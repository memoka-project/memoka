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
    pub location: RepositoryLocation,
    pub password: Password,
}
#[derive(Clone, Debug)]
pub enum RepositoryLocation {
    LocalDirectory { path: PathBuf },
    GoogleDrive(crate::rclone::DriveRepository),
}
impl Repository {
    pub fn at(path: PathBuf, password: Password) -> Self {
        Self {
            location: RepositoryLocation::LocalDirectory { path },
            password,
        }
    }
    pub(crate) fn drive(context: crate::rclone::DriveRepository, password: Password) -> Self {
        Self {
            location: RepositoryLocation::GoogleDrive(context),
            password,
        }
    }
    pub fn local_path(&self) -> Result<&Path, ReadError> {
        match &self.location {
            RepositoryLocation::LocalDirectory { path } => Ok(path),
            _ => Err(ReadError::new(
                "INVALID_ARGUMENT",
                "This operation requires a local repository",
            )),
        }
    }
    pub(crate) fn drive_context(&self) -> Option<&crate::rclone::DriveRepository> {
        match &self.location {
            RepositoryLocation::GoogleDrive(context) => Some(context),
            _ => None,
        }
    }
    pub(crate) fn address(&self) -> OsString {
        match &self.location {
            RepositoryLocation::LocalDirectory { path } => path.as_os_str().to_owned(),
            RepositoryLocation::GoogleDrive(_) => "rclone:memoka_drive:".into(),
        }
    }
    pub fn local(workspace: &Path) -> Self {
        Self::at(
            workspace.join(".memoka-backups").join("restic"),
            Password::Insecure,
        )
    }
    pub fn validate_path(&self) -> Result<(), ReadError> {
        if let Some(context) = self.drive_context() {
            return crate::cloud::validate_folder_id(&context.folder_id);
        }
        let path = self.local_path()?;
        if !path.is_absolute() {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Repository must be an absolute local path",
            ));
        }
        // A missing leaf is allowed only for explicit initialization. Existing
        // ancestors must not redirect to another store via symlink/reparse.
        for path in path.ancestors() {
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
        command.arg("--repo").arg(repo.address()).arg("--no-cache");
        if let Some(context) = repo.drive_context() {
            context.configure(&mut command)?;
        }
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
        let result = run_process(command, &self.cancel, timeout);
        // Restic's child rclone can refresh the shared config too. Inspect
        // rewritten config/side files after reaping, also on cancel/error.
        if let Some(context) = repo.drive_context() {
            context.inspect_config()?;
        }
        let result = result?;
        let status = result.status;
        let stdout = result.stdout;
        if status.code() != Some(0) {
            if repo.drive_context().is_some() && !matches!(status.code(), Some(3 | 10 | 11 | 12)) {
                return Err(crate::rclone::classify_error(&result.stderr));
            }
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
        if let Ok(path) = repo.local_path() {
            if path.exists() && fs::read_dir(path)?.next().transpose()?.is_some() {
                return Err(ReadError::new(
                    "REPOSITORY_NOT_EMPTY",
                    "Initialization requires an empty dedicated directory",
                ));
            }
            fs::create_dir_all(path)?;
        }
        if let Some(context) = repo.drive_context() {
            context.require_empty(&self.cancel)?;
        }
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
                source.local_path()?.as_os_str().to_owned(),
                "--from-insecure-no-password".into(),
                "--copy-chunker-params".into(),
            ]);
        }
        self.run(repo, &args, None)?;
        self.repository_id(repo)
    }
}
fn run_process(
    command: Command,
    cancel: &Cancellation,
    timeout: Duration,
) -> Result<crate::sidecar::ProcessOutput, ReadError> {
    crate::sidecar::run(command, cancel, timeout, None)
}
#[cfg(test)]
use crate::sidecar::bounded_output;
use crate::sidecar::sanitized;
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
        let repo = Repository::at(dir.path().into(), Password::Insecure);
        let error = expired.run(&repo, &args(&["snapshots"]), None).unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
    }
    #[cfg(unix)]
    #[test]
    fn repository_parent_symlinks_are_rejected_before_initialization() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        let repo = Repository::at(
            dir.path().join("link/missing-repository"),
            Password::Insecure,
        );
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
