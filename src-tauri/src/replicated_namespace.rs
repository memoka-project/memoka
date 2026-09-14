//! Workspace v4 uses the same parent-history projection as normalized Notes.
//! Readers, CLI planning and migration share this interpretation.
use crate::attachment::validate_uuid_v7;
use crate::document_model::{ReadError, decode_document, workspace_json};
use crate::namespace::{Entry, Namespace};
use crate::persistence::PersistedDocument;
use crate::replicated_tree::{Placement, derive_tree};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yrs::{Any, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact};

pub const SCHEMA_VERSION: i64 = 4;
const LIMIT: usize = 1_000_000;
const PLACEMENT_FIELDS: [&str; 4] = [
    "parent_entry_id",
    "position",
    "deleted_at",
    "trash_operation_id",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Deletion {
    operation_id: String,
    replica_id: String,
    counter: u64,
    entity_ids: Vec<String>,
    at: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restoration {
    operation_id: String,
    replica_id: String,
    deletion_id: String,
    entity_ids: Vec<String>,
}
struct Model {
    namespace: Namespace,
    placements: BTreeMap<String, Placement>,
    parents: BTreeMap<String, Placement>,
    counter: u64,
}
fn invalid(message: &str) -> ReadError {
    ReadError::new("INVALID_NAMESPACE", message)
}
fn id(value: &str) -> Result<(), ReadError> {
    Ok(validate_uuid_v7(value, "Namespace identity")?)
}
fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, ReadError> {
    let value = value
        .as_object()
        .ok_or_else(|| invalid("Namespace map is missing"))?;
    if value.len() > LIMIT {
        return Err(invalid("Namespace operation limit exceeded"));
    }
    Ok(value)
}
fn operation(
    key: &str,
    operation_id: &str,
    replica: &str,
    entity_ids: &[String],
    ids: &BTreeSet<String>,
    root: &str,
) -> Result<(), ReadError> {
    id(key)?;
    id(replica)?;
    if key != operation_id
        || entity_ids.is_empty()
        || entity_ids.iter().collect::<BTreeSet<_>>().len() != entity_ids.len()
        || entity_ids.iter().any(|id| id == root || !ids.contains(id))
    {
        return Err(invalid("Invalid Namespace deletion or restoration"));
    }
    Ok(())
}

pub fn project(value: &Value) -> Result<Namespace, ReadError> {
    Ok(interpret(value)?.namespace)
}
fn interpret(value: &Value) -> Result<Model, ReadError> {
    if value["schema_version"].as_i64() != Some(SCHEMA_VERSION) {
        return Err(invalid("Unsupported replicated Workspace schema"));
    }
    let raw = &value["main_namespace"];
    let root = raw["namespace_id"]
        .as_str()
        .ok_or_else(|| invalid("Namespace ID is missing"))?;
    id(root)?;
    let raw_entries = object(&raw["entries"])?;
    let mut ids = raw_entries.keys().cloned().collect::<BTreeSet<_>>();
    for value in &ids {
        id(value)?;
    }
    if !ids.insert(root.to_owned()) {
        return Err(invalid("Entry ID reuses Namespace ID"));
    }
    object(&raw["placements"])?;
    object(&raw["deletions"])?;
    object(&raw["restorations"])?;
    let placements: BTreeMap<String, Placement> =
        serde_json::from_value(raw["placements"].clone())?;
    if placements.values().any(|edge| edge.region != "entries") {
        return Err(invalid("Invalid Namespace placement region"));
    }
    let parents = derive_tree(root, &ids, &placements)?;
    let deletions: BTreeMap<String, Deletion> = serde_json::from_value(raw["deletions"].clone())?;
    let restorations: BTreeMap<String, Restoration> =
        serde_json::from_value(raw["restorations"].clone())?;
    let mut restored: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut observed = BTreeMap::new();
    let mut counter = placements
        .values()
        .map(|edge| edge.counter)
        .max()
        .unwrap_or(0);
    for (key, deletion) in &deletions {
        operation(
            key,
            &deletion.operation_id,
            &deletion.replica_id,
            &deletion.entity_ids,
            &ids,
            root,
        )?;
        if deletion.counter == 0
            || deletion.counter > 9_007_199_254_740_991
            || chrono::DateTime::parse_from_rfc3339(&deletion.at).is_err()
        {
            return Err(invalid("Invalid Namespace deletion"));
        }
        counter = counter.max(deletion.counter);
        observed.insert(key, deletion.entity_ids.iter().collect::<BTreeSet<_>>());
    }
    for (key, restoration) in &restorations {
        operation(
            key,
            &restoration.operation_id,
            &restoration.replica_id,
            &restoration.entity_ids,
            &ids,
            root,
        )?;
        let deleted = observed
            .get(&restoration.deletion_id)
            .ok_or_else(|| invalid("Unknown Namespace deletion"))?;
        if restoration
            .entity_ids
            .iter()
            .any(|id| !deleted.contains(id))
        {
            return Err(invalid("Restoration exceeds its observed deletion"));
        }
        restored
            .entry(restoration.deletion_id.clone())
            .or_default()
            .extend(restoration.entity_ids.iter().cloned());
    }
    let mut active: BTreeMap<&str, &Deletion> = BTreeMap::new();
    for (key, deletion) in &deletions {
        for entity_id in &deletion.entity_ids {
            if restored.get(key).is_some_and(|set| set.contains(entity_id)) {
                continue;
            }
            let previous = active.get(entity_id.as_str());
            let priority = |d: &Deletion| (d.counter, d.replica_id.clone(), d.operation_id.clone());
            if previous.is_none_or(|previous| priority(previous) < priority(deletion)) {
                active.insert(entity_id, deletion);
            }
        }
    }
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (key, edge) in &parents {
        children.entry(&edge.parent_id).or_default().push(key);
    }
    let mut effective = BTreeMap::new();
    let mut entries = BTreeMap::new();
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        for child in children.get(parent).into_iter().flatten() {
            let stamp = active
                .get(child)
                .copied()
                .or_else(|| effective.get(parent).copied());
            if let Some(stamp) = stamp {
                effective.insert(*child, stamp);
            }
            let mut value = raw_entries[*child].clone();
            let fields = value
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid Namespace Entry"))?;
            if PLACEMENT_FIELDS
                .iter()
                .any(|field| fields.contains_key(*field))
            {
                return Err(invalid(
                    "Replicated Entry placement and Trash must live in histories",
                ));
            }
            fields.insert(
                "parent_entry_id".into(),
                if parent == root {
                    Value::Null
                } else {
                    json!(parent)
                },
            );
            fields.insert("position".into(), json!(parents[*child].position));
            fields.insert("deleted_at".into(), json!(stamp.map(|stamp| &stamp.at)));
            fields.insert(
                "trash_operation_id".into(),
                json!(stamp.map(|stamp| &stamp.operation_id)),
            );
            let mut entry: Entry = serde_json::from_value(value)?;
            entry.entry_id = (*child).to_owned();
            entries.insert((*child).to_owned(), entry);
            pending.push(child);
        }
    }
    let mut notes: BTreeMap<String, Value> = serde_json::from_value(value["notes"].clone())?;
    for note in notes.values() {
        if note.get("deleted_at").is_some() || note.get("trash_operation_id").is_some() {
            return Err(invalid(
                "Replicated Note Trash must live in Namespace histories",
            ));
        }
    }
    for entry in entries.values() {
        if let Some(target) = &entry.target {
            let note = notes
                .get_mut(&target.id)
                .ok_or_else(|| invalid("Namespace target Note is missing"))?;
            note["deleted_at"] = json!(entry.deleted_at);
            note["trash_operation_id"] = json!(entry.trash_operation_id);
        }
    }
    let namespace = Namespace {
        namespace_id: root.to_owned(),
        entries,
        notes,
    };
    namespace.validate()?;
    Ok(Model {
        namespace,
        placements,
        parents,
        counter,
    })
}

fn nested<T: ReadTxn>(txn: &T, parent: &MapRef, key: &str) -> Result<MapRef, ReadError> {
    match parent.get(txn, key) {
        Some(Out::YMap(value)) => Ok(value),
        _ => Err(invalid("Namespace shared map is missing")),
    }
}
fn any(value: &Value) -> Result<Any, ReadError> {
    Any::from_json(&value.to_string()).map_err(|_| invalid("Invalid Namespace value"))
}
fn put(
    txn: &mut yrs::TransactionMut,
    map: &MapRef,
    key: &str,
    value: &Value,
) -> Result<(), ReadError> {
    use yrs::types::ToJson;
    if map
        .get(txn, key)
        .map(|old| serde_json::to_value(old.to_json(txn)))
        .transpose()?
        .as_ref()
        != Some(value)
    {
        map.insert(txn, key, any(value)?);
    }
    Ok(())
}
fn next(counter: &mut u64) -> Result<u64, ReadError> {
    if *counter >= 9_007_199_254_740_991 {
        return Err(invalid("Namespace logical counter exhausted"));
    }
    *counter += 1;
    Ok(*counter)
}

/// Migration candidate only; the Workspace migrator installs it after backup.
pub fn migrate(document: &PersistedDocument, replica_id: &str) -> Result<Vec<u8>, ReadError> {
    id(replica_id)?;
    if document.schema_version != 3 {
        return Err(invalid("Only Workspace v3 can be normalized"));
    }
    let before = crate::namespace::read_namespace(document)?;
    let doc = decode_document(document)?;
    let mut counter = 0;
    {
        let mut txn = doc.transact_mut();
        let root = txn
            .get_map("workspace")
            .ok_or_else(|| invalid("Workspace is missing"))?;
        let ns = nested(&txn, &root, "main_namespace")?;
        let entries = nested(&txn, &ns, "entries")?;
        let notes = nested(&txn, &root, "notes")?;
        root.insert(&mut txn, "schema_version", SCHEMA_VERSION);
        let placements = ns.insert(&mut txn, "placements", MapPrelim::default());
        let deletions = ns.insert(&mut txn, "deletions", MapPrelim::default());
        ns.insert(&mut txn, "restorations", MapPrelim::default());
        let mut trash: BTreeMap<String, Deletion> = BTreeMap::new();
        for (key, entry) in &before.entries {
            let value = nested(&txn, &entries, key)?;
            for field in PLACEMENT_FIELDS {
                value.remove(&mut txn, field);
            }
            let operation_id = uuid::Uuid::now_v7().to_string();
            let edge = Placement {
                counter: next(&mut counter)?,
                operation_id: operation_id.clone(),
                replica_id: replica_id.into(),
                entity_id: key.clone(),
                parent_id: entry
                    .parent_entry_id
                    .clone()
                    .unwrap_or_else(|| before.namespace_id.clone()),
                region: "entries".into(),
                position: entry.position.clone(),
            };
            placements.insert(
                &mut txn,
                operation_id.as_str(),
                any(&serde_json::to_value(edge)?)?,
            );
            if let Some(operation_id) = &entry.trash_operation_id {
                trash
                    .entry(operation_id.clone())
                    .or_insert_with(|| Deletion {
                        operation_id: operation_id.clone(),
                        replica_id: replica_id.into(),
                        counter: 0,
                        entity_ids: vec![],
                        at: entry.deleted_at.clone().unwrap(),
                    })
                    .entity_ids
                    .push(key.clone());
            }
        }
        for (key, mut deletion) in trash {
            deletion.counter = next(&mut counter)?;
            deletions.insert(
                &mut txn,
                key.as_str(),
                any(&serde_json::to_value(deletion)?)?,
            );
        }
        for key in before.notes.keys() {
            let value = nested(&txn, &notes, key)?;
            value.remove(&mut txn, "deleted_at");
            value.remove(&mut txn, "trash_operation_id");
        }
    }
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let after = crate::namespace::read_namespace(&PersistedDocument {
        schema_version: SCHEMA_VERSION,
        snapshot: bytes.clone(),
        updates: vec![],
        snapshot_revision: document.revision,
        ..document.clone()
    })?;
    if serde_json::to_value(&before.entries)? != serde_json::to_value(&after.entries)?
        || before.notes != after.notes
    {
        return Err(invalid("Workspace conversion changed content or identity"));
    }
    Ok(bytes)
}

/// Scratch projection for the existing CLI planner. Its updates are never saved.
pub fn legacy_projection(document: &PersistedDocument) -> Result<yrs::Doc, ReadError> {
    let projected = crate::namespace::read_namespace(document)?;
    let doc = decode_document(document)?;
    {
        let mut txn = doc.transact_mut();
        let root = txn
            .get_map("workspace")
            .ok_or_else(|| invalid("Missing Workspace"))?;
        root.insert(&mut txn, "schema_version", 3_i64);
        let ns = nested(&txn, &root, "main_namespace")?;
        let entries = nested(&txn, &ns, "entries")?;
        let notes = nested(&txn, &root, "notes")?;
        for (key, entry) in &projected.entries {
            let map = nested(&txn, &entries, key)?;
            let json = serde_json::to_value(entry)?;
            for field in PLACEMENT_FIELDS {
                put(&mut txn, &map, field, &json[field])?;
            }
        }
        for (key, value) in &projected.notes {
            let map = nested(&txn, &notes, key)?;
            for field in ["deleted_at", "trash_operation_id"] {
                put(&mut txn, &map, field, &value[field])?;
            }
        }
    }
    Ok(doc)
}

/// Reconcile a validated CLI view into the original stable Entry maps.
pub fn reconcile(
    document: &PersistedDocument,
    desired: &Namespace,
    replica_id: &str,
) -> Result<Vec<u8>, ReadError> {
    id(replica_id)?;
    desired.validate()?;
    let mut model = interpret(&workspace_json(document)?)?;
    if desired.namespace_id != model.namespace.namespace_id
        || model
            .namespace
            .entries
            .keys()
            .any(|key| !desired.entries.contains_key(key))
        || model
            .namespace
            .notes
            .keys()
            .any(|key| !desired.notes.contains_key(key))
    {
        return Err(invalid("Namespace identity cannot be replaced or removed"));
    }
    let mut moves = BTreeMap::new();
    for (key, entry) in &desired.entries {
        id(key)?;
        if let Some(old) = model.namespace.entries.get(key) {
            if entry.target != old.target || entry.created_at != old.created_at {
                return Err(invalid("Namespace identity is immutable"));
            }
            if entry.deleted_at != old.deleted_at
                || entry.trash_operation_id != old.trash_operation_id
            {
                return Err(invalid("Trash edits require observed deletion operations"));
            }
        } else if entry.deleted_at.is_some() {
            return Err(invalid("New CLI Entries must be live"));
        }
        if model.namespace.entries.get(key).is_none_or(|old| {
            old.parent_entry_id != entry.parent_entry_id || old.position != entry.position
        }) {
            moves.insert(
                key.clone(),
                (
                    entry
                        .parent_entry_id
                        .clone()
                        .unwrap_or_else(|| desired.namespace_id.clone()),
                    entry.position.clone(),
                ),
            );
        }
    }
    let latest: BTreeMap<String, Placement> =
        model
            .placements
            .values()
            .fold(BTreeMap::new(), |mut latest, edge| {
                if latest.get(&edge.entity_id).is_none_or(|old| old < edge) {
                    latest.insert(edge.entity_id.clone(), edge.clone());
                }
                latest
            });
    for (parent, _) in moves.values().cloned().collect::<Vec<_>>() {
        let mut cursor = parent;
        let mut seen = BTreeSet::new();
        while seen.insert(cursor.clone()) {
            let Some(edge) = model.parents.get(&cursor) else {
                break;
            };
            if latest.get(&cursor) != Some(edge) {
                moves
                    .entry(cursor.clone())
                    .or_insert_with(|| (edge.parent_id.clone(), edge.position.clone()));
            }
            cursor = moves
                .get(&cursor)
                .map_or_else(|| edge.parent_id.clone(), |edge| edge.0.clone());
        }
    }
    let mut new_edges = vec![];
    for (key, (parent, position)) in &moves {
        let operation_id = uuid::Uuid::now_v7().to_string();
        let edge = Placement {
            operation_id: operation_id.clone(),
            replica_id: replica_id.into(),
            counter: next(&mut model.counter)?,
            entity_id: key.clone(),
            parent_id: parent.clone(),
            region: "entries".into(),
            position: position.clone(),
        };
        model.placements.insert(operation_id, edge.clone());
        new_edges.push(edge);
    }
    let mut ids = desired.entries.keys().cloned().collect::<BTreeSet<_>>();
    ids.insert(desired.namespace_id.clone());
    let projected = derive_tree(&desired.namespace_id, &ids, &model.placements)?;
    for (key, (parent, position)) in &moves {
        if projected[key].parent_id != *parent || projected[key].position != *position {
            return Err(invalid("Namespace move would create a cycle"));
        }
    }
    let doc = decode_document(document)?;
    let vector = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let root = txn
            .get_map("workspace")
            .ok_or_else(|| invalid("Workspace is missing"))?;
        let ns = nested(&txn, &root, "main_namespace")?;
        let entries = nested(&txn, &ns, "entries")?;
        let notes = nested(&txn, &root, "notes")?;
        let placements = nested(&txn, &ns, "placements")?;
        for (key, entry) in &desired.entries {
            let value = match entries.get(&txn, key) {
                Some(Out::YMap(value)) => value,
                None => entries.insert(&mut txn, key.as_str(), MapPrelim::default()),
                _ => return Err(invalid("Invalid Entry map")),
            };
            for (field, item) in serde_json::to_value(entry)?.as_object().unwrap() {
                if field == "entry_id"
                    || PLACEMENT_FIELDS.contains(&field.as_str())
                    || (field == "name" && entry.target.is_some())
                {
                    continue;
                }
                put(&mut txn, &value, field, item)?;
            }
        }
        for (key, note) in &desired.notes {
            let value = match notes.get(&txn, key) {
                Some(Out::YMap(value)) => value,
                None => notes.insert(&mut txn, key.as_str(), MapPrelim::default()),
                _ => return Err(invalid("Invalid Note metadata map")),
            };
            for (field, item) in object(note)? {
                if field != "deleted_at" && field != "trash_operation_id" {
                    put(&mut txn, &value, field, item)?;
                }
            }
        }
        for edge in new_edges {
            placements.insert(
                &mut txn,
                edge.operation_id.as_str(),
                any(&serde_json::to_value(&edge)?)?,
            );
        }
    }
    let snapshot = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let after = crate::namespace::read_namespace(&PersistedDocument {
        snapshot,
        updates: vec![],
        snapshot_revision: document.revision,
        ..document.clone()
    })?;
    if serde_json::to_value(&desired.entries)? != serde_json::to_value(&after.entries)?
        || desired.notes != after.notes
    {
        return Err(invalid(
            "CLI reconciliation changed requested Namespace projection",
        ));
    }
    Ok(doc.transact().encode_state_as_update_v1(&vector))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::SharedRef;
    use yrs::updates::decoder::Decode;
    fn fixtures() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/replicated-namespace-contract.json"
        ))
        .unwrap()
    }
    fn document(fixture: &Value) -> PersistedDocument {
        PersistedDocument {
            kind: "workspace".into(),
            document_id: fixture["workspaceId"].as_str().unwrap().into(),
            schema_version: SCHEMA_VERSION,
            revision: 1,
            snapshot_revision: 1,
            snapshot: serde_json::from_value(fixture["snapshot"].clone()).unwrap(),
            updates: vec![],
        }
    }
    #[test]
    fn matches_yjs_namespace_projection_and_preserves_legacy_migration() {
        for fixture in fixtures() {
            let document = document(&fixture);
            let namespace = crate::namespace::read_namespace(&document).unwrap();
            assert_eq!(
                serde_json::to_value(&namespace.entries).unwrap(),
                fixture["projection"]["entries"],
                "{}",
                fixture["name"]
            );
            assert_eq!(
                serde_json::to_value(&namespace.notes).unwrap(),
                fixture["projection"]["notes"],
                "{}",
                fixture["name"]
            );
            if fixture["legacySnapshot"].is_array() {
                let original = PersistedDocument {
                    schema_version: 3,
                    snapshot: serde_json::from_value(fixture["legacySnapshot"].clone()).unwrap(),
                    ..document.clone()
                };
                let bytes = original.snapshot.clone();
                let converted = migrate(&original, &uuid::Uuid::now_v7().to_string()).unwrap();
                assert_eq!(original.snapshot, bytes);
                let projected = crate::namespace::read_namespace(&PersistedDocument {
                    snapshot: converted,
                    ..document
                })
                .unwrap();
                assert_eq!(
                    serde_json::to_value(&projected.entries).unwrap(),
                    fixture["projection"]["entries"]
                );
            }
        }
    }
    #[test]
    fn native_moves_after_cycle_correction_preserve_stable_entry_identity() {
        let fixture = &fixtures()[1];
        let document = document(fixture);
        let before = decode_document(&document).unwrap();
        let (old_entry_ids, key, parent) = {
            let txn = before.transact();
            let root = txn.get_map("workspace").unwrap();
            let ns = nested(&txn, &root, "main_namespace").unwrap();
            let entries = nested(&txn, &ns, "entries").unwrap();
            let old_ids = entries
                .iter(&txn)
                .map(|(key, _)| (key.to_owned(), nested(&txn, &entries, key).unwrap().hook()))
                .collect::<BTreeMap<_, _>>();
            let view = interpret(&workspace_json(&document).unwrap()).unwrap();
            let mut latest = BTreeMap::new();
            for edge in view.placements.values() {
                if latest
                    .get(&edge.entity_id)
                    .is_none_or(|previous| *previous < edge)
                {
                    latest.insert(edge.entity_id.clone(), edge);
                }
            }
            let corrected = view
                .parents
                .iter()
                .find(|(key, edge)| latest.get(*key).is_some_and(|latest| *latest != *edge))
                .unwrap()
                .0
                .clone();
            let movable = view
                .namespace
                .entries
                .values()
                .find(|entry| entry.name.as_deref() == Some("Parent"))
                .unwrap()
                .entry_id
                .clone();
            (old_ids, movable, corrected)
        };
        let mut desired = crate::namespace::read_namespace(&document).unwrap();
        let entry = desired.entries.get_mut(&key).unwrap();
        entry.parent_entry_id = Some(parent);
        entry.position = "a0".into();
        entry.name = Some("Native renamed".into());
        let update = reconcile(&document, &desired, &uuid::Uuid::now_v7().to_string()).unwrap();
        before
            .transact_mut()
            .apply_update(yrs::Update::decode_v1(&update).unwrap())
            .unwrap();
        let snapshot = before
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let after = crate::namespace::read_namespace(&PersistedDocument {
            snapshot,
            ..document.clone()
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&after.entries).unwrap(),
            serde_json::to_value(&desired.entries).unwrap()
        );
        let txn = before.transact();
        let root = txn.get_map("workspace").unwrap();
        let ns = nested(&txn, &root, "main_namespace").unwrap();
        let entries = nested(&txn, &ns, "entries").unwrap();
        for (key, hook) in old_entry_ids {
            assert_eq!(nested(&txn, &entries, &key).unwrap().hook(), hook);
        }
        if let Ok(path) = std::env::var("MEMOKA_NAMESPACE_NATIVE_FIXTURE") {
            std::fs::write(path, serde_json::to_vec(&json!({ "source": fixture, "update": update, "entryId": key, "expectedEntries": desired.entries })).unwrap()).unwrap();
        }
    }
}
