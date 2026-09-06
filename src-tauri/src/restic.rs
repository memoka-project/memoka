//! Fixed-version sidecar boundary. No shell, remote backend, ambient Restic
//! credentials, or raw subprocess output is exposed to application logs.
use crate::{
    document_model::ReadError,
    read_service::{checked_directory, plain_file},
};
use serde_json::Value;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const VERSION: &str = "0.19.1";
pub type Cancellation = Arc<AtomicBool>;
pub fn cancellation() -> Cancellation {
    Arc::new(AtomicBool::new(false))
}

#[derive(Clone)]
pub enum Password {
    Insecure,
    Secret(String),
}
impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Insecure => "Insecure",
            Self::Secret(_) => "Secret([redacted])",
        })
    }
}
#[derive(Clone, Debug)]
pub struct Repository {
    pub path: PathBuf,
    pub password: Password,
}
impl Repository {
    pub fn local(workspace: &Path) -> Self {
        Self {
            path: workspace.join(".memoka-backups").join("restic"),
            password: Password::Insecure,
        }
    }
    pub fn validate_path(&self) -> Result<(), ReadError> {
        if !self.path.is_absolute() {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Repository must be an absolute local path",
            ));
        }
        // A missing leaf is allowed only for explicit initialization. Existing
        // ancestors must not redirect to another store via symlink/reparse.
        for path in self.path.ancestors() {
            match fs::symlink_metadata(path) {
                Ok(_) => checked_directory(path)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Restic {
    binary: PathBuf,
    pub cancel: Cancellation,
    pub timeout: Duration,
    deadline: Option<Instant>,
}
impl Restic {
    pub fn discover(cancel: Cancellation) -> Result<Self, ReadError> {
        let binary_name = if cfg!(windows) {
            "restic.exe"
        } else {
            "restic"
        };
        let installed = std::env::current_exe()?
            .parent()
            .ok_or_else(|| ReadError::new("SIDECAR_MISSING", "Cannot locate installation"))?
            .join(binary_name);
        let binary = if installed.is_file() {
            installed
        } else {
            #[cfg(debug_assertions)]
            {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries")
                    .join(if cfg!(windows) {
                        "restic-x86_64-pc-windows-msvc.exe"
                    } else {
                        "restic-x86_64-unknown-linux-gnu"
                    })
            }
            #[cfg(not(debug_assertions))]
            {
                return Err(ReadError::new(
                    "SIDECAR_MISSING",
                    "Bundled Restic is missing; repair the Memoka installation",
                ));
            }
        };
        plain_file(&binary).map_err(|_| {
            ReadError::new(
                "SIDECAR_MISSING",
                "Run the verified Restic preparation step before building Memoka",
            )
        })?;
        let mut command = Command::new(&binary);
        sanitized(&mut command);
        command
            .arg("version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let result = run_process(command, &cancel, Duration::from_secs(10))?;
        if !result.status.success()
            || !String::from_utf8_lossy(&result.stdout).starts_with(&format!("restic {VERSION} "))
        {
            return Err(ReadError::new(
                "SIDECAR_VERSION",
                "Unexpected Restic version",
            ));
        }
        Ok(Self {
            binary,
            cancel,
            timeout: Duration::from_secs(3600),
            deadline: None,
        })
    }
    /// Bound the whole operation, including metadata enumeration, validation,
    /// copy and verification, rather than restarting the clock per subprocess.
    pub fn within(&self, budget: Duration) -> Self {
        let mut value = self.clone();
        let deadline = Instant::now() + budget;
        value.deadline = Some(self.deadline.map_or(deadline, |old| old.min(deadline)));
        value
    }
    pub fn expired(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
    }
    pub fn run(
        &self,
        repo: &Repository,
        args: &[OsString],
        cwd: Option<&Path>,
    ) -> Result<Vec<u8>, ReadError> {
        self.execute(repo, args, cwd, None)
    }
    pub fn json(&self, repo: &Repository, args: &[&str]) -> Result<Value, ReadError> {
        let mut args = args.iter().map(OsString::from).collect::<Vec<_>>();
        args.push("--json".into());
        serde_json::from_slice(&self.run(repo, &args, None)?)
            .map_err(|_| ReadError::new("RESTIC_PROTOCOL", "Restic returned invalid JSON"))
    }
    pub fn dump_file(
        &self,
        repo: &Repository,
        snapshot: &str,
        path: &str,
        target: &Path,
    ) -> Result<(), ReadError> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)?;
        self.execute(
            repo,
            &["dump".into(), snapshot.into(), path.into()],
            None,
            Some(file.try_clone()?),
        )?;
        file.sync_all()?;
        Ok(())
    }
    fn execute(
        &self,
        repo: &Repository,
        args: &[OsString],
        cwd: Option<&Path>,
        output: Option<File>,
    ) -> Result<Vec<u8>, ReadError> {
        repo.validate_path()?;
        if self.cancel.load(Ordering::Acquire) {
            return Err(ReadError::new("CANCELLED", "Operation cancelled"));
        }
        let mut command = Command::new(&self.binary);
        sanitized(&mut command);
        command.arg("--repo").arg(&repo.path).arg("--no-cache");
        match &repo.password {
            Password::Insecure => {
                command.arg("--insecure-no-password");
            }
            Password::Secret(secret) => {
                if secret.is_empty() {
                    return Err(ReadError::new(
                        "CREDENTIALS",
                        "Additional repository requires a nonempty password",
                    ));
                }
                command.env("RESTIC_PASSWORD", secret);
            }
        }
        command
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command.stdout(output.map_or_else(Stdio::piped, Stdio::from));
        let timeout = self.deadline.map_or(self.timeout, |deadline| {
            self.timeout
                .min(deadline.saturating_duration_since(Instant::now()))
        });
        if timeout.is_zero() {
            return Err(ReadError::new(
                "TIMEOUT",
                "Restic operation deadline reached",
            ));
        }
        let result = run_process(command, &self.cancel, timeout)?;
        let status = result.status;
        let stdout = result.stdout;
        if status.code() != Some(0) {
            return Err(ReadError::new(
                match status.code() {
                    Some(3) => "RESTIC_INCOMPLETE",
                    Some(10) => "REPOSITORY_MISSING",
                    Some(11) => "REPOSITORY_LOCKED",
                    Some(12) => "CREDENTIALS",
                    _ => "RESTIC_FAILED",
                },
                "Restic operation failed; no generation was accepted",
            )
            .with_details(serde_json::json!({"exit_code":status.code()})));
        }
        if stdout.len() > 64 * 1024 * 1024 {
            return Err(ReadError::new(
                "RESTIC_PROTOCOL",
                "Restic response exceeds the size limit",
            ));
        }
        Ok(stdout)
    }
    pub fn repository_id(&self, repo: &Repository) -> Result<String, ReadError> {
        let value = self.json(repo, &["cat", "config"])?;
        let id = value["id"]
            .as_str()
            .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Repository ID is missing"))?;
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ReadError::new("RESTIC_PROTOCOL", "Invalid repository ID"));
        }
        Ok(id.into())
    }
    pub fn initialize(
        &self,
        repo: &Repository,
        source: Option<&Repository>,
    ) -> Result<String, ReadError> {
        repo.validate_path()?;
        if repo.path.exists() && fs::read_dir(&repo.path)?.next().transpose()?.is_some() {
            return Err(ReadError::new(
                "REPOSITORY_NOT_EMPTY",
                "Initialization requires an empty dedicated directory",
            ));
        }
        fs::create_dir_all(&repo.path)?;
        let mut args = vec![OsString::from("init")];
        if let Some(source) = source {
            if !matches!(source.password, Password::Insecure) {
                return Err(ReadError::new(
                    "INVALID_ARGUMENT",
                    "Copy initialization source must be local history",
                ));
            }
            args.extend([
                "--from-repo".into(),
                source.path.clone().into_os_string(),
                "--from-insecure-no-password".into(),
                "--copy-chunker-params".into(),
            ]);
        }
        self.run(repo, &args, None)?;
        self.repository_id(repo)
    }
}
/// Every exit, including an I/O error or unwinding, kills and reaps the child.
/// A cancelled operation owns its token permanently; later requests cannot
/// reset it while this process is still stopping.
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct ProcessOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
}
fn run_process(
    mut command: Command,
    cancel: &Cancellation,
    timeout: Duration,
) -> Result<ProcessOutput, ReadError> {
    if cancel.load(Ordering::Acquire) {
        return Err(ReadError::new("CANCELLED", "Operation cancelled"));
    }
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot start bundled Restic"))?,
    );
    let stdout = child
        .0
        .stdout
        .take()
        .map(|pipe| std::thread::spawn(move || bounded_output(pipe, 64 * 1024 * 1024)));
    let stderr = child
        .0
        .stderr
        .take()
        .map(|pipe| std::thread::spawn(move || bounded_output(pipe, 256 * 1024)));
    let began = Instant::now();
    let result = loop {
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(_) => {
                break Err(ReadError::new(
                    "SIDECAR_IO",
                    "Cannot wait for bundled Restic",
                ));
            }
            Ok(None) => {}
        }
        if cancel.load(Ordering::Acquire) || began.elapsed() >= timeout {
            break Err(ReadError::new(
                if cancel.load(Ordering::Acquire) {
                    "CANCELLED"
                } else {
                    "TIMEOUT"
                },
                "Restic operation was stopped",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // Close the writer before joining readers even on timeout, wait failure,
    // or cancellation. Never expose Restic's raw stderr in application logs.
    drop(child);
    let stdout = stdout
        .map(|thread| {
            thread
                .join()
                .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot read Restic response"))
        })
        .transpose()?
        .transpose()
        .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot read Restic response"))?
        .unwrap_or_default();
    if let Some(thread) = stderr {
        let _ = thread.join();
    }
    Ok(ProcessOutput {
        status: result?,
        stdout,
    })
}
fn bounded_output(mut input: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match input.read(&mut buffer)? {
            0 => break,
            count => {
                let left = (limit + 1).saturating_sub(result.len());
                result.extend_from_slice(&buffer[..count.min(left)]);
            }
        }
    }
    Ok(result)
}
fn sanitized(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("RESTIC_")
        {
            command.env_remove(key);
        }
    }
    command.env("GOMAXPROCS", "2").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}
pub fn args(values: &[impl AsRef<OsStr>]) -> Vec<OsString> {
    values
        .iter()
        .map(|value| value.as_ref().to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_shorter_deadline_cannot_be_reset_by_the_next_phase() {
        let restic = Restic {
            binary: PathBuf::from("must-not-run"),
            cancel: cancellation(),
            timeout: Duration::from_secs(3600),
            deadline: None,
        };
        let expired = restic
            .within(Duration::ZERO)
            .within(Duration::from_secs(30));
        assert!(expired.expired());
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository {
            path: dir.path().into(),
            password: Password::Insecure,
        };
        let error = expired.run(&repo, &args(&["snapshots"]), None).unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
    }
    #[cfg(unix)]
    #[test]
    fn repository_parent_symlinks_are_rejected_before_initialization() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        let repo = Repository {
            path: dir.path().join("link/missing-repository"),
            password: Password::Insecure,
        };
        assert_eq!(repo.validate_path().unwrap_err().code, "UNSAFE_PATH");
        assert!(!dir.path().join("real/missing-repository").exists());
    }
    #[test]
    fn output_is_bounded_but_the_pipe_is_fully_drained() {
        let input = std::io::Cursor::new(vec![42; 100_000]);
        assert_eq!(bounded_output(input, 16).unwrap(), vec![42; 17]);
    }
    #[cfg(unix)]
    #[test]
    fn timeout_and_cancel_reap_the_child_before_returning() {
        for cancel_early in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let pid_file = temporary.path().join("child-pid");
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", "echo $$ > \"$1\"; exec sleep 30", "memoka-test"])
                .arg(&pid_file)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let cancel = cancellation();
            let token = cancel.clone();
            let child_pid = pid_file.clone();
            let cancel_thread = std::thread::spawn(move || {
                let began = Instant::now();
                while !child_pid.exists() && began.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if cancel_early {
                    token.store(true, Ordering::Release);
                }
            });
            let result = run_process(command, &cancel, Duration::from_millis(250));
            cancel_thread.join().unwrap();
            let error = result.err().expect("process must be stopped");
            assert_eq!(
                error.code,
                if cancel_early { "CANCELLED" } else { "TIMEOUT" }
            );
            let pid: i32 = fs::read_to_string(pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // The exact child is no longer alive and cannot be a zombie.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
    }
}
