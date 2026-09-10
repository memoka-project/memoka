//! Native Core editing of normalized Notes. Legacy command planning uses a
//! disposable XML view; persistence receives only updates to stable entities.
use super::*;
use yrs::{
    Doc, Map, Text, WriteTxn, Xml, XmlElementPrelim, XmlElementRef, XmlFragmentRef, XmlOut,
    XmlTextPrelim, XmlTextRef, types::Attrs,
};

#[derive(Clone)]
struct Desired {
    entity: Entity,
    attrs: Value,
    inline: Vec<Value>,
    parent: Option<(String, String)>,
}
struct Layout {
    nodes: BTreeMap<String, Desired>,
    groups: BTreeMap<(String, String), Vec<String>>,
}

/// Prepares a new normalized snapshot without modifying the original database.
/// The Workspace migration owns the pre-migration backup and atomic install.
pub fn migrate(document: &PersistedDocument, replica_id: &str) -> Result<Vec<u8>, ReadError> {
    if document.kind != "note" || !(2..=6).contains(&document.schema_version) {
        return Err(invalid(
            "Only a legacy Note can be converted to the normalized model",
        ));
    }
    checked_id(replica_id)?;
    let source = crate::document_model::read_note(document, true)?;
    let original = decode_document(document)?;
    let metadata = read_map(&original.transact(), "meta")?;
    let updated_at = metadata["updated_at"].as_str().unwrap_or("");
    let doc = Doc::with_options(yrs::Options {
        skip_gc: true,
        ..Default::default()
    });
    {
        let mut txn = doc.transact_mut();
        let meta = txn.get_or_insert_map("meta");
        meta.insert(&mut txn, "note_id", document.document_id.as_str());
        meta.insert(&mut txn, "schema_version", SCHEMA_VERSION);
        meta.insert(&mut txn, "content_layout", "entity-map");
        meta.insert(
            &mut txn,
            "created_at",
            metadata["created_at"].as_str().unwrap_or(""),
        );
        meta.insert(&mut txn, "updated_at", updated_at);
        let root = Entity {
            id: document.document_id.clone(),
            kind: "section".into(),
            column_id: None,
            content_root: false,
        };
        txn.get_or_insert_map("entities").insert(
            &mut txn,
            root.id.as_str(),
            any(&serde_json::to_value(&root)?)?,
        );
        writable_content(&mut txn, &root)?
            .0
            .insert(&mut txn, "tags", any(&json!([]))?);
    }
    let base = PersistedDocument {
        kind: "note".into(),
        document_id: document.document_id.clone(),
        schema_version: SCHEMA_VERSION,
        revision: 1,
        snapshot_revision: 1,
        updates: vec![],
        snapshot: doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default()),
    };
    let update = reconcile(&base, &source.root, replica_id, updated_at)?;
    use yrs::updates::decoder::Decode;
    doc.transact_mut()
        .apply_update(
            yrs::Update::decode_v1(&update).map_err(|_| invalid("Invalid migration delta"))?,
        )
        .map_err(|_| invalid("Cannot apply migration delta"))?;
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let converted = read(&PersistedDocument {
        snapshot: bytes.clone(),
        ..base
    })?;
    if normalized(serde_json::to_value(&converted.root)?)
        != normalized(serde_json::to_value(&source.root)?)
    {
        return Err(invalid("Migration changed content or identities"));
    }
    Ok(bytes)
}
impl Layout {
    fn add(&mut self, node: Desired) -> Result<(), ReadError> {
        checked_id(&node.entity.id)?;
        if self.nodes.contains_key(&node.entity.id) || !known_type(&node.entity.kind) {
            return Err(invalid("Invalid or duplicate stable identity"));
        }
        if let Some(parent) = &node.parent {
            self.groups
                .entry(parent.clone())
                .or_default()
                .push(node.entity.id.clone());
        }
        self.nodes.insert(node.entity.id.clone(), node);
        Ok(())
    }
    fn section(
        &mut self,
        section: &Section,
        parent: Option<&str>,
        current: &Model,
        depth: usize,
    ) -> Result<(), ReadError> {
        if depth > crate::document_model::MAX_SECTION_DEPTH || section.title.contains(['\n', '\r'])
        {
            return Err(invalid("Invalid Section title or depth"));
        }
        self.add(Desired {
            entity: Entity {
                id: section.section_id.clone(),
                kind: "section".into(),
                column_id: None,
                content_root: false,
            },
            attrs: json!({"emoji":section.emoji,"tags":section.tags}),
            inline: if section.title.is_empty() {
                vec![]
            } else {
                vec![json!({"type":"text","text":section.title})]
            },
            parent: parent.map(|id| (id.into(), "sections".into())),
        })?;
        self.blocks(&section.body, &section.section_id, "body", current)?;
        for child in &section.children {
            self.section(child, Some(&section.section_id), current, depth + 1)?;
        }
        Ok(())
    }
    fn blocks(
        &mut self,
        blocks: &[Value],
        parent: &str,
        region: &str,
        current: &Model,
    ) -> Result<(), ReadError> {
        for block in blocks {
            let id = block["attrs"]["blockId"]
                .as_str()
                .ok_or_else(|| invalid("Block has no stable identity"))?;
            let kind = block["type"]
                .as_str()
                .ok_or_else(|| invalid("Block has no type"))?;
            let mut attrs = block.get("attrs").cloned().unwrap_or_else(|| json!({}));
            attrs
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid Block attributes"))?
                .remove("blockId");
            let children = block["content"].as_array().map_or(&[][..], Vec::as_slice);
            self.add(Desired {
                entity: Entity {
                    id: id.into(),
                    kind: kind.into(),
                    column_id: None,
                    content_root: false,
                },
                attrs,
                inline: if text_type(kind) {
                    children.to_vec()
                } else {
                    vec![]
                },
                parent: Some((parent.into(), region.into())),
            })?;
            if kind == "table" {
                let count = children
                    .first()
                    .and_then(|row| row["content"].as_array())
                    .map_or(0, Vec::len);
                if count == 0
                    || children.iter().any(|row| {
                        row["type"] != "tableRow"
                            || row["content"]
                                .as_array()
                                .is_none_or(|cells| cells.len() != count)
                    })
                {
                    return Err(invalid("Table must be rectangular"));
                }
                let old_columns: Vec<_> = current
                    .children
                    .get(id)
                    .into_iter()
                    .flatten()
                    .filter(|key| current.kind(key) == "tableColumn")
                    .cloned()
                    .collect();
                let mut columns = vec![];
                for index in 0..count {
                    let mut known = BTreeSet::new();
                    for row in children {
                        let row_id = row["attrs"]["blockId"]
                            .as_str()
                            .ok_or_else(|| invalid("Missing Table row identity"))?;
                        let cell_id = row["content"][index]["attrs"]["blockId"]
                            .as_str()
                            .ok_or_else(|| invalid("Missing cell identity"))?;
                        if let Some(column) = current
                            .entities
                            .get(cell_id)
                            .and_then(|entity| entity.column_id.as_ref())
                        {
                            known.insert(column.clone());
                        } else {
                            for column in &old_columns {
                                if derived_id(row_id, &format!("cell:{column}"))? == cell_id {
                                    known.insert(column.clone());
                                }
                            }
                        }
                    }
                    if known.len() > 1 {
                        return Err(invalid("Cells disagree about a stable column"));
                    }
                    let column = known
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
                    if columns.contains(&column) {
                        return Err(invalid("Duplicate Table column"));
                    }
                    self.add(Desired {
                        entity: Entity {
                            id: column.clone(),
                            kind: "tableColumn".into(),
                            column_id: None,
                            content_root: false,
                        },
                        attrs: json!({}),
                        inline: vec![],
                        parent: Some((id.into(), "columns".into())),
                    })?;
                    columns.push(column);
                }
                for row in children {
                    let row_id = row["attrs"]["blockId"].as_str().unwrap();
                    let mut attrs = row.get("attrs").cloned().unwrap_or_else(|| json!({}));
                    attrs.as_object_mut().unwrap().remove("blockId");
                    self.add(Desired {
                        entity: Entity {
                            id: row_id.into(),
                            kind: "tableRow".into(),
                            column_id: None,
                            content_root: false,
                        },
                        attrs,
                        inline: vec![],
                        parent: Some((id.into(), "rows".into())),
                    })?;
                    for (index, cell) in row["content"].as_array().unwrap().iter().enumerate() {
                        let cell_id = cell["attrs"]["blockId"].as_str().unwrap();
                        let mut attrs = cell.get("attrs").cloned().unwrap_or_else(|| json!({}));
                        attrs.as_object_mut().unwrap().remove("blockId");
                        self.add(Desired {
                            entity: Entity {
                                id: cell_id.into(),
                                kind: cell["type"]
                                    .as_str()
                                    .ok_or_else(|| invalid("Invalid cell"))?
                                    .into(),
                                column_id: Some(columns[index].clone()),
                                content_root: false,
                            },
                            attrs,
                            inline: vec![],
                            parent: Some((row_id.into(), "cells".into())),
                        })?;
                        self.blocks(
                            cell["content"].as_array().map_or(&[][..], Vec::as_slice),
                            cell_id,
                            "content",
                            current,
                        )?;
                    }
                }
            } else if !text_type(kind) && !matches!(kind, "horizontalRule" | "image" | "attachment")
            {
                self.blocks(children, id, "content", current)?;
            }
        }
        Ok(())
    }
}

/// Does not mutate the supplied persisted state. The returned delta is validated
/// through the same native projection as readers before the owner can commit it.
pub fn reconcile(
    document: &PersistedDocument,
    root: &Section,
    replica_id: &str,
    updated_at: &str,
) -> Result<Vec<u8>, ReadError> {
    checked_id(replica_id)?;
    if root.section_id != document.document_id || document.schema_version != SCHEMA_VERSION {
        return Err(invalid("Replicated editing identity or schema mismatch"));
    }
    let doc = decode_document(document)?;
    let vector = doc.transact().state_vector();
    let (current, _) = interpret(&doc, &document.document_id)?;
    let mut layout = Layout {
        nodes: BTreeMap::new(),
        groups: BTreeMap::new(),
    };
    layout.section(root, None, &current, 0)?;
    let coordinates: BTreeMap<_, _> = layout
        .nodes
        .iter()
        .filter_map(|(id, node)| {
            node.entity.column_id.as_ref().map(|column| {
                (
                    id.clone(),
                    (column.clone(), node.parent.as_ref().unwrap().0.clone()),
                )
            })
        })
        .collect();
    for (id, node) in &mut layout.nodes {
        node.entity.content_root = if let Some(old) = current.entities.get(id) {
            old.content_root
        } else if let Some((parent, _)) = &node.parent {
            if let Some(column) = &node.entity.column_id {
                derived_id(parent, &format!("cell:{column}"))? == *id
            } else if let Some((column, row)) = coordinates.get(parent) {
                derived_id(parent, "empty-paragraph")? == *id
                    || derived_id(row, &format!("paragraph:{column}"))? == *id
            } else {
                false
            }
        } else {
            false
        };
    }
    for (id, node) in &layout.nodes {
        if current.entities.contains_key(id) && !current.visible.contains(id) {
            return Err(invalid("Protected identities require explicit recovery"));
        }
        if let Some((parent, region)) = &node.parent {
            let parent_type = &layout
                .nodes
                .get(parent)
                .ok_or_else(|| invalid("Unknown parent"))?
                .entity
                .kind;
            if !allowed(&node.entity.kind, parent_type, region) {
                return Err(invalid("Invalid parent or region"));
            }
        }
    }
    let mut positions = BTreeMap::new();
    for ((parent, region), ids) in &layout.groups {
        let old: Vec<_> = current
            .children
            .get(parent)
            .into_iter()
            .flatten()
            .filter(|id| current.parents[*id].region == *region)
            .cloned()
            .collect();
        positions.extend(sibling_positions(ids, &old, &current.parents, replica_id)?);
    }
    {
        let mut txn = doc.transact_mut();
        let entities = txn.get_or_insert_map("entities");
        let placements = txn.get_or_insert_map("placements");
        let history: BTreeMap<String, Placement> =
            serde_json::from_value(read_map(&txn, "placements")?)?;
        let mut counter = history.values().map(|edge| edge.counter).max().unwrap_or(0);
        let mut next_counter = || -> Result<u64, ReadError> {
            if counter >= 9_007_199_254_740_991 {
                return Err(invalid("Placement logical counter exhausted"));
            }
            counter += 1;
            Ok(counter)
        };
        let mut latest = BTreeMap::<String, Placement>::new();
        for edge in history.values() {
            if latest
                .get(&edge.entity_id)
                .is_none_or(|previous| previous < edge)
            {
                latest.insert(edge.entity_id.clone(), edge.clone());
            }
        }
        let moving: BTreeSet<_> = layout
            .nodes
            .iter()
            .filter_map(|(id, node)| {
                let (parent, region) = node.parent.as_ref()?;
                current
                    .parents
                    .get(id)
                    .is_none_or(|old| {
                        old.parent_id != *parent
                            || old.region != *region
                            || old.position != positions[id]
                    })
                    .then_some(id.clone())
            })
            .collect();
        let mut stabilized = BTreeMap::new();
        for id in &moving {
            for start in [
                current.parents.get(id).map(|edge| edge.parent_id.as_str()),
                layout.nodes[id].parent.as_ref().map(|edge| edge.0.as_str()),
            ]
            .into_iter()
            .flatten()
            {
                let mut cursor = start;
                while let Some(edge) = current.parents.get(cursor) {
                    if !moving.contains(cursor) && latest.get(cursor) != Some(edge) {
                        stabilized.insert(cursor.to_owned(), edge.clone());
                    }
                    cursor = &edge.parent_id;
                }
            }
        }
        for (_, mut edge) in stabilized {
            edge.operation_id = uuid::Uuid::now_v7().to_string();
            edge.replica_id = replica_id.into();
            edge.counter = next_counter()?;
            placements.insert(
                &mut txn,
                edge.operation_id.as_str(),
                any(&serde_json::to_value(&edge)?)?,
            );
        }
        for (id, desired) in &layout.nodes {
            if !current.entities.contains_key(id) {
                entities.insert(
                    &mut txn,
                    id.as_str(),
                    any(&serde_json::to_value(&desired.entity)?)?,
                );
            }
            let mut attrs = desired.attrs.clone();
            attrs
                .as_object_mut()
                .unwrap()
                .retain(|_, value| !value.is_null());
            if current
                .entities
                .get(id)
                .is_some_and(|old| old.kind != desired.entity.kind)
            {
                attrs["type"] = desired.entity.kind.clone().into();
            }
            let (map, fragment) = writable_content(
                &mut txn,
                current.entities.get(id).unwrap_or(&desired.entity),
            )?;
            let existing: Value = serde_json::to_value(map.to_json(&txn))?;
            for key in existing
                .as_object()
                .unwrap()
                .keys()
                .chain(attrs.as_object().unwrap().keys())
                .collect::<BTreeSet<_>>()
            {
                if existing.get(key) == attrs.get(key) {
                    continue;
                }
                match attrs.get(key) {
                    Some(value) => {
                        map.insert(&mut txn, key.as_str(), any(value)?);
                    }
                    None => {
                        map.remove(&mut txn, key);
                    }
                }
            }
            // Content that no longer fits a changed type remains in its stable
            // inline root and is available through protected-content recovery.
            if text_type(&desired.entity.kind) || !current.entities.contains_key(id) {
                sync_inline(&mut txn, &fragment, &desired.inline)?;
            }
            if let Some((parent, region)) = &desired.parent {
                let position = &positions[id];
                if current.parents.get(id).is_none_or(|old| {
                    old.parent_id != *parent || old.region != *region || old.position != *position
                }) {
                    let operation_id = uuid::Uuid::now_v7().to_string();
                    let counter = next_counter()?;
                    let placement = Placement {
                        operation_id: operation_id.clone(),
                        replica_id: replica_id.into(),
                        counter,
                        entity_id: id.clone(),
                        parent_id: parent.clone(),
                        region: region.clone(),
                        position: position.clone(),
                    };
                    placements.insert(
                        &mut txn,
                        operation_id,
                        any(&serde_json::to_value(placement)?)?,
                    );
                }
            }
        }
        let deleted: Vec<_> = current
            .visible
            .iter()
            .filter(|id| !layout.nodes.contains_key(*id))
            .cloned()
            .collect();
        if !deleted.is_empty() {
            let id = uuid::Uuid::now_v7().to_string();
            txn.get_or_insert_map("deletions").insert(
                &mut txn,
                id.as_str(),
                any(&json!({"operationId":id,"replicaId":replica_id,"entityIds":deleted}))?,
            );
        }
        txn.get_or_insert_map("meta")
            .insert(&mut txn, "updated_at", updated_at);
    }
    let (_, after) = interpret(&doc, &document.document_id)?;
    if normalized(serde_json::to_value(&after.root)?) != normalized(serde_json::to_value(root)?) {
        return Err(invalid(
            "Core edit did not preserve the requested content and identities",
        ));
    }
    Ok(doc.transact().encode_state_as_update_v1(&vector))
}

fn sibling_positions(
    ids: &[String],
    previous: &[String],
    parents: &BTreeMap<String, Placement>,
    seed: &str,
) -> Result<BTreeMap<String, String>, ReadError> {
    if ids == previous {
        return Ok(ids
            .iter()
            .map(|id| (id.clone(), parents[id].position.clone()))
            .collect());
    }
    let old: BTreeSet<_> = previous.iter().collect();
    let entries: Vec<_> = ids.iter().filter(|id| old.contains(id)).collect();
    let mut tails = Vec::<usize>::new();
    let mut predecessors = BTreeMap::new();
    for (index, id) in entries.iter().enumerate() {
        let slot =
            tails.partition_point(|tail| parents[entries[*tail]].position < parents[*id].position);
        if slot > 0 {
            predecessors.insert(index, tails[slot - 1]);
        }
        if slot == tails.len() {
            tails.push(index);
        } else {
            tails[slot] = index;
        }
    }
    let mut stable = BTreeSet::new();
    let mut cursor = tails.last().copied();
    while let Some(index) = cursor {
        stable.insert(entries[index].clone());
        cursor = predecessors.get(&index).copied();
    }
    let mut result = BTreeMap::new();
    let mut low: Option<String> = None;
    for (index, id) in ids.iter().enumerate() {
        let key = if stable.contains(id) {
            parents[id].position.clone()
        } else {
            let upper = ids[index + 1..]
                .iter()
                .find(|id| stable.contains(*id))
                .map(|id| parents[id].position.as_str());
            crate::sibling_position::between(low.as_deref(), upper, &format!("{seed}:{id}"))?
        };
        low = Some(key.clone());
        result.insert(id.clone(), key);
    }
    Ok(result)
}

fn any(value: &Value) -> Result<yrs::Any, ReadError> {
    yrs::Any::from_json(&value.to_string()).map_err(|_| invalid("Invalid shared attribute"))
}
fn writable_content(
    txn: &mut yrs::TransactionMut,
    entity: &Entity,
) -> Result<(yrs::MapRef, XmlFragmentRef), ReadError> {
    if named_content(txn, entity) {
        return Ok((
            txn.get_or_insert_map(format!("attrs:{}", entity.id)),
            txn.get_or_insert_xml_fragment(format!("inline:{}", entity.id)),
        ));
    }
    let registry = txn.get_or_insert_map("content");
    let entry = match registry.get(txn, &entity.id) {
        Some(yrs::Out::YMap(entry)) => entry,
        None => {
            let entry = registry.insert(txn, entity.id.as_str(), yrs::MapPrelim::default());
            entry.insert(txn, "attrs", yrs::MapPrelim::default());
            entry.insert(txn, "inline", yrs::XmlFragmentPrelim::default());
            entry
        }
        _ => return Err(invalid("Invalid stable content registry entry")),
    };
    match (entry.get(txn, "attrs"), entry.get(txn, "inline")) {
        (Some(yrs::Out::YMap(attrs)), Some(yrs::Out::YXmlFragment(inline))) => Ok((attrs, inline)),
        _ => Err(invalid("Invalid stable entity content")),
    }
}
// Compare content semantics, not the storage shape of legacy XML. Unset PM
// attributes can be null or absent, and adjacent text nodes with identical
// formatting can share one Y.Text run. Populated attributes, marks, identities,
// text and structural boundaries must still match exactly.
fn normalized(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            for child in object.values_mut() {
                *child = normalized(child.take());
            }
            if let Some(Value::Object(attrs)) = object.get_mut("attrs") {
                attrs.retain(|_, value| !value.is_null());
            }
            object.retain(|key, value| {
                !matches!(key.as_str(), "attrs" | "content" | "marks")
                    || !(value.as_array().is_some_and(Vec::is_empty)
                        || value.as_object().is_some_and(serde_json::Map::is_empty))
            });
            if let Some(Value::Array(content)) = object.get_mut("content") {
                let mut merged: Vec<Value> = Vec::with_capacity(content.len());
                for node in std::mem::take(content) {
                    if let (Some(Value::Object(previous)), Value::Object(next)) =
                        (merged.last_mut(), &node)
                    {
                        if next.get("type").and_then(Value::as_str) == Some("text")
                            && previous.len() == next.len()
                            && next.iter().all(|(key, value)| {
                                key == "text" || previous.get(key) == Some(value)
                            })
                        {
                            if let (Some(Value::String(text)), Some(Value::String(suffix))) =
                                (previous.get_mut("text"), next.get("text"))
                            {
                                text.push_str(suffix);
                                continue;
                            }
                        }
                    }
                    merged.push(node);
                }
                *content = merged;
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = normalized(item.take());
            }
        }
        _ => {}
    }
    value
}

enum Inline {
    Text(String, Vec<(String, Attrs)>),
    Atom(Value),
}
fn sync_inline(
    txn: &mut yrs::TransactionMut,
    fragment: &XmlFragmentRef,
    nodes: &[Value],
) -> Result<(), ReadError> {
    let mut desired = Vec::<Inline>::new();
    for node in nodes {
        if node["type"] != "text" {
            desired.push(Inline::Atom(node.clone()));
            continue;
        }
        let text = node["text"]
            .as_str()
            .ok_or_else(|| invalid("Invalid inline text"))?;
        if text.is_empty() {
            continue;
        }
        let mut attrs = Attrs::new();
        for mark in node["marks"].as_array().map_or(&[][..], Vec::as_slice) {
            attrs.insert(
                mark["type"]
                    .as_str()
                    .ok_or_else(|| invalid("Invalid mark"))?
                    .into(),
                any(mark.get("attrs").unwrap_or(&json!({})))?,
            );
        }
        if !matches!(desired.last(), Some(Inline::Text(..))) {
            desired.push(Inline::Text(String::new(), vec![]));
        }
        if let Some(Inline::Text(value, runs)) = desired.last_mut() {
            value.push_str(text);
            runs.push((text.into(), attrs));
        }
    }
    for (index, node) in desired.iter().enumerate() {
        let index = index as u32;
        let current = fragment.get(txn, index);
        let compatible = |current: &XmlOut, node: &Inline| match (current, node) {
            (XmlOut::Text(_), Inline::Text(..)) => true,
            (XmlOut::Element(element), Inline::Atom(node)) => {
                node["type"].as_str() == Some(element.tag().as_ref())
            }
            _ => false,
        };
        if current
            .as_ref()
            .is_none_or(|current| !compatible(current, node))
        {
            let keep = current.as_ref().is_some_and(|current| {
                desired
                    .get(index as usize + 1)
                    .is_some_and(|next| compatible(current, next))
            });
            if current.is_some() && !keep {
                fragment.remove_range(txn, index, 1);
            }
            match node {
                Inline::Text(..) => {
                    fragment.insert(txn, index, XmlTextPrelim::new(""));
                }
                Inline::Atom(node) => {
                    fragment.insert(
                        txn,
                        index,
                        XmlElementPrelim::empty(
                            node["type"]
                                .as_str()
                                .ok_or_else(|| invalid("Missing inline type"))?,
                        ),
                    );
                }
            }
        }
        match (fragment.get(txn, index).unwrap(), node) {
            (XmlOut::Text(text), Inline::Text(value, runs)) => sync_text(txn, &text, value, runs),
            (XmlOut::Element(element), Inline::Atom(value)) => {
                let old: BTreeSet<_> = element
                    .attributes(txn)
                    .map(|(key, _)| key.to_string())
                    .collect();
                let attrs = value["attrs"].as_object().cloned().unwrap_or_default();
                for key in old.iter().chain(attrs.keys()).collect::<BTreeSet<_>>() {
                    let before = element
                        .get_attribute(txn, key)
                        .map(|value| value.to_json(txn));
                    let next = attrs.get(key).map(any).transpose()?;
                    if before == next {
                        continue;
                    }
                    if let Some(value) = next {
                        element.insert_attribute(txn, key.as_str(), value);
                    } else {
                        element.remove_attribute(txn, key);
                    }
                }
                sync_inline(
                    txn,
                    element.as_ref(),
                    value["content"].as_array().map_or(&[][..], Vec::as_slice),
                )?;
            }
            _ => return Err(invalid("Invalid inline projection")),
        }
    }
    let remaining = fragment.len(txn) - desired.len() as u32;
    if remaining > 0 {
        fragment.remove_range(txn, desired.len() as u32, remaining);
    }
    Ok(())
}

fn sync_text(
    txn: &mut yrs::TransactionMut,
    text: &XmlTextRef,
    desired: &str,
    runs: &[(String, Attrs)],
) {
    let old: String = text
        .diff(txn, |_| ())
        .into_iter()
        .filter_map(|part| match part.insert {
            yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
            _ => None,
        })
        .collect();
    let mut start = old
        .bytes()
        .zip(desired.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(start) || !desired.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = old[start..]
        .bytes()
        .rev()
        .zip(desired[start..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - end) || !desired.is_char_boundary(desired.len() - end) {
        end -= 1;
    }
    if old.len() > start + end {
        text.remove_range(txn, start as u32, (old.len() - start - end) as u32);
    }
    if desired.len() > start + end {
        text.insert(txn, start as u32, &desired[start..desired.len() - end]);
    }
    let previous = text.diff(txn, |_| ());
    let mut offset = 0u32;
    let (mut run_index, mut run_offset) = (0usize, 0usize);
    for part in previous {
        let yrs::Out::Any(yrs::Any::String(value)) = part.insert else {
            continue;
        };
        let old_attrs = part.attributes.map(|attrs| *attrs).unwrap_or_default();
        let mut left = value.len();
        while left > 0 {
            let (run, attrs) = &runs[run_index];
            let size = left.min(run.len() - run_offset);
            let mut changes = Attrs::new();
            for key in old_attrs.keys().chain(attrs.keys()) {
                if old_attrs.get(key) != attrs.get(key) {
                    changes.insert(
                        key.clone(),
                        attrs.get(key).cloned().unwrap_or(yrs::Any::Null),
                    );
                }
            }
            if !changes.is_empty() {
                text.format(txn, offset, size as u32, changes);
            }
            offset += size as u32;
            left -= size;
            run_offset += size;
            if run_offset == run.len() {
                run_index += 1;
                run_offset = 0;
            }
        }
    }
}

/// An isolated, schema-6 view for existing CLI planning and edit descriptors.
pub fn legacy_projection(note: &crate::document_model::Note) -> Result<Doc, ReadError> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let meta = txn.get_or_insert_map("meta");
        meta.insert(&mut txn, "note_id", note.note_id.as_str());
        meta.insert(&mut txn, "schema_version", 6);
        let root = txn
            .get_or_insert_xml_fragment("body")
            .push_back(&mut txn, XmlElementPrelim::empty("section"));
        write_section(&mut txn, &root, &note.root)?;
    }
    Ok(doc)
}
fn write_section(
    txn: &mut yrs::TransactionMut,
    element: &XmlElementRef,
    section: &Section,
) -> Result<(), ReadError> {
    let header = element.push_back(txn, XmlElementPrelim::empty("sectionHeader"));
    header.insert_attribute(txn, "sectionId", section.section_id.as_str());
    header.insert_attribute(txn, "tags", serde_json::to_string(&section.tags)?);
    if let Some(emoji) = &section.emoji {
        header.insert_attribute(txn, "emoji", emoji.as_str());
    }
    header.push_back(txn, XmlTextPrelim::new(section.title.as_str()));
    let body = element.push_back(txn, XmlElementPrelim::empty("sectionBody"));
    for blocks in section.body.chunks(256) {
        let chunk = body.push_back(txn, XmlElementPrelim::empty("bodyChunk"));
        chunk.insert_attribute(txn, "chunkId", uuid::Uuid::now_v7().to_string());
        for block in blocks {
            write_block(txn, &chunk, block)?;
        }
    }
    let children = element.push_back(txn, XmlElementPrelim::empty("sectionChildren"));
    for child in &section.children {
        let element = children.push_back(txn, XmlElementPrelim::empty("section"));
        write_section(txn, &element, child)?;
    }
    Ok(())
}
fn write_block(
    txn: &mut yrs::TransactionMut,
    parent: &XmlElementRef,
    node: &Value,
) -> Result<(), ReadError> {
    let kind = node["type"]
        .as_str()
        .ok_or_else(|| invalid("Missing node type"))?;
    let element = parent.push_back(txn, XmlElementPrelim::empty(kind));
    if let Some(attrs) = node["attrs"].as_object() {
        for (key, value) in attrs {
            element.insert_attribute(txn, key.as_str(), any(value)?);
        }
    }
    let mut text: Option<XmlTextRef> = None;
    for child in node["content"].as_array().map_or(&[][..], Vec::as_slice) {
        if child["type"] == "text" {
            let text = text.get_or_insert_with(|| element.push_back(txn, XmlTextPrelim::new("")));
            let mut attrs = Attrs::new();
            for mark in child["marks"].as_array().map_or(&[][..], Vec::as_slice) {
                attrs.insert(
                    mark["type"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid mark"))?
                        .into(),
                    any(mark.get("attrs").unwrap_or(&json!({})))?,
                );
            }
            let end = text.len(txn);
            text.insert_with_attributes(txn, end, child["text"].as_str().unwrap_or(""), attrs);
        } else {
            text = None;
            write_block(txn, &element, child)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{StateVector, Update, updates::decoder::Decode};

    fn fixture() -> PersistedDocument {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/replicated-note-contract.json"
        ))
        .unwrap();
        let value = &fixtures[0];
        PersistedDocument {
            kind: "note".into(),
            document_id: value["noteId"].as_str().unwrap().into(),
            schema_version: 7,
            revision: 1,
            snapshot_revision: 1,
            snapshot: serde_json::from_value(value["snapshot"].clone()).unwrap(),
            updates: vec![],
        }
    }
    #[test]
    fn migrates_and_edits_internal_link_labels_without_losing_text_or_marks() {
        let source = fixture();
        let mut note = crate::document_model::read_note(&source, false).unwrap();
        let block_id = uuid::Uuid::now_v7().to_string();
        let link = json!({"type":"internalSectionLink","attrs":{"targetSectionId":note.note_id},"content":[{"type":"text","text":"リンク先の表示名","marks":[{"type":"bold"}]}]});
        note.root
            .body
            .push(json!({"type":"paragraph","attrs":{"blockId":block_id},"content":[link]}));
        let legacy = legacy_projection(&note).unwrap();
        let legacy = PersistedDocument {
            schema_version: 6,
            snapshot: legacy
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            ..source.clone()
        };
        let migrated = PersistedDocument {
            schema_version: 7,
            snapshot: migrate(&legacy, &uuid::Uuid::now_v7().to_string()).unwrap(),
            ..source
        };
        let root = read(&migrated).unwrap().root;
        assert_eq!(
            normalized(serde_json::to_value(&root).unwrap()),
            normalized(serde_json::to_value(&note.root).unwrap())
        );
        let mut changed = root;
        changed.body.last_mut().unwrap()["content"][0]["content"][0]["text"] =
            json!("更新した表示名");
        let delta = reconcile(
            &migrated,
            &changed,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T00:00:00.000Z",
        )
        .unwrap();
        let edited = apply(&migrated, &[delta]);
        assert_eq!(
            normalized(serde_json::to_value(read(&edited).unwrap().root).unwrap()),
            normalized(serde_json::to_value(&changed).unwrap())
        );
    }

    #[test]
    fn converts_a_legacy_note_without_changing_content_ids_or_the_source() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/reader-contract.json"))
                .unwrap();
        let record = fixtures["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|doc| doc["kind"] == "note")
            .unwrap();
        let mut source = PersistedDocument {
            kind: "note".into(),
            document_id: record["document_id"].as_str().unwrap().into(),
            schema_version: record["schema_version"].as_i64().unwrap(),
            revision: 1,
            snapshot_revision: 1,
            snapshot: serde_json::from_value(record["snapshot"].clone()).unwrap(),
            updates: vec![],
        };
        let expected = crate::document_model::read_note(&source, true)
            .unwrap()
            .root;
        let before = source.snapshot.clone();
        let snapshot = migrate(&source, &uuid::Uuid::now_v7().to_string()).unwrap();
        assert_eq!(source.snapshot, before);
        source.schema_version = 7;
        source.snapshot = snapshot;
        source.snapshot_revision = source.revision;
        source.updates.clear();
        assert_eq!(
            normalized(serde_json::to_value(read(&source).unwrap().root).unwrap()),
            normalized(serde_json::to_value(expected).unwrap())
        );
    }

    #[test]
    fn migrates_editor_defaults_and_split_identically_marked_xml_text() {
        fn add_defaults(node: &mut Value) {
            let defaults: &[&str] = match node["type"].as_str().unwrap_or("") {
                "listItem" => &["checked"],
                "orderedList" => &["type"],
                "blockquote" => &["alertTitle", "alertFold"],
                "tableCell" | "tableHeader" => &["colwidth", "align"],
                _ => &[],
            };
            for key in defaults {
                node["attrs"]
                    .as_object_mut()
                    .unwrap()
                    .entry(*key)
                    .or_insert(Value::Null);
            }
            if let Some(children) = node["content"].as_array_mut() {
                for child in children {
                    add_defaults(child);
                }
            }
        }
        let source = fixture();
        let mut note = crate::document_model::read_note(&source, false).unwrap();
        for block in &mut note.root.body {
            add_defaults(block);
        }
        let legacy = legacy_projection(&note).unwrap();
        {
            let mut txn = legacy.transact_mut();
            let mut element = txn.get_xml_fragment("body").unwrap();
            // Root Section -> SectionBody -> BodyChunk -> first paragraph.
            for index in [0, 1, 0, 0] {
                let XmlOut::Element(child) = element.get(&txn, index).unwrap() else {
                    panic!("missing fixture element");
                };
                let fragment: &XmlFragmentRef = child.as_ref();
                element = fragment.clone();
            }
            let count = element.len(&txn);
            element.remove_range(&mut txn, 0, count);
            for (value, bold) in [("日本", true), ("語🙂", true), (" plain", false)] {
                let text = element.push_back(&mut txn, XmlTextPrelim::new(""));
                let mut marks = Attrs::new();
                if bold {
                    marks.insert("bold".into(), any(&json!({})).unwrap());
                }
                text.insert_with_attributes(&mut txn, 0, value, marks);
            }
        }
        let legacy = PersistedDocument {
            schema_version: 6,
            snapshot: legacy
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            ..source
        };
        let before = legacy.snapshot.clone();
        let expected = crate::document_model::read_note(&legacy, true).unwrap();
        assert_eq!(
            expected.root.body[0]["content"].as_array().unwrap().len(),
            3
        );
        let migrated = PersistedDocument {
            schema_version: 7,
            snapshot: migrate(&legacy, &uuid::Uuid::now_v7().to_string()).unwrap(),
            ..legacy.clone()
        };
        let actual = read(&migrated).unwrap();
        assert_eq!(
            actual.root.body[0]["content"],
            json!([
                {"type":"text", "text":"日本語🙂", "marks":[{"type":"bold"}]},
                {"type":"text", "text":" plain"},
            ])
        );
        assert_eq!(
            normalized(serde_json::to_value(&actual.root).unwrap()),
            normalized(serde_json::to_value(&expected.root).unwrap())
        );
        assert_eq!(legacy.snapshot, before);
    }

    #[test]
    fn content_comparison_rejects_changes_to_values_marks_ids_and_structure() {
        let node = json!({"type":"paragraph", "attrs":{"blockId":"stable"}, "content":[{"type":"text", "text":"日本語🙂", "marks":[{"type":"bold"}]}]});
        for value in [json!(false), json!(0), json!(""), json!([120])] {
            let mut changed = node.clone();
            changed["attrs"]["setting"] = value;
            assert_ne!(normalized(changed), normalized(node.clone()));
        }
        for (path, replacement) in [
            ("/attrs/blockId", json!("other")),
            ("/content/0/text", json!("日本語")),
            ("/content/0/marks", json!([])),
            ("/type", json!("codeBlock")),
        ] {
            let mut changed = node.clone();
            *changed.pointer_mut(path).unwrap() = replacement;
            assert_ne!(normalized(changed), normalized(node.clone()));
        }
        let mut broken = node.clone();
        broken["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"hardBreak"}));
        assert_ne!(normalized(broken), normalized(node.clone()));
        assert_ne!(
            normalized(json!({"content":[node.clone(), node]})),
            normalized(json!({"content":[]}))
        );
    }

    fn apply(source: &PersistedDocument, updates: &[Vec<u8>]) -> PersistedDocument {
        let doc = decode_document(source).unwrap();
        for update in updates {
            doc.transact_mut()
                .apply_update(Update::decode_v1(update).unwrap())
                .unwrap();
        }
        PersistedDocument {
            snapshot: doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            ..source.clone()
        }
    }
    fn moved(root: &Section) -> Section {
        let mut root = root.clone();
        let children = std::mem::take(&mut root.children);
        root.children.push(Section {
            section_id: uuid::Uuid::now_v7().to_string(),
            title: "移動先".into(),
            tags: vec![],
            emoji: None,
            body: vec![],
            children,
        });
        root
    }
    #[test]
    fn preserves_inline_identity_and_formatting_across_a_native_move() {
        let source = fixture();
        let doc = decode_document(&source).unwrap();
        let (model, projection) = interpret(&doc, &source.document_id).unwrap();
        let target = moved(&projection.root);
        let update = reconcile(
            &source,
            &target,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T00:00:00.000Z",
        )
        .unwrap();
        let merged = apply(&source, &[update]);
        let after_doc = decode_document(&merged).unwrap();
        let after = read(&merged).unwrap();
        assert_eq!(
            normalized(serde_json::to_value(&after.root).unwrap()),
            normalized(serde_json::to_value(target).unwrap())
        );
        for entity in model.entities.values() {
            let before = entity_inline(&doc.transact(), entity).unwrap();
            let after = entity_inline(&after_doc.transact(), entity).unwrap();
            assert_eq!(
                before.as_ref().map(|value| {
                    let branch: &yrs::branch::Branch = value.as_ref();
                    branch.id()
                }),
                after.as_ref().map(|value| {
                    let branch: &yrs::branch::Branch = value.as_ref();
                    branch.id()
                })
            );
        }
    }

    #[test]
    fn native_moves_into_a_cycle_corrected_ancestor_preserve_its_placement() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/replicated-note-contract.json"
        ))
        .unwrap();
        let source = PersistedDocument {
            document_id: fixtures[1]["noteId"].as_str().unwrap().into(),
            snapshot: serde_json::from_value(fixtures[1]["snapshot"].clone()).unwrap(),
            ..fixture()
        };
        let doc = decode_document(&source).unwrap();
        let (model, projection) = interpret(&doc, &source.document_id).unwrap();
        let history: BTreeMap<String, Placement> =
            serde_json::from_value(read_map(&doc.transact(), "placements").unwrap()).unwrap();
        let corrected = model
            .parents
            .iter()
            .find(|(id, edge)| {
                history
                    .values()
                    .filter(|candidate| candidate.entity_id == **id)
                    .max()
                    .is_some_and(|latest| latest != *edge)
            })
            .unwrap()
            .0;
        let mut target = projection.root.clone();
        let child = target.children.remove(0);
        let child_id = child.section_id.clone();
        target
            .children
            .iter_mut()
            .find(|section| section.section_id == *corrected)
            .unwrap()
            .children
            .push(child);
        let original_inline = entity_inline(&doc.transact(), &model.entities[&child_id])
            .unwrap()
            .unwrap();
        let update = reconcile(
            &source,
            &target,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T04:00:00.000Z",
        )
        .unwrap();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        let (after, projection) = interpret(&doc, &source.document_id).unwrap();
        assert_eq!(
            normalized(serde_json::to_value(projection.root).unwrap()),
            normalized(serde_json::to_value(target).unwrap())
        );
        assert_eq!(
            after.parents[corrected].parent_id,
            model.parents[corrected].parent_id
        );
        let retained = entity_inline(&doc.transact(), &after.entities[&child_id])
            .unwrap()
            .unwrap();
        use yrs::SharedRef;
        assert_eq!(original_inline.hook(), retained.hook());
    }

    #[test]
    fn native_update_fixture() {
        let source = fixture();
        let projection = read(&source).unwrap();
        let move_target = moved(&projection.root);
        let movement = reconcile(
            &source,
            &move_target,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T01:00:00.000Z",
        )
        .unwrap();
        let mut edited = projection.root.clone();
        let paragraph = &mut edited.children[0].body[0];
        let edited_id = paragraph["attrs"]["blockId"].as_str().unwrap().to_string();
        paragraph["content"][0]["text"] = format!(
            "🙂 Rust {}",
            paragraph["content"][0]["text"].as_str().unwrap()
        )
        .into();
        let text_update = reconcile(
            &source,
            &edited,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T02:00:00.000Z",
        )
        .unwrap();
        let mut removed = projection.root.clone();
        let deleted_id = removed.children.remove(0).section_id;
        let deletion = reconcile(
            &source,
            &removed,
            &uuid::Uuid::now_v7().to_string(),
            "2026-09-10T03:00:00.000Z",
        )
        .unwrap();
        let merged = apply(&source, &[movement.clone(), text_update.clone()]);
        let reverse = apply(
            &source,
            &[text_update.clone(), movement.clone(), movement.clone()],
        );
        assert_eq!(
            normalized(serde_json::to_value(read(&merged).unwrap()).unwrap()),
            normalized(serde_json::to_value(read(&reverse).unwrap()).unwrap())
        );
        let deleted = read(&apply(&source, &[deletion.clone(), text_update.clone()])).unwrap();
        assert!(
            deleted
                .recovery
                .iter()
                .any(|item| item.entity_id == edited_id)
        );
        if let Some(path) = std::env::var_os("MEMOKA_REPLICATED_NATIVE_FIXTURE") {
            let output = json!({
                "noteId":source.document_id, "snapshot":source.snapshot, "moveUpdate":movement,
                "textUpdate":text_update,"deleteUpdate":deletion,"editedBlockId":edited_id,"deletedSectionId":deleted_id,
                "merged":read(&merged).unwrap(),"deleted":deleted
            });
            std::fs::write(path, serde_json::to_vec(&output).unwrap()).unwrap();
        }
    }
}
