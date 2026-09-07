use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

use crate::document_model::{ReadError, migrate_note};
use crate::namespace::{WORKSPACE_SCHEMA, migrate_workspace, read_namespace};
use crate::persistence::{PersistedDocument, PersistedUpdate, PersistenceError};

pub const DATABASE_SCHEMA: i64 = 5;

#[cfg(test)]
#[path = "workspace_migration_tests.rs"]
mod tests;

pub struct PreparedMigration {
    pub documents: Vec<(PersistedDocument, Vec<u8>)>,
    pub entry_ids: BTreeMap<String, String>,
    pub known_missing: Vec<String>,
}

pub fn load_document(
    connection: &Connection,
    kind: &str,
    id: &str,
) -> Result<PersistedDocument, ReadError> {
    let mut document = connection.query_row(
        "SELECT schema_version, revision, snapshot_revision, snapshot FROM documents WHERE kind=?1 AND document_id=?2",
        params![kind, id], |row| Ok(PersistedDocument {
            kind: kind.into(), document_id: id.into(), schema_version: row.get(0)?, revision: row.get(1)?, snapshot_revision: row.get(2)?, snapshot: row.get(3)?, updates: Vec::new(),
        })
    ).optional()?.ok_or_else(|| ReadError::new("NOT_FOUND", "Document does not exist"))?;
    let mut query = connection.prepare("SELECT revision, update_blob FROM document_updates WHERE kind=?1 AND document_id=?2 ORDER BY revision")?;
    document.updates = query
        .query_map(params![kind, id], |row| {
            Ok(PersistedUpdate {
                revision: row.get(0)?,
                update: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(document)
}

/// No file creation, PRAGMA mutation, repair, Help synchronization or backup
/// initialization is permitted until this complete pass has succeeded.
pub fn preflight(root: &Path) -> Result<Option<PreparedMigration>, ReadError> {
    let path = root.join("memoka.sqlite3");
    if !path.exists() {
        return Ok(None);
    }
    crate::read_service::plain_file(&path)?;
    // Even SQLITE_OPEN_READ_ONLY can create WAL/SHM beside its source. Under
    // the Workspace owner lease, inspect a WAL-free DB as immutable; if crash
    // recovery has left WAL data, replay a private DB+WAL copy instead. Never
    // use immutable on a source with WAL, which would hide committed edits.
    let wal = root.join("memoka.sqlite3-wal");
    let has_wal = match fs::symlink_metadata(&wal) {
        Ok(_) => crate::read_service::plain_file(&wal)?.len() > 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let temporary = if has_wal {
        Some(tempfile::tempdir()?)
    } else {
        None
    };
    let connection = if let Some(temporary) = &temporary {
        let copy = temporary.path().join("state.sqlite");
        fs::copy(&path, &copy)?;
        fs::copy(&wal, temporary.path().join("state.sqlite-wal"))?;
        Connection::open_with_flags(
            copy,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?
    } else {
        let mut uri = tauri::Url::from_file_path(fs::canonicalize(&path)?)
            .map_err(|_| ReadError::new("UNSAFE_PATH", "Invalid database path"))?;
        uri.query_pairs_mut().append_pair("immutable", "1");
        Connection::open_with_flags(
            uri.as_str(),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?
    };
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN DEFERRED")?;
    let unsafe_schema: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type IN ('trigger','view'))",
        [],
        |row| row.get(0),
    )?;
    if unsafe_schema {
        return Err(ReadError::new(
            "UNSAFE_SCHEMA",
            "Unexpected migration schema objects",
        ));
    }
    let version: String = connection.query_row(
        "SELECT value FROM settings WHERE key='database_schema_version'",
        [],
        |row| row.get(0),
    )?;
    let version = version
        .parse::<i64>()
        .map_err(|_| ReadError::new("UNSUPPORTED_SCHEMA", "Invalid database schema"))?;
    if version == DATABASE_SCHEMA {
        return Ok(None);
    }
    if !(2..=4).contains(&version) {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported database migration",
        ));
    }
    let ids = connection
        .prepare("SELECT kind, document_id FROM documents ORDER BY kind, document_id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut failures = Vec::new();
    let mut prepared = PreparedMigration {
        documents: Vec::new(),
        entry_ids: BTreeMap::new(),
        known_missing: Vec::new(),
    };
    let mut actual_notes = std::collections::BTreeSet::new();
    let mut expected_notes = std::collections::BTreeSet::new();
    let mut section_owners = BTreeMap::new();
    for (kind, id) in ids {
        let document = load_document(&connection, &kind, &id)?;
        let result = if kind == "workspace" {
            migrate_workspace(&document).and_then(|(snapshot, mapping)| {
                let migrated = PersistedDocument {
                    schema_version: WORKSPACE_SCHEMA,
                    snapshot: snapshot.clone(),
                    snapshot_revision: document.revision,
                    updates: Vec::new(),
                    ..document.clone()
                };
                let namespace = read_namespace(&migrated)?;
                expected_notes.extend(namespace.notes.keys().cloned());
                prepared.documents.push((document, snapshot));
                prepared.entry_ids.extend(mapping);
                Ok(())
            })
        } else if kind == "note" {
            actual_notes.insert(id.clone());
            crate::document_model::read_note(&document, true).and_then(|note| {
                crate::document_model::register_section_owners(&note, &mut section_owners)?;
                migrate_note(&document).map(|snapshot| {
                    if let Some(snapshot) = snapshot {
                        prepared.documents.push((document, snapshot));
                    }
                })
            })
        } else {
            Err(ReadError::new(
                "UNSUPPORTED_SCHEMA",
                "Unknown persisted document kind",
            ))
        };
        if let Err(error) = result {
            failures.push(json!({"document_id":id, "code":error.code,"details":error.details}));
        }
    }
    if actual_notes != expected_notes {
        failures.push(json!({"code":"INVALID_NAMESPACE", "message":"Workspace Note metadata and documents disagree"}));
    }
    if !failures.is_empty() {
        return Err(ReadError::new(
            "MIGRATION_PREFLIGHT_FAILED",
            "移行前検査に失敗しました。元のWorkspaceを旧版で修正してから再試行してください。",
        )
        .with_details(json!({"documents":failures})));
    }
    // Missing legacy CAS objects are a catalogued migration condition, not a
    // reason to silently omit a newly missing file from a later capture.
    let has_attachments: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='attachments')",
        [],
        |row| row.get(0),
    )?;
    if has_attachments {
        let records = connection
            .prepare("SELECT attachment_id,sha256,size FROM attachments ORDER BY attachment_id")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, hash, size) in records {
            crate::attachment::validate_uuid_v7(&id, "attachmentId")?;
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                || size < 0
            {
                return Err(ReadError::new(
                    "INVALID_DATA",
                    "Invalid legacy Attachment metadata",
                ));
            }
            let object = root
                .join("attachments/objects")
                .join(&hash[..2])
                .join(&hash[2..]);
            let mut missing = false;
            for path in [
                root.join("attachments"),
                root.join("attachments/objects"),
                root.join("attachments/objects").join(&hash[..2]),
            ] {
                match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        crate::read_service::checked_directory(&path)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        missing = true;
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            if !missing {
                match fs::symlink_metadata(&object) {
                    Ok(_) => {
                        if crate::read_service::plain_file(&object)?.len() != size as u64
                            || crate::read_service::hash_file(&object)? != hash
                        {
                            return Err(ReadError::new(
                                "ATTACHMENT_CORRUPT",
                                "Legacy Attachment content is corrupt",
                            )
                            .with_details(json!({"attachment_id":id})));
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing = true,
                    Err(error) => return Err(error.into()),
                }
            }
            if missing {
                prepared.known_missing.push(id);
            }
        }
    }
    Ok(Some(prepared))
}

pub fn migration_rollback_copy(root: &Path, source: &Connection) -> Result<(), ReadError> {
    let directory = root.join("migration-backups");
    fs::create_dir_all(&directory)?;
    crate::read_service::checked_directory(&directory)?;
    let first = directory.join("before-namespace-v5.sqlite3");
    let final_path = match fs::symlink_metadata(&first) {
        // A previous attempt may predate further edits made in the old app.
        // Keep that rollback copy, but always capture this attempt's state.
        Ok(_) => {
            crate::read_service::plain_file(&first)?;
            directory.join(format!(
                "before-namespace-v5-{}.sqlite3",
                uuid::Uuid::now_v7()
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => first,
        Err(error) => return Err(error.into()),
    };
    let staging = tempfile::NamedTempFile::new_in(&directory)?;
    let mut destination = Connection::open(staging.path())?;
    rusqlite::backup::Backup::new(source, &mut destination)?.run_to_completion(
        256,
        Duration::from_millis(1),
        None,
    )?;
    destination
        .close()
        .map_err(|(_, error)| ReadError::from(error))?;
    staging.as_file().sync_all()?;
    staging.persist_noclobber(final_path).map_err(|_| {
        ReadError::new(
            "ROLLBACK_COPY_FAILED",
            "Could not preserve the migration rollback copy",
        )
    })?;
    crate::persistence::sync_directory(&directory)?;
    Ok(())
}

pub fn apply(connection: &Connection, prepared: &PreparedMigration) -> Result<(), ReadError> {
    let transaction = connection.unchecked_transaction()?;
    let has_missing: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('attachments') WHERE name='known_missing')",
        [],
        |row| row.get(0),
    )?;
    if !has_missing {
        transaction.execute_batch("ALTER TABLE attachments ADD COLUMN known_missing INTEGER NOT NULL DEFAULT 0 CHECK(known_missing IN (0,1))")?;
    }
    for (before, snapshot) in &prepared.documents {
        let target_schema = if before.kind == "note" {
            5
        } else {
            WORKSPACE_SCHEMA
        };
        crate::persistence::backup_document_before_schema_migration(
            &transaction,
            &before.kind,
            &before.document_id,
            before.schema_version,
            target_schema,
        )?;
        let count = transaction.execute("UPDATE documents SET schema_version=?1, revision=revision+1, snapshot_revision=revision+1, snapshot=?2 WHERE kind=?3 AND document_id=?4 AND revision=?5", params![target_schema, snapshot, before.kind, before.document_id, before.revision])?;
        if count != 1 {
            return Err(ReadError::new(
                "REVISION_CONFLICT",
                "Workspace changed during migration",
            ));
        }
        transaction.execute(
            "DELETE FROM document_updates WHERE kind=?1 AND document_id=?2",
            params![before.kind, before.document_id],
        )?;
    }
    for id in &prepared.known_missing {
        transaction.execute(
            "UPDATE attachments SET known_missing=1 WHERE attachment_id=?1",
            [id],
        )?;
    }
    let states = transaction
        .prepare("SELECT window_id, state_json FROM local_window_state")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, source) in states {
        let mut state: Value = serde_json::from_str(&source)?;
        migrate_tree_state(&mut state, &prepared.entry_ids);
        transaction.execute(
            "UPDATE local_window_state SET state_json=?1 WHERE window_id=?2",
            params![serde_json::to_string(&state)?, id],
        )?;
    }
    transaction.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('namespace_migration_entry_ids',?1)",
        [serde_json::to_string(&prepared.entry_ids)?],
    )?;
    transaction.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('database_schema_version',?1)",
        [DATABASE_SCHEMA.to_string()],
    )?;
    transaction.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('content_epoch','1')",
        [],
    )?;
    transaction.execute("INSERT OR REPLACE INTO workspace_search_invalidations(kind,document_id,source_revision) SELECT kind,document_id,revision FROM documents WHERE kind='workspace'", [])?;
    transaction.commit()?;
    Ok(())
}

/// Only canonical changes advance the backup epoch. Metadata cache refreshes,
/// cursor/fold/tab state, FTS and backup bookkeeping cannot dirty history.
fn workspace_content(connection: &Connection, id: &str) -> Result<Value, ReadError> {
    let doc = load_document(connection, "workspace", id)?;
    let mut value = crate::document_model::workspace_json(&doc)?;
    if let Some(notes) = value["notes"].as_object_mut() {
        for note in notes.values_mut() {
            if let Some(note) = note.as_object_mut() {
                note.remove("title_cache");
                note.remove("updated_at");
            }
        }
    }
    Ok(value)
}
pub fn canonical_workspace_before(
    connection: &Connection,
    request: &crate::persistence::PersistenceCommitRequest,
) -> Result<Option<Value>, crate::persistence::PersistenceError> {
    if request
        .documents
        .iter()
        .any(|document| document.kind == "note")
    {
        return Ok(None);
    }
    if let Some(document) = request
        .documents
        .iter()
        .find(|document| document.kind == "workspace")
    {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE kind='workspace' AND document_id=?1)",
            [&document.document_id],
            |row| row.get(0),
        )?;
        if exists {
            return workspace_content(connection, &document.document_id)
                .map(Some)
                .map_err(persistence_error);
        }
    }
    Ok(None)
}
pub fn advance_content_epoch(
    connection: &Connection,
    request: &crate::persistence::PersistenceCommitRequest,
    before: Option<Value>,
) -> Result<(), crate::persistence::PersistenceError> {
    let mut changed = request.documents.iter().any(|doc| doc.kind == "note");
    if !changed {
        if let Some(document) = request.documents.iter().find(|doc| doc.kind == "workspace") {
            changed = before.as_ref()
                != Some(
                    &workspace_content(connection, &document.document_id)
                        .map_err(persistence_error)?,
                );
        }
    }
    if changed {
        bump_content_epoch(connection)?;
    }
    Ok(())
}
pub fn bump_content_epoch(
    connection: &Connection,
) -> Result<(), crate::persistence::PersistenceError> {
    connection.execute("INSERT INTO settings(key,value) VALUES('content_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)",[])?;
    Ok(())
}

fn migrate_tree_state(state: &mut Value, ids: &BTreeMap<String, String>) {
    match state {
        Value::Object(object) => {
            if let Some(Value::Object(tree)) = object.get_mut("tree") {
                if let Some(note) = tree.remove("selectedNoteId") {
                    tree.insert(
                        "selectedEntryId".into(),
                        note.as_str()
                            .and_then(|id| ids.get(id))
                            .map_or(Value::Null, |id| json!(id)),
                    );
                }
                if let Some(Value::Array(notes)) = tree.remove("collapsedNoteIds") {
                    tree.insert(
                        "collapsedEntryIds".into(),
                        json!(
                            notes
                                .iter()
                                .filter_map(|id| id.as_str().and_then(|id| ids.get(id)))
                                .collect::<Vec<_>>()
                        ),
                    );
                }
            }
            for value in object.values_mut() {
                migrate_tree_state(value, ids);
            }
        }
        Value::Array(array) => {
            for value in array {
                migrate_tree_state(value, ids);
            }
        }
        _ => {}
    }
}

pub fn persistence_error(error: ReadError) -> PersistenceError {
    PersistenceError::InvalidInput(
        serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()),
    )
}
