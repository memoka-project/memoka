//! Native interpretation of the stable-entity Note model. The same projection
//! contract is used for current reads, history and CLI Markdown export. Opening
//! or migrating a production Workspace to this schema is deliberately separate.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use yrs::{Map, ReadTxn, Transact, XmlFragment, types::ToJson};

use crate::attachment::validate_uuid_v7;
use crate::document_model::{ReadError, Section, decode_document, xml_json};
use crate::persistence::PersistedDocument;
use crate::replicated_tree::{Placement, derive_tree};

pub const SCHEMA_VERSION: i64 = 7;
pub mod edit;
const MAX_ENTITIES: usize = 200_000;
const MAX_OPERATIONS: usize = 1_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entity {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    column_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    content_root: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Deletion {
    operation_id: String,
    replica_id: String,
    entity_ids: Vec<String>,
    #[serde(default)]
    deletion_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedContent {
    pub entity_id: String,
    pub reason: String,
    pub deletion_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub root: Section,
    pub recovery: Vec<ProtectedContent>,
    pub depth_corrections: Vec<String>,
}

struct Model {
    root_id: String,
    entities: BTreeMap<String, Entity>,
    attrs: BTreeMap<String, Value>,
    inline: BTreeMap<String, Vec<Value>>,
    parents: BTreeMap<String, Placement>,
    children: BTreeMap<String, Vec<String>>,
    visible: BTreeSet<String>,
}

fn invalid(message: &str) -> ReadError {
    ReadError::new("INVALID_DATA", message)
}
fn checked_id(id: &str) -> Result<(), ReadError> {
    validate_uuid_v7(id, "replicated identity").map_err(|_| invalid("Invalid replicated identity"))
}
fn text_type(kind: &str) -> bool {
    matches!(
        kind,
        "section" | "paragraph" | "detailsSummary" | "codeBlock" | "sourceBlock"
    )
}
fn known_type(kind: &str) -> bool {
    text_type(kind)
        || matches!(
            kind,
            "blockquote"
                | "details"
                | "detailsBody"
                | "horizontalRule"
                | "bulletList"
                | "orderedList"
                | "listItem"
                | "image"
                | "attachment"
                | "table"
                | "tableRow"
                | "tableColumn"
                | "tableCell"
                | "tableHeader"
        )
}
fn allowed(kind: &str, parent: &str, region: &str) -> bool {
    if kind == "section" {
        return parent == "section" && region == "sections";
    }
    let special = matches!(
        kind,
        "tableRow"
            | "tableColumn"
            | "tableCell"
            | "tableHeader"
            | "listItem"
            | "detailsSummary"
            | "detailsBody"
    );
    match parent {
        "section" => region == "body" && !special,
        "table" => {
            (kind == "tableRow" && region == "rows")
                || (kind == "tableColumn" && region == "columns")
        }
        "tableRow" => matches!(kind, "tableCell" | "tableHeader") && region == "cells",
        "bulletList" | "orderedList" => kind == "listItem" && region == "content",
        "details" => matches!(kind, "detailsSummary" | "detailsBody") && region == "content",
        "blockquote" | "detailsBody" | "listItem" | "tableCell" | "tableHeader" => {
            region == "content" && !special
        }
        _ => false,
    }
}

fn read_map<T: ReadTxn>(txn: &T, name: &str) -> Result<Value, ReadError> {
    txn.get_map(name)
        .map(|value| serde_json::to_value(value.to_json(txn)))
        .transpose()
        .map(|value| value.unwrap_or_else(|| json!({})))
        .map_err(ReadError::from)
}

fn named_content<T: ReadTxn>(txn: &T, entity: &Entity) -> bool {
    entity.content_root
        || txn
            .get_map("meta")
            .and_then(|map| map.get(txn, "content_layout"))
            .is_none_or(|value| value.to_json(txn) != yrs::Any::String("entity-map".into()))
}
fn content_entry<T: ReadTxn>(txn: &T, entity: &Entity) -> Result<yrs::MapRef, ReadError> {
    match txn
        .get_map("content")
        .and_then(|map| map.get(txn, &entity.id))
    {
        Some(yrs::Out::YMap(map)) => Ok(map),
        _ => Err(invalid("Missing stable entity content")),
    }
}
fn entity_attributes<T: ReadTxn>(txn: &T, entity: &Entity) -> Result<Value, ReadError> {
    if named_content(txn, entity) {
        return read_map(txn, &format!("attrs:{}", entity.id));
    }
    match content_entry(txn, entity)?.get(txn, "attrs") {
        Some(yrs::Out::YMap(map)) => Ok(serde_json::to_value(map.to_json(txn))?),
        _ => Err(invalid("Missing stable entity attributes")),
    }
}
fn entity_inline<T: ReadTxn>(
    txn: &T,
    entity: &Entity,
) -> Result<Option<yrs::XmlFragmentRef>, ReadError> {
    if named_content(txn, entity) {
        return Ok(txn.get_xml_fragment(format!("inline:{}", entity.id)));
    }
    match content_entry(txn, entity)?.get(txn, "inline") {
        Some(yrs::Out::YXmlFragment(fragment)) => Ok(Some(fragment)),
        _ => Err(invalid("Missing stable entity inline content")),
    }
}

pub fn read(document: &PersistedDocument) -> Result<Projection, ReadError> {
    if document.kind != "note" || document.schema_version != SCHEMA_VERSION {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported replicated Note schema",
        ));
    }
    checked_id(&document.document_id)?;
    let doc = decode_document(document)?;
    interpret(&doc, &document.document_id).map(|(_, projection)| projection)
}

fn interpret(doc: &yrs::Doc, note_id: &str) -> Result<(Model, Projection), ReadError> {
    let txn = doc.transact();
    if txn.store().pending_ds().is_some() {
        return Err(invalid("Replicated update dependencies are missing"));
    }
    let meta = read_map(&txn, "meta")?;
    if meta
        .get("content_layout")
        .is_some_and(|value| value != "entity-map")
    {
        return Err(invalid("Unsupported replicated content layout"));
    }
    if meta["note_id"].as_str() != Some(note_id)
        || meta["schema_version"].as_i64() != Some(SCHEMA_VERSION)
    {
        return Err(invalid("Replicated identity or schema mismatch"));
    }
    let entities: BTreeMap<String, Entity> = serde_json::from_value(read_map(&txn, "entities")?)?;
    for (name, _) in txn.root_refs() {
        if matches!(
            name,
            "meta" | "entities" | "placements" | "deletions" | "restorations" | "content"
        ) {
            continue;
        }
        if !name
            .strip_prefix("attrs:")
            .or_else(|| name.strip_prefix("inline:"))
            .is_some_and(|id| {
                entities
                    .get(id)
                    .is_some_and(|entity| named_content(&txn, entity))
            })
        {
            return Err(invalid("Unknown replicated shared type"));
        }
    }
    let placements: BTreeMap<String, Placement> =
        serde_json::from_value(read_map(&txn, "placements")?)?;
    let deletions: BTreeMap<String, Deletion> =
        serde_json::from_value(read_map(&txn, "deletions")?)?;
    let restorations: BTreeMap<String, Deletion> =
        serde_json::from_value(read_map(&txn, "restorations")?)?;
    if entities.len() > MAX_ENTITIES
        || placements.len() + deletions.len() + restorations.len() > MAX_OPERATIONS
    {
        return Err(invalid("Replicated Note size limit exceeded"));
    }
    let mut attrs = BTreeMap::new();
    let mut inline = BTreeMap::new();
    let mut remaining = 2_000_000;
    let mut inline_ids = BTreeSet::new();
    for (id, entity) in &entities {
        checked_id(id)?;
        if entity.id != *id || !known_type(&entity.kind) {
            return Err(invalid("Invalid replicated entity"));
        }
        if let Some(column) = &entity.column_id {
            checked_id(column)?;
            if entities
                .get(column)
                .is_none_or(|entity| entity.kind != "tableColumn")
            {
                return Err(invalid("Cell has no column"));
            }
        }
        let attributes = entity_attributes(&txn, entity)?;
        if attributes
            .get("type")
            .is_some_and(|kind| !kind.as_str().is_some_and(known_type))
        {
            return Err(invalid("Unknown entity type"));
        }
        if attributes.get("tags").is_some_and(|tags| {
            !tags
                .as_array()
                .is_some_and(|tags| tags.iter().all(Value::is_string))
        }) {
            return Err(invalid("Invalid Section tags"));
        }
        let mut content = Vec::new();
        if let Some(fragment) = entity_inline(&txn, entity)? {
            for child in fragment.children(&txn) {
                content.extend(xml_json(&txn, child, 0, &mut inline_ids, &mut remaining)?);
            }
        }
        for node in &content {
            if node["content"]
                .as_array()
                .is_some_and(|children| !children.is_empty())
            {
                if node["type"] != "internalSectionLink"
                    || node["content"].as_array().unwrap().iter().any(|child| {
                        child["type"] != "text"
                            || child["content"]
                                .as_array()
                                .is_some_and(|nested| !nested.is_empty())
                    })
                {
                    return Err(invalid("Only internal links can contain a text label"));
                }
            }
            if !matches!(
                node["type"].as_str(),
                Some("text" | "hardBreak" | "internalSectionLink")
            ) {
                return Err(invalid("Invalid replicated inline node"));
            }
            if node["type"] == "internalSectionLink" {
                checked_id(
                    node["attrs"]["targetSectionId"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid internal link"))?,
                )?;
            }
        }
        attrs.insert(id.clone(), attributes);
        inline.insert(id.clone(), content);
    }
    if let Some(registry) = txn.get_map("content") {
        for (id, value) in registry.iter(&txn) {
            if entities
                .get(id)
                .is_none_or(|entity| named_content(&txn, entity))
            {
                return Err(invalid("Invalid content registry identity"));
            }
            let yrs::Out::YMap(entry) = value else {
                return Err(invalid("Invalid content registry entry"));
            };
            if entry
                .keys(&txn)
                .any(|key| !matches!(key, "attrs" | "inline"))
            {
                return Err(invalid("Unknown content registry field"));
            }
        }
    }
    if entities
        .get(note_id)
        .is_none_or(|root| root.kind != "section")
    {
        return Err(invalid("Replicated Note has no root Section"));
    }
    let parents = derive_tree(note_id, &entities.keys().cloned().collect(), &placements)?;
    let descendants = sorted_children(&parents);
    let mut pending = vec![(note_id.to_string(), 0usize)];
    while let Some((id, depth)) = pending.pop() {
        if depth > 128 {
            return Err(invalid("Replicated structure depth limit exceeded"));
        }
        pending.extend(
            descendants
                .get(&id)
                .into_iter()
                .flatten()
                .map(|child| (child.clone(), depth + 1)),
        );
    }
    let mut coordinates = BTreeSet::new();
    for (id, entity) in &entities {
        if !matches!(entity.kind.as_str(), "tableCell" | "tableHeader") {
            continue;
        }
        let column = entity
            .column_id
            .as_ref()
            .ok_or_else(|| invalid("Cell has no column identity"))?;
        let row = &parents
            .get(id)
            .ok_or_else(|| invalid("Cell has no row"))?
            .parent_id;
        let table = &parents
            .get(row)
            .ok_or_else(|| invalid("Row has no table"))?
            .parent_id;
        if parents
            .get(column)
            .is_none_or(|edge| &edge.parent_id != table)
        {
            return Err(invalid("Cell coordinates belong to different tables"));
        }
        if !coordinates.insert((row.clone(), column.clone())) {
            return Err(invalid("Duplicate stable table cell"));
        }
    }
    let mut model = Model {
        root_id: note_id.to_string(),
        entities,
        attrs,
        inline,
        parents,
        children: BTreeMap::new(),
        visible: BTreeSet::from([note_id.to_string()]),
    };
    if model.kind(&model.root_id) != "section" {
        return Err(invalid("Invalid root type"));
    }
    let mut cancelled: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (id, restoration) in &restorations {
        validate_deletion(id, restoration, &model)?;
        let deletion_id = restoration
            .deletion_id
            .as_ref()
            .ok_or_else(|| invalid("Restoration has no deletion"))?;
        let deletion = deletions
            .get(deletion_id)
            .ok_or_else(|| invalid("Unobserved deletion"))?;
        let observed: BTreeSet<_> = deletion.entity_ids.iter().collect();
        if restoration
            .entity_ids
            .iter()
            .any(|id| !observed.contains(id))
        {
            return Err(invalid("Invalid restoration selection"));
        }
        cancelled
            .entry(deletion_id.clone())
            .or_default()
            .extend(restoration.entity_ids.iter().cloned());
    }
    let mut deleted: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, deletion) in &deletions {
        validate_deletion(id, deletion, &model)?;
        if deletion.deletion_id.is_some() {
            return Err(invalid("Invalid deletion"));
        }
        for entity_id in &deletion.entity_ids {
            if !cancelled.get(id).is_some_and(|ids| ids.contains(entity_id)) {
                deleted
                    .entry(entity_id.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
    }
    let original_children = sorted_children(&model.parents);
    let mut pending = original_children
        .get(&model.root_id)
        .cloned()
        .unwrap_or_default();
    pending.reverse();
    let mut depths = BTreeMap::from([(model.root_id.clone(), 0usize)]);
    let mut recovery = Vec::new();
    let mut depth_corrections = Vec::new();
    while let Some(id) = pending.pop() {
        let edge = model.parents[&id].clone();
        let kind = model.kind(&id).to_owned();
        let own_deletes = deleted.get(&id).cloned().unwrap_or_default();
        let parent_visible = model.visible.contains(&edge.parent_id);
        let coordinate_visible = model.entities[&id]
            .column_id
            .as_ref()
            .is_none_or(|column| model.visible.contains(column));
        let valid = allowed(&kind, model.kind(&edge.parent_id), &edge.region);
        if !own_deletes.is_empty() || !parent_visible || !coordinate_visible || !valid {
            recovery.push(ProtectedContent {
                entity_id: id.clone(),
                reason: if !own_deletes.is_empty() {
                    "deleted"
                } else if !parent_visible || !coordinate_visible {
                    "deleted-parent"
                } else {
                    "incompatible-type"
                }
                .into(),
                deletion_ids: own_deletes,
            });
        } else {
            let mut parent = edge.parent_id.clone();
            let mut depth = depths[&parent];
            if kind == "section" {
                while depth >= 5 {
                    parent = model.parents[&parent].parent_id.clone();
                    depth = depths[&parent];
                }
                if parent != edge.parent_id {
                    model.parents.get_mut(&id).unwrap().parent_id = parent;
                    depth_corrections.push(id.clone());
                }
                depth += 1;
            }
            depths.insert(id.clone(), depth);
            model.visible.insert(id.clone());
            if !text_type(&kind) && !model.inline[&id].is_empty() {
                recovery.push(ProtectedContent {
                    entity_id: id.clone(),
                    reason: "incompatible-type".into(),
                    deletion_ids: Vec::new(),
                });
            }
        }
        pending.extend(
            original_children
                .get(&id)
                .into_iter()
                .flatten()
                .rev()
                .cloned(),
        );
    }
    model.children = sorted_children(&model.parents);
    for children in model.children.values_mut() {
        children.retain(|id| model.visible.contains(id));
    }
    recovery.sort_by(|a, b| a.entity_id.cmp(&b.entity_id));
    depth_corrections.sort();
    let projection = Projection {
        root: model.section(&model.root_id)?,
        recovery,
        depth_corrections,
    };
    Ok((model, projection))
}

fn validate_deletion(id: &str, value: &Deletion, model: &Model) -> Result<(), ReadError> {
    checked_id(id)?;
    checked_id(&value.replica_id)?;
    if value.operation_id != id
        || value.entity_ids.is_empty()
        || value.entity_ids.iter().collect::<BTreeSet<_>>().len() != value.entity_ids.len()
        || value
            .entity_ids
            .iter()
            .any(|id| !model.entities.contains_key(id) || id == &model.root_id)
    {
        return Err(invalid("Invalid deletion operation"));
    }
    Ok(())
}

fn sorted_children(parents: &BTreeMap<String, Placement>) -> BTreeMap<String, Vec<String>> {
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, edge) in parents {
        children
            .entry(edge.parent_id.clone())
            .or_default()
            .push(id.clone());
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|a, b| {
            (&parents[a].region, &parents[a].position, a).cmp(&(
                &parents[b].region,
                &parents[b].position,
                b,
            ))
        });
    }
    children
}

impl Model {
    fn kind(&self, id: &str) -> &str {
        self.attrs[id]["type"]
            .as_str()
            .unwrap_or(&self.entities[id].kind)
    }
    fn section(&self, id: &str) -> Result<Section, ReadError> {
        let title = self.inline[id]
            .iter()
            .map(|node| {
                node["text"]
                    .as_str()
                    .ok_or_else(|| invalid("Section title must be text"))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("");
        if title.contains(['\n', '\r']) {
            return Err(invalid("Section title must be a single line"));
        }
        let children = self.children.get(id).cloned().unwrap_or_default();
        Ok(Section {
            section_id: id.to_owned(),
            title,
            emoji: self.attrs[id]["emoji"].as_str().map(str::to_owned),
            tags: serde_json::from_value(
                self.attrs[id]
                    .get("tags")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )?,
            body: children
                .iter()
                .filter(|child| self.parents[*child].region == "body")
                .map(|child| self.block(child, 0))
                .collect::<Result<_, _>>()?,
            children: children
                .iter()
                .filter(|child| self.kind(child) == "section")
                .map(|child| self.section(child))
                .collect::<Result<_, _>>()?,
        })
    }
    fn block(&self, id: &str, depth: usize) -> Result<Value, ReadError> {
        if depth > 128 {
            return Err(invalid("Block depth limit exceeded"));
        }
        let kind = self.kind(id);
        let mut attrs = self.attrs[id].clone();
        attrs.as_object_mut().unwrap().remove("type");
        attrs["blockId"] = json!(id);
        let children = self.children.get(id).cloned().unwrap_or_default();
        if kind == "table" {
            let columns = children
                .iter()
                .filter(|child| self.kind(child) == "tableColumn")
                .collect::<Vec<_>>();
            let mut rows = Vec::new();
            for row in children
                .iter()
                .filter(|child| self.kind(child) == "tableRow")
            {
                let mut cells = Vec::new();
                for column in &columns {
                    let matches = self
                        .children
                        .get(row)
                        .into_iter()
                        .flatten()
                        .filter(|cell| self.entities[*cell].column_id.as_ref() == Some(column))
                        .collect::<Vec<_>>();
                    if matches.len() > 1 {
                        return Err(invalid("Duplicate stable table cell"));
                    }
                    cells.push(if let Some(cell) = matches.first() { self.block(cell, depth + 1)? } else {
                        json!({"type":"tableCell","attrs":{"blockId":derived_id(row, &format!("cell:{column}"))?},"content":[{"type":"paragraph","attrs":{"blockId":derived_id(row, &format!("paragraph:{column}"))?}}]})
                    });
                }
                let mut attrs = self.attrs[row].clone();
                attrs["blockId"] = json!(row);
                rows.push(json!({"type":"tableRow","attrs":attrs,"content":cells}));
            }
            return Ok(json!({"type":kind,"attrs":attrs,"content":rows}));
        }
        if text_type(kind) {
            return Ok(json!({"type":kind,"attrs":attrs,"content":self.inline[id]}));
        }
        if matches!(kind, "horizontalRule" | "image" | "attachment") {
            return Ok(json!({"type":kind,"attrs":attrs}));
        }
        if matches!(kind, "tableCell" | "tableHeader") && children.is_empty() {
            return Ok(
                json!({"type":kind,"attrs":attrs,"content":[{"type":"paragraph","attrs":{"blockId":derived_id(id,"empty-paragraph")?}}]}),
            );
        }
        Ok(
            json!({"type":kind,"attrs":attrs,"content":children.iter().filter(|child| self.kind(child) != "tableColumn").map(|child| self.block(child, depth+1)).collect::<Result<Vec<_>, _>>()?}),
        )
    }
}

fn derived_id(namespace: &str, label: &str) -> Result<String, ReadError> {
    checked_id(namespace)?;
    let hash = Sha256::digest(serde_json::to_vec(&[namespace, label])?);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    let namespace = uuid::Uuid::parse_str(namespace)
        .map_err(|_| invalid("Invalid derived identity namespace"))?;
    bytes[..6].copy_from_slice(&namespace.as_bytes()[..6]);
    bytes[6] = (bytes[6] & 15) | 0x70;
    bytes[8] = (bytes[8] & 63) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_yjs_replication_contract() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/replicated-note-contract.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let document = PersistedDocument {
                kind: "note".into(),
                document_id: fixture["noteId"].as_str().unwrap().into(),
                schema_version: 7,
                revision: 1,
                snapshot_revision: 1,
                snapshot: serde_json::from_value(fixture["snapshot"].clone()).unwrap(),
                updates: Vec::new(),
            };
            let projection = read(&document).unwrap();
            assert_eq!(
                normalize(serde_json::to_value(&projection).unwrap()),
                normalize(fixture["projection"].clone()),
                "{}",
                fixture["name"]
            );
            assert_eq!(
                crate::document_model::read_note(&document, false)
                    .unwrap()
                    .root,
                projection.root
            );
        }
    }
    fn normalize(mut value: Value) -> Value {
        match &mut value {
            Value::Object(object) => {
                object.retain(|key, value| {
                    !matches!(key.as_str(), "attrs" | "content" | "marks")
                        || !(value.as_array().is_some_and(Vec::is_empty)
                            || value.as_object().is_some_and(serde_json::Map::is_empty))
                });
                for child in object.values_mut() {
                    *child = normalize(child.take());
                }
            }
            Value::Array(array) => {
                for child in array {
                    *child = normalize(child.take());
                }
            }
            _ => {}
        }
        value
    }
}
