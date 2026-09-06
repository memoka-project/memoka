//! The only production rclone remote is memoka_drive. No user URI/flags/backend
//! or PATH fallback. Config tokens never enter argv or returned diagnostics.
use crate::{
    document_model::ReadError, private_files, read_service::plain_file, restic::Cancellation,
    sidecar,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, OnceLock},
    time::Duration,
};
pub const VERSION: &str = "1.75.1";
pub const REMOTE: &str = "memoka_drive";
#[derive(Clone, Debug)]
pub(crate) struct Rclone {
    pub binary: PathBuf,
}
impl Rclone {
    pub fn discover() -> Result<Self, ReadError> {
        static VERIFIED: OnceLock<Result<Rclone, ReadError>> = OnceLock::new();
        VERIFIED
            .get_or_init(|| {
                let installed =
                    std::env::current_exe()?
                        .parent()
                        .ok_or_else(missing)?
                        .join(if cfg!(windows) {
                            "rclone.exe"
                        } else {
                            "rclone"
                        });
                let binary = if installed.is_file() {
                    installed
                } else if cfg!(debug_assertions) {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("binaries")
                        .join(if cfg!(windows) {
                            "rclone-x86_64-pc-windows-msvc.exe"
                        } else {
                            "rclone-x86_64-unknown-linux-gnu"
                        })
                } else {
                    return Err(missing());
                };
                verify_binary(&binary)?;
                Ok(Self { binary })
            })
            .clone()
    }
    pub fn command(&self, path: &Path, key: &str) -> Command {
        let mut command = Command::new(&self.binary);
        sidecar::sanitized(&mut command);
        command
            .env("RCLONE_CONFIG", path)
            .env("RCLONE_CONFIG_PASS", key)
            .arg("--ask-password=false")
            .arg("--log-level=ERROR")
            .arg("--contimeout=10s")
            .arg("--timeout=60s")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    fn execute(
        &self,
        path: &Path,
        key: &str,
        args: &[OsString],
        answer: Option<&str>,
        input: Option<Vec<u8>>,
        cancel: &Cancellation,
    ) -> Result<Vec<u8>, ReadError> {
        private_files::inspect(path.parent().ok_or_else(missing)?)?;
        let mut command = self.command(path, key);
        command.args(args);
        if let Some(answer) = answer {
            command.env("RCLONE_RESULT", answer);
        }
        let output = sidecar::run(command, cancel, Duration::from_secs(60), input)?;
        private_files::inspect(path.parent().ok_or_else(missing)?)?;
        if !output.status.success() {
            return Err(classify_error(&output.stderr));
        }
        if output.stdout.len() > 64 * 1024 * 1024 {
            return Err(protocol());
        }
        Ok(output.stdout)
    }
    pub fn json(
        &self,
        path: &Path,
        key: &str,
        args: &[&str],
        cancel: &Cancellation,
    ) -> Result<Value, ReadError> {
        let bytes = self.execute(path, key, &crate::restic::args(args), None, None, cancel)?;
        serde_json::from_slice(&bytes).map_err(|_| protocol())
    }
    pub fn create_config(
        &self,
        path: &Path,
        key: &str,
        client_id: &str,
        client_secret: &str,
        token: Value,
        cancel: &Cancellation,
    ) -> Result<(), ReadError> {
        if path.exists() {
            return Err(ReadError::new(
                "CLOUD_STATE_IO",
                "New credentials require a new protected config",
            ));
        }
        // Encryption is established while the file is still empty. These are
        // two fixed password inputs, not parsing OAuth terminal conversations.
        self.execute(
            path,
            key,
            &crate::restic::args(&["config", "encryption", "set"]),
            None,
            Some(format!("{key}\n{key}\n").into_bytes()),
            cancel,
        )?;
        ensure_encrypted(path)?;
        let packet = zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD_NO_PAD.encode(serde_json::to_vec(&json!({"token":serde_json::to_string(&token)?, "client_id":client_id, "client_secret":client_secret}))?));
        let mut question = self.json(
            path,
            key,
            &[
                "config",
                "create",
                REMOTE,
                "drive",
                "client_id",
                client_id,
                "scope",
                "drive.file",
                "--non-interactive",
            ],
            cancel,
        )?;
        for _ in 0..5 {
            if question["State"] == "" {
                ensure_encrypted(path)?;
                return Ok(());
            }
            if question["Error"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err(protocol());
            }
            let answer = match question["Option"]["Name"].as_str() {
                Some("config_is_local" | "config_change_team_drive") => "false",
                Some("config_token") => packet.as_str(),
                _ => return Err(protocol()), // Never accept shared clients/scopes/unknown prompts.
            };
            let state = question["State"].as_str().ok_or_else(protocol)?;
            let output = self.execute(
                path,
                key,
                &crate::restic::args(&[
                    "config",
                    "update",
                    REMOTE,
                    "--non-interactive",
                    "--continue",
                    "--state",
                    state,
                ]),
                Some(answer),
                None,
                cancel,
            )?;
            question = serde_json::from_slice(&output).map_err(|_| protocol())?;
        }
        Err(protocol())
    }
}
fn missing() -> ReadError {
    ReadError::new(
        "RCLONE_MISSING",
        &format!(
            "Bundled rclone {VERSION} is missing; run rclone:prepare or repair the installation"
        ),
    )
}
fn protocol() -> ReadError {
    ReadError::new("RCLONE_PROTOCOL", "Unexpected response from bundled rclone")
}
fn verify_binary(path: &Path) -> Result<(), ReadError> {
    plain_file(path).map_err(|_| missing())?;
    let mut input = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let expected = if cfg!(windows) {
        "033eee51c9ad47c2de2624b6674d355274bcd6cf0027a5f85db4437ba24ae81c"
    } else {
        "f66d8c1d552ad90296a11bc8b46d56a7fa5da1a7fa05e7ca522d95df92c4a4c0"
    };
    if digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        != expected
    {
        return Err(ReadError::new(
            "RCLONE_VERSION",
            "Bundled rclone failed fixed-version checksum verification",
        ));
    }
    Ok(())
}
pub(crate) fn ensure_encrypted(path: &Path) -> Result<(), ReadError> {
    plain_file(path)?;
    let mut header = [0u8; 128];
    let count = fs::File::open(path)?.read(&mut header)?;
    if !String::from_utf8_lossy(&header[..count]).contains("\nRCLONE_ENCRYPT_V0:\n") {
        return Err(ReadError::new(
            "CLOUD_CONFIG_UNENCRYPTED",
            "Cloud configuration is not encrypted; operation refused",
        ));
    }
    Ok(())
}
/// Runtime object: only constructed from a validated connection and Drive ID.
/// Arc preserves the credential-writer lease over all phases in one operation.
#[derive(Clone)]
pub struct DriveRepository {
    pub(crate) rclone: Rclone,
    pub(crate) config: PathBuf,
    pub(crate) key: Arc<zeroize::Zeroizing<String>>,
    pub(crate) folder_id: String,
    pub(crate) _lease: Arc<private_files::Lease>,
    pub(crate) _repository_lease: Option<Arc<private_files::Lease>>,
}
impl std::fmt::Debug for DriveRepository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DriveRepository([validated; secrets redacted])")
    }
}
impl DriveRepository {
    pub(crate) fn inspect_config(&self) -> Result<(), ReadError> {
        private_files::inspect(self.config.parent().ok_or_else(missing)?)?;
        ensure_encrypted(&self.config)
    }
    pub(crate) fn require_empty(&self, cancel: &Cancellation) -> Result<(), ReadError> {
        crate::cloud::validate_repository_layout(self, cancel, true)
    }
    pub(crate) fn configure(&self, command: &mut Command) -> Result<(), ReadError> {
        self.inspect_config()?;
        crate::cloud::validate_folder_id(&self.folder_id)?;
        command.arg("-o").arg(format!("rclone.program={}", quote_program(&self.rclone.binary)?))
            .arg("-o").arg("rclone.args=serve restic --stdio --drive-use-trash=true --drive-skip-shortcuts --drive-skip-gdocs --ask-password=false --log-level=ERROR --contimeout=10s --timeout=60s")
            .env("RCLONE_CONFIG", &self.config).env("RCLONE_CONFIG_PASS", self.key.as_str())
            .env("RCLONE_CONFIG_MEMOKA_DRIVE_ROOT_FOLDER_ID", &self.folder_id)
            .env("RCLONE_CONFIG_MEMOKA_DRIVE_SCOPE", "drive.file");
        Ok(())
    }
    pub(crate) fn validate_layout(&self, cancel: &Cancellation) -> Result<(), ReadError> {
        crate::cloud::validate_repository_layout(self, cancel, false)
    }
}
pub(crate) fn quote_program(path: &Path) -> Result<String, ReadError> {
    let path = path
        .to_str()
        .ok_or_else(|| ReadError::new("UNSAFE_PATH", "Sidecar path must be Unicode"))?;
    if !Path::new(path).is_absolute() {
        return Err(ReadError::new(
            "UNSAFE_PATH",
            "Sidecar path must be absolute",
        ));
    }
    // Restic uses shellquote.Split on this value, including on Windows.
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}
pub(crate) fn classify_error(stderr: &[u8]) -> ReadError {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let (code, message) = if text.contains("invalid_grant")
        || text.contains("invalid_token")
        || text.contains("unauthorized_client")
    {
        (
            "CLOUD_REAUTH_REQUIRED",
            "Google authorization expired or was revoked; reconnect explicitly",
        )
    } else if text.contains("invalid_client") {
        (
            "CLOUD_CLIENT_INVALID",
            "The configured Google OAuth client is invalid",
        )
    } else if text.contains("storagequotaexceeded") {
        ("CLOUD_QUOTA", "Google Drive storage quota is exceeded")
    } else if text.contains("dailylimitexceeded") || text.contains("upload limit") {
        (
            "CLOUD_UPLOAD_LIMIT",
            "Google's upload limit was reached; retry later",
        )
    } else if text.contains("ratelimitexceeded")
        || ["error 429", "http 429", "status code 429", "status=429"]
            .iter()
            .any(|code| text.contains(code))
    {
        (
            "CLOUD_RATE_LIMIT",
            "Google Drive rate limit reached; retry later",
        )
    } else if text.contains("insufficientfilepermissions")
        || text.contains("insufficientpermissions")
    {
        (
            "CLOUD_ACCESS_DENIED",
            "This Google connection cannot access the backup folder",
        )
    } else if text.contains("500 internal")
        || text.contains("502 bad")
        || text.contains("503 service")
        || text.contains("504 gateway")
    {
        ("CLOUD_TRANSIENT", "Google Drive is temporarily unavailable")
    } else {
        (
            "CLOUD_IO",
            "Google Drive operation failed; inspect connection, folder access and network",
        )
    };
    ReadError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_binary_and_plaintext_config_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rclone");
        fs::write(&path, b"not the pinned executable").unwrap();
        assert_eq!(verify_binary(&path).unwrap_err().code, "RCLONE_VERSION");
        assert_eq!(
            ensure_encrypted(&path).unwrap_err().code,
            "CLOUD_CONFIG_UNENCRYPTED"
        );
        assert!(quote_program(Path::new("relative program")).is_err());
    }
    #[test]
    fn diagnostics_are_classified_without_echoing_secrets() {
        for (raw, code) in [
            ("invalid_grant", "CLOUD_REAUTH_REQUIRED"),
            ("storageQuotaExceeded", "CLOUD_QUOTA"),
            ("userRateLimitExceeded", "CLOUD_RATE_LIMIT"),
            ("503 Service Unavailable", "CLOUD_TRANSIENT"),
            ("403 unknown", "CLOUD_IO"),
        ] {
            let secret = crate::cloud::random_key();
            let error = classify_error(format!("{raw} access_token={secret}").as_bytes());
            assert_eq!(error.code, code);
            assert!(!serde_json::to_string(&error).unwrap().contains(&secret));
        }
    }
    #[test]
    fn real_config_is_encrypted_before_secrets_and_uses_no_secret_argv() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("private");
        private_files::directory(&dir).unwrap();
        let config = dir.join("rclone.conf");
        let key = crate::cloud::random_key();
        let token = crate::cloud::random_key();
        let rclone = Rclone::discover().unwrap();
        rclone.create_config(&config,&key,"offline-test.apps.googleusercontent.com","dummy-client-secret",json!({"access_token":token,"refresh_token":token,"token_type":"Bearer","expiry":"2099-01-01T00:00:00Z"}),&crate::restic::cancellation()).unwrap();
        ensure_encrypted(&config).unwrap();
        for entry in fs::read_dir(&dir).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(&token));
            assert!(!String::from_utf8_lossy(&bytes).contains(&key));
        }
        let cmd = rclone.command(&config, &key);
        assert!(
            cmd.get_args()
                .all(|arg| !arg.to_string_lossy().contains(&key))
        );
        let loaded = rclone
            .json(
                &config,
                &key,
                &["config", "dump"],
                &crate::restic::cancellation(),
            )
            .unwrap();
        assert!(loaded[REMOTE]["token"].as_str().unwrap().contains(&token));
    }
}
