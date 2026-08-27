use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, State};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::search_index::{
    SearchIndexHierarchyUpdateRequest, SearchIndexQueryRequest, SearchIndexQueryResponse,
    SearchIndexRebuildRequest, SearchIndexReplaceRequest,
};

const DATABASE_SCHEMA_VERSION: i64 = 4;
const PREVIOUS_DATABASE_SCHEMA_VERSION: i64 = 3;
const LEGACY_DATABASE_SCHEMA_VERSION: i64 = 2;
const WORKSPACE_DOCUMENT_SCHEMA_VERSION: i64 = 2;
const LEGACY_NOTE_DOCUMENT_SCHEMA_VERSION: i64 = 2;
const NOTE_DOCUMENT_SCHEMA_VERSION: i64 = 3;
#[cfg(test)]
const DOCUMENT_SCHEMA_VERSION: i64 = LEGACY_NOTE_DOCUMENT_SCHEMA_VERSION;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommitFault {
    BeforeCommit,
    BeforeSqlCommit,
    AfterCommitResponse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCommitInput {
    pub kind: String,
    pub document_id: String,
    pub schema_version: i64,
    pub base_revision: i64,
    pub snapshot: Option<Vec<u8>>,
    pub update: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStateCommitInput {
    pub window_id: String,
    pub state: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceCommitRequest {
    pub operation_id: String,
    pub scope: String,
    pub documents: Vec<DocumentCommitInput>,
    #[serde(default)]
    pub local_states: Vec<LocalStateCommitInput>,
    #[serde(default)]
    pub search_index_metadata_only_note_id: Option<String>,
    pub fault: Option<CommitFault>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceCompactionRequest {
    pub operation_id: String,
    pub kind: String,
    pub document_id: String,
    pub schema_version: i64,
    pub expected_revision: i64,
    pub fault: Option<CommitFault>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRevision {
    pub kind: String,
    pub document_id: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceCommitResponse {
    pub operation_id: String,
    pub deduplicated: bool,
    pub documents: Vec<DocumentRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceManifest {
    pub database_schema_version: i64,
    pub active_workspace_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedUpdate {
    pub revision: i64,
    pub update: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDocument {
    pub kind: String,
    pub document_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub snapshot_revision: i64,
    pub snapshot: Vec<u8>,
    pub updates: Vec<PersistedUpdate>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedLocalState {
    pub window_id: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum PersistenceError {
    Io(std::io::Error),
    Database(rusqlite::Error),
    Json(serde_json::Error),
    InvalidInput(String),
    DuplicateOperationMismatch,
    RevisionConflict {
        kind: String,
        document_id: String,
        expected: i64,
        actual: i64,
    },
    UnknownDocument {
        kind: String,
        document_id: String,
    },
    Injected(CommitFault),
}

impl fmt::Display for PersistenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Database(error) => write!(formatter, "database error: {error}"),
            Self::Json(error) => write!(formatter, "JSON error: {error}"),
            Self::InvalidInput(message) => write!(formatter, "invalid input: {message}"),
            Self::DuplicateOperationMismatch => {
                write!(formatter, "operation_id was reused with different content")
            }
            Self::RevisionConflict {
                kind,
                document_id,
                expected,
                actual,
            } => write!(
                formatter,
                "revision conflict for {kind}:{document_id}: expected {expected}, actual {actual}"
            ),
            Self::UnknownDocument { kind, document_id } => {
                write!(formatter, "unknown document: {kind}:{document_id}")
            }
            Self::Injected(fault) => write!(formatter, "injected persistence fault: {fault:?}"),
        }
    }
}

impl std::error::Error for PersistenceError {}

impl From<std::io::Error> for PersistenceError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for PersistenceError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}

impl From<serde_json::Error> for PersistenceError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub struct ProductStore {
    pub(crate) connection: Connection,
    pub(crate) root: PathBuf,
}

impl ProductStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PersistenceError> {
        let root = root.as_ref();
        fs::create_dir_all(root)?;
        let connection = Connection::open(root.join("memoka.sqlite3"))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = FULL;

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS documents (
                kind TEXT NOT NULL,
                document_id TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                snapshot_revision INTEGER NOT NULL,
                snapshot BLOB NOT NULL,
                PRIMARY KEY (kind, document_id)
            );

            CREATE TABLE IF NOT EXISTS document_updates (
                kind TEXT NOT NULL,
                document_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                operation_id TEXT NOT NULL,
                update_blob BLOB NOT NULL,
                PRIMARY KEY (kind, document_id, revision),
                UNIQUE (kind, document_id, operation_id),
                FOREIGN KEY (kind, document_id)
                    REFERENCES documents(kind, document_id)
                    ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS local_window_state (
                window_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                operation_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                response_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workspace_search_invalidations (
                kind TEXT NOT NULL,
                document_id TEXT NOT NULL,
                source_revision INTEGER NOT NULL,
                PRIMARY KEY (kind, document_id)
            );

            CREATE TABLE IF NOT EXISTS document_schema_backups (
                kind TEXT NOT NULL,
                document_id TEXT NOT NULL,
                from_schema_version INTEGER NOT NULL,
                to_schema_version INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                snapshot_revision INTEGER NOT NULL,
                snapshot BLOB NOT NULL,
                PRIMARY KEY (
                    kind, document_id, from_schema_version, to_schema_version
                )
            );

            CREATE TABLE IF NOT EXISTS document_schema_backup_updates (
                kind TEXT NOT NULL,
                document_id TEXT NOT NULL,
                from_schema_version INTEGER NOT NULL,
                to_schema_version INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                operation_id TEXT NOT NULL,
                update_blob BLOB NOT NULL,
                PRIMARY KEY (
                    kind, document_id, from_schema_version,
                    to_schema_version, revision
                )
            );
            ",
        )?;
        connection.execute(
            "
            INSERT INTO settings (key, value)
            VALUES ('database_schema_version', ?1)
            ON CONFLICT(key) DO NOTHING
            ",
            [DATABASE_SCHEMA_VERSION.to_string()],
        )?;
        let stored_schema_version = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'database_schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )?
            .parse::<i64>()
            .map_err(|error| {
                PersistenceError::InvalidInput(format!("invalid database_schema_version: {error}"))
            })?;
        match stored_schema_version {
            DATABASE_SCHEMA_VERSION => {
                ensure_attachment_schema(&connection)?;
                ensure_document_schema_backup_tables(&connection)?;
            }
            PREVIOUS_DATABASE_SCHEMA_VERSION => migrate_database_v3_to_v4(&connection)?,
            LEGACY_DATABASE_SCHEMA_VERSION => {
                migrate_database_v2_to_v3(&connection)?;
                migrate_database_v3_to_v4(&connection)?;
            }
            _ => {
                return Err(PersistenceError::InvalidInput(format!(
                    "database schema {stored_schema_version} requires an unsupported migration to {DATABASE_SCHEMA_VERSION}"
                )));
            }
        }
        let mut store = Self {
            connection,
            root: root.to_path_buf(),
        };
        crate::attachment::recover_attachment_operations(&mut store)?;
        crate::portable_mirror::recover_portable_mirror_operations(&mut store)?;
        Ok(store)
    }

    pub fn manifest(&self) -> Result<PersistenceManifest, PersistenceError> {
        let database_schema_version = self
            .setting("database_schema_version")?
            .ok_or_else(|| {
                PersistenceError::InvalidInput(
                    "database_schema_version setting is missing".to_owned(),
                )
            })?
            .parse::<i64>()
            .map_err(|error| {
                PersistenceError::InvalidInput(format!("invalid database_schema_version: {error}"))
            })?;
        Ok(PersistenceManifest {
            database_schema_version,
            active_workspace_id: self.setting("active_workspace_id")?,
        })
    }

    pub fn commit(
        &mut self,
        request: &PersistenceCommitRequest,
    ) -> Result<PersistenceCommitResponse, PersistenceError> {
        validate_operation_id(&request.operation_id)?;
        validate_scope(&request.scope)?;
        let fingerprint = request_fingerprint(request);

        if let Some((stored_fingerprint, response_json)) = self
            .connection
            .query_row(
                "
                SELECT fingerprint, response_json
                FROM operations
                WHERE operation_id = ?1
                ",
                [&request.operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_fingerprint != fingerprint {
                return Err(PersistenceError::DuplicateOperationMismatch);
            }
            let mut response: PersistenceCommitResponse = serde_json::from_str(&response_json)?;
            response.deduplicated = true;
            return Ok(response);
        }

        if request.fault == Some(CommitFault::BeforeCommit) {
            return Err(PersistenceError::Injected(CommitFault::BeforeCommit));
        }

        let transaction = self.connection.transaction()?;
        let revisions = commit_documents(&transaction, request)?;
        commit_local_states(&transaction, request)?;
        advance_search_index_metadata_revision(&transaction, request, &revisions)?;
        let response = PersistenceCommitResponse {
            operation_id: request.operation_id.clone(),
            deduplicated: false,
            documents: revisions,
        };
        transaction.execute(
            "
            INSERT INTO operations (operation_id, scope, fingerprint, response_json)
            VALUES (?1, ?2, ?3, ?4)
            ",
            params![
                request.operation_id,
                request.scope,
                fingerprint,
                serde_json::to_string(&response)?
            ],
        )?;

        if request.fault == Some(CommitFault::BeforeSqlCommit) {
            return Err(PersistenceError::Injected(CommitFault::BeforeSqlCommit));
        }
        transaction.commit()?;
        if request.fault == Some(CommitFault::AfterCommitResponse) {
            return Err(PersistenceError::Injected(CommitFault::AfterCommitResponse));
        }
        Ok(response)
    }

    pub fn compact(
        &mut self,
        request: &PersistenceCompactionRequest,
    ) -> Result<PersistenceCommitResponse, PersistenceError> {
        validate_operation_id(&request.operation_id)?;
        validate_document_identity(&request.kind, &request.document_id)?;
        if !supported_document_schema(&request.kind, request.schema_version) {
            return Err(PersistenceError::InvalidInput(format!(
                "unsupported {} schema_version {}",
                request.kind, request.schema_version
            )));
        }
        if request.expected_revision < 1 {
            return Err(PersistenceError::InvalidInput(
                "expected_revision must be positive".to_owned(),
            ));
        }
        let fingerprint = compaction_request_fingerprint(request);

        if let Some((stored_fingerprint, response_json)) = self
            .connection
            .query_row(
                "
                SELECT fingerprint, response_json
                FROM operations
                WHERE operation_id = ?1
                ",
                [&request.operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_fingerprint != fingerprint {
                return Err(PersistenceError::DuplicateOperationMismatch);
            }
            let mut response: PersistenceCommitResponse = serde_json::from_str(&response_json)?;
            response.deduplicated = true;
            return Ok(response);
        }

        if request.fault == Some(CommitFault::BeforeCommit) {
            return Err(PersistenceError::Injected(CommitFault::BeforeCommit));
        }

        let transaction = self.connection.transaction()?;
        let revision = compact_document(&transaction, request)?;
        let response = PersistenceCommitResponse {
            operation_id: request.operation_id.clone(),
            deduplicated: false,
            documents: vec![DocumentRevision {
                kind: request.kind.clone(),
                document_id: request.document_id.clone(),
                revision,
            }],
        };
        transaction.execute(
            "
            INSERT INTO operations (operation_id, scope, fingerprint, response_json)
            VALUES (?1, 'note-doc', ?2, ?3)
            ",
            params![
                request.operation_id,
                fingerprint,
                serde_json::to_string(&response)?
            ],
        )?;

        if request.fault == Some(CommitFault::BeforeSqlCommit) {
            return Err(PersistenceError::Injected(CommitFault::BeforeSqlCommit));
        }
        transaction.commit()?;
        if request.fault == Some(CommitFault::AfterCommitResponse) {
            return Err(PersistenceError::Injected(CommitFault::AfterCommitResponse));
        }
        Ok(response)
    }

    pub fn load_document(
        &self,
        kind: &str,
        document_id: &str,
    ) -> Result<PersistedDocument, PersistenceError> {
        validate_document_identity(kind, document_id)?;
        let document = self
            .connection
            .query_row(
                "
                SELECT schema_version, revision, snapshot_revision, snapshot
                FROM documents
                WHERE kind = ?1 AND document_id = ?2
                ",
                params![kind, document_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| PersistenceError::UnknownDocument {
                kind: kind.to_owned(),
                document_id: document_id.to_owned(),
            })?;

        let mut statement = self.connection.prepare(
            "
            SELECT revision, update_blob
            FROM document_updates
            WHERE kind = ?1
              AND document_id = ?2
              AND revision > ?3
            ORDER BY revision
            ",
        )?;
        let updates = statement
            .query_map(params![kind, document_id, document.2], |row| {
                Ok(PersistedUpdate {
                    revision: row.get(0)?,
                    update: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PersistedDocument {
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
            schema_version: document.0,
            revision: document.1,
            snapshot_revision: document.2,
            snapshot: document.3,
            updates,
        })
    }

    pub fn load_local_states(&self) -> Result<Vec<PersistedLocalState>, PersistenceError> {
        let mut statement = self.connection.prepare(
            "
            SELECT window_id, state_json
            FROM local_window_state
            ORDER BY window_id
            ",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (window_id, state_json) = row?;
                Ok(PersistedLocalState {
                    window_id,
                    state: serde_json::from_str(&state_json)?,
                })
            })
            .collect()
    }

    pub fn rebuild_workspace_search_index(
        &mut self,
        request: &SearchIndexRebuildRequest,
    ) -> Result<(), PersistenceError> {
        crate::search_index::rebuild(&mut self.connection, request)
    }

    pub fn replace_workspace_search_index_document(
        &mut self,
        request: &SearchIndexReplaceRequest,
    ) -> Result<String, PersistenceError> {
        crate::search_index::replace_document(&mut self.connection, request).map(str::to_owned)
    }

    pub fn update_workspace_search_index_hierarchy(
        &mut self,
        request: &SearchIndexHierarchyUpdateRequest,
    ) -> Result<String, PersistenceError> {
        crate::search_index::update_hierarchy(&mut self.connection, request).map(str::to_owned)
    }

    pub fn query_workspace_search_index(
        &mut self,
        request: &SearchIndexQueryRequest,
    ) -> Result<SearchIndexQueryResponse, PersistenceError> {
        crate::search_index::query(&mut self.connection, request)
    }

    fn setting(&self, key: &str) -> Result<Option<String>, PersistenceError> {
        self.connection
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(Into::into)
    }
}

#[derive(Default)]
struct ProductPersistenceInner {
    store: Option<ProductStore>,
    data_area: Option<PathBuf>,
}

#[derive(Default)]
pub struct ProductPersistenceState {
    inner: Mutex<ProductPersistenceInner>,
}

impl ProductPersistenceState {
    pub(crate) fn with_store<T>(
        &self,
        app: &AppHandle,
        action: impl FnOnce(&mut ProductStore) -> Result<T, PersistenceError>,
    ) -> Result<T, PersistenceError> {
        let mut guard = self.inner.lock().map_err(|_| {
            PersistenceError::InvalidInput("product persistence lock is poisoned".to_owned())
        })?;
        if guard.store.is_none() {
            if let Some(path) = crate::data_area::load_selected_data_area(app)? {
                let store = crate::data_area::open_data_area(&path)?;
                guard.data_area = Some(path);
                guard.store = Some(store);
            }
        }
        let store = guard.store.as_mut().ok_or_else(|| {
            PersistenceError::InvalidInput("Workspace data area has not been selected".to_owned())
        })?;
        action(store)
    }

    pub(crate) fn activate_data_area(
        &self,
        app: &AppHandle,
        path: PathBuf,
    ) -> Result<PathBuf, PersistenceError> {
        let canonical = crate::data_area::prepare_data_area(&path)?;
        let store = crate::data_area::open_data_area(&canonical)?;
        crate::data_area::save_selected_data_area(app, &canonical)?;
        let mut guard = self.inner.lock().map_err(|_| {
            PersistenceError::InvalidInput("product persistence lock is poisoned".to_owned())
        })?;
        guard.data_area = Some(canonical.clone());
        guard.store = Some(store);
        Ok(canonical)
    }

    pub(crate) fn ensure_selected_data_area(
        &self,
        app: &AppHandle,
    ) -> Result<Option<PathBuf>, PersistenceError> {
        let mut guard = self.inner.lock().map_err(|_| {
            PersistenceError::InvalidInput("product persistence lock is poisoned".to_owned())
        })?;
        if let Some(path) = &guard.data_area {
            return Ok(Some(path.clone()));
        }
        let Some(path) = crate::data_area::load_selected_data_area(app)? else {
            return Ok(None);
        };
        let store = crate::data_area::open_data_area(&path)?;
        guard.data_area = Some(path.clone());
        guard.store = Some(store);
        Ok(Some(path))
    }
}

fn attachment_schema_sql() -> &'static str {
    "
    CREATE TABLE IF NOT EXISTS attachment_objects (
        sha256 TEXT PRIMARY KEY,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (sha256) REFERENCES attachment_objects(sha256)
    );

    CREATE INDEX IF NOT EXISTS attachments_sha256_idx
        ON attachments(sha256);

    CREATE TABLE IF NOT EXISTS attachment_operations (
        operation_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
            state IN ('started', 'staged', 'cas_committed', 'completed', 'cancelled')
        ),
        request_json TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachment_operation_items (
        operation_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
        staged_size INTEGER NOT NULL DEFAULT 0 CHECK (staged_size >= 0),
        original_filename TEXT NOT NULL,
        declared_mime_type TEXT NOT NULL,
        sha256 TEXT,
        detected_mime_type TEXT,
        PRIMARY KEY (operation_id, attachment_id),
        UNIQUE (operation_id, ordinal),
        FOREIGN KEY (operation_id)
            REFERENCES attachment_operations(operation_id)
            ON DELETE CASCADE
    );
    "
}

fn ensure_attachment_schema(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(attachment_schema_sql())?;
    Ok(())
}

fn migrate_database_v2_to_v3(connection: &Connection) -> Result<(), PersistenceError> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(attachment_schema_sql())?;
    transaction.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'database_schema_version' AND value = ?2",
        params![
            PREVIOUS_DATABASE_SCHEMA_VERSION.to_string(),
            LEGACY_DATABASE_SCHEMA_VERSION.to_string()
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn document_schema_backup_sql() -> &'static str {
    "
    CREATE TABLE IF NOT EXISTS document_schema_backups (
        kind TEXT NOT NULL,
        document_id TEXT NOT NULL,
        from_schema_version INTEGER NOT NULL,
        to_schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_revision INTEGER NOT NULL,
        snapshot BLOB NOT NULL,
        PRIMARY KEY (
            kind, document_id, from_schema_version, to_schema_version
        )
    );
    CREATE TABLE IF NOT EXISTS document_schema_backup_updates (
        kind TEXT NOT NULL,
        document_id TEXT NOT NULL,
        from_schema_version INTEGER NOT NULL,
        to_schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        update_blob BLOB NOT NULL,
        PRIMARY KEY (
            kind, document_id, from_schema_version,
            to_schema_version, revision
        )
    );
    "
}

fn ensure_document_schema_backup_tables(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(document_schema_backup_sql())?;
    Ok(())
}

fn migrate_database_v3_to_v4(connection: &Connection) -> Result<(), PersistenceError> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(document_schema_backup_sql())?;
    transaction.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'database_schema_version' AND value = ?2",
        params![
            DATABASE_SCHEMA_VERSION.to_string(),
            PREVIOUS_DATABASE_SCHEMA_VERSION.to_string()
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn supported_document_schema(kind: &str, schema_version: i64) -> bool {
    match kind {
        "workspace" => schema_version == WORKSPACE_DOCUMENT_SCHEMA_VERSION,
        "note" => {
            schema_version == LEGACY_NOTE_DOCUMENT_SCHEMA_VERSION
                || schema_version == NOTE_DOCUMENT_SCHEMA_VERSION
        }
        _ => false,
    }
}

fn backup_document_before_schema_migration(
    transaction: &Transaction<'_>,
    kind: &str,
    document_id: &str,
    from_schema_version: i64,
    to_schema_version: i64,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "
        INSERT OR IGNORE INTO document_schema_backups (
            kind, document_id, from_schema_version, to_schema_version,
            revision, snapshot_revision, snapshot
        )
        SELECT kind, document_id, schema_version, ?4,
               revision, snapshot_revision, snapshot
        FROM documents
        WHERE kind = ?1 AND document_id = ?2 AND schema_version = ?3
        ",
        params![kind, document_id, from_schema_version, to_schema_version],
    )?;
    transaction.execute(
        "
        INSERT OR IGNORE INTO document_schema_backup_updates (
            kind, document_id, from_schema_version, to_schema_version,
            revision, operation_id, update_blob
        )
        SELECT kind, document_id, ?3, ?4,
               revision, operation_id, update_blob
        FROM document_updates
        WHERE kind = ?1 AND document_id = ?2
        ",
        params![kind, document_id, from_schema_version, to_schema_version],
    )?;
    Ok(())
}

fn commit_documents(
    transaction: &Transaction<'_>,
    request: &PersistenceCommitRequest,
) -> Result<Vec<DocumentRevision>, PersistenceError> {
    let mut documents = request.documents.iter().collect::<Vec<_>>();
    documents.sort_by(|left, right| {
        (&left.kind, &left.document_id).cmp(&(&right.kind, &right.document_id))
    });
    let mut revisions = Vec::with_capacity(documents.len());

    for document in documents {
        validate_document_identity(&document.kind, &document.document_id)?;
        if !supported_document_schema(&document.kind, document.schema_version) {
            return Err(PersistenceError::InvalidInput(format!(
                "unsupported {} schema_version {}",
                document.kind, document.schema_version
            )));
        }
        let existing = transaction
            .query_row(
                "
                SELECT schema_version, revision
                FROM documents
                WHERE kind = ?1 AND document_id = ?2
                ",
                params![document.kind, document.document_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;

        let revision = match existing {
            None => {
                if document.base_revision != 0 {
                    return Err(PersistenceError::RevisionConflict {
                        kind: document.kind.clone(),
                        document_id: document.document_id.clone(),
                        expected: document.base_revision,
                        actual: 0,
                    });
                }
                let snapshot = document.snapshot.as_ref().ok_or_else(|| {
                    PersistenceError::InvalidInput(format!(
                        "new document {}:{} requires a snapshot",
                        document.kind, document.document_id
                    ))
                })?;
                if snapshot.is_empty() || document.update.is_some() {
                    return Err(PersistenceError::InvalidInput(
                        "new document must contain one non-empty snapshot and no update".to_owned(),
                    ));
                }
                if document.kind == "workspace" {
                    register_active_workspace(transaction, &document.document_id)?;
                }
                transaction.execute(
                    "
                    INSERT INTO documents (
                        kind, document_id, schema_version, revision,
                        snapshot_revision, snapshot
                    ) VALUES (?1, ?2, ?3, 1, 1, ?4)
                    ",
                    params![
                        document.kind,
                        document.document_id,
                        document.schema_version,
                        snapshot
                    ],
                )?;
                1
            }
            Some((schema_version, revision)) => {
                let migrating_note_schema = document.kind == "note"
                    && schema_version == LEGACY_NOTE_DOCUMENT_SCHEMA_VERSION
                    && document.schema_version == NOTE_DOCUMENT_SCHEMA_VERSION;
                if schema_version != document.schema_version && !migrating_note_schema {
                    return Err(PersistenceError::InvalidInput(format!(
                        "schema_version mismatch for {}:{}",
                        document.kind, document.document_id
                    )));
                }
                if revision != document.base_revision {
                    return Err(PersistenceError::RevisionConflict {
                        kind: document.kind.clone(),
                        document_id: document.document_id.clone(),
                        expected: document.base_revision,
                        actual: revision,
                    });
                }
                match (&document.snapshot, &document.update) {
                    (None, Some(update)) if !update.is_empty() => {
                        if migrating_note_schema {
                            backup_document_before_schema_migration(
                                transaction,
                                &document.kind,
                                &document.document_id,
                                schema_version,
                                document.schema_version,
                            )?;
                        }
                        let next_revision = revision + 1;
                        transaction.execute(
                            "
                            INSERT INTO document_updates (
                                kind, document_id, revision, operation_id, update_blob
                            ) VALUES (?1, ?2, ?3, ?4, ?5)
                            ",
                            params![
                                document.kind,
                                document.document_id,
                                next_revision,
                                request.operation_id,
                                update
                            ],
                        )?;
                        transaction.execute(
                            "
                            UPDATE documents
                            SET revision = ?3, schema_version = ?4
                            WHERE kind = ?1 AND document_id = ?2
                            ",
                            params![
                                document.kind,
                                document.document_id,
                                next_revision,
                                document.schema_version
                            ],
                        )?;
                        next_revision
                    }
                    _ => {
                        return Err(PersistenceError::InvalidInput(
                            "existing document must contain exactly one non-empty update"
                                .to_owned(),
                        ));
                    }
                }
            }
        };
        if matches!(document.kind.as_str(), "workspace" | "note") {
            transaction.execute(
                "
                INSERT INTO workspace_search_invalidations (
                    kind, document_id, source_revision
                ) VALUES (?1, ?2, ?3)
                ON CONFLICT(kind, document_id) DO UPDATE SET
                    source_revision = excluded.source_revision
                ",
                params![document.kind, document.document_id, revision],
            )?;
        }
        revisions.push(DocumentRevision {
            kind: document.kind.clone(),
            document_id: document.document_id.clone(),
            revision,
        });
    }
    Ok(revisions)
}

fn advance_search_index_metadata_revision(
    transaction: &Transaction<'_>,
    request: &PersistenceCommitRequest,
    revisions: &[DocumentRevision],
) -> Result<(), PersistenceError> {
    let Some(note_id) = request.search_index_metadata_only_note_id.as_deref() else {
        return Ok(());
    };
    validate_document_identity("note", note_id)?;
    if request.scope != "workspace-structure" || request.documents.len() != 2 {
        return Err(PersistenceError::InvalidInput(
            "search index metadata-only commit requires one Workspace and one NoteDoc".to_owned(),
        ));
    }
    let workspace = request
        .documents
        .iter()
        .find(|document| document.kind == "workspace");
    let note = request
        .documents
        .iter()
        .find(|document| document.kind == "note" && document.document_id == note_id);
    let (Some(workspace), Some(_note)) = (workspace, note) else {
        return Err(PersistenceError::InvalidInput(
            "search index metadata-only commit document set is invalid".to_owned(),
        ));
    };
    let table_exists = transaction.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'workspace_search_state'
        )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !table_exists {
        return Ok(());
    }
    let next_revision = revisions
        .iter()
        .find(|revision| {
            revision.kind == "workspace" && revision.document_id == workspace.document_id
        })
        .map(|revision| revision.revision)
        .ok_or_else(|| {
            PersistenceError::InvalidInput(
                "search index metadata-only Workspace revision is missing".to_owned(),
            )
        })?;
    transaction.execute(
        "UPDATE workspace_search_state
         SET workspace_revision = ?3
         WHERE workspace_id = ?1 AND workspace_revision = ?2",
        params![
            workspace.document_id,
            workspace.base_revision,
            next_revision
        ],
    )?;
    Ok(())
}

fn compact_document(
    transaction: &Transaction<'_>,
    request: &PersistenceCompactionRequest,
) -> Result<i64, PersistenceError> {
    let (schema_version, revision, snapshot_revision, snapshot) = transaction
        .query_row(
            "
            SELECT schema_version, revision, snapshot_revision, snapshot
            FROM documents
            WHERE kind = ?1 AND document_id = ?2
            ",
            params![request.kind, request.document_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| PersistenceError::UnknownDocument {
            kind: request.kind.clone(),
            document_id: request.document_id.clone(),
        })?;
    if schema_version != request.schema_version {
        return Err(PersistenceError::InvalidInput(format!(
            "schema_version mismatch for {}:{}",
            request.kind, request.document_id
        )));
    }
    if revision != request.expected_revision {
        return Err(PersistenceError::RevisionConflict {
            kind: request.kind.clone(),
            document_id: request.document_id.clone(),
            expected: request.expected_revision,
            actual: revision,
        });
    }

    let mut statement = transaction.prepare(
        "
        SELECT update_blob
        FROM document_updates
        WHERE kind = ?1
          AND document_id = ?2
          AND revision > ?3
          AND revision <= ?4
        ORDER BY revision
        ",
    )?;
    let updates = statement
        .query_map(
            params![
                request.kind,
                request.document_id,
                snapshot_revision,
                request.expected_revision
            ],
            |row| row.get::<_, Vec<u8>>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let doc = Doc::new();
    {
        let mut crdt_transaction = doc.transact_mut();
        apply_encoded_update(&mut crdt_transaction, &snapshot, "snapshot")?;
        for update in &updates {
            apply_encoded_update(&mut crdt_transaction, update, "incremental update")?;
        }
    }
    let compacted = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    transaction.execute(
        "
        UPDATE documents
        SET snapshot_revision = ?3, snapshot = ?4
        WHERE kind = ?1 AND document_id = ?2
        ",
        params![
            request.kind,
            request.document_id,
            request.expected_revision,
            compacted
        ],
    )?;
    transaction.execute(
        "
        DELETE FROM document_updates
        WHERE kind = ?1
          AND document_id = ?2
          AND revision <= ?3
        ",
        params![request.kind, request.document_id, request.expected_revision],
    )?;
    Ok(revision)
}

fn apply_encoded_update(
    transaction: &mut yrs::TransactionMut<'_>,
    bytes: &[u8],
    label: &str,
) -> Result<(), PersistenceError> {
    let update = Update::decode_v1(bytes)
        .map_err(|error| PersistenceError::InvalidInput(format!("invalid Yjs {label}: {error}")))?;
    transaction.apply_update(update).map_err(|error| {
        PersistenceError::InvalidInput(format!("cannot apply Yjs {label}: {error}"))
    })
}

fn register_active_workspace(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), PersistenceError> {
    let active = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = 'active_workspace_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(active) = active {
        if active != workspace_id {
            return Err(PersistenceError::InvalidInput(
                "only one active workspace is supported in Core MVP".to_owned(),
            ));
        }
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO settings (key, value) VALUES ('active_workspace_id', ?1)",
        [workspace_id],
    )?;
    Ok(())
}

fn commit_local_states(
    transaction: &Transaction<'_>,
    request: &PersistenceCommitRequest,
) -> Result<(), PersistenceError> {
    let mut states = request.local_states.iter().collect::<Vec<_>>();
    states.sort_by(|left, right| left.window_id.cmp(&right.window_id));
    for local_state in states {
        if local_state.window_id.is_empty() || !local_state.state.is_object() {
            return Err(PersistenceError::InvalidInput(
                "window local state requires a non-empty id and JSON object".to_owned(),
            ));
        }
        transaction.execute(
            "
            INSERT INTO local_window_state (window_id, state_json, operation_id)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(window_id) DO UPDATE SET
                state_json = excluded.state_json,
                operation_id = excluded.operation_id
            ",
            params![
                local_state.window_id,
                serde_json::to_string(&local_state.state)?,
                request.operation_id
            ],
        )?;
    }
    Ok(())
}

fn validate_document_identity(kind: &str, document_id: &str) -> Result<(), PersistenceError> {
    if !matches!(kind, "workspace" | "note") {
        return Err(PersistenceError::InvalidInput(format!(
            "unsupported document kind: {kind}"
        )));
    }
    if document_id.is_empty() || document_id.len() > 128 {
        return Err(PersistenceError::InvalidInput(
            "document_id must contain 1..=128 characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> Result<(), PersistenceError> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(PersistenceError::InvalidInput(
            "operation_id must be an ASCII identifier".to_owned(),
        ));
    }
    Ok(())
}

fn validate_scope(scope: &str) -> Result<(), PersistenceError> {
    if matches!(
        scope,
        "note-doc" | "workspace-structure" | "local-ui" | "bootstrap"
    ) {
        Ok(())
    } else {
        Err(PersistenceError::InvalidInput(format!(
            "unsupported transaction scope: {scope}"
        )))
    }
}

fn request_fingerprint(request: &PersistenceCommitRequest) -> String {
    let mut hasher = Sha256::new();
    hash_value(&mut hasher, request.scope.as_bytes());
    let mut documents = request.documents.iter().collect::<Vec<_>>();
    documents.sort_by(|left, right| {
        (&left.kind, &left.document_id).cmp(&(&right.kind, &right.document_id))
    });
    for document in documents {
        hash_value(&mut hasher, document.kind.as_bytes());
        hash_value(&mut hasher, document.document_id.as_bytes());
        hash_value(&mut hasher, &document.schema_version.to_be_bytes());
        hash_value(&mut hasher, &document.base_revision.to_be_bytes());
        hash_optional_bytes(&mut hasher, document.snapshot.as_deref());
        hash_optional_bytes(&mut hasher, document.update.as_deref());
    }
    let mut states = request.local_states.iter().collect::<Vec<_>>();
    states.sort_by(|left, right| left.window_id.cmp(&right.window_id));
    for state in states {
        hash_value(&mut hasher, state.window_id.as_bytes());
        hash_value(
            &mut hasher,
            serde_json::to_string(&state.state)
                .expect("serializing a serde_json::Value cannot fail")
                .as_bytes(),
        );
    }
    if let Some(note_id) = &request.search_index_metadata_only_note_id {
        hash_value(&mut hasher, b"search-index-metadata-only-note");
        hash_value(&mut hasher, note_id.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn compaction_request_fingerprint(request: &PersistenceCompactionRequest) -> String {
    let mut hasher = Sha256::new();
    hash_value(&mut hasher, b"compact");
    hash_value(&mut hasher, request.kind.as_bytes());
    hash_value(&mut hasher, request.document_id.as_bytes());
    hash_value(&mut hasher, &request.schema_version.to_be_bytes());
    hash_value(&mut hasher, &request.expected_revision.to_be_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hash_optional_bytes(hasher: &mut Sha256, value: Option<&[u8]>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_value(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn hash_value(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

#[tauri::command]
pub fn persistence_manifest(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
) -> Result<PersistenceManifest, String> {
    state
        .with_store(&app, |store| store.manifest())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn persistence_commit(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: PersistenceCommitRequest,
) -> Result<PersistenceCommitResponse, String> {
    state
        .with_store(&app, |store| store.commit(&request))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn persistence_compact(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: PersistenceCompactionRequest,
) -> Result<PersistenceCommitResponse, String> {
    state
        .with_store(&app, |store| store.compact(&request))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn persistence_load_document(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    kind: String,
    document_id: String,
) -> Result<PersistedDocument, String> {
    state
        .with_store(&app, |store| store.load_document(&kind, &document_id))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn persistence_load_local_states(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
) -> Result<Vec<PersistedLocalState>, String> {
    state
        .with_store(&app, |store| store.load_local_states())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_search_index_rebuild(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: SearchIndexRebuildRequest,
) -> Result<(), String> {
    state
        .with_store(&app, |store| store.rebuild_workspace_search_index(&request))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_search_index_replace_document(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: SearchIndexReplaceRequest,
) -> Result<String, String> {
    state
        .with_store(&app, |store| {
            store.replace_workspace_search_index_document(&request)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_search_index_update_hierarchy(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: SearchIndexHierarchyUpdateRequest,
) -> Result<String, String> {
    state
        .with_store(&app, |store| {
            store.update_workspace_search_index_hierarchy(&request)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_search_index_query(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    request: SearchIndexQueryRequest,
) -> Result<SearchIndexQueryResponse, String> {
    state
        .with_store(&app, |store| store.query_workspace_search_index(&request))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use yrs::{GetString, Text};

    struct YjsHistory {
        snapshot: Vec<u8>,
        update_2: Vec<u8>,
        update_3: Vec<u8>,
        update_4: Vec<u8>,
    }

    fn new_store() -> (TempDir, ProductStore) {
        let directory = TempDir::new().expect("temporary directory");
        let store = ProductStore::open(directory.path()).expect("open product store");
        (directory, store)
    }

    fn new_document(kind: &str, document_id: &str, bytes: &[u8]) -> DocumentCommitInput {
        DocumentCommitInput {
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
            schema_version: DOCUMENT_SCHEMA_VERSION,
            base_revision: 0,
            snapshot: Some(bytes.to_vec()),
            update: None,
        }
    }

    fn update_document(
        kind: &str,
        document_id: &str,
        base_revision: i64,
        bytes: &[u8],
    ) -> DocumentCommitInput {
        DocumentCommitInput {
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
            schema_version: DOCUMENT_SCHEMA_VERSION,
            base_revision,
            snapshot: None,
            update: Some(bytes.to_vec()),
        }
    }

    fn compact_request(
        operation_id: &str,
        kind: &str,
        document_id: &str,
        expected_revision: i64,
    ) -> PersistenceCompactionRequest {
        PersistenceCompactionRequest {
            operation_id: operation_id.to_owned(),
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
            schema_version: DOCUMENT_SCHEMA_VERSION,
            expected_revision,
            fault: None,
        }
    }

    fn yjs_history() -> YjsHistory {
        let doc = Doc::with_client_id(1);
        let text = doc.get_or_insert_text("body");
        text.insert(&mut doc.transact_mut(), 0, "one");
        let snapshot = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let state_vector = doc.transact().state_vector();
        text.insert(&mut doc.transact_mut(), 3, "-two");
        let update_2 = doc.transact().encode_state_as_update_v1(&state_vector);

        let state_vector = doc.transact().state_vector();
        text.insert(&mut doc.transact_mut(), 7, "-three");
        let update_3 = doc.transact().encode_state_as_update_v1(&state_vector);

        let state_vector = doc.transact().state_vector();
        text.insert(&mut doc.transact_mut(), 13, "-four");
        let update_4 = doc.transact().encode_state_as_update_v1(&state_vector);

        YjsHistory {
            snapshot,
            update_2,
            update_3,
            update_4,
        }
    }

    fn read_yjs_text(snapshot: &[u8]) -> String {
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(snapshot).unwrap())
            .unwrap();
        let text = doc.get_or_insert_text("body");
        text.get_string(&doc.transact())
    }

    fn request(
        operation_id: &str,
        documents: Vec<DocumentCommitInput>,
    ) -> PersistenceCommitRequest {
        PersistenceCommitRequest {
            operation_id: operation_id.to_owned(),
            scope: "workspace-structure".to_owned(),
            documents,
            local_states: Vec::new(),
            search_index_metadata_only_note_id: None,
            fault: None,
        }
    }

    #[test]
    fn atomically_creates_workspace_and_note_snapshots() {
        let (_directory, mut store) = new_store();
        let response = store
            .commit(&request(
                "op-create",
                vec![
                    new_document("workspace", "workspace-1", b"workspace-snapshot"),
                    new_document("note", "note-1", b"note-snapshot"),
                ],
            ))
            .expect("commit documents");

        assert_eq!(response.documents.len(), 2);
        assert_eq!(
            store.manifest().unwrap().active_workspace_id.as_deref(),
            Some("workspace-1")
        );
        assert_eq!(
            store.load_document("note", "note-1").unwrap().snapshot,
            b"note-snapshot"
        );
        let invalidations: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM workspace_search_invalidations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invalidations, 2);
    }

    #[test]
    fn records_incremental_updates_after_the_snapshot() {
        let (_directory, mut store) = new_store();
        store
            .commit(&request(
                "op-create",
                vec![new_document("note", "note-1", b"snapshot")],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit",
                vec![update_document("note", "note-1", 1, b"delta")],
            ))
            .unwrap();

        let document = store.load_document("note", "note-1").unwrap();
        assert_eq!(document.revision, 2);
        assert_eq!(document.snapshot_revision, 1);
        assert_eq!(
            document.updates,
            vec![PersistedUpdate {
                revision: 2,
                update: b"delta".to_vec(),
            }]
        );
    }

    #[test]
    fn backs_up_the_exact_note_v2_history_before_committing_v3_migration() {
        let (_directory, mut store) = new_store();
        store
            .commit(&request(
                "op-create-v2",
                vec![new_document("note", "note-migrate", b"v2-snapshot")],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit-v2",
                vec![update_document("note", "note-migrate", 1, b"v2-update")],
            ))
            .unwrap();

        store
            .commit(&request(
                "op-migrate-v3",
                vec![DocumentCommitInput {
                    kind: "note".to_owned(),
                    document_id: "note-migrate".to_owned(),
                    schema_version: NOTE_DOCUMENT_SCHEMA_VERSION,
                    base_revision: 2,
                    snapshot: None,
                    update: Some(b"v3-migration-update".to_vec()),
                }],
            ))
            .unwrap();

        let migrated = store.load_document("note", "note-migrate").unwrap();
        assert_eq!(migrated.schema_version, NOTE_DOCUMENT_SCHEMA_VERSION);
        assert_eq!(migrated.revision, 3);
        assert_eq!(migrated.snapshot, b"v2-snapshot");
        assert_eq!(migrated.updates.len(), 2);

        let backup: (i64, i64, Vec<u8>) = store
            .connection
            .query_row(
                "SELECT revision, snapshot_revision, snapshot
                 FROM document_schema_backups
                 WHERE kind = 'note' AND document_id = 'note-migrate'
                   AND from_schema_version = 2 AND to_schema_version = 3",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(backup, (2, 1, b"v2-snapshot".to_vec()));
        let backup_update: (i64, String, Vec<u8>) = store
            .connection
            .query_row(
                "SELECT revision, operation_id, update_blob
                 FROM document_schema_backup_updates
                 WHERE kind = 'note' AND document_id = 'note-migrate'
                   AND from_schema_version = 2 AND to_schema_version = 3",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            backup_update,
            (2, "op-edit-v2".to_owned(), b"v2-update".to_vec())
        );
    }

    #[test]
    fn compacts_updates_into_a_snapshot_without_advancing_revision() {
        let (_directory, mut store) = new_store();
        let history = yjs_history();
        store
            .commit(&request(
                "op-create",
                vec![new_document("note", "note-1", &history.snapshot)],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit-2",
                vec![update_document("note", "note-1", 1, &history.update_2)],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit-3",
                vec![update_document("note", "note-1", 2, &history.update_3)],
            ))
            .unwrap();

        let response = store
            .compact(&compact_request("op-compact", "note", "note-1", 3))
            .unwrap();

        assert_eq!(response.documents[0].revision, 3);
        let document = store.load_document("note", "note-1").unwrap();
        assert_eq!(document.revision, 3);
        assert_eq!(document.snapshot_revision, 3);
        assert_eq!(read_yjs_text(&document.snapshot), "one-two-three");
        assert!(document.updates.is_empty());

        store
            .commit(&request(
                "op-edit-4",
                vec![update_document("note", "note-1", 3, &history.update_4)],
            ))
            .unwrap();
        let document = store.load_document("note", "note-1").unwrap();
        assert_eq!(document.revision, 4);
        assert_eq!(document.snapshot_revision, 3);
        assert_eq!(
            document.updates,
            vec![PersistedUpdate {
                revision: 4,
                update: history.update_4,
            }]
        );
    }

    #[test]
    fn stale_or_failed_compaction_preserves_the_previous_snapshot_and_updates() {
        let (_directory, mut store) = new_store();
        let history = yjs_history();
        store
            .commit(&request(
                "op-create",
                vec![new_document("note", "note-1", &history.snapshot)],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit",
                vec![update_document("note", "note-1", 1, &history.update_2)],
            ))
            .unwrap();
        let before = store.load_document("note", "note-1").unwrap();

        assert!(matches!(
            store.compact(&compact_request("op-stale-compact", "note", "note-1", 1)),
            Err(PersistenceError::RevisionConflict { .. })
        ));
        assert_eq!(store.load_document("note", "note-1").unwrap(), before);

        let mut failed = compact_request("op-failed-compact", "note", "note-1", 2);
        failed.fault = Some(CommitFault::BeforeSqlCommit);
        assert!(matches!(
            store.compact(&failed),
            Err(PersistenceError::Injected(CommitFault::BeforeSqlCommit))
        ));
        assert_eq!(store.load_document("note", "note-1").unwrap(), before);
    }

    #[test]
    fn retries_compaction_idempotently_when_the_response_is_lost() {
        let (_directory, mut store) = new_store();
        let history = yjs_history();
        store
            .commit(&request(
                "op-create",
                vec![new_document("note", "note-1", &history.snapshot)],
            ))
            .unwrap();
        store
            .commit(&request(
                "op-edit",
                vec![update_document("note", "note-1", 1, &history.update_2)],
            ))
            .unwrap();
        let mut first = compact_request("op-compact-lost", "note", "note-1", 2);
        first.fault = Some(CommitFault::AfterCommitResponse);
        assert!(matches!(
            store.compact(&first),
            Err(PersistenceError::Injected(CommitFault::AfterCommitResponse))
        ));

        first.fault = None;
        let retry = store.compact(&first).expect("deduplicated retry");
        assert!(retry.deduplicated);
        let persisted = store.load_document("note", "note-1").unwrap();
        assert_eq!(persisted.snapshot_revision, 2);
        assert_eq!(read_yjs_text(&persisted.snapshot), "one-two");
        assert!(persisted.updates.is_empty());
    }

    #[test]
    fn invalid_crdt_bytes_leave_the_snapshot_and_updates_unchanged() {
        let (_directory, mut store) = new_store();
        store
            .commit(&request(
                "op-create",
                vec![new_document("note", "note-1", b"invalid-snapshot")],
            ))
            .unwrap();
        let before = store.load_document("note", "note-1").unwrap();

        assert!(matches!(
            store.compact(&compact_request("op-invalid-compact", "note", "note-1", 1)),
            Err(PersistenceError::InvalidInput(_))
        ));
        assert_eq!(store.load_document("note", "note-1").unwrap(), before);
    }

    #[test]
    fn rolls_back_every_document_and_local_state_before_sql_commit() {
        let (_directory, mut store) = new_store();
        let mut request = request(
            "op-fault",
            vec![
                new_document("workspace", "workspace-1", b"workspace"),
                new_document("note", "note-1", b"note"),
            ],
        );
        request.local_states.push(LocalStateCommitInput {
            window_id: "window-1".to_owned(),
            state: serde_json::json!({"mode": "normal"}),
        });
        request.fault = Some(CommitFault::BeforeSqlCommit);

        assert!(matches!(
            store.commit(&request),
            Err(PersistenceError::Injected(CommitFault::BeforeSqlCommit))
        ));
        assert!(matches!(
            store.load_document("note", "note-1"),
            Err(PersistenceError::UnknownDocument { .. })
        ));
        assert!(store.load_local_states().unwrap().is_empty());
        assert_eq!(store.manifest().unwrap().active_workspace_id, None);
        let invalidations: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM workspace_search_invalidations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invalidations, 0);
    }

    #[test]
    fn retries_idempotently_when_the_response_is_lost_after_commit() {
        let (_directory, mut store) = new_store();
        let mut first = request(
            "op-lost-response",
            vec![new_document("note", "note-1", b"snapshot")],
        );
        first.fault = Some(CommitFault::AfterCommitResponse);
        assert!(matches!(
            store.commit(&first),
            Err(PersistenceError::Injected(CommitFault::AfterCommitResponse))
        ));

        first.fault = None;
        let retry = store.commit(&first).expect("deduplicated retry");
        assert!(retry.deduplicated);
        assert_eq!(store.load_document("note", "note-1").unwrap().revision, 1);
    }

    #[test]
    fn rejects_reusing_an_operation_id_with_different_content() {
        let (_directory, mut store) = new_store();
        store
            .commit(&request(
                "op-same",
                vec![new_document("note", "note-1", b"first")],
            ))
            .unwrap();
        assert!(matches!(
            store.commit(&request(
                "op-same",
                vec![update_document("note", "note-1", 1, b"different")],
            )),
            Err(PersistenceError::DuplicateOperationMismatch)
        ));
    }

    #[test]
    fn stale_revision_leaves_all_documents_unchanged() {
        let (_directory, mut store) = new_store();
        store
            .commit(&request(
                "op-create",
                vec![
                    new_document("note", "note-a", b"a"),
                    new_document("note", "note-b", b"b"),
                ],
            ))
            .unwrap();
        let result = store.commit(&request(
            "op-stale",
            vec![
                update_document("note", "note-a", 1, b"a2"),
                update_document("note", "note-b", 99, b"b2"),
            ],
        ));
        assert!(matches!(
            result,
            Err(PersistenceError::RevisionConflict { .. })
        ));
        assert_eq!(store.load_document("note", "note-a").unwrap().revision, 1);
        assert_eq!(store.load_document("note", "note-b").unwrap().revision, 1);
    }

    #[test]
    fn keeps_window_local_state_separate_from_crdt_documents() {
        let (_directory, mut store) = new_store();
        let mut request = request("op-local", Vec::new());
        request.scope = "local-ui".to_owned();
        request.local_states = vec![
            LocalStateCommitInput {
                window_id: "window-1".to_owned(),
                state: serde_json::json!({"mode": "insert", "scrollTop": 10}),
            },
            LocalStateCommitInput {
                window_id: "window-2".to_owned(),
                state: serde_json::json!({"mode": "normal", "scrollTop": 900}),
            },
        ];
        store.commit(&request).unwrap();

        let states = store.load_local_states().unwrap();
        assert_eq!(states.len(), 2);
        assert_ne!(states[0].state, states[1].state);
    }
}
