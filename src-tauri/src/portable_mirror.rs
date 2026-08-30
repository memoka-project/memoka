use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use unicode_normalization::UnicodeNormalization;

use crate::attachment::{
    AttachmentMetadata, copy_resolved_attachment_cas_to, list_all_attachment_metadata,
    resolve_attachment_cas_source, validate_filename, validate_mime_hint, validate_uuid_v7,
};
use crate::data_area::MIRROR_UPDATE_MARKER;
use crate::persistence::{
    DocumentRevision, PersistenceError, ProductPersistenceState, ProductStore, sync_directory,
    sync_file,
};

pub const PORTABLE_MIRROR_SCHEMA_VERSION: u32 = 1;
pub const PORTABLE_MANIFEST_FILE: &str = "memoka-manifest.json";
const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_PORTABLE_COMPONENT_BYTES: usize = 255;
const MAX_PORTABLE_RELATIVE_PATH_BYTES: usize = 2_048;

pub(crate) fn recover_portable_mirror_operations(
    store: &mut ProductStore,
) -> Result<(), PersistenceError> {
    let staging = store.root.join("portable-staging");
    if staging.exists() {
        let metadata = fs::symlink_metadata(&staging)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PersistenceError::InvalidInput(
                "portable mirror staging is not a regular directory".to_owned(),
            ));
        }
        fs::remove_dir_all(staging)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorFileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorDocumentEntry {
    pub kind: String,
    pub document_id: String,
    pub schema_version: i64,
    pub source_revision: i64,
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorAttachmentEntry {
    pub attachment_id: String,
    pub sha256: String,
    pub size: u64,
    pub original_filename: String,
    pub mime_type: String,
    pub created_at: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorSectionEntry {
    pub section_id: String,
    pub markdown_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorNoteEntry {
    pub note_id: String,
    pub parent_note_id: Option<String>,
    pub deleted_at: Option<String>,
    pub markdown_path: String,
    pub sections: Vec<PortableMirrorSectionEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableMirrorManifest {
    pub schema_version: u32,
    pub generated_at: String,
    pub workspace_id: String,
    pub notes: Vec<PortableMirrorNoteEntry>,
    pub documents: Vec<PortableMirrorDocumentEntry>,
    pub attachments: Vec<PortableMirrorAttachmentEntry>,
    pub files: Vec<PortableMirrorFileEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableMirrorStatus {
    manifest: Option<PortableMirrorManifest>,
    mirror_needs_repair: bool,
    document_revisions: Vec<DocumentRevision>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableMirrorItem {
    path: String,
    expected_size: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_attachment_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableMirrorBeginRequest {
    operation_id: String,
    manifest: String,
    items: Vec<PortableMirrorItem>,
}

#[derive(Clone)]
struct PortableMirrorOperationContext {
    data_area: PathBuf,
    internal_root: PathBuf,
    request: PortableMirrorBeginRequest,
}

struct PortableMirrorOperation {
    context: PortableMirrorOperationContext,
    io: Mutex<()>,
}

#[derive(Default)]
pub(crate) struct PortableMirrorOperationState {
    operations: Mutex<BTreeMap<String, Arc<PortableMirrorOperation>>>,
}

impl PortableMirrorOperationState {
    fn register(
        &self,
        context: PortableMirrorOperationContext,
    ) -> Result<Arc<PortableMirrorOperation>, PersistenceError> {
        let mut operations = self.operations.lock().map_err(|_| {
            PersistenceError::InvalidInput("portable mirror operation lock is poisoned".to_owned())
        })?;
        if let Some(existing) = operations.get(&context.request.operation_id) {
            if existing.context.data_area != context.data_area
                || serde_json::to_vec(&existing.context.request)?
                    != serde_json::to_vec(&context.request)?
            {
                return Err(PersistenceError::DuplicateOperationMismatch);
            }
            return Ok(existing.clone());
        }
        let operation = Arc::new(PortableMirrorOperation {
            context,
            io: Mutex::new(()),
        });
        operations.insert(
            operation.context.request.operation_id.clone(),
            operation.clone(),
        );
        Ok(operation)
    }

    fn get(&self, operation_id: &str) -> Result<Arc<PortableMirrorOperation>, PersistenceError> {
        validate_operation_id(operation_id)?;
        self.operations
            .lock()
            .map_err(|_| {
                PersistenceError::InvalidInput(
                    "portable mirror operation lock is poisoned".to_owned(),
                )
            })?
            .get(operation_id)
            .cloned()
            .ok_or_else(|| {
                PersistenceError::InvalidInput("unknown portable mirror operation".to_owned())
            })
    }

    fn remove(
        &self,
        operation_id: &str,
        operation: &Arc<PortableMirrorOperation>,
    ) -> Result<(), PersistenceError> {
        let mut operations = self.operations.lock().map_err(|_| {
            PersistenceError::InvalidInput("portable mirror operation lock is poisoned".to_owned())
        })?;
        if operations
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            operations.remove(operation_id);
        }
        Ok(())
    }

    pub(crate) fn has_active_operations(&self) -> Result<bool, PersistenceError> {
        self.operations
            .lock()
            .map(|operations| !operations.is_empty())
            .map_err(|_| {
                PersistenceError::InvalidInput(
                    "portable mirror operation lock is poisoned".to_owned(),
                )
            })
    }
}

trait StoreDataAreaPath {
    fn data_area_path(&self) -> Result<PathBuf, PersistenceError>;
}

impl StoreDataAreaPath for ProductStore {
    fn data_area_path(&self) -> Result<PathBuf, PersistenceError> {
        self.root.parent().map(Path::to_path_buf).ok_or_else(|| {
            PersistenceError::InvalidInput("internal data directory has no parent".to_owned())
        })
    }
}

#[cfg(test)]
pub(crate) fn begin_store(
    store: &mut ProductStore,
    request: &PortableMirrorBeginRequest,
) -> Result<(), PersistenceError> {
    validate_operation_id(&request.operation_id)?;
    validate_request(request)?;
    let context = operation_context(store, request.clone())?;
    let attachment_sources = resolve_attachment_sources(store, request)?;
    begin_operation(&context, &attachment_sources)
}

fn begin_operation(
    context: &PortableMirrorOperationContext,
    attachment_sources: &BTreeMap<String, PathBuf>,
) -> Result<(), PersistenceError> {
    let request = &context.request;
    let directory = staging_directory(&context.internal_root, &request.operation_id);
    if directory.exists() {
        let existing: PortableMirrorBeginRequest =
            serde_json::from_slice(&fs::read(directory.join("request.json"))?)?;
        if serde_json::to_vec(&existing)? != serde_json::to_vec(request)? {
            return Err(PersistenceError::DuplicateOperationMismatch);
        }
        return Ok(());
    }
    fs::create_dir_all(&directory)?;
    write_json_staging_file(&directory.join("request.json"), request)?;
    fs::write(directory.join("manifest.json"), request.manifest.as_bytes())?;
    for (index, item) in request.items.iter().enumerate() {
        let staging = staging_file(&directory, index);
        if let Some(attachment_id) = &item.source_attachment_id {
            let source = attachment_sources.get(attachment_id).ok_or_else(|| {
                PersistenceError::InvalidInput(
                    "portable mirror Attachment source is missing".to_owned(),
                )
            })?;
            copy_resolved_attachment_cas_to(source, &item.sha256, item.expected_size, &staging)?;
        } else {
            File::create(&staging)?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn write_chunk_store(
    store: &mut ProductStore,
    operation_id: &str,
    item_index: usize,
    offset: u64,
    bytes: &[u8],
) -> Result<(), PersistenceError> {
    validate_operation_id(operation_id)?;
    let context = load_operation_context(store, operation_id)?;
    write_chunk_operation(&context, item_index, offset, bytes)
}

fn write_chunk_operation(
    context: &PortableMirrorOperationContext,
    item_index: usize,
    offset: u64,
    bytes: &[u8],
) -> Result<(), PersistenceError> {
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(PersistenceError::InvalidInput(
            "portable mirror chunk exceeds 4 MiB".to_owned(),
        ));
    }
    let directory = staging_directory(&context.internal_root, &context.request.operation_id);
    let request = &context.request;
    let item = request
        .items
        .get(item_index)
        .ok_or_else(|| PersistenceError::InvalidInput("unknown portable mirror item".to_owned()))?;
    if item.source_attachment_id.is_some() {
        return Err(PersistenceError::InvalidInput(
            "Attachment mirror items are copied from CAS".to_owned(),
        ));
    }
    let path = staging_file(&directory, item_index);
    let current = path.metadata()?.len();
    if offset < current {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut existing = vec![0; bytes.len()];
        let read = file.read(&mut existing)?;
        if read != bytes.len() || existing != bytes {
            return Err(PersistenceError::InvalidInput(
                "portable mirror chunk retry does not match".to_owned(),
            ));
        }
        return Ok(());
    }
    if offset != current || offset + bytes.len() as u64 > item.expected_size {
        return Err(PersistenceError::InvalidInput(
            "invalid portable mirror chunk boundary".to_owned(),
        ));
    }
    let mut file = OpenOptions::new().append(true).open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn commit_store(
    store: &mut ProductStore,
    operation_id: &str,
) -> Result<(), PersistenceError> {
    validate_operation_id(operation_id)?;
    let context = load_operation_context(store, operation_id)?;
    commit_operation(&context)
}

fn commit_operation(context: &PortableMirrorOperationContext) -> Result<(), PersistenceError> {
    commit_operation_with_hook(context, || {})
}

fn commit_operation_with_hook(
    context: &PortableMirrorOperationContext,
    after_staging_verified: impl FnOnce(),
) -> Result<(), PersistenceError> {
    let operation_id = &context.request.operation_id;
    let directory = staging_directory(&context.internal_root, operation_id);
    let request = &context.request;
    let manifest = parse_and_validate_manifest(&request.manifest, &request.items)?;
    for (index, item) in request.items.iter().enumerate() {
        sync_file(&staging_file(&directory, index))?;
        verify_file(
            &staging_file(&directory, index),
            &item.sha256,
            item.expected_size,
        )?;
    }
    validate_reused_files(&context.data_area, &manifest, &request.items)?;
    sync_directory(&directory)?;
    let data_area = &context.data_area;
    let marker = data_area.join(MIRROR_UPDATE_MARKER);
    write_json_file(
        &marker,
        &serde_json::json!({
            "schemaVersion": PORTABLE_MIRROR_SCHEMA_VERSION,
            "operationId": operation_id,
        }),
    )?;
    sync_directory(&data_area)?;
    after_staging_verified();

    let previous_paths = existing_manifest_paths(data_area)?;
    let current_paths = manifest
        .files
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<BTreeSet<_>>();
    let mut affected_directories = BTreeSet::new();
    for (index, item) in request.items.iter().enumerate() {
        let target = safe_mirror_target(data_area, &item.path)?;
        if let Some(parent) = target.parent() {
            create_safe_directories(data_area, parent, &mut affected_directories)?;
        }
        if target.exists() {
            let metadata = fs::symlink_metadata(&target)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(PersistenceError::InvalidInput(format!(
                    "portable mirror target is not a regular file: {}",
                    item.path
                )));
            }
            #[cfg(target_os = "windows")]
            fs::remove_file(&target)?;
        }
        fs::rename(staging_file(&directory, index), &target)?;
        if let Some(parent) = target.parent() {
            affected_directories.insert(parent.to_path_buf());
        }
    }

    for obsolete in previous_paths.difference(&current_paths) {
        let path = safe_mirror_target(data_area, obsolete)?;
        if path.exists() {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                fs::remove_file(&path)?;
                if let Some(parent) = path.parent() {
                    affected_directories.insert(parent.to_path_buf());
                }
                remove_empty_managed_parents(data_area, path.parent(), &mut affected_directories)?;
            }
        }
    }
    sync_directories(&affected_directories)?;

    let manifest_staging = directory.join("manifest.publish.tmp");
    fs::write(&manifest_staging, request.manifest.as_bytes())?;
    sync_file(&manifest_staging)?;
    let manifest_target = data_area.join(PORTABLE_MANIFEST_FILE);
    #[cfg(target_os = "windows")]
    if manifest_target.exists() {
        fs::remove_file(&manifest_target)?;
    }
    fs::rename(manifest_staging, &manifest_target)?;
    sync_directory(data_area)?;

    fs::remove_file(marker)?;
    sync_directory(data_area)?;
    fs::remove_dir_all(directory)?;
    sync_directory(&context.internal_root.join("portable-staging"))?;
    let _ = manifest;
    Ok(())
}

fn validate_reused_files(
    data_area: &Path,
    manifest: &PortableMirrorManifest,
    items: &[PortableMirrorItem],
) -> Result<(), PersistenceError> {
    let staged = items
        .iter()
        .map(|item| item.path.as_str())
        .collect::<BTreeSet<_>>();
    if staged.len() == manifest.files.len() {
        return Ok(());
    }
    let previous_path = data_area.join(PORTABLE_MANIFEST_FILE);
    let previous: PortableMirrorManifest = serde_json::from_slice(&fs::read(previous_path)?)?;
    validate_manifest(&previous)?;
    let previous_files = previous
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    for entry in &manifest.files {
        if staged.contains(entry.path.as_str()) {
            continue;
        }
        let Some(existing) = previous_files.get(entry.path.as_str()) else {
            return Err(PersistenceError::InvalidInput(format!(
                "portable mirror delta cannot reuse an unknown file: {}",
                entry.path
            )));
        };
        if existing.sha256 != entry.sha256
            || existing.size != entry.size
            || existing.kind != entry.kind
        {
            return Err(PersistenceError::InvalidInput(format!(
                "portable mirror delta changed a file without uploading it: {}",
                entry.path
            )));
        }
        let target = safe_mirror_target(data_area, &entry.path)?;
        let metadata = fs::symlink_metadata(&target)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != entry.size
        {
            return Err(PersistenceError::InvalidInput(format!(
                "portable mirror reusable file is unavailable: {}",
                entry.path
            )));
        }
    }
    Ok(())
}

fn cancel_operation(context: &PortableMirrorOperationContext) -> Result<(), PersistenceError> {
    let directory = staging_directory(&context.internal_root, &context.request.operation_id);
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

fn operation_context(
    store: &ProductStore,
    request: PortableMirrorBeginRequest,
) -> Result<PortableMirrorOperationContext, PersistenceError> {
    Ok(PortableMirrorOperationContext {
        data_area: store.data_area_path()?,
        internal_root: store.root.clone(),
        request,
    })
}

#[cfg(test)]
fn load_operation_context(
    store: &ProductStore,
    operation_id: &str,
) -> Result<PortableMirrorOperationContext, PersistenceError> {
    let directory = staging_directory(&store.root, operation_id);
    operation_context(store, load_request(&directory)?)
}

fn resolve_attachment_sources(
    store: &mut ProductStore,
    request: &PortableMirrorBeginRequest,
) -> Result<BTreeMap<String, PathBuf>, PersistenceError> {
    let mut sources = BTreeMap::new();
    for item in &request.items {
        let Some(attachment_id) = &item.source_attachment_id else {
            continue;
        };
        let source =
            resolve_attachment_cas_source(store, attachment_id, &item.sha256, item.expected_size)?;
        sources.insert(attachment_id.clone(), source);
    }
    Ok(sources)
}

pub fn verify_portable_mirror(source: &Path) -> Result<PortableMirrorManifest, PersistenceError> {
    if source.join(MIRROR_UPDATE_MARKER).exists() {
        return Err(PersistenceError::InvalidInput(
            "portable mirror publication is incomplete".to_owned(),
        ));
    }
    let manifest_source = fs::read_to_string(source.join(PORTABLE_MANIFEST_FILE))?;
    let manifest: PortableMirrorManifest = serde_json::from_str(&manifest_source)?;
    validate_manifest(&manifest)?;
    for entry in &manifest.files {
        let path = safe_mirror_target(source, &entry.path)?;
        verify_file(&path, &entry.sha256, entry.size)?;
    }
    Ok(manifest)
}

pub fn restore_portable_mirror(source: &Path, target: &Path) -> Result<(), PersistenceError> {
    let source = fs::canonicalize(source)?;
    let manifest = verify_portable_mirror(&source)?;
    prepare_restore_target(target)?;
    let target = fs::canonicalize(target)?;
    if source == target || source.starts_with(&target) || target.starts_with(&source) {
        return Err(PersistenceError::InvalidInput(
            "restore source and target must be separate directories".to_owned(),
        ));
    }
    validate_restore_targets(&target, &manifest)?;

    let staging_internal = target.join(".memoka-restore-staging");
    if staging_internal.exists() {
        return Err(PersistenceError::InvalidInput(
            "restore staging from another operation already exists".to_owned(),
        ));
    }
    let mut copied = Vec::<PathBuf>::new();
    let mut internal_published = false;
    let restored = (|| -> Result<(), PersistenceError> {
        let mut store = ProductStore::open(&staging_internal)?;
        restore_documents(&mut store, &source, &manifest)?;
        restore_attachments(&mut store, &source, &manifest)?;
        write_json_file(
            &staging_internal.join("data-area.json"),
            &serde_json::json!({
                "schemaVersion": 1,
                "kind": "memoka-data-area",
            }),
        )?;
        sync_directory(&staging_internal)?;
        drop(store);

        let mut affected_directories = BTreeSet::new();
        for entry in &manifest.files {
            let source_file = safe_mirror_target(&source, &entry.path)?;
            let target_file = safe_mirror_target(&target, &entry.path)?;
            if let Some(parent) = target_file.parent() {
                create_safe_directories(&target, parent, &mut affected_directories)?;
            }
            fs::copy(source_file, &target_file)?;
            sync_file(&target_file)?;
            if let Some(parent) = target_file.parent() {
                affected_directories.insert(parent.to_path_buf());
            }
            copied.push(target_file);
        }
        sync_directories(&affected_directories)?;
        let target_manifest = target.join(PORTABLE_MANIFEST_FILE);
        fs::copy(source.join(PORTABLE_MANIFEST_FILE), &target_manifest)?;
        sync_file(&target_manifest)?;
        copied.push(target_manifest);
        fs::rename(&staging_internal, target.join(".memoka"))?;
        internal_published = true;
        sync_directory(&target)?;
        Ok(())
    })();
    if let Err(error) = restored {
        for path in copied.iter().rev() {
            let _ = fs::remove_file(path);
        }
        if staging_internal.exists() {
            let _ = fs::remove_dir_all(&staging_internal);
        }
        if internal_published {
            let _ = fs::remove_dir_all(target.join(".memoka"));
        }
        return Err(error);
    }
    Ok(())
}

fn prepare_restore_target(target: &Path) -> Result<(), PersistenceError> {
    fs::create_dir_all(target)?;
    let metadata = fs::symlink_metadata(target)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::InvalidInput(
            "restore target must be a local directory".to_owned(),
        ));
    }
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == ".memoka" || name.starts_with(".memoka-") || name.starts_with("memoka-") {
            return Err(PersistenceError::InvalidInput(format!(
                "restore target already contains reserved Memoka data: {name}"
            )));
        }
    }
    Ok(())
}

fn validate_restore_targets(
    target: &Path,
    manifest: &PortableMirrorManifest,
) -> Result<(), PersistenceError> {
    let mut planned_top_level = BTreeSet::from([
        portable_collision_key(".memoka"),
        portable_collision_key(PORTABLE_MANIFEST_FILE),
    ]);
    for file in &manifest.files {
        let first = Path::new(&file.path)
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .ok_or_else(|| {
                PersistenceError::InvalidInput("portable restore path is invalid".to_owned())
            })?;
        planned_top_level.insert(portable_collision_key(first));
    }
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if planned_top_level.contains(&portable_collision_key(&name)) {
            return Err(PersistenceError::InvalidInput(format!(
                "restore target would overwrite or merge with existing data: {name}"
            )));
        }
    }
    Ok(())
}

fn restore_documents(
    store: &mut ProductStore,
    source: &Path,
    manifest: &PortableMirrorManifest,
) -> Result<(), PersistenceError> {
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Transact, Update};

    let mut identities = BTreeSet::new();
    let transaction = store.connection.transaction()?;
    let mut document_identities = BTreeSet::new();
    for document in &manifest.documents {
        if !document_identities.insert((document.kind.clone(), document.document_id.clone())) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror Manifest contains duplicate document identities".to_owned(),
            ));
        }
        if !identities.insert((document.kind.clone(), document.document_id.clone())) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror contains duplicate document identities".to_owned(),
            ));
        }
        let supported = matches!(
            (document.kind.as_str(), document.schema_version),
            ("workspace", 2) | ("note", 3)
        );
        if !supported || document.source_revision < 1 {
            return Err(PersistenceError::InvalidInput(
                "portable mirror document schema/revision is unsupported".to_owned(),
            ));
        }
        let snapshot = fs::read(safe_mirror_target(source, &document.path)?)?;
        let update = Update::decode_v1(&snapshot).map_err(|error| {
            PersistenceError::InvalidInput(format!(
                "portable recovery document is not a Yjs v1 update: {error}"
            ))
        })?;
        let probe = Doc::new();
        probe.transact_mut().apply_update(update).map_err(|error| {
            PersistenceError::InvalidInput(format!(
                "portable recovery document cannot be applied: {error}"
            ))
        })?;
        transaction.execute(
            "INSERT INTO documents (
                kind, document_id, schema_version, revision,
                snapshot_revision, snapshot
             ) VALUES (?1, ?2, ?3, 1, 1, ?4)",
            rusqlite::params![
                document.kind,
                document.document_id,
                document.schema_version,
                snapshot
            ],
        )?;
    }
    transaction.execute(
        "INSERT INTO settings (key, value) VALUES ('active_workspace_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&manifest.workspace_id],
    )?;
    transaction.commit()?;
    Ok(())
}

fn restore_attachments(
    store: &mut ProductStore,
    source: &Path,
    manifest: &PortableMirrorManifest,
) -> Result<(), PersistenceError> {
    let mut attachment_ids = BTreeSet::new();
    for attachment in &manifest.attachments {
        validate_uuid_v7(&attachment.attachment_id, "attachment_id")?;
        validate_sha256(&attachment.sha256)?;
        validate_filename(&attachment.original_filename)?;
        validate_mime_hint(&attachment.mime_type)?;
        if !attachment_ids.insert(&attachment.attachment_id) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror contains duplicate Attachment IDs".to_owned(),
            ));
        }
        let source_file = safe_mirror_target(source, &attachment.path)?;
        let object = store
            .root
            .join("attachments")
            .join("objects")
            .join(&attachment.sha256[..2])
            .join(&attachment.sha256[2..]);
        if let Some(parent) = object.parent() {
            fs::create_dir_all(parent)?;
        }
        if !object.exists() {
            fs::copy(source_file, &object)?;
            sync_file(&object)?;
        }
        store.connection.execute(
            "INSERT INTO attachment_objects (sha256, size, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(sha256) DO NOTHING",
            rusqlite::params![
                attachment.sha256,
                attachment.size as i64,
                attachment.created_at
            ],
        )?;
        store.connection.execute(
            "INSERT INTO attachments (
                attachment_id, sha256, size, original_filename, mime_type, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                attachment.attachment_id,
                attachment.sha256,
                attachment.size as i64,
                attachment.original_filename,
                attachment.mime_type,
                attachment.created_at
            ],
        )?;
    }
    Ok(())
}

fn parse_and_validate_manifest(
    source: &str,
    items: &[PortableMirrorItem],
) -> Result<PortableMirrorManifest, PersistenceError> {
    let manifest: PortableMirrorManifest = serde_json::from_str(source)?;
    validate_manifest(&manifest)?;
    let files = manifest
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    for item in items {
        let Some(entry) = files.get(item.path.as_str()) else {
            return Err(PersistenceError::InvalidInput(
                "portable mirror publication contains a file absent from its Manifest".to_owned(),
            ));
        };
        if entry.sha256 != item.sha256 || entry.size != item.expected_size {
            return Err(PersistenceError::InvalidInput(
                "portable mirror Manifest files disagree with publication".to_owned(),
            ));
        }
    }
    Ok(manifest)
}

fn validate_manifest(manifest: &PortableMirrorManifest) -> Result<(), PersistenceError> {
    if manifest.schema_version != PORTABLE_MIRROR_SCHEMA_VERSION || manifest.generated_at.is_empty()
    {
        return Err(PersistenceError::InvalidInput(
            "unsupported portable mirror Manifest".to_owned(),
        ));
    }
    validate_uuid_v7(&manifest.workspace_id, "workspace_id")?;
    let files = manifest
        .files
        .iter()
        .map(|entry| (&entry.path, entry))
        .collect::<BTreeMap<_, _>>();
    if files.len() != manifest.files.len() {
        return Err(PersistenceError::InvalidInput(
            "portable mirror Manifest contains duplicate paths".to_owned(),
        ));
    }
    let portable_keys = manifest
        .files
        .iter()
        .map(|entry| portable_collision_key(&entry.path))
        .collect::<BTreeSet<_>>();
    if portable_keys.len() != manifest.files.len() {
        return Err(PersistenceError::InvalidInput(
            "portable mirror Manifest contains case/NFC-colliding paths".to_owned(),
        ));
    }
    for entry in &manifest.files {
        validate_relative_path(&entry.path)?;
        validate_sha256(&entry.sha256)?;
        if !matches!(entry.kind.as_str(), "markdown" | "document" | "attachment") {
            return Err(PersistenceError::InvalidInput(
                "portable mirror Manifest contains an unknown file kind".to_owned(),
            ));
        }
    }
    let mut referenced_paths = BTreeSet::new();
    let mut document_identities = BTreeSet::new();
    let mut note_document_ids = BTreeSet::new();
    let mut workspace_documents = 0;
    for document in &manifest.documents {
        validate_uuid_v7(&document.document_id, "document_id")?;
        if document.source_revision < 1
            || !matches!(
                (document.kind.as_str(), document.schema_version),
                ("workspace", 2) | ("note", 3)
            )
            || !document_identities.insert((document.kind.clone(), document.document_id.clone()))
        {
            return Err(PersistenceError::InvalidInput(
                "portable mirror document identity/schema is invalid".to_owned(),
            ));
        }
        let file = files.get(&document.path).ok_or_else(|| {
            PersistenceError::InvalidInput("portable document file is missing".to_owned())
        })?;
        if file.kind != "document"
            || file.sha256 != document.sha256
            || file.size != document.size
            || !matches!(document.kind.as_str(), "workspace" | "note")
        {
            return Err(PersistenceError::InvalidInput(
                "portable document metadata disagrees with file entry".to_owned(),
            ));
        }
        if !referenced_paths.insert(document.path.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror file has multiple logical owners".to_owned(),
            ));
        }
        match document.kind.as_str() {
            "workspace" => workspace_documents += 1,
            "note" => {
                note_document_ids.insert(document.document_id.clone());
            }
            _ => unreachable!(),
        }
    }
    if workspace_documents != 1 {
        return Err(PersistenceError::InvalidInput(
            "portable mirror requires exactly one Workspace document".to_owned(),
        ));
    }
    if !manifest.documents.iter().any(|document| {
        document.kind == "workspace" && document.document_id == manifest.workspace_id
    }) {
        return Err(PersistenceError::InvalidInput(
            "portable mirror Workspace identity disagrees with recovery document".to_owned(),
        ));
    }

    let mut note_ids = BTreeSet::new();
    for note in &manifest.notes {
        validate_uuid_v7(&note.note_id, "note_id")?;
        if !note_ids.insert(note.note_id.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror Manifest contains duplicate Note identities".to_owned(),
            ));
        }
    }
    let parents = manifest
        .notes
        .iter()
        .map(|note| (note.note_id.as_str(), note.parent_note_id.as_deref()))
        .collect::<BTreeMap<_, _>>();
    let mut section_ids = note_ids.clone();
    for note in &manifest.notes {
        if let Some(parent_id) = note.parent_note_id.as_deref() {
            validate_uuid_v7(parent_id, "parent_note_id")?;
            if !note_ids.contains(parent_id) {
                return Err(PersistenceError::InvalidInput(
                    "portable mirror Note parent is missing".to_owned(),
                ));
            }
        }
        let mut ancestry = BTreeSet::from([note.note_id.as_str()]);
        let mut parent = note.parent_note_id.as_deref();
        while let Some(parent_id) = parent {
            if !ancestry.insert(parent_id) {
                return Err(PersistenceError::InvalidInput(
                    "portable mirror Note tree contains a cycle".to_owned(),
                ));
            }
            parent = parents.get(parent_id).copied().flatten();
        }
        let file = files.get(&note.markdown_path).ok_or_else(|| {
            PersistenceError::InvalidInput("portable Note Markdown file is missing".to_owned())
        })?;
        if file.kind != "markdown" || !referenced_paths.insert(note.markdown_path.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable Note Markdown ownership is invalid".to_owned(),
            ));
        }
        for section in &note.sections {
            validate_uuid_v7(&section.section_id, "section_id")?;
            if !section_ids.insert(section.section_id.clone()) {
                return Err(PersistenceError::InvalidInput(
                    "portable mirror contains duplicate Section identities".to_owned(),
                ));
            }
            let file = files.get(&section.markdown_path).ok_or_else(|| {
                PersistenceError::InvalidInput(
                    "portable Section Markdown file is missing".to_owned(),
                )
            })?;
            if file.kind != "markdown" || !referenced_paths.insert(section.markdown_path.clone()) {
                return Err(PersistenceError::InvalidInput(
                    "portable Section Markdown ownership is invalid".to_owned(),
                ));
            }
        }
    }
    if note_document_ids != note_ids {
        return Err(PersistenceError::InvalidInput(
            "portable mirror Note list disagrees with recovery documents".to_owned(),
        ));
    }

    let mut attachment_ids = BTreeSet::new();
    for attachment in &manifest.attachments {
        validate_uuid_v7(&attachment.attachment_id, "attachment_id")?;
        validate_sha256(&attachment.sha256)?;
        validate_filename(&attachment.original_filename)?;
        validate_mime_hint(&attachment.mime_type)?;
        if !attachment_ids.insert(attachment.attachment_id.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror Manifest contains duplicate Attachment identities".to_owned(),
            ));
        }
        let file = files.get(&attachment.path).ok_or_else(|| {
            PersistenceError::InvalidInput("portable Attachment file is missing".to_owned())
        })?;
        if file.kind != "attachment"
            || file.sha256 != attachment.sha256
            || file.size != attachment.size
        {
            return Err(PersistenceError::InvalidInput(
                "portable Attachment metadata disagrees with file entry".to_owned(),
            ));
        }
        if !referenced_paths.insert(attachment.path.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable Attachment file has multiple logical owners".to_owned(),
            ));
        }
    }
    let file_paths = files.keys().map(|path| (*path).clone()).collect();
    if referenced_paths != file_paths {
        return Err(PersistenceError::InvalidInput(
            "portable mirror contains unreferenced files".to_owned(),
        ));
    }
    Ok(())
}

fn validate_request(request: &PortableMirrorBeginRequest) -> Result<(), PersistenceError> {
    if request.items.is_empty() {
        return Err(PersistenceError::InvalidInput(
            "portable mirror publication requires files".to_owned(),
        ));
    }
    let mut paths = BTreeSet::new();
    let mut portable_keys = BTreeSet::new();
    for item in &request.items {
        validate_relative_path(&item.path)?;
        validate_sha256(&item.sha256)?;
        if !paths.insert(item.path.clone()) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror publication contains duplicate paths".to_owned(),
            ));
        }
        if !portable_keys.insert(portable_collision_key(&item.path)) {
            return Err(PersistenceError::InvalidInput(
                "portable mirror publication contains case/NFC-colliding paths".to_owned(),
            ));
        }
    }
    parse_and_validate_manifest(&request.manifest, &request.items)?;
    Ok(())
}

fn portable_collision_key(value: &str) -> String {
    value.nfc().flat_map(char::to_lowercase).collect()
}

fn validate_relative_path(value: &str) -> Result<(), PersistenceError> {
    let portable_key = portable_collision_key(value);
    let first_key = value
        .split('/')
        .next()
        .map(portable_collision_key)
        .unwrap_or_default();
    if value.is_empty()
        || value.as_bytes().len() > MAX_PORTABLE_RELATIVE_PATH_BYTES
        || value.contains('\\')
        || first_key == portable_collision_key(".memoka")
        || first_key == portable_collision_key(PORTABLE_MANIFEST_FILE)
        || first_key == portable_collision_key(MIRROR_UPDATE_MARKER)
        || portable_key == portable_collision_key(PORTABLE_MANIFEST_FILE)
        || portable_key == portable_collision_key(MIRROR_UPDATE_MARKER)
    {
        return Err(PersistenceError::InvalidInput(format!(
            "invalid portable mirror path: {value}"
        )));
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PersistenceError::InvalidInput(format!(
            "invalid portable mirror path: {value}"
        )));
    }
    for component in value.split('/') {
        let normalized = component.nfc().collect::<String>();
        let invalid_character = component
            .chars()
            .any(|character| character.is_control() || "<>:\"|?*".contains(character));
        let collision_key = portable_collision_key(component);
        let lower_stem = collision_key.split('.').next().unwrap_or_default();
        let reserved = matches!(lower_stem, "con" | "prn" | "aux" | "nul")
            || ((lower_stem.starts_with("com") || lower_stem.starts_with("lpt"))
                && lower_stem.get(3..).is_some_and(|suffix| {
                    matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                }));
        if component.as_bytes().len() > MAX_PORTABLE_COMPONENT_BYTES
            || normalized != component
            || invalid_character
            || component.ends_with(' ')
            || component.ends_with('.')
            || reserved
        {
            return Err(PersistenceError::InvalidInput(format!(
                "invalid portable mirror path component: {component}"
            )));
        }
    }
    Ok(())
}

fn safe_mirror_target(root: &Path, relative: &str) -> Result<PathBuf, PersistenceError> {
    validate_relative_path(relative)?;
    Ok(root.join(relative))
}

fn create_safe_directories(
    root: &Path,
    target: &Path,
    affected_directories: &mut BTreeSet<PathBuf>,
) -> Result<(), PersistenceError> {
    let relative = target.strip_prefix(root).map_err(|_| {
        PersistenceError::InvalidInput("portable mirror target escaped data area".to_owned())
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(PersistenceError::InvalidInput(
                "portable mirror directory is invalid".to_owned(),
            ));
        };
        current.push(component);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(PersistenceError::InvalidInput(format!(
                    "portable mirror parent is not a regular directory: {}",
                    current.display()
                )));
            }
        } else {
            fs::create_dir(&current)?;
            if let Some(parent) = current.parent() {
                affected_directories.insert(parent.to_path_buf());
            }
            affected_directories.insert(current.clone());
        }
    }
    Ok(())
}

fn existing_manifest_paths(data_area: &Path) -> Result<BTreeSet<String>, PersistenceError> {
    let path = data_area.join(PORTABLE_MANIFEST_FILE);
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let bytes = fs::read(path)?;
    let Ok(manifest) = serde_json::from_slice::<PortableMirrorManifest>(&bytes) else {
        return Ok(BTreeSet::new());
    };
    if validate_manifest(&manifest).is_err() {
        return Ok(BTreeSet::new());
    }
    Ok(manifest.files.into_iter().map(|entry| entry.path).collect())
}

fn current_manifest(data_area: &Path) -> Result<Option<PortableMirrorManifest>, PersistenceError> {
    if data_area.join(MIRROR_UPDATE_MARKER).exists() {
        return Ok(None);
    }
    let path = data_area.join(PORTABLE_MANIFEST_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let manifest: PortableMirrorManifest = serde_json::from_slice(&fs::read(path)?)?;
    validate_manifest(&manifest)?;
    for entry in &manifest.files {
        let target = safe_mirror_target(data_area, &entry.path)?;
        let metadata = fs::symlink_metadata(target)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != entry.size
        {
            return Err(PersistenceError::InvalidInput(format!(
                "portable mirror file is unavailable: {}",
                entry.path
            )));
        }
    }
    Ok(Some(manifest))
}

fn remove_empty_managed_parents(
    root: &Path,
    mut parent: Option<&Path>,
    affected_directories: &mut BTreeSet<PathBuf>,
) -> Result<(), PersistenceError> {
    while let Some(directory) = parent {
        if directory == root || directory.file_name().is_some_and(|name| name == ".memoka") {
            break;
        }
        if fs::read_dir(directory)?.next().is_some() {
            break;
        }
        let ancestor = directory.parent();
        fs::remove_dir(directory)?;
        if let Some(ancestor) = ancestor {
            affected_directories.insert(ancestor.to_path_buf());
        }
        parent = ancestor;
    }
    Ok(())
}

fn staging_directory(internal_root: &Path, operation_id: &str) -> PathBuf {
    internal_root.join("portable-staging").join(operation_id)
}

fn staging_file(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("{index}.part"))
}

#[cfg(test)]
fn load_request(directory: &Path) -> Result<PortableMirrorBeginRequest, PersistenceError> {
    Ok(serde_json::from_slice(&fs::read(
        directory.join("request.json"),
    )?)?)
}

fn validate_operation_id(value: &str) -> Result<(), PersistenceError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(PersistenceError::InvalidInput(
            "portable mirror operation ID is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), PersistenceError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(PersistenceError::InvalidInput(
            "portable mirror SHA-256 is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn verify_file(
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<(), PersistenceError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != expected_size {
        return Err(PersistenceError::InvalidInput(format!(
            "portable mirror file size/type mismatch: {}",
            path.display()
        )));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected_hash {
        return Err(PersistenceError::InvalidInput(format!(
            "portable mirror SHA-256 mismatch: {}",
            path.display()
        )));
    }
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), PersistenceError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn write_json_staging_file<T: Serialize>(path: &Path, value: &T) -> Result<(), PersistenceError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn sync_directories(directories: &BTreeSet<PathBuf>) -> Result<(), PersistenceError> {
    let mut ordered = directories.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        right
            .components()
            .count()
            .cmp(&left.components().count())
            .then_with(|| left.cmp(right))
    });
    for directory in ordered {
        if directory.exists() {
            sync_directory(directory)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn portable_mirror_status(app: AppHandle) -> Result<PortableMirrorStatus, String> {
    run_mirror_blocking(move || {
        app.state::<ProductPersistenceState>()
            .with_store(&app, |store| {
                let data_area = store.data_area_path()?;
                let manifest_exists = data_area.join(PORTABLE_MANIFEST_FILE).exists();
                let marker_exists = data_area.join(MIRROR_UPDATE_MARKER).exists();
                let manifest = current_manifest(&data_area).ok().flatten();
                Ok(PortableMirrorStatus {
                    mirror_needs_repair: marker_exists || (manifest_exists && manifest.is_none()),
                    manifest,
                    document_revisions: store.document_revisions()?,
                })
            })
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn portable_mirror_list_attachments(
    app: AppHandle,
) -> Result<Vec<AttachmentMetadata>, String> {
    run_mirror_blocking(move || {
        app.state::<ProductPersistenceState>()
            .with_store(&app, list_all_attachment_metadata)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn portable_mirror_begin(
    app: AppHandle,
    request: PortableMirrorBeginRequest,
) -> Result<(), String> {
    run_mirror_blocking(move || {
        validate_operation_id(&request.operation_id).map_err(|error| error.to_string())?;
        validate_request(&request).map_err(|error| error.to_string())?;
        let persistence = app.state::<ProductPersistenceState>();
        let operations = app.state::<PortableMirrorOperationState>();
        let (context, attachment_sources) = persistence
            .with_store(&app, |store| {
                Ok((
                    operation_context(store, request.clone())?,
                    resolve_attachment_sources(store, &request)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let operation = operations
            .register(context)
            .map_err(|error| error.to_string())?;
        let result = operation
            .io
            .lock()
            .map_err(|_| "portable mirror I/O lock is poisoned".to_owned())
            .and_then(|_guard| {
                begin_operation(&operation.context, &attachment_sources)
                    .map_err(|error| error.to_string())
            });
        if result.is_err() {
            let _ = cancel_operation(&operation.context);
            let _ = operations.remove(&request.operation_id, &operation);
        }
        result
    })
    .await
}

#[tauri::command(async)]
pub(crate) fn portable_mirror_write_chunk(
    operations: State<'_, PortableMirrorOperationState>,
    request: Request<'_>,
) -> Result<(), String> {
    let operation_id = request_header(&request, "x-memoka-operation-id")?;
    let item_index = request_header(&request, "x-memoka-item-index")?
        .parse::<usize>()
        .map_err(|error| format!("invalid portable mirror item index: {error}"))?;
    let offset = request_header(&request, "x-memoka-chunk-offset")?
        .parse::<u64>()
        .map_err(|error| format!("invalid portable mirror chunk offset: {error}"))?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => {
            return Err("portable mirror chunks require a raw IPC body".to_owned());
        }
    };
    let operation = operations
        .get(&operation_id)
        .map_err(|error| error.to_string())?;
    operation
        .io
        .lock()
        .map_err(|_| "portable mirror I/O lock is poisoned".to_owned())
        .and_then(|_guard| {
            write_chunk_operation(&operation.context, item_index, offset, bytes)
                .map_err(|error| error.to_string())
        })
}

#[tauri::command]
pub(crate) async fn portable_mirror_commit(
    app: AppHandle,
    operation_id: String,
) -> Result<(), String> {
    run_mirror_blocking(move || {
        let operations = app.state::<PortableMirrorOperationState>();
        let operation = operations
            .get(&operation_id)
            .map_err(|error| error.to_string())?;
        let result = operation
            .io
            .lock()
            .map_err(|_| "portable mirror I/O lock is poisoned".to_owned())
            .and_then(|_guard| {
                commit_operation(&operation.context).map_err(|error| error.to_string())
            });
        if result.is_ok() {
            operations
                .remove(&operation_id, &operation)
                .map_err(|error| error.to_string())?;
        }
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn portable_mirror_cancel(
    app: AppHandle,
    operation_id: String,
) -> Result<(), String> {
    run_mirror_blocking(move || {
        let operations = app.state::<PortableMirrorOperationState>();
        let operation = match operations.get(&operation_id) {
            Ok(operation) => operation,
            Err(PersistenceError::InvalidInput(message))
                if message == "unknown portable mirror operation" =>
            {
                return Ok(());
            }
            Err(error) => return Err(error.to_string()),
        };
        let result = operation
            .io
            .lock()
            .map_err(|_| "portable mirror I/O lock is poisoned".to_owned())
            .and_then(|_guard| {
                cancel_operation(&operation.context).map_err(|error| error.to_string())
            });
        if result.is_ok() {
            operations
                .remove(&operation_id, &operation)
                .map_err(|error| error.to_string())?;
        }
        result
    })
    .await
}

async fn run_mirror_blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|error| format!("portable mirror worker failed: {error}"))?
}

fn request_header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing request header: {name}"))
}

#[cfg(test)]
mod tests {
    use super::{
        MIRROR_UPDATE_MARKER, PORTABLE_MANIFEST_FILE, PORTABLE_MIRROR_SCHEMA_VERSION,
        PortableMirrorBeginRequest, PortableMirrorDocumentEntry, PortableMirrorFileEntry,
        PortableMirrorItem, PortableMirrorManifest, PortableMirrorNoteEntry, begin_store,
        commit_operation_with_hook, commit_store, load_operation_context, restore_portable_mirror,
        validate_restore_targets, verify_portable_mirror, write_chunk_store,
    };
    use crate::persistence::ProductStore;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use tempfile::tempdir;

    fn sha256(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn publishes_manifest_last_and_verifies_every_file() {
        let temporary = tempdir().unwrap();
        let data_area = temporary.path().join("workspace");
        let internal = data_area.join(".memoka");
        let mut store = ProductStore::open(&internal).unwrap();
        let bytes = b"workspace-yjs-snapshot";
        let hash = sha256(bytes);
        let path = "memoka-recovery/workspace.yjs";
        let workspace_id = "0198d9c8-1a2b-7c3d-8e4f-1234567890ab";
        let manifest = PortableMirrorManifest {
            schema_version: PORTABLE_MIRROR_SCHEMA_VERSION,
            generated_at: "2026-08-24T00:00:00.000Z".to_owned(),
            workspace_id: workspace_id.to_owned(),
            notes: vec![],
            documents: vec![PortableMirrorDocumentEntry {
                kind: "workspace".to_owned(),
                document_id: workspace_id.to_owned(),
                schema_version: 2,
                source_revision: 1,
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
            }],
            attachments: vec![],
            files: vec![PortableMirrorFileEntry {
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
                kind: "document".to_owned(),
            }],
        };
        let request = PortableMirrorBeginRequest {
            operation_id: "operation-1".to_owned(),
            manifest: format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
            items: vec![PortableMirrorItem {
                path: path.to_owned(),
                expected_size: bytes.len() as u64,
                sha256: hash,
                source_attachment_id: None,
            }],
        };
        begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, "operation-1", 0, 0, bytes).unwrap();
        commit_store(&mut store, "operation-1").unwrap();

        assert_eq!(fs::read(data_area.join(path)).unwrap(), bytes);
        assert!(data_area.join(PORTABLE_MANIFEST_FILE).is_file());
        assert!(!data_area.join(MIRROR_UPDATE_MARKER).exists());
        assert_eq!(
            verify_portable_mirror(&data_area).unwrap().workspace_id,
            workspace_id
        );

        fs::write(data_area.join(path), b"tampered").unwrap();
        assert!(
            verify_portable_mirror(&data_area)
                .unwrap_err()
                .to_string()
                .contains("size/type mismatch")
        );
    }

    #[test]
    fn delta_publication_reuses_unchanged_manifest_files() {
        let temporary = tempdir().unwrap();
        let data_area = temporary.path().join("workspace");
        let internal = data_area.join(".memoka");
        let mut store = ProductStore::open(&internal).unwrap();
        let workspace_id = "0198d9c8-1a2b-7c3d-8e4f-1234567890ab";
        let note_id = "0198d9c8-1a2b-7c3d-9e4f-1234567890ab";
        let workspace_path = "memoka-recovery/workspace.yjs";
        let note_path = "memoka-recovery/Project.yjs";
        let markdown_path = "Project.md";
        let original_workspace = b"workspace-one";
        let updated_workspace = b"workspace-two";
        let note = b"note-recovery";
        let markdown = b"# Project\n";

        let manifest = |workspace: &[u8], revision: i64, generated_at: &str| {
            let workspace_hash = sha256(workspace);
            let note_hash = sha256(note);
            let markdown_hash = sha256(markdown);
            PortableMirrorManifest {
                schema_version: PORTABLE_MIRROR_SCHEMA_VERSION,
                generated_at: generated_at.to_owned(),
                workspace_id: workspace_id.to_owned(),
                notes: vec![PortableMirrorNoteEntry {
                    note_id: note_id.to_owned(),
                    parent_note_id: None,
                    deleted_at: None,
                    markdown_path: markdown_path.to_owned(),
                    sections: vec![],
                }],
                documents: vec![
                    PortableMirrorDocumentEntry {
                        kind: "workspace".to_owned(),
                        document_id: workspace_id.to_owned(),
                        schema_version: 2,
                        source_revision: revision,
                        path: workspace_path.to_owned(),
                        sha256: workspace_hash.clone(),
                        size: workspace.len() as u64,
                    },
                    PortableMirrorDocumentEntry {
                        kind: "note".to_owned(),
                        document_id: note_id.to_owned(),
                        schema_version: 3,
                        source_revision: 1,
                        path: note_path.to_owned(),
                        sha256: note_hash.clone(),
                        size: note.len() as u64,
                    },
                ],
                attachments: vec![],
                files: vec![
                    PortableMirrorFileEntry {
                        path: workspace_path.to_owned(),
                        sha256: workspace_hash,
                        size: workspace.len() as u64,
                        kind: "document".to_owned(),
                    },
                    PortableMirrorFileEntry {
                        path: markdown_path.to_owned(),
                        sha256: markdown_hash,
                        size: markdown.len() as u64,
                        kind: "markdown".to_owned(),
                    },
                    PortableMirrorFileEntry {
                        path: note_path.to_owned(),
                        sha256: note_hash,
                        size: note.len() as u64,
                        kind: "document".to_owned(),
                    },
                ],
            }
        };
        let first_manifest = manifest(original_workspace, 1, "2026-08-24T00:00:00.000Z");
        let first_items = [
            (workspace_path, original_workspace.as_slice()),
            (markdown_path, markdown.as_slice()),
            (note_path, note.as_slice()),
        ];
        let first_request = PortableMirrorBeginRequest {
            operation_id: "delta-baseline".to_owned(),
            manifest: serde_json::to_string_pretty(&first_manifest).unwrap(),
            items: first_items
                .iter()
                .map(|(path, bytes)| PortableMirrorItem {
                    path: (*path).to_owned(),
                    expected_size: bytes.len() as u64,
                    sha256: sha256(bytes),
                    source_attachment_id: None,
                })
                .collect(),
        };
        begin_store(&mut store, &first_request).unwrap();
        for (index, (_, bytes)) in first_items.iter().enumerate() {
            write_chunk_store(&mut store, "delta-baseline", index, 0, bytes).unwrap();
        }
        commit_store(&mut store, "delta-baseline").unwrap();

        let second_manifest = manifest(updated_workspace, 2, "2026-08-24T00:00:01.000Z");
        let second_request = PortableMirrorBeginRequest {
            operation_id: "delta-update".to_owned(),
            manifest: serde_json::to_string_pretty(&second_manifest).unwrap(),
            items: vec![PortableMirrorItem {
                path: workspace_path.to_owned(),
                expected_size: updated_workspace.len() as u64,
                sha256: sha256(updated_workspace),
                source_attachment_id: None,
            }],
        };
        begin_store(&mut store, &second_request).unwrap();
        write_chunk_store(&mut store, "delta-update", 0, 0, updated_workspace).unwrap();
        commit_store(&mut store, "delta-update").unwrap();

        assert_eq!(
            fs::read(data_area.join(workspace_path)).unwrap(),
            updated_workspace
        );
        assert_eq!(fs::read(data_area.join(markdown_path)).unwrap(), markdown);
        assert_eq!(fs::read(data_area.join(note_path)).unwrap(), note);
        assert_eq!(
            verify_portable_mirror(&data_area)
                .unwrap()
                .documents
                .first()
                .unwrap()
                .source_revision,
            2
        );
    }

    #[test]
    fn keeps_the_product_store_available_while_mirror_io_is_in_flight() {
        let temporary = tempdir().unwrap();
        let data_area = temporary.path().join("workspace");
        let internal = data_area.join(".memoka");
        let mut store = ProductStore::open(&internal).unwrap();
        let bytes = b"non-blocking-workspace-snapshot";
        let hash = sha256(bytes);
        let path = "memoka-recovery/workspace.yjs";
        let workspace_id = "0198d9c8-1a2b-7c3d-8e4f-1234567890ab";
        let manifest = PortableMirrorManifest {
            schema_version: PORTABLE_MIRROR_SCHEMA_VERSION,
            generated_at: "2026-08-24T00:00:00.000Z".to_owned(),
            workspace_id: workspace_id.to_owned(),
            notes: vec![],
            documents: vec![PortableMirrorDocumentEntry {
                kind: "workspace".to_owned(),
                document_id: workspace_id.to_owned(),
                schema_version: 2,
                source_revision: 1,
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
            }],
            attachments: vec![],
            files: vec![PortableMirrorFileEntry {
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
                kind: "document".to_owned(),
            }],
        };
        let request = PortableMirrorBeginRequest {
            operation_id: "operation-concurrency".to_owned(),
            manifest: format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
            items: vec![PortableMirrorItem {
                path: path.to_owned(),
                expected_size: bytes.len() as u64,
                sha256: hash,
                source_attachment_id: None,
            }],
        };
        begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, "operation-concurrency", 0, 0, bytes).unwrap();
        let context = load_operation_context(&store, "operation-concurrency").unwrap();
        let (entered_sender, entered_receiver) = mpsc::channel();
        let (resume_sender, resume_receiver) = mpsc::channel();
        let publishing = thread::spawn(move || {
            commit_operation_with_hook(&context, || {
                entered_sender.send(()).unwrap();
                resume_receiver.recv().unwrap();
            })
        });

        entered_receiver.recv().unwrap();
        assert!(store.manifest().is_ok());
        resume_sender.send(()).unwrap();
        publishing.join().unwrap().unwrap();
        assert_eq!(
            verify_portable_mirror(&data_area).unwrap().workspace_id,
            workspace_id
        );
    }

    #[test]
    fn refuses_a_mirror_with_an_in_progress_marker() {
        let temporary = tempdir().unwrap();
        fs::write(temporary.path().join(MIRROR_UPDATE_MARKER), "publishing").unwrap();
        assert!(
            verify_portable_mirror(temporary.path())
                .unwrap_err()
                .to_string()
                .contains("publication is incomplete")
        );
    }

    #[test]
    fn refuses_restore_before_overwriting_a_case_equivalent_target() {
        let target = tempdir().unwrap();
        fs::write(target.path().join("project.md"), "keep").unwrap();
        let manifest = PortableMirrorManifest {
            schema_version: PORTABLE_MIRROR_SCHEMA_VERSION,
            generated_at: "2026-08-24T00:00:00.000Z".to_owned(),
            workspace_id: "0198d9c8-1a2b-7c3d-8e4f-1234567890ab".to_owned(),
            notes: vec![],
            documents: vec![],
            attachments: vec![],
            files: vec![PortableMirrorFileEntry {
                path: "Project.md".to_owned(),
                sha256: "0".repeat(64),
                size: 0,
                kind: "markdown".to_owned(),
            }],
        };
        let error = validate_restore_targets(target.path(), &manifest).unwrap_err();
        assert!(error.to_string().contains("overwrite or merge"));
        assert_eq!(
            fs::read_to_string(target.path().join("project.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn restores_recovery_documents_as_a_fresh_database_baseline() {
        use yrs::{ReadTxn, StateVector, Text, Transact};

        let temporary = tempdir().unwrap();
        let source = temporary.path().join("source");
        let mut store = ProductStore::open(source.join(".memoka")).unwrap();
        let document = yrs::Doc::with_client_id(7);
        document.get_or_insert_text("workspace").insert(
            &mut document.transact_mut(),
            0,
            "portable",
        );
        let bytes = document
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let hash = sha256(&bytes);
        let path = "memoka-recovery/workspace.yjs";
        let workspace_id = "0198d9c8-1a2b-7c3d-8e4f-1234567890ab";
        let manifest = PortableMirrorManifest {
            schema_version: PORTABLE_MIRROR_SCHEMA_VERSION,
            generated_at: "2026-08-24T00:00:00.000Z".to_owned(),
            workspace_id: workspace_id.to_owned(),
            notes: vec![],
            documents: vec![PortableMirrorDocumentEntry {
                kind: "workspace".to_owned(),
                document_id: workspace_id.to_owned(),
                schema_version: 2,
                source_revision: 9,
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
            }],
            attachments: vec![],
            files: vec![PortableMirrorFileEntry {
                path: path.to_owned(),
                sha256: hash.clone(),
                size: bytes.len() as u64,
                kind: "document".to_owned(),
            }],
        };
        let request = PortableMirrorBeginRequest {
            operation_id: "restore-source".to_owned(),
            manifest: format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
            items: vec![PortableMirrorItem {
                path: path.to_owned(),
                expected_size: bytes.len() as u64,
                sha256: hash,
                source_attachment_id: None,
            }],
        };
        begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, "restore-source", 0, 0, &bytes).unwrap();
        commit_store(&mut store, "restore-source").unwrap();
        drop(store);

        let target = temporary.path().join("target");
        restore_portable_mirror(&source, &target).unwrap();
        let restored = ProductStore::open(target.join(".memoka")).unwrap();
        let persisted = restored.load_document("workspace", workspace_id).unwrap();
        assert_eq!(persisted.revision, 1);
        assert_eq!(persisted.snapshot_revision, 1);
        assert!(persisted.updates.is_empty());
        assert_eq!(persisted.snapshot, bytes);
        assert_eq!(
            restored.manifest().unwrap().active_workspace_id.as_deref(),
            Some(workspace_id)
        );
    }
}
