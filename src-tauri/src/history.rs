//! Generation-scoped reads and full restore. Snapshot paths are never used as
//! host output paths: only the fixed Memoka allowlist is extracted.
use crate::{
    backup::{self, Descriptor, Generation},
    document_model::ReadError,
    read_service::{WorkspaceReader, checked_directory, hash_file, plain_file},
    restic::{Repository, Restic},
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn generation(
    restic: &Restic,
    repo: &Repository,
    id: &str,
    workspace_id: Option<&str>,
    cache: Option<&Path>,
) -> Result<Generation, ReadError> {
    crate::attachment::validate_uuid_v7(id, "generation_id")?;
    backup::generations(restic, repo, workspace_id, cache)?
        .into_iter()
        .find(|generation| generation.descriptor.generation_id == id)
        .ok_or_else(|| ReadError::new("NOT_FOUND", "Unknown accepted history generation"))
}
fn database_file(descriptor: &Descriptor) -> &backup::CapturedFile {
    descriptor
        .files
        .iter()
        .find(|file| file.path == "state.sqlite")
        .expect("validated descriptor")
}
fn extract_file(
    restic: &Restic,
    repo: &Repository,
    generation: &Generation,
    file: &backup::CapturedFile,
    target: &Path,
) -> Result<(), ReadError> {
    if !target.exists() {
        restic.dump_file(
            repo,
            &generation.snapshot_id,
            &format!("/{}", file.path),
            target,
        )?;
    }
    if plain_file(target)?.len() != file.size || hash_file(target)? != file.sha256 {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "History file hash or size mismatch",
        ));
    }
    Ok(())
}
pub fn validate_database(
    reader: &mut WorkspaceReader,
    descriptor: &Descriptor,
) -> Result<(), ReadError> {
    reader.validate_all()?;
    if reader.workspace_id != descriptor.workspace_id
        || reader.workspace_revision != descriptor.workspace_revision
        || reader.content_epoch != descriptor.content_epoch
        || reader.document_revisions != descriptor.document_revisions
        || reader.attachments != descriptor.attachments
    {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Snapshot database disagrees with its capture descriptor",
        ));
    }
    let mut owners = std::collections::BTreeMap::new();
    for id in reader
        .document_revisions
        .keys()
        .cloned()
        .collect::<Vec<_>>()
    {
        let mut pending = vec![&reader.note(&id)?.root];
        while let Some(section) = pending.pop() {
            owners.insert(section.section_id.clone(), id.clone());
            pending.extend(&section.children);
        }
    }
    if owners != descriptor.section_owners {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Snapshot Section catalog disagrees with descriptor",
        ));
    }
    Ok(())
}
pub struct HistoricalReader {
    pub reader: WorkspaceReader,
    pub directory: PathBuf,
}
pub fn open(
    workspace: &Path,
    restic: &Restic,
    repo: &Repository,
    generation: &Generation,
) -> Result<HistoricalReader, ReadError> {
    backup::validate_descriptor(&generation.descriptor)?;
    let cache = workspace.join(".memoka/history-cache");
    fs::create_dir_all(&cache)?;
    checked_directory(&cache)?;
    let directory = cache.join(&generation.descriptor.generation_id);
    if !directory.exists() {
        fs::create_dir(&directory)?;
    }
    checked_directory(&directory)?;
    let target = directory.join("state.sqlite");
    if target.exists()
        && (plain_file(&target)?.len() != database_file(&generation.descriptor).size
            || hash_file(&target)? != database_file(&generation.descriptor).sha256)
    {
        backup::cleanup_stage(&directory)?;
        fs::create_dir(&directory)?;
    }
    extract_file(
        restic,
        repo,
        generation,
        database_file(&generation.descriptor),
        &target,
    )?;
    let mut reader = WorkspaceReader::open_database(
        &target,
        directory.clone(),
        Some(generation.descriptor.generation_id.clone()),
    )?;
    validate_database(&mut reader, &generation.descriptor)?;
    // Bounded cache: retain at most three databases, including this one.
    // Concurrent readers are protected by OS file handles; Windows removal
    // may fail harmlessly while a preview is still using a database.
    let mut old = fs::read_dir(&cache)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path() != directory
                && entry.file_name().to_str().is_some_and(|name| {
                    crate::attachment::validate_uuid_v7(name, "generation_id").is_ok()
                })
        })
        .collect::<Vec<_>>();
    old.sort_by_key(|entry| std::cmp::Reverse(entry.metadata().and_then(|m| m.modified()).ok()));
    for entry in old.into_iter().skip(2) {
        let _ = backup::cleanup_stage(&entry.path());
    }
    Ok(HistoricalReader { reader, directory })
}
pub fn attachment(
    restic: &Restic,
    repo: &Repository,
    generation: &Generation,
    reader: &mut HistoricalReader,
    id: &str,
    include_trash: bool,
    target: &Path,
) -> Result<(), ReadError> {
    materialize_attachment(restic, repo, generation, reader, id)?;
    reader.reader.attachment_get(id, include_trash, target)
}
pub fn materialize_attachment(
    restic: &Restic,
    repo: &Repository,
    generation: &Generation,
    reader: &HistoricalReader,
    id: &str,
) -> Result<(), ReadError> {
    let record = generation
        .descriptor
        .attachments
        .iter()
        .find(|record| record.attachment_id == id)
        .ok_or_else(|| ReadError::new("NOT_FOUND", "Unknown historical Attachment"))?;
    if record.known_missing {
        return Err(ReadError::new(
            "ATTACHMENT_MISSING",
            "This generation records a missing Attachment",
        ));
    }
    let file = generation
        .descriptor
        .files
        .iter()
        .find(|file| file.path == format!("blobs/{}", record.sha256))
        .ok_or_else(|| {
            ReadError::new(
                "HISTORY_CORRUPT",
                "Missing historical Attachment descriptor",
            )
        })?;
    let blobs = reader.directory.join("blobs");
    fs::create_dir_all(&blobs)?;
    checked_directory(&blobs)?;
    extract_file(restic, repo, generation, file, &blobs.join(&record.sha256))?;
    Ok(())
}
pub fn list(workspace: &Path, restic: &Restic, id: Option<&str>) -> Result<Value, ReadError> {
    let repo = backup::local_repository(workspace, restic, false)?;
    let reader = WorkspaceReader::open(workspace)?;
    let generations =
        backup::generations(restic, &repo, Some(&reader.workspace_id), Some(workspace))?;
    Ok(
        json!({"schema_version":1,"workspace_id":reader.workspace_id,"generations":generations.into_iter().filter(|generation|id.is_none_or(|id|generation.descriptor.section_owners.contains_key(id))).collect::<Vec<_>>() }),
    )
}
pub fn restore(
    restic: &Restic,
    repo: &Repository,
    generation: &Generation,
    target: &Path,
) -> Result<(), ReadError> {
    backup::validate_descriptor(&generation.descriptor)?;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent)?;
    checked_directory(&parent)?;
    let basename = target
        .file_name()
        .ok_or_else(|| ReadError::new("UNSAFE_PATH", "Invalid restore target"))?;
    crate::attachment::validate_filename(
        basename
            .to_str()
            .ok_or_else(|| ReadError::new("UNSAFE_PATH", "Invalid restore target name"))?,
    )?;
    let target = parent.join(basename);
    if let Ok(path) = repo.local_path() {
        let repository = fs::canonicalize(path)?;
        if target.starts_with(&repository) || repository.starts_with(&target) {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Restore target overlaps its source repository",
            ));
        }
    }
    if target.exists() {
        checked_directory(&target)?;
        if fs::read_dir(&target)?.next().transpose()?.is_some() {
            return Err(ReadError::new(
                "TARGET_NOT_EMPTY",
                "Restore requires a new empty Workspace",
            ));
        }
    }
    let size = generation
        .descriptor
        .files
        .iter()
        .try_fold(0u64, |total, file| total.checked_add(file.size))
        .ok_or_else(|| {
            ReadError::new("INVALID_DATA", "Capture size exceeds the supported range")
        })?;
    if fs2::available_space(&parent)? < size.saturating_add(1024 * 1024 * 1024) {
        return Err(ReadError::new(
            "LOW_DISK_SPACE",
            "Insufficient reserve for restore",
        ));
    }
    let temporary = tempfile::Builder::new()
        .prefix(".memoka-restore-")
        .tempdir_in(&parent)?;
    let stage = temporary.path().join("capture");
    fs::create_dir(&stage)?;
    fs::create_dir(stage.join("blobs"))?;
    // Revalidate repository-side allowlist before extracting any bytes.
    let verified = backup::verify_generation(
        restic,
        repo,
        &generation.snapshot_id,
        &generation.repository_id,
    )?;
    if serde_json::to_value(&verified.descriptor)? != serde_json::to_value(&generation.descriptor)?
    {
        return Err(ReadError::new(
            "HISTORY_CORRUPT",
            "Generation descriptor changed before restore",
        ));
    }
    for file in &generation.descriptor.files {
        let path = if file.path == "state.sqlite" {
            stage.join("state.sqlite")
        } else {
            stage.join("blobs").join(&file.sha256)
        };
        extract_file(restic, repo, generation, file, &path)?;
    }
    let database = stage.join("state.sqlite");
    let mut reader = WorkspaceReader::open_database(
        &database,
        stage.clone(),
        Some(generation.descriptor.generation_id.clone()),
    )?;
    validate_database(&mut reader, &generation.descriptor)?;
    drop(reader);
    let restored = temporary.path().join("workspace");
    let internal = restored.join(".memoka");
    fs::create_dir_all(&internal)?;
    fs::rename(&database, internal.join("memoka.sqlite3"))?;
    for record in &generation.descriptor.attachments {
        if record.known_missing {
            continue;
        }
        let directory = internal
            .join("attachments/objects")
            .join(&record.sha256[..2]);
        fs::create_dir_all(&directory)?;
        let target = directory.join(&record.sha256[2..]);
        if !target.exists() {
            fs::rename(stage.join("blobs").join(&record.sha256), &target)?;
            crate::persistence::sync_file(&target)?;
        }
    }
    let mut db = ConnectionGuard::open(&internal.join("memoka.sqlite3"))?;
    db.clean_operational_state()?;
    drop(db);
    let marker = json!({"schemaVersion":1,"kind":"memoka-data-area"});
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(internal.join("data-area.json"))?;
    file.write_all(&serde_json::to_vec(&marker)?)?;
    file.sync_all()?;
    // Windows cannot rename the containing directory while a descendant
    // file is still open. Close the marker before publishing the Workspace.
    drop(file);
    crate::persistence::sync_file(&internal.join("memoka.sqlite3"))?;
    crate::persistence::sync_directory(&internal)?;
    crate::persistence::sync_directory(&restored)?;
    if target.exists() {
        fs::remove_dir(&target)?;
    }
    fs::rename(restored, &target)?;
    crate::persistence::sync_directory(&parent)?;
    // First GUI open initializes a fresh local repository; no old credentials,
    // endpoint, lock, mirror checkpoint or background-operation settings survive.
    Ok(())
}
struct ConnectionGuard(rusqlite::Connection);
impl ConnectionGuard {
    fn open(path: &Path) -> Result<Self, ReadError> {
        let db = rusqlite::Connection::open(path)?;
        db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;")?;
        Ok(Self(db))
    }
    fn clean_operational_state(&mut self) -> Result<(), ReadError> {
        let transaction = self.0.transaction()?;
        transaction.execute("DELETE FROM local_window_state", [])?;
        transaction.execute("DELETE FROM settings WHERE key NOT IN ('database_schema_version','active_workspace_id','content_epoch','namespace_migration_entry_ids')",[])?;
        transaction.execute("DELETE FROM attachment_operation_items", [])?;
        transaction.execute("DELETE FROM attachment_operations", [])?;
        crate::replication::clear_group_state(&transaction)?;
        for table in ["operations", "agent_edit_receipts"] {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )?;
            if exists {
                transaction.execute(&format!("DELETE FROM {table}"), [])?;
            }
        }
        transaction.execute("INSERT OR REPLACE INTO workspace_search_invalidations(kind,document_id,source_revision) SELECT kind,document_id,revision FROM documents",[])?;
        transaction.commit()?;
        Ok(())
    }
}
