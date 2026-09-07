//! Live, allowlisted transfer diagnostics. Polling never writes the Workspace
//! or contacts a backend. Raw sidecar output, filenames and credentials are
//! deliberately not part of this contract.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Instant,
};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    #[default]
    Connecting,
    Listing,
    SourceVerification,
    Uploading,
    TargetVerification,
    Maintaining,
    LockRecovery,
    Complete,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Repository,
    Snapshots,
    Descriptor,
    FileList,
    Copy,
    Forget,
    Prune,
    Check,
    Unlock,
    Other,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub running: bool,
    pub stage: Stage,
    pub started_at: String,
    pub last_progress_at: String,
    pub elapsed_ms: u64,
    pub stage_elapsed_ms: u64,
    pub generation_captured_at: Option<String>,
    pub completed_generations: usize,
    pub total_generations: usize,
    pub operation: Option<Operation>,
    pub failed_operation: Option<Operation>,
    pub operations_completed: u64,
    pub operation_counts: BTreeMap<Operation, u64>,
    /// rclone's reported file-transport bytes, not a snapshot size or an ETA.
    /// Includes reads as well as writes; None means no measurement available.
    pub transport_bytes: Option<u64>,
    pub bytes_per_second: Option<f64>,
    pub transport_errors: u64,
}

struct State {
    snapshot: Snapshot,
    began: Instant,
    stage_began: Instant,
    command_bytes: u64,
    command_errors: u64,
}
pub(crate) struct Progress(Mutex<State>);
type Registry = BTreeMap<(PathBuf, String), Weak<Progress>>;
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

impl Progress {
    pub fn start(workspace: &Path, target: &str, total: usize) -> Arc<Self> {
        let now = chrono::Utc::now().to_rfc3339();
        let value = Arc::new(Self(Mutex::new(State {
            snapshot: Snapshot {
                running: true,
                started_at: now.clone(),
                last_progress_at: now,
                total_generations: total,
                ..Default::default()
            },
            began: Instant::now(),
            stage_began: Instant::now(),
            command_bytes: 0,
            command_errors: 0,
        })));
        let mut entries = registry().lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, value| value.strong_count() > 0);
        entries.insert((workspace.into(), target.into()), Arc::downgrade(&value));
        value
    }
    fn update(&self, change: impl FnOnce(&mut State)) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut state);
    }
    pub fn stage(&self, stage: Stage) {
        self.update(|s| {
            s.snapshot.stage = stage;
            s.stage_began = Instant::now();
            s.snapshot.last_progress_at = chrono::Utc::now().to_rfc3339();
        });
    }
    pub fn generation(&self, captured_at: &str) {
        self.update(|s| s.snapshot.generation_captured_at = Some(captured_at.into()));
    }
    pub fn completed(&self, count: usize) {
        self.update(|s| s.snapshot.completed_generations = count);
    }
    pub fn operation_started(&self, operation: Operation) {
        self.update(|s| {
            s.snapshot.operation = Some(operation);
            s.snapshot.failed_operation = None;
            s.snapshot.bytes_per_second = None;
            s.command_bytes = 0;
            s.command_errors = 0;
        });
    }
    pub fn operation_finished(&self, operation: Operation, success: bool) {
        self.update(|s| {
            s.snapshot.operation = None;
            s.snapshot.bytes_per_second = None;
            if success {
                s.snapshot.operations_completed += 1;
                *s.snapshot.operation_counts.entry(operation).or_default() += 1;
                s.snapshot.last_progress_at = chrono::Utc::now().to_rfc3339();
            } else {
                s.snapshot.failed_operation = Some(operation);
            }
        });
    }
    /// Accept only the numeric stats object from rclone's JSON log. Restic
    /// prefixes child stderr with `rclone: `. Never retain message/object/path.
    pub fn observe_line(&self, line: &[u8]) {
        let line = line.strip_prefix(b"rclone: ").unwrap_or(line);
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            return;
        };
        let Some(stats) = value.get("stats").and_then(|s| s.as_object()) else {
            return;
        };
        let Some(bytes) = stats.get("bytes").and_then(|n| n.as_u64()) else {
            return;
        };
        let errors = stats.get("errors").and_then(|n| n.as_u64()).unwrap_or(0);
        self.update(|s| {
            let added = bytes.saturating_sub(s.command_bytes);
            s.snapshot.transport_bytes = Some(
                s.snapshot
                    .transport_bytes
                    .unwrap_or(0)
                    .saturating_add(added),
            );
            s.snapshot.transport_errors = s
                .snapshot
                .transport_errors
                .saturating_add(errors.saturating_sub(s.command_errors));
            if added > 0 || errors > s.command_errors {
                s.snapshot.last_progress_at = chrono::Utc::now().to_rfc3339();
            }
            s.command_bytes = s.command_bytes.max(bytes);
            s.command_errors = s.command_errors.max(errors);
            s.snapshot.bytes_per_second = stats
                .get("speed")
                .and_then(|n| n.as_f64())
                .filter(|n| n.is_finite() && *n >= 0.0);
        });
    }
    pub fn snapshot(&self) -> Snapshot {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut result = s.snapshot.clone();
        if result.running {
            result.elapsed_ms = s.began.elapsed().as_millis() as u64;
            result.stage_elapsed_ms = s.stage_began.elapsed().as_millis() as u64;
        }
        result
    }
    pub fn finish(&self, success: bool) -> Snapshot {
        self.update(|s| {
            s.snapshot.running = false;
            s.snapshot.elapsed_ms = s.began.elapsed().as_millis() as u64;
            s.snapshot.stage_elapsed_ms = s.stage_began.elapsed().as_millis() as u64;
            s.snapshot.operation = None;
            s.snapshot.bytes_per_second = None;
            if success {
                s.snapshot.stage = Stage::Complete;
                s.snapshot.last_progress_at = chrono::Utc::now().to_rfc3339();
            }
        });
        self.snapshot()
    }
}

pub(crate) fn live(workspace: &Path, target: &str) -> Option<Snapshot> {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(workspace.into(), target.into()))
        .and_then(Weak::upgrade)
        .map(|value| value.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stats_are_numeric_only_cumulative_and_not_a_fake_heartbeat() {
        let temp = tempfile::tempdir().unwrap();
        let p = Progress::start(temp.path(), "target", 4);
        p.completed(3);
        p.stage(Stage::TargetVerification);
        p.operation_started(Operation::Descriptor);
        p.observe_line(br#"rclone: {"stats":{"bytes":1024,"speed":100,"errors":1},"msg":"token=private-secret","object":"private-file"}"#);
        let first = p.snapshot();
        assert_eq!(first.transport_bytes, Some(1024));
        assert_eq!(first.transport_errors, 1);
        p.observe_line(br#"{"stats":{"bytes":1024,"speed":0,"errors":1}}"#);
        assert_eq!(p.snapshot().last_progress_at, first.last_progress_at);
        p.observe_line(br#"{"stats":{"bytes":-1,"speed":10000,"errors":500}}"#);
        p.observe_line(b"not a JSON log");
        assert_eq!(p.snapshot().transport_errors, 1);
        p.operation_finished(Operation::Descriptor, true);
        p.operation_started(Operation::FileList);
        p.observe_line(
            br#"{"stats":{"bytes":10,"speed":-3,"errors":0},"secret":"private-secret"}"#,
        );
        assert_eq!(p.snapshot().transport_bytes, Some(1034));
        assert_eq!(p.snapshot().bytes_per_second, None);
        p.operation_finished(Operation::FileList, false);
        let snapshot = p.finish(false);
        assert!(!snapshot.running);
        assert_eq!(snapshot.stage, Stage::TargetVerification);
        assert_eq!(snapshot.completed_generations, 3);
        assert_eq!(snapshot.operation_counts[&Operation::Descriptor], 1);
        assert!(!snapshot.operation_counts.contains_key(&Operation::FileList));
        assert_eq!(snapshot.failed_operation, Some(Operation::FileList));
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("private-secret") && !json.contains("private-file"));
        assert_eq!(p.snapshot().elapsed_ms, snapshot.elapsed_ms);
    }
    #[test]
    fn live_progress_is_scoped_and_expires_without_a_database_write() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let p = Progress::start(a.path(), "one", 2);
        assert!(live(a.path(), "one").unwrap().running);
        assert!(live(a.path(), "two").is_none());
        assert!(live(b.path(), "one").is_none());
        assert_eq!(std::fs::read_dir(a.path()).unwrap().count(), 0);
        let replacement = Progress::start(a.path(), "one", 3);
        drop(p);
        assert_eq!(live(a.path(), "one").unwrap().total_generations, 3);
        drop(replacement);
        assert!(live(a.path(), "one").is_none());
    }
}
