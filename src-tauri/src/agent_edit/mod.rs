//! ID-scoped, optimistic editing. This is shared by the GUI Core gateway and
//! the lease-owning standalone CLI; it never edits a live frontend document.
pub mod bridge;
mod markdown;
mod notes;
mod projection;
mod sections;
pub use notes::{NoteAction, NoteRequest};
pub use sections::{SectionAction, SectionRequest};

use crate::document_model::{ReadError, decode_document, read_note};
use crate::persistence::{DocumentCommitInput, PersistenceCommitRequest, ProductStore};
use crate::read_service::{WorkspaceReader, hex};
use crate::workspace_migration::load_document;
use rusqlite::{Connection, OptionalExtension, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use yrs::{Map, ReadTxn, StateVector, Transact};

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_EDITS: usize = 100;
pub const MAX_DIFF_BYTES: usize = 64 * 1024;
pub const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_NEW_BLOCKS: usize = 10_000;

/// Public editing envelopes use one owner, durable receipt, and GUI
/// delivery boundary. Untagged serialization preserves existing receipt hashes.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum AgentRequest {
    Body(EditRequest),
    Note(NoteRequest),
    Section(SectionRequest),
}
impl From<EditRequest> for AgentRequest {
    fn from(value: EditRequest) -> Self {
        Self::Body(value)
    }
}
impl From<NoteRequest> for AgentRequest {
    fn from(value: NoteRequest) -> Self {
        Self::Note(value)
    }
}
impl From<SectionRequest> for AgentRequest {
    fn from(value: SectionRequest) -> Self {
        Self::Section(value)
    }
}
impl AgentRequest {
    pub fn workspace_id(&self) -> &str {
        match self {
            Self::Body(r) => &r.workspace_id,
            Self::Note(r) => &r.workspace_id,
            Self::Section(r) => &r.workspace_id,
        }
    }
    pub fn request_id(&self) -> &str {
        match self {
            Self::Body(r) => &r.request_id,
            Self::Note(r) => &r.request_id,
            Self::Section(r) => &r.request_id,
        }
    }
    pub fn replica_id(&self) -> Option<&str> {
        match self {
            Self::Body(r) => r.replica_id.as_deref(),
            Self::Note(r) => r.replica_id.as_deref(),
            Self::Section(r) => r.replica_id.as_deref(),
        }
    }
    pub fn note_id(&self) -> Option<&str> {
        match self {
            Self::Body(r) => Some(&r.note_id),
            Self::Note(r) => r.action.note_id(),
            Self::Section(r) => Some(&r.note_id),
        }
    }
    pub fn expected_note_revision(&self) -> Option<i64> {
        match self {
            Self::Body(r) => Some(r.expected_revision),
            Self::Section(r) => Some(r.expected_revision),
            Self::Note(r) => match r.action {
                NoteAction::Rename {
                    expected_revision, ..
                } => Some(expected_revision),
                _ => None,
            },
        }
    }
    pub fn validate(&self) -> Result<(), ReadError> {
        match self {
            Self::Body(r) => r.validate(),
            Self::Note(r) => r.validate(),
            Self::Section(r) => r.validate(),
        }
    }
    pub fn identity(&self) -> Value {
        json!({"workspace_id":self.workspace_id(),"request_id":self.request_id(),"note_id":self.note_id(),"expected_revision":self.expected_note_revision()})
    }
    fn fingerprint(&self) -> Result<String, ReadError> {
        Ok(hex(&Sha256::digest(serde_json::to_vec(self)?)))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditRequest {
    /// Protocol version. Only 1 is accepted.
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u32,
    /// Lowercase UUIDv7 of the explicitly selected Workspace.
    pub workspace_id: String,
    /// Copy identity from the edit view. Required while synchronization is enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replica_id: Option<String>,
    /// Lowercase UUIDv7 of the Note (also its Root Section ID).
    pub note_id: String,
    /// Note-wide persisted revision from read --for-edit. No force/rebase.
    #[schemars(range(min = 1, max = 9_007_199_254_740_991_i64))]
    pub expected_revision: i64,
    /// Canonical lowercase UUIDv4 or UUIDv7. Reuse with identical content after an unknown outcome.
    pub request_id: String,
    /// Ordered operations, all resolved against the same base snapshot and committed atomically.
    #[schemars(length(min = 1, max = 100))]
    pub edits: Vec<Edit>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Edit {
    /// Unique exact literal match within one editable paragraph segment. Preserves marks and identity.
    ReplaceText {
        section_id: String,
        scope: BodyScope,
        /// Optional Paragraph ID inside the Section's direct Body (including nested containers).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        old_text: String,
        new_text: String,
    },
    /// Append supported Markdown blocks to the Section's direct Body, before its child Sections.
    AppendMarkdown {
        section_id: String,
        markdown: String,
    },
    /// Insert supported Markdown beside a top-level Body block. Nested block anchors are rejected.
    InsertMarkdown {
        section_id: String,
        anchor_block_id: String,
        position: InsertPosition,
        markdown: String,
    },
    /// Assign an existing task ListItem's state without changing its text or children.
    SetTaskChecked {
        section_id: String,
        block_id: String,
        checked: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BodyScope {
    Body,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum InsertPosition {
    Before,
    After,
}

impl Edit {
    pub fn section_id(&self) -> &str {
        match self {
            Self::ReplaceText { section_id, .. }
            | Self::AppendMarkdown { section_id, .. }
            | Self::InsertMarkdown { section_id, .. }
            | Self::SetTaskChecked { section_id, .. } => section_id,
        }
    }
}

pub fn invalid(message: &str) -> ReadError {
    ReadError::new("INVALID_REQUEST", message)
}
pub fn unsupported(message: &str) -> ReadError {
    ReadError::new("UNSUPPORTED_CONTENT", message)
}
pub fn validate_id(id: &str) -> Result<(), ReadError> {
    crate::attachment::validate_uuid_v7(id, "id")
        .map_err(|_| invalid("Entity IDs must be lowercase UUIDv7"))
}
impl EditRequest {
    pub fn validate(&self) -> Result<(), ReadError> {
        if let Some(id) = &self.replica_id {
            validate_id(id)?;
        }
        validate_note_envelope(
            self.schema_version,
            &self.workspace_id,
            &self.note_id,
            self.expected_revision,
            &self.request_id,
        )?;
        if self.edits.is_empty()
            || self.edits.len() > MAX_EDITS
            || serde_json::to_vec(self)?.len() > MAX_INPUT_BYTES
        {
            return Err(invalid(
                "Editing accepts 1–100 operations and at most 1 MiB",
            ));
        }
        for edit in &self.edits {
            validate_id(edit.section_id())?;
            match edit {
                Edit::ReplaceText {
                    block_id,
                    old_text,
                    new_text,
                    ..
                } => {
                    if let Some(id) = block_id {
                        validate_id(id)?;
                    }
                    if old_text.is_empty()
                        || old_text.contains(['\r', '\n'])
                        || new_text.contains(['\r', '\n'])
                    {
                        return Err(invalid(
                            "old_text must not be empty; text replacement cannot contain CR/LF",
                        ));
                    }
                }
                Edit::InsertMarkdown {
                    anchor_block_id, ..
                } => validate_id(anchor_block_id)?,
                Edit::SetTaskChecked { block_id, .. } => validate_id(block_id)?,
                _ => (),
            }
        }
        Ok(())
    }
}

fn validate_note_envelope(
    schema_version: u32,
    workspace_id: &str,
    note_id: &str,
    expected_revision: i64,
    request_id: &str,
) -> Result<(), ReadError> {
    if schema_version != 1 || !(1..=9_007_199_254_740_991).contains(&expected_revision) {
        return Err(invalid("Unsupported schema or invalid expected_revision"));
    }
    validate_id(workspace_id)?;
    validate_id(note_id)?;
    let id = uuid::Uuid::parse_str(request_id)
        .map_err(|_| invalid("request_id must be a UUIDv4 or UUIDv7"))?;
    if !matches!(id.get_version_num(), 4 | 7) || id.to_string() != request_id {
        return Err(invalid("request_id must be a canonical UUIDv4 or UUIDv7"));
    }
    Ok(())
}

/// Do not let serde_json::Value silently collapse duplicate object keys.
pub fn parse_request(bytes: &[u8]) -> Result<EditRequest, ReadError> {
    let request: EditRequest = parse_unique_request(bytes)?;
    request.validate()?;
    Ok(request)
}

pub fn parse_note_request(bytes: &[u8]) -> Result<NoteRequest, ReadError> {
    let request: NoteRequest = parse_unique_request(bytes)?;
    request.validate()?;
    Ok(request)
}

pub fn parse_section_request(bytes: &[u8]) -> Result<SectionRequest, ReadError> {
    let request: SectionRequest = parse_unique_request(bytes)?;
    request.validate()?;
    Ok(request)
}

pub(crate) fn parse_unique_request<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
) -> Result<T, ReadError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(invalid("Input exceeds 1 MiB"));
    }
    #[derive(Debug)]
    struct UniqueValue(Value);
    impl<'de> Deserialize<'de> for UniqueValue {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = UniqueValue;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("JSON without duplicate object keys")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut result = serde_json::Map::new();
                    while let Some((key, value)) = map.next_entry::<String, UniqueValue>()? {
                        if result.insert(key, value.0).is_some() {
                            return Err(serde::de::Error::custom("Duplicate object key"));
                        }
                    }
                    Ok(UniqueValue(Value::Object(result)))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut seq: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut result = Vec::new();
                    while let Some(value) = seq.next_element::<UniqueValue>()? {
                        result.push(value.0);
                    }
                    Ok(UniqueValue(Value::Array(result)))
                }
                fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
                    Ok(UniqueValue(v.into()))
                }
                fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                    Ok(UniqueValue(v.into()))
                }
                fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                    Ok(UniqueValue(v.into()))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                    Ok(UniqueValue(json!(v)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                    Ok(UniqueValue(v.into()))
                }
                fn visit_unit<E>(self) -> Result<Self::Value, E> {
                    Ok(UniqueValue(Value::Null))
                }
            }
            d.deserialize_any(Visitor)
        }
    }
    let value: UniqueValue = serde_json::from_slice(bytes)
        .map_err(|_| invalid("Invalid JSON, duplicate keys, or nesting limit exceeded"))?;
    serde_json::from_value(value.0).map_err(|e| invalid(&format!("Invalid edit request: {e}")))
}

pub fn schema() -> Value {
    json!({"schema_version":1,"cli_version":env!("CARGO_PKG_VERSION"),"request":schemars::schema_for!(EditRequest),"note_request":schemars::schema_for!(NoteRequest),"section_request":schemars::schema_for!(SectionRequest),
        "limits":{"input_bytes":MAX_INPUT_BYTES,"edits":MAX_EDITS,"diff_bytes":MAX_DIFF_BYTES,"new_blocks":MAX_NEW_BLOCKS,"result_bytes":MAX_RESULT_BYTES,"edit_view_block_bytes":256*1024,"edit_view_page_bytes":MAX_INPUT_BYTES},
        "read":"read --id ID --for-edit --format json [--workspace DIR] [--limit N] [--cursor CURSOR]",
        "edit":"edit --input FILE|- --format json [--workspace DIR] [--dry-run]",
        "note_edit":"note-edit --input FILE|- --format json [--workspace DIR] [--dry-run]",
        "section_edit":"section-edit --input FILE|- --format json [--workspace DIR] [--dry-run]",
        "section_limits":{"max_depth":crate::document_model::MAX_SECTION_DEPTH,"max_affected_nodes":MAX_NEW_BLOCKS,"max_subtree_bytes":sections::MAX_SUBTREE_BYTES,"root_depth":0}})
}

pub struct PreparedEdit {
    pub request: AgentRequest,
    pub fingerprint: String,
    pub documents: Vec<DocumentCommitInput>,
    pub result: Value,
    pub workspace_revision: i64,
    pub replayed: bool,
}

pub fn receipt(
    connection: &Connection,
    request: impl Into<AgentRequest>,
) -> Result<Option<Value>, ReadError> {
    let request = request.into();
    // Identity must be checked even for an existing receipt. A copied backup
    // cannot reuse the original copy's completed request or its revision.
    check_replica_binding(connection, request.replica_id())?;
    let row: Option<(String, String)> = connection.query_row(
        "SELECT request_hash,result_json FROM agent_edit_receipts WHERE workspace_id=?1 AND request_id=?2",
        params![request.workspace_id(), request.request_id()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(fingerprint, result)| {
        if fingerprint != request.fingerprint()? {
            return Err(ReadError::new(
                "REQUEST_ID_REUSED",
                "request_id was already committed with different content",
            ));
        }
        let mut result: Value = serde_json::from_str(&result)?;
        result["replayed"] = true.into();
        Ok(result)
    })
    .transpose()
}

pub(crate) fn check_replica_binding(
    connection: &Connection,
    requested: Option<&str>,
) -> Result<(), ReadError> {
    let replica: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key='replica_id'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let enabled: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key='replication_config')",
        [],
        |r| r.get(0),
    )?;
    if enabled && requested.is_none() {
        return Err(ReadError::new(
            "EDIT_REPLICA_REQUIRED",
            "Read this Workspace copy again and include its replica_id",
        ));
    }
    if requested.is_some() && requested != replica.as_deref() {
        return Err(ReadError::new(
            "EDIT_REPLICA_MISMATCH",
            "Editing request belongs to another Workspace copy",
        ));
    }
    Ok(())
}

pub(crate) fn require_edit_schema(reader: &WorkspaceReader) -> Result<(), ReadError> {
    let version: String = reader.connection.query_row(
        "SELECT value FROM settings WHERE key='database_schema_version'",
        [],
        |r| r.get(0),
    )?;
    if version != "6" && version != crate::workspace_migration::DATABASE_SCHEMA.to_string() {
        return Err(ReadError::new(
            "MIGRATION_REQUIRED",
            "Open this Workspace in the updated Memoka before editing",
        ));
    }
    Ok(())
}

fn editable_note_document(
    stored: &crate::persistence::PersistedDocument,
) -> Result<yrs::Doc, ReadError> {
    if stored.schema_version == crate::replicated_note::SCHEMA_VERSION {
        crate::replicated_note::edit::legacy_projection(&read_note(stored, false)?)
    } else {
        decode_document(stored)
    }
}
fn edited_note_view(
    stored: &crate::persistence::PersistedDocument,
    doc: &yrs::Doc,
) -> Result<crate::document_model::Note, ReadError> {
    read_note(
        &crate::persistence::PersistedDocument {
            schema_version: 6,
            snapshot: doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            snapshot_revision: stored.revision,
            updates: vec![],
            ..stored.clone()
        },
        false,
    )
}
fn local_replica_id(reader: &WorkspaceReader) -> Result<String, ReadError> {
    let id: Option<String> = reader
        .connection
        .query_row(
            "SELECT value FROM settings WHERE key='replica_id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        validate_id(&id)?;
        return Ok(id);
    }
    // Unsynchronized pre-migration copies have no enrollment identity. This
    // process-local author never authorizes a network connection.
    static LOCAL_REPLICA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    Ok(LOCAL_REPLICA
        .get_or_init(|| uuid::Uuid::now_v7().to_string())
        .clone())
}
fn edited_note_update(
    stored: &crate::persistence::PersistedDocument,
    doc: &yrs::Doc,
    vector: &StateVector,
    reader: &WorkspaceReader,
    now: &str,
) -> Result<Vec<u8>, ReadError> {
    if stored.schema_version == crate::replicated_note::SCHEMA_VERSION {
        crate::replicated_note::edit::reconcile(
            stored,
            &edited_note_view(stored, doc)?.root,
            &local_replica_id(reader)?,
            now,
        )
    } else {
        Ok(doc.transact().encode_state_as_update_v1(vector))
    }
}

fn live_note(reader: &WorkspaceReader, note_id: &str) -> Result<(), ReadError> {
    let note = reader
        .namespace
        .notes
        .get(note_id)
        .ok_or_else(|| ReadError::new("TARGET_NOT_FOUND", "Note not found"))?;
    if note["deleted_at"].is_string() || note["system_role"] == "help" {
        return Err(ReadError::new(
            "READ_ONLY_TARGET",
            "Trash and managed Help cannot be edited",
        ));
    }
    Ok(())
}

pub fn read_for_edit(
    workspace: &Path,
    id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Value, ReadError> {
    validate_id(id)?;
    let reader = WorkspaceReader::open(workspace)?;
    require_edit_schema(&reader)?;
    let ids: Vec<_> = if reader.document_revisions.contains_key(id) {
        vec![id.to_string()]
    } else {
        reader.document_revisions.keys().cloned().collect()
    };
    for note_id in ids {
        let stored = load_document(&reader.connection, "note", &note_id)?;
        let note = read_note(&stored, false)?;
        let doc = editable_note_document(&stored)?;
        let index = projection::Index::new(&doc)?;
        if index.sections.contains_key(id) {
            live_note(&reader, &note_id)?;
            if ![6, 7].contains(&stored.schema_version) {
                return Err(ReadError::new(
                    "MIGRATION_REQUIRED",
                    "Open this Note in the updated Memoka before editing",
                ));
            }
            let replica: Option<String> = reader
                .connection
                .query_row(
                    "SELECT value FROM settings WHERE key='replica_id'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let mut result = index.read(&doc, &note, &reader.workspace_id, id, limit, cursor)?;
            result["replica_id"] = json!(replica);
            return Ok(result);
        }
    }
    Err(ReadError::new(
        "TARGET_NOT_FOUND",
        "Note or Section not found",
    ))
}

pub fn prepare(
    workspace: &Path,
    request: impl Into<AgentRequest>,
) -> Result<PreparedEdit, ReadError> {
    let request = match request.into() {
        AgentRequest::Note(request) => return notes::prepare(workspace, request),
        AgentRequest::Section(request) => return sections::prepare(workspace, request),
        AgentRequest::Body(request) => request,
    };
    request.validate()?;
    let reader = WorkspaceReader::open(workspace)?;
    require_edit_schema(&reader)?;
    if reader.workspace_id != request.workspace_id {
        return Err(ReadError::new(
            "WORKSPACE_MISMATCH",
            "Workspace identity does not match the request",
        ));
    }
    let fingerprint = AgentRequest::from(request.clone()).fingerprint()?;
    if let Some(result) = receipt(&reader.connection, request.clone())? {
        return Ok(PreparedEdit {
            request: request.into(),
            fingerprint,
            documents: vec![],
            result,
            workspace_revision: reader.workspace_revision,
            replayed: true,
        });
    }
    live_note(&reader, &request.note_id)?;
    let stored = load_document(&reader.connection, "note", &request.note_id)?;
    if ![6, 7].contains(&stored.schema_version) {
        return Err(ReadError::new(
            "MIGRATION_REQUIRED",
            "Open this Note in the updated Memoka before editing",
        ));
    }
    check_revision(request.expected_revision, stored.revision)?;
    let before = read_note(&stored, false)?;
    let doc = editable_note_document(&stored)?;
    let vector = doc.transact().state_vector();
    let index = projection::Index::new(&doc)?;
    let changes = index.plan(&doc, &reader, &request)?;
    let applied_edits = changes.changed_count();
    let (changed_ids, created_ids) = changes.apply(&doc, &index)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let update = if applied_edits > 0 {
        edited_note_update(&stored, &doc, &vector, &reader, &now)?
    } else {
        vec![]
    };
    let after = edited_note_view(&stored, &doc)?;
    let section_ids = request
        .edits
        .iter()
        .map(|edit| edit.section_id().to_string())
        .collect::<BTreeSet<_>>();
    let mut budget = MAX_DIFF_BYTES;
    let mut truncated = false;
    let mut diff = Vec::new();
    for id in section_ids {
        let body = |note: &crate::document_model::Note| -> String {
            let mut pending = vec![&note.root];
            while let Some(section) = pending.pop() {
                if section.section_id == id {
                    return section
                        .body
                        .iter()
                        .map(|b| crate::markdown_read::block_markdown(b, &reader.workspace_id))
                        .collect();
                }
                pending.extend(&section.children);
            }
            String::new()
        };
        let old = body(&before);
        let new = body(&after);
        if old == new {
            continue;
        }
        let mut output = LimitedDiff {
            bytes: vec![],
            limit: budget,
        };
        if similar::TextDiff::configure()
            .timeout(std::time::Duration::from_millis(100))
            .diff_lines(&old, &new)
            .unified_diff()
            .context_radius(3)
            .header("before", "after")
            .to_writer(&mut output)
            .is_err()
        {
            truncated = true;
        }
        let end = std::str::from_utf8(&output.bytes).map_or_else(|e| e.valid_up_to(), |s| s.len());
        let text = std::str::from_utf8(&output.bytes[..end]).unwrap();
        diff.push(json!({"section_id":id,"unified_diff":text}));
        budget -= end;
    }
    let mut documents = Vec::new();
    if applied_edits > 0 {
        documents.push(DocumentCommitInput {
            kind: "note".into(),
            document_id: request.note_id.clone(),
            schema_version: stored.schema_version,
            base_revision: stored.revision,
            snapshot: None,
            update: Some(update),
        });
        let workspace_stored =
            load_document(&reader.connection, "workspace", &reader.workspace_id)?;
        let workspace_doc = decode_document(&workspace_stored)?;
        let workspace_vector = workspace_doc.transact().state_vector();
        {
            let mut txn = workspace_doc.transact_mut();
            let root = txn
                .get_map("workspace")
                .ok_or_else(|| invalid("Missing Workspace"))?;
            let Some(yrs::Out::YMap(notes)) = root.get(&txn, "notes") else {
                return Err(invalid("Missing Note metadata"));
            };
            let Some(yrs::Out::YMap(meta)) = notes.get(&txn, &request.note_id) else {
                return Err(invalid("Missing Note metadata"));
            };
            meta.insert(&mut txn, "updated_at", now.as_str());
        }
        documents.push(DocumentCommitInput {
            kind: "workspace".into(),
            document_id: reader.workspace_id.clone(),
            schema_version: workspace_stored.schema_version,
            base_revision: reader.workspace_revision,
            snapshot: None,
            update: Some(
                workspace_doc
                    .transact()
                    .encode_state_as_update_v1(&workspace_vector),
            ),
        });
    }
    let result = json!({"schema_version":1,"ok":true,"status":if applied_edits>0{"applied"}else{"no_change"},"request_id":request.request_id,"note_id":request.note_id,
        "revision_before":stored.revision,"revision_after":stored.revision+i64::from(applied_edits>0),"applied_edits":applied_edits,"validated_edits":request.edits.len(),
        "changed_block_ids":changed_ids,"created_block_ids":created_ids,"replayed":false,"changes":diff,"diff_truncated":truncated});
    if serde_json::to_vec(&result)?.len() > MAX_RESULT_BYTES {
        return Err(invalid("Edit result is too large; use a smaller batch"));
    }
    Ok(PreparedEdit {
        request: request.into(),
        fingerprint,
        documents,
        result,
        workspace_revision: reader.workspace_revision,
        replayed: false,
    })
}

pub fn check_revision(expected: i64, current: i64) -> Result<(), ReadError> {
    if expected != current {
        Err(ReadError::new(
            "REVISION_CONFLICT",
            "Read the Note again and reconsider the edit; do not replace only the revision",
        )
        .with_details(json!({"expected_revision":expected,"current_revision":current})))
    } else {
        Ok(())
    }
}

pub fn preview(prepared: &PreparedEdit) -> Value {
    let mut result = prepared.result.clone();
    if !prepared.replayed {
        result["status"] = "preview".into();
        result["applied_edits"] = 0.into();
        result["revision_after"] = result["revision_before"].clone();
        if result.get("workspace_revision_before").is_some() {
            result["workspace_revision_after"] = result["workspace_revision_before"].clone();
        }
    }
    result
}

pub(crate) fn commit(
    store: &mut ProductStore,
    prepared: &PreparedEdit,
) -> Result<Value, ReadError> {
    commit_with_fault(store, prepared, None)
}

pub(crate) fn commit_with_fault(
    store: &mut ProductStore,
    prepared: &PreparedEdit,
    fault: Option<crate::persistence::CommitFault>,
) -> Result<Value, ReadError> {
    if let Some(result) = receipt(&store.connection, prepared.request.clone())? {
        return Ok(result);
    }
    let request = PersistenceCommitRequest {
        operation_id: format!("agent-edit-{}", prepared.request.request_id()),
        scope: "workspace-structure".into(),
        documents: prepared.documents.clone(),
        local_states: vec![],
        search_index_metadata_only_note_id: match &prepared.request {
            AgentRequest::Body(request) => Some(request.note_id.clone()),
            AgentRequest::Section(request) => Some(request.note_id.clone()),
            AgentRequest::Note(_) => None,
        },
        fault,
    };
    store.commit_agent_edit(&request, prepared)
}

pub fn standalone(
    workspace: &Path,
    request: impl Into<AgentRequest>,
    dry_run: bool,
) -> Result<Value, ReadError> {
    let prepared = prepare(workspace, request)?;
    if dry_run {
        return Ok(preview(&prepared));
    }
    if prepared.replayed {
        return Ok(prepared.result);
    }
    let mut store = ProductStore::open_existing_for_edit(workspace)?;
    commit(&mut store, &prepared)
}

pub fn error_response(request_id: Option<&str>, error: &ReadError) -> Value {
    let unknown = matches!(
        error.code.as_str(),
        "IPC_TIMEOUT"
            | "IPC_IO"
            | "IO"
            | "IPC_PROTOCOL"
            | "OWNER_UNAVAILABLE"
            | "AGENT_RESPONSE_LOST"
    );
    json!({"schema_version":1,"ok":false,"request_id":request_id,"commit_state":if unknown{"unknown"}else{"not_applied"},"error":error})
}

#[cfg(test)]
mod tests;

struct LimitedDiff {
    bytes: Vec<u8>,
    limit: usize,
}
impl std::io::Write for LimitedDiff {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let remaining = self.limit - self.bytes.len();
        self.bytes
            .extend_from_slice(&bytes[..remaining.min(bytes.len())]);
        if bytes.len() > remaining {
            Err(std::io::Error::other("diff limit"))
        } else {
            Ok(bytes.len())
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
