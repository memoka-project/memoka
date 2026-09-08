//! Read-only compatibility for portable mirrors written by earlier Memoka.
//! New workspaces use Restic; no publication API is registered or implemented.
use crate::attachment::{validate_filename, validate_mime_hint, validate_uuid_v7};
use crate::data_area::MIRROR_UPDATE_MARKER;
use crate::persistence::{
    PersistedDocument, PersistenceError, ProductStore, sync_directory, sync_file,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const PORTABLE_MIRROR_SCHEMA_VERSION: u32 = 1;
pub const PORTABLE_MANIFEST_FILE: &str = "memoka-manifest.json";
const MAX_PORTABLE_COMPONENT_BYTES: usize = 255;
const MAX_PORTABLE_RELATIVE_PATH_BYTES: usize = 2_048;

#[cfg(test)]
#[path = "portable_mirror_tests.rs"]
mod tests;

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

pub fn verify_portable_mirror(source: &Path) -> Result<PortableMirrorManifest, PersistenceError> {
    if source.join(MIRROR_UPDATE_MARKER).exists() {
        return Err(PersistenceError::InvalidInput(
            "portable mirror publication is incomplete".to_owned(),
        ));
    }
    crate::read_service::plain_file(&source.join(PORTABLE_MANIFEST_FILE)).map_err(legacy_error)?;
    let manifest_source = fs::read_to_string(source.join(PORTABLE_MANIFEST_FILE))?;
    let manifest: PortableMirrorManifest = serde_json::from_str(&manifest_source)?;
    validate_manifest(&manifest)?;
    for entry in &manifest.files {
        let path = safe_mirror_target(source, &entry.path)?;
        verify_file(&path, &entry.sha256, entry.size)?;
    }
    load_recovery_documents(source, &manifest)?;
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
            verify_file(&target_file, &entry.sha256, entry.size)?;
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

fn legacy_error(error: crate::document_model::ReadError) -> PersistenceError {
    PersistenceError::InvalidInput(format!("{}: {}", error.code, error.message))
}
fn load_recovery_documents(
    source: &Path,
    manifest: &PortableMirrorManifest,
) -> Result<Vec<PersistedDocument>, PersistenceError> {
    let mut documents = Vec::new();
    let mut expected = BTreeSet::new();
    let mut actual = BTreeSet::new();
    for entry in &manifest.documents {
        let path = safe_mirror_target(source, &entry.path)?;
        let snapshot = fs::read(path)?;
        let hash = Sha256::digest(&snapshot)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if snapshot.len() as u64 != entry.size || hash != entry.sha256 {
            return Err(PersistenceError::InvalidInput(
                "Recovery source changed after verification".into(),
            ));
        }
        let mut document = PersistedDocument {
            kind: entry.kind.clone(),
            document_id: entry.document_id.clone(),
            schema_version: entry.schema_version,
            revision: 1,
            snapshot_revision: 1,
            snapshot,
            updates: Vec::new(),
        };
        if document.kind == "workspace" {
            let (snapshot, _) =
                crate::namespace::migrate_workspace(&document).map_err(legacy_error)?;
            document.schema_version = 3;
            document.snapshot = snapshot;
            let namespace = crate::namespace::read_namespace(&document).map_err(legacy_error)?;
            expected.extend(namespace.notes.keys().cloned());
        } else {
            if let Some(snapshot) =
                crate::document_model::migrate_note(&document).map_err(legacy_error)?
            {
                document.snapshot = snapshot;
            }
            document.schema_version = 6;
            crate::document_model::read_note(&document, false).map_err(legacy_error)?;
            actual.insert(document.document_id.clone());
        }
        documents.push(document);
    }
    if actual != expected {
        return Err(PersistenceError::InvalidInput(
            "Recovery Workspace and Note documents disagree".into(),
        ));
    }
    Ok(documents)
}
fn restore_documents(
    store: &mut ProductStore,
    source: &Path,
    manifest: &PortableMirrorManifest,
) -> Result<(), PersistenceError> {
    // Validate and migrate the complete set before writing any source document.
    let documents = load_recovery_documents(source, manifest)?;
    let transaction = store.connection.transaction()?;
    for document in documents {
        transaction.execute("INSERT INTO documents (kind, document_id, schema_version, revision, snapshot_revision, snapshot)
            VALUES (?1, ?2, ?3, 1, 1, ?4)", rusqlite::params![document.kind,document.document_id,document.schema_version,document.snapshot])?;
    }
    transaction.execute(
        "INSERT INTO settings (key, value) VALUES ('active_workspace_id', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [&manifest.workspace_id],
    )?;
    transaction.execute("INSERT INTO settings (key,value) VALUES ('content_epoch','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])?;
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
        verify_file(&object, &attachment.sha256, attachment.size)?;
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
                ("workspace", 2) | ("note", 2 | 3)
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
    let target = root.join(relative);
    let mut ancestor = target.parent();
    while let Some(path) = ancestor {
        if path == root {
            break;
        }
        match fs::symlink_metadata(path) {
            Ok(_) => {
                crate::read_service::checked_directory(path).map_err(legacy_error)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        ancestor = path.parent();
    }
    Ok(target)
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
