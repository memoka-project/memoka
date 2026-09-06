//! Additional repositories and retention use the pinned Restic implementation.
//! No repository format, encryption, deduplication or calendar policy is reimplemented here.
use crate::{
    backup::{self, AdditionalTarget, Generation},
    document_model::ReadError,
    history,
    read_service::{WorkspaceReader, checked_directory},
    restic::{Password, Repository, Restic, args},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, ffi::OsString, fs, path::Path, time::Duration};

const CREDENTIAL_SERVICE: &str = "dev.memoka.desktop.backup";
fn credential(id: &str) -> Result<keyring::Entry, ReadError> {
    keyring::Entry::new(CREDENTIAL_SERVICE, id).map_err(|_| credentials_error())
}
fn credentials_error() -> ReadError {
    ReadError::new(
        "CREDENTIALS_UNAVAILABLE",
        "The additional repository credential is unavailable or the OS credential store is locked",
    )
}
pub fn additional_repository(workspace: &Path, restic: &Restic) -> Result<Repository, ReadError> {
    let target = backup::config(workspace)?.additional.ok_or_else(|| {
        ReadError::new(
            "ADDITIONAL_UNCONFIGURED",
            "No additional repository is configured",
        )
    })?;
    if !target.path.join("config").is_file() {
        return Err(ReadError::new(
            "ADDITIONAL_OFFLINE",
            "The additional repository is not connected",
        ));
    }
    let secret = credential(&target.credential)?
        .get_password()
        .map_err(|_| credentials_error())?;
    let repo = Repository {
        path: target.path,
        password: Password::Secret(secret),
    };
    if restic.repository_id(&repo)? != target.repository_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Additional repository identity changed",
        ));
    }
    Ok(repo)
}

#[derive(Default, Serialize, Deserialize)]
struct InitIntent {
    workspace_id: String,
    path: std::path::PathBuf,
    repository_id: Option<String>,
}
pub fn configure_additional(
    workspace: &Path,
    restic: &Restic,
    parent: &Path,
    secret: String,
) -> Result<(), ReadError> {
    if secret.is_empty() {
        return Err(ReadError::new(
            "INVALID_ARGUMENT",
            "An additional repository requires a nonempty password",
        ));
    }
    checked_directory(parent)?;
    let parent = fs::canonicalize(parent)?;
    let workspace = fs::canonicalize(workspace)?;
    // Reject both nesting directions; a backup must not contain or be contained
    // in the Workspace, its canonical files, caches or local repository.
    if parent.starts_with(&workspace) || workspace.starts_with(&parent) {
        return Err(ReadError::new(
            "UNSAFE_PATH",
            "Additional storage must be outside the Workspace and its ancestors",
        ));
    }
    let reader = WorkspaceReader::open(&workspace)?;
    let workspace_id = reader.workspace_id.clone();
    drop(reader);
    let source = backup::local_repository(&workspace, restic, false)?;
    let path = parent.join(format!("memoka-{workspace_id}"));
    let mut config = backup::config(&workspace)?;
    if config
        .additional
        .as_ref()
        .is_some_and(|old| old.path != path)
    {
        return Err(ReadError::new(
            "ADDITIONAL_CONFIGURED",
            "Detach the existing additional destination before choosing another",
        ));
    }
    let mut pending: Option<InitIntent> =
        backup::setting(&workspace, "backup.additional_init_pending")?;
    let repo = Repository {
        path: path.clone(),
        password: Password::Secret(secret),
    };
    let expected = config
        .additional
        .as_ref()
        .filter(|old| old.path == path)
        .map(|old| old.repository_id.clone())
        .or_else(|| {
            pending
                .as_ref()
                .filter(|old| old.path == path && old.workspace_id == workspace_id)
                .and_then(|old| old.repository_id.clone())
        });
    let repository_id = if path.join("config").is_file() {
        if expected.is_none()
            && !pending
                .as_ref()
                .is_some_and(|old| old.path == path && old.workspace_id == workspace_id)
        {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Unrecognized additional repository; initialization refused",
            ));
        }
        let id = restic.repository_id(&repo)?;
        if expected.is_some_and(|old| old != id) {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Additional repository identity changed",
            ));
        }
        id
    } else {
        if expected.is_some() {
            return Err(ReadError::new(
                "REPOSITORY_MISSING",
                "The configured additional repository is missing",
            ));
        }
        pending = Some(InitIntent {
            workspace_id,
            path: path.clone(),
            repository_id: None,
        });
        backup::save_setting(&workspace, "backup.additional_init_pending", &pending)?;
        restic.initialize(&repo, Some(&source))?
    };
    backup::save_setting(
        &workspace,
        "backup.additional_init_pending",
        &Some(InitIntent {
            workspace_id: WorkspaceReader::open(&workspace)?.workspace_id,
            path: path.clone(),
            repository_id: Some(repository_id.clone()),
        }),
    )?;
    let credential_id = format!("repo:{repository_id}");
    if let Password::Secret(secret) = &repo.password {
        credential(&credential_id)?
            .set_password(secret)
            .map_err(|_| credentials_error())?;
    }
    config.additional = Some(AdditionalTarget {
        path,
        repository_id,
        credential: credential_id,
    });
    backup::save_setting(&workspace, "backup.config", &config)?;
    backup::save_setting(
        &workspace,
        "backup.additional_init_pending",
        &Option::<InitIntent>::None,
    )?;
    Ok(())
}
pub fn detach_additional(workspace: &Path) -> Result<(), ReadError> {
    let mut config = backup::config(workspace)?;
    let previous = config.additional.take();
    backup::save_setting(workspace, "backup.config", &config)?;
    if let Some(previous) = previous {
        if let Ok(entry) = credential(&previous.credential) {
            let _ = entry.delete_credential();
        }
    }
    backup::save_setting(
        workspace,
        "backup.additional_init_pending",
        &Option::<InitIntent>::None,
    )?;
    backup::save_setting(workspace, "backup.transfers", &TransferLedger::default())?;
    backup::update_status(workspace, |status| {
        status.additional_phase = "unconfigured".into();
        status.additional_error = None;
        status.additional_protected_capture_at = None;
        status.last_additional_copy_at = None;
        status.pending_copy_count = 0;
        status.expired_copy_count = 0;
    })?;
    // Repositories themselves are deliberately left intact.
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct TransferLedger {
    repository_id: Option<String>,
    pending: std::collections::BTreeMap<String, String>,
    expired: std::collections::BTreeMap<String, String>,
    delivered: BTreeSet<String>,
}
pub fn copy(workspace: &Path, restic: &Restic, budget: Duration) -> Result<Value, ReadError> {
    let bounded = restic.within(budget);
    let restic = &bounded;
    let reader = WorkspaceReader::open(workspace)?;
    let workspace_id = reader.workspace_id.clone();
    drop(reader);
    let source = backup::local_repository(workspace, restic, false)?;
    let local = backup::generations(restic, &source, Some(&workspace_id), Some(workspace))?;
    let mut ledger: TransferLedger = backup::setting(workspace, "backup.transfers")?;
    let target_id = backup::config(workspace)?
        .additional
        .map(|target| target.repository_id)
        .ok_or_else(|| {
            ReadError::new(
                "ADDITIONAL_UNCONFIGURED",
                "No additional repository is configured",
            )
        })?;
    if ledger.repository_id.as_deref() != Some(target_id.as_str()) {
        ledger = TransferLedger {
            repository_id: Some(target_id),
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
    for item in &local {
        if !ledger.delivered.contains(&item.descriptor.generation_id) {
            ledger
                .pending
                .entry(item.descriptor.generation_id.clone())
                .or_insert(item.descriptor.captured_at.clone());
        }
    }
    backup::save_setting(workspace, "backup.transfers", &ledger)?;
    let result: Result<Value, ReadError> = (|| {
        let target = additional_repository(workspace, restic)?;
        let copied = backup::generations(restic, &target, Some(&workspace_id), Some(workspace))?;
        for item in &copied {
            ledger.pending.remove(&item.descriptor.generation_id);
            ledger
                .delivered
                .insert(item.descriptor.generation_id.clone());
        }
        let mut protected = copied
            .first()
            .map(|item| item.descriptor.captured_at.clone());
        backup::update_status(workspace, |status| {
            status.additional_protected_capture_at = protected.clone();
        })?;
        let mut count = 0;
        for generation in &local {
            if !ledger
                .pending
                .contains_key(&generation.descriptor.generation_id)
            {
                continue;
            }
            if restic.expired() {
                break;
            }
            copy_generation(restic, &source, &target, generation)?;
            ledger.pending.remove(&generation.descriptor.generation_id);
            count += 1;
            ledger
                .delivered
                .insert(generation.descriptor.generation_id.clone());
            if protected.as_ref().is_none_or(|old| {
                chrono::DateTime::parse_from_rfc3339(old).ok()
                    < chrono::DateTime::parse_from_rfc3339(&generation.descriptor.captured_at).ok()
            }) {
                protected = Some(generation.descriptor.captured_at.clone());
            }
            backup::save_setting(workspace, "backup.transfers", &ledger)?;
            // A later (older) generation can time out. Keep the protection
            // achieved so far visible even when that later copy fails.
            backup::update_status(workspace, |status| {
                status.last_additional_copy_at = Some(chrono::Utc::now().to_rfc3339());
                status.additional_protected_capture_at = protected.clone();
            })?;
        }
        backup::update_status(workspace, |status| {
            status.additional_phase = "idle".into();
            status.additional_error = None;
            if count > 0 {
                status.last_additional_copy_at = Some(chrono::Utc::now().to_rfc3339());
            }
            status.additional_protected_capture_at = protected;
        })?;
        Ok(
            json!({"schema_version":1,"copied":count,"pending":ledger.pending.len(),"expired":ledger.expired.len()}),
        )
    })();
    backup::save_setting(workspace, "backup.transfers", &ledger)?;
    backup::update_status(workspace, |status| {
        status.pending_copy_count = ledger.pending.len();
        status.expired_copy_count = ledger.expired.len();
        if let Err(error) = &result {
            status.additional_phase = "error".into();
            status.additional_error = Some(error.clone());
        }
    })?;
    result
}
pub fn copy_generation(
    restic: &Restic,
    source: &Repository,
    target: &Repository,
    generation: &Generation,
) -> Result<(), ReadError> {
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
    restic.run(
        target,
        &[
            OsString::from("copy"),
            "--from-repo".into(),
            source.path.as_os_str().to_owned(),
            "--from-insecure-no-password".into(),
            generation.snapshot_id.clone().into(),
        ],
        None,
    )?;
    let copied = backup::generations(
        restic,
        target,
        Some(&generation.descriptor.workspace_id),
        None,
    )?
    .into_iter()
    .find(|item| item.descriptor.generation_id == generation.descriptor.generation_id)
    .ok_or_else(|| {
        ReadError::new(
            "INCOMPLETE_GENERATION",
            "Copied generation could not be verified",
        )
    })?;
    if serde_json::to_value(&copied.descriptor)? != serde_json::to_value(&generation.descriptor)? {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Copied descriptor differs from its source",
        ));
    }
    Ok(())
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
) -> Result<RetentionPlan, ReadError> {
    if accepted.is_empty() {
        return Err(ReadError::new(
            "NO_ACCEPTED_GENERATIONS",
            "Retention requires at least one verified generation",
        ));
    }
    let repository_id = restic.repository_id(repo)?;
    let workspace_id = &accepted[0].descriptor.workspace_id;
    if accepted.iter().any(|item| {
        item.repository_id != repository_id || &item.descriptor.workspace_id != workspace_id
    }) {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Retention requires one verified Workspace and repository",
        ));
    }
    // Restic treats explicit snapshot arguments as unconditional deletion, even
    // with keep-* flags. Restrict the dry-run with OR tag filters, never args.
    let mut command = args(&[
        "forget",
        "--dry-run",
        "--json",
        "--group-by",
        "",
        "--keep-last",
        "48",
        "--keep-daily",
        "30",
        "--keep-monthly",
        "12",
    ]);
    for item in accepted {
        command.extend([
            "--tag".into(),
            format!(
                "memoka,workspace:{workspace_id},generation:{}",
                item.descriptor.generation_id
            )
            .into(),
        ]);
    }
    if command.iter().map(|arg| arg.len()).sum::<usize>() > 24_000 {
        return Err(ReadError::new(
            "RETENTION_TOO_LARGE",
            "Retention candidate filters exceed the safe command size; no snapshots were deleted",
        ));
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
    let workspace_id = WorkspaceReader::open(workspace)?.workspace_id;
    let accepted = backup::generations(restic, repo, Some(&workspace_id), Some(workspace))?;
    let plan = retention_plan(restic, repo, &accepted)?;
    if dry_run {
        return Ok(plan);
    }
    // Execute only the exact verified removal set. New concurrent snapshots can
    // never become implicit candidates between planning and execution.
    if restic.repository_id(repo)? != plan.repository_id {
        return Err(ReadError::new(
            "REPOSITORY_MISMATCH",
            "Repository identity changed before maintenance",
        ));
    }
    if !plan.remove.is_empty() {
        let mut command = vec![OsString::from("forget")];
        command.extend(plan.remove.iter().map(OsString::from));
        restic.run(repo, &command, None)?;
        if backup::config(workspace)?.local_repository_id.as_deref()
            == Some(plan.repository_id.as_str())
        {
            let mut ledger: TransferLedger = backup::setting(workspace, "backup.transfers")?;
            for generation in accepted
                .iter()
                .filter(|item| plan.remove.contains(&item.snapshot_id))
            {
                let id = &generation.descriptor.generation_id;
                if let Some(captured_at) = ledger.pending.remove(id) {
                    ledger.expired.insert(id.clone(), captured_at);
                }
            }
            backup::save_setting(workspace, "backup.transfers", &ledger)?;
            backup::update_status(workspace, |status| {
                status.pending_copy_count = ledger.pending.len();
                status.expired_copy_count = ledger.expired.len();
            })?;
        }
    }
    if prune {
        let key = format!("backup.last_prune.{}", plan.repository_id);
        if prune_due(workspace, &plan.repository_id)? {
            restic.run(repo, &args(&["prune"]), None)?;
            backup::save_setting(workspace, &key, &Some(chrono::Utc::now().to_rfc3339()))?;
        }
    }
    Ok(plan)
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
    if prune_due(workspace, &local)? {
        return Ok(true);
    }
    if let Some(target) = config.additional {
        if status.additional_error.is_none() && status.additional_protected_capture_at.is_some() {
            return prune_due(workspace, &target.repository_id);
        }
    }
    Ok(false)
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
