use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::http::{Response, StatusCode};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::persistence::{
    PersistenceError, ProductPersistenceState, ProductStore, sync_directory, sync_file,
};

pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const MAX_BATCH_FILES: usize = 16;
pub(crate) const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentBatchItemInput {
    attachment_id: String,
    original_filename: String,
    declared_mime_type: String,
    expected_size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentBatchBeginRequest {
    operation_id: String,
    created_at: String,
    items: Vec<AttachmentBatchItemInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentNativePathItem {
    attachment_id: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentNativeImportRequest {
    operation_id: String,
    created_at: String,
    items: Vec<AttachmentNativePathItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentMetadata {
    pub attachment_id: String,
    pub sha256: String,
    pub size: u64,
    pub original_filename: String,
    pub mime_type: String,
    pub created_at: String,
    pub available: bool,
    pub previewable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentBatchResponse {
    operation_id: String,
    deduplicated: bool,
    attachments: Vec<AttachmentMetadata>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentBatchBeginResponse {
    operation_id: String,
    state: String,
    deduplicated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentChunkResponse {
    operation_id: String,
    attachment_id: String,
    staged_size: u64,
    complete: bool,
    deduplicated: bool,
}

#[derive(Clone, Debug)]
struct OperationItem {
    attachment_id: String,
    ordinal: usize,
    expected_size: u64,
    staged_size: u64,
    original_filename: String,
    declared_mime_type: String,
}

#[derive(Clone, Debug)]
struct PreparedItem {
    input: OperationItem,
    sha256: String,
    mime_type: String,
}

#[derive(Clone, Debug)]
struct ExistingOperation {
    fingerprint: String,
    state: String,
    response_json: Option<String>,
}

pub(crate) fn recover_attachment_operations(
    store: &mut ProductStore,
) -> Result<(), PersistenceError> {
    let operations = {
        let mut statement = store.connection.prepare(
            "SELECT operation_id, state FROM attachment_operations ORDER BY created_at, operation_id",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (operation_id, state) in operations {
        match state.as_str() {
            "completed" | "cancelled" => {
                let staging = staging_directory(&store.root, &operation_id);
                if staging.exists() {
                    fs::remove_dir_all(staging)?;
                }
            }
            "started" => {
                let incomplete: i64 = store.connection.query_row(
                    "SELECT COUNT(*) FROM attachment_operation_items
                     WHERE operation_id = ?1 AND staged_size != expected_size",
                    [&operation_id],
                    |row| row.get(0),
                )?;
                if incomplete == 0 {
                    attachment_batch_commit_store(store, &operation_id)?;
                } else {
                    attachment_batch_cancel_store(store, &operation_id)?;
                }
            }
            "staged" | "cas_committed" => {
                attachment_batch_commit_store(store, &operation_id)?;
            }
            _ => {
                return Err(PersistenceError::InvalidInput(format!(
                    "unknown attachment operation state: {state}"
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn attachment_batch_begin_store(
    store: &mut ProductStore,
    request: &AttachmentBatchBeginRequest,
) -> Result<AttachmentBatchBeginResponse, PersistenceError> {
    validate_batch_request(request)?;
    let fingerprint = batch_fingerprint(request);
    if let Some(existing) = existing_operation(&store.connection, &request.operation_id)? {
        if existing.fingerprint != fingerprint {
            return Err(PersistenceError::DuplicateOperationMismatch);
        }
        if existing.state == "cancelled" {
            return Err(PersistenceError::InvalidInput(
                "attachment operation was cancelled".to_owned(),
            ));
        }
        // A completed operation has already removed staging. Retrying the
        // original begin request must still be idempotent and proceed to the
        // stored commit response without recreating writable input files.
        if existing.state != "completed" {
            ensure_existing_staging(store, request)?;
        }
        return Ok(AttachmentBatchBeginResponse {
            operation_id: request.operation_id.clone(),
            state: existing.state,
            deduplicated: true,
        });
    }

    let staging = staging_directory(&store.root, &request.operation_id);
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    for item in &request.items {
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(staging_file(
                &store.root,
                &request.operation_id,
                &item.attachment_id,
            ))?
            .sync_all()?;
    }
    sync_directory(&staging)?;

    let request_json = serde_json::to_string(request)?;
    let transaction = store.connection.transaction()?;
    transaction.execute(
        "INSERT INTO attachment_operations (
            operation_id, fingerprint, state, request_json,
            response_json, created_at, updated_at
         ) VALUES (?1, ?2, 'started', ?3, NULL, ?4, ?4)",
        params![
            request.operation_id,
            fingerprint,
            request_json,
            request.created_at
        ],
    )?;
    for (ordinal, item) in request.items.iter().enumerate() {
        transaction.execute(
            "INSERT INTO attachment_operation_items (
                operation_id, attachment_id, ordinal, expected_size,
                staged_size, original_filename, declared_mime_type
             ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
            params![
                request.operation_id,
                item.attachment_id,
                ordinal as i64,
                item.expected_size as i64,
                item.original_filename,
                item.declared_mime_type
            ],
        )?;
    }
    transaction.commit()?;
    Ok(AttachmentBatchBeginResponse {
        operation_id: request.operation_id.clone(),
        state: "started".to_owned(),
        deduplicated: false,
    })
}

fn ensure_existing_staging(
    store: &ProductStore,
    request: &AttachmentBatchBeginRequest,
) -> Result<(), PersistenceError> {
    let items = load_operation_items(&store.connection, &request.operation_id)?;
    let directory = staging_directory(&store.root, &request.operation_id);
    fs::create_dir_all(&directory)?;
    for item in items {
        let path = staging_file(&store.root, &request.operation_id, &item.attachment_id);
        if path.exists() {
            if fs::metadata(&path)?.len() != item.staged_size {
                return Err(PersistenceError::InvalidInput(format!(
                    "staged attachment size changed for {}",
                    item.attachment_id
                )));
            }
        } else if item.staged_size == 0 {
            File::create(path)?.sync_all()?;
        } else {
            return Err(PersistenceError::InvalidInput(format!(
                "staged attachment is missing for {}",
                item.attachment_id
            )));
        }
    }
    Ok(())
}

fn write_chunk_store(
    store: &mut ProductStore,
    operation_id: &str,
    attachment_id: &str,
    offset: u64,
    bytes: &[u8],
) -> Result<AttachmentChunkResponse, PersistenceError> {
    validate_uuid_v7(operation_id, "operation_id")?;
    validate_uuid_v7(attachment_id, "attachment_id")?;
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment chunk exceeds {MAX_CHUNK_BYTES} bytes"
        )));
    }
    let existing = existing_operation(&store.connection, operation_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment operation".to_owned()))?;
    if existing.state == "completed" {
        let item = load_operation_item(&store.connection, operation_id, attachment_id)?;
        let next_size = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| PersistenceError::InvalidInput("chunk offset overflow".to_owned()))?;
        if next_size > item.expected_size {
            return Err(PersistenceError::InvalidInput(
                "attachment chunk exceeds declared size".to_owned(),
            ));
        }
        let metadata = query_attachment_metadata(&store.connection, &store.root, attachment_id)?
            .ok_or_else(|| {
                PersistenceError::InvalidInput(
                    "completed attachment operation has no metadata".to_owned(),
                )
            })?;
        let mut file = File::open(cas_path(&store.root, &metadata.sha256)?)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut existing_bytes = vec![0; bytes.len()];
        file.read_exact(&mut existing_bytes)?;
        if existing_bytes != bytes {
            return Err(PersistenceError::DuplicateOperationMismatch);
        }
        return Ok(AttachmentChunkResponse {
            operation_id: operation_id.to_owned(),
            attachment_id: attachment_id.to_owned(),
            staged_size: item.expected_size,
            complete: true,
            deduplicated: true,
        });
    }
    if existing.state == "cancelled" {
        return Err(PersistenceError::InvalidInput(
            "attachment operation was cancelled".to_owned(),
        ));
    }
    let item = load_operation_item(&store.connection, operation_id, attachment_id)?;
    let path = staging_file(&store.root, operation_id, attachment_id);
    let mut file = OpenOptions::new().read(true).write(true).open(&path)?;
    let current_size = file.metadata()?.len();
    let next_size = offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| PersistenceError::InvalidInput("chunk offset overflow".to_owned()))?;
    if next_size > item.expected_size {
        return Err(PersistenceError::InvalidInput(
            "attachment chunk exceeds declared size".to_owned(),
        ));
    }

    let deduplicated = if offset == current_size {
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        file.sync_data()?;
        false
    } else if next_size <= current_size {
        let mut existing_bytes = vec![0; bytes.len()];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut existing_bytes)?;
        if existing_bytes != bytes {
            return Err(PersistenceError::DuplicateOperationMismatch);
        }
        true
    } else {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment chunk offset {offset} does not match staged size {current_size}"
        )));
    };
    let staged_size = current_size.max(next_size);
    store.connection.execute(
        "UPDATE attachment_operation_items
         SET staged_size = ?3
         WHERE operation_id = ?1 AND attachment_id = ?2",
        params![operation_id, attachment_id, staged_size as i64],
    )?;
    let incomplete_count: i64 = store.connection.query_row(
        "SELECT COUNT(*) FROM attachment_operation_items
         WHERE operation_id = ?1 AND staged_size != expected_size",
        [operation_id],
        |row| row.get(0),
    )?;
    if incomplete_count == 0 {
        store.connection.execute(
            "UPDATE attachment_operations SET state = 'staged'
             WHERE operation_id = ?1 AND state IN ('started', 'staged')",
            [operation_id],
        )?;
    }
    Ok(AttachmentChunkResponse {
        operation_id: operation_id.to_owned(),
        attachment_id: attachment_id.to_owned(),
        staged_size,
        complete: staged_size == item.expected_size,
        deduplicated,
    })
}

pub(crate) fn attachment_batch_commit_store(
    store: &mut ProductStore,
    operation_id: &str,
) -> Result<AttachmentBatchResponse, PersistenceError> {
    validate_uuid_v7(operation_id, "operation_id")?;
    let existing = existing_operation(&store.connection, operation_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment operation".to_owned()))?;
    if existing.state == "completed" {
        let response_json = existing.response_json.ok_or_else(|| {
            PersistenceError::InvalidInput(
                "completed attachment operation has no response".to_owned(),
            )
        })?;
        let mut response: AttachmentBatchResponse = serde_json::from_str(&response_json)?;
        for attachment in &response.attachments {
            verify_cas_object(
                &cas_path(&store.root, &attachment.sha256)?,
                &attachment.sha256,
                attachment.size,
            )?;
        }
        response.deduplicated = true;
        return Ok(response);
    }
    if existing.state == "cancelled" {
        return Err(PersistenceError::InvalidInput(
            "attachment operation was cancelled".to_owned(),
        ));
    }

    let items = load_operation_items(&store.connection, operation_id)?;
    if items
        .iter()
        .any(|item| item.staged_size != item.expected_size)
    {
        return Err(PersistenceError::InvalidInput(
            "attachment batch is not fully staged".to_owned(),
        ));
    }
    let request: AttachmentBatchBeginRequest = serde_json::from_str(&store.connection.query_row(
        "SELECT request_json FROM attachment_operations WHERE operation_id = ?1",
        [operation_id],
        |row| row.get::<_, String>(0),
    )?)?;
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        let staging = staging_file(&store.root, operation_id, &item.attachment_id);
        let (sha256, prefix) = hash_file(&staging)?;
        if fs::metadata(&staging)?.len() != item.expected_size {
            return Err(PersistenceError::InvalidInput(format!(
                "staged attachment size mismatch for {}",
                item.attachment_id
            )));
        }
        let mime_type =
            detect_mime_type(&prefix, &item.original_filename, &item.declared_mime_type);
        publish_cas_object(
            &store.root,
            operation_id,
            &item.attachment_id,
            &staging,
            &sha256,
            item.expected_size,
        )?;
        prepared.push(PreparedItem {
            input: item,
            sha256,
            mime_type,
        });
    }

    store.connection.execute(
        "UPDATE attachment_operations SET state = 'cas_committed', updated_at = ?2
         WHERE operation_id = ?1",
        params![operation_id, request.created_at],
    )?;

    let root = store.root.clone();
    let transaction = store.connection.transaction()?;
    let mut metadata = Vec::with_capacity(prepared.len());
    for prepared_item in &prepared {
        let item = &prepared_item.input;
        transaction.execute(
            "INSERT INTO attachment_objects (sha256, size, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(sha256) DO NOTHING",
            params![
                prepared_item.sha256,
                item.expected_size as i64,
                request.created_at
            ],
        )?;
        let stored_object_size: i64 = transaction.query_row(
            "SELECT size FROM attachment_objects WHERE sha256 = ?1",
            [&prepared_item.sha256],
            |row| row.get(0),
        )?;
        if stored_object_size != item.expected_size as i64 {
            return Err(PersistenceError::InvalidInput(
                "CAS object metadata size mismatch".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO attachments (
                attachment_id, sha256, size, original_filename, mime_type, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(attachment_id) DO NOTHING",
            params![
                item.attachment_id,
                prepared_item.sha256,
                item.expected_size as i64,
                item.original_filename,
                prepared_item.mime_type,
                request.created_at
            ],
        )?;
        let stored = query_attachment_metadata(&transaction, &root, &item.attachment_id)?
            .ok_or_else(|| {
                PersistenceError::InvalidInput("attachment metadata was not committed".to_owned())
            })?;
        if stored.sha256 != prepared_item.sha256
            || stored.size != item.expected_size
            || stored.original_filename != item.original_filename
            || stored.mime_type != prepared_item.mime_type
        {
            return Err(PersistenceError::DuplicateOperationMismatch);
        }
        transaction.execute(
            "UPDATE attachment_operation_items
             SET sha256 = ?3, detected_mime_type = ?4
             WHERE operation_id = ?1 AND attachment_id = ?2",
            params![
                operation_id,
                item.attachment_id,
                prepared_item.sha256,
                prepared_item.mime_type
            ],
        )?;
        metadata.push(stored);
    }
    metadata.sort_by_key(|entry| {
        prepared
            .iter()
            .find(|item| item.input.attachment_id == entry.attachment_id)
            .map(|item| item.input.ordinal)
            .unwrap_or(usize::MAX)
    });
    let response = AttachmentBatchResponse {
        operation_id: operation_id.to_owned(),
        deduplicated: false,
        attachments: metadata,
    };
    transaction.execute(
        "UPDATE attachment_operations
         SET state = 'completed', response_json = ?2, updated_at = ?3
         WHERE operation_id = ?1",
        params![
            operation_id,
            serde_json::to_string(&response)?,
            request.created_at
        ],
    )?;
    transaction.commit()?;
    let staging = staging_directory(&store.root, operation_id);
    if staging.exists() {
        let _ = fs::remove_dir_all(staging);
    }
    Ok(response)
}

pub(crate) fn attachment_batch_cancel_store(
    store: &mut ProductStore,
    operation_id: &str,
) -> Result<(), PersistenceError> {
    validate_uuid_v7(operation_id, "operation_id")?;
    let existing = existing_operation(&store.connection, operation_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment operation".to_owned()))?;
    if existing.state == "completed" {
        return Err(PersistenceError::InvalidInput(
            "completed attachment operation cannot be cancelled".to_owned(),
        ));
    }
    store.connection.execute(
        "UPDATE attachment_operations SET state = 'cancelled' WHERE operation_id = ?1",
        [operation_id],
    )?;
    let staging = staging_directory(&store.root, operation_id);
    if staging.exists() {
        fs::remove_dir_all(staging)?;
    }
    Ok(())
}

fn import_native_paths_store(
    store: &mut ProductStore,
    request: &AttachmentNativeImportRequest,
) -> Result<AttachmentBatchResponse, PersistenceError> {
    if request.items.is_empty() || request.items.len() > MAX_BATCH_FILES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment batch must contain 1..={MAX_BATCH_FILES} files"
        )));
    }
    let mut inputs = Vec::with_capacity(request.items.len());
    let mut total = 0_u64;
    for item in &request.items {
        validate_uuid_v7(&item.attachment_id, "attachment_id")?;
        if item.path.contains("\0") || item.path.contains("://") {
            return Err(PersistenceError::InvalidInput(
                "remote attachment URI is not supported".to_owned(),
            ));
        }
        let path = Path::new(&item.path);
        if !path.is_absolute() {
            return Err(PersistenceError::InvalidInput(
                "native attachment path must be absolute".to_owned(),
            ));
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(PersistenceError::InvalidInput(
                "attachment path must be a regular non-symlink file".to_owned(),
            ));
        }
        let size = metadata.len();
        validate_file_size(size)?;
        total = total
            .checked_add(size)
            .ok_or_else(|| PersistenceError::InvalidInput("batch size overflow".to_owned()))?;
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                PersistenceError::InvalidInput("attachment filename must be valid UTF-8".to_owned())
            })?
            .to_owned();
        validate_filename(&filename)?;
        inputs.push(AttachmentBatchItemInput {
            attachment_id: item.attachment_id.clone(),
            original_filename: filename,
            declared_mime_type: String::new(),
            expected_size: size,
        });
    }
    if total > MAX_BATCH_BYTES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment batch exceeds {MAX_BATCH_BYTES} bytes"
        )));
    }
    let begin = AttachmentBatchBeginRequest {
        operation_id: request.operation_id.clone(),
        created_at: request.created_at.clone(),
        items: inputs,
    };
    let begin_response = attachment_batch_begin_store(store, &begin)?;
    if begin_response.state == "completed" {
        return attachment_batch_commit_store(store, &request.operation_id);
    }
    for item in &request.items {
        let destination = staging_file(&store.root, &request.operation_id, &item.attachment_id);
        let current = fs::metadata(&destination)?.len();
        if current == 0 {
            let mut source = File::open(&item.path)?;
            let mut target = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&destination)?;
            std::io::copy(&mut source, &mut target)?;
            target.sync_all()?;
        }
        let staged_size = fs::metadata(&destination)?.len();
        let expected = load_operation_item(
            &store.connection,
            &request.operation_id,
            &item.attachment_id,
        )?
        .expected_size;
        if staged_size != expected {
            return Err(PersistenceError::InvalidInput(format!(
                "native attachment changed while importing: {}",
                item.path
            )));
        }
        store.connection.execute(
            "UPDATE attachment_operation_items SET staged_size = expected_size
             WHERE operation_id = ?1 AND attachment_id = ?2",
            params![request.operation_id, item.attachment_id],
        )?;
    }
    store.connection.execute(
        "UPDATE attachment_operations SET state = 'staged' WHERE operation_id = ?1",
        [&request.operation_id],
    )?;
    attachment_batch_commit_store(store, &request.operation_id)
}

fn resolve_attachments_store(
    store: &mut ProductStore,
    attachment_ids: &[String],
) -> Result<Vec<AttachmentMetadata>, PersistenceError> {
    let mut result = Vec::with_capacity(attachment_ids.len());
    for attachment_id in attachment_ids {
        validate_uuid_v7(attachment_id, "attachment_id")?;
        if let Some(metadata) =
            query_attachment_metadata(&store.connection, &store.root, attachment_id)?
        {
            result.push(metadata);
        }
    }
    Ok(result)
}

fn materialize_attachment(
    store: &mut ProductStore,
    attachment_id: &str,
) -> Result<(AttachmentMetadata, PathBuf), PersistenceError> {
    validate_uuid_v7(attachment_id, "attachment_id")?;
    let metadata = query_attachment_metadata(&store.connection, &store.root, attachment_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment".to_owned()))?;
    let source = cas_path(&store.root, &metadata.sha256)?;
    verify_cas_object(&source, &metadata.sha256, metadata.size)?;
    let directory = store
        .root
        .join("attachments")
        .join("materialized")
        .join(attachment_id);
    fs::create_dir_all(&directory)?;
    let target = directory.join(&metadata.original_filename);
    let copy_required = match fs::symlink_metadata(&target) {
        Ok(target_metadata) if target_metadata.file_type().is_symlink() => {
            fs::remove_file(&target)?;
            true
        }
        Ok(target_metadata) if target_metadata.is_file() => {
            if verify_cas_object(&target, &metadata.sha256, metadata.size).is_ok() {
                false
            } else {
                fs::remove_file(&target)?;
                true
            }
        }
        Ok(_) => {
            return Err(PersistenceError::InvalidInput(
                "materialized attachment target is not a regular file".to_owned(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    if copy_required {
        fs::copy(&source, &target)?;
        sync_file(&target)?;
    }
    sync_directory(&directory)?;
    Ok((metadata, target))
}

fn is_dangerous_to_open(metadata: &AttachmentMetadata, prefix: &[u8]) -> bool {
    let mime = metadata.mime_type.to_ascii_lowercase();
    let extension = Path::new(&metadata.original_filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let dangerous_extension = matches!(
        extension.as_str(),
        "exe"
            | "com"
            | "bat"
            | "cmd"
            | "ps1"
            | "msi"
            | "scr"
            | "js"
            | "mjs"
            | "cjs"
            | "vbs"
            | "vbe"
            | "wsf"
            | "wsh"
            | "hta"
            | "reg"
            | "jar"
            | "py"
            | "pyw"
            | "pl"
            | "rb"
            | "php"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "desktop"
            | "lnk"
            | "url"
            | "webloc"
            | "app"
            | "command"
            | "html"
            | "htm"
            | "xhtml"
            | "svg"
            | "svgz"
    );
    dangerous_extension
        || matches!(
            mime.as_str(),
            "text/html"
                | "application/xhtml+xml"
                | "image/svg+xml"
                | "application/x-msdownload"
                | "application/vnd.microsoft.portable-executable"
                | "application/x-msdos-program"
                | "application/x-executable"
                | "application/x-pie-executable"
                | "application/x-sharedlib"
                | "application/x-shellscript"
                | "text/x-shellscript"
                | "application/javascript"
                | "text/javascript"
                | "application/ecmascript"
                | "text/ecmascript"
                | "application/x-ms-shortcut"
                | "application/java-archive"
        )
        || prefix.starts_with(b"MZ")
        || prefix.starts_with(b"\x7fELF")
        || matches!(prefix.get(..4), Some([0xfe, 0xed, 0xfa, 0xce]))
        || matches!(prefix.get(..4), Some([0xfe, 0xed, 0xfa, 0xcf]))
        || matches!(prefix.get(..4), Some([0xcf, 0xfa, 0xed, 0xfe]))
        || matches!(prefix.get(..4), Some([0xca, 0xfe, 0xba, 0xbe]))
        || prefix.starts_with(b"#!")
}

fn protocol_response_store(
    store: &mut ProductStore,
    attachment_id: &str,
) -> Result<(String, Vec<u8>), PersistenceError> {
    validate_uuid_v7(attachment_id, "attachment_id")?;
    let metadata = query_attachment_metadata(&store.connection, &store.root, attachment_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment".to_owned()))?;
    if !is_previewable_mime(&metadata.mime_type) {
        return Err(PersistenceError::InvalidInput(
            "attachment is not a safe inline image".to_owned(),
        ));
    }
    let path = cas_path(&store.root, &metadata.sha256)?;
    verify_cas_object(&path, &metadata.sha256, metadata.size)?;
    Ok((metadata.mime_type, fs::read(path)?))
}

#[tauri::command]
pub(crate) fn attachment_batch_begin(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: AttachmentBatchBeginRequest,
) -> Result<AttachmentBatchBeginResponse, String> {
    state
        .with_store(&app, |store| attachment_batch_begin_store(store, &request))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_batch_write_chunk(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: Request<'_>,
) -> Result<AttachmentChunkResponse, String> {
    let operation_id = request_header(&request, "x-memoka-operation-id")?;
    let attachment_id = request_header(&request, "x-memoka-attachment-id")?;
    let offset = request_header(&request, "x-memoka-chunk-offset")?
        .parse::<u64>()
        .map_err(|error| format!("invalid attachment chunk offset: {error}"))?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("attachment chunks require a raw IPC body".to_owned()),
    };
    state
        .with_store(&app, |store| {
            write_chunk_store(store, &operation_id, &attachment_id, offset, bytes)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_batch_commit(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    operation_id: String,
) -> Result<AttachmentBatchResponse, String> {
    state
        .with_store(&app, |store| {
            attachment_batch_commit_store(store, &operation_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_batch_cancel(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    operation_id: String,
) -> Result<(), String> {
    state
        .with_store(&app, |store| {
            attachment_batch_cancel_store(store, &operation_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_import_native_paths(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: AttachmentNativeImportRequest,
) -> Result<AttachmentBatchResponse, String> {
    state
        .with_store(&app, |store| import_native_paths_store(store, &request))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_resolve(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    attachment_ids: Vec<String>,
) -> Result<Vec<AttachmentMetadata>, String> {
    state
        .with_store(&app, |store| {
            resolve_attachments_store(store, &attachment_ids)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn attachment_open(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    attachment_id: String,
) -> Result<(), String> {
    let path = state
        .with_store(&app, |store| {
            validate_uuid_v7(&attachment_id, "attachment_id")?;
            let metadata = query_attachment_metadata(
                &store.connection,
                &store.root,
                &attachment_id,
            )?
            .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment".to_owned()))?;
            let source = cas_path(&store.root, &metadata.sha256)?;
            verify_cas_object(&source, &metadata.sha256, metadata.size)?;
            let mut prefix = vec![0_u8; 512];
            let mut file = File::open(&source)?;
            let length = file.read(&mut prefix)?;
            prefix.truncate(length);
            if is_dangerous_to_open(&metadata, &prefix) {
                return Err(PersistenceError::InvalidInput(
                    "dangerous executable, script, shortcut, HTML, or SVG attachment cannot be opened"
                        .to_owned(),
                ));
            }
            materialize_attachment(store, &attachment_id).map(|(_, path)| path)
        })
        .map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn attachment_copy_files(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    attachment_ids: Vec<String>,
    formats: crate::clipboard::RichClipboardFormats,
) -> Result<(), String> {
    if attachment_ids.is_empty() || attachment_ids.len() > MAX_BATCH_FILES {
        return Err(format!(
            "file Clipboard requires 1..={MAX_BATCH_FILES} attachments"
        ));
    }
    let paths = state
        .with_store(&app, |store| {
            attachment_ids
                .iter()
                .map(|attachment_id| {
                    materialize_attachment(store, attachment_id)
                        .map(|(_, path)| path.to_string_lossy().into_owned())
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    crate::clipboard::write_rich_file_paths(app, paths, formats).await
}

pub(crate) fn attachment_protocol_response(
    app: &AppHandle,
    request_path: &str,
) -> Response<Vec<u8>> {
    let attachment_id = request_path.trim_start_matches('/');
    let result = app
        .state::<ProductPersistenceState>()
        .with_store(app, |store| protocol_response_store(store, attachment_id));
    match result {
        Ok((mime_type, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime_type)
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "default-src 'none'")
            .header("cache-control", "private, max-age=31536000, immutable")
            .body(bytes)
            .expect("valid attachment protocol response"),
        Err(error) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "text/plain; charset=utf-8")
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "default-src 'none'")
            .body(error.to_string().into_bytes())
            .expect("valid attachment protocol error response"),
    }
}

fn request_header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing raw IPC header: {name}"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|error| format!("invalid raw IPC header {name}: {error}"))
}

fn validate_batch_request(request: &AttachmentBatchBeginRequest) -> Result<(), PersistenceError> {
    validate_uuid_v7(&request.operation_id, "operation_id")?;
    if request.created_at.is_empty() || request.created_at.len() > 64 {
        return Err(PersistenceError::InvalidInput(
            "created_at must be a non-empty timestamp".to_owned(),
        ));
    }
    if request.items.is_empty() || request.items.len() > MAX_BATCH_FILES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment batch must contain 1..={MAX_BATCH_FILES} files"
        )));
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0_u64;
    for item in &request.items {
        validate_uuid_v7(&item.attachment_id, "attachment_id")?;
        if !ids.insert(&item.attachment_id) {
            return Err(PersistenceError::InvalidInput(
                "attachment batch contains duplicate IDs".to_owned(),
            ));
        }
        validate_filename(&item.original_filename)?;
        validate_mime_hint(&item.declared_mime_type)?;
        validate_file_size(item.expected_size)?;
        total = total
            .checked_add(item.expected_size)
            .ok_or_else(|| PersistenceError::InvalidInput("batch size overflow".to_owned()))?;
    }
    if total > MAX_BATCH_BYTES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment batch exceeds {MAX_BATCH_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_file_size(size: u64) -> Result<(), PersistenceError> {
    if size > MAX_ATTACHMENT_BYTES {
        return Err(PersistenceError::InvalidInput(format!(
            "attachment exceeds {MAX_ATTACHMENT_BYTES} bytes"
        )));
    }
    Ok(())
}

pub(crate) fn validate_filename(filename: &str) -> Result<(), PersistenceError> {
    if filename.is_empty()
        || filename.len() > 255
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.chars().any(char::is_control)
    {
        return Err(PersistenceError::InvalidInput(
            "attachment filename is unsafe".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_mime_hint(mime: &str) -> Result<(), PersistenceError> {
    if mime.len() > 127 || mime.chars().any(char::is_control) {
        return Err(PersistenceError::InvalidInput(
            "attachment MIME hint is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_uuid_v7(value: &str, label: &str) -> Result<(), PersistenceError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || matches!(byte, b'a'..=b'f')
        });
    if !valid {
        return Err(PersistenceError::InvalidInput(format!(
            "{label} must be a lowercase UUIDv7"
        )));
    }
    Ok(())
}

fn batch_fingerprint(request: &AttachmentBatchBeginRequest) -> String {
    let bytes = serde_json::to_vec(request).expect("attachment request serialization cannot fail");
    hex_digest(Sha256::digest(bytes).as_slice())
}

fn existing_operation(
    connection: &rusqlite::Connection,
    operation_id: &str,
) -> Result<Option<ExistingOperation>, PersistenceError> {
    connection
        .query_row(
            "SELECT fingerprint, state, response_json
             FROM attachment_operations WHERE operation_id = ?1",
            [operation_id],
            |row| {
                Ok(ExistingOperation {
                    fingerprint: row.get(0)?,
                    state: row.get(1)?,
                    response_json: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn load_operation_items(
    connection: &rusqlite::Connection,
    operation_id: &str,
) -> Result<Vec<OperationItem>, PersistenceError> {
    let mut statement = connection.prepare(
        "SELECT attachment_id, ordinal, expected_size, staged_size,
                original_filename, declared_mime_type
         FROM attachment_operation_items
         WHERE operation_id = ?1 ORDER BY ordinal",
    )?;
    statement
        .query_map([operation_id], |row| {
            Ok(OperationItem {
                attachment_id: row.get(0)?,
                ordinal: row.get::<_, i64>(1)? as usize,
                expected_size: row.get::<_, i64>(2)? as u64,
                staged_size: row.get::<_, i64>(3)? as u64,
                original_filename: row.get(4)?,
                declared_mime_type: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn load_operation_item(
    connection: &rusqlite::Connection,
    operation_id: &str,
    attachment_id: &str,
) -> Result<OperationItem, PersistenceError> {
    connection
        .query_row(
            "SELECT attachment_id, ordinal, expected_size, staged_size,
                    original_filename, declared_mime_type
             FROM attachment_operation_items
             WHERE operation_id = ?1 AND attachment_id = ?2",
            params![operation_id, attachment_id],
            |row| {
                Ok(OperationItem {
                    attachment_id: row.get(0)?,
                    ordinal: row.get::<_, i64>(1)? as usize,
                    expected_size: row.get::<_, i64>(2)? as u64,
                    staged_size: row.get::<_, i64>(3)? as u64,
                    original_filename: row.get(4)?,
                    declared_mime_type: row.get(5)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment item".to_owned()))
}

fn query_attachment_metadata(
    connection: &rusqlite::Connection,
    root: &Path,
    attachment_id: &str,
) -> Result<Option<AttachmentMetadata>, PersistenceError> {
    let row = connection
        .query_row(
            "SELECT attachment_id, sha256, size, original_filename, mime_type, created_at
             FROM attachments WHERE attachment_id = ?1",
            [attachment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((attachment_id, sha256, size, original_filename, mime_type, created_at)) = row else {
        return Ok(None);
    };
    validate_filename(&original_filename)?;
    validate_mime_hint(&mime_type)?;
    let size = size as u64;
    let path = cas_path(root, &sha256)?;
    let available = path
        .symlink_metadata()
        .map(|metadata| {
            !metadata.file_type().is_symlink() && metadata.is_file() && metadata.len() == size
        })
        .unwrap_or(false);
    Ok(Some(AttachmentMetadata {
        attachment_id,
        sha256,
        size,
        original_filename,
        previewable: available && is_previewable_mime(&mime_type),
        mime_type,
        created_at,
        available,
    }))
}

pub(crate) fn list_all_attachment_metadata(
    store: &mut ProductStore,
) -> Result<Vec<AttachmentMetadata>, PersistenceError> {
    let ids = {
        let mut statement = store
            .connection
            .prepare("SELECT attachment_id FROM attachments ORDER BY created_at, attachment_id")?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    ids.into_iter()
        .map(|attachment_id| {
            query_attachment_metadata(&store.connection, &store.root, &attachment_id)?
                .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment".to_owned()))
        })
        .collect()
}

pub(crate) fn resolve_attachment_cas_source(
    store: &mut ProductStore,
    attachment_id: &str,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<PathBuf, PersistenceError> {
    validate_uuid_v7(attachment_id, "attachment_id")?;
    let metadata = query_attachment_metadata(&store.connection, &store.root, attachment_id)?
        .ok_or_else(|| PersistenceError::InvalidInput("unknown attachment".to_owned()))?;
    if metadata.sha256 != expected_sha256 || metadata.size != expected_size {
        return Err(PersistenceError::InvalidInput(
            "portable mirror Attachment metadata does not match CAS".to_owned(),
        ));
    }
    cas_path(&store.root, &metadata.sha256)
}

pub(crate) fn copy_resolved_attachment_cas_to(
    source: &Path,
    expected_sha256: &str,
    expected_size: u64,
    target: &Path,
) -> Result<(), PersistenceError> {
    verify_cas_object(source, expected_sha256, expected_size)?;
    fs::copy(source, target)?;
    Ok(())
}

fn staging_directory(root: &Path, operation_id: &str) -> PathBuf {
    root.join("attachments").join("staging").join(operation_id)
}

fn staging_file(root: &Path, operation_id: &str, attachment_id: &str) -> PathBuf {
    staging_directory(root, operation_id).join(format!("{attachment_id}.part"))
}

fn cas_path(root: &Path, sha256: &str) -> Result<PathBuf, PersistenceError> {
    if sha256.len() != 64
        || !sha256
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(PersistenceError::InvalidInput(
            "invalid attachment SHA-256".to_owned(),
        ));
    }
    Ok(root
        .join("attachments")
        .join("objects")
        .join(&sha256[..2])
        .join(&sha256[2..]))
}

fn publish_cas_object(
    root: &Path,
    operation_id: &str,
    attachment_id: &str,
    staging: &Path,
    sha256: &str,
    size: u64,
) -> Result<(), PersistenceError> {
    let target = cas_path(root, sha256)?;
    let parent = target
        .parent()
        .ok_or_else(|| PersistenceError::InvalidInput("CAS path has no parent".to_owned()))?;
    fs::create_dir_all(parent)?;
    if target.exists() {
        return verify_cas_object(&target, sha256, size);
    }
    let temporary = parent.join(format!(".{operation_id}-{attachment_id}.tmp"));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    // The staging file remains writable until the operation reaches
    // `completed`. Copying here prevents a crash between CAS publication and
    // staging cleanup from leaving a writable hard link to an immutable CAS
    // object.
    fs::copy(staging, &temporary)?;
    sync_file(&temporary)?;
    match fs::rename(&temporary, &target) {
        Ok(()) => {}
        Err(error) if target.exists() => {
            let _ = fs::remove_file(&temporary);
            verify_cas_object(&target, sha256, size)?;
            if !matches!(error.kind(), std::io::ErrorKind::AlreadyExists) {
                // Another retry may have published the same verified object.
            }
        }
        Err(error) => return Err(error.into()),
    }
    sync_directory(parent)?;
    verify_cas_object(&target, sha256, size)
}

fn hash_file(path: &Path) -> Result<(String, Vec<u8>), PersistenceError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(512);
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        if prefix.len() < 512 {
            let needed = (512 - prefix.len()).min(length);
            prefix.extend_from_slice(&buffer[..needed]);
        }
        hasher.update(&buffer[..length]);
    }
    Ok((hex_digest(hasher.finalize().as_slice()), prefix))
}

fn verify_cas_object(path: &Path, sha256: &str, size: u64) -> Result<(), PersistenceError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != size {
        return Err(PersistenceError::InvalidInput(
            "existing CAS object size mismatch".to_owned(),
        ));
    }
    let (actual, _) = hash_file(path)?;
    if actual != sha256 {
        return Err(PersistenceError::InvalidInput(
            "existing CAS object hash mismatch".to_owned(),
        ));
    }
    Ok(())
}

fn detect_mime_type(prefix: &[u8], filename: &str, declared: &str) -> String {
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png".to_owned();
    }
    if prefix.starts_with(b"\xff\xd8\xff") {
        return "image/jpeg".to_owned();
    }
    if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        return "image/gif".to_owned();
    }
    if prefix.len() >= 12 && &prefix[..4] == b"RIFF" && &prefix[8..12] == b"WEBP" {
        return "image/webp".to_owned();
    }
    let declared = declared
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if declared.contains('/')
        && !is_previewable_mime(&declared)
        && declared
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'+' | b'.'))
    {
        return declared;
    }
    match Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "svg" | "svgz" => "image/svg+xml",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn is_previewable_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn uuid(seed: u8) -> String {
        format!("018f0000-0000-7000-8000-{seed:012x}")
    }

    fn begin(operation: &str, items: Vec<(&str, &str, &[u8])>) -> AttachmentBatchBeginRequest {
        AttachmentBatchBeginRequest {
            operation_id: operation.to_owned(),
            created_at: "2026-08-22T00:00:00.000Z".to_owned(),
            items: items
                .into_iter()
                .map(|(id, name, bytes)| AttachmentBatchItemInput {
                    attachment_id: id.to_owned(),
                    original_filename: name.to_owned(),
                    declared_mime_type: "application/octet-stream".to_owned(),
                    expected_size: bytes.len() as u64,
                })
                .collect(),
        }
    }

    #[test]
    fn migrates_v2_without_deleting_documents() {
        let directory = TempDir::new().unwrap();
        {
            let connection =
                rusqlite::Connection::open(directory.path().join("memoka.sqlite3")).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO settings VALUES ('database_schema_version', '2');
                     CREATE TABLE documents (
                       kind TEXT NOT NULL, document_id TEXT NOT NULL,
                       schema_version INTEGER NOT NULL, revision INTEGER NOT NULL,
                       snapshot_revision INTEGER NOT NULL, snapshot BLOB NOT NULL,
                       PRIMARY KEY(kind, document_id)
                     );
                     INSERT INTO documents VALUES ('workspace', 'keep', 2, 1, 1, X'00');",
                )
                .unwrap();
        }
        let store = ProductStore::open(directory.path()).unwrap();
        assert_eq!(store.manifest().unwrap().database_schema_version, 4);
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn commits_deduplicated_content_with_distinct_logical_ids() {
        let directory = TempDir::new().unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        let operation = uuid(1);
        let first_id = uuid(2);
        let second_id = uuid(3);
        let bytes = b"same content";
        let request = begin(
            &operation,
            vec![
                (&first_id, "one.bin", bytes),
                (&second_id, "two.bin", bytes),
            ],
        );
        attachment_batch_begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, &operation, &first_id, 0, bytes).unwrap();
        write_chunk_store(&mut store, &operation, &second_id, 0, bytes).unwrap();
        let response = attachment_batch_commit_store(&mut store, &operation).unwrap();
        assert_eq!(response.attachments.len(), 2);
        assert_eq!(
            response.attachments[0].sha256,
            response.attachments[1].sha256
        );
        assert_ne!(
            response.attachments[0].attachment_id,
            response.attachments[1].attachment_id
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM attachment_objects", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert!(
            attachment_batch_commit_store(&mut store, &operation)
                .unwrap()
                .deduplicated
        );
        let retried_begin = attachment_batch_begin_store(&mut store, &request).unwrap();
        assert_eq!(retried_begin.state, "completed");
        assert!(retried_begin.deduplicated);
        assert!(!staging_directory(&store.root, &operation).exists());
        assert!(
            write_chunk_store(&mut store, &operation, &first_id, 0, bytes)
                .unwrap()
                .deduplicated
        );
        assert!(write_chunk_store(&mut store, &operation, &first_id, 0, b"evil content").is_err());
    }

    #[test]
    fn refuses_mismatched_retry_and_corrupt_existing_cas() {
        let directory = TempDir::new().unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        let operation = uuid(4);
        let attachment = uuid(5);
        let bytes = b"payload";
        let request = begin(&operation, vec![(&attachment, "safe.txt", bytes)]);
        attachment_batch_begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, &operation, &attachment, 0, bytes).unwrap();
        assert!(write_chunk_store(&mut store, &operation, &attachment, 0, b"xxxxxxx").is_err());
        let (sha, _) = hash_file(&staging_file(&store.root, &operation, &attachment)).unwrap();
        let cas = cas_path(&store.root, &sha).unwrap();
        fs::create_dir_all(cas.parent().unwrap()).unwrap();
        fs::write(&cas, b"corrupt").unwrap();
        assert!(attachment_batch_commit_store(&mut store, &operation).is_err());
        assert_eq!(fs::read(cas).unwrap(), b"corrupt");
    }

    #[test]
    fn detects_only_raster_images_as_inline_previews() {
        assert_eq!(
            detect_mime_type(b"\x89PNG\r\n\x1a\nrest", "x.bin", ""),
            "image/png"
        );
        assert!(is_previewable_mime("image/png"));
        assert!(!is_previewable_mime("image/svg+xml"));
        assert_eq!(
            detect_mime_type(b"not a PNG", "spoofed.png", "image/png"),
            "application/octet-stream"
        );
    }

    #[test]
    fn recovers_staged_operations_and_cancels_partial_staging_on_open() {
        let directory = TempDir::new().unwrap();
        let completed_operation = uuid(6);
        let completed_attachment = uuid(7);
        let partial_operation = uuid(8);
        let partial_attachment = uuid(9);
        {
            let mut store = ProductStore::open(directory.path()).unwrap();
            let bytes = b"recover me";
            let request = begin(
                &completed_operation,
                vec![(&completed_attachment, "recover.txt", bytes)],
            );
            attachment_batch_begin_store(&mut store, &request).unwrap();
            write_chunk_store(
                &mut store,
                &completed_operation,
                &completed_attachment,
                0,
                bytes,
            )
            .unwrap();

            let partial = begin(
                &partial_operation,
                vec![(&partial_attachment, "partial.txt", b"unfinished")],
            );
            attachment_batch_begin_store(&mut store, &partial).unwrap();
            write_chunk_store(
                &mut store,
                &partial_operation,
                &partial_attachment,
                0,
                b"part",
            )
            .unwrap();
        }

        let store = ProductStore::open(directory.path()).unwrap();
        assert!(
            query_attachment_metadata(&store.connection, &store.root, &completed_attachment,)
                .unwrap()
                .unwrap()
                .available
        );
        assert_eq!(
            existing_operation(&store.connection, &partial_operation)
                .unwrap()
                .unwrap()
                .state,
            "cancelled"
        );
        assert!(!staging_directory(&store.root, &partial_operation).exists());
    }

    #[test]
    fn refuses_executable_and_active_document_attachments() {
        let base = AttachmentMetadata {
            attachment_id: uuid(10),
            sha256: "a".repeat(64),
            size: 4,
            original_filename: "safe.txt".to_owned(),
            mime_type: "text/plain".to_owned(),
            created_at: "2026-08-22T00:00:00.000Z".to_owned(),
            available: true,
            previewable: false,
        };
        assert!(!is_dangerous_to_open(&base, b"plain text"));
        assert!(is_dangerous_to_open(&base, b"#!/bin/sh"));
        assert!(is_dangerous_to_open(
            &AttachmentMetadata {
                original_filename: "page.html".to_owned(),
                ..base.clone()
            },
            b"<p>page</p>"
        ));
        assert!(is_dangerous_to_open(
            &AttachmentMetadata {
                original_filename: "vector.svg".to_owned(),
                mime_type: "image/svg+xml".to_owned(),
                ..base.clone()
            },
            b"<svg/>"
        ));
        assert!(is_dangerous_to_open(
            &AttachmentMetadata {
                original_filename: "task.js".to_owned(),
                mime_type: "text/plain".to_owned(),
                ..base.clone()
            },
            b"alert(1)"
        ));
        assert!(is_dangerous_to_open(
            &AttachmentMetadata {
                original_filename: "task.txt".to_owned(),
                mime_type: "text/javascript".to_owned(),
                ..base
            },
            b"alert(1)"
        ));
    }

    #[test]
    fn cas_publication_does_not_share_a_writable_staging_inode() {
        let directory = TempDir::new().unwrap();
        let operation = uuid(11);
        let attachment = uuid(12);
        let bytes = b"immutable while journal is pending";
        let staging = staging_file(directory.path(), &operation, &attachment);
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::write(&staging, bytes).unwrap();
        let (sha256, _) = hash_file(&staging).unwrap();

        publish_cas_object(
            directory.path(),
            &operation,
            &attachment,
            &staging,
            &sha256,
            bytes.len() as u64,
        )
        .unwrap();
        fs::write(&staging, vec![b'x'; bytes.len()]).unwrap();

        assert_eq!(
            fs::read(cas_path(directory.path(), &sha256).unwrap()).unwrap(),
            bytes
        );
    }

    #[test]
    fn retries_a_completed_native_path_import_without_recreating_staging() {
        let directory = TempDir::new().unwrap();
        let source = directory.path().join("native.txt");
        fs::write(&source, b"native retry").unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        let operation = uuid(13);
        let request = AttachmentNativeImportRequest {
            operation_id: operation.clone(),
            created_at: "2026-08-22T00:00:00.000Z".to_owned(),
            items: vec![AttachmentNativePathItem {
                attachment_id: uuid(14),
                path: source.to_string_lossy().into_owned(),
            }],
        };

        assert!(
            !import_native_paths_store(&mut store, &request)
                .unwrap()
                .deduplicated
        );
        assert!(!staging_directory(&store.root, &operation).exists());
        assert!(
            import_native_paths_store(&mut store, &request)
                .unwrap()
                .deduplicated
        );
        assert!(!staging_directory(&store.root, &operation).exists());
    }

    #[test]
    fn materialized_edits_never_modify_cas_and_are_repaired() {
        let directory = TempDir::new().unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        let operation = uuid(15);
        let attachment = uuid(16);
        let bytes = b"immutable CAS";
        let request = begin(&operation, vec![(&attachment, "note.txt", bytes)]);
        attachment_batch_begin_store(&mut store, &request).unwrap();
        write_chunk_store(&mut store, &operation, &attachment, 0, bytes).unwrap();
        let response = attachment_batch_commit_store(&mut store, &operation).unwrap();
        let cas = cas_path(&store.root, &response.attachments[0].sha256).unwrap();

        let (_, materialized) = materialize_attachment(&mut store, &attachment).unwrap();
        fs::write(&materialized, b"externally edited").unwrap();
        assert_eq!(fs::read(&cas).unwrap(), bytes);

        let (_, repaired) = materialize_attachment(&mut store, &attachment).unwrap();
        assert_eq!(repaired, materialized);
        assert_eq!(fs::read(repaired).unwrap(), bytes);
        assert_eq!(fs::read(&cas).unwrap(), bytes);

        fs::write(&cas, vec![b'x'; bytes.len()]).unwrap();
        assert!(attachment_batch_commit_store(&mut store, &operation).is_err());
    }
}
