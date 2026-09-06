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
impl ChildGuard {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        #[cfg(windows)]
        {
            // process-wrap 10's JobObject::try_wait consumes a completion-port
            // notification without remembering it for wait(). Consuming the
            // final notification here can make Drop's wait block forever.
            // Poll only the leader; keep the Job Object for kill/wait/drop so
            // all descendants are still terminated before draining the pipes.
            self.0.inner_mut().try_wait()
        }
        #[cfg(not(windows))]
        self.0.try_wait()
    }
}
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
    run_observed(command, cancel, timeout, input, None)
}

pub(crate) fn run_observed(
    command: Command,
    cancel: &Cancellation,
    timeout: Duration,
    input: Option<Vec<u8>>,
    progress: Option<std::sync::Arc<crate::backup_progress::Progress>>,
) -> Result<ProcessOutput, ReadError> {
    run_with_cleanup(command, cancel, timeout, input, progress, Duration::ZERO)
}

/// Restic must be allowed to remove its lock using the still-running rclone
/// transport. Killing the process group first leaves remote locks behind.
pub(crate) fn run_restic(
    command: Command,
    cancel: &Cancellation,
    timeout: Duration,
    progress: Option<std::sync::Arc<crate::backup_progress::Progress>>,
) -> Result<ProcessOutput, ReadError> {
    run_with_cleanup(
        command,
        cancel,
        timeout,
        None,
        progress,
        Duration::from_secs(20),
    )
}

fn run_with_cleanup(
    command: Command,
    cancel: &Cancellation,
    timeout: Duration,
    input: Option<Vec<u8>>,
    progress: Option<std::sync::Arc<crate::backup_progress::Progress>>,
    cleanup_grace: Duration,
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
        command.wrap(process_wrap::std::CreationFlags(
            windows::Win32::System::Threading::CREATE_NO_WINDOW,
        ));
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
    let stderr = child.0.stderr().take().map(|pipe| {
        std::thread::spawn(move || observed_output(pipe, 256 * 1024, progress.as_deref()))
    });
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
        match child.try_wait() {
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
            let cancelled = cancel.load(Ordering::Acquire) || interrupted();
            finish_before_kill(&mut child, cleanup_grace);
            break Err(ReadError::new(
                if cancelled { "CANCELLED" } else { "TIMEOUT" },
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

fn finish_before_kill(child: &mut ChildGuard, grace: Duration) {
    if grace.is_zero() {
        return;
    }
    #[cfg(unix)]
    {
        // Signal ONLY the leader, never ChildWrapper::signal (process group).
        // Restic handles SIGINT, cancels the command, then unlocks via rclone.
        if unsafe { libc::kill(child.0.id() as i32, libc::SIGINT) } != 0 {
            return;
        }
    }
    // CREATE_NO_WINDOW children cannot receive a console Ctrl-C on Windows.
    // Give an in-flight command a bounded chance to finish naturally there;
    // do not pretend forced Job Object termination can clean repository locks.
    let began = Instant::now();
    while began.elapsed() < grace {
        match child.try_wait() {
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            _ => break,
        }
    }
    // ChildGuard still kills/reaps all remaining descendants before returning.
}
pub(crate) fn bounded_output(mut input: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    observed_output(&mut input, limit, None)
}
fn observed_output(
    mut input: impl Read,
    limit: usize,
    progress: Option<&crate::backup_progress::Progress>,
) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if progress.is_some() {
            // Stats are periodic and may fill the pipe for hours. Keep the
            // bounded tail so final auth/rate-limit errors remain classifiable.
            result.extend_from_slice(&buffer[..count]);
            if result.len() > limit + 1 {
                result.drain(..result.len() - limit - 1);
            }
        } else {
            let left = (limit + 1).saturating_sub(result.len());
            result.extend_from_slice(&buffer[..count.min(left)]);
        }
        if let Some(progress) = progress {
            for byte in &buffer[..count] {
                if *byte == b'\n' {
                    if !oversized {
                        progress.observe_line(&line);
                    }
                    line.clear();
                    oversized = false;
                } else if !oversized {
                    if line.len() >= 64 * 1024 {
                        oversized = true;
                        line.clear();
                    } else {
                        line.push(*byte);
                    }
                }
            }
        }
    }
    if !oversized && !line.is_empty() {
        if let Some(progress) = progress {
            progress.observe_line(&line);
        }
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
    #[cfg(windows)]
    #[test]
    fn windows_no_console_children_run_and_exit_inside_their_jobs() {
        // Repeated short-lived children exercise polling followed by teardown,
        // the same sequence used by a multi-command Restic transfer.
        for _ in 0..16 {
            let mut command = Command::new("cmd.exe");
            command
                .args(["/D", "/C", "echo", "sidecar-ok"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let result = run(
                command,
                &crate::restic::cancellation(),
                Duration::from_secs(10),
                None,
            )
            .unwrap();
            assert!(result.status.success());
            assert_eq!(
                String::from_utf8(result.stdout).unwrap().trim(),
                "sidecar-ok"
            );
            assert!(result.stderr.is_empty());
        }
    }
    #[cfg(unix)]
    #[test]
    fn graceful_stop_keeps_transport_alive_for_cleanup_then_reaps_descendants() {
        for cancel_early in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let ready = temp.path().join("ready");
            let clean = temp.path().join("cleaned");
            let pid_path = temp.path().join("transport-pid");
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30 & transport=$!; printf '%s' \"$transport\" > \"$3\"; trap 'if kill -0 \"$transport\"; then printf cleaned > \"$2\"; fi; kill \"$transport\"; wait \"$transport\"; exit 0' INT; printf ready > \"$1\"; while :; do sleep 0.05; done", "cleanup-test"])
                .arg(&ready).arg(&clean).arg(&pid_path)
                .stdout(Stdio::piped()).stderr(Stdio::piped());
            let cancel = crate::restic::cancellation();
            let token = cancel.clone();
            let worker = std::thread::spawn(move || {
                run_with_cleanup(
                    command,
                    &token,
                    Duration::from_secs(2),
                    None,
                    None,
                    Duration::from_secs(2),
                )
            });
            let began = Instant::now();
            while !ready.exists() && began.elapsed() < Duration::from_secs(1) {
                std::thread::sleep(Duration::from_millis(10));
            }
            if cancel_early {
                cancel.store(true, Ordering::Release);
            }
            let error = worker.join().unwrap().err().unwrap();
            assert_eq!(
                error.code,
                if cancel_early { "CANCELLED" } else { "TIMEOUT" }
            );
            assert_eq!(std::fs::read_to_string(clean).unwrap(), "cleaned");
            let pid: i32 = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
    }
    #[cfg(unix)]
    #[test]
    fn unresponsive_restic_cleanup_has_a_bounded_grace_period() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "trap '' INT; exec sleep 30"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let began = Instant::now();
        let error = run_with_cleanup(
            command,
            &crate::restic::cancellation(),
            Duration::from_millis(100),
            None,
            None,
            Duration::from_millis(100),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "TIMEOUT");
        assert!(began.elapsed() < Duration::from_secs(3));
    }
    #[test]
    fn bounded_read_drains_excess() {
        assert_eq!(bounded_output(&b"0123456789"[..], 3).unwrap(), b"0123");
    }
    #[test]
    fn periodic_stats_are_bounded_and_keep_the_final_error_classifiable() {
        let temp = tempfile::tempdir().unwrap();
        let p = crate::backup_progress::Progress::start(temp.path(), "stats", 1);
        let mut input = vec![b'x'; 100_000];
        input.extend_from_slice(b"\n");
        input.extend_from_slice(
            br#"rclone: {"stats":{"bytes":42,"speed":2,"errors":0},"msg":"private"}"#,
        );
        input.extend_from_slice(b"\ninvalid_grant: private-token\n");
        let captured = observed_output(input.as_slice(), 128, Some(&p)).unwrap();
        assert!(captured.len() <= 129);
        assert_eq!(p.snapshot().transport_bytes, Some(42));
        assert_eq!(
            crate::rclone::classify_error(&captured).code,
            "CLOUD_REAUTH_REQUIRED"
        );
        assert!(
            !serde_json::to_string(&p.snapshot())
                .unwrap()
                .contains("private")
        );
    }
    #[cfg(unix)]
    #[test]
    fn statistics_arrive_while_the_process_is_running_and_cancel_still_reaps_it() {
        use std::sync::{Arc, atomic::Ordering};
        let temp = tempfile::tempdir().unwrap();
        let progress = crate::backup_progress::Progress::start(temp.path(), "live-pipe", 1);
        let cancel = crate::restic::cancellation();
        let worker_progress = Arc::clone(&progress);
        let worker_cancel = Arc::clone(&cancel);
        let worker = std::thread::spawn(move || {
            let mut command = Command::new("sh");
            command
                .args([
                    "-c",
                    "printf '%s\\n' '{\"stats\":{\"bytes\":123,\"speed\":10}}' >&2; sleep 30",
                ])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            run_observed(
                command,
                &worker_cancel,
                Duration::from_secs(5),
                None,
                Some(worker_progress),
            )
        });
        let began = Instant::now();
        while progress.snapshot().transport_bytes.is_none()
            && began.elapsed() < Duration::from_secs(3)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let saw_live_stats =
            progress.snapshot().transport_bytes == Some(123) && !worker.is_finished();
        cancel.store(true, Ordering::Release);
        assert_eq!(worker.join().unwrap().err().unwrap().code, "CANCELLED");
        assert!(saw_live_stats);
        assert!(!progress.finish(false).running);
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
