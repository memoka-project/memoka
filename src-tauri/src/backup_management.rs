//! Independent destinations and retention use the pinned Restic implementation.
use crate::{
    backup::{self, AdditionalTarget, Generation, Retention},
    backup_progress::{Progress, Stage},
    backup_settings::{
        self as settings, DestinationLocation, DestinationStatus, InitIntent, TransferLedger,
        ledger_key,
    },
    document_model::ReadError,
    history,
    read_service::{WorkspaceReader, checked_directory},
    restic::{Password, Repository, Restic, args},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, ffi::OsString, fs, path::Path, time::Duration};

#[cfg(test)]
use crate::credentials::credentials_error;
use crate::credentials::{Credentials, OsCredentials};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deferred_copy_survives_restart_lost_response_and_source_retention() {
        use crate::backup_progress::Operation;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let first = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let source = backup::local_repository(&workspace, &restic, false).unwrap();
        let credentials = TestCredentials::default();
        let directory = temp.path().join("destination");
        fs::create_dir(&directory).unwrap();
        configure_destination(
            &workspace,
            &restic,
            &directory,
            "test-only-key".into(),
            Retention::default(),
            &credentials,
        )
        .unwrap();
        let target = backup::config(&workspace).unwrap().destinations.remove(0);
        let repo = open_destination(&target, &restic, &credentials).unwrap();
        copy_target(
            &workspace,
            &restic,
            &source,
            std::slice::from_ref(&first),
            &target,
            &credentials,
            1,
            false,
        )
        .unwrap();
        backup::save_setting(
            &workspace,
            "content_epoch",
            &(backup::content_epoch(&workspace).unwrap() + 1),
        )
        .unwrap();
        let second = backup::run_local(&workspace, &restic).unwrap().unwrap();
        // Copy finished remotely, but the process lost its response before
        // recording it. Retrying must not create a second remote generation.
        upload_generation(&restic, &source, &repo, &second).unwrap();
        let local = vec![second.clone(), first.clone()];
        let value = copy_target(
            &workspace,
            &restic,
            &source,
            &local,
            &target,
            &credentials,
            1,
            true,
        )
        .unwrap();
        assert_eq!(value["copied"], 1);
        let key = ledger_key(&target.id);
        let ledger: TransferLedger = backup::setting(&workspace, &key).unwrap();
        assert_eq!(ledger.awaiting_verification.len(), 1);
        assert!(!ledger.delivered.contains(&second.descriptor.generation_id));
        assert!(!upload_pending(&ledger, &local, &target.repository_id));
        let status = backup::status(&workspace).unwrap().destinations[&target.id].clone();
        assert_eq!(status.phase, "verification-pending");
        assert_eq!(status.pending_copy_count, 0);
        assert_eq!(status.pending_verification_count, 1);
        assert_eq!(
            status.protected_capture_at.as_deref(),
            Some(first.descriptor.captured_at.as_str())
        );
        let operations = &status.progress.unwrap().operation_counts;
        assert_eq!(operations[&Operation::Copy], 1);
        assert!(!operations.contains_key(&Operation::Snapshots));
        assert_eq!(operations[&Operation::Descriptor], 1); // local source only
        assert_eq!(operations[&Operation::FileList], 1);
        assert_eq!(
            maintain_repository(&workspace, &restic, &repo, false, true)
                .unwrap_err()
                .code,
            "VERIFICATION_PENDING"
        );

        // During departure there is no target connection/verification or
        // maintenance, even if deferred work is due and credentials unavailable.
        let mut config = backup::config(&workspace).unwrap();
        config.destinations[0].location = DestinationLocation::GoogleDrive {
            connection_id: uuid::Uuid::now_v7().to_string(),
            root_folder_id: "never-connect-to-this-test-folder".into(),
            display_name: "test".into(),
        };
        backup::save_setting(&workspace, "backup.config", &config).unwrap();
        assert!(
            !cloud_unit(&workspace, &restic, None, true, |_| panic!(
                "must defer verification"
            ))
            .unwrap()
        );
        config.destinations[0] = target.clone();
        backup::save_setting(&workspace, "backup.config", &config).unwrap();

        // Mismatched verification metadata never advances protection or
        // re-uploads. The expected descriptor is durable, not a memory-only queue.
        let mut invalid = ledger.clone();
        invalid
            .awaiting_verification
            .get_mut(&second.descriptor.generation_id)
            .unwrap()
            .descriptor
            .content_epoch += 1;
        backup::save_setting(&workspace, &key, &invalid).unwrap();
        assert_eq!(
            verify_target(&workspace, &restic, &target, &credentials)
                .unwrap_err()
                .code,
            "HISTORY_CORRUPT"
        );
        let status = backup::status(&workspace).unwrap().destinations[&target.id].clone();
        assert!(status.error.is_none());
        assert_eq!(status.verification_error.unwrap().code, "HISTORY_CORRUPT");
        assert_eq!(status.pending_verification_count, 1);
        assert_eq!(
            status.protected_capture_at.as_deref(),
            Some(first.descriptor.captured_at.as_str())
        );
        backup::save_setting(&workspace, &key, &ledger).unwrap();

        backup::save_setting(
            &workspace,
            "content_epoch",
            &(backup::content_epoch(&workspace).unwrap() + 1),
        )
        .unwrap();
        backup::run_local(&workspace, &restic).unwrap().unwrap();
        settings::set_local(
            &workspace,
            15,
            Retention {
                last: 1,
                daily: 0,
                monthly: 0,
            },
        )
        .unwrap();
        maintain_repository(&workspace, &restic, &source, false, false).unwrap();
        let ledger: TransferLedger = backup::setting(&workspace, &key).unwrap();
        assert!(
            ledger
                .awaiting_verification
                .contains_key(&second.descriptor.generation_id)
        );
        assert!(
            !ledger
                .expired
                .contains_key(&second.descriptor.generation_id)
        );
        // A fresh worker can verify even though the local source is now gone.
        let restarted = Restic::discover(crate::restic::cancellation()).unwrap();
        verify_target(&workspace, &restarted, &target, &credentials).unwrap();
        let ledger: TransferLedger = backup::setting(&workspace, &key).unwrap();
        assert!(ledger.awaiting_verification.is_empty());
        assert!(ledger.delivered.contains(&second.descriptor.generation_id));
        let status = backup::status(&workspace).unwrap().destinations[&target.id].clone();
        assert!(status.verification_error.is_none());
        assert_eq!(status.pending_verification_count, 0);
        assert_eq!(
            status.protected_capture_at.as_deref(),
            Some(second.descriptor.captured_at.as_str())
        );
        assert!(
            !status
                .progress
                .unwrap()
                .operation_counts
                .contains_key(&Operation::Copy)
        );
        assert_eq!(
            backup::generations(&restarted, &repo, None, None)
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn deferred_failure_does_not_backoff_new_uploads() {
        let now = chrono::Utc::now();
        let mut status = DestinationStatus {
            verification_error: Some(ReadError::new("TEMPORARY", "retry verification")),
            maintenance_error: Some(ReadError::new("REPOSITORY_LOCKED", "retry cleanup")),
            next_retry_at: Some((now + chrono::Duration::hours(1)).to_rfc3339()),
            ..Default::default()
        };
        assert!(cloud_retry_due(Some(&status), now, CloudWork::Upload));
        assert!(!cloud_retry_due(Some(&status), now, CloudWork::Verify));
        assert!(!cloud_retry_due(Some(&status), now, CloudWork::Maintain));
        status.verification_error = Some(ReadError::new("REPOSITORY_MISMATCH", "stop"));
        assert!(!cloud_retry_due(Some(&status), now, CloudWork::Upload));
    }
    #[test]
    fn small_history_skips_forget_and_prune_but_rechecks_after_growth_or_setting_changes() {
        use crate::backup_progress::Operation;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let first = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let repo = backup::local_repository(&workspace, &restic, false).unwrap();
        let retention = Retention {
            last: 2,
            daily: 0,
            monthly: 0,
        };
        settings::set_local(&workspace, 15, retention.clone()).unwrap();
        let progress = Progress::start(&workspace, "no-op-maintenance", 0);
        let observed = restic.with_progress(progress.clone());
        let plan = maintain_repository(&workspace, &observed, &repo, false, true).unwrap();
        assert_eq!(plan.keep, [first.snapshot_id.clone()]);
        assert!(plan.remove.is_empty());
        let counts = progress.snapshot().operation_counts;
        assert!(!counts.contains_key(&Operation::Forget));
        assert!(!counts.contains_key(&Operation::Prune));
        assert!(!maintenance_due(&workspace, &first.repository_id, &retention).unwrap());
        assert!(
            backup::setting::<Option<String>>(
                &workspace,
                &format!("backup.last_prune.{}", first.repository_id)
            )
            .unwrap()
            .is_none()
        );
        assert!(maintenance_due(&workspace, &first.repository_id, &Retention::default()).unwrap());
        for expected_due in [false, true] {
            backup::save_setting(
                &workspace,
                "content_epoch",
                &(backup::content_epoch(&workspace).unwrap() + 1),
            )
            .unwrap();
            backup::run_local(&workspace, &restic).unwrap().unwrap();
            assert_eq!(
                maintenance_due(&workspace, &first.repository_id, &retention).unwrap(),
                expected_due
            );
        }
        // Dry-run must not acknowledge deletion or set the cleanup journal.
        let plan = maintain_repository(&workspace, &restic, &repo, true, true).unwrap();
        assert_eq!(plan.remove, [first.snapshot_id.clone()]);
        assert!(!prune_pending(&workspace, &first.repository_id).unwrap());
        assert!(maintenance_due(&workspace, &first.repository_id, &retention).unwrap());
        maintain_repository(&workspace, &restic, &repo, false, false).unwrap();
        assert!(prune_pending(&workspace, &first.repository_id).unwrap());
        assert!(maintenance_due(&workspace, &first.repository_id, &retention).unwrap());
        let progress = Progress::start(&workspace, "pending-prune", 0);
        maintain_repository(
            &workspace,
            &restic.with_progress(progress.clone()),
            &repo,
            false,
            true,
        )
        .unwrap();
        assert_eq!(progress.snapshot().operation_counts[&Operation::Prune], 1);
        assert!(!prune_pending(&workspace, &first.repository_id).unwrap());
        assert!(!maintenance_due(&workspace, &first.repository_id, &retention).unwrap());
        assert_eq!(
            backup::generations(&restic, &repo, None, None)
                .unwrap()
                .len(),
            2
        );
        // A scan becomes due again without relying on a physical prune time.
        backup::save_setting(
            &workspace,
            &format!("backup.last_maintenance.{}", first.repository_id),
            &Some((chrono::Utc::now() - chrono::Duration::hours(25)).to_rfc3339()),
        )
        .unwrap();
        assert!(maintenance_due(&workspace, &first.repository_id, &retention).unwrap());
    }
    #[test]
    fn interrupted_writes_keep_cleanup_pending_across_successful_copies() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let generation = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let id = &generation.repository_id;
        assert!(!prune_pending(&workspace, id).unwrap());
        assert!(!begin_repository_write(&workspace, id).unwrap());
        // Simulated crash: no completion call. A successful retry must not
        // clear the older cleanup request, including after process restart.
        let old = begin_repository_write(&workspace, id).unwrap();
        assert!(old);
        complete_repository_write(&workspace, id, old).unwrap();
        assert!(prune_pending(&workspace, id).unwrap());
        let repo = backup::local_repository(&workspace, &restic, false).unwrap();
        maintain_repository(&workspace, &restic, &repo, false, false).unwrap();
        assert!(prune_pending(&workspace, id).unwrap());
        maintain_repository(&workspace, &restic, &repo, false, true).unwrap();
        assert!(!prune_pending(&workspace, id).unwrap());
        // Another interruption is retained but cannot run prune twice a day.
        begin_repository_write(&workspace, id).unwrap();
        assert!(!maintenance_due(&workspace, id, &Retention::default()).unwrap());
        backup::save_setting(
            &workspace,
            &format!("backup.last_prune.{id}"),
            &Some((chrono::Utc::now() - chrono::Duration::hours(25)).to_rfc3339()),
        )
        .unwrap();
        assert!(maintenance_due(&workspace, id, &Retention::default()).unwrap());
    }
    #[test]
    fn pending_prune_still_rejects_unknown_matching_snapshots_and_keeps_its_retry_journal() {
        use crate::backup_progress::Operation;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let generation = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let repo = backup::local_repository(&workspace, &restic, false).unwrap();
        let unknown = temp.path().join("unknown.txt");
        fs::write(&unknown, "synthetic unrecognized snapshot").unwrap();
        restic
            .run(
                &repo,
                &args(&[
                    "backup",
                    "--tag",
                    "memoka",
                    "--tag",
                    &format!("workspace:{}", generation.descriptor.workspace_id),
                    "--tag",
                    &format!("generation:{}", uuid::Uuid::now_v7()),
                    "--tag",
                    "unknown",
                    unknown.to_str().unwrap(),
                ]),
                None,
            )
            .unwrap();
        // A no-delete/no-prune scan may leave these files untouched. A prune
        // must NOT bypass the exact-set check just because keep-last is large.
        begin_repository_write(&workspace, &generation.repository_id).unwrap();
        let progress = Progress::start(&workspace, "unsafe-prune", 0);
        let error = maintain_repository(
            &workspace,
            &restic.with_progress(progress.clone()),
            &repo,
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(error.code, "RETENTION_UNSAFE");
        assert!(
            !progress
                .snapshot()
                .operation_counts
                .contains_key(&Operation::Prune)
        );
        assert!(prune_pending(&workspace, &generation.repository_id).unwrap());
        assert_eq!(
            restic
                .json(&repo, &["snapshots"])
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn post_copy_verifies_only_the_selected_generation_and_remembers_it() {
        use crate::backup_progress::Operation;
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation())
            .unwrap()
            .with_transfer_cache()
            .unwrap();
        let source = backup::local_repository(&workspace, &restic, true).unwrap();
        let target = Repository::at(
            temp.path().join("target"),
            Password::Secret("test-backup-only".into()),
        );
        restic.initialize(&target, Some(&source)).unwrap();
        let mut latest = None;
        for _ in 0..4 {
            backup::save_setting(
                &workspace,
                "content_epoch",
                &(backup::content_epoch(&workspace).unwrap() + 1),
            )
            .unwrap();
            let generation = backup::run_local(&workspace, &restic).unwrap().unwrap();
            copy_generation(&restic, &source, &target, &generation).unwrap();
            latest = Some(generation);
        }
        let latest = latest.unwrap();
        let progress = Progress::start(&workspace, "test", 4);
        let observed = restic.with_progress(progress.clone());
        // A retry (lost copy response) uses the same identity and still fully
        // verifies that generation, without reading the other three bodies.
        let copied = copy_generation_verified(&observed, &source, &target, &latest).unwrap();
        assert_ne!(copied.snapshot_id, latest.snapshot_id);
        assert_eq!(
            serde_json::to_value(&copied.descriptor).unwrap(),
            serde_json::to_value(&latest.descriptor).unwrap()
        );
        let counts = progress.snapshot().operation_counts;
        assert_eq!(counts[&Operation::Snapshots], 1);
        assert_eq!(counts[&Operation::Descriptor], 2); // source + just this target
        assert_eq!(counts[&Operation::FileList], 2);
        backup::remember_generation(&workspace, &copied).unwrap();
        let cached: Vec<Generation> = backup::setting(
            &workspace,
            &format!("backup.cache.{}", copied.repository_id),
        )
        .unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].snapshot_id, copied.snapshot_id);
        assert_eq!(
            backup::copied_generation(
                &restic,
                &target,
                &latest.descriptor.workspace_id,
                &uuid::Uuid::now_v7().to_string()
            )
            .unwrap_err()
            .code,
            "INCOMPLETE_GENERATION"
        );
    }
    #[test]
    fn cloud_backoff_and_manual_reauthentication_are_distinct() {
        let now = chrono::Utc::now();
        let mut state = DestinationStatus::default();
        assert!(cloud_retry_due(Some(&state), now, CloudWork::Upload));
        state.error = Some(ReadError::new("CLOUD_RATE_LIMIT", "retry later"));
        state.next_retry_at = Some((now + chrono::Duration::seconds(90)).to_rfc3339());
        assert!(!cloud_retry_due(Some(&state), now, CloudWork::Upload));
        assert!(cloud_retry_due(
            Some(&state),
            now + chrono::Duration::seconds(91),
            CloudWork::Upload
        ));
        for code in [
            "CLOUD_REAUTH_REQUIRED",
            "CREDENTIALS_UNAVAILABLE",
            "REPOSITORY_MISMATCH",
        ] {
            state.error = Some(ReadError::new(code, "manual action required"));
            assert!(!cloud_retry_due(
                Some(&state),
                now + chrono::Duration::days(30),
                CloudWork::Upload
            ));
        }
    }
    use std::{
        collections::BTreeMap,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    #[derive(Default)]
    struct TestCredentials {
        values: Mutex<BTreeMap<String, String>>,
        locked: AtomicBool,
    }
    impl Credentials for TestCredentials {
        fn get(&self, id: &str) -> Result<String, ReadError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(credentials_error());
            }
            self.values
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(credentials_error)
        }
        fn set(&self, id: &str, value: &str) -> Result<(), ReadError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(credentials_error());
            }
            self.values
                .lock()
                .unwrap()
                .insert(id.to_string(), value.to_string());
            Ok(())
        }
        fn remove(&self, id: &str) {
            self.values.lock().unwrap().remove(id);
        }
    }
    #[test]
    fn real_restic_three_destinations_isolate_keys_disabled_targets_and_failures() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        crate::backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let first = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let credentials = TestCredentials::default();
        for name in ["a", "b", "c"] {
            let parent = temp.path().join(name);
            fs::create_dir(&parent).unwrap();
            configure_destination(
                &workspace,
                &restic,
                &parent,
                format!("private-key-{name}"),
                Retention::default(),
                &credentials,
            )
            .unwrap();
        }
        let targets = backup::config(&workspace).unwrap().destinations;
        assert_eq!(targets.len(), 3);
        assert_eq!(
            targets
                .iter()
                .map(|item| &item.repository_id)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        assert!(
            !serde_json::to_string(&backup::config(&workspace).unwrap())
                .unwrap()
                .contains("private-key")
        );
        assert_eq!(
            configure_destination(
                &workspace,
                &restic,
                &temp.path().join("a"),
                "private-key-a".into(),
                Retention::default(),
                &credentials
            )
            .unwrap_err()
            .code,
            "DESTINATION_EXISTS"
        );
        let copied =
            copy_destinations(&workspace, &restic, Duration::from_secs(180), &credentials).unwrap();
        assert!(
            copied["destinations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["copied"] == 1),
            "{copied}"
        );
        for target in &targets {
            let repo = open_destination(target, &restic, &credentials).unwrap();
            let snapshots = backup::generations(&restic, &repo, None, None).unwrap();
            assert_eq!(snapshots.len(), 1);
            assert_eq!(
                snapshots[0].descriptor.generation_id,
                first.descriptor.generation_id
            );
            assert_eq!(
                snapshots[0].descriptor.captured_at,
                first.descriptor.captured_at
            );
        }
        settings::update_destination(&workspace, &targets[1].id, |target| target.enabled = false)
            .unwrap();
        credentials
            .set(&targets[2].credential_ref, "wrong-password")
            .unwrap();
        backup::save_setting(
            &workspace,
            "content_epoch",
            &(backup::content_epoch(&workspace).unwrap() + 1),
        )
        .unwrap();
        let second = backup::run_local(&workspace, &restic).unwrap().unwrap();
        let copied =
            copy_destinations(&workspace, &restic, Duration::from_secs(180), &credentials).unwrap();
        assert_eq!(copied["destinations"].as_array().unwrap().len(), 2);
        let status = backup::status(&workspace).unwrap();
        assert_eq!(
            status.destinations[&targets[0].id]
                .protected_capture_at
                .as_deref(),
            Some(second.descriptor.captured_at.as_str())
        );
        assert_eq!(
            status.destinations[&targets[1].id]
                .protected_capture_at
                .as_deref(),
            Some(first.descriptor.captured_at.as_str())
        );
        assert!(status.destinations[&targets[2].id].error.is_some());
        let previous_secret = credentials.get(&targets[2].credential_ref).unwrap();
        assert!(
            reregister(
                &workspace,
                &restic,
                &targets[2].id,
                "not-correct".into(),
                &credentials
            )
            .is_err()
        );
        assert_eq!(
            credentials.get(&targets[2].credential_ref).unwrap(),
            previous_secret
        );
        reregister(
            &workspace,
            &restic,
            &targets[2].id,
            "private-key-c".into(),
            &credentials,
        )
        .unwrap();
        // Paused destinations are never maintained, even when explicitly asked.
        let b = open_destination(&targets[1], &restic, &credentials).unwrap();
        assert_eq!(
            maintain_repository(&workspace, &restic, &b, false, false)
                .unwrap_err()
                .code,
            "DESTINATION_DISABLED"
        );
        // A zero-length budget is incomplete, and no destination is reported
        // as successfully copied just because it never got a turn.
        let exhausted = copy_destinations(&workspace, &restic, Duration::ZERO, &credentials);
        assert!(
            exhausted.is_err()
                || exhausted.unwrap()["destinations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item.get("error").is_some())
        );
        // Local retention does not pin paused destinations. Even a generation
        // never placed into their queue must be recorded as an expired chance.
        backup::save_setting(
            &workspace,
            "content_epoch",
            &(backup::content_epoch(&workspace).unwrap() + 1),
        )
        .unwrap();
        let third = backup::run_local(&workspace, &restic).unwrap().unwrap();
        settings::set_local(
            &workspace,
            15,
            Retention {
                last: 1,
                daily: 0,
                monthly: 0,
            },
        )
        .unwrap();
        let local = backup::local_repository(&workspace, &restic, false).unwrap();
        maintain_repository(&workspace, &restic, &local, false, false).unwrap();
        let b_ledger: TransferLedger =
            backup::setting(&workspace, &ledger_key(&targets[1].id)).unwrap();
        assert!(
            b_ledger
                .expired
                .contains_key(&second.descriptor.generation_id)
        );
        assert_eq!(
            backup::status(&workspace).unwrap().destinations[&targets[1].id].expired_copy_count,
            1
        );
        settings::update_destination(&workspace, &targets[1].id, |target| target.enabled = true)
            .unwrap();
        copy_destinations(&workspace, &restic, Duration::from_secs(180), &credentials).unwrap();
        for target in &targets {
            let status = backup::status(&workspace).unwrap();
            assert!(status.destinations[&target.id].error.is_none());
            assert_eq!(status.destinations[&target.id].pending_copy_count, 0);
            let repo = open_destination(target, &restic, &credentials).unwrap();
            let kept = backup::generations(&restic, &repo, None, None).unwrap();
            assert_eq!(kept.len(), if target.id == targets[0].id { 3 } else { 2 });
            assert_eq!(
                kept[0].descriptor.generation_id,
                third.descriptor.generation_id
            );
        }
        // Distinct retention policies operate only on the requested repository.
        settings::update_destination(&workspace, &targets[0].id, |target| {
            target.retention = Retention {
                last: 1,
                daily: 0,
                monthly: 0,
            }
        })
        .unwrap();
        let a = open_destination(&targets[0], &restic, &credentials).unwrap();
        let plan = maintain_repository(&workspace, &restic, &a, true, false).unwrap();
        assert_eq!(plan.keep.len(), 1);
        assert_eq!(plan.remove.len(), 2);
        maintain_repository(&workspace, &restic, &a, false, false).unwrap();
        assert_eq!(
            backup::generations(&restic, &b, None, None).unwrap().len(),
            2
        );
        let kept = backup::generations(&restic, &a, None, None).unwrap();
        crate::history::restore(&restic, &a, &kept[0], &temp.path().join("restored")).unwrap();
        // An offlined directory fails independently while another remains usable.
        fs::rename(temp.path().join("b"), temp.path().join("b-disconnected")).unwrap();
        let copied =
            copy_destinations(&workspace, &restic, Duration::from_secs(180), &credentials).unwrap();
        assert_eq!(
            copied["destinations"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item.get("error").is_some())
                .count(),
            1
        );
    }
    #[test]
    fn initialized_repository_survives_keyring_failure_and_retry() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        crate::backup::tests::fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        backup::run_local(&workspace, &restic).unwrap();
        let parent = temp.path().join("additional");
        fs::create_dir(&parent).unwrap();
        let credentials = TestCredentials::default();
        credentials.locked.store(true, Ordering::Relaxed);
        assert_eq!(
            configure_destination(
                &workspace,
                &restic,
                &parent,
                "secret".into(),
                Retention::default(),
                &credentials
            )
            .unwrap_err()
            .code,
            "CREDENTIALS_UNAVAILABLE"
        );
        let intent: Vec<InitIntent> = backup::setting(&workspace, "backup.init_intents").unwrap();
        assert_eq!(intent.len(), 1);
        assert!(intent[0].repository_id.is_some());
        assert!(backup::config(&workspace).unwrap().destinations.is_empty());
        credentials.locked.store(false, Ordering::Relaxed);
        configure_destination(
            &workspace,
            &restic,
            &parent,
            "secret".into(),
            Retention::default(),
            &credentials,
        )
        .unwrap();
        let config = backup::config(&workspace).unwrap();
        assert_eq!(config.destinations[0].id, intent[0].id);
        assert_eq!(
            Some(&config.destinations[0].repository_id),
            intent[0].repository_id.as_ref()
        );
        assert!(
            backup::setting::<Vec<InitIntent>>(&workspace, "backup.init_intents")
                .unwrap()
                .is_empty()
        );
    }
}
pub fn additional_repository(
    target: &AdditionalTarget,
    restic: &Restic,
) -> Result<Repository, ReadError> {
    open_destination(target, restic, &OsCredentials)
}
fn open_destination(
    target: &AdditionalTarget,
    restic: &Restic,
    credentials: &dyn Credentials,
) -> Result<Repository, ReadError> {
    if let DestinationLocation::GoogleDrive {
        connection_id,
        root_folder_id,
        ..
    } = &target.location
    {
        return crate::cloud::CloudService::discover()?.repository(
            connection_id,
            root_folder_id,
            Password::Secret(credentials.get(&target.credential_ref)?),
            Some(&target.repository_id),
            restic,
        );
    }
    let path = target
        .location
        .local_path()
        .ok_or_else(|| ReadError::new("INVALID_ARGUMENT", "Invalid local destination"))?;
    if !path.join("config").is_file() {
        return Err(ReadError::new(
            "ADDITIONAL_OFFLINE",
            "The backup destination is not connected",
        ));
    }
    let repo = Repository::at(
        path.to_owned(),
        Password::Secret(credentials.get(&target.credential_ref)?),
    );
    if restic.repository_id(&repo)? != target.repository_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Backup destination identity changed",
        ));
    }
    Ok(repo)
}
pub fn configure_additional(
    workspace: &Path,
    restic: &Restic,
    parent: &Path,
    secret: String,
    retention: Retention,
) -> Result<(), ReadError> {
    configure_destination(workspace, restic, parent, secret, retention, &OsCredentials)
}
fn configure_destination(
    workspace: &Path,
    restic: &Restic,
    parent: &Path,
    secret: String,
    retention: Retention,
    credentials: &dyn Credentials,
) -> Result<(), ReadError> {
    retention.validate()?;
    if secret.is_empty() {
        return Err(ReadError::new(
            "INVALID_ARGUMENT",
            "A backup destination requires a nonempty password",
        ));
    }
    checked_directory(parent)?;
    let parent = fs::canonicalize(parent)?;
    let workspace = fs::canonicalize(workspace)?;
    if parent.starts_with(&workspace) || workspace.starts_with(&parent) {
        return Err(ReadError::new(
            "UNSAFE_PATH",
            "Additional storage must be outside the Workspace and its ancestors",
        ));
    }
    let workspace_id = WorkspaceReader::open(&workspace)?.workspace_id;
    let source = backup::local_repository(&workspace, restic, false)?;
    let path = parent.join(format!("memoka-{workspace_id}"));
    let config = backup::config(&workspace)?;
    if config
        .destinations
        .iter()
        .filter_map(|old| old.location.local_path())
        .any(|old| old == path || path.starts_with(old) || old.starts_with(&path))
    {
        return Err(ReadError::new(
            "DESTINATION_EXISTS",
            "This destination is already registered or overlaps another destination",
        ));
    }
    let mut intents: Vec<InitIntent> = backup::setting(&workspace, "backup.init_intents")?;
    let pending = intents
        .iter()
        .find(|item| item.path == path && item.workspace_id == workspace_id)
        .cloned();
    let id = pending
        .as_ref()
        .map(|item| item.id.clone())
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let expected = pending.as_ref().and_then(|item| item.repository_id.clone());
    let repo = Repository::at(path.clone(), Password::Secret(secret));
    let repository_id = if path.join("config").is_file() {
        if pending.is_none() {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Unrecognized existing repository; initialization refused",
            ));
        }
        let found = restic.repository_id(&repo)?;
        if expected.as_ref().is_some_and(|old| *old != found) {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Backup destination identity changed",
            ));
        }
        found
    } else {
        if expected.is_some() {
            return Err(ReadError::new(
                "REPOSITORY_MISSING",
                "The initialized destination is missing",
            ));
        }
        if pending.is_none() {
            intents.push(InitIntent {
                id: id.clone(),
                workspace_id: workspace_id.clone(),
                path: path.clone(),
                repository_id: None,
            });
            backup::save_setting(&workspace, "backup.init_intents", &intents)?;
        }
        restic.initialize(&repo, Some(&source))?
    };
    if config
        .destinations
        .iter()
        .any(|item| item.repository_id == repository_id)
    {
        return Err(ReadError::new(
            "DESTINATION_EXISTS",
            "This repository is already registered",
        ));
    }
    // Persist the successful init before accessing the keyring. A retry never
    // silently initializes a different repository after a keyring failure.
    let intent = intents
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Missing initialization intent"))?;
    intent.repository_id = Some(repository_id.clone());
    backup::save_setting(&workspace, "backup.init_intents", &intents)?;
    let credential_id = format!("repo:{repository_id}");
    if let Password::Secret(secret) = &repo.password {
        credentials.set(&credential_id, secret)?;
    }
    backup::update_config(&workspace, |config| {
        config.destinations.push(AdditionalTarget {
            id: id.clone(),
            location: DestinationLocation::LocalDirectory { path },
            repository_id,
            credential_ref: credential_id,
            enabled: true,
            retention,
        });
        Ok(())
    })?;
    intents.retain(|item| item.id != id);
    backup::save_setting(&workspace, "backup.init_intents", &intents)?;
    Ok(())
}
pub fn register_credential(
    workspace: &Path,
    restic: &Restic,
    id: &str,
    secret: String,
) -> Result<(), ReadError> {
    reregister(workspace, restic, id, secret, &OsCredentials)
}
fn reregister(
    workspace: &Path,
    restic: &Restic,
    id: &str,
    secret: String,
    credentials: &dyn Credentials,
) -> Result<(), ReadError> {
    let target = settings::destination(workspace, id)?;
    let repo = match &target.location {
        DestinationLocation::LocalDirectory { path } => {
            Repository::at(path.clone(), Password::Secret(secret))
        }
        DestinationLocation::GoogleDrive {
            connection_id,
            root_folder_id,
            ..
        } => crate::cloud::CloudService::discover()?.repository(
            connection_id,
            root_folder_id,
            Password::Secret(secret),
            Some(&target.repository_id),
            restic,
        )?,
    };
    if restic.repository_id(&repo)? != target.repository_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Backup destination identity changed",
        ));
    }
    if let Password::Secret(secret) = &repo.password {
        credentials.set(&target.credential_ref, secret)?;
    }
    Ok(())
}
pub fn detach_additional(workspace: &Path, id: &str) -> Result<(), ReadError> {
    let previous = settings::destination(workspace, id)?;
    if let DestinationLocation::GoogleDrive { connection_id, .. } = &previous.location {
        crate::cloud::CloudService::discover()?.update_binding(
            connection_id,
            &WorkspaceReader::open(workspace)?.workspace_id,
            id,
            None,
        )?;
    }
    backup::update_config(workspace, |config| {
        config.destinations.retain(|item| item.id != id);
        Ok(())
    })?;
    // Repository passwords are OS-user/repository scoped. Another Workspace
    // may still use this same repository; never delete its shared key here.
    backup::save_setting(workspace, &ledger_key(id), &TransferLedger::default())?;
    backup::update_status(workspace, |status| {
        status.destinations.remove(id);
    })?;
    // Keep the repository itself intact for standalone recovery.
    Ok(())
}
fn update_target_status(
    workspace: &Path,
    id: &str,
    update: impl FnOnce(&mut DestinationStatus),
) -> Result<(), ReadError> {
    backup::update_status(workspace, |status| {
        update(status.destinations.entry(id.to_owned()).or_default())
    })
}
pub fn copy(workspace: &Path, restic: &Restic, budget: Duration) -> Result<Value, ReadError> {
    copy_destinations(workspace, restic, budget, &OsCredentials)
}
pub fn copy_local(workspace: &Path, restic: &Restic) -> Result<Value, ReadError> {
    copy_selected(workspace, restic, None, &OsCredentials, true)
}
fn copy_destinations(
    workspace: &Path,
    restic: &Restic,
    budget: Duration,
    credentials: &dyn Credentials,
) -> Result<Value, ReadError> {
    copy_selected(workspace, restic, Some(budget), credentials, false)
}
fn copy_selected(
    workspace: &Path,
    restic: &Restic,
    budget: Option<Duration>,
    credentials: &dyn Credentials,
    local_only: bool,
) -> Result<Value, ReadError> {
    let bounded = budget.map_or_else(|| restic.clone(), |budget| restic.within(budget));
    let restic = &bounded;
    let mut targets = backup::config(workspace)?
        .destinations
        .into_iter()
        .filter(|item| item.enabled && (!local_only || !item.location.is_cloud()))
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(json!({"schema_version":3,"destinations":[]}));
    }
    let next: Option<String> = backup::setting(workspace, "backup.copy_next_id")?;
    if let Some(index) = next.and_then(|id| targets.iter().position(|item| item.id == id)) {
        targets.rotate_left(index);
    }
    let source = backup::local_repository(workspace, restic, false)?;
    let workspace_id = WorkspaceReader::open(workspace)?.workspace_id;
    let local = backup::generations(restic, &source, Some(&workspace_id), Some(workspace))?;
    let mut results = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        if restic.cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(ReadError::new("CANCELLED", "Backup copy cancelled"));
        }
        if !settings::destination(workspace, &target.id)?.enabled {
            continue;
        }
        let result = if restic.expired() {
            Err(ReadError::new(
                "COPY_TIMEOUT",
                "Transfer budget expired; this destination remains pending",
            ))
        } else {
            // Advance before trying: an offline/slow first target cannot starve
            // the other destinations on every automatic run.
            backup::save_setting(
                workspace,
                "backup.copy_next_id",
                &Some(&targets[(index + 1) % targets.len()].id),
            )?;
            copy_target(
                workspace,
                restic,
                &source,
                &local,
                target,
                credentials,
                usize::MAX,
                false,
            )
        };
        match result {
            Ok(value) => results.push(value),
            Err(error) => {
                update_target_status(workspace, &target.id, |state| {
                    state.phase = "error".into();
                    state.error = Some(error.clone());
                })?;
                results.push(json!({"id":target.id,"error":error}));
            }
        }
    }
    Ok(json!({"schema_version":3,"destinations":results}))
}
fn copy_target(
    workspace: &Path,
    restic: &Restic,
    source: &Repository,
    local: &[Generation],
    target: &AdditionalTarget,
    credentials: &dyn Credentials,
    generation_limit: usize,
    defer_verification: bool,
) -> Result<Value, ReadError> {
    let key = ledger_key(&target.id);
    let progress = Progress::start(workspace, &target.id, local.len());
    let observed = restic.with_progress(progress.clone());
    let restic = &observed;
    let mut ledger: TransferLedger = backup::setting(workspace, &key)?;
    if ledger.repository_id.as_deref() != Some(&target.repository_id) {
        ledger = TransferLedger {
            repository_id: Some(target.repository_id.clone()),
            ..Default::default()
        };
    }
    let live = local
        .iter()
        .map(|item| item.descriptor.generation_id.as_str())
        .collect::<BTreeSet<_>>();
    for (id, time) in ledger.pending.clone() {
        if !live.contains(id.as_str()) {
            ledger.pending.remove(&id);
            ledger.expired.insert(id, time);
        }
    }
    for item in local {
        if !ledger.delivered.contains(&item.descriptor.generation_id)
            && !ledger
                .awaiting_verification
                .contains_key(&item.descriptor.generation_id)
        {
            ledger
                .pending
                .entry(item.descriptor.generation_id.clone())
                .or_insert(item.descriptor.captured_at.clone());
        }
    }
    backup::save_setting(workspace, &key, &ledger)?;
    progress.completed(
        local
            .iter()
            .filter(|g| {
                ledger.delivered.contains(&g.descriptor.generation_id)
                    || ledger
                        .awaiting_verification
                        .contains_key(&g.descriptor.generation_id)
            })
            .count(),
    );
    update_target_status(workspace, &target.id, |state| {
        state.phase = "copying".into();
        state.error = None;
        state.pending_copy_count = ledger.pending.len();
        state.pending_verification_count = ledger.awaiting_verification.len();
        state.expired_copy_count = ledger.expired.len();
        state.progress = None;
    })?;
    let result = (|| -> Result<Value, ReadError> {
        let cached;
        let restic = if target.location.is_cloud() {
            cached = restic.with_transfer_cache()?;
            &cached
        } else {
            restic
        };
        let repo = open_destination(target, restic, credentials)?;
        // Restic copy is idempotent by source snapshot identity. For deferred
        // cloud transfers, do not re-list/verify the remote history before
        // sending new data. A lost copy response can safely retry the copy.
        let copied = if defer_verification {
            Vec::new()
        } else {
            restic.stage(Stage::Listing);
            backup::generations(
                restic,
                &repo,
                local
                    .first()
                    .map(|item| item.descriptor.workspace_id.as_str()),
                Some(workspace),
            )?
        };
        for item in &copied {
            ledger.pending.remove(&item.descriptor.generation_id);
            ledger
                .awaiting_verification
                .remove(&item.descriptor.generation_id);
            ledger
                .delivered
                .insert(item.descriptor.generation_id.clone());
        }
        progress.completed(
            local
                .iter()
                .filter(|g| {
                    ledger.delivered.contains(&g.descriptor.generation_id)
                        || ledger
                            .awaiting_verification
                            .contains_key(&g.descriptor.generation_id)
                })
                .count(),
        );
        backup::save_setting(workspace, &key, &ledger)?;
        let mut protected = if defer_verification {
            backup::status(workspace)?
                .destinations
                .get(&target.id)
                .and_then(|s| s.protected_capture_at.clone())
        } else {
            copied
                .first()
                .map(|item| item.descriptor.captured_at.clone())
        };
        update_target_status(workspace, &target.id, |state| {
            state.protected_capture_at = protected.clone();
            state.pending_copy_count = ledger.pending.len();
            state.pending_verification_count = ledger.awaiting_verification.len();
        })?;
        let mut count = 0;
        let active = backup::status(workspace)?
            .destinations
            .get(&target.id)
            .and_then(|s| s.active_generation_id.clone());
        let mut order: Vec<_> = local.iter().collect();
        if target.location.is_cloud() {
            // A failed active generation keeps its turn; new captures cannot
            // starve it. Once source retention expires it, use remaining data.
            order.sort_by_key(|g| active.as_deref() != Some(g.descriptor.generation_id.as_str()));
        }
        for generation in order {
            if count >= generation_limit {
                break;
            }
            if !ledger
                .pending
                .contains_key(&generation.descriptor.generation_id)
            {
                continue;
            }
            if !settings::destination(workspace, &target.id)?.enabled {
                break;
            }
            if restic.expired() {
                return Err(ReadError::new(
                    "COPY_TIMEOUT",
                    "Transfer budget expired; remaining generations will be retried",
                ));
            }
            update_target_status(workspace, &target.id, |state| {
                state.active_generation_id = Some(generation.descriptor.generation_id.clone())
            })?;
            progress.generation(&generation.descriptor.captured_at);
            let was_pending = begin_repository_write(workspace, &target.repository_id)?;
            if defer_verification {
                upload_generation(restic, source, &repo, generation)?;
                ledger.awaiting_verification.insert(
                    generation.descriptor.generation_id.clone(),
                    generation.clone(),
                );
            } else {
                let verified = copy_generation_verified(restic, source, &repo, generation)?;
                backup::remember_generation(workspace, &verified)?;
                ledger
                    .delivered
                    .insert(generation.descriptor.generation_id.clone());
            }
            ledger.pending.remove(&generation.descriptor.generation_id);
            count += 1;
            progress.completed(
                local
                    .iter()
                    .filter(|g| {
                        ledger.delivered.contains(&g.descriptor.generation_id)
                            || ledger
                                .awaiting_verification
                                .contains_key(&g.descriptor.generation_id)
                    })
                    .count(),
            );
            if !defer_verification
                && protected.as_ref().is_none_or(|old| {
                    chrono::DateTime::parse_from_rfc3339(old).ok()
                        < chrono::DateTime::parse_from_rfc3339(&generation.descriptor.captured_at)
                            .ok()
                })
            {
                protected = Some(generation.descriptor.captured_at.clone());
            }
            settings::save_transfer(workspace, &target.id, &ledger, |state| {
                state.last_copy_at = Some(chrono::Utc::now().to_rfc3339());
                state.protected_capture_at = protected.clone();
                state.active_generation_id = None;
                state.phase = if !ledger.awaiting_verification.is_empty() {
                    "verification-pending"
                } else {
                    "idle"
                }
                .into();
            })?;
            complete_repository_write(workspace, &target.repository_id, was_pending)?;
        }
        Ok(
            json!({"id":target.id,"copied":count,"pending":ledger.pending.len(),"expired":ledger.expired.len()}),
        )
    })();
    let ledger: TransferLedger = backup::setting(workspace, &key)?;
    let summary = progress.finish(result.is_ok());
    update_target_status(workspace, &target.id, |state| {
        state.progress = Some(summary);
        state.pending_copy_count = ledger.pending.len();
        state.pending_verification_count = ledger.awaiting_verification.len();
        state.expired_copy_count = ledger.expired.len();
        state.phase = if result.is_err() {
            "error"
        } else if !ledger.awaiting_verification.is_empty() {
            "verification-pending"
        } else {
            "idle"
        }
        .into();
        state.error = result.as_ref().err().cloned();
        if result.is_ok() || !target.location.is_cloud() {
            state.active_generation_id = None;
        }
    })?;
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloudWork {
    Upload,
    Verify,
    Maintain,
}

fn upload_pending(ledger: &TransferLedger, local: &[Generation], repository_id: &str) -> bool {
    ledger.repository_id.as_deref() != Some(repository_id)
        || local.iter().any(|g| {
            !ledger.delivered.contains(&g.descriptor.generation_id)
                && !ledger
                    .awaiting_verification
                    .contains_key(&g.descriptor.generation_id)
        })
        || ledger
            .pending
            .keys()
            .any(|id| !local.iter().any(|g| &g.descriptor.generation_id == id))
}

/// One cloud upload, verification or maintenance unit gets its own one-hour
/// deadline. Re-evaluate the queue only after it finishes; new captures do not
/// restart it. The caller holds a source-reader lease, not a capture mutex.
pub(crate) fn cloud_unit(
    workspace: &Path,
    restic: &Restic,
    force: Option<&str>,
    transfers_only: bool,
    selected: impl FnOnce(&str),
) -> Result<bool, ReadError> {
    let mut targets: Vec<_> = backup::config(workspace)?
        .destinations
        .into_iter()
        .filter(|t| t.enabled && t.location.is_cloud())
        .collect();
    if targets.is_empty() {
        return Ok(false);
    }
    let next: Option<String> = backup::setting(workspace, "backup.cloud_next_id")?;
    if let Some(index) = next.and_then(|id| targets.iter().position(|t| t.id == id)) {
        targets.rotate_left(index);
    }
    if let Some(id) = force {
        targets.retain(|t| t.id == id);
    }
    let source = backup::local_repository(workspace, restic, false)?;
    let workspace_id = WorkspaceReader::open(workspace)?.workspace_id;
    let local = backup::generations(restic, &source, Some(&workspace_id), Some(workspace))?;
    let status = backup::status(workspace)?;
    // Send new generations to every available destination before starting
    // remote verification or maintenance. Departure stops at this boundary.
    for kind in [CloudWork::Upload, CloudWork::Verify, CloudWork::Maintain] {
        if transfers_only && kind != CloudWork::Upload {
            break;
        }
        for (index, target) in targets.iter().enumerate() {
            if force.is_none()
                && !cloud_retry_due(
                    status.destinations.get(&target.id),
                    chrono::Utc::now(),
                    kind,
                )
            {
                continue;
            }
            let ledger: TransferLedger = backup::setting(workspace, &ledger_key(&target.id))?;
            let pending = upload_pending(&ledger, &local, &target.repository_id);
            let needs_maintenance = status
                .destinations
                .get(&target.id)
                .is_some_and(|s| s.protected_capture_at.is_some())
                && maintenance_due(workspace, &target.repository_id, &target.retention)?;
            let eligible = match kind {
                CloudWork::Upload => pending,
                CloudWork::Verify => !pending && !ledger.awaiting_verification.is_empty(),
                CloudWork::Maintain => {
                    !pending
                        && ledger.awaiting_verification.is_empty()
                        && (needs_maintenance || force.is_some())
                }
            };
            if !eligible {
                continue;
            }
            selected(&target.id);
            backup::save_setting(
                workspace,
                "backup.cloud_next_id",
                &Some(&targets[(index + 1) % targets.len()].id),
            )?;
            let result = if kind == CloudWork::Upload {
                copy_target(
                    workspace,
                    restic,
                    &source,
                    &local,
                    target,
                    &OsCredentials,
                    1,
                    true,
                )
                .map(|_| ())
            } else if kind == CloudWork::Verify {
                verify_target(workspace, restic, target, &OsCredentials)
            } else {
                let progress = Progress::start(workspace, &target.id, 0);
                progress.stage(Stage::Maintaining);
                let restic = restic.with_progress(progress.clone());
                update_target_status(workspace, &target.id, |s| {
                    s.phase = "maintaining".into();
                })?;
                let result = restic
                    .with_transfer_cache()
                    .and_then(|restic| {
                        let repo = additional_repository(target, &restic)?;
                        maintain_repository(workspace, &restic, &repo, false, true)
                    })
                    .map(|_| ());
                let summary = progress.finish(result.is_ok());
                update_target_status(workspace, &target.id, |s| s.progress = Some(summary))?;
                result
            };
            let ledger: TransferLedger = backup::setting(workspace, &ledger_key(&target.id))?;
            update_target_status(workspace, &target.id, |state| {
                if kind == CloudWork::Upload && result.is_ok() {
                    state.active_generation_id = None;
                }
                match &result {
                    Ok(()) => {
                        match kind {
                            CloudWork::Upload => state.error = None,
                            CloudWork::Verify => state.verification_error = None,
                            CloudWork::Maintain => state.maintenance_error = None,
                        }
                        if state.error.is_none()
                            && state.verification_error.is_none()
                            && state.maintenance_error.is_none()
                        {
                            state.failure_count = 0;
                            state.next_retry_at = None;
                        }
                        state.phase = if !ledger.awaiting_verification.is_empty() {
                            "verification-pending"
                        } else {
                            "idle"
                        }
                        .into();
                    }
                    Err(error) => {
                        state.phase = if error.code == "CANCELLED" {
                            "cancelled"
                        } else {
                            "error"
                        }
                        .into();
                        match kind {
                            CloudWork::Upload => state.error = Some(error.clone()),
                            CloudWork::Verify => state.verification_error = Some(error.clone()),
                            CloudWork::Maintain => state.maintenance_error = Some(error.clone()),
                        }
                        state.failure_count = state.failure_count.saturating_add(1);
                        let seconds = 30i64
                            .saturating_mul(1i64 << state.failure_count.min(10))
                            .min(3600)
                            + (rand::random::<u16>() % 31) as i64;
                        state.next_retry_at = Some(
                            (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339(),
                        );
                    }
                }
            })?;
            // The error is persisted per target. Return control to the scheduler
            // so another target still gets a turn, without a modal/global failure.
            return Ok(true);
        }
    }
    Ok(false)
}
fn cloud_retry_due(
    state: Option<&DestinationStatus>,
    now: chrono::DateTime<chrono::Utc>,
    kind: CloudWork,
) -> bool {
    let Some(state) = state else {
        return true;
    };
    if [
        &state.error,
        &state.verification_error,
        &state.maintenance_error,
    ]
    .into_iter()
    .flatten()
    .any(|e| {
        matches!(
            e.code.as_str(),
            "CLOUD_REAUTH_REQUIRED"
                | "CLOUD_CLIENT_INVALID"
                | "CLOUD_CLIENT_CHANGED"
                | "CLOUD_SCOPE_MISMATCH"
                | "CREDENTIALS"
                | "CREDENTIALS_UNAVAILABLE"
                | "CLOUD_ACCOUNT_CHANGED"
                | "CLOUD_ROOT_UNAVAILABLE"
                | "CLOUD_ROOT_INVALID"
                | "DRIVE_UNSAFE_LAYOUT"
                | "CLOUD_ACCESS_DENIED"
                | "CLOUD_QUOTA"
                | "REPOSITORY_MISMATCH"
                | "REPOSITORY_MISSING"
        )
    }) {
        return false;
    }
    let error = match kind {
        CloudWork::Upload => &state.error,
        CloudWork::Verify => &state.verification_error,
        CloudWork::Maintain => &state.maintenance_error,
    };
    // A failed deferred check/cleanup must not delay the next upload.
    if error.is_none() {
        return true;
    }
    state
        .next_retry_at
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|time| time <= now)
}

pub fn copy_generation(
    restic: &Restic,
    source: &Repository,
    target: &Repository,
    generation: &Generation,
) -> Result<(), ReadError> {
    copy_generation_verified(restic, source, target, generation).map(|_| ())
}

fn copy_generation_verified(
    restic: &Restic,
    source: &Repository,
    target: &Repository,
    generation: &Generation,
) -> Result<Generation, ReadError> {
    let target_id = restic.opened_repository_id(target)?;
    upload_generation(restic, source, target, generation)?;
    verify_copied_generation(restic, target, &target_id, generation)
}

/// Only the copy command is remote work here. Local source validation still
/// precedes sending data; a successful upload alone must not advance protection.
fn upload_generation(
    restic: &Restic,
    source: &Repository,
    target: &Repository,
    generation: &Generation,
) -> Result<(), ReadError> {
    restic.stage(Stage::SourceVerification);
    let source_id = restic.repository_id(source)?;
    if generation.repository_id != source_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Copy source identity changed",
        ));
    }
    let verified = backup::verify_generation(restic, source, &generation.snapshot_id, &source_id)?;
    if serde_json::to_value(&verified.descriptor)? != serde_json::to_value(&generation.descriptor)?
    {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Copy source descriptor changed",
        ));
    }
    restic.stage(Stage::Uploading);
    restic.run(
        target,
        &[
            OsString::from("copy"),
            "--from-repo".into(),
            source.local_path()?.as_os_str().to_owned(),
            "--from-insecure-no-password".into(),
            generation.snapshot_id.clone().into(),
        ],
        None,
    )?;
    Ok(())
}

fn verify_copied_generation(
    restic: &Restic,
    target: &Repository,
    target_id: &str,
    generation: &Generation,
) -> Result<Generation, ReadError> {
    restic.stage(Stage::TargetVerification);
    let copied = backup::copied_generation(
        restic,
        target,
        &generation.descriptor.workspace_id,
        &generation.descriptor.generation_id,
    )?;
    if copied.repository_id != target_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Copy destination identity changed",
        ));
    }
    if serde_json::to_value(&copied.descriptor)? != serde_json::to_value(&generation.descriptor)? {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Copied descriptor differs from its source",
        ));
    }
    Ok(copied)
}

/// Resume one durable verification record without re-copying data or depending
/// on the local source snapshot still existing after retention.
fn verify_target(
    workspace: &Path,
    restic: &Restic,
    target: &AdditionalTarget,
    credentials: &dyn Credentials,
) -> Result<(), ReadError> {
    let key = ledger_key(&target.id);
    let mut ledger: TransferLedger = backup::setting(workspace, &key)?;
    if ledger.repository_id.as_deref() != Some(&target.repository_id) {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Verification destination changed",
        ));
    }
    let Some(generation) = ledger
        .awaiting_verification
        .values()
        .max_by_key(|g| {
            (
                chrono::DateTime::parse_from_rfc3339(&g.descriptor.captured_at).ok(),
                &g.descriptor.generation_id,
            )
        })
        .cloned()
    else {
        return Ok(());
    };
    let progress = Progress::start(workspace, &target.id, 1);
    progress.generation(&generation.descriptor.captured_at);
    let observed = restic.with_progress(progress.clone());
    update_target_status(workspace, &target.id, |s| {
        s.phase = "verifying".into();
        s.verification_error = None;
    })?;
    let result = (|| {
        let restic = observed.with_transfer_cache()?;
        let repo = open_destination(target, &restic, credentials)?;
        let verified =
            verify_copied_generation(&restic, &repo, &target.repository_id, &generation)?;
        backup::remember_generation(workspace, &verified)?;
        ledger
            .awaiting_verification
            .remove(&generation.descriptor.generation_id);
        ledger
            .delivered
            .insert(generation.descriptor.generation_id.clone());
        settings::save_transfer(workspace, &target.id, &ledger, |s| {
            s.phase = if !ledger.awaiting_verification.is_empty() {
                "verification-pending"
            } else {
                "idle"
            }
            .into();
            if s.protected_capture_at.as_ref().is_none_or(|old| {
                chrono::DateTime::parse_from_rfc3339(old).ok()
                    < chrono::DateTime::parse_from_rfc3339(&generation.descriptor.captured_at).ok()
            }) {
                s.protected_capture_at = Some(generation.descriptor.captured_at.clone());
            }
        })?;
        progress.completed(1);
        Ok(())
    })();
    let ledger: TransferLedger = backup::setting(workspace, &key)?;
    let summary = progress.finish(result.is_ok());
    update_target_status(workspace, &target.id, |s| {
        s.progress = Some(summary);
        s.pending_verification_count = ledger.awaiting_verification.len();
        s.verification_error = result.as_ref().err().cloned();
        s.phase = if result.is_err() {
            "error"
        } else if !ledger.awaiting_verification.is_empty() {
            "verification-pending"
        } else {
            "idle"
        }
        .into();
    })?;
    result
}

#[derive(Clone, Debug, Serialize)]
pub struct RetentionPlan {
    pub repository_id: String,
    pub keep: Vec<String>,
    pub remove: Vec<String>,
}
pub fn retention_plan(
    restic: &Restic,
    repo: &Repository,
    accepted: &[Generation],
    retention: &Retention,
) -> Result<RetentionPlan, ReadError> {
    checked_retention_plan(restic, repo, accepted, retention, false)
}
fn checked_retention_plan(
    restic: &Restic,
    repo: &Repository,
    accepted: &[Generation],
    retention: &Retention,
    require_full_plan: bool,
) -> Result<RetentionPlan, ReadError> {
    retention.validate()?;
    if accepted.is_empty() {
        return Err(ReadError::new(
            "NO_ACCEPTED_GENERATIONS",
            "Retention requires at least one verified generation",
        ));
    }
    let repository_id = restic.opened_repository_id(repo)?;
    let workspace_id = &accepted[0].descriptor.workspace_id;
    if accepted.iter().any(|item| {
        item.repository_id != repository_id || &item.descriptor.workspace_id != workspace_id
    }) {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Retention requires one verified Workspace and repository",
        ));
    }
    // Every verified generation fits within keep-last. This proof needs no
    // remote forget --dry-run (which itself requires an exclusive lock).
    // Do not use this shortcut for a deletion: unknown matching snapshots
    // must still fail the exact-set check in the full Restic plan below.
    if !require_full_plan && accepted.len() <= retention.last as usize {
        return Ok(RetentionPlan {
            repository_id,
            keep: accepted.iter().map(|g| g.snapshot_id.clone()).collect(),
            remove: Vec::new(),
        });
    }
    // A Workspace filter has constant argument size. Never pass snapshot IDs
    // with a keep policy: Restic would treat them as unconditional deletions.
    // The exact set check below rejects unknown/invalid matching snapshots.
    let mut command = args(&[
        "forget",
        "--dry-run",
        "--json",
        "--group-by",
        "",
        "--keep-last",
        &retention.last.to_string(),
        "--tag",
        &format!("memoka,workspace:{workspace_id}"),
    ]);
    if retention.daily > 0 {
        command.extend(["--keep-daily".into(), retention.daily.to_string().into()]);
    }
    if retention.monthly > 0 {
        command.extend([
            "--keep-monthly".into(),
            retention.monthly.to_string().into(),
        ]);
    }
    let raw: Value = serde_json::from_slice(&restic.run(repo, &command, None)?)?;
    let groups = raw
        .as_array()
        .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Retention plan is not an array"))?;
    if groups.len() != 1 {
        return Err(ReadError::new(
            "RETENTION_UNSAFE",
            "Retention unexpectedly split the Workspace into multiple groups",
        ));
    }
    let ids = |name: &str| -> Result<Vec<String>, ReadError> {
        if groups[0][name].is_null() {
            return Ok(Vec::new());
        }
        groups[0][name]
            .as_array()
            .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Missing retention candidates"))?
            .iter()
            .map(|item| {
                item["id"].as_str().map(str::to_owned).ok_or_else(|| {
                    ReadError::new("RESTIC_PROTOCOL", "Missing retention snapshot ID")
                })
            })
            .collect()
    };
    let keep = ids("keep")?;
    let remove = ids("remove")?;
    let considered = keep.iter().chain(&remove).collect::<BTreeSet<_>>();
    let expected = accepted
        .iter()
        .map(|item| &item.snapshot_id)
        .collect::<BTreeSet<_>>();
    if keep.is_empty()
        || considered != expected
        || considered.len() != keep.len() + remove.len()
        || !keep.contains(&accepted[0].snapshot_id)
    {
        return Err(ReadError::new(
            "RETENTION_UNSAFE",
            "Retention differs from the verified set or would delete the newest generation",
        ));
    }
    Ok(RetentionPlan {
        repository_id,
        keep,
        remove,
    })
}
pub fn maintain_repository(
    workspace: &Path,
    restic: &Restic,
    repo: &Repository,
    dry_run: bool,
    prune: bool,
) -> Result<RetentionPlan, ReadError> {
    if let Some(context) = repo.drive_context() {
        context.validate_layout(&restic.cancel)?;
    }
    let workspace_id = WorkspaceReader::open(workspace)?.workspace_id;
    let repository_id = restic.opened_repository_id(repo)?;
    let config = backup::config(workspace)?;
    let local = config.local_repository_id.as_deref() == Some(repository_id.as_str());
    let retention = if local {
        config.local_retention.clone()
    } else {
        let target = config
            .destinations
            .iter()
            .find(|item| item.repository_id == repository_id)
            .ok_or_else(|| ReadError::new("NOT_FOUND", "Repository is not configured"))?;
        if !target.enabled {
            return Err(ReadError::new(
                "DESTINATION_DISABLED",
                "Destination is disabled",
            ));
        }
        let ledger: TransferLedger = backup::setting(workspace, &ledger_key(&target.id))?;
        if !ledger.awaiting_verification.is_empty() {
            return Err(ReadError::new(
                "VERIFICATION_PENDING",
                "Uploaded generations must be verified before destination retention",
            ));
        }
        target.retention.clone()
    };
    let accepted = backup::generations(restic, repo, Some(&workspace_id), Some(workspace))?;
    let pending_prune =
        prune && prune_due(workspace, &repository_id)? && prune_pending(workspace, &repository_id)?;
    // Even with no candidate snapshots to remove, prune is destructive. Keep
    // the full verified-set guard when reclaiming packs from an older write.
    let plan = checked_retention_plan(restic, repo, &accepted, &retention, pending_prune)?;
    if dry_run {
        return Ok(plan);
    }
    // Execute only the exact verified removal set. New concurrent snapshots can
    // never become implicit candidates between planning and execution.
    let should_prune = prune
        && prune_due(workspace, &repository_id)?
        && (!plan.remove.is_empty() || prune_pending(workspace, &repository_id)?);
    if (!plan.remove.is_empty() || should_prune)
        && restic.repository_id(repo)? != plan.repository_id
    {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Repository identity changed before maintenance",
        ));
    }
    for batch in plan.remove.chunks(128) {
        if !local
            && !backup::config(workspace)?
                .destinations
                .iter()
                .any(|target| target.repository_id == repository_id && target.enabled)
        {
            return Err(ReadError::new(
                "DESTINATION_DISABLED",
                "Destination is disabled",
            ));
        }
        let mut command = vec![OsString::from("forget")];
        command.extend(batch.iter().map(OsString::from));
        // Persist BEFORE deleting, so a crash/partial failure cannot lose the
        // need to reclaim packs on the next successful idle maintenance.
        begin_repository_write(workspace, &repository_id)?;
        restic.run(repo, &command, None)?;
        if local {
            for target in &config.destinations {
                let key = ledger_key(&target.id);
                let mut ledger: TransferLedger = backup::setting(workspace, &key)?;
                ledger.repository_id = Some(target.repository_id.clone());
                for generation in accepted
                    .iter()
                    .filter(|item| batch.contains(&item.snapshot_id))
                {
                    let id = &generation.descriptor.generation_id;
                    ledger.pending.remove(id);
                    if !ledger.delivered.contains(id)
                        && !ledger.awaiting_verification.contains_key(id)
                    {
                        ledger
                            .expired
                            .insert(id.clone(), generation.descriptor.captured_at.clone());
                    }
                }
                backup::save_setting(workspace, &key, &ledger)?;
                update_target_status(workspace, &target.id, |status| {
                    status.pending_copy_count = ledger.pending.len();
                    status.expired_copy_count = ledger.expired.len();
                })?;
            }
        }
    }
    if should_prune {
        let key = format!("backup.last_prune.{}", plan.repository_id);
        if !local
            && !backup::config(workspace)?
                .destinations
                .iter()
                .any(|target| target.repository_id == repository_id && target.enabled)
        {
            return Err(ReadError::new(
                "DESTINATION_DISABLED",
                "Destination is disabled",
            ));
        }
        restic.run(repo, &args(&["prune"]), None)?;
        backup::save_setting(workspace, &key, &Some(chrono::Utc::now().to_rfc3339()))?;
        complete_repository_write(workspace, &repository_id, false)?;
    }
    backup::save_setting(
        workspace,
        &format!("backup.retention_applied.{}", plan.repository_id),
        &Some(retention),
    )?;
    backup::save_setting(
        workspace,
        &format!("backup.maintenance_latest.{}", plan.repository_id),
        &accepted.first().map(|g| &g.snapshot_id),
    )?;
    backup::save_setting(
        workspace,
        &format!("backup.last_maintenance.{}", plan.repository_id),
        &Some(chrono::Utc::now().to_rfc3339()),
    )?;
    Ok(plan)
}

fn prune_pending(workspace: &Path, repository_id: &str) -> Result<bool, ReadError> {
    backup::setting(workspace, &format!("backup.prune_pending.{repository_id}"))
}

/// A journal for writes that may leave unreferenced packs. Keep an older
/// pending cleanup even when a later copy succeeds. No remote data is changed.
pub(crate) fn begin_repository_write(
    workspace: &Path,
    repository_id: &str,
) -> Result<bool, ReadError> {
    let pending = prune_pending(workspace, repository_id)?;
    backup::save_setting(
        workspace,
        &format!("backup.prune_pending.{repository_id}"),
        &true,
    )?;
    Ok(pending)
}
pub(crate) fn complete_repository_write(
    workspace: &Path,
    repository_id: &str,
    was_pending: bool,
) -> Result<(), ReadError> {
    if !was_pending {
        backup::save_setting(
            workspace,
            &format!("backup.prune_pending.{repository_id}"),
            &false,
        )?;
    }
    Ok(())
}
fn prune_due(workspace: &Path, repository_id: &str) -> Result<bool, ReadError> {
    let last: Option<String> =
        backup::setting(workspace, &format!("backup.last_prune.{repository_id}"))?;
    Ok(last
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
        .is_none_or(|last| chrono::Utc::now().signed_duration_since(last).num_hours() >= 24))
}
pub fn idle_maintenance_due(workspace: &Path) -> Result<bool, ReadError> {
    let config = backup::config(workspace)?;
    let status = backup::status(workspace)?;
    // Do not follow failed capture/copy with destructive "success cleanup".
    if status.local_error.is_some() || status.last_local_capture_at.is_none() {
        return Ok(false);
    }
    let Some(local) = config.local_repository_id else {
        return Ok(false);
    };
    if maintenance_due(workspace, &local, &config.local_retention)? {
        return Ok(true);
    }
    for target in config
        .destinations
        .iter()
        .filter(|target| target.enabled && !target.location.is_cloud())
    {
        if status
            .destinations
            .get(&target.id)
            .is_some_and(|state| state.error.is_none() && state.protected_capture_at.is_some())
            && maintenance_due(workspace, &target.repository_id, &target.retention)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn maintenance_due(
    workspace: &Path,
    repository_id: &str,
    retention: &Retention,
) -> Result<bool, ReadError> {
    let applied: Option<Retention> = backup::setting(
        workspace,
        &format!("backup.retention_applied.{repository_id}"),
    )?;
    if applied.as_ref() != Some(retention)
        || (prune_pending(workspace, repository_id)? && prune_due(workspace, repository_id)?)
    {
        return Ok(true);
    }
    // Even no-op scans have a completion time; do not scan Drive once a
    // minute just because no physical prune has ever been necessary.
    let last: Option<String> = backup::setting(
        workspace,
        &format!("backup.last_maintenance.{repository_id}"),
    )?;
    if last
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .is_none_or(|last| chrono::Utc::now().signed_duration_since(last).num_hours() >= 24)
    {
        return Ok(true);
    }
    // New verified copies can cross keep-last before the daily scan. Daily /
    // monthly decisions still come from Restic, never from this local hint.
    let accepted: Vec<Generation> =
        backup::setting(workspace, &format!("backup.cache.{repository_id}"))?;
    let latest: Option<String> = backup::setting(
        workspace,
        &format!("backup.maintenance_latest.{repository_id}"),
    )?;
    Ok(accepted.len() > retention.last as usize
        && accepted
            .iter()
            .max_by_key(|g| {
                (
                    chrono::DateTime::parse_from_rfc3339(&g.descriptor.captured_at).ok(),
                    &g.descriptor.generation_id,
                )
            })
            .is_some_and(|g| latest.as_deref() != Some(g.snapshot_id.as_str())))
}
pub fn check(restic: &Restic, repo: &Repository, full: bool) -> Result<Value, ReadError> {
    let mut command = args(&["check"]);
    if full {
        command.push("--read-data".into());
    }
    restic.run(repo, &command, None)?;
    let accepted = backup::generations(restic, repo, None, None)?;
    if full {
        for generation in &accepted {
            let temporary = tempfile::tempdir()?;
            // The same allowlist/hash/SQLite/Yjs validation as full restore,
            // without publishing a Workspace or changing either repository.
            history::restore(
                restic,
                repo,
                generation,
                &temporary.path().join(&generation.descriptor.generation_id),
            )?;
        }
    }
    Ok(
        json!({"schema_version":1,"repository_id":restic.repository_id(repo)?,"full_data_read":full,"accepted_generations":accepted.len()}),
    )
}
