//! Read-only, repeatable SQLite transaction plus Yjs replay. Opening this
//! service never opens ProductStore and cannot migrate or initialize history.
use crate::{
    document_model::{Note, ReadError, Section, read_note},
    namespace::{Namespace, read_namespace},
    workspace_migration::load_document,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub command: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub include_trash: bool,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub generation: Option<String>,
}
fn default_limit() -> usize {
    100
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AttachmentRecord {
    pub attachment_id: String,
    pub sha256: String,
    pub size: u64,
    pub original_filename: String,
    pub mime_type: String,
    pub created_at: String,
    pub known_missing: bool,
}

pub struct WorkspaceReader {
    pub replica_id: Option<String>,
    pub connection: Connection,
    pub internal_root: PathBuf,
    pub workspace_id: String,
    pub workspace_revision: i64,
    pub namespace: Namespace,
    pub document_revisions: BTreeMap<String, i64>,
    pub attachments: Vec<AttachmentRecord>,
    pub content_epoch: i64,
    read_at: String,
    pub generation: Option<String>,
    notes: BTreeMap<String, Note>,
}

pub fn plain_file(path: &Path) -> Result<fs::Metadata, ReadError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ReadError::new("UNSAFE_PATH", "Expected a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Reparse points are not allowed",
            ));
        }
    }
    Ok(metadata)
}
pub fn checked_directory(path: &Path) -> Result<(), ReadError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ReadError::new("UNSAFE_PATH", "Expected a local directory"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Reparse points are not allowed",
            ));
        }
    }
    Ok(())
}
pub fn hash_file(path: &Path) -> Result<String, ReadError> {
    hash_file_cancellable(path, None)
}
pub fn hash_file_cancellable(
    path: &Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, ReadError> {
    plain_file(path)?;
    let mut input = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if cancel.is_some_and(|token| token.load(std::sync::atomic::Ordering::Acquire)) {
            return Err(ReadError::new("CANCELLED", "File verification cancelled"));
        }
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex(&hasher.finalize()))
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl WorkspaceReader {
    pub fn open(workspace: &Path) -> Result<Self, ReadError> {
        checked_directory(workspace)?;
        let root = workspace.join(".memoka");
        checked_directory(&root)?;
        let marker = root.join("data-area.json");
        plain_file(&marker)?;
        let value: Value = serde_json::from_slice(&fs::read(marker)?)?;
        if value["schemaVersion"] != 1 || value["kind"] != "memoka-data-area" {
            return Err(ReadError::new(
                "UNSUPPORTED_SCHEMA",
                "Not a Memoka Workspace",
            ));
        }
        Self::open_database(&root.join("memoka.sqlite3"), root, None)
    }
    pub fn open_database(
        database: &Path,
        internal_root: PathBuf,
        generation: Option<String>,
    ) -> Result<Self, ReadError> {
        plain_file(database)?;
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection
            .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED")?;
        let executable_schema: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view'))",
            [],
            |row| row.get(0),
        )?;
        if executable_schema {
            return Err(ReadError::new(
                "UNSUPPORTED_SCHEMA",
                "Unexpected executable database schema",
            ));
        }
        let schema: String = connection.query_row(
            "SELECT value FROM settings WHERE key='database_schema_version'",
            [],
            |row| row.get(0),
        )?;
        if schema != "5"
            && schema != "6"
            && schema != crate::workspace_migration::DATABASE_SCHEMA.to_string()
        {
            return Err(ReadError::new(
                "MIGRATION_REQUIRED",
                "Open the Workspace in Memoka before using the reader",
            ));
        }
        let workspace_id: String = connection.query_row(
            "SELECT value FROM settings WHERE key='active_workspace_id'",
            [],
            |row| row.get(0),
        )?;
        crate::attachment::validate_uuid_v7(&workspace_id, "workspace_id")?;
        let workspace = load_document(&connection, "workspace", &workspace_id)?;
        let namespace = read_namespace(&workspace)?;
        let document_revisions = connection
            .prepare(
                "SELECT document_id,revision FROM documents WHERE kind='note' ORDER BY document_id",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<BTreeMap<String, i64>, _>>()?;
        if namespace.notes.keys().ne(document_revisions.keys()) {
            return Err(ReadError::new(
                "INVALID_NAMESPACE",
                "Note placements and stored documents disagree",
            ));
        }
        let content_epoch = connection
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM settings WHERE key='content_epoch'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let attachments=connection.prepare("SELECT attachment_id,sha256,size,original_filename,mime_type,created_at,known_missing FROM attachments ORDER BY attachment_id")?.query_map([],|row|Ok(AttachmentRecord{ attachment_id:row.get(0)?,sha256:row.get(1)?,size:row.get::<_,i64>(2)?.try_into().map_err(|_|rusqlite::Error::IntegralValueOutOfRange(2,-1))?,original_filename:row.get(3)?,mime_type:row.get(4)?,created_at:row.get(5)?,known_missing:row.get(6)? }))?.collect::<Result<Vec<_>,_>>()?;
        for attachment in &attachments {
            crate::attachment::validate_uuid_v7(&attachment.attachment_id, "attachment_id")?;
            crate::attachment::validate_filename(&attachment.original_filename)?;
            crate::attachment::validate_mime_hint(&attachment.mime_type)?;
            if attachment.sha256.len() != 64
                || !attachment
                    .sha256
                    .bytes()
                    .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
            {
                return Err(ReadError::new("INVALID_DATA", "Invalid Attachment hash"));
            }
        }
        let replica_id: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key='replica_id'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = &replica_id {
            crate::attachment::validate_uuid_v7(id, "replicaId")?;
        }
        Ok(Self {
            replica_id,
            connection,
            internal_root,
            workspace_id,
            workspace_revision: workspace.revision,
            namespace,
            document_revisions,
            attachments,
            content_epoch,
            read_at: chrono::Utc::now().to_rfc3339(),
            generation,
            notes: BTreeMap::new(),
        })
    }
    pub fn note(&mut self, id: &str) -> Result<&Note, ReadError> {
        if !self.notes.contains_key(id) {
            let note = read_note(&load_document(&self.connection, "note", id)?, false)?;
            self.notes.insert(id.to_owned(), note);
        }
        Ok(&self.notes[id])
    }
    pub fn validate_all(&mut self) -> Result<(), ReadError> {
        let check: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if check != "ok" {
            return Err(ReadError::new(
                "INVALID_DATA",
                "SQLite integrity check failed",
            ));
        }
        let mut owners = BTreeMap::new();
        for id in self.document_revisions.keys().cloned().collect::<Vec<_>>() {
            crate::document_model::register_section_owners(self.note(&id)?, &mut owners)?;
        }
        Ok(())
    }
    pub fn revision_signature(&self) -> String {
        hex(&Sha256::digest(
            serde_json::to_vec(&(
                &self.workspace_id,
                self.workspace_revision,
                &self.document_revisions,
                self.content_epoch,
                &self.generation,
            ))
            .expect("serializable revisions"),
        ))
    }
    pub fn query(&mut self, request: &ReadRequest) -> Result<Value, ReadError> {
        if request.limit == 0 || request.limit > 1000 {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "limit must be between 1 and 1000",
            ));
        }
        match request.command.as_str() {
            "tree" => {
                let items=self.namespace.ordered(request.include_trash).into_iter().map(|(entry,depth)|json!({"entry_id":entry.entry_id,"parent_entry_id":entry.parent_entry_id,"position":entry.position,"target":entry.target,"title":self.namespace.name(entry),"depth":depth,"namespace_path":self.namespace.path(&entry.entry_id),"deleted_at":entry.deleted_at})).collect();
                self.paginate(items, request)
            }
            "read" => self.read_resource(
                request
                    .id
                    .as_deref()
                    .ok_or_else(|| ReadError::new("INVALID_ARGUMENT", "id is required"))?,
                request.include_trash,
            ),
            "search" => self.search(request),
            _ => Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Unsupported read command",
            )),
        }
    }
    fn source(&self, revision: Option<i64>) -> Value {
        json!({"generation_id":self.generation,"replica_id":if self.generation.is_none(){self.replica_id.as_deref()}else{None},"document_revision":revision,"workspace_metadata_revision":self.workspace_revision,"read_at":self.read_at})
    }
    fn paginate(&self, items: Vec<Value>, request: &ReadRequest) -> Result<Value, ReadError> {
        let fingerprint = hex(&Sha256::digest(
            serde_json::to_vec(&(
                &request.command,
                &request.query,
                request.include_trash,
                &self.generation,
            ))
            .unwrap(),
        ));
        let signature = self.revision_signature();
        let start = if let Some(cursor) = &request.cursor {
            let parts = cursor.split(':').collect::<Vec<_>>();
            if parts.len() != 3 || parts[0] != signature || parts[1] != fingerprint {
                return Err(ReadError::new(
                    "CURSOR_STALE",
                    "The Workspace or query changed; restart the query",
                ));
            }
            parts[2]
                .parse::<usize>()
                .map_err(|_| ReadError::new("INVALID_ARGUMENT", "Invalid cursor"))?
        } else {
            0
        };
        if start > items.len() {
            return Err(ReadError::new("INVALID_ARGUMENT", "Cursor is out of range"));
        }
        let end = (start + request.limit).min(items.len());
        Ok(
            json!({"schema_version":1,"workspace_id":self.workspace_id,"source":self.source(None),"items":&items[start..end],"total":items.len(),"next_cursor":if end<items.len(){Some(format!("{signature}:{fingerprint}:{end}"))}else{None}}),
        )
    }
    fn find_resource(
        &mut self,
        id: &str,
        include_trash: bool,
    ) -> Result<(String, Section, usize), ReadError> {
        crate::attachment::validate_uuid_v7(id, "id")?;
        let ids = if self.document_revisions.contains_key(id) {
            vec![id.to_owned()]
        } else {
            self.document_revisions.keys().cloned().collect()
        };
        let mut trashed = false;
        for note_id in ids {
            let deleted = self.namespace.notes[&note_id]["deleted_at"].is_string();
            let mut pending = vec![(&self.note(&note_id)?.root, 0)];
            while let Some((section, depth)) = pending.pop() {
                if section.section_id == id {
                    if deleted && !include_trash {
                        trashed = true;
                        break;
                    }
                    return Ok((note_id, section.clone(), depth));
                }
                pending.extend(
                    section
                        .children
                        .iter()
                        .rev()
                        .map(|child| (child, depth + 1)),
                );
            }
        }
        Err(ReadError::new(
            if trashed { "IN_TRASH" } else { "NOT_FOUND" },
            "Resource is unavailable; reading Trash requires include-trash",
        ))
    }
    pub fn read_resource(&mut self, id: &str, include_trash: bool) -> Result<Value, ReadError> {
        let (note_id, mut section, depth) = self.find_resource(id, include_trash)?;
        let kind = if id == note_id { "note" } else { "section" };
        let mut references = BTreeSet::new();
        let mut attachment_ids = BTreeSet::new();
        let mut pending = vec![serde_json::to_value(&section)?];
        while let Some(value) = pending.pop() {
            match value {
                Value::Object(fields) => {
                    if fields.get("type").and_then(Value::as_str) == Some("internalSectionLink") {
                        if let Some(id) = fields
                            .get("attrs")
                            .and_then(|a| a["targetSectionId"].as_str())
                        {
                            references.insert(id.to_owned());
                        }
                    }
                    if let Some(id) = fields
                        .get("attrs")
                        .and_then(|a| a["attachmentId"].as_str())
                        .filter(|id| !id.is_empty())
                    {
                        attachment_ids.insert(id.to_owned());
                    }
                    pending.extend(fields.into_values());
                }
                Value::Array(values) => pending.extend(values),
                _ => {}
            }
        }
        let mut titles = BTreeMap::new();
        let references=references.into_iter().map(|id| {
            let resolved = match self.find_resource(&id, include_trash) {
                Ok((_, section, _)) => Some(section.title),
                Err(error) if matches!(error.code.as_str(), "NOT_FOUND" | "IN_TRASH") => None,
                Err(error) => return Err(error),
            };
            if let Some(title) = &resolved { titles.insert(id.clone(), title.clone()); }
            Ok(json!({"kind":"section","id":id,"resolved":resolved.is_some(),"title":resolved,"uri":crate::markdown_read::uri(&self.workspace_id,"section",&id)}))
        }).collect::<Result<Vec<_>, ReadError>>()?;
        crate::markdown_read::resolve_link_labels(&mut section, &titles);
        let attachments=attachment_ids.into_iter().map(|id| {
            let metadata=self.attachments.iter().find(|a|a.attachment_id==id);
            json!({"attachment_id":id,"mime_type":metadata.map(|a|&a.mime_type),"filename":metadata.map(|a|&a.original_filename),"available":metadata.is_some_and(|a|!a.known_missing&&(self.generation.is_some() || self.attachment_path(a).is_ok())),"uri":crate::markdown_read::uri(&self.workspace_id,"attachment",&id)})
        }).collect::<Vec<_>>();
        Ok(
            json!({"schema_version":1,"workspace_id":self.workspace_id,"resource":{"kind":kind,"id":id},"note_id":note_id,"depth":depth,"heading_level":depth+1,"source":self.source(self.document_revisions.get(&note_id).copied()),"title":section.title,"namespace_path":self.namespace.note_entry(&note_id).map(|entry|self.namespace.path(&entry.entry_id)),"uri":crate::markdown_read::uri(&self.workspace_id,kind,id),"markdown":crate::markdown_read::section_markdown(&section,depth,&self.workspace_id),"section":section,"references":references,"attachments":attachments}),
        )
    }
    fn search(&mut self, request: &ReadRequest) -> Result<Value, ReadError> {
        let query = request.query.as_deref().unwrap_or("");
        let normalize = |text: &str| text.nfkc().collect::<String>().to_lowercase();
        let terms = normalize(query)
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if terms.is_empty() {
            return self.paginate(Vec::new(), request);
        }
        // Resolve atomic link labels against this same read transaction/generation,
        // never a live document while viewing a historical snapshot.
        let mut titles = BTreeMap::new();
        for id in self.document_revisions.keys().cloned().collect::<Vec<_>>() {
            if !request.include_trash && self.namespace.notes[&id]["deleted_at"].is_string() {
                continue;
            }
            let mut pending = vec![&self.note(&id)?.root];
            while let Some(section) = pending.pop() {
                titles.insert(section.section_id.clone(), section.title.clone());
                pending.extend(&section.children);
            }
        }
        let mut items = Vec::new();
        for id in self.document_revisions.keys().cloned().collect::<Vec<_>>() {
            if !request.include_trash && self.namespace.notes[&id]["deleted_at"].is_string() {
                continue;
            }
            let path = self
                .namespace
                .note_entry(&id)
                .map(|e| self.namespace.path(&e.entry_id))
                .unwrap_or_default();
            let updated = self.namespace.notes[&id]["updated_at"].clone();
            let mut root = self.note(&id)?.root.clone();
            crate::markdown_read::resolve_link_labels(&mut root, &titles);
            let mut line_number = 0;
            let mut pending = vec![(&root, 0, path.clone())];
            while let Some((section, depth, section_path)) = pending.pop() {
                let text = normalize(&format!("{} {}", section_path.join("/"), section.title));
                if terms.iter().all(|term| text.contains(term)) {
                    items.push(json!({"note_id":id,"section_id":section.section_id,"kind":"title","title":section.title,"namespace_path":path,"section_path":section_path,"updated_at":updated,"depth":depth,"logical_line_number":null,"text":section.title}));
                }
                for (section_line, line) in crate::markdown_read::search_lines(&section.body)
                    .into_iter()
                    .enumerate()
                {
                    line_number += 1;
                    let normalized = normalize(&line.text);
                    if terms.iter().all(|term| normalized.contains(term)) {
                        items.push(json!({"note_id":id,"section_id":section.section_id,"kind":"body","title":section.title,"namespace_path":path,"section_path":section_path,"updated_at":updated,"depth":depth,"logical_line_number":line_number,"section_line_number":section_line+1,"block_id":line.block_id,"line_index":line.line_index,"source_offset":line.source_offset,"text":line.text}));
                    }
                }
                pending.extend(section.children.iter().rev().map(|child| {
                    let mut path = section_path.clone();
                    path.push(child.title.clone());
                    (child, depth + 1, path)
                }));
            }
        }
        items.sort_by(|a, b| {
            b["updated_at"]
                .as_str()
                .cmp(&a["updated_at"].as_str())
                .then(a["note_id"].as_str().cmp(&b["note_id"].as_str()))
                .then(
                    a["logical_line_number"]
                        .as_i64()
                        .cmp(&b["logical_line_number"].as_i64()),
                )
                .then(a["section_id"].as_str().cmp(&b["section_id"].as_str()))
        });
        self.paginate(items, request)
    }
    pub fn attachment_path(&self, record: &AttachmentRecord) -> Result<PathBuf, ReadError> {
        if record.known_missing {
            return Err(ReadError::new(
                "ATTACHMENT_MISSING",
                "Attachment was recorded as missing",
            ));
        }
        let path = if self.generation.is_some() {
            self.internal_root.join("blobs").join(&record.sha256)
        } else {
            self.internal_root
                .join("attachments")
                .join("objects")
                .join(&record.sha256[..2])
                .join(&record.sha256[2..])
        };
        let mut parent = path.parent();
        while let Some(directory) = parent {
            checked_directory(directory)?;
            if directory == self.internal_root {
                break;
            }
            if !directory.starts_with(&self.internal_root) {
                return Err(ReadError::new(
                    "UNSAFE_PATH",
                    "Attachment path escaped its store",
                ));
            }
            parent = directory.parent();
        }
        if plain_file(&path)?.len() != record.size {
            return Err(ReadError::new(
                "ATTACHMENT_CORRUPT",
                "Attachment size mismatch",
            ));
        }
        Ok(path)
    }
    pub fn attachment_file(
        &mut self,
        id: &str,
        include_trash: bool,
    ) -> Result<(AttachmentRecord, fs::File), ReadError> {
        crate::attachment::validate_uuid_v7(id, "attachment_id")?;
        let metadata = self
            .attachments
            .iter()
            .find(|a| a.attachment_id == id)
            .cloned()
            .ok_or_else(|| ReadError::new("NOT_FOUND", "Unknown Attachment"))?;
        if !include_trash {
            let mut live = false;
            let mut trash = false;
            for note_id in self.document_revisions.keys().cloned().collect::<Vec<_>>() {
                // Exact JSON attribute comparison, not a substring search of user text.
                let tree = serde_json::to_value(&self.note(&note_id)?.root)?;
                let mut pending = vec![&tree];
                let mut found = false;
                while let Some(node) = pending.pop() {
                    match node {
                        Value::Object(obj) => {
                            if obj.get("attrs").is_some_and(|a| a["attachmentId"] == id) {
                                found = true;
                                break;
                            }
                            pending.extend(obj.values());
                        }
                        Value::Array(values) => pending.extend(values),
                        _ => {}
                    }
                }
                if found {
                    if self.namespace.notes[&note_id]["deleted_at"].is_string() {
                        trash = true;
                    } else {
                        live = true;
                    }
                }
            }
            if trash && !live {
                return Err(ReadError::new(
                    "IN_TRASH",
                    "Reading this Attachment requires include-trash",
                ));
            }
        }
        let source = self.attachment_path(&metadata)?;
        if hash_file(&source)? != metadata.sha256 {
            return Err(ReadError::new(
                "ATTACHMENT_CORRUPT",
                "Attachment hash mismatch",
            ));
        }
        Ok((metadata, fs::File::open(source)?))
    }
    pub fn attachment_get(
        &mut self,
        id: &str,
        include_trash: bool,
        output: &Path,
    ) -> Result<(), ReadError> {
        let (_, mut source) = self.attachment_file(id, include_trash)?;
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        checked_directory(parent)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        std::io::copy(&mut source, &mut file)?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    }
}
