//! Bounded, secret-safe subprocesses. A process group / Windows Job Object
//! owns all descendants (including Restic's rclone), not just the first child.
use crate::{document_model::ReadError, restic::Cancellation};
use process_wrap::std::{ChildWrapper, CommandWrap};
use std::{
    io::{Read, Write},
    process::{Command, ExitStatus, Stdio},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

// Set only by the standalone CLI, never by GUI cancellation.
static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Acquire)
}
pub(crate) fn install_cli_interrupt_handler() -> Result<(), ReadError> {
    ctrlc::set_handler(|| {
        INTERRUPTED.store(true, Ordering::Release);
    })
    .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot install CLI cancellation handler"))
}
struct ChildGuard(Box<dyn ChildWrapper>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.start_kill();
        let _ = self.0.wait();
    }
}
pub(crate) struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    // Only allowlisted classification may consume this; NEVER return/log it.
    pub stderr: Vec<u8>,
}
pub(crate) fn run(
    command: Command,
    cancel: &Cancellation,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<ProcessOutput, ReadError> {
    if cancel.load(Ordering::Acquire) || interrupted() {
        return Err(ReadError::new("CANCELLED", "Operation cancelled"));
    }
    if timeout.is_zero() {
        return Err(ReadError::new("TIMEOUT", "Operation deadline reached"));
    }
    let mut command = CommandWrap::from(command);
    #[cfg(unix)]
    command.wrap(process_wrap::std::ProcessGroup::leader());
    #[cfg(windows)]
    {
        command.wrap(process_wrap::std::CreationFlags(0x08000000));
        command.wrap(process_wrap::std::JobObject);
    }
    if input.is_some() {
        command.command_mut().stdin(Stdio::piped());
    }
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot start bundled sidecar"))?,
    );
    let stdout = child
        .0
        .stdout()
        .take()
        .map(|pipe| std::thread::spawn(move || bounded_output(pipe, 64 * 1024 * 1024)));
    let stderr = child
        .0
        .stderr()
        .take()
        .map(|pipe| std::thread::spawn(move || bounded_output(pipe, 256 * 1024)));
    let writer = input.and_then(|bytes| {
        child.0.stdin().take().map(|mut pipe| {
            std::thread::spawn(move || {
                let bytes = zeroize::Zeroizing::new(bytes);
                pipe.write_all(&bytes)
            })
        })
    });
    let began = Instant::now();
    let result = loop {
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(_) => {
                break Err(ReadError::new(
                    "SIDECAR_IO",
                    "Cannot wait for bundled sidecar",
                ));
            }
            Ok(None) => {}
        }
        if cancel.load(Ordering::Acquire) || interrupted() || began.elapsed() >= timeout {
            break Err(ReadError::new(
                if cancel.load(Ordering::Acquire) || interrupted() {
                    "CANCELLED"
                } else {
                    "TIMEOUT"
                },
                "Sidecar operation stopped",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // Close all inherited pipe writers before joining, even if the leader
    // has already exited. No rclone/refresh process survives a cancellation.
    drop(child);
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    fn collect(
        thread: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>,
    ) -> Result<Vec<u8>, ReadError> {
        thread
            .map(|thread| {
                thread
                    .join()
                    .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot read sidecar response"))?
                    .map_err(|_| ReadError::new("SIDECAR_IO", "Cannot read sidecar response"))
            })
            .transpose()
            .map(Option::unwrap_or_default)
    }
    let stdout = collect(stdout)?;
    let stderr = collect(stderr)?;
    Ok(ProcessOutput {
        status: result?,
        stdout,
        stderr,
    })
}
pub(crate) fn bounded_output(mut input: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let left = (limit + 1).saturating_sub(result.len());
        result.extend_from_slice(&buffer[..count.min(left)]);
    }
    Ok(result)
}
pub(crate) fn sanitized(command: &mut Command) {
    let explicit: Vec<_> = command
        .get_envs()
        .map(|(key, _)| key.to_os_string())
        .collect();
    for key in std::env::vars_os().map(|(key, _)| key).chain(explicit) {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if [
            "RESTIC_", "RCLONE_", "_RCLONE_", "LD_", "DYLD_", "GOOGLE_", "AWS_", "AZURE_",
        ]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
            || ["GODEBUG", "GOFLAGS", "SSLKEYLOGFILE"].contains(&upper.as_str())
        {
            command.env_remove(key);
        }
    }
    command.env("GOMAXPROCS", "2").stdin(Stdio::null());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_read_drains_excess() {
        assert_eq!(bounded_output(&b"0123456789"[..], 3).unwrap(), b"0123");
    }
    #[test]
    fn sidecars_and_browser_strip_ambient_secrets_and_backend_overrides() {
        let mut command = Command::new("not-executed");
        let protected = [
            "RCLONE_CONFIG",
            "RCLONE_CONFIG_PASS",
            "RCLONE_CONFIG_MEMOKA_DRIVE_ROOT_FOLDER_ID",
            "_RCLONE_X",
            "RESTIC_PASSWORD",
            "RESTIC_REPOSITORY",
            "RESTIC_PASSWORD_COMMAND",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AWS_SECRET_ACCESS_KEY",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "GODEBUG",
            "GOFLAGS",
            "SSLKEYLOGFILE",
        ];
        for name in protected {
            command.env(name, "synthetic-secret");
        }
        command.env("HTTPS_PROXY", "http://proxy.invalid");
        sanitized(&mut command);
        for name in protected {
            assert!(
                command
                    .get_envs()
                    .any(|(key, value)| key == name && value.is_none())
            );
        }
        assert!(
            command
                .get_envs()
                .any(|(key, value)| key == "HTTPS_PROXY" && value.is_some())
        );
    }
    #[cfg(unix)]
    #[test]
    fn timeout_and_cancel_kill_descendants_that_hold_output_open() {
        for cancelled in [false, true] {
            let token = crate::restic::cancellation();
            let cancel = token.clone();
            if cancelled {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(100));
                    cancel.store(true, Ordering::Release);
                });
            }
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", "sleep 60 & wait"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let began = Instant::now();
            let error = run(command, &token, Duration::from_millis(400), None)
                .err()
                .unwrap();
            assert_eq!(error.code, if cancelled { "CANCELLED" } else { "TIMEOUT" });
            assert!(began.elapsed() < Duration::from_secs(3));
        }
    }
}
