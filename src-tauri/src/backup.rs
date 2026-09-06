//! Canonical SQLite + CAS capture and Restic history. All heavy operations run
//! outside the GUI/persistence mutex. The only shared persistence writes here
//! are operational settings and never advance content_epoch.
pub use crate::backup_settings::{
    AdditionalTarget, BackupConfig, BackupStatus, Retention, config, status,
};
pub(crate) use crate::backup_settings::{
    connection, save_setting, setting, update_config, update_status,
};
use crate::{
    document_model::ReadError,
    read_service::{
        AttachmentRecord, WorkspaceReader, checked_directory, hash_file_cancellable, plain_file,
    },
    restic::{Repository, Restic, args},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use uuid::Uuid;
#[cfg(test)]
use {crate::restic::Password, serde_json::json};

pub const FORMAT_VERSION: u32 = 1;
const RESERVE: u64 = 1024 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CapturedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Descriptor {
    pub backup_format_version: u32,
    pub generation_id: String,
    pub workspace_id: String,
    pub captured_at: String,
    pub timezone: String,
    pub memoka_version: String,
    pub database_schema: i64,
    pub workspace_schema: i64,
    pub note_schema: i64,
    pub content_epoch: i64,
    pub workspace_revision: i64,
    pub document_revisions: BTreeMap<String, i64>,
    pub section_owners: BTreeMap<String, String>,
    pub files: Vec<CapturedFile>,
    pub attachments: Vec<AttachmentRecord>,
    pub known_missing: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Generation {
    pub snapshot_id: String,
    pub repository_id: String,
    pub descriptor: Descriptor,
}
pub fn content_epoch(workspace: &Path) -> Result<i64, ReadError> {
    Ok(connection(workspace)?
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key='content_epoch'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}
fn phase(workspace: &Path, name: &str) -> Result<(), ReadError> {
    update_status(workspace, |value| value.phase = name.into())
}

pub fn local_repository(
    workspace: &Path,
    restic: &Restic,
    initialize: bool,
) -> Result<Repository, ReadError> {
    let repo = Repository::local(workspace);
    let expected = if initialize {
        config(workspace)?.local_repository_id
    } else {
        crate::backup_settings::read_local_repository_id(workspace)?
    };
    if let Some(expected) = expected {
        if !repo.path.join("config").is_file() {
            return Err(ReadError::new(
                "REPOSITORY_MISSING",
                "Local history is missing; it will not be silently reinitialized",
            ));
        }
        if restic.repository_id(&repo)? != expected {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Local history repository identity changed",
            ));
        }
        return Ok(repo);
    }
    if !initialize {
        return Err(ReadError::new(
            "BACKUP_UNINITIALIZED",
            "Local history has not been initialized",
        ));
    }
    let pending: bool = setting(workspace, "backup.local_init_pending")?;
    let id = if repo.path.join("config").is_file() {
        if !pending {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Unrecognized existing local repository; initialization refused",
            ));
        }
        restic.repository_id(&repo)?
    } else {
        if repo.path.exists() && fs::read_dir(&repo.path)?.next().transpose()?.is_some() {
            return Err(ReadError::new(
                "REPOSITORY_NOT_EMPTY",
                "Local history initialization requires an empty directory",
            ));
        }
        save_setting(workspace, "backup.local_init_pending", &true)?;
        restic.initialize(&repo, None)?
    };
    update_config(workspace, |config| {
        config.local_repository_id = Some(id);
        Ok(())
    })?;
    save_setting(workspace, "backup.local_init_pending", &false)?;
    Ok(repo)
}

/// Capture the version actually obtained by Online Backup, not a collection of
/// pre-copy reads of the live DB. No Core mutex is held while copying or hashing.
pub fn capture(workspace: &Path, restic: &Restic) -> Result<(PathBuf, Descriptor), ReadError> {
    let internal = workspace.join(".memoka");
    checked_directory(&internal)?;
    let source_path = internal.join("memoka.sqlite3");
    let size = plain_file(&source_path)?.len();
    if fs2::available_space(workspace)? < RESERVE + size {
        return Err(ReadError::new(
            "LOW_DISK_SPACE",
            "Backup requires 1 GiB reserve plus the database copy",
        ));
    }
    let generation = Uuid::now_v7().to_string();
    let inputs = internal.join("backup-input");
    fs::create_dir_all(&inputs)?;
    checked_directory(&inputs)?;
    let stage = inputs.join(&generation);
    fs::create_dir(&stage)?;
    let result = (|| {
        let database = stage.join("state.sqlite");
        let source = Connection::open_with_flags(
            source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut destination = Connection::open(&database)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
            let start = Instant::now();
            loop {
                if restic.cancel.load(Ordering::Acquire) {
                    return Err(ReadError::new("CANCELLED", "Capture cancelled"));
                }
                if start.elapsed() > Duration::from_secs(120) {
                    return Err(ReadError::new(
                        "CAPTURE_TIMEOUT",
                        "SQLite capture did not complete in time",
                    ));
                }
                match backup.step(256)? {
                    rusqlite::backup::StepResult::Done => break,
                    _ => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        }
        // Online Backup may restart while live writes continue. Timestamp the
        // completed coherent copy, not when later CAS hashing finishes.
        let captured_at = chrono::Local::now();
        destination
            .close()
            .map_err(|(_, error)| ReadError::from(error))?;
        drop(source);
        let mut reader = WorkspaceReader::open_database(&database, internal.clone(), None)?;
        reader.validate_all()?;
        let mut owners = BTreeMap::new();
        for id in reader
            .document_revisions
            .keys()
            .cloned()
            .collect::<Vec<_>>()
        {
            let mut pending = vec![&reader.note(&id)?.root];
            while let Some(section) = pending.pop() {
                owners.insert(section.section_id.clone(), id.clone());
                pending.extend(section.children.iter());
            }
        }
        let blobs = stage.join("blobs");
        fs::create_dir(&blobs)?;
        let mut files = Vec::new();
        let mut seen = BTreeSet::new();
        let mut missing = Vec::new();
        for record in &reader.attachments {
            if restic.cancel.load(Ordering::Acquire) {
                return Err(ReadError::new("CANCELLED", "Capture cancelled"));
            }
            if record.known_missing {
                missing.push(record.attachment_id.clone());
                continue;
            }
            let source = reader.attachment_path(record)?;
            if !seen.insert(record.sha256.clone()) {
                continue;
            }
            let target = blobs.join(&record.sha256);
            if fs::hard_link(&source, &target).is_err() {
                if fs2::available_space(workspace)? < RESERVE + record.size {
                    return Err(ReadError::new(
                        "LOW_DISK_SPACE",
                        "Insufficient reserve for Attachment copy",
                    ));
                }
                let mut input = fs::File::open(&source)?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                let mut buffer = [0u8; 128 * 1024];
                loop {
                    if restic.cancel.load(Ordering::Acquire) {
                        return Err(ReadError::new("CANCELLED", "Attachment copy cancelled"));
                    }
                    let count = input.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    output.write_all(&buffer[..count])?;
                }
                output.sync_all()?;
            }
            if plain_file(&target)?.len() != record.size
                || hash_file_cancellable(&target, Some(&restic.cancel))? != record.sha256
            {
                return Err(ReadError::new(
                    "ATTACHMENT_CORRUPT",
                    "Capture Attachment hash or size mismatch",
                ));
            }
            files.push(CapturedFile {
                path: format!("blobs/{}", record.sha256),
                size: record.size,
                sha256: record.sha256.clone(),
            });
        }
        let mut descriptor = Descriptor {
            backup_format_version: FORMAT_VERSION,
            generation_id: generation,
            workspace_id: reader.workspace_id.clone(),
            captured_at: captured_at.to_rfc3339(),
            timezone: captured_at.offset().to_string(),
            memoka_version: env!("CARGO_PKG_VERSION").into(),
            database_schema: crate::workspace_migration::DATABASE_SCHEMA,
            workspace_schema: 3,
            note_schema: 3,
            content_epoch: reader.content_epoch,
            workspace_revision: reader.workspace_revision,
            document_revisions: reader.document_revisions.clone(),
            section_owners: owners,
            files,
            attachments: reader.attachments.clone(),
            known_missing: missing,
        };
        drop(reader);
        descriptor.files.insert(
            0,
            CapturedFile {
                path: "state.sqlite".into(),
                size: plain_file(&database)?.len(),
                sha256: hash_file_cancellable(&database, Some(&restic.cancel))?,
            },
        );
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join("backup.json"))?;
        file.write_all(&serde_json::to_vec_pretty(&descriptor)?)?;
        file.sync_all()?;
        crate::persistence::sync_file(&database)?;
        crate::persistence::sync_directory(&blobs)?;
        crate::persistence::sync_directory(&stage)?;
        Ok(descriptor)
    })();
    match result {
        Ok(descriptor) => Ok((stage, descriptor)),
        Err(error) => {
            cleanup_stage(&stage)?;
            Err(error)
        }
    }
}

pub fn validate_descriptor(descriptor: &Descriptor) -> Result<(), ReadError> {
    if descriptor.backup_format_version != FORMAT_VERSION
        || descriptor.database_schema != crate::workspace_migration::DATABASE_SCHEMA
        || descriptor.workspace_schema != 3
        || descriptor.note_schema != 3
    {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported backup schema",
        ));
    }
    crate::attachment::validate_uuid_v7(&descriptor.generation_id, "generation_id")?;
    crate::attachment::validate_uuid_v7(&descriptor.workspace_id, "workspace_id")?;
    chrono::DateTime::parse_from_rfc3339(&descriptor.captured_at)
        .map_err(|_| ReadError::new("INVALID_DATA", "Invalid generation time"))?;
    if descriptor.workspace_revision < 1 || descriptor.content_epoch < 0 {
        return Err(ReadError::new("INVALID_DATA", "Invalid capture revision"));
    }
    let mut allowed = BTreeMap::new();
    let mut ids = BTreeSet::new();
    let mut missing = BTreeSet::new();
    for attachment in &descriptor.attachments {
        crate::attachment::validate_uuid_v7(&attachment.attachment_id, "attachment_id")?;
        crate::attachment::validate_filename(&attachment.original_filename)?;
        crate::attachment::validate_mime_hint(&attachment.mime_type)?;
        validate_hash(&attachment.sha256)?;
        if !ids.insert(&attachment.attachment_id) {
            return Err(ReadError::new(
                "INVALID_DATA",
                "Duplicate Attachment identity",
            ));
        }
        if attachment.known_missing {
            missing.insert(attachment.attachment_id.clone());
        } else if allowed
            .insert(format!("blobs/{}", attachment.sha256), attachment.size)
            .is_some_and(|size| size != attachment.size)
        {
            return Err(ReadError::new(
                "INVALID_DATA",
                "Conflicting Attachment sizes",
            ));
        }
    }
    if descriptor
        .known_missing
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        != missing
    {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Known missing metadata disagrees",
        ));
    }
    let mut names = BTreeSet::new();
    let mut databases = 0;
    for file in &descriptor.files {
        validate_hash(&file.sha256)?;
        if !names.insert(&file.path) {
            return Err(ReadError::new("UNSAFE_PATH", "Duplicate capture path"));
        }
        if file.path == "state.sqlite" {
            databases += 1;
        } else if allowed.remove(&file.path) != Some(file.size)
            || file.path != format!("blobs/{}", file.sha256)
        {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "File is outside the capture allowlist",
            ));
        }
    }
    if databases != 1 || !allowed.is_empty() {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Capture file set is incomplete",
        ));
    }
    for (id, revision) in &descriptor.document_revisions {
        crate::attachment::validate_uuid_v7(id, "note_id")?;
        if *revision < 1 {
            return Err(ReadError::new("INVALID_DATA", "Invalid document revision"));
        }
    }
    for (section, note) in &descriptor.section_owners {
        crate::attachment::validate_uuid_v7(section, "section_id")?;
        if !descriptor.document_revisions.contains_key(note) {
            return Err(ReadError::new("INVALID_DATA", "Unknown Section owner"));
        }
    }
    Ok(())
}
fn validate_hash(hash: &str) -> Result<(), ReadError> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ReadError::new("INVALID_DATA", "Invalid SHA-256"));
    }
    Ok(())
}

pub fn verify_generation(
    restic: &Restic,
    repo: &Repository,
    snapshot: &str,
    repository_id: &str,
) -> Result<Generation, ReadError> {
    validate_hash(snapshot)?;
    let raw = restic.run(repo, &args(&["dump", snapshot, "/backup.json"]), None)?;
    let descriptor: Descriptor = serde_json::from_slice(&raw)?;
    validate_descriptor(&descriptor)?;
    let listing = restic.run(repo, &args(&["ls", "--json", snapshot]), None)?;
    let expected = descriptor
        .files
        .iter()
        .map(|file| (format!("/{}", file.path), file.size))
        .chain(std::iter::once(("/backup.json".into(), raw.len() as u64)))
        .collect::<BTreeMap<_, _>>();
    let mut seen = BTreeSet::new();
    for line in listing
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let item: Value = serde_json::from_slice(line)?;
        if item["struct_type"] == "snapshot" {
            continue;
        }
        let path = item["path"]
            .as_str()
            .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Missing snapshot path"))?;
        if path == "/blobs" && item["type"] == "dir" {
            continue;
        }
        if item["type"] != "file"
            || expected.get(path).copied() != item["size"].as_u64()
            || !seen.insert(path.to_owned())
        {
            return Err(ReadError::new(
                "INCOMPLETE_GENERATION",
                "Snapshot contents do not match the allowlist",
            ));
        }
    }
    if expected.keys().ne(seen.iter()) {
        return Err(ReadError::new(
            "INCOMPLETE_GENERATION",
            "Snapshot files are missing",
        ));
    }
    Ok(Generation {
        snapshot_id: snapshot.into(),
        repository_id: repository_id.into(),
        descriptor,
    })
}

pub fn generations(
    restic: &Restic,
    repo: &Repository,
    workspace_id: Option<&str>,
    cache: Option<&Path>,
) -> Result<Vec<Generation>, ReadError> {
    let repository_id = restic.repository_id(repo)?;
    let cache_key = format!("backup.cache.{repository_id}");
    let cached: Vec<Generation> = if let Some(workspace) = cache {
        setting(workspace, &cache_key)?
    } else {
        Vec::new()
    };
    let raw = restic.json(repo, &["snapshots"])?;
    let snapshots = raw
        .as_array()
        .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Snapshot list is not an array"))?;
    let mut result = Vec::new();
    let mut generations = BTreeSet::new();
    for snapshot in snapshots {
        let tags = snapshot["tags"].as_array().cloned().unwrap_or_default();
        let workspace_tag = tags
            .iter()
            .filter_map(Value::as_str)
            .find_map(|tag| tag.strip_prefix("workspace:"));
        let generation_tag = tags
            .iter()
            .filter_map(Value::as_str)
            .find_map(|tag| tag.strip_prefix("generation:"));
        if !tags.iter().any(|tag| tag == "memoka")
            || tags.len() != 3
            || generation_tag.is_none()
            || workspace_tag.is_none()
            || workspace_id.is_some_and(|id| Some(id) != workspace_tag)
        {
            continue;
        }
        let id = snapshot["id"]
            .as_str()
            .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Missing snapshot ID"))?;
        let accepted = if let Some(cached) = cached
            .iter()
            .find(|item| item.snapshot_id == id && item.repository_id == repository_id)
        {
            cached.clone()
        } else {
            match verify_generation(restic, repo, id, &repository_id) {
                Ok(value) => value,
                Err(error)
                    if [
                        "INCOMPLETE_GENERATION",
                        "INVALID_DATA",
                        "UNSUPPORTED_SCHEMA",
                        "UNSAFE_PATH",
                    ]
                    .contains(&error.code.as_str()) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        if Some(accepted.descriptor.workspace_id.as_str()) != workspace_tag
            || Some(accepted.descriptor.generation_id.as_str()) != generation_tag
        {
            continue;
        }
        if generations.insert(accepted.descriptor.generation_id.clone()) {
            result.push(accepted);
        }
    }
    result.sort_by(|a, b| {
        chrono::DateTime::parse_from_rfc3339(&b.descriptor.captured_at)
            .expect("validated time")
            .cmp(
                &chrono::DateTime::parse_from_rfc3339(&a.descriptor.captured_at)
                    .expect("validated time"),
            )
            .then(b.descriptor.generation_id.cmp(&a.descriptor.generation_id))
    });
    if let Some(workspace) = cache {
        save_setting(workspace, &cache_key, &result)?;
    }
    Ok(result)
}

pub fn run_local(workspace: &Path, restic: &Restic) -> Result<Option<Generation>, ReadError> {
    let result: Result<Option<Generation>, ReadError> = (|| {
        let mut current = WorkspaceReader::open(workspace)?;
        current.validate_all()?;
        let workspace_id = current.workspace_id.clone();
        let epoch = current.content_epoch;
        drop(current);
        let repo = local_repository(workspace, restic, true)?;
        let existing = generations(restic, &repo, Some(&workspace_id), Some(workspace))?;
        if let Some(latest) = existing.first() {
            if latest.descriptor.content_epoch == epoch {
                update_status(workspace, |value| {
                    value.phase = "idle".into();
                    value.last_local_captured_epoch = epoch;
                    value.last_local_capture_at = Some(latest.descriptor.captured_at.clone());
                    value.local_error = None;
                })?;
                return Ok(None);
            }
        }
        phase(workspace, "capturing")?;
        let (stage, descriptor) = capture(workspace, restic)?;
        let result = (|| {
            phase(workspace, "saving")?;
            // Restic 0.19.1 --time parses wall time in time.Local, not RFC3339.
            // Descriptor keeps the offset/timezone and subsecond capture time.
            let timestamp = chrono::DateTime::parse_from_rfc3339(&descriptor.captured_at)
                .map_err(|_| ReadError::new("INVALID_DATA", "Invalid capture time"))?
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            let output = restic.run(
                &repo,
                &args(&[
                    "backup",
                    "--json",
                    "--host",
                    "memoka",
                    "--group-by",
                    "",
                    "--read-concurrency",
                    "2",
                    "--force",
                    "--time",
                    &timestamp,
                    "--tag",
                    "memoka",
                    "--tag",
                    &format!("workspace:{}", descriptor.workspace_id),
                    "--tag",
                    &format!("generation:{}", descriptor.generation_id),
                    "backup.json",
                    "state.sqlite",
                    "blobs",
                ]),
                Some(&stage),
            )?;
            let summary = output
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
                .find(|value| value["message_type"] == "summary")
                .ok_or_else(|| ReadError::new("RESTIC_PROTOCOL", "Backup summary is missing"))?;
            let id = summary["snapshot_id"].as_str().ok_or_else(|| {
                ReadError::new("RESTIC_PROTOCOL", "Backup snapshot ID is missing")
            })?;
            let generation = verify_generation(
                restic,
                &repo,
                id,
                config(workspace)?
                    .local_repository_id
                    .as_deref()
                    .unwrap_or(""),
            )?;
            update_status(workspace, |value| {
                value.phase = "idle".into();
                value.local_error = None;
                value.last_local_captured_epoch = descriptor.content_epoch;
                value.last_local_capture_at = Some(descriptor.captured_at.clone());
                value.known_missing_count = descriptor.known_missing.len();
            })?;
            Ok(Some(generation))
        })();
        cleanup_stage(&stage)?;
        result
    })();
    if let Err(error) = &result {
        let _ = update_status(workspace, |value| {
            value.phase = "error".into();
            value.local_error = Some(error.clone());
        });
    }
    result
}

/// Only removes our recognized, direct UUID staging directory; never follows a
/// link or recursively deletes a workspace, repository or arbitrary path.
pub fn cleanup_stage(stage: &Path) -> Result<(), ReadError> {
    let name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ReadError::new("UNSAFE_PATH", "Invalid staging directory"))?;
    crate::attachment::validate_uuid_v7(name, "staging generation")?;
    if ![
        Some("backup-input"),
        Some("history-cache"),
        Some("restore-staging"),
    ]
    .contains(
        &stage
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str()),
    ) {
        return Err(ReadError::new("UNSAFE_PATH", "Invalid staging parent"));
    }
    checked_directory(stage)?;
    for item in fs::read_dir(stage)? {
        let item = item?;
        let path = item.path();
        if item.file_name() == "blobs" {
            checked_directory(&path)?;
            for blob in fs::read_dir(&path)? {
                let blob = blob?;
                let filename = blob.file_name();
                validate_hash(filename.to_str().unwrap_or(""))?;
                plain_file(&blob.path())?;
                fs::remove_file(blob.path())?;
            }
            fs::remove_dir(path)?;
        } else {
            if ![
                "state.sqlite",
                "state.sqlite-wal",
                "state.sqlite-shm",
                "backup.json",
            ]
            .contains(&item.file_name().to_str().unwrap_or(""))
            {
                return Err(ReadError::new(
                    "UNSAFE_PATH",
                    "Unrecognized staging content; preserving directory",
                ));
            }
            plain_file(&path)?;
            fs::remove_file(path)?;
        }
    }
    fs::remove_dir(stage)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::persistence::{PersistenceCommitRequest, ProductStore};
    pub fn fixture(workspace: &Path) {
        crate::data_area::prepare_data_area(workspace).unwrap();
        let mut store = ProductStore::open(workspace.join(".memoka")).unwrap();
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reader-contract.json"))
                .unwrap();
        let documents=fixture["documents"].as_array().unwrap().iter().map(|doc|json!({"kind":doc["kind"],"documentId":doc["document_id"],"schemaVersion":doc["schema_version"],"baseRevision":0,"snapshot":doc["snapshot"],"update":null})).collect::<Vec<_>>();
        let request:PersistenceCommitRequest=serde_json::from_value(json!({"operationId":Uuid::now_v7().to_string(),"scope":"workspace-structure","documents":documents,"localStates":[]})).unwrap();
        store.commit(&request).unwrap();
    }
    #[test]
    fn real_restic_capture_and_noop_tick() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let first = run_local(&workspace, &restic)
            .unwrap()
            .expect("initial capture");
        assert_eq!(first.descriptor.document_revisions.len(), 1);
        assert!(run_local(&workspace, &restic).unwrap().is_none());
        let repo = local_repository(&workspace, &restic, false).unwrap();
        let list = generations(&restic, &repo, None, None).unwrap();
        assert_eq!(list.len(), 1);
        restic.json(&repo, &["check"]).unwrap();
    }
    #[test]
    #[ignore = "manual real-Restic 93-generation calendar/retention safety test"]
    fn real_restic_retention_calendar_boundaries() {
        use chrono::{Duration as Days, NaiveDate, TimeZone};
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let repo = local_repository(&workspace, &restic, true).unwrap();
        let (stage, mut descriptor) = capture(&workspace, &restic).unwrap();
        let now = chrono::Utc.with_ymd_and_hms(2026, 9, 6, 12, 0, 0).unwrap();
        let mut captures = (0..49)
            .map(|minute| (now + Days::minutes(minute), minute != 0))
            .collect::<Vec<_>>();
        captures.extend((1..=31).map(|day| (now - Days::days(day), day < 30)));
        for offset in 1..=13 {
            let total = 2026 * 12 + 8 - offset;
            let date = NaiveDate::from_ymd_opt(total / 12, (total % 12 + 1) as u32, 1).unwrap();
            // Current September plus eleven earlier calendar months. August
            // already has a newer daily snapshot, so August 1 is not retained.
            captures.push((
                date.and_hms_opt(12, 0, 0).unwrap().and_utc(),
                (2..=11).contains(&offset),
            ));
        }
        let mut expected_generations = std::collections::BTreeSet::new();
        for (index, (at, keep)) in captures.iter().enumerate() {
            descriptor.generation_id = Uuid::now_v7().to_string();
            descriptor.captured_at = at.to_rfc3339();
            if *keep {
                expected_generations.insert(descriptor.generation_id.clone());
            }
            fs::write(
                stage.join("backup.json"),
                serde_json::to_vec(&descriptor).unwrap(),
            )
            .unwrap();
            let timestamp = at
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            restic
                .run(
                    &repo,
                    &args(&[
                        "backup",
                        "--json",
                        "--force",
                        "--host",
                        if index % 2 == 0 { "host-a" } else { "host-b" },
                        "--time",
                        &timestamp,
                        "--tag",
                        "memoka",
                        "--tag",
                        &format!("workspace:{}", descriptor.workspace_id),
                        "--tag",
                        &format!("generation:{}", descriptor.generation_id),
                        "backup.json",
                        "state.sqlite",
                        "blobs",
                    ]),
                    Some(&stage),
                )
                .unwrap();
        }
        let accepted = generations(&restic, &repo, Some(&descriptor.workspace_id), None).unwrap();
        assert_eq!(accepted.len(), 93);
        let before = accepted
            .iter()
            .map(|value| value.snapshot_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let plan =
            crate::backup_management::maintain_repository(&workspace, &restic, &repo, true, false)
                .unwrap();
        let kept_generations = accepted
            .iter()
            .filter(|value| plan.keep.contains(&value.snapshot_id))
            .map(|value| value.descriptor.generation_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(kept_generations, expected_generations);
        assert_eq!(plan.keep.len(), 87);
        assert_eq!(plan.remove.len(), 6);
        assert!(plan.keep.contains(&accepted[0].snapshot_id));
        assert_eq!(
            generations(&restic, &repo, None, None)
                .unwrap()
                .iter()
                .map(|value| value.snapshot_id.clone())
                .collect::<std::collections::BTreeSet<_>>(),
            before,
            "dry run must not delete anything"
        );
        crate::backup_management::maintain_repository(&workspace, &restic, &repo, false, false)
            .unwrap();
        let remaining = generations(&restic, &repo, None, None).unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|value| value.descriptor.generation_id.clone())
                .collect::<std::collections::BTreeSet<_>>(),
            expected_generations
        );
        restic.json(&repo, &["check"]).unwrap();
    }
    #[test]
    fn real_restic_restore_preserves_revisions_and_unreferenced_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("source");
        fixture(&workspace);
        let bytes = b"unreferenced attachment bytes";
        use sha2::{Digest, Sha256};
        let hash = crate::read_service::hex(&Sha256::digest(bytes));
        let id = Uuid::now_v7().to_string();
        let missing_id = Uuid::now_v7().to_string();
        let object_directory = workspace
            .join(".memoka/attachments/objects")
            .join(&hash[..2]);
        fs::create_dir_all(&object_directory).unwrap();
        fs::write(object_directory.join(&hash[2..]), bytes).unwrap();
        let db = Connection::open(workspace.join(".memoka/memoka.sqlite3")).unwrap();
        for (attachment, sha, size, missing) in [
            (&id, hash.clone(), bytes.len() as i64, 0),
            (&missing_id, "a".repeat(64), 100, 1),
        ] {
            db.execute("INSERT INTO attachment_objects(sha256,size,created_at) VALUES (?1,?2,'2026-09-06T00:00:00Z')",rusqlite::params![sha,size]).unwrap();
            db.execute("INSERT INTO attachments(attachment_id,sha256,size,original_filename,mime_type,created_at,known_missing) VALUES (?1,?2,?3,'添付.txt','text/plain','2026-09-06T00:00:00Z',?4)",rusqlite::params![attachment,sha,size,missing]).unwrap();
        }
        drop(db);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let saved = run_local(&workspace, &restic).unwrap().unwrap();
        assert_eq!(saved.descriptor.known_missing, vec![missing_id.clone()]);
        let repo = local_repository(&workspace, &restic, false).unwrap();
        let mut past = crate::history::open(&workspace, &restic, &repo, &saved).unwrap();
        let note_id = saved.descriptor.document_revisions.keys().next().unwrap();
        let past_note = past.reader.read_resource(note_id, false).unwrap();
        let output = temp.path().join("attachment.txt");
        crate::history::attachment(&restic, &repo, &saved, &mut past, &id, false, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), bytes);
        let restored = temp.path().join("restored");
        crate::history::restore(&restic, &repo, &saved, &restored).unwrap();
        let mut reader = WorkspaceReader::open(&restored).unwrap();
        assert_eq!(
            reader.document_revisions,
            saved.descriptor.document_revisions
        );
        assert_eq!(
            reader.workspace_revision,
            saved.descriptor.workspace_revision
        );
        assert_eq!(
            reader.read_resource(note_id, false).unwrap()["markdown"],
            past_note["markdown"]
        );
        let output = temp.path().join("restored-attachment.txt");
        reader.attachment_get(&id, false, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), bytes);
        assert_eq!(
            reader
                .attachment_get(&missing_id, false, &temp.path().join("missing.txt"))
                .unwrap_err()
                .code,
            "ATTACHMENT_MISSING"
        );
        assert!(config(&restored).unwrap().local_repository_id.is_none());
        assert!(!restored.join(".memoka-backups").exists());
        assert_eq!(
            crate::history::restore(&restic, &repo, &saved, &restored)
                .unwrap_err()
                .code,
            "TARGET_NOT_EMPTY"
        );
        let source = WorkspaceReader::open(&workspace).unwrap();
        assert_eq!(source.document_revisions, reader.document_revisions);
    }
    #[test]
    fn offline_additional_preserves_local_capture_without_success_cleanup() {
        let temporary = tempfile::tempdir().unwrap();
        let workspace = temporary.path().join("workspace");
        fixture(&workspace);
        let mut configured = config(&workspace).unwrap();
        configured.destinations.push(AdditionalTarget {
            id: "offline".into(),
            enabled: true,
            retention: Retention::default(),
            path: temporary.path().join("disconnected-device"),
            repository_id: "a".repeat(64),
            credential: "not-used-while-offline".into(),
        });
        save_setting(&workspace, "backup.config", &configured).unwrap();
        let service = crate::native_service::NativeService::new(workspace.clone());
        let result = service
            .run_cycle(std::time::Duration::from_secs(30))
            .unwrap();
        assert!(result["local_generation"].is_object());
        assert_eq!(
            result["destinations"][0]["error"]["code"],
            "ADDITIONAL_OFFLINE"
        );
        assert!(result["maintenance"].is_null(), "{result}");
        let state = status(&workspace).unwrap();
        assert!(state.last_local_capture_at.is_some());
        assert!(state.local_error.is_none());
        assert_eq!(
            state.destinations["offline"].error.as_ref().unwrap().code,
            "ADDITIONAL_OFFLINE"
        );
        // Later independent maintenance remains available, including when
        // the additional repository has been disconnected for a long time.
        let later = service
            .backup(crate::workspace_owner::BackupAction::Maintain { dry_run: true })
            .unwrap();
        assert_eq!(later["local"]["keep"].as_array().unwrap().len(), 1);
        assert!(later["destinations"].as_array().unwrap().is_empty());
    }
    #[test]
    fn real_restic_independent_key_copy_and_retention_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let workspace = temporary.path().join("workspace");
        fixture(&workspace);
        let restic = Restic::discover(crate::restic::cancellation()).unwrap();
        let original = run_local(&workspace, &restic).unwrap().unwrap();
        let source = local_repository(&workspace, &restic, false).unwrap();
        let target = Repository {
            path: temporary.path().join("additional"),
            password: Password::Secret("temporary-contract-password".into()),
        };
        restic.initialize(&target, Some(&source)).unwrap();
        assert_ne!(
            restic.repository_id(&source).unwrap(),
            restic.repository_id(&target).unwrap()
        );
        let no_secret = Repository {
            path: target.path.clone(),
            password: Password::Insecure,
        };
        assert_eq!(
            restic.repository_id(&no_secret).unwrap_err().code,
            "CREDENTIALS"
        );
        crate::backup_management::copy_generation(&restic, &source, &target, &original).unwrap();
        crate::backup_management::copy_generation(&restic, &source, &target, &original).unwrap();
        let accepted = generations(&restic, &target, None, None).unwrap();
        assert_eq!(accepted.len(), 1);
        assert_eq!(
            accepted[0].descriptor.generation_id,
            original.descriptor.generation_id
        );
        assert_eq!(
            accepted[0].descriptor.captured_at,
            original.descriptor.captured_at
        );
        let plan = crate::backup_management::retention_plan(
            &restic,
            &target,
            &accepted,
            &Retention::default(),
        )
        .unwrap();
        assert_eq!(plan.keep, vec![accepted[0].snapshot_id.clone()]);
        assert!(plan.remove.is_empty());
        assert!(
            crate::backup_management::check(&restic, &target, true).unwrap()["full_data_read"]
                .as_bool()
                .unwrap()
        );
    }
    #[test]
    fn reads_ts_yjs_fixture_without_a_display() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fixture(&workspace);
        let mut reader = WorkspaceReader::open(&workspace).unwrap();
        let source: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/reader-contract.json"))
                .unwrap();
        let id = source["expected"]["sectionId"].as_str().unwrap();
        let value = reader.read_resource(id, false).unwrap();
        assert_eq!(value["section"], source["expected"]);
        let md = value["markdown"].as_str().unwrap();
        assert!(md.contains("**太字**"));
        assert!(md.contains("[!WARNING]- 独自タイトル"));
        assert!(md.contains("####") == false);
        assert!(md.contains("memoka://workspace/"));
    }
}
