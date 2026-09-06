//! A process-local receipt for a fully checked backup cycle. This is not a
//! substitute for repository validation: cold starts, changed content, targets
//! or repository files always fall back to the normal verified path.
use crate::{
    backup,
    backup_settings::{self as settings, BackupConfig, BackupStatus},
    document_model::ReadError,
    read_service::{checked_directory, hash_file, plain_file},
    restic::Repository,
};
use serde::{Deserialize, de::IgnoredAny};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Debug, PartialEq, Eq)]
struct RepositoryStamp {
    config_hash: String,
    snapshots: BTreeMap<String, (u64, SystemTime)>,
}
impl RepositoryStamp {
    fn read(path: &Path) -> Result<Self, ReadError> {
        Repository::at(path.to_owned(), crate::restic::Password::Insecure).validate_path()?;
        checked_directory(path)?;
        let config = path.join("config");
        // A Restic config is tiny. Never hash an unexpectedly huge replacement
        // on the fast path, and never follow a substituted symlink.
        if plain_file(&config)?.len() > 64 * 1024 {
            return Err(ReadError::new(
                "INVALID_DATA",
                "Unexpected repository config size",
            ));
        }
        let config_hash = hash_file(&config)?;
        let directory = path.join("snapshots");
        checked_directory(&directory)?;
        let mut snapshots = BTreeMap::new();
        for item in fs::read_dir(directory)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            backup::validate_hash(&name)?;
            let metadata = plain_file(&item.path())?;
            snapshots.insert(name, (metadata.len(), metadata.modified()?));
        }
        Ok(Self {
            config_hash,
            snapshots,
        })
    }
}

// Project the operational JSON instead of materializing descriptors with all
// document revisions, attachment hashes and Section IDs on every no-op check.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Ledger {
    repository_id: Option<String>,
    pending: BTreeMap<String, IgnoredAny>,
    delivered: BTreeSet<String>,
    awaiting_verification: BTreeMap<String, IgnoredAny>,
}
#[derive(Deserialize)]
struct AcceptedGeneration {
    snapshot_id: String,
    repository_id: String,
    descriptor: AcceptedDescriptor,
}
#[derive(Deserialize)]
struct AcceptedDescriptor {
    generation_id: String,
    content_epoch: i64,
}

pub(crate) struct BackupCheckpoint {
    epoch: i64,
    repository_id: String,
    generations: BTreeSet<String>,
    repositories: BTreeMap<PathBuf, RepositoryStamp>,
    targets: BTreeMap<String, Value>,
}
impl BackupCheckpoint {
    /// Only call after run_local and all local copies succeeded, under the
    /// service's capture and repository-reader leases. Never load a receipt
    /// from disk on startup merely because persisted status says "idle".
    pub(crate) fn record(workspace: &Path) -> Result<Option<Self>, ReadError> {
        let mut db = settings::connection(workspace)?;
        let tx = db.transaction()?;
        let config: BackupConfig = settings::read(&tx, "backup.config")?;
        let status: BackupStatus = settings::read(&tx, "backup.status")?;
        let Some(repository_id) = config.local_repository_id else {
            return Ok(None);
        };
        if status.local_error.is_some() || status.last_local_capture_at.is_none() {
            return Ok(None);
        }
        let source = Repository::local(workspace).local_path()?.to_owned();
        let stamp = RepositoryStamp::read(&source)?;
        let accepted: Vec<AcceptedGeneration> =
            settings::read(&tx, &format!("backup.cache.{repository_id}"))?;
        let accepted: Vec<_> = accepted
            .into_iter()
            .filter(|g| {
                g.repository_id == repository_id && stamp.snapshots.contains_key(&g.snapshot_id)
            })
            .collect();
        if !accepted
            .iter()
            .any(|g| g.descriptor.content_epoch == status.last_local_captured_epoch)
        {
            return Ok(None);
        }
        let mut repositories = BTreeMap::from([(source, stamp)]);
        let mut targets = BTreeMap::new();
        for target in config.destinations.iter().filter(|t| t.enabled) {
            targets.insert(target.id.clone(), serde_json::to_value(target)?);
            if let Some(path) = target.location.local_path() {
                repositories.insert(path.to_owned(), RepositoryStamp::read(path)?);
            }
        }
        Ok(Some(Self {
            epoch: status.last_local_captured_epoch,
            repository_id,
            generations: accepted
                .into_iter()
                .map(|g| g.descriptor.generation_id)
                .collect(),
            repositories,
            targets,
        }))
    }

    /// Read-only, with no child processes, keyring or network access. Public
    /// pending counts alone aren't proof: every retained generation must be
    /// acknowledged by the matching destination repository's durable ledger.
    pub(crate) fn is_current(&self, workspace: &Path) -> Result<bool, ReadError> {
        let mut db = settings::connection(workspace)?;
        let tx = db.transaction()?;
        let epoch: Option<i64> = settings::read(&tx, "content_epoch")?;
        if epoch != Some(self.epoch) {
            return Ok(false);
        }
        let config: BackupConfig = settings::read(&tx, "backup.config")?;
        let status: BackupStatus = settings::read(&tx, "backup.status")?;
        if config.schema_version != 3
            || config.local_repository_id.as_deref() != Some(&self.repository_id)
            || status.last_local_captured_epoch != self.epoch
            || status.last_local_capture_at.is_none()
            || status.local_error.is_some()
            || status.phase != "idle"
        {
            return Ok(false);
        }
        let source = Repository::local(workspace).local_path()?.to_owned();
        if !self.repository_unchanged(&source) {
            return Ok(false);
        }
        for target in config.destinations.iter().filter(|t| t.enabled) {
            if self.targets.get(&target.id) != Some(&serde_json::to_value(target)?) {
                return Ok(false);
            }
            let Some(state) = status.destinations.get(&target.id) else {
                return Ok(false);
            };
            if state.error.is_some() || state.pending_copy_count != 0 {
                return Ok(false);
            }
            let ledger: Ledger = settings::read(&tx, &settings::ledger_key(&target.id))?;
            if ledger.repository_id.as_deref() != Some(&target.repository_id)
                || !ledger.pending.is_empty()
                || self.generations.iter().any(|id| {
                    !ledger.delivered.contains(id)
                        && !(target.location.is_cloud()
                            && ledger.awaiting_verification.contains_key(id))
                })
            {
                return Ok(false);
            }
            if let Some(path) = target.location.local_path() {
                if !self.repository_unchanged(path) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    fn repository_unchanged(&self, path: &Path) -> bool {
        self.repositories.get(path).is_some_and(|previous| {
            RepositoryStamp::read(path).is_ok_and(|current| &current == previous)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backup_settings::*,
        restic::{Restic, cancellation},
    };
    use serde_json::json;

    #[test]
    fn receipt_checks_epoch_repository_inventory_and_the_actual_transfer_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path();
        backup::tests::fixture(workspace);
        let restic = Restic::discover(cancellation()).unwrap();
        let generation = backup::run_local(workspace, &restic).unwrap().unwrap();
        let epoch = backup::content_epoch(workspace).unwrap();
        let mut config = backup::config(workspace).unwrap();
        let cloud = AdditionalTarget {
            id: uuid::Uuid::now_v7().to_string(),
            location: DestinationLocation::GoogleDrive {
                connection_id: uuid::Uuid::now_v7().to_string(),
                root_folder_id: "test-folder".into(),
                display_name: "Synthetic acknowledgement, no Google access".into(),
            },
            repository_id: "b".repeat(64),
            credential_ref: "never-accessed".into(),
            enabled: true,
            retention: Default::default(),
        };
        config.destinations.push(cloud.clone());
        backup::save_setting(workspace, "backup.config", &config).unwrap();
        let checkpoint = BackupCheckpoint::record(workspace).unwrap().unwrap();
        // A public count of zero is not proof of successful upload.
        backup::update_status(workspace, |s| {
            s.destinations.insert(cloud.id.clone(), Default::default());
        })
        .unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        let mut ledger = TransferLedger {
            repository_id: Some(cloud.repository_id.clone()),
            awaiting_verification: BTreeMap::from([(
                generation.descriptor.generation_id.clone(),
                generation.clone(),
            )]),
            ..Default::default()
        };
        save_transfer(workspace, &cloud.id, &ledger, |s| {
            s.phase = "verification-pending".into();
        })
        .unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());
        // Deferred verification failure is not an upload failure.
        backup::update_status(workspace, |s| {
            s.destinations
                .get_mut(&cloud.id)
                .unwrap()
                .verification_error = Some(ReadError::new("TEMPORARY", "offline"));
        })
        .unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());
        backup::update_status(workspace, |s| {
            s.destinations.get_mut(&cloud.id).unwrap().error =
                Some(ReadError::new("TEMPORARY", "upload failed"));
        })
        .unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        backup::update_status(workspace, |s| {
            s.destinations.get_mut(&cloud.id).unwrap().error = None;
        })
        .unwrap();

        // Even a stale/misleading public pending count cannot hide work.
        ledger.pending.insert("old-pending".into(), "time".into());
        backup::save_setting(workspace, &ledger_key(&cloud.id), &ledger).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        ledger.pending.clear();
        ledger.repository_id = Some("c".repeat(64));
        backup::save_setting(workspace, &ledger_key(&cloud.id), &ledger).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        ledger.repository_id = Some(cloud.repository_id.clone());
        backup::save_setting(workspace, &ledger_key(&cloud.id), &ledger).unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());

        // Only content changes require a new capture; UI state does not.
        backup::save_setting(workspace, "ui-test", &json!({"focus":"sidebar"})).unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());
        backup::save_setting(workspace, "content_epoch", &(epoch + 1)).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        backup::save_setting(workspace, "content_epoch", &epoch).unwrap();
        config.destinations[0].repository_id = "c".repeat(64);
        backup::save_setting(workspace, "backup.config", &config).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        config.destinations[0] = cloud.clone();
        let mut new_target = cloud.clone();
        new_target.id = uuid::Uuid::now_v7().to_string();
        config.destinations.push(new_target);
        backup::save_setting(workspace, "backup.config", &config).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        config.destinations[1].enabled = false;
        backup::save_setting(workspace, "backup.config", &config).unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());
        config.local_repository_id = Some("d".repeat(64));
        backup::save_setting(workspace, "backup.config", &config).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        config.local_repository_id = Some(generation.repository_id.clone());
        backup::save_setting(workspace, "backup.config", &config).unwrap();

        let repo = Repository::local(workspace)
            .local_path()
            .unwrap()
            .to_owned();
        let snapshot = repo.join("snapshots").join(&generation.snapshot_id);
        let moved = repo.join("held-snapshot");
        fs::rename(&snapshot, &moved).unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
        fs::rename(&moved, &snapshot).unwrap();
        assert!(checkpoint.is_current(workspace).unwrap());
        // Repository config replacement is detected without decrypting it in
        // a child process. The subsequent normal path reports the real error.
        fs::rename(repo.join("config"), repo.join("held-config")).unwrap();
        fs::write(repo.join("config"), b"replaced").unwrap();
        assert!(!checkpoint.is_current(workspace).unwrap());
    }

    #[test]
    fn local_destination_presence_and_snapshot_changes_invalidate_a_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(cancellation()).unwrap();
        let generation = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let source = Repository::local(&workspace);
        let path = temp.path().join("additional");
        let target_repo = Repository::at(path.clone(), crate::restic::Password::Insecure);
        let repository_id = restic.initialize(&target_repo, Some(&source)).unwrap();
        crate::backup_management::copy_generation(&restic, &source, &target_repo, &generation)
            .unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let mut config = backup::config(&workspace).unwrap();
        config.destinations.push(AdditionalTarget {
            id: id.clone(),
            location: DestinationLocation::LocalDirectory { path: path.clone() },
            repository_id: repository_id.clone(),
            credential_ref: "test-only".into(),
            enabled: true,
            retention: Default::default(),
        });
        backup::save_setting(&workspace, "backup.config", &config).unwrap();
        let accepted = backup::copied_generation(
            &restic,
            &target_repo,
            &generation.descriptor.workspace_id,
            &generation.descriptor.generation_id,
        )
        .unwrap();
        let ledger = TransferLedger {
            repository_id: Some(repository_id),
            delivered: BTreeSet::from([generation.descriptor.generation_id.clone()]),
            ..Default::default()
        };
        save_transfer(&workspace, &id, &ledger, |s| {
            s.phase = "idle".into();
        })
        .unwrap();
        let checkpoint = BackupCheckpoint::record(&workspace).unwrap().unwrap();
        assert!(checkpoint.is_current(&workspace).unwrap());
        let offline = temp.path().join("offline");
        fs::rename(&path, &offline).unwrap();
        assert!(!checkpoint.is_current(&workspace).unwrap());
        fs::rename(&offline, &path).unwrap();
        assert!(checkpoint.is_current(&workspace).unwrap());
        let snapshot = path.join("snapshots").join(accepted.snapshot_id);
        fs::rename(&snapshot, temp.path().join("held-snapshot")).unwrap();
        fs::write(snapshot, b"changed").unwrap();
        assert!(!checkpoint.is_current(&workspace).unwrap());
    }
}
