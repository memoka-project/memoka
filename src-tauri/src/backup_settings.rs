//! Workspace-local backup configuration and operational state. Never advances
//! content_epoch, and never contains passwords.
use crate::{document_model::ReadError, read_service::plain_file};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Retention {
    pub last: u32,
    pub daily: u32,
    pub monthly: u32,
}
impl Default for Retention {
    fn default() -> Self {
        Self {
            last: 48,
            daily: 30,
            monthly: 12,
        }
    }
}
impl Retention {
    pub fn validate(&self) -> Result<(), ReadError> {
        if self.last == 0 {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Keep at least one recent generation",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DestinationLocation {
    LocalDirectory {
        path: PathBuf,
    },
    GoogleDrive {
        connection_id: String,
        root_folder_id: String,
        display_name: String,
    },
}
impl DestinationLocation {
    pub fn local_path(&self) -> Option<&Path> {
        match self {
            Self::LocalDirectory { path } => Some(path),
            _ => None,
        }
    }
    pub fn is_cloud(&self) -> bool {
        matches!(self, Self::GoogleDrive { .. })
    }
    pub fn validate(&self) -> Result<(), ReadError> {
        match self {
            Self::GoogleDrive {
                connection_id,
                root_folder_id,
                ..
            } => {
                crate::cloud::validate_connection_id(connection_id)?;
                crate::cloud::validate_folder_id(root_folder_id)
            }
            _ => Ok(()),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdditionalTarget {
    pub id: String,
    pub location: DestinationLocation,
    pub repository_id: String,
    pub credential_ref: String,
    pub enabled: bool,
    pub retention: Retention,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupConfig {
    pub schema_version: u32,
    pub interval_minutes: u32,
    pub local_repository_id: Option<String>,
    pub local_retention: Retention,
    pub destinations: Vec<AdditionalTarget>,
}
impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            schema_version: 3,
            interval_minutes: 15,
            local_repository_id: None,
            local_retention: Retention::default(),
            destinations: Vec::new(),
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DestinationStatus {
    pub phase: String,
    pub last_copy_at: Option<String>,
    pub protected_capture_at: Option<String>,
    pub error: Option<ReadError>,
    pub maintenance_error: Option<ReadError>,
    pub verification_error: Option<ReadError>,
    pub pending_copy_count: usize,
    pub pending_verification_count: usize,
    pub expired_copy_count: usize,
    pub failure_count: u32,
    pub next_retry_at: Option<String>,
    pub active_generation_id: Option<String>,
    pub progress: Option<crate::backup_progress::Snapshot>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupStatus {
    pub phase: String,
    pub maintenance_error: Option<ReadError>,
    pub local_error: Option<ReadError>,
    pub last_local_captured_epoch: i64,
    pub last_local_capture_at: Option<String>,
    pub known_missing_count: usize,
    pub destinations: BTreeMap<String, DestinationStatus>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TransferLedger {
    pub repository_id: Option<String>,
    pub pending: BTreeMap<String, String>,
    pub expired: BTreeMap<String, String>,
    pub delivered: BTreeSet<String>,
    /// A successful copy is not yet a verified/protected generation. Keep its
    /// expected descriptor across restarts and local source retention.
    pub awaiting_verification: BTreeMap<String, crate::backup::Generation>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InitIntent {
    pub id: String,
    pub workspace_id: String,
    pub path: PathBuf,
    pub repository_id: Option<String>,
}
pub fn ledger_key(id: &str) -> String {
    format!("backup.transfers.{id}")
}

pub(crate) fn connection(workspace: &Path) -> Result<Connection, ReadError> {
    let path = workspace.join(".memoka/memoka.sqlite3");
    plain_file(&path)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}
pub(crate) fn read<T: serde::de::DeserializeOwned + Default>(
    db: &Connection,
    key: &str,
) -> Result<T, ReadError> {
    let value: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    value.map_or_else(
        || Ok(T::default()),
        |value| serde_json::from_str(&value).map_err(Into::into),
    )
}
fn write<T: Serialize>(db: &Connection, key: &str, value: &T) -> Result<(), ReadError> {
    db.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, serde_json::to_string(value)?])?;
    Ok(())
}
pub(crate) fn setting<T: serde::de::DeserializeOwned + Default>(
    workspace: &Path,
    key: &str,
) -> Result<T, ReadError> {
    read(&connection(workspace)?, key)
}
pub(crate) fn save_setting<T: Serialize>(
    workspace: &Path,
    key: &str,
    value: &T,
) -> Result<(), ReadError> {
    write(&connection(workspace)?, key, value)
}

/// Commit the durable queue and its public counts/protection together. A crash
/// must not lose verification work while leaving protection permanently stale.
pub(crate) fn save_transfer(
    workspace: &Path,
    id: &str,
    ledger: &TransferLedger,
    update: impl FnOnce(&mut DestinationStatus),
) -> Result<(), ReadError> {
    let mut db = connection(workspace)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut status: BackupStatus = read(&tx, "backup.status")?;
    let target = status.destinations.entry(id.to_owned()).or_default();
    target.pending_copy_count = ledger.pending.len();
    target.pending_verification_count = ledger.awaiting_verification.len();
    target.expired_copy_count = ledger.expired.len();
    update(target);
    write(&tx, &ledger_key(id), ledger)?;
    write(&tx, "backup.status", &status)?;
    tx.commit()?;
    Ok(())
}

/// One transaction moves the old singleton, ledger, status and unfinished init.
/// No Restic or credential-store access is needed, including when offline.
fn migrate(db: &mut Connection) -> Result<(), ReadError> {
    let raw: Value = read(db, "backup.config")?;
    // A fresh/restored Workspace has nothing to migrate. Pure config/status
    // reads must stay read-only, including while a history reader holds a
    // SQLite read transaction. The first settings write creates schema 3.
    if raw.is_null() {
        return Ok(());
    }
    if raw["schema_version"] == 3 {
        return Ok(());
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let raw: Value = read(&tx, "backup.config")?;
    if raw["schema_version"] == 3 {
        return Ok(());
    }
    if raw.get("schema_version").is_some_and(|v| v != 1 && v != 2) {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported backup configuration version",
        ));
    }
    let mut converted = raw.clone();
    if let Some(targets) = converted
        .get_mut("destinations")
        .and_then(Value::as_array_mut)
    {
        for target in targets {
            migrate_location(target)?;
        }
    }
    let mut config: BackupConfig = if raw.is_null() {
        BackupConfig::default()
    } else {
        serde_json::from_value(converted)?
    };
    let previous: Value = read(&tx, "backup.status")?;
    let mut status: BackupStatus = if previous.is_null() {
        BackupStatus::default()
    } else {
        serde_json::from_value(previous.clone())?
    };
    if let Some(target) = raw.get("additional").filter(|v| !v.is_null()) {
        let mut target = target.clone();
        let id = uuid::Uuid::now_v7().to_string();
        target["id"] = json!(id);
        target["enabled"] = json!(true);
        target["retention"] = serde_json::to_value(Retention::default())?;
        migrate_location(&mut target)?;
        config.destinations.push(serde_json::from_value(target)?);
        let mut migrated = json!({});
        for (old, new) in [
            ("additional_phase", "phase"),
            ("last_additional_copy_at", "last_copy_at"),
            ("additional_protected_capture_at", "protected_capture_at"),
            ("additional_error", "error"),
            ("pending_copy_count", "pending_copy_count"),
            ("expired_copy_count", "expired_copy_count"),
        ] {
            if let Some(value) = previous.get(old) {
                migrated[new] = value.clone();
            }
        }
        status
            .destinations
            .insert(id.clone(), serde_json::from_value(migrated)?);
        let ledger: TransferLedger = read(&tx, "backup.transfers")?;
        write(&tx, &ledger_key(&id), &ledger)?;
    }
    let pending: Value = read(&tx, "backup.additional_init_pending")?;
    if !pending.is_null() {
        let mut pending = pending;
        pending["id"] = json!(uuid::Uuid::now_v7().to_string());
        let pending: InitIntent = serde_json::from_value(pending)?;
        let mut intents: Vec<InitIntent> = read(&tx, "backup.init_intents")?;
        intents.push(pending);
        write(&tx, "backup.init_intents", &intents)?;
    }
    config.schema_version = 3;
    write(&tx, "backup.config", &config)?;
    write(&tx, "backup.status", &status)?;
    tx.execute(
        "DELETE FROM settings WHERE key IN ('backup.transfers','backup.additional_init_pending')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}
pub fn config(workspace: &Path) -> Result<BackupConfig, ReadError> {
    let mut db = connection(workspace)?;
    migrate(&mut db)?;
    let value: BackupConfig = read(&db, "backup.config")?;
    for target in &value.destinations {
        target.location.validate()?;
    }
    Ok(value)
}
/// History/CLI reads need only the unchanged local identity. Do not migrate
/// operational settings or allocate destination IDs just to read a generation.
pub(crate) fn read_local_repository_id(workspace: &Path) -> Result<Option<String>, ReadError> {
    let raw: Value = setting(workspace, "backup.config")?;
    if raw
        .get("schema_version")
        .is_some_and(|v| v != 1 && v != 2 && v != 3)
    {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported backup configuration version",
        ));
    }
    serde_json::from_value(raw["local_repository_id"].clone()).map_err(Into::into)
}
fn migrate_location(value: &mut Value) -> Result<(), ReadError> {
    let target = value
        .as_object_mut()
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Invalid legacy backup destination"))?;
    if target.contains_key("location") {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Legacy destination unexpectedly contains a location",
        ));
    }
    let path = target
        .remove("path")
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Missing legacy backup path"))?;
    target.insert(
        "location".into(),
        json!({"kind":"local-directory", "path":path}),
    );
    if let Some(credential) = target.remove("credential") {
        target.insert("credential_ref".into(), credential);
    }
    Ok(())
}
pub fn status(workspace: &Path) -> Result<BackupStatus, ReadError> {
    let mut db = connection(workspace)?;
    migrate(&mut db)?;
    read(&db, "backup.status")
}
pub(crate) fn update_config(
    workspace: &Path,
    update: impl FnOnce(&mut BackupConfig) -> Result<(), ReadError>,
) -> Result<(), ReadError> {
    let mut db = connection(workspace)?;
    migrate(&mut db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut value = read(&tx, "backup.config")?;
    update(&mut value)?;
    write(&tx, "backup.config", &value)?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn update_status(
    workspace: &Path,
    update: impl FnOnce(&mut BackupStatus),
) -> Result<(), ReadError> {
    let mut db = connection(workspace)?;
    migrate(&mut db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut value = read(&tx, "backup.status")?;
    update(&mut value);
    write(&tx, "backup.status", &value)?;
    tx.commit()?;
    Ok(())
}
pub fn set_local(workspace: &Path, minutes: u32, retention: Retention) -> Result<(), ReadError> {
    if !(1..=1440).contains(&minutes) {
        return Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Backup interval must be 1–1440 minutes",
        ));
    }
    retention.validate()?;
    update_config(workspace, |config| {
        config.interval_minutes = minutes;
        config.local_retention = retention;
        Ok(())
    })
}
pub fn destination(workspace: &Path, id: &str) -> Result<AdditionalTarget, ReadError> {
    config(workspace)?
        .destinations
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| ReadError::new("NOT_FOUND", "Backup destination not found"))
}
pub fn update_destination(
    workspace: &Path,
    id: &str,
    update: impl FnOnce(&mut AdditionalTarget),
) -> Result<(), ReadError> {
    update_config(workspace, |config| {
        let target = config
            .destinations
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| ReadError::new("NOT_FOUND", "Backup destination not found"))?;
        update(target);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".memoka")).unwrap();
        Connection::open(dir.path().join(".memoka/memoka.sqlite3"))
            .unwrap()
            .execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
            .unwrap();
        dir
    }
    #[test]
    fn transfer_queue_and_protection_commit_or_rollback_together() {
        let dir = fixture();
        let workspace = dir.path();
        let mut ledger = TransferLedger::default();
        ledger
            .pending
            .insert("generation".into(), "2026-09-06T00:00:00Z".into());
        save_transfer(workspace, "target", &ledger, |_| {}).unwrap();
        let db = connection(workspace).unwrap();
        db.execute_batch("CREATE TRIGGER reject_status BEFORE UPDATE ON settings
            WHEN NEW.key = 'backup.status' BEGIN SELECT RAISE(ABORT, 'test status write failure'); END;").unwrap();
        ledger.pending.clear();
        ledger.delivered.insert("generation".into());
        assert!(
            save_transfer(workspace, "target", &ledger, |s| {
                s.protected_capture_at = Some("2026-09-06T00:00:00Z".into());
            })
            .is_err()
        );
        let unchanged: TransferLedger = setting(workspace, &ledger_key("target")).unwrap();
        assert!(unchanged.delivered.is_empty());
        assert_eq!(unchanged.pending.len(), 1);
        let status: BackupStatus = setting(workspace, "backup.status").unwrap();
        assert!(status.destinations["target"].protected_capture_at.is_none());
        assert_eq!(status.destinations["target"].pending_copy_count, 1);
        db.execute_batch("DROP TRIGGER reject_status;").unwrap();
        save_transfer(workspace, "target", &ledger, |s| {
            s.protected_capture_at = Some("2026-09-06T00:00:00Z".into());
        })
        .unwrap();
        let saved: TransferLedger = setting(workspace, &ledger_key("target")).unwrap();
        assert!(saved.delivered.contains("generation"));
        let status: BackupStatus = setting(workspace, "backup.status").unwrap();
        assert!(status.destinations["target"].protected_capture_at.is_some());
        assert_eq!(status.destinations["target"].pending_copy_count, 0);
    }
    #[test]
    fn schema_two_migration_preserves_order_status_ledger_intent_and_content() {
        let dir = fixture();
        let path = dir.path();
        let targets = json!([
            {"id":"second","path":"/offline/B","repository_id":"b","credential":"ref-b","enabled":false,"retention":{"last":8,"daily":2,"monthly":1}},
            {"id":"first","path":"/offline/A","repository_id":"a","credential":"ref-a","enabled":true,"retention":{"last":9,"daily":0,"monthly":3}}
        ]);
        save_setting(path,"backup.config",&json!({"schema_version":2,"interval_minutes":17,"local_repository_id":"local","destinations":targets})).unwrap();
        let error = json!({"code":"ADDITIONAL_OFFLINE","message":"offline","details":null});
        save_setting(path,"backup.status",&json!({"last_local_captured_epoch":77,"destinations":{"second":{"phase":"error","error":error,"pending_copy_count":3,"expired_copy_count":2,"protected_capture_at":"2026-09-01T00:00:00Z"}}})).unwrap();
        let ledger =
            json!({"repository_id":"b","pending":{"p":"t"},"expired":{"e":"t"},"delivered":["d"]});
        let intents =
            json!([{"id":"retry","workspace_id":"w","path":"/offline/new","repository_id":"same"}]);
        save_setting(path, &ledger_key("second"), &ledger).unwrap();
        save_setting(path, "backup.init_intents", &intents).unwrap();
        save_setting(path, "content_epoch", &99).unwrap();
        connection(path).unwrap().execute_batch("CREATE TABLE untouched_document (bytes BLOB); INSERT INTO untouched_document VALUES (X'010203');").unwrap();
        let migrated = config(path).unwrap();
        assert_eq!(migrated.schema_version, 3);
        assert_eq!(
            migrated
                .destinations
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["second", "first"]
        );
        for (actual, original) in migrated
            .destinations
            .iter()
            .zip(targets.as_array().unwrap())
        {
            assert_eq!(actual.enabled, original["enabled"]);
            assert_eq!(actual.repository_id, original["repository_id"]);
            assert_eq!(actual.credential_ref, original["credential"]);
            assert_eq!(
                serde_json::to_value(&actual.retention).unwrap(),
                original["retention"]
            );
            assert_eq!(
                serde_json::to_value(&actual.location).unwrap()["path"],
                original["path"]
            );
        }
        assert_eq!(
            setting::<Value>(path, &ledger_key("second")).unwrap(),
            ledger
        );
        assert_eq!(
            setting::<Value>(path, "backup.init_intents").unwrap(),
            intents
        );
        assert_eq!(setting::<u64>(path, "content_epoch").unwrap(), 99);
        assert_eq!(
            status(path).unwrap().destinations["second"]
                .error
                .as_ref()
                .unwrap()
                .code,
            "ADDITIONAL_OFFLINE"
        );
        assert_eq!(
            status(path).unwrap().destinations["second"].expired_copy_count,
            2
        );
        assert_eq!(
            connection(path)
                .unwrap()
                .query_row("SELECT hex(bytes) FROM untouched_document", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "010203"
        );
        assert_eq!(
            serde_json::to_value(config(path).unwrap()).unwrap(),
            serde_json::to_value(migrated).unwrap()
        );
    }
    #[test]
    fn unknown_location_is_never_reinterpreted_as_local() {
        let dir = fixture();
        let value = json!({"schema_version":3,"destinations":[{"id":"bad","enabled":true,"repository_id":"x","credential_ref":"ref","retention":{"last":1,"daily":0,"monthly":0},"location":{"kind":"arbitrary-remote","path":"rclone:evil:"}}]});
        save_setting(dir.path(), "backup.config", &value).unwrap();
        assert!(config(dir.path()).is_err());
        assert_eq!(
            setting::<Value>(dir.path(), "backup.config").unwrap(),
            value
        );
    }
    #[test]
    fn singleton_migration_preserves_credentials_and_state_once() {
        let dir = fixture();
        let path = dir.path();
        save_setting(path, "backup.config", &json!({"interval_minutes":23,"local_repository_id":"local","additional":{"path":"/offline/repo","repository_id":"other","credential":"repo:other"}})).unwrap();
        save_setting(path, "backup.status", &json!({"phase":"idle","last_local_captured_epoch":9,"additional_phase":"error","pending_copy_count":2,"expired_copy_count":1,"additional_error":{"code":"OFFLINE","message":"offline","details":null},"additional_protected_capture_at":"2026-09-01T00:00:00Z"})).unwrap();
        save_setting(
            path,
            "backup.transfers",
            &json!({"repository_id":"other","pending":{"a":"time"},"expired":{},"delivered":["b"]}),
        )
        .unwrap();
        save_setting(
            path,
            "backup.additional_init_pending",
            &json!({"workspace_id":"workspace","path":"/other/repo","repository_id":"interrupted"}),
        )
        .unwrap();
        let migrated = config(path).unwrap();
        let target = &migrated.destinations[0];
        assert_eq!(migrated.interval_minutes, 23);
        assert_eq!(target.credential_ref, "repo:other");
        assert!(target.enabled);
        assert_eq!(target.retention, Retention::default());
        assert_eq!(config(path).unwrap().destinations[0].id, target.id);
        let status = status(path).unwrap();
        assert_eq!(status.last_local_captured_epoch, 9);
        assert_eq!(status.destinations[&target.id].pending_copy_count, 2);
        let ledger: TransferLedger = setting(path, &ledger_key(&target.id)).unwrap();
        assert!(ledger.delivered.contains("b"));
        assert_eq!(ledger.pending["a"], "time");
        let intents: Vec<InitIntent> = setting(path, "backup.init_intents").unwrap();
        assert_eq!(intents[0].repository_id.as_deref(), Some("interrupted"));
    }
    #[test]
    fn rejects_unknown_versions_and_invalid_retention_without_resetting() {
        let dir = fixture();
        assert!(
            set_local(
                dir.path(),
                15,
                Retention {
                    last: 0,
                    daily: 1,
                    monthly: 1
                }
            )
            .is_err()
        );
        set_local(
            dir.path(),
            15,
            Retention {
                last: 1,
                daily: 0,
                monthly: 0,
            },
        )
        .unwrap();
        save_setting(dir.path(), "backup.config", &json!({"schema_version":99})).unwrap();
        assert_eq!(config(dir.path()).unwrap_err().code, "UNSUPPORTED_SCHEMA");
        assert_eq!(
            setting::<Value>(dir.path(), "backup.config").unwrap()["schema_version"],
            99
        );
    }

    #[test]
    fn fresh_settings_reads_are_read_only_and_metadata_can_change_during_work() {
        let dir = fixture();
        let path = dir.path();
        let reader = connection(path).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM settings;")
            .unwrap();
        assert_eq!(config(path).unwrap().schema_version, 3);
        assert!(status(path).unwrap().destinations.is_empty());
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM settings", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        reader.execute_batch("COMMIT;").unwrap();

        update_config(path, |config| {
            config.destinations.push(AdditionalTarget {
                id: "target".into(),
                location: DestinationLocation::LocalDirectory {
                    path: PathBuf::from("/offline/target"),
                },
                repository_id: "repository".into(),
                credential_ref: "test-credential-reference".into(),
                enabled: true,
                retention: Retention::default(),
            });
            Ok(())
        })
        .unwrap();
        update_status(path, |state| {
            state.destinations.entry("target".into()).or_default().phase = "copying".into();
        })
        .unwrap();
        let service = crate::native_service::NativeService::new(path.to_owned());
        service
            .settings(crate::native_service::BackupSettingsRequest::Enabled {
                id: "target".into(),
                enabled: false,
            })
            .unwrap();
        // A subsequent worker status write cannot restore stale configuration.
        update_status(path, |state| {
            state.destinations.get_mut("target").unwrap().phase = "idle".into();
        })
        .unwrap();
        set_local(
            path,
            20,
            Retention {
                last: 7,
                daily: 0,
                monthly: 0,
            },
        )
        .unwrap();
        assert!(!destination(path, "target").unwrap().enabled);
        assert_eq!(
            destination(path, "target").unwrap().retention,
            Retention::default()
        );
        assert_eq!(status(path).unwrap().destinations["target"].phase, "idle");
    }

    #[test]
    fn history_identity_lookup_does_not_migrate_legacy_settings() {
        let dir = fixture();
        let path = dir.path();
        let original = json!({"local_repository_id":"local","additional":{"path":"/offline","repository_id":"other","credential":"repo:other"}});
        save_setting(path, "backup.config", &original).unwrap();
        let reader = connection(path).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM settings;")
            .unwrap();
        assert_eq!(
            read_local_repository_id(path).unwrap().as_deref(),
            Some("local")
        );
        assert_eq!(setting::<Value>(path, "backup.config").unwrap(), original);
        reader.execute_batch("COMMIT;").unwrap();
    }
}
