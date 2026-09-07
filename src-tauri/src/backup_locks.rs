//! Repository-lock diagnostics and stale-only recovery. Never prune,
//! delete snapshots, bypass data locks or expose unfiltered sidecar output.
use crate::{
    document_model::ReadError,
    restic::{Repository, Restic, args},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
pub struct Lock {
    pub id: String,
    pub time: String,
    pub hostname: String,
    pub pid: u32,
    pub exclusive: bool,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub schema_version: u32,
    pub repository_id: String,
    pub unlock_attempted: bool,
    pub locks: Vec<Lock>,
}
#[derive(Deserialize)]
struct LockData {
    time: String,
    hostname: String,
    pid: u32,
    exclusive: bool,
}
fn protocol() -> ReadError {
    ReadError::new("RESTIC_PROTOCOL", "Invalid repository lock information")
}
fn repository_identity(
    restic: &Restic,
    repo: &Repository,
    expected: &str,
) -> Result<String, ReadError> {
    let repository_id = restic.repository_id(repo)?;
    if repository_id != expected {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Repository identity changed during lock recovery",
        ));
    }
    Ok(repository_id)
}
pub fn inspect(restic: &Restic, repo: &Repository, expected: &str) -> Result<Report, ReadError> {
    let repository_id = repository_identity(restic, repo, expected)?;
    // `list locks` itself does not take a repository lock in pinned Restic.
    let raw = restic.run(repo, &args(&["list", "locks"]), None)?;
    let ids: BTreeSet<_> = std::str::from_utf8(&raw)
        .map_err(|_| protocol())?
        .split_whitespace()
        .collect();
    if ids.len() > 128
        || ids.iter().any(|id| {
            id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(protocol());
    }
    let mut locks = Vec::new();
    for id in ids {
        // Only lock metadata is read without a lock, never snapshot/index data.
        let raw = restic.run(repo, &args(&["cat", "lock", id, "--no-lock"]), None)?;
        let value: LockData = serde_json::from_slice(&raw).map_err(|_| protocol())?;
        if value.hostname.len() > 256
            || value.hostname.chars().any(char::is_control)
            || value.pid == 0
            || chrono::DateTime::parse_from_rfc3339(&value.time).is_err()
        {
            return Err(protocol());
        }
        locks.push(Lock {
            id: id.into(),
            time: value.time,
            hostname: value.hostname,
            pid: value.pid,
            exclusive: value.exclusive,
        });
    }
    locks.sort_by(|a, b| a.time.cmp(&b.time).then(a.id.cmp(&b.id)));
    Ok(Report {
        schema_version: 3,
        repository_id,
        unlock_attempted: false,
        locks,
    })
}

pub fn recover(restic: &Restic, repo: &Repository, expected: &str) -> Result<Report, ReadError> {
    remove_stale(restic, repo, expected)?;
    let mut report = inspect(restic, repo, expected)?;
    report.unlock_attempted = true;
    Ok(report)
}

fn remove_stale(restic: &Restic, repo: &Repository, expected: &str) -> Result<(), ReadError> {
    repository_identity(restic, repo, expected)?;
    // Restic rechecks staleness at execution time (same-host dead PID or an
    // expired heartbeat). There is deliberately no --remove-all API/option.
    restic.run(repo, &args(&["unlock"]), None)?;
    Ok(())
}

pub(crate) fn recover_for_retry(
    restic: &Restic,
    repo: &Repository,
    expected: &str,
) -> Result<(), ReadError> {
    remove_stale(restic, repo, expected)?;
    repository_identity(restic, repo, expected)?;
    // No extra UI lock listing on the automatic path. The single retried
    // command checks its own lock mode and any remaining live locks itself.
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::Ordering,
        time::{Duration, Instant},
    };
    struct RunningBackup {
        handle: Option<std::thread::JoinHandle<Result<Vec<u8>, ReadError>>>,
        cancel: crate::restic::Cancellation,
    }
    impl Drop for RunningBackup {
        fn drop(&mut self) {
            if let Some(worker) = self.handle.take() {
                self.cancel.store(true, Ordering::Release);
                let _ = worker.join();
            }
        }
    }

    #[test]
    fn active_locks_survive_unlock_but_an_orphan_is_recovered_without_changing_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        crate::backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let generation = crate::backup::run_local(&workspace, &restic)
            .unwrap()
            .unwrap();
        let managed = crate::backup::local_repository(&workspace, &restic, false).unwrap();
        let repo = Repository::local(&workspace);
        let expected = &generation.repository_id;
        assert!(inspect(&restic, &repo, expected).unwrap().locks.is_empty());
        let ready = temp.path().join("ready");
        let worker_ready = ready.clone();
        let worker_restic = restic.clone();
        let worker_repo = repo.clone();
        let worker = std::thread::spawn(move || {
            worker_restic.run(
                &worker_repo,
                &[
                    "backup".into(),
                    "--stdin-from-command".into(),
                    "--stdin-filename".into(),
                    "interrupted-test".into(),
                    "--".into(),
                    "sh".into(),
                    "-c".into(),
                    "printf ready > \"$1\"; exec sleep 120".into(),
                    "lock-test".into(),
                    worker_ready.into_os_string(),
                ],
                None,
            )
        });
        let mut worker = RunningBackup {
            handle: Some(worker),
            cancel: restic.cancel.clone(),
        };
        let began = Instant::now();
        while !ready.exists()
            && !worker.handle.as_ref().unwrap().is_finished()
            && began.elapsed() < Duration::from_secs(15)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready.exists(), "temporary Restic fixture did not start");
        let active = recover(&restic, &repo, expected).unwrap();
        assert_eq!(active.locks.len(), 1);
        assert!(!active.locks[0].exclusive);
        let progress = crate::backup_progress::Progress::start(&workspace, "lock-test", 0);
        let observed = restic.with_progress(progress.clone());
        let plan = args(&["forget", "--keep-last", "1", "--dry-run", "--json"]);
        // Automatic recovery is also stale-only; a live shared backup still
        // blocks the exclusive retention command after its single retry.
        assert_eq!(
            observed.run(&managed, &plan, None).unwrap_err().code,
            "REPOSITORY_LOCKED"
        );
        assert_eq!(
            progress.snapshot().operation_counts[&crate::backup_progress::Operation::Unlock],
            1
        );
        assert_eq!(inspect(&restic, &repo, expected).unwrap().locks.len(), 1);
        let process_id = active.locks[0].pid;
        // Only the process identified inside THIS private test repository is
        // killed. Simulate a crash that cannot remove its repository lock.
        assert_eq!(unsafe { libc::kill(process_id as i32, libc::SIGKILL) }, 0);
        assert!(worker.handle.take().unwrap().join().unwrap().is_err());
        assert_eq!(
            recover(&restic, &repo, &"0".repeat(64)).unwrap_err().code,
            "REPOSITORY_MISMATCH"
        );
        assert_eq!(inspect(&restic, &repo, expected).unwrap().locks.len(), 1);
        assert_eq!(
            restic.run(&repo, &args(&["prune"]), None).unwrap_err().code,
            "REPOSITORY_LOCKED"
        );
        // A different/unregistered identity must never acquire auto-unlock
        // authority, even when it can reach and decrypt this repository.
        let replaced = managed.clone().with_automatic_lock_recovery("0".repeat(64));
        assert_eq!(
            restic.run(&replaced, &plan, None).unwrap_err().code,
            "REPOSITORY_MISMATCH"
        );
        assert_eq!(inspect(&restic, &repo, expected).unwrap().locks.len(), 1);
        observed.run(&managed, &plan, None).unwrap();
        assert!(inspect(&restic, &repo, expected).unwrap().locks.is_empty());
        assert_eq!(
            progress.snapshot().operation_counts[&crate::backup_progress::Operation::Unlock],
            2
        );
        observed.run(&managed, &plan, None).unwrap();
        assert_eq!(
            progress.snapshot().operation_counts[&crate::backup_progress::Operation::Unlock],
            2,
            "healthy operations must not run extra lock probes/unlock"
        );
        // The explicit recovery route remains usable after automatic recovery.
        let recovered = recover(&restic, &repo, expected).unwrap();
        assert!(recovered.unlock_attempted && recovered.locks.is_empty());
        let snapshots = crate::backup::generations(&restic, &repo, None, None).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].snapshot_id, generation.snapshot_id);
        restic.run(&repo, &args(&["check"]), None).unwrap();
        assert_eq!(
            fs::read_dir(repo.local_path().unwrap().join("locks"))
                .unwrap()
                .count(),
            0
        );
    }
}
