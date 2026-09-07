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
    io::{Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const VERSION: &str = "0.19.1";
/// Bound each invocation for destination fairness and Windows command-line size.
pub(crate) const COPY_BATCH_SIZE: usize = 16;
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
    // Granted only after a Workspace destination's identity (and, on Drive,
    // local writer binding) has been validated. Arbitrary restore sources do
    // not acquire this capability merely by supplying a path/password.
    automatic_lock_recovery: Option<String>,
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
            automatic_lock_recovery: None,
        }
    }
    pub(crate) fn drive(context: crate::rclone::DriveRepository, password: Password) -> Self {
        Self {
            location: RepositoryLocation::GoogleDrive(context),
            password,
            automatic_lock_recovery: None,
        }
    }
    pub(crate) fn with_automatic_lock_recovery(mut self, expected: String) -> Self {
        self.automatic_lock_recovery = Some(expected);
        self
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
    cache: Option<Arc<tempfile::TempDir>>,
    progress: Option<Arc<crate::backup_progress::Progress>>,
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
            cache: None,
            progress: None,
        })
    }
    /// A private, disposable cache shared across one transfer job's commands
    /// and generations. Never reuse the user's Restic cache or capture it.
    pub(crate) fn with_transfer_cache(&self) -> Result<Self, ReadError> {
        let mut value = self.clone();
        if value.cache.is_none() {
            let directory = tempfile::Builder::new()
                .prefix("memoka-restic-")
                .tempdir()?;
            crate::private_files::directory(directory.path())?;
            value.cache = Some(Arc::new(directory));
        }
        Ok(value)
    }
    pub(crate) fn with_progress(&self, progress: Arc<crate::backup_progress::Progress>) -> Self {
        let mut value = self.clone();
        value.progress = Some(progress);
        value
    }
    pub(crate) fn stage(&self, stage: crate::backup_progress::Stage) {
        if let Some(progress) = &self.progress {
            progress.stage(stage);
        }
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
        self.execute(repo, args, cwd, None, None)
    }
    pub(crate) fn copy_snapshots(
        &self,
        source: &Repository,
        target: &Repository,
        snapshots: &[&str],
    ) -> Result<(), ReadError> {
        // No IDs means "copy the entire repository" to Restic, not a no-op.
        if snapshots.is_empty()
            || snapshots.len() > COPY_BATCH_SIZE
            || snapshots.iter().any(|id| {
                id.len() != 64
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Copy requires a bounded, nonempty batch of full snapshot IDs",
            ));
        }
        if !matches!(source.password, Password::Insecure) {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Copy source must be local history",
            ));
        }
        let mut args = vec![
            "copy".into(),
            "--from-repo".into(),
            source.local_path()?.as_os_str().to_owned(),
            "--from-insecure-no-password".into(),
            "--".into(),
        ];
        args.extend(snapshots.iter().map(OsString::from));
        self.execute(target, &args, None, None, Some(source))?;
        Ok(())
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
            None,
        )?;
        file.sync_all()?;
        Ok(())
    }
    fn execute(
        &self,
        repo: &Repository,
        args: &[OsString],
        cwd: Option<&Path>,
        mut output: Option<File>,
        source: Option<&Repository>,
    ) -> Result<Vec<u8>, ReadError> {
        let first = self.execute_once(
            repo,
            args,
            cwd,
            output.as_ref().map(File::try_clone).transpose()?,
        );
        let Err(error) = &first else { return first };
        // Exit 11 is a lock-acquisition failure. Do not replay incomplete
        // writes, authentication failures, cancellations or arbitrary commands.
        let eligible = matches!(
            args.first().and_then(|arg| arg.to_str()),
            Some("backup" | "snapshots" | "dump" | "ls" | "copy" | "forget" | "prune" | "check")
        );
        let repositories = source
            .into_iter()
            .chain(std::iter::once(repo))
            .filter_map(|r| r.automatic_lock_recovery.as_deref().map(|id| (r, id)))
            .collect::<Vec<_>>();
        if error.code != "REPOSITORY_LOCKED" || !eligible || repositories.is_empty() {
            return first;
        }
        // Child/transport cleanup has completed before execute_once returns.
        // Reuse the existing leases, cancellation and whole-operation deadline.
        let stage = self.progress.as_ref().map(|p| p.snapshot().stage);
        self.stage(crate::backup_progress::Stage::LockRecovery);
        for (repository, expected) in repositories {
            crate::backup_locks::recover_for_retry(self, repository, expected)?;
        }
        if let Some(stage) = stage {
            self.stage(stage);
        }
        if let Some(file) = &mut output {
            // dump_file's original output is new and private. Never append to
            // bytes from the failed attempt (try_clone shares the file offset).
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
        }
        // No recursive retry: live locks are respected by Restic again. The
        // caller retains its normal backoff/status and verification semantics.
        self.execute_once(repo, args, cwd, output)
    }
    fn execute_once(
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
        command.arg("--repo").arg(repo.address());
        // Explicit integrity checks must still read the repository itself.
        if let Some(cache) = self
            .cache
            .as_ref()
            .filter(|_| args.first().is_none_or(|arg| arg != "check"))
        {
            checked_directory(cache.path())?;
            command.arg("--cache-dir").arg(cache.path());
        } else {
            command.arg("--no-cache");
        }
        if let Some(context) = repo.drive_context() {
            context.configure(&mut command)?;
            if self.progress.is_some() {
                context.configure_progress(&mut command);
            }
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
        use crate::backup_progress::Operation;
        let operation = match args.first().and_then(|arg| arg.to_str()) {
            Some("cat") => Operation::Repository,
            Some("snapshots") => Operation::Snapshots,
            Some("dump") => Operation::Descriptor,
            Some("ls") => Operation::FileList,
            Some("copy") => Operation::Copy,
            Some("forget") => Operation::Forget,
            Some("prune") => Operation::Prune,
            Some("check") => Operation::Check,
            Some("unlock") => Operation::Unlock,
            _ => Operation::Other,
        };
        if let Some(progress) = &self.progress {
            progress.operation_started(operation);
        }
        let result =
            crate::sidecar::run_restic(command, &self.cancel, timeout, self.progress.clone());
        if let Some(progress) = &self.progress {
            progress
                .operation_finished(operation, result.as_ref().is_ok_and(|r| r.status.success()));
        }
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
                match status.code() {
                    Some(11) => "バックアップ保存先のロックを取得できません。別の処理が実行中、または異常終了した処理のロックが残っています。保存済みの世代は維持されています。",
                    _ => "Restic operation failed; existing verified generations remain protected",
                },
            )
            .with_details(serde_json::json!({"exit_code":status.code(), "operation":operation})));
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
        // Freshly decrypt the config, but do not upload a read lock just to
        // identify the repository. This reads no snapshot/index/pack; normal
        // data reads, copy, forget and prune still use Restic's own locks.
        let value = self.json(repo, &["cat", "config", "--no-lock"])?;
        let id = value["id"]
            .as_str()
            .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Repository ID is missing"))?;
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ReadError::new("RESTIC_PROTOCOL", "Invalid repository ID"));
        }
        Ok(id.into())
    }
    /// Reuse only the identity checked when this leased cloud handle opened.
    /// Never persists across jobs; post-copy checks and pre-deletion checks
    /// deliberately call repository_id instead to detect replacement.
    pub(crate) fn opened_repository_id(&self, repo: &Repository) -> Result<String, ReadError> {
        match repo
            .drive_context()
            .and_then(|c| c.verified_repository_id.as_ref())
        {
            Some(id) => Ok(id.clone()),
            None => self.repository_id(repo),
        }
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
    #[cfg(unix)]
    fn automatic_fixture(root: &Path) -> (Restic, Repository) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(root).unwrap();
        let binary = root.join("fake-restic");
        // All files/paths belong to this private fixture. No real repository,
        // keyring, Drive connection or ambient Restic configuration is used.
        fs::write(
            &binary,
            r#"#!/bin/sh
repo=; source=; op=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) shift; repo="$1" ;;
    --from-repo) shift; source="$1" ;;
    cat|snapshots|dump|copy|unlock|check) op="$1" ;;
    --) shift; printf '%s\n' "$@" > "$repo/snapshot-args"; break ;;
    --remove-all) exit 99 ;;
  esac
  shift
done
printf '%s\n' "$op" >> "$repo/calls"
case "$op" in
  cat) printf '{"id":"%s"}' "$(cat "$repo/identity")" ;;
  unlock)
    [ ! -f "$repo/unlock-fails" ] || exit 1
    touch "$repo/unlocked"
    if [ -f "$repo/unlock-delay" ]; then sleep 1; fi
    if [ -f "$repo/new-identity" ]; then cp "$repo/new-identity" "$repo/identity"; fi
    ;;
  *)
    if [ -n "$source" ] && [ -f "$source/fault" ] && [ ! -f "$source/unlocked" ]; then exit 11; fi
    if [ -f "$repo/fault" ] && { [ ! -f "$repo/unlocked" ] || [ -f "$repo/persistent" ]; }; then
      printf partial
      exit "$(cat "$repo/fault")"
    fi
    printf complete
    ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("identity"), "a".repeat(64)).unwrap();
        let restic = Restic {
            binary,
            cancel: cancellation(),
            timeout: Duration::from_secs(10),
            deadline: None,
            cache: None,
            progress: None,
        };
        (
            restic,
            Repository::at(root.to_path_buf(), Password::Insecure),
        )
    }
    #[cfg(unix)]
    fn calls(path: &Path, operation: &str) -> usize {
        fs::read_to_string(path.join("calls"))
            .unwrap_or_default()
            .lines()
            .filter(|s| *s == operation)
            .count()
    }
    #[cfg(unix)]
    #[test]
    fn copy_batch_requires_explicit_ids_and_uses_one_cancellable_command() {
        let temp = tempfile::tempdir().unwrap();
        let (restic, target) = automatic_fixture(&temp.path().join("target"));
        let (_, source) = automatic_fixture(&temp.path().join("source"));
        let ids = (0..COPY_BATCH_SIZE)
            .map(|n| format!("{n:064x}"))
            .collect::<Vec<_>>();
        let ids = ids.iter().map(String::as_str).collect::<Vec<_>>();
        for invalid in [
            vec![],
            vec![ids[0]; COPY_BATCH_SIZE + 1],
            vec!["latest"],
            vec!["--all"],
            vec![""],
            vec!["ABCD"],
            vec!["abc"],
        ] {
            assert_eq!(
                restic
                    .copy_snapshots(&source, &target, &invalid)
                    .unwrap_err()
                    .code,
                "INVALID_ARGUMENT"
            );
        }
        assert_eq!(calls(target.local_path().unwrap(), "copy"), 0);
        restic.copy_snapshots(&source, &target, &ids).unwrap();
        assert_eq!(calls(target.local_path().unwrap(), "copy"), 1);
        assert_eq!(
            fs::read_to_string(target.local_path().unwrap().join("snapshot-args"))
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ids
        );
        restic.cancel.store(true, Ordering::Release);
        assert_eq!(
            restic
                .copy_snapshots(&source, &target, &ids)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert_eq!(calls(target.local_path().unwrap(), "copy"), 1);
    }
    #[cfg(unix)]
    #[test]
    fn automatic_unlock_is_opt_in_bounded_and_only_retries_lock_acquisition_errors() {
        let temporary = tempfile::tempdir().unwrap();
        for (name, enabled, fault, persistent, expected) in [
            ("healthy", true, None, false, None),
            (
                "read-only",
                false,
                Some(11),
                false,
                Some("REPOSITORY_LOCKED"),
            ),
            ("stale", true, Some(11), false, None),
            ("live", true, Some(11), true, Some("REPOSITORY_LOCKED")),
            (
                "incomplete",
                true,
                Some(3),
                false,
                Some("RESTIC_INCOMPLETE"),
            ),
            ("missing", true, Some(10), false, Some("REPOSITORY_MISSING")),
            ("credentials", true, Some(12), false, Some("CREDENTIALS")),
            ("unrelated", true, Some(1), false, Some("RESTIC_FAILED")),
        ] {
            let root = temporary.path().join(name);
            let (restic, mut repo) = automatic_fixture(&root);
            if enabled {
                repo = repo.with_automatic_lock_recovery("a".repeat(64));
            }
            if let Some(code) = fault {
                fs::write(root.join("fault"), code.to_string()).unwrap();
            }
            if persistent {
                fs::write(root.join("persistent"), "").unwrap();
            }
            let result = restic.run(&repo, &args(&["snapshots"]), None);
            assert_eq!(
                result.as_ref().err().map(|e| e.code.as_str()),
                expected,
                "{name}"
            );
            let recovers = enabled && fault == Some(11);
            assert_eq!(calls(&root, "unlock"), usize::from(recovers), "{name}");
            assert_eq!(
                calls(&root, "snapshots"),
                1 + usize::from(recovers),
                "{name}"
            );
            assert_eq!(calls(&root, "cat"), 2 * usize::from(recovers), "{name}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn automatic_unlock_preserves_identity_deadline_and_cancellation_guards() {
        let temporary = tempfile::tempdir().unwrap();
        for (name, expected) in [
            ("wrong-identity", "REPOSITORY_MISMATCH"),
            ("replaced-during-unlock", "REPOSITORY_MISMATCH"),
            ("unlock-error", "RESTIC_FAILED"),
            ("deadline", "TIMEOUT"),
            ("cancel", "CANCELLED"),
        ] {
            let root = temporary.path().join(name);
            let (mut restic, repo) = automatic_fixture(&root);
            let repo = repo.with_automatic_lock_recovery("a".repeat(64));
            fs::write(root.join("fault"), "11").unwrap();
            match name {
                "wrong-identity" => fs::write(root.join("identity"), "b".repeat(64)).unwrap(),
                "replaced-during-unlock" => {
                    fs::write(root.join("new-identity"), "b".repeat(64)).unwrap()
                }
                "unlock-error" => fs::write(root.join("unlock-fails"), "").unwrap(),
                "deadline" => {
                    restic = restic.within(Duration::from_millis(700));
                    fs::write(root.join("unlock-delay"), "").unwrap();
                }
                _ => restic.cancel.store(true, Ordering::Release),
            }
            assert_eq!(
                restic
                    .run(&repo, &args(&["snapshots"]), None)
                    .unwrap_err()
                    .code,
                expected,
                "{name}"
            );
            assert_eq!(
                calls(&root, "snapshots"),
                usize::from(name != "cancel"),
                "{name}"
            );
            assert_eq!(
                calls(&root, "unlock"),
                usize::from(name != "cancel" && name != "wrong-identity"),
                "{name}"
            );
        }
        // Cancellation arriving DURING recovery must not launch the original
        // data operation again after the unlock child has been reaped.
        let root = temporary.path().join("cancel-during-unlock");
        let (restic, repo) = automatic_fixture(&root);
        let repo = repo.with_automatic_lock_recovery("a".repeat(64));
        fs::write(root.join("fault"), "11").unwrap();
        fs::write(root.join("unlock-delay"), "").unwrap();
        let cancel = restic.cancel.clone();
        let worker = std::thread::spawn(move || restic.run(&repo, &args(&["snapshots"]), None));
        let began = Instant::now();
        while !root.join("unlocked").exists()
            && !worker.is_finished()
            && began.elapsed() < Duration::from_secs(3)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let reached_unlock = root.join("unlocked").exists();
        cancel.store(true, Ordering::Release);
        let result = worker.join().unwrap();
        assert!(reached_unlock, "unlock fixture was not reached");
        assert_eq!(result.unwrap_err().code, "CANCELLED");
        assert_eq!(calls(&root, "snapshots"), 1);
        assert_eq!(calls(&root, "unlock"), 1);
    }
    #[cfg(unix)]
    #[test]
    fn automatic_unlock_retries_dump_from_start_and_recovers_only_registered_copy_endpoints() {
        let temporary = tempfile::tempdir().unwrap();
        let target_path = temporary.path().join("target");
        let (restic, target) = automatic_fixture(&target_path);
        let target = target.with_automatic_lock_recovery("a".repeat(64));
        fs::write(target_path.join("fault"), "11").unwrap();
        let output = temporary.path().join("dump");
        restic
            .dump_file(&target, "snapshot", "/state.sqlite", &output)
            .unwrap();
        assert_eq!(fs::read(output).unwrap(), b"complete");
        let source_path = temporary.path().join("source");
        let (_, source) = automatic_fixture(&source_path);
        fs::write(source_path.join("fault"), "11").unwrap();
        // Raw source can be read explicitly, but must not be auto-unlocked.
        assert_eq!(
            restic
                .copy_snapshots(&source, &target, &[&"a".repeat(64), &"b".repeat(64)])
                .unwrap_err()
                .code,
            "REPOSITORY_LOCKED"
        );
        assert_eq!(calls(&source_path, "unlock"), 0);
        let source = source.with_automatic_lock_recovery("a".repeat(64));
        restic
            .copy_snapshots(&source, &target, &[&"a".repeat(64), &"b".repeat(64)])
            .unwrap();
        assert_eq!(calls(&source_path, "unlock"), 1);
        assert_eq!(calls(&target_path, "copy"), 4);
    }
    #[cfg(unix)]
    #[test]
    fn only_config_identity_reads_skip_locks_and_leased_identity_never_replaces_a_fresh_check() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("restic-test");
        // No backend is launched. Reject --no-lock for any data operation.
        fs::write(&script, format!("#!/bin/sh\nconfig=false; unlocked=false\nfor arg do\n case \"$arg\" in config) config=true;; --no-lock) unlocked=true;; esac\ndone\nif $config; then\n $unlocked || exit 1\n printf '%s' '{{\"id\":\"{}\"}}'\nelse\n $unlocked && exit 1\n printf '[]'\nfi\n", "a".repeat(64))).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let private = temp.path().join("private");
        crate::private_files::directory(&private).unwrap();
        let config = private.join("synthetic.conf");
        fs::write(&config, "# test only\nRCLONE_ENCRYPT_V0:\nsynthetic\n").unwrap();
        let lease =
            Arc::new(crate::private_files::Lease::acquire(temp.path().join("lease")).unwrap());
        let context = crate::rclone::DriveRepository {
            rclone: crate::rclone::Rclone::discover().unwrap(),
            config,
            key: Arc::new(zeroize::Zeroizing::new("test-only".into())),
            folder_id: "folder123".into(),
            _lease: lease.clone(),
            _repository_lease: Some(lease),
            verified_repository_id: Some("b".repeat(64)),
        };
        let repo = Repository::drive(context.clone(), Password::Secret("test-only".into()));
        let restic = Restic {
            binary: script,
            cancel: cancellation(),
            timeout: Duration::from_secs(5),
            deadline: None,
            cache: None,
            progress: None,
        };
        assert_eq!(
            restic
                .within(Duration::ZERO)
                .opened_repository_id(&repo)
                .unwrap(),
            "b".repeat(64)
        );
        assert_eq!(
            restic
                .within(Duration::ZERO)
                .repository_id(&repo)
                .unwrap_err()
                .code,
            "TIMEOUT"
        );
        assert_eq!(restic.repository_id(&repo).unwrap(), "a".repeat(64));
        assert!(
            crate::backup::generations(&restic, &repo, None, None)
                .unwrap()
                .is_empty()
        );
        let mut unopened = context;
        unopened.verified_repository_id = None;
        let reopened = Repository::drive(unopened, repo.password.clone());
        assert_eq!(
            restic.opened_repository_id(&reopened).unwrap(),
            "a".repeat(64)
        );
    }
    #[cfg(unix)]
    #[test]
    fn cancelling_real_restic_removes_its_lock_before_returning() {
        let temp = tempfile::tempdir().unwrap();
        let restic = Restic::discover(cancellation()).unwrap();
        let repo = Repository::at(temp.path().join("repository"), Password::Insecure);
        restic.initialize(&repo, None).unwrap();
        let child_repo = repo.clone();
        let child_restic = restic.clone();
        let ready = temp.path().join("reading");
        let child_ready = ready.clone();
        let worker = std::thread::spawn(move || {
            child_restic.run(
                &child_repo,
                &[
                    "backup".into(),
                    "--stdin-from-command".into(),
                    "--stdin-filename".into(),
                    "test-input".into(),
                    "--".into(),
                    "sh".into(),
                    "-c".into(),
                    "printf ready > \"$1\"; exec sleep 30".into(),
                    "restic-test".into(),
                    child_ready.into_os_string(),
                ],
                None,
            )
        });
        let began = Instant::now();
        while !ready.exists() && !worker.is_finished() && began.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let locks = repo.local_path().unwrap().join("locks");
        let had_lock = std::fs::read_dir(&locks).unwrap().count() > 0;
        // No global --no-lock: an exclusive operation still rejects this lock.
        let pruning = restic.run(&repo, &args(&["prune"]), None);
        restic.cancel.store(true, Ordering::Release);
        let stopped = worker.join().unwrap().unwrap_err();
        let error = pruning.unwrap_err();
        assert_eq!(error.code, "REPOSITORY_LOCKED");
        assert!(error.message.contains("ロック"));
        assert_eq!(error.details["operation"], "prune");
        assert_eq!(stopped.code, "CANCELLED");
        assert!(ready.exists() && had_lock);
        assert_eq!(std::fs::read_dir(locks).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn cancelling_real_restic_over_rclone_stdio_removes_its_lock() {
        let temp = tempfile::tempdir().unwrap();
        let restic = Restic::discover(cancellation()).unwrap();
        let repo = Repository::at(temp.path().join("repository"), Password::Insecure);
        restic.initialize(&repo, None).unwrap();
        let config = temp.path().join("empty-rclone.conf");
        fs::write(&config, "").unwrap();
        let rclone = crate::rclone::Rclone::discover().unwrap();
        let rclone_command = rclone.command(&config, "unused-test-key");
        let program =
            crate::rclone::quote_program(Path::new(rclone_command.get_program())).unwrap();
        let ready = temp.path().join("reading");
        let mut command = Command::new(&restic.binary);
        sanitized(&mut command);
        // Real stdio transport to a local-only repository; no Google account
        // and no ambient rclone config or Restic cache is used by this test.
        command
            .args([
                "--repo",
                &format!("rclone:{}", repo.local_path().unwrap().display()),
                "--no-cache",
                "--insecure-no-password",
                "-o",
                &format!("rclone.program={program}"),
                "-o",
                "rclone.args=serve restic --stdio --ask-password=false",
                "backup",
                "--stdin-from-command",
                "--stdin-filename",
                "test-input",
                "--",
                "sh",
                "-c",
                "printf ready > \"$1\"; exec sleep 30",
                "restic-test",
            ])
            .arg(&ready)
            .env("RCLONE_CONFIG", &config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let cancel = restic.cancel.clone();
        let worker = std::thread::spawn(move || {
            crate::sidecar::run_restic(command, &cancel, Duration::from_secs(30), None)
        });
        let began = Instant::now();
        while !ready.exists() && !worker.is_finished() && began.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let locks = repo.local_path().unwrap().join("locks");
        let had_lock = fs::read_dir(&locks).unwrap().count() > 0;
        restic.cancel.store(true, Ordering::Release);
        let error = worker.join().unwrap().err().unwrap();
        assert_eq!(error.code, "CANCELLED");
        assert!(ready.exists() && had_lock);
        assert_eq!(fs::read_dir(locks).unwrap().count(), 0);
    }
    #[test]
    fn a_shorter_deadline_cannot_be_reset_by_the_next_phase() {
        let restic = Restic {
            binary: PathBuf::from("must-not-run"),
            cancel: cancellation(),
            timeout: Duration::from_secs(3600),
            deadline: None,
            cache: None,
            progress: None,
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
    #[test]
    fn transfer_cache_is_private_shared_and_disposable() {
        let base = Restic::discover(cancellation()).unwrap();
        assert!(base.cache.is_none());
        let cached = base.with_transfer_cache().unwrap();
        let next = cached
            .within(Duration::from_secs(60))
            .with_transfer_cache()
            .unwrap();
        let path = cached.cache.as_ref().unwrap().path().to_path_buf();
        assert_eq!(next.cache.as_ref().unwrap().path(), path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(cached);
        assert!(path.is_dir());
        drop(next);
        assert!(!path.exists());
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
