use crate::persistence::PersistenceError;
use rusqlite::{
    Connection, OptionalExtension, Params, Statement, Transaction, params, params_from_iter,
    types::Value,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const SEARCH_INDEX_SCHEMA_VERSION: i64 = 8;
const RECENT_SEARCH_PREFIX_ROWS: i64 = 4_096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexBlockInput {
    block_id: String,
    kind: String,
    section_id: String,
    text: String,
    normalized_text: String,
    japanese_grams: String,
    logical_line_number: i64,
    section_line_number: i64,
    line_index: i64,
    source_offset: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexSectionInput {
    section_id: String,
    #[serde(default)]
    parent_section_id: Option<String>,
    title: String,
    normalized_title: String,
    title_japanese_grams: String,
    order: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexDocumentInput {
    note_id: String,
    #[serde(default)]
    parent_note_id: Option<String>,
    updated_at: String,
    source_revision: i64,
    sections: Vec<SearchIndexSectionInput>,
    blocks: Vec<SearchIndexBlockInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexRebuildRequest {
    schema_version: i64,
    workspace_id: String,
    workspace_revision: i64,
    documents: Vec<SearchIndexDocumentInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexReplaceRequest {
    schema_version: i64,
    workspace_id: String,
    workspace_revision: i64,
    document: SearchIndexDocumentInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexHierarchyEntry {
    note_id: String,
    parent_note_id: Option<String>,
    title: String,
    normalized_title: String,
    title_japanese_grams: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexHierarchyUpdateRequest {
    schema_version: i64,
    workspace_id: String,
    base_revision: i64,
    workspace_revision: i64,
    entries: Vec<SearchIndexHierarchyEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexQueryRequest {
    schema_version: i64,
    workspace_id: String,
    workspace_revision: i64,
    query: String,
    scope: String,
    normalized_terms: Vec<String>,
    strategy: String,
    match_expression: String,
    limit: i64,
    #[serde(default)]
    excluded_note_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexHit {
    result_id: String,
    note_id: String,
    section_id: String,
    title: String,
    parent_path: String,
    updated_at: String,
    kind: String,
    text: String,
    block_id: Option<String>,
    logical_line_number: Option<i64>,
    section_line_number: Option<i64>,
    line_index: i64,
    source_offset: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexQueryResponse {
    status: String,
    hits: Vec<SearchIndexHit>,
}

pub fn rebuild(
    connection: &mut Connection,
    request: &SearchIndexRebuildRequest,
) -> Result<(), PersistenceError> {
    validate_rebuild_request(request)?;
    ensure_schema(connection)?;
    validate_source_revision(
        connection,
        "workspace",
        &request.workspace_id,
        request.workspace_revision,
    )?;
    for document in &request.documents {
        validate_source_revision(
            connection,
            "note",
            &document.note_id,
            document.source_revision,
        )?;
    }

    let transaction = connection.transaction()?;
    delete_workspace(&transaction, &request.workspace_id)?;
    for document in &request.documents {
        insert_document(&transaction, &request.workspace_id, document)?;
    }
    transaction.execute(
        "
        INSERT INTO workspace_search_state (
            workspace_id, schema_version, workspace_revision
        ) VALUES (?1, ?2, ?3)
        ON CONFLICT(workspace_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            workspace_revision = excluded.workspace_revision
        ",
        params![
            request.workspace_id,
            request.schema_version,
            request.workspace_revision
        ],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_invalidations WHERE kind IN ('workspace', 'note')",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn replace_document(
    connection: &mut Connection,
    request: &SearchIndexReplaceRequest,
) -> Result<&'static str, PersistenceError> {
    validate_request_header(
        request.schema_version,
        &request.workspace_id,
        request.workspace_revision,
    )?;
    validate_document(&request.document)?;
    ensure_schema(connection)?;
    if !index_is_current(
        connection,
        &request.workspace_id,
        request.workspace_revision,
        request.schema_version,
    )? {
        return Ok("stale");
    }
    validate_source_revision(
        connection,
        "workspace",
        &request.workspace_id,
        request.workspace_revision,
    )?;
    validate_source_revision(
        connection,
        "note",
        &request.document.note_id,
        request.document.source_revision,
    )?;
    let document_exists = connection.query_row(
        "
            SELECT EXISTS (
                SELECT 1
            FROM workspace_search_documents
            WHERE workspace_id = ?1 AND note_id = ?2
            )
            ",
        params![request.workspace_id, request.document.note_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !document_exists {
        return Ok("stale");
    }

    let transaction = connection.transaction()?;
    delete_document(
        &transaction,
        &request.workspace_id,
        &request.document.note_id,
    )?;
    insert_document(&transaction, &request.workspace_id, &request.document)?;
    transaction.execute(
        "
        DELETE FROM workspace_search_invalidations
        WHERE kind = 'note' AND document_id = ?1 AND source_revision <= ?2
        ",
        params![request.document.note_id, request.document.source_revision],
    )?;
    transaction.execute(
        "
        DELETE FROM workspace_search_invalidations
        WHERE kind = 'workspace'
          AND document_id = ?1
          AND source_revision <= ?2
        ",
        params![request.workspace_id, request.workspace_revision],
    )?;
    transaction.commit()?;
    Ok("updated")
}

pub fn update_hierarchy(
    connection: &mut Connection,
    request: &SearchIndexHierarchyUpdateRequest,
) -> Result<&'static str, PersistenceError> {
    validate_request_header(
        request.schema_version,
        &request.workspace_id,
        request.workspace_revision,
    )?;
    if request.base_revision < 1 || request.base_revision >= request.workspace_revision {
        return Err(PersistenceError::InvalidInput(
            "search hierarchy update requires increasing Workspace revisions".to_owned(),
        ));
    }
    ensure_schema(connection)?;
    if !index_is_current(
        connection,
        &request.workspace_id,
        request.base_revision,
        request.schema_version,
    )? {
        return Ok("stale");
    }
    validate_source_revision(
        connection,
        "workspace",
        &request.workspace_id,
        request.workspace_revision,
    )?;
    let transaction = connection.transaction()?;
    for entry in &request.entries {
        if entry.note_id.is_empty() {
            return Err(PersistenceError::InvalidInput(
                "search hierarchy update has an empty Note ID".to_owned(),
            ));
        }
        if entry.parent_note_id.as_deref() == Some(entry.note_id.as_str()) {
            return Err(PersistenceError::InvalidInput(
                "search hierarchy update cannot self-parent a Note".to_owned(),
            ));
        }
        let row_id = transaction
            .query_row(
                "SELECT row_id
                 FROM workspace_search_sections
                 WHERE workspace_id = ?1 AND note_id = ?2 AND section_id = ?2",
                params![request.workspace_id, entry.note_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let Some(row_id) = row_id else {
            return Ok("stale");
        };
        if let Some(parent_note_id) = &entry.parent_note_id {
            let parent_exists = transaction.query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM workspace_search_sections
                    WHERE workspace_id = ?1
                      AND note_id = ?2
                      AND section_id = ?2
                )",
                params![request.workspace_id, parent_note_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !parent_exists {
                return Ok("stale");
            }
        }
        let changed = transaction.execute(
            "UPDATE workspace_search_sections
             SET parent_section_id = ?3, title = ?4, normalized_title = ?5
             WHERE workspace_id = ?1 AND note_id = ?2 AND section_id = ?2",
            params![
                request.workspace_id,
                entry.note_id,
                entry.parent_note_id,
                entry.title,
                entry.normalized_title
            ],
        )?;
        if changed != 1 {
            return Ok("stale");
        }
        transaction.execute(
            "DELETE FROM workspace_search_title_trigram WHERE rowid = ?1",
            [row_id],
        )?;
        transaction.execute(
            "INSERT INTO workspace_search_title_trigram (rowid, title)
             VALUES (?1, ?2)",
            params![row_id, entry.normalized_title],
        )?;
        transaction.execute(
            "DELETE FROM workspace_search_title_japanese_grams WHERE rowid = ?1",
            [row_id],
        )?;
        if !entry.title_japanese_grams.is_empty() {
            transaction.execute(
                "INSERT INTO workspace_search_title_japanese_grams (rowid, title)
                 VALUES (?1, ?2)",
                params![row_id, entry.title_japanese_grams],
            )?;
        }
    }
    transaction.execute(
        "UPDATE workspace_search_state
         SET workspace_revision = ?3
         WHERE workspace_id = ?1 AND workspace_revision = ?2",
        params![
            request.workspace_id,
            request.base_revision,
            request.workspace_revision
        ],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_invalidations
         WHERE kind = 'workspace' AND document_id = ?1 AND source_revision <= ?2",
        params![request.workspace_id, request.workspace_revision],
    )?;
    transaction.commit()?;
    Ok("updated")
}

pub fn query(
    connection: &mut Connection,
    request: &SearchIndexQueryRequest,
) -> Result<SearchIndexQueryResponse, PersistenceError> {
    validate_request_header(
        request.schema_version,
        &request.workspace_id,
        request.workspace_revision,
    )?;
    if !matches!(request.scope.as_str(), "title" | "body") {
        return Err(PersistenceError::InvalidInput(format!(
            "invalid search scope {}",
            request.scope
        )));
    }
    if !(1..=100).contains(&request.limit) {
        return Err(PersistenceError::InvalidInput(
            "search limit must be between 1 and 100".to_owned(),
        ));
    }
    let excluded = request.excluded_note_ids.iter().collect::<HashSet<_>>();
    if request.excluded_note_ids.len() > 100
        || excluded.len() != request.excluded_note_ids.len()
        || request.excluded_note_ids.iter().any(String::is_empty)
    {
        return Err(PersistenceError::InvalidInput(
            "search excluded Note IDs must be unique non-empty values".to_owned(),
        ));
    }
    ensure_schema(connection)?;
    if !index_is_current(
        connection,
        &request.workspace_id,
        request.workspace_revision,
        request.schema_version,
    )? || source_revisions_are_stale(connection, request)?
    {
        return Ok(SearchIndexQueryResponse {
            status: "stale".to_owned(),
            hits: Vec::new(),
        });
    }

    let mut hits = match request.strategy.as_str() {
        "all-titles" if request.scope == "title" && request.normalized_terms.is_empty() => {
            query_all_titles(connection, request)?
        }
        "empty" if request.scope == "body" && request.normalized_terms.is_empty() => Vec::new(),
        "trigram" if !request.normalized_terms.is_empty() => query_trigram(connection, request)?,
        "japanese-gram" if !request.match_expression.is_empty() => {
            query_japanese_gram(connection, request)?
        }
        "scan" if !request.normalized_terms.is_empty() => query_scan(connection, request)?,
        _ => {
            return Err(PersistenceError::InvalidInput(format!(
                "invalid search strategy for query {:?}: {}",
                request.query, request.strategy
            )));
        }
    };
    hydrate_parent_paths(connection, &request.workspace_id, &mut hits)?;
    Ok(SearchIndexQueryResponse {
        status: "ready".to_owned(),
        hits,
    })
}

fn ensure_schema(connection: &Connection) -> Result<(), PersistenceError> {
    let legacy_schema = table_exists(connection, "workspace_search_rows")?
        || table_exists(connection, "workspace_search_trigram")?
        || table_exists(connection, "workspace_search_japanese_grams")?
        || (table_exists(connection, "workspace_search_sections")?
            && table_has_column(connection, "workspace_search_sections", "path_title")?)
        || (table_exists(connection, "workspace_search_documents")?
            && !table_has_column(connection, "workspace_search_documents", "updated_at")?);
    if legacy_schema {
        drop_derived_tables_impl(connection)?;
    }
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspace_search_state (
            workspace_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            workspace_revision INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_search_documents (
            workspace_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, note_id)
        );

        CREATE TABLE IF NOT EXISTS workspace_search_sections (
            row_id INTEGER PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            parent_section_id TEXT,
            title TEXT NOT NULL,
            normalized_title TEXT NOT NULL,
            section_order INTEGER NOT NULL,
            UNIQUE (workspace_id, section_id)
        );

        CREATE TABLE IF NOT EXISTS workspace_search_body_rows (
            row_id INTEGER PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            result_id TEXT NOT NULL,
            note_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            text TEXT NOT NULL,
            normalized_text TEXT NOT NULL,
            block_id TEXT,
            logical_line_number INTEGER NOT NULL,
            section_line_number INTEGER NOT NULL,
            line_index INTEGER NOT NULL DEFAULT 0,
            source_offset INTEGER NOT NULL DEFAULT 0,
            block_order INTEGER NOT NULL,
            UNIQUE (workspace_id, result_id)
        );

        CREATE INDEX IF NOT EXISTS workspace_search_documents_recency
        ON workspace_search_documents (workspace_id, updated_at DESC, note_id);

        CREATE INDEX IF NOT EXISTS workspace_search_sections_note_order
        ON workspace_search_sections (workspace_id, note_id, section_order);

        CREATE INDEX IF NOT EXISTS workspace_search_sections_parent
        ON workspace_search_sections (workspace_id, parent_section_id, section_id);

        CREATE INDEX IF NOT EXISTS workspace_search_body_note_order
        ON workspace_search_body_rows (workspace_id, note_id, block_order);

        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_title_trigram
        USING fts5(title, tokenize='trigram');

        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_title_japanese_grams
        USING fts5(title, tokenize='unicode61');

        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_body_trigram
        USING fts5(body, tokenize='trigram');

        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_body_japanese_grams
        USING fts5(body, tokenize='unicode61');
        ",
    )?;
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, PersistenceError> {
    connection
        .query_row(
            "SELECT EXISTS (
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
            )",
            [table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(Into::into)
}

fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, PersistenceError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|name| name == column))
}

fn validate_rebuild_request(request: &SearchIndexRebuildRequest) -> Result<(), PersistenceError> {
    validate_request_header(
        request.schema_version,
        &request.workspace_id,
        request.workspace_revision,
    )?;
    let note_ids = request
        .documents
        .iter()
        .map(|document| document.note_id.as_str())
        .collect::<HashSet<_>>();
    if note_ids.len() != request.documents.len() {
        return Err(PersistenceError::InvalidInput(
            "search index rebuild contains duplicate Note IDs".to_owned(),
        ));
    }
    for document in &request.documents {
        validate_document(document)?;
        if document
            .parent_note_id
            .as_deref()
            .is_some_and(|parent| !note_ids.contains(parent))
        {
            return Err(PersistenceError::InvalidInput(format!(
                "search index Note {} refers to an unknown parent",
                document.note_id
            )));
        }
    }
    Ok(())
}

fn validate_request_header(
    schema_version: i64,
    workspace_id: &str,
    workspace_revision: i64,
) -> Result<(), PersistenceError> {
    if schema_version != SEARCH_INDEX_SCHEMA_VERSION {
        return Err(PersistenceError::InvalidInput(format!(
            "unsupported search index schema {schema_version}"
        )));
    }
    if workspace_id.is_empty() || workspace_revision < 1 {
        return Err(PersistenceError::InvalidInput(
            "search index requires a persisted workspace".to_owned(),
        ));
    }
    Ok(())
}

fn validate_document(document: &SearchIndexDocumentInput) -> Result<(), PersistenceError> {
    if document.note_id.is_empty() || document.source_revision < 1 {
        return Err(PersistenceError::InvalidInput(
            "search index requires a persisted NoteDoc".to_owned(),
        ));
    }
    let section_ids = document
        .sections
        .iter()
        .map(|section| section.section_id.as_str())
        .collect::<HashSet<_>>();
    if document.sections.is_empty()
        || document.sections[0].section_id != document.note_id
        || document.sections[0].parent_section_id.is_some()
        || section_ids.len() != document.sections.len()
        || document
            .sections
            .iter()
            .enumerate()
            .any(|(index, section)| {
                section.section_id.is_empty()
                    || section.order < 0
                    || (index > 0
                        && section
                            .parent_section_id
                            .as_deref()
                            .is_none_or(|parent| !section_ids.contains(parent)))
            })
    {
        return Err(PersistenceError::InvalidInput(format!(
            "search index requires a Root Section and valid Section IDs for note {}",
            document.note_id
        )));
    }
    for block in &document.blocks {
        if block.block_id.is_empty()
            || block.kind != "body"
            || block.section_id.is_empty()
            || block.logical_line_number < 1
            || block.section_line_number < 1
            || block.line_index < 0
            || block.source_offset < 0
        {
            return Err(PersistenceError::InvalidInput(format!(
                "invalid search block in note {}",
                document.note_id
            )));
        }
    }
    Ok(())
}

fn validate_source_revision(
    connection: &Connection,
    kind: &str,
    document_id: &str,
    expected_revision: i64,
) -> Result<(), PersistenceError> {
    let actual = connection
        .query_row(
            "SELECT revision FROM documents WHERE kind = ?1 AND document_id = ?2",
            params![kind, document_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| PersistenceError::UnknownDocument {
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
        })?;
    if actual != expected_revision {
        return Err(PersistenceError::RevisionConflict {
            kind: kind.to_owned(),
            document_id: document_id.to_owned(),
            expected: expected_revision,
            actual,
        });
    }
    Ok(())
}

fn index_is_current(
    connection: &Connection,
    workspace_id: &str,
    workspace_revision: i64,
    schema_version: i64,
) -> Result<bool, PersistenceError> {
    let state = connection
        .query_row(
            "
            SELECT schema_version, workspace_revision
            FROM workspace_search_state
            WHERE workspace_id = ?1
            ",
            [workspace_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    Ok(state == Some((schema_version, workspace_revision)))
}

fn source_revisions_are_stale(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<bool, PersistenceError> {
    let excluded = request
        .excluded_note_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut statement = connection.prepare(
        "SELECT kind, document_id, source_revision
         FROM workspace_search_invalidations",
    )?;
    let invalidations = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(invalidations
        .iter()
        .any(|(kind, document_id, source_revision)| match kind.as_str() {
            "note" => !excluded.contains(document_id.as_str()),
            // A metadata-only NoteDoc commit advances search_state in the
            // same SQLite transaction. Its paired Workspace invalidation is
            // safe only while Core excludes at least one dirty NoteDoc and
            // merges that durable CRDT projection itself.
            "workspace" => {
                document_id != &request.workspace_id
                    || *source_revision > request.workspace_revision
                    || excluded.is_empty()
            }
            _ => true,
        }))
}

fn delete_workspace(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "DELETE FROM workspace_search_title_trigram WHERE rowid IN (
            SELECT row_id FROM workspace_search_sections WHERE workspace_id = ?1
        )",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_title_japanese_grams WHERE rowid IN (
            SELECT row_id FROM workspace_search_sections WHERE workspace_id = ?1
        )",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_trigram WHERE rowid IN (
            SELECT row_id FROM workspace_search_body_rows WHERE workspace_id = ?1
        )",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_japanese_grams WHERE rowid IN (
            SELECT row_id FROM workspace_search_body_rows WHERE workspace_id = ?1
        )",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_rows WHERE workspace_id = ?1",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_sections WHERE workspace_id = ?1",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_documents WHERE workspace_id = ?1",
        [workspace_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_state WHERE workspace_id = ?1",
        [workspace_id],
    )?;
    Ok(())
}

fn delete_document(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    note_id: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "DELETE FROM workspace_search_title_trigram WHERE rowid IN (
            SELECT row_id FROM workspace_search_sections
            WHERE workspace_id = ?1 AND note_id = ?2
        )",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_title_japanese_grams WHERE rowid IN (
            SELECT row_id FROM workspace_search_sections
            WHERE workspace_id = ?1 AND note_id = ?2
        )",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_trigram WHERE rowid IN (
            SELECT row_id FROM workspace_search_body_rows
            WHERE workspace_id = ?1 AND note_id = ?2
        )",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_japanese_grams WHERE rowid IN (
            SELECT row_id FROM workspace_search_body_rows
            WHERE workspace_id = ?1 AND note_id = ?2
        )",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_body_rows WHERE workspace_id = ?1 AND note_id = ?2",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_sections WHERE workspace_id = ?1 AND note_id = ?2",
        params![workspace_id, note_id],
    )?;
    transaction.execute(
        "DELETE FROM workspace_search_documents WHERE workspace_id = ?1 AND note_id = ?2",
        params![workspace_id, note_id],
    )?;
    Ok(())
}

fn insert_document(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    document: &SearchIndexDocumentInput,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "
        INSERT INTO workspace_search_documents (
            workspace_id, note_id, source_revision, updated_at
        ) VALUES (?1, ?2, ?3, ?4)
        ",
        params![
            workspace_id,
            document.note_id,
            document.source_revision,
            document.updated_at
        ],
    )?;
    let sections = document
        .sections
        .iter()
        .map(|section| (section.section_id.as_str(), section))
        .collect::<HashMap<_, _>>();
    for (index, section) in document.sections.iter().enumerate() {
        let parent_section_id = if index == 0 {
            document.parent_note_id.as_deref()
        } else {
            section.parent_section_id.as_deref()
        };
        transaction
            .prepare_cached(
                "INSERT INTO workspace_search_sections (
                    workspace_id, section_id, note_id, parent_section_id,
                    title, normalized_title, section_order
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                workspace_id,
                section.section_id,
                document.note_id,
                parent_section_id,
                section.title,
                section.normalized_title,
                section.order
            ])?;
        let row_id = transaction.last_insert_rowid();
        transaction
            .prepare_cached(
                "INSERT INTO workspace_search_title_trigram (rowid, title)
                 VALUES (?1, ?2)",
            )?
            .execute(params![row_id, section.normalized_title])?;
        if !section.title_japanese_grams.is_empty() {
            transaction
                .prepare_cached(
                    "INSERT INTO workspace_search_title_japanese_grams (rowid, title)
                     VALUES (?1, ?2)",
                )?
                .execute(params![row_id, section.title_japanese_grams])?;
        }
    }
    for (block_order, block) in document.blocks.iter().enumerate() {
        sections.get(block.section_id.as_str()).ok_or_else(|| {
            PersistenceError::InvalidInput(format!(
                "search block refers to an unknown Section in note {}",
                document.note_id
            ))
        })?;
        let result_id = format!(
            "{}:{}:line:{}",
            document.note_id, block.kind, block.logical_line_number
        );
        transaction
            .prepare_cached(
                "INSERT INTO workspace_search_body_rows (
                    workspace_id, result_id, note_id, section_id, text,
                    normalized_text, block_id, logical_line_number,
                    section_line_number, line_index, source_offset, block_order
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?
            .execute(params![
                workspace_id,
                result_id,
                document.note_id,
                block.section_id,
                block.text,
                block.normalized_text,
                block.block_id,
                block.logical_line_number,
                block.section_line_number,
                block.line_index,
                block.source_offset,
                block_order as i64
            ])?;
        let row_id = transaction.last_insert_rowid();
        transaction
            .prepare_cached(
                "INSERT INTO workspace_search_body_trigram (rowid, body)
                 VALUES (?1, ?2)",
            )?
            .execute(params![row_id, block.normalized_text])?;
        if !block.japanese_grams.is_empty() {
            transaction
                .prepare_cached(
                    "INSERT INTO workspace_search_body_japanese_grams (rowid, body)
                     VALUES (?1, ?2)",
                )?
                .execute(params![row_id, block.japanese_grams])?;
        }
    }
    Ok(())
}

const TITLE_HIT_COLUMNS: &str = "
    s.note_id || ':section:' || s.section_id || ':title',
    s.note_id, s.section_id, s.title, '', d.updated_at,
    'title', '', NULL, NULL, NULL, 0, 0
";

const BODY_HIT_COLUMNS: &str = "
    b.result_id, b.note_id, b.section_id, s.title, '', d.updated_at,
    'body', b.text, b.block_id, b.logical_line_number,
    b.section_line_number, b.line_index, b.source_offset
";

fn query_all_titles(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    let exclusion = excluded_note_predicate(request, "s", 2);
    let limit_parameter = 2 + request.excluded_note_ids.len();
    let sql = format!(
        "SELECT {TITLE_HIT_COLUMNS}
         FROM workspace_search_sections AS s
         JOIN workspace_search_documents AS d
           ON d.workspace_id = s.workspace_id AND d.note_id = s.note_id
         WHERE s.workspace_id = ?1
         {exclusion}
         ORDER BY d.updated_at DESC, d.note_id, s.section_order
         LIMIT ?{limit_parameter}"
    );
    let mut parameters = vec![Value::Text(request.workspace_id.clone())];
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn query_trigram(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    if request.scope == "title" {
        query_title_terms(connection, request, Some("workspace_search_title_trigram"))
    } else {
        query_body_indexed(
            connection,
            request,
            "workspace_search_body_trigram",
            &request.match_expression,
        )
    }
}

fn query_japanese_gram(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    if request.scope == "title" {
        query_title_terms(
            connection,
            request,
            Some("workspace_search_title_japanese_grams"),
        )
    } else {
        query_body_indexed(
            connection,
            request,
            "workspace_search_body_japanese_grams",
            &request.match_expression,
        )
    }
}

fn query_title_terms(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
    fts_table: Option<&str>,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    let recent = query_recent_title_prefix(connection, request)?;
    if recent.len() as i64 >= request.limit {
        return Ok(recent);
    }
    let mut parameters = vec![Value::Text(request.workspace_id.clone())];
    let mut terms = Vec::new();
    for (index, term) in request.normalized_terms.iter().enumerate() {
        let name = format!("term_{index}");
        let seed = if let Some(table) = fts_table {
            parameters.push(Value::Text(format!("\"{}\"", term.replace('"', "\"\""))));
            let match_parameter = parameters.len();
            parameters.push(Value::Text(term.clone()));
            let exact_parameter = parameters.len();
            format!(
                "SELECT seed.section_id
                 FROM workspace_search_sections AS seed
                 JOIN {table} ON {table}.rowid = seed.row_id
                 WHERE seed.workspace_id = ?1
                   AND {table} MATCH ?{match_parameter}
                   AND instr(seed.normalized_title, ?{exact_parameter}) > 0"
            )
        } else {
            parameters.push(Value::Text(term.clone()));
            let exact_parameter = parameters.len();
            format!(
                "SELECT seed.section_id
                 FROM workspace_search_sections AS seed
                 WHERE seed.workspace_id = ?1
                   AND instr(seed.normalized_title, ?{exact_parameter}) > 0"
            )
        };
        terms.push(format!(
            "{name}(section_id) AS (
                {seed}
                UNION
                SELECT child.section_id
                FROM workspace_search_sections AS child
                JOIN {name} AS ancestor
                  ON child.parent_section_id = ancestor.section_id
                WHERE child.workspace_id = ?1
            )"
        ));
    }
    let joins = (0..request.normalized_terms.len())
        .map(|index| {
            format!(
                "JOIN term_{index} AS matched_{index}
                   ON matched_{index}.section_id = s.section_id"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let exclusion_parameter = parameters.len() + 1;
    let exclusion = excluded_note_predicate(request, "s", exclusion_parameter);
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let limit_parameter = parameters.len();
    let sql = format!(
        "WITH RECURSIVE {}
         SELECT {TITLE_HIT_COLUMNS}
         FROM workspace_search_sections AS s
         JOIN workspace_search_documents AS d
           ON d.workspace_id = s.workspace_id AND d.note_id = s.note_id
         {joins}
         WHERE s.workspace_id = ?1
         {exclusion}
         ORDER BY d.updated_at DESC, d.note_id, s.section_order
         LIMIT ?{limit_parameter}",
        terms.join(",\n")
    );
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn query_recent_title_prefix(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    let exclusion = excluded_note_predicate(request, "d", 2);
    let term_parameter = request.excluded_note_ids.len() + 2;
    let having = request
        .normalized_terms
        .iter()
        .enumerate()
        .map(|(index, _)| {
            format!(
                "max(instr(ancestry.normalized_title, ?{}) > 0) = 1",
                term_parameter + index
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let limit_parameter = term_parameter + request.normalized_terms.len();
    let sql = format!(
        "WITH RECURSIVE
         recent(section_id) AS (
             SELECT s.section_id
             FROM workspace_search_documents AS d
                  INDEXED BY workspace_search_documents_recency
             JOIN workspace_search_sections AS s
                  INDEXED BY workspace_search_sections_note_order
               ON s.workspace_id = d.workspace_id AND s.note_id = d.note_id
             WHERE d.workspace_id = ?1
             {exclusion}
             ORDER BY d.updated_at DESC, d.note_id, s.section_order
             LIMIT {RECENT_SEARCH_PREFIX_ROWS}
         ),
         ancestry(target_id, section_id, parent_section_id, normalized_title) AS (
             SELECT recent.section_id, s.section_id, s.parent_section_id,
                    s.normalized_title
             FROM recent
             JOIN workspace_search_sections AS s
               ON s.workspace_id = ?1 AND s.section_id = recent.section_id
             UNION
             SELECT ancestry.target_id, parent.section_id,
                    parent.parent_section_id, parent.normalized_title
             FROM ancestry
             JOIN workspace_search_sections AS parent
               ON parent.workspace_id = ?1
              AND parent.section_id = ancestry.parent_section_id
         ),
         matched(section_id) AS (
             SELECT ancestry.target_id
             FROM ancestry
             GROUP BY ancestry.target_id
             HAVING {having}
         )
         SELECT {TITLE_HIT_COLUMNS}
         FROM recent
         JOIN matched ON matched.section_id = recent.section_id
         JOIN workspace_search_sections AS s
           ON s.workspace_id = ?1 AND s.section_id = recent.section_id
         JOIN workspace_search_documents AS d
           ON d.workspace_id = s.workspace_id AND d.note_id = s.note_id
         ORDER BY d.updated_at DESC, d.note_id, s.section_order
         LIMIT ?{limit_parameter}"
    );
    let mut parameters = vec![Value::Text(request.workspace_id.clone())];
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.extend(request.normalized_terms.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn query_body_indexed(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
    table: &str,
    match_expression: &str,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    // Most interactive queries match several recent rows. Search a bounded
    // recency prefix first: when it fills the requested limit, every omitted
    // row is older, so this is already the exact global updated-at order. A
    // sparse query falls through to FTS and preserves completeness.
    let recent = query_recent_body_prefix(connection, request)?;
    if recent.len() as i64 >= request.limit {
        return Ok(recent);
    }
    let predicates = body_search_term_predicates(request, 3, "b");
    let exclusion_parameter = request.normalized_terms.len() + 3;
    let exclusion = excluded_note_predicate(request, "b", exclusion_parameter);
    let limit_parameter = exclusion_parameter + request.excluded_note_ids.len();
    let sql = format!(
        "SELECT {BODY_HIT_COLUMNS}
         FROM workspace_search_body_rows AS b
         JOIN {table} ON {table}.rowid = b.row_id
         JOIN workspace_search_documents AS d
           ON d.workspace_id = b.workspace_id AND d.note_id = b.note_id
         JOIN workspace_search_sections AS s
           ON s.workspace_id = b.workspace_id AND s.section_id = b.section_id
         WHERE b.workspace_id = ?1
           AND {table} MATCH ?2
           AND {predicates}
           {exclusion}
         ORDER BY d.updated_at DESC, d.note_id, b.block_order
         LIMIT ?{limit_parameter}"
    );
    let mut parameters = vec![
        Value::Text(request.workspace_id.clone()),
        Value::Text(match_expression.to_owned()),
    ];
    parameters.extend(request.normalized_terms.iter().cloned().map(Value::Text));
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn query_recent_body_prefix(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    let exclusion = excluded_note_predicate(request, "d", 2);
    let term_parameter = request.excluded_note_ids.len() + 2;
    let predicates = body_search_term_predicates(request, term_parameter, "b");
    let limit_parameter = term_parameter + request.normalized_terms.len();
    let sql = format!(
        "SELECT {BODY_HIT_COLUMNS}
         FROM (
             SELECT b.row_id
             FROM workspace_search_documents AS d
                  INDEXED BY workspace_search_documents_recency
             JOIN workspace_search_body_rows AS b
                  INDEXED BY workspace_search_body_note_order
               ON b.workspace_id = d.workspace_id AND b.note_id = d.note_id
             WHERE d.workspace_id = ?1
             {exclusion}
             ORDER BY d.updated_at DESC, d.note_id, b.block_order
             LIMIT {RECENT_SEARCH_PREFIX_ROWS}
         ) AS recent
         JOIN workspace_search_body_rows AS b ON b.row_id = recent.row_id
         JOIN workspace_search_documents AS d
           ON d.workspace_id = b.workspace_id AND d.note_id = b.note_id
         JOIN workspace_search_sections AS s
           ON s.workspace_id = b.workspace_id AND s.section_id = b.section_id
         WHERE {predicates}
         ORDER BY d.updated_at DESC, d.note_id, b.block_order
         LIMIT ?{limit_parameter}"
    );
    let mut parameters = vec![Value::Text(request.workspace_id.clone())];
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.extend(request.normalized_terms.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn query_scan(
    connection: &Connection,
    request: &SearchIndexQueryRequest,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    if request.scope == "title" {
        return query_title_terms(connection, request, None);
    }
    let predicates = body_search_term_predicates(request, 2, "b");
    let exclusion_parameter = request.normalized_terms.len() + 2;
    let exclusion = excluded_note_predicate(request, "b", exclusion_parameter);
    let limit_parameter = exclusion_parameter + request.excluded_note_ids.len();
    let sql = format!(
        "SELECT {BODY_HIT_COLUMNS}
         FROM workspace_search_body_rows AS b
         JOIN workspace_search_documents AS d
           ON d.workspace_id = b.workspace_id AND d.note_id = b.note_id
         JOIN workspace_search_sections AS s
           ON s.workspace_id = b.workspace_id AND s.section_id = b.section_id
         WHERE b.workspace_id = ?1 AND {predicates}
         {exclusion}
         ORDER BY d.updated_at DESC, d.note_id, b.block_order
         LIMIT ?{limit_parameter}"
    );
    let mut parameters = vec![Value::Text(request.workspace_id.clone())];
    parameters.extend(request.normalized_terms.iter().cloned().map(Value::Text));
    parameters.extend(request.excluded_note_ids.iter().cloned().map(Value::Text));
    parameters.push(Value::Integer(request.limit));
    let mut statement = connection.prepare(&sql)?;
    read_hits(&mut statement, params_from_iter(parameters.iter()))
}

fn excluded_note_predicate(
    request: &SearchIndexQueryRequest,
    alias: &str,
    first_parameter: usize,
) -> String {
    if request.excluded_note_ids.is_empty() {
        return String::new();
    }
    let parameters = (0..request.excluded_note_ids.len())
        .map(|index| format!("?{}", first_parameter + index))
        .collect::<Vec<_>>()
        .join(", ");
    format!("AND {alias}.note_id NOT IN ({parameters})")
}

fn body_search_term_predicates(
    request: &SearchIndexQueryRequest,
    first_parameter: usize,
    alias: &str,
) -> String {
    request
        .normalized_terms
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let parameter = first_parameter + index;
            format!("instr({alias}.normalized_text, ?{parameter}) > 0")
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn hydrate_parent_paths(
    connection: &Connection,
    workspace_id: &str,
    hits: &mut [SearchIndexHit],
) -> Result<(), PersistenceError> {
    let mut nodes = HashMap::<String, (Option<String>, String)>::new();
    let mut statement = connection.prepare_cached(
        "SELECT parent_section_id, title
         FROM workspace_search_sections
         WHERE workspace_id = ?1 AND section_id = ?2",
    )?;
    for hit in hits {
        let mut current_id = hit.section_id.clone();
        let mut seen = HashSet::new();
        let mut parts = Vec::new();
        loop {
            if !seen.insert(current_id.clone()) {
                return Err(PersistenceError::InvalidInput(
                    "search hierarchy contains a cycle".to_owned(),
                ));
            }
            let node = if let Some(cached) = nodes.get(&current_id) {
                cached.clone()
            } else {
                let loaded = statement
                    .query_row(params![workspace_id, current_id], |row| {
                        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
                    })
                    .optional()?
                    .ok_or_else(|| {
                        PersistenceError::InvalidInput(format!(
                            "search result refers to an unknown Section: {current_id}"
                        ))
                    })?;
                nodes.insert(current_id.clone(), loaded.clone());
                loaded
            };
            let Some(parent_id) = node.0 else {
                break;
            };
            let parent = if let Some(cached) = nodes.get(&parent_id) {
                cached.clone()
            } else {
                let loaded = statement
                    .query_row(params![workspace_id, parent_id], |row| {
                        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
                    })
                    .optional()?
                    .ok_or_else(|| {
                        PersistenceError::InvalidInput(format!(
                            "search hierarchy refers to an unknown parent: {parent_id}"
                        ))
                    })?;
                nodes.insert(parent_id.clone(), loaded.clone());
                loaded
            };
            parts.push(parent.1.clone());
            current_id = parent_id;
        }
        parts.reverse();
        hit.parent_path = if parts.is_empty() {
            "/".to_owned()
        } else {
            format!("/{}", parts.join("/"))
        };
    }
    Ok(())
}

fn read_hits<P: Params>(
    statement: &mut Statement<'_>,
    parameters: P,
) -> Result<Vec<SearchIndexHit>, PersistenceError> {
    statement
        .query_map(parameters, |row| {
            Ok(SearchIndexHit {
                result_id: row.get(0)?,
                note_id: row.get(1)?,
                section_id: row.get(2)?,
                title: row.get(3)?,
                parent_path: row.get(4)?,
                updated_at: row.get(5)?,
                kind: row.get(6)?,
                text: row.get(7)?,
                block_id: row.get(8)?,
                logical_line_number: row.get(9)?,
                section_line_number: row.get(10)?,
                line_index: row.get(11)?,
                source_offset: row.get(12)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn drop_derived_tables_impl(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "
        DROP TABLE IF EXISTS workspace_search_body_japanese_grams;
        DROP TABLE IF EXISTS workspace_search_body_trigram;
        DROP TABLE IF EXISTS workspace_search_title_japanese_grams;
        DROP TABLE IF EXISTS workspace_search_title_trigram;
        DROP TABLE IF EXISTS workspace_search_body_rows;
        DROP TABLE IF EXISTS workspace_search_sections;
        DROP TABLE IF EXISTS workspace_search_japanese_grams;
        DROP TABLE IF EXISTS workspace_search_trigram;
        DROP TABLE IF EXISTS workspace_search_rows;
        DROP TABLE IF EXISTS workspace_search_documents;
        DROP TABLE IF EXISTS workspace_search_state;
        ",
    )?;
    Ok(())
}

#[cfg(test)]
pub fn drop_derived_tables(connection: &Connection) -> Result<(), PersistenceError> {
    drop_derived_tables_impl(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{DocumentCommitInput, PersistenceCommitRequest, ProductStore};
    use std::time::Instant;
    use tempfile::TempDir;

    fn connection_with_sources(note_count: usize) -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE documents (
                    kind TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    PRIMARY KEY (kind, document_id)
                );
                CREATE TABLE workspace_search_invalidations (
                    kind TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    source_revision INTEGER NOT NULL,
                    PRIMARY KEY (kind, document_id)
                );
                INSERT INTO documents (kind, document_id, revision)
                VALUES ('workspace', 'workspace-1', 1);
                ",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO documents (kind, document_id, revision) VALUES ('note', ?1, 1)",
                )
                .unwrap();
            for index in 0..note_count {
                insert.execute([format!("note-{index}")]).unwrap();
            }
        }
        transaction.commit().unwrap();
        connection
    }

    fn document(
        note_id: &str,
        title: &str,
        _parent_path: &str,
        body: &str,
        revision: i64,
    ) -> SearchIndexDocumentInput {
        SearchIndexDocumentInput {
            note_id: note_id.to_owned(),
            parent_note_id: None,
            updated_at: "2026-08-10T00:00:00.000Z".to_owned(),
            source_revision: revision,
            sections: vec![SearchIndexSectionInput {
                section_id: note_id.to_owned(),
                parent_section_id: None,
                title: title.to_owned(),
                normalized_title: title.to_lowercase(),
                title_japanese_grams: japanese_grams(title),
                order: 0,
            }],
            blocks: vec![SearchIndexBlockInput {
                block_id: format!("block-{note_id}"),
                kind: "body".to_owned(),
                section_id: note_id.to_owned(),
                text: body.to_owned(),
                normalized_text: body.to_lowercase(),
                japanese_grams: japanese_grams(body),
                logical_line_number: 1,
                section_line_number: 1,
                line_index: 0,
                source_offset: 0,
            }],
        }
    }

    fn japanese_grams(value: &str) -> String {
        let characters = value.chars().collect::<Vec<_>>();
        let mut grams = Vec::new();
        for (index, character) in characters.iter().enumerate() {
            if matches!(*character, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}') {
                grams.push(character.to_string());
                if let Some(next) = characters.get(index + 1)
                    && matches!(*next, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}')
                {
                    grams.push(format!("{character}{next}"));
                }
            }
        }
        grams.sort();
        grams.dedup();
        grams.join(" ")
    }

    #[test]
    fn updates_one_hierarchy_row_and_projects_descendant_paths_at_query_time() {
        let mut connection = connection_with_sources(2);
        let parent = document("note-0", "Old", "/", "parent body", 1);
        let mut child = document("note-1", "Child", "/Old", "child body", 1);
        child.parent_note_id = Some("note-0".to_owned());
        rebuild(
            &mut connection,
            &SearchIndexRebuildRequest {
                schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                workspace_id: "workspace-1".to_owned(),
                workspace_revision: 1,
                documents: vec![parent, child],
            },
        )
        .unwrap();
        let body_row_ids_before = connection
            .prepare("SELECT row_id FROM workspace_search_body_rows ORDER BY row_id")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        connection
            .execute(
                "UPDATE documents SET revision = 2
                 WHERE kind = 'workspace' AND document_id = 'workspace-1'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace_search_invalidations (
                    kind, document_id, source_revision
                 ) VALUES ('workspace', 'workspace-1', 2)",
                [],
            )
            .unwrap();

        assert_eq!(
            update_hierarchy(
                &mut connection,
                &SearchIndexHierarchyUpdateRequest {
                    schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                    workspace_id: "workspace-1".to_owned(),
                    base_revision: 1,
                    workspace_revision: 2,
                    entries: vec![SearchIndexHierarchyEntry {
                        note_id: "note-0".to_owned(),
                        parent_note_id: None,
                        title: "新親".to_owned(),
                        normalized_title: "新親".to_owned(),
                        title_japanese_grams: japanese_grams("新親"),
                    }],
                },
            )
            .unwrap(),
            "updated"
        );
        let response = query(
            &mut connection,
            &SearchIndexQueryRequest {
                schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                workspace_id: "workspace-1".to_owned(),
                workspace_revision: 2,
                query: "新親".to_owned(),
                scope: "title".to_owned(),
                normalized_terms: vec!["新親".to_owned()],
                strategy: "japanese-gram".to_owned(),
                match_expression: "\"新親\"".to_owned(),
                limit: 20,
                excluded_note_ids: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(response.status, "ready");
        let child = response
            .hits
            .iter()
            .find(|hit| hit.note_id == "note-1")
            .unwrap();
        assert_eq!(child.parent_path, "/新親");
        let child_body = query(
            &mut connection,
            &query_request_at_revision("child body", "trigram", "body", 2),
        )
        .unwrap();
        assert_eq!(child_body.hits[0].note_id, "note-1");
        assert_eq!(child_body.hits[0].parent_path, "/新親");
        let body_rows: i64 = connection
            .query_row(
                "SELECT count(*) FROM workspace_search_body_rows",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(body_rows, 2);

        connection
            .execute_batch(
                "UPDATE documents SET revision = 3
                 WHERE kind = 'workspace' AND document_id = 'workspace-1';
                 INSERT INTO workspace_search_invalidations (
                    kind, document_id, source_revision
                 ) VALUES ('workspace', 'workspace-1', 3)
                 ON CONFLICT(kind, document_id) DO UPDATE SET source_revision = 3;",
            )
            .unwrap();
        assert_eq!(
            update_hierarchy(
                &mut connection,
                &SearchIndexHierarchyUpdateRequest {
                    schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                    workspace_id: "workspace-1".to_owned(),
                    base_revision: 2,
                    workspace_revision: 3,
                    entries: vec![SearchIndexHierarchyEntry {
                        note_id: "note-1".to_owned(),
                        parent_note_id: None,
                        title: "Child".to_owned(),
                        normalized_title: "child".to_owned(),
                        title_japanese_grams: String::new(),
                    }],
                },
            )
            .unwrap(),
            "updated"
        );
        let moved = query(
            &mut connection,
            &query_request_at_revision("Child", "trigram", "title", 3),
        )
        .unwrap();
        assert_eq!(moved.hits[0].parent_path, "/");
        assert_eq!(
            query(
                &mut connection,
                &query_request_at_revision("child body", "trigram", "body", 3),
            )
            .unwrap()
            .hits[0]
                .parent_path,
            "/"
        );
        let body_row_ids_after = connection
            .prepare("SELECT row_id FROM workspace_search_body_rows ORDER BY row_id")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(body_row_ids_after, body_row_ids_before);

        let section_rows_before = connection
            .prepare(
                "SELECT row_id, section_id, parent_section_id, title
                 FROM workspace_search_sections ORDER BY row_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        connection
            .execute_batch(
                "UPDATE documents SET revision = 4
                 WHERE kind = 'workspace' AND document_id = 'workspace-1';
                 INSERT INTO workspace_search_invalidations (
                    kind, document_id, source_revision
                 ) VALUES ('workspace', 'workspace-1', 4)
                 ON CONFLICT(kind, document_id) DO UPDATE SET source_revision = 4;",
            )
            .unwrap();
        assert_eq!(
            update_hierarchy(
                &mut connection,
                &SearchIndexHierarchyUpdateRequest {
                    schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                    workspace_id: "workspace-1".to_owned(),
                    base_revision: 3,
                    workspace_revision: 4,
                    entries: Vec::new(),
                },
            )
            .unwrap(),
            "updated"
        );
        let section_rows_after = connection
            .prepare(
                "SELECT row_id, section_id, parent_section_id, title
                 FROM workspace_search_sections ORDER BY row_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(section_rows_after, section_rows_before);
        assert_eq!(
            query(
                &mut connection,
                &query_request_at_revision("Child", "trigram", "title", 4),
            )
            .unwrap()
            .status,
            "ready"
        );
    }

    fn rebuild_request(documents: Vec<SearchIndexDocumentInput>) -> SearchIndexRebuildRequest {
        SearchIndexRebuildRequest {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            workspace_revision: 1,
            documents,
        }
    }

    fn source_commit(
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

    fn query_request_at_revision(
        query: &str,
        strategy: &str,
        scope: &str,
        workspace_revision: i64,
    ) -> SearchIndexQueryRequest {
        let mut request = query_request(query, strategy, scope);
        request.workspace_revision = workspace_revision;
        request
    }

    fn query_request(query: &str, strategy: &str, scope: &str) -> SearchIndexQueryRequest {
        let normalized_terms = query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        SearchIndexQueryRequest {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            workspace_revision: 1,
            query: query.to_owned(),
            scope: scope.to_owned(),
            normalized_terms: normalized_terms.clone(),
            strategy: strategy.to_owned(),
            match_expression: normalized_terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND "),
            limit: 20,
            excluded_note_ids: Vec::new(),
        }
    }

    #[test]
    fn treats_the_previous_visible_text_projection_as_stale() {
        assert_eq!(SEARCH_INDEX_SCHEMA_VERSION, 8);
        let mut connection = connection_with_sources(1);
        rebuild(
            &mut connection,
            &rebuild_request(vec![document("note-0", "Link", "/", "visible label", 1)]),
        )
        .unwrap();
        connection
            .execute(
                "UPDATE workspace_search_state SET schema_version = 7 WHERE workspace_id = ?1",
                ["workspace-1"],
            )
            .unwrap();

        let response = query(
            &mut connection,
            &query_request("visible", "trigram", "body"),
        )
        .unwrap();
        assert_eq!(response.status, "stale");
        assert!(response.hits.is_empty());
    }

    #[test]
    fn rebuilds_queries_and_incrementally_replaces_crdt_projections() {
        let mut connection = connection_with_sources(2);
        let mut older = document(
            "note-0",
            "開発 Memoka",
            "開発 / Memoka",
            "本文に日本語の検索対象があります shared-order",
            1,
        );
        older.sections.push(SearchIndexSectionInput {
            section_id: "section-api".to_owned(),
            parent_section_id: Some("note-0".to_owned()),
            title: "API設計".to_owned(),
            normalized_title: "api設計".to_owned(),
            title_japanese_grams: japanese_grams("API設計"),
            order: 1,
        });
        older.blocks[0].section_id = "section-api".to_owned();
        let mut newer = document(
            "note-1",
            "日記",
            "個人",
            "transaction mid-token shared-order",
            1,
        );
        newer.updated_at = "2026-08-11T00:00:00.000Z".to_owned();
        rebuild(&mut connection, &rebuild_request(vec![older, newer])).unwrap();

        let title = query(&mut connection, &query_request("api", "trigram", "title")).unwrap();
        assert_eq!(title.status, "ready");
        assert_eq!(title.hits[0].result_id, "note-0:section:section-api:title");
        assert_eq!(
            query(
                &mut connection,
                &query_request("開発", "japanese-gram", "title")
            )
            .unwrap()
            .hits[0]
                .note_id,
            "note-0"
        );
        assert_eq!(
            query(
                &mut connection,
                &query_request("api memoka", "scan", "title")
            )
            .unwrap()
            .hits[0]
                .note_id,
            "note-0"
        );
        assert!(
            query(&mut connection, &query_request("", "empty", "body"))
                .unwrap()
                .hits
                .is_empty()
        );

        let body = query(&mut connection, &query_request("日本語", "trigram", "body")).unwrap();
        assert_eq!(body.hits[0].kind, "body");
        assert_eq!(body.hits[0].note_id, "note-0");

        for short in ["本", "本語"] {
            let result = query(
                &mut connection,
                &query_request(short, "japanese-gram", "body"),
            )
            .unwrap();
            assert_eq!(result.hits[0].note_id, "note-0");
        }
        assert_eq!(
            query(
                &mut connection,
                &query_request("shared-order", "trigram", "body")
            )
            .unwrap()
            .hits
            .iter()
            .map(|hit| hit.note_id.as_str())
            .collect::<Vec<_>>(),
            vec!["note-1", "note-0"]
        );

        connection
            .execute_batch(
                "
                UPDATE documents SET revision = 2
                WHERE kind = 'note' AND document_id = 'note-0';
                INSERT INTO workspace_search_invalidations (
                    kind, document_id, source_revision
                ) VALUES ('note', 'note-0', 2);
                ",
            )
            .unwrap();
        assert_eq!(
            query(&mut connection, &query_request("日本語", "trigram", "body"))
                .unwrap()
                .status,
            "stale"
        );

        let replace = SearchIndexReplaceRequest {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            workspace_revision: 1,
            document: document("note-0", "API設計", "開発", "更新済み本文 shared-order", 2),
        };
        assert_eq!(
            replace_document(&mut connection, &replace).unwrap(),
            "updated"
        );
        let updated = query(&mut connection, &query_request("更新済", "trigram", "body")).unwrap();
        assert_eq!(updated.hits[0].note_id, "note-0");
        assert!(
            query(&mut connection, &query_request("日本語", "trigram", "body"))
                .unwrap()
                .hits
                .is_empty()
        );
        assert_eq!(
            query(
                &mut connection,
                &query_request("shared-order", "trigram", "body")
            )
            .unwrap()
            .hits
            .iter()
            .map(|hit| hit.note_id.as_str())
            .collect::<Vec<_>>(),
            vec!["note-1", "note-0"]
        );
    }

    #[test]
    fn source_commit_atomically_invalidates_the_product_index() {
        let directory = TempDir::new().unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        store
            .commit(&source_commit(
                "op-create",
                vec![
                    DocumentCommitInput {
                        kind: "workspace".to_owned(),
                        document_id: "workspace-1".to_owned(),
                        schema_version: 2,
                        base_revision: 0,
                        snapshot: Some(b"workspace".to_vec()),
                        update: None,
                    },
                    DocumentCommitInput {
                        kind: "note".to_owned(),
                        document_id: "note-0".to_owned(),
                        schema_version: 2,
                        base_revision: 0,
                        snapshot: Some(b"note".to_vec()),
                        update: None,
                    },
                ],
            ))
            .unwrap();
        store
            .rebuild_workspace_search_index(&rebuild_request(vec![document(
                "note-0",
                "Product",
                "root",
                "durable body",
                1,
            )]))
            .unwrap();
        assert_eq!(
            store
                .query_workspace_search_index(&query_request("durable", "trigram", "body"))
                .unwrap()
                .status,
            "ready"
        );

        store
            .commit(&source_commit(
                "op-update",
                vec![DocumentCommitInput {
                    kind: "note".to_owned(),
                    document_id: "note-0".to_owned(),
                    schema_version: 2,
                    base_revision: 1,
                    snapshot: None,
                    update: Some(b"delta".to_vec()),
                }],
            ))
            .unwrap();
        assert_eq!(
            store
                .query_workspace_search_index(&query_request("durable", "trigram", "body"))
                .unwrap()
                .status,
            "stale"
        );

        let replace = SearchIndexReplaceRequest {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            workspace_revision: 1,
            document: document("note-0", "Product", "root", "updated durable", 2),
        };
        assert_eq!(
            store
                .replace_workspace_search_index_document(&replace)
                .unwrap(),
            "updated"
        );
        assert_eq!(
            store
                .query_workspace_search_index(&query_request("updated", "trigram", "body"))
                .unwrap()
                .status,
            "ready"
        );
    }

    #[test]
    fn metadata_only_workspace_commit_keeps_one_note_replace_incremental() {
        let directory = TempDir::new().unwrap();
        let mut store = ProductStore::open(directory.path()).unwrap();
        store
            .commit(&source_commit(
                "op-create-metadata-bridge",
                vec![
                    DocumentCommitInput {
                        kind: "workspace".to_owned(),
                        document_id: "workspace-1".to_owned(),
                        schema_version: 2,
                        base_revision: 0,
                        snapshot: Some(b"workspace".to_vec()),
                        update: None,
                    },
                    DocumentCommitInput {
                        kind: "note".to_owned(),
                        document_id: "note-0".to_owned(),
                        schema_version: 2,
                        base_revision: 0,
                        snapshot: Some(b"note".to_vec()),
                        update: None,
                    },
                ],
            ))
            .unwrap();
        store
            .rebuild_workspace_search_index(&rebuild_request(vec![document(
                "note-0",
                "Product",
                "root",
                "durable body",
                1,
            )]))
            .unwrap();

        let mut edit = source_commit(
            "op-metadata-bridge-edit",
            vec![
                DocumentCommitInput {
                    kind: "workspace".to_owned(),
                    document_id: "workspace-1".to_owned(),
                    schema_version: 2,
                    base_revision: 1,
                    snapshot: None,
                    update: Some(b"timestamp".to_vec()),
                },
                DocumentCommitInput {
                    kind: "note".to_owned(),
                    document_id: "note-0".to_owned(),
                    schema_version: 2,
                    base_revision: 1,
                    snapshot: None,
                    update: Some(b"delta".to_vec()),
                },
            ],
        );
        edit.search_index_metadata_only_note_id = Some("note-0".to_owned());
        store.commit(&edit).unwrap();

        assert_eq!(
            store
                .query_workspace_search_index(&query_request_at_revision(
                    "durable", "trigram", "body", 2,
                ))
                .unwrap()
                .status,
            "stale"
        );
        let mut partial = query_request_at_revision("durable", "trigram", "body", 2);
        partial.excluded_note_ids = vec!["note-0".to_owned()];
        let partial_response = store.query_workspace_search_index(&partial).unwrap();
        assert_eq!(partial_response.status, "ready");
        assert!(partial_response.hits.is_empty());
        let replace = SearchIndexReplaceRequest {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            workspace_revision: 2,
            document: document("note-0", "Product", "root", "fast updated body", 2),
        };
        assert_eq!(
            store
                .replace_workspace_search_index_document(&replace)
                .unwrap(),
            "updated"
        );
        assert_eq!(
            store
                .query_workspace_search_index(&query_request_at_revision(
                    "updated", "trigram", "body", 2,
                ))
                .unwrap()
                .status,
            "ready"
        );
    }

    #[test]
    fn recreates_deleted_derived_tables_without_changing_source_documents() {
        let mut connection = connection_with_sources(1);
        let request = rebuild_request(vec![document(
            "note-0",
            "再構築",
            "root",
            "消しても戻る検索本文",
            1,
        )]);
        rebuild(&mut connection, &request).unwrap();
        drop_derived_tables(&connection).unwrap();
        rebuild(&mut connection, &request).unwrap();

        let result = query(
            &mut connection,
            &query_request("検索本文", "trigram", "body"),
        )
        .unwrap();
        assert_eq!(result.hits[0].note_id, "note-0");
        let source_count: i64 = connection
            .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!(source_count, 2);
    }

    #[test]
    fn rebuilds_legacy_duplicate_block_ids_with_unique_logical_row_ids() {
        let mut connection = connection_with_sources(1);
        let mut indexed = document(
            "note-0",
            "duplicate legacy IDs",
            "/",
            "first duplicate needle",
            1,
        );
        let mut second = indexed.blocks[0].clone();
        second.text = "second duplicate needle".to_owned();
        second.normalized_text = second.text.clone();
        second.japanese_grams = japanese_grams(&second.text);
        second.logical_line_number = 2;
        second.section_line_number = 2;
        indexed.blocks.push(second);

        rebuild(&mut connection, &rebuild_request(vec![indexed])).unwrap();
        let response = query(
            &mut connection,
            &query_request("duplicate needle", "trigram", "body"),
        )
        .unwrap();
        assert_eq!(response.status, "ready");
        assert_eq!(response.hits.len(), 2);
        assert_eq!(response.hits[0].result_id, "note-0:body:line:1");
        assert_eq!(response.hits[1].result_id, "note-0:body:line:2");
        assert_eq!(response.hits[1].section_line_number, Some(2));
    }

    #[test]
    fn allocates_fts_row_ids_across_multiple_workspace_projections() {
        let mut connection = connection_with_sources(1);
        rebuild(
            &mut connection,
            &rebuild_request(vec![document(
                "note-0",
                "First workspace",
                "/",
                "first-workspace-body",
                1,
            )]),
        )
        .unwrap();
        connection
            .execute_batch(
                "INSERT INTO documents (kind, document_id, revision) VALUES
                    ('workspace', 'workspace-2', 1),
                    ('note', 'note-workspace-2', 1);",
            )
            .unwrap();
        rebuild(
            &mut connection,
            &SearchIndexRebuildRequest {
                schema_version: SEARCH_INDEX_SCHEMA_VERSION,
                workspace_id: "workspace-2".to_owned(),
                workspace_revision: 1,
                documents: vec![document(
                    "note-workspace-2",
                    "Second workspace",
                    "/",
                    "second-workspace-body",
                    1,
                )],
            },
        )
        .unwrap();

        for table in ["workspace_search_sections", "workspace_search_body_rows"] {
            let row_count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            let unique_row_count: i64 = connection
                .query_row(
                    &format!("SELECT count(DISTINCT row_id) FROM {table}"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(row_count, 2);
            assert_eq!(unique_row_count, row_count);
        }

        let mut second_query = query_request("second-workspace", "trigram", "body");
        second_query.workspace_id = "workspace-2".to_owned();
        let second = query(&mut connection, &second_query).unwrap();
        assert_eq!(second.status, "ready");
        assert_eq!(second.hits[0].note_id, "note-workspace-2");

        let first = query(
            &mut connection,
            &query_request("first-workspace", "trigram", "body"),
        )
        .unwrap();
        assert_eq!(first.status, "ready");
        assert_eq!(first.hits[0].note_id, "note-0");
    }

    #[test]
    fn indexed_query_falls_back_for_a_sparse_match_beyond_the_recent_prefix() {
        let note_count = RECENT_SEARCH_PREFIX_ROWS as usize + 1;
        let mut connection = connection_with_sources(note_count);
        let documents = (0..note_count)
            .map(|index| {
                document(
                    &format!("note-{index}"),
                    &format!("Note {index}"),
                    "/",
                    if index + 1 == note_count {
                        "sparse-target-beyond-prefix"
                    } else {
                        "ordinary body"
                    },
                    1,
                )
            })
            .collect();
        rebuild(&mut connection, &rebuild_request(documents)).unwrap();

        let response = query(
            &mut connection,
            &query_request("target-beyond", "trigram", "body"),
        )
        .unwrap();
        assert_eq!(response.status, "ready");
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].note_id, format!("note-{}", note_count - 1));
    }

    #[test]
    fn discards_legacy_denormalized_rows_and_creates_v8_tables() {
        let connection = connection_with_sources(0);
        connection
            .execute_batch(
                "
                CREATE TABLE workspace_search_rows (
                    row_id INTEGER PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    result_id TEXT NOT NULL,
                    note_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    normalized_title TEXT NOT NULL,
                    parent_path TEXT NOT NULL,
                    normalized_parent_path TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    normalized_text TEXT NOT NULL,
                    block_id TEXT,
                    heading_id TEXT,
                    document_order INTEGER NOT NULL,
                    block_order INTEGER NOT NULL
                );
                ",
            )
            .unwrap();
        ensure_schema(&connection).unwrap();
        assert!(!table_exists(&connection, "workspace_search_rows").unwrap());
        let mut statement = connection
            .prepare("PRAGMA table_info(workspace_search_body_rows)")
            .unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for expected in [
            "logical_line_number",
            "section_line_number",
            "line_index",
            "source_offset",
        ] {
            assert!(columns.iter().any(|column| column == expected));
        }
        assert!(!columns.iter().any(|column| column == "parent_path"));
        assert!(!columns.iter().any(|column| column == "updated_at"));
        let section_columns = connection
            .prepare("PRAGMA table_info(workspace_search_sections)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!section_columns.iter().any(|column| column == "path_title"));
        assert!(
            !section_columns
                .iter()
                .any(|column| column == "normalized_path_title")
        );
        assert!(table_has_column(&connection, "workspace_search_documents", "updated_at").unwrap());
    }

    #[test]
    fn rejects_a_rebuild_from_stale_source_revisions() {
        let mut connection = connection_with_sources(1);
        let request = rebuild_request(vec![document("note-0", "stale", "root", "body", 99)]);
        assert!(matches!(
            rebuild(&mut connection, &request),
            Err(PersistenceError::RevisionConflict { .. })
        ));
        ensure_schema(&connection).unwrap();
        let state_count: i64 = connection
            .query_row("SELECT count(*) FROM workspace_search_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(state_count, 0);
    }

    #[test]
    #[ignore = "manual 100k-note / 100MB product-scale SQLite FTS benchmark"]
    fn benchmark_100k_first_result() {
        const NOTE_COUNT: usize = 100_000;
        let mut connection = connection_with_sources(NOTE_COUNT);
        let body = "Memoka transaction workspace CRDT 日本語検索 ".repeat(20);
        let documents = (0..NOTE_COUNT)
            .map(|index| {
                document(
                    &format!("note-{index}"),
                    &format!("Memoka Note {index}"),
                    "benchmark",
                    &format!("note_token_{index} {body}"),
                    1,
                )
            })
            .collect();
        rebuild(&mut connection, &rebuild_request(documents)).unwrap();

        let mut measure = |request: &SearchIndexQueryRequest, expected: usize| {
            let mut timings = Vec::new();
            for _ in 0..30 {
                let started = Instant::now();
                let response = query(&mut connection, request).unwrap();
                assert_eq!(response.hits.len(), expected);
                timings.push(started.elapsed().as_secs_f64() * 1_000.0);
            }
            timings.sort_by(f64::total_cmp);
            (
                timings[timings.len() / 2],
                timings[((timings.len() as f64 * 0.95).ceil() as usize) - 1],
                timings[timings.len() - 1],
            )
        };
        let body = measure(&query_request("日本語検索", "trigram", "body"), 20);
        let title_scan = measure(&query_request("m", "scan", "title"), 20);
        let title_sparse = measure(&query_request("99999", "trigram", "title"), 1);
        eprintln!(
            "workspace_search_100k note_count={NOTE_COUNT} \
             body_p50_ms={:.3} body_p95_ms={:.3} body_max_ms={:.3} \
             title_scan_p50_ms={:.3} title_scan_p95_ms={:.3} title_scan_max_ms={:.3} \
             title_sparse_p50_ms={:.3} title_sparse_p95_ms={:.3} title_sparse_max_ms={:.3}",
            body.0,
            body.1,
            body.2,
            title_scan.0,
            title_scan.1,
            title_scan.2,
            title_sparse.0,
            title_sparse.1,
            title_sparse.2,
        );
        for (name, p95) in [
            ("body", body.1),
            ("title scan", title_scan.1),
            ("title sparse", title_sparse.1),
        ] {
            assert!(p95 < 100.0, "{name} first-result p95 was {p95:.3}ms");
        }
    }
}
