//! DOM-free interpretation of the persisted Yjs model. Used by migration,
//! current reads, history reads and restore validation.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yrs::types::{AsPrelim, ToJson};
use yrs::updates::decoder::Decode;
use yrs::{
    Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, TransactionMut, Update, Xml,
    XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut,
};

use crate::attachment::validate_uuid_v7;
use crate::persistence::{PersistedDocument, PersistenceError};

pub const MAX_SECTION_DEPTH: usize = 5;
const MAX_NODES: usize = 2_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadError {
    pub code: String,
    pub message: String,
    pub details: Value,
}

impl ReadError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Value::Null,
        }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ReadError {}
impl From<PersistenceError> for ReadError {
    fn from(error: PersistenceError) -> Self {
        let code = match error {
            PersistenceError::RevisionConflict { .. } => "REVISION_CONFLICT",
            PersistenceError::UnknownDocument { .. } => "NOT_FOUND",
            PersistenceError::Io(_) => "IO",
            _ => "INVALID_DATA",
        };
        Self::new(code, &error.to_string())
    }
}
impl From<rusqlite::Error> for ReadError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("DATABASE", &error.to_string())
    }
}
impl From<std::io::Error> for ReadError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO", &error.to_string())
    }
}
impl From<serde_json::Error> for ReadError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_DATA", &error.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub section_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    pub tags: Vec<String>,
    pub body: Vec<Value>,
    pub children: Vec<Section>,
}

#[derive(Clone, Debug)]
pub struct Note {
    pub note_id: String,
    pub revision: i64,
    pub root: Section,
}

pub fn register_section_owners(
    note: &Note,
    owners: &mut BTreeMap<String, String>,
) -> Result<(), ReadError> {
    let mut pending = vec![&note.root];
    while let Some(section) = pending.pop() {
        if let Some(previous) = owners.insert(section.section_id.clone(), note.note_id.clone()) {
            return Err(ReadError::new(
                "DUPLICATE_SECTION_ID",
                "Section identity has multiple owners",
            )
            .with_details(
                json!({"section_id": section.section_id, "note_ids": [previous, note.note_id]}),
            ));
        }
        pending.extend(&section.children);
    }
    Ok(())
}

pub fn decode_document(document: &PersistedDocument) -> Result<Doc, ReadError> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let mut apply = |bytes: &[u8]| -> Result<(), ReadError> {
            let update = Update::decode_v1(bytes)
                .map_err(|_| ReadError::new("INVALID_DATA", "Invalid Yjs update"))?;
            txn.apply_update(update)
                .map_err(|_| ReadError::new("INVALID_DATA", "Cannot replay Yjs update"))?;
            Ok(())
        };
        apply(&document.snapshot)?;
        let mut expected = document.snapshot_revision + 1;
        for update in &document.updates {
            if update.revision != expected {
                return Err(ReadError::new(
                    "INVALID_DATA",
                    "Document update revisions are not contiguous",
                ));
            }
            apply(&update.update)?;
            expected += 1;
        }
        if expected - 1 != document.revision {
            return Err(ReadError::new(
                "INVALID_DATA",
                "Document revision does not match replay",
            ));
        }
    }
    if doc.transact().store().pending_update().is_some() {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Yjs update dependencies are missing",
        ));
    }
    Ok(doc)
}

pub fn workspace_json(document: &PersistedDocument) -> Result<Value, ReadError> {
    let doc = decode_document(document)?;
    let txn = doc.transact();
    let root = txn
        .get_map("workspace")
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Workspace metadata is missing"))?;
    let value = serde_json::to_value(root.to_json(&txn))?;
    if value["workspace_id"].as_str() != Some(&document.document_id) {
        return Err(ReadError::new(
            "INVALID_ID",
            "Workspace identity does not match its storage key",
        ));
    }
    Ok(value)
}

pub fn read_note(document: &PersistedDocument, allow_legacy: bool) -> Result<Note, ReadError> {
    if document.kind != "note"
        || !(document.schema_version == 3 || (allow_legacy && document.schema_version == 2))
    {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported Note schema",
        ));
    }
    let doc = decode_document(document)?;
    let txn = doc.transact();
    let meta = txn
        .get_map("meta")
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Note metadata is missing"))?;
    let metadata = serde_json::to_value(meta.to_json(&txn))?;
    if metadata["note_id"].as_str() != Some(&document.document_id)
        || metadata["schema_version"].as_i64() != Some(document.schema_version)
    {
        return Err(ReadError::new(
            "INVALID_ID",
            "Note identity or schema does not match its storage key",
        ));
    }
    let fragment = txn
        .get_xml_fragment("body")
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Note body is missing"))?;
    if fragment.len(&txn) != 1 {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Note must have one Root Section",
        ));
    }
    let root = fragment
        .children(&txn)
        .next()
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Root Section is missing"))?;
    let mut ids = BTreeSet::new();
    let mut remaining = MAX_NODES;
    let root = read_section(
        &txn,
        root,
        0,
        document.schema_version,
        &mut ids,
        &mut remaining,
    )?;
    if root.section_id != document.document_id {
        return Err(ReadError::new(
            "INVALID_ID",
            "Root Section ID must equal Note ID",
        ));
    }
    Ok(Note {
        note_id: document.document_id.clone(),
        revision: document.revision,
        root,
    })
}

/// Upgrade only a private replay document. The original stream is retained
/// until the enclosing, preflighted SQL migration commits atomically.
pub fn migrate_note(document: &PersistedDocument) -> Result<Option<Vec<u8>>, ReadError> {
    read_note(document, true)?;
    if document.schema_version == 3 {
        return Ok(None);
    }
    let doc = decode_document(document)?;
    let mut txn = doc.transact_mut();
    let body = txn
        .get_xml_fragment("body")
        .ok_or_else(|| invalid("Missing Note body"))?;
    let mut pending = body.children(&txn).collect::<Vec<_>>();
    while let Some(XmlOut::Element(section)) = pending.pop() {
        let parts = section.children(&txn).collect::<Vec<_>>();
        let (XmlOut::Element(header), XmlOut::Element(body), XmlOut::Element(children)) =
            (&parts[0], &parts[1], &parts[2])
        else {
            return Err(invalid("Invalid Section containers"));
        };
        let id = header
            .get_attribute(&txn, "sectionId")
            .ok_or_else(|| invalid("Missing Section ID"))?
            .to_string(&txn);
        pending.extend(children.children(&txn));
        let blocks = body.children(&txn).collect::<Vec<_>>();
        let mut offset = 0;
        while offset < blocks.len() {
            let start = offset;
            let mut estimated = 0;
            while offset < blocks.len() && offset - start < 256 {
                let bytes = match &blocks[offset] {
                    XmlOut::Element(value) => value.get_string(&txn).len(),
                    XmlOut::Text(value) => value.get_string(&txn).len(),
                    XmlOut::Fragment(_) => return Err(invalid("Unexpected XML fragment")),
                };
                if offset > start && estimated + bytes > 128 * 1024 {
                    break;
                }
                estimated += bytes;
                offset += 1;
            }
            let chunk = body.push_back(&mut txn, XmlElementPrelim::empty("bodyChunk"));
            chunk.insert_attribute(
                &mut txn,
                "chunkId",
                crate::namespace::migration_id(
                    &document.document_id,
                    &format!("body-chunk:{id}:{start}"),
                ),
            );
            for block in &blocks[start..offset] {
                clone_xml_into(&mut txn, block, &chunk)?;
            }
        }
        if !blocks.is_empty() {
            body.remove_range(&mut txn, 0, blocks.len() as u32);
        }
    }
    let meta = txn
        .get_map("meta")
        .ok_or_else(|| invalid("Missing Note metadata"))?;
    meta.insert(&mut txn, "schema_version", 3);
    let bytes = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    read_note(
        &PersistedDocument {
            schema_version: 3,
            snapshot: bytes.clone(),
            snapshot_revision: document.revision,
            updates: Vec::new(),
            ..document.clone()
        },
        false,
    )?;
    Ok(Some(bytes))
}

fn clone_xml_into(
    txn: &mut TransactionMut<'_>,
    source: &XmlOut,
    parent: &XmlElementRef,
) -> Result<(), ReadError> {
    match source {
        XmlOut::Element(source) => {
            // as_prelim on elements stringifies numeric/bool/object attributes.
            // Copy typed Any values to preserve table, image and callout data.
            let attrs = source
                .attributes(txn)
                .map(|(key, value)| (key.to_owned(), value.to_json(txn)))
                .collect::<Vec<_>>();
            let children = source.children(txn).collect::<Vec<_>>();
            let copy = parent.push_back(txn, XmlElementPrelim::empty(source.tag().clone()));
            for (key, value) in attrs {
                copy.insert_attribute(txn, key, value);
            }
            for child in children {
                clone_xml_into(txn, &child, &copy)?;
            }
        }
        XmlOut::Text(source) => {
            let prelim = source.as_prelim(txn);
            parent.push_back(txn, yrs::types::xml::XmlIn::Text(prelim));
        }
        XmlOut::Fragment(_) => return Err(invalid("Unexpected XML fragment")),
    }
    Ok(())
}

fn invalid(message: &str) -> ReadError {
    ReadError::new("INVALID_DATA", message)
}

fn checked_id(id: &str, ids: &mut BTreeSet<String>) -> Result<(), ReadError> {
    validate_uuid_v7(id, "id")
        .map_err(|_| ReadError::new("INVALID_ID", "Identity must be a lowercase UUIDv7"))?;
    if !ids.insert(id.to_owned()) {
        return Err(ReadError::new("INVALID_ID", "Duplicate document identity"));
    }
    Ok(())
}

fn read_section<T: ReadTxn>(
    txn: &T,
    xml: XmlOut,
    depth: usize,
    schema: i64,
    ids: &mut BTreeSet<String>,
    remaining: &mut usize,
) -> Result<Section, ReadError> {
    let XmlOut::Element(section) = xml else {
        return Err(invalid("Invalid Section node"));
    };
    if depth > MAX_SECTION_DEPTH {
        let id = section
            .children(txn)
            .next()
            .and_then(|header| match header {
                XmlOut::Element(header) => header.get_attribute(txn, "sectionId"),
                _ => None,
            })
            .and_then(|value| String::try_from(value).ok());
        return Err(
            ReadError::new("SECTION_DEPTH_LIMIT", "Section depth exceeds H6")
                .with_details(json!({"section_id": id, "depth": depth})),
        );
    }
    if section.tag().as_ref() != "section" || section.len(txn) != 3 {
        return Err(invalid("Section must contain Header, Body and Children"));
    }
    let parts = section.children(txn).collect::<Vec<_>>();
    let (XmlOut::Element(header), XmlOut::Element(body), XmlOut::Element(children)) =
        (&parts[0], &parts[1], &parts[2])
    else {
        return Err(invalid("Invalid Section containers"));
    };
    if header.tag().as_ref() != "sectionHeader"
        || body.tag().as_ref() != "sectionBody"
        || children.tag().as_ref() != "sectionChildren"
    {
        return Err(invalid("Invalid Section containers"));
    }
    let attributes = header
        .attributes(txn)
        .map(|(key, value)| {
            (
                key.to_owned(),
                serde_json::to_value(value.to_json(txn)).unwrap_or(Value::Null),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let id = attributes
        .get("sectionId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Section ID is missing"))?
        .to_owned();
    checked_id(&id, ids)?;
    let mut title = String::new();
    for child in header.children(txn) {
        let XmlOut::Text(text) = child else {
            return Err(invalid("Section title must be text"));
        };
        for delta in text.diff(txn, |_| ()) {
            if let yrs::Out::Any(yrs::Any::String(text)) = delta.insert {
                title.push_str(&text);
            } else {
                return Err(invalid("Section title contains a non-text value"));
            }
        }
    }
    if title.contains(['\n', '\r']) {
        return Err(invalid("Section title must be a single line"));
    }
    let tags = match attributes.get("tags") {
        Some(Value::String(value)) => serde_json::from_str::<Vec<String>>(value)?,
        None => Vec::new(),
        _ => return Err(invalid("Invalid Section tags")),
    };
    let emoji = attributes
        .get("emoji")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let mut blocks = Vec::new();
    for child in body.children(txn) {
        if schema == 2 {
            blocks.extend(xml_json(txn, child, 0, ids, remaining)?);
            continue;
        }
        let XmlOut::Element(chunk) = child else {
            return Err(invalid("Invalid BodyChunk"));
        };
        if chunk.tag().as_ref() != "bodyChunk" || chunk.len(txn) == 0 {
            return Err(invalid("Invalid BodyChunk"));
        }
        let chunk_id = chunk
            .get_attribute(txn, "chunkId")
            .and_then(|value| String::try_from(value).ok())
            .ok_or_else(|| invalid("BodyChunk ID is missing"))?;
        checked_id(&chunk_id, ids)?;
        for block in chunk.children(txn) {
            blocks.extend(xml_json(txn, block, 0, ids, remaining)?);
        }
    }
    let children = children
        .children(txn)
        .map(|child| read_section(txn, child, depth + 1, schema, ids, remaining))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Section {
        section_id: id,
        title,
        emoji,
        tags,
        body: blocks,
        children,
    })
}

fn xml_json<T: ReadTxn>(
    txn: &T,
    xml: XmlOut,
    depth: usize,
    ids: &mut BTreeSet<String>,
    remaining: &mut usize,
) -> Result<Vec<Value>, ReadError> {
    if depth > 256 || *remaining == 0 {
        return Err(invalid("Document traversal limit exceeded"));
    }
    *remaining -= 1;
    match xml {
        XmlOut::Element(node) => {
            let name = node.tag().as_ref();
            if matches!(
                name,
                "section" | "sectionHeader" | "sectionChildren" | "sectionBody" | "bodyChunk"
            ) {
                return Err(invalid("Section structure found inside a body block"));
            }
            let attrs = node
                .attributes(txn)
                .map(|(key, value)| Ok((key.to_owned(), serde_json::to_value(value.to_json(txn))?)))
                .collect::<Result<BTreeMap<_, _>, ReadError>>()?;
            let block = matches!(
                name,
                "paragraph"
                    | "blockquote"
                    | "horizontalRule"
                    | "bulletList"
                    | "orderedList"
                    | "listItem"
                    | "codeBlock"
                    | "image"
                    | "attachment"
                    | "sourceBlock"
                    | "table"
                    | "tableRow"
                    | "tableCell"
                    | "tableHeader"
            );
            if block {
                checked_id(
                    attrs
                        .get("blockId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("Block ID is missing"))?,
                    ids,
                )?;
            } else if !matches!(name, "hardBreak" | "internalSectionLink") {
                return Err(ReadError::new("UNSUPPORTED_SCHEMA", "Unknown body node"));
            }
            let mut content = Vec::new();
            for child in node.children(txn) {
                content.extend(xml_json(txn, child, depth + 1, ids, remaining)?);
            }
            Ok(vec![
                json!({ "type": name, "attrs": attrs, "content": content }),
            ])
        }
        XmlOut::Text(text) => {
            let mut result = Vec::new();
            for delta in text.diff(txn, |_| ()) {
                let yrs::Out::Any(yrs::Any::String(text)) = delta.insert else {
                    return Err(invalid("Unsupported inline embed"));
                };
                if text.is_empty() {
                    continue;
                }
                let mut node = json!({"type":"text", "text": text});
                if let Some(attributes) = delta.attributes {
                    let mut marks = Vec::new();
                    let sorted = attributes.iter().collect::<BTreeMap<_, _>>();
                    for (encoded, attrs) in sorted {
                        let name = encoded
                            .rsplit_once("--")
                            .filter(|(_, suffix)| {
                                suffix.len() == 8
                                    && suffix
                                        .bytes()
                                        .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
                            })
                            .map_or(encoded.as_ref(), |(name, _)| name);
                        if !matches!(
                            name,
                            "bold" | "italic" | "strike" | "code" | "link" | "highlight"
                        ) {
                            return Err(ReadError::new(
                                "UNSUPPORTED_SCHEMA",
                                "Unknown inline mark",
                            ));
                        }
                        let attrs = serde_json::to_value(attrs)?;
                        marks.push(if attrs.as_object().is_some_and(|map| !map.is_empty()) {
                            json!({"type":name,"attrs":attrs})
                        } else {
                            json!({"type":name})
                        });
                    }
                    if !marks.is_empty() {
                        node["marks"] = json!(marks);
                    }
                }
                result.push(node);
            }
            Ok(result)
        }
        XmlOut::Fragment(_) => Err(invalid("Unexpected nested XML fragment")),
    }
}
