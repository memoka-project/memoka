use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use yrs::{Any, Map, MapPrelim, Out, ReadTxn, StateVector, Transact};

use crate::attachment::validate_uuid_v7;
use crate::document_model::{ReadError, decode_document, workspace_json};
use crate::persistence::PersistedDocument;

pub const WORKSPACE_SCHEMA: i64 = 3;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ResourceRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    #[serde(default)]
    pub entry_id: String,
    pub parent_entry_id: Option<String>,
    pub position: String,
    pub target: Option<ResourceRef>,
    pub name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub trash_operation_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Namespace {
    pub namespace_id: String,
    pub entries: BTreeMap<String, Entry>,
    pub notes: BTreeMap<String, Value>,
}

pub fn read_namespace(document: &PersistedDocument) -> Result<Namespace, ReadError> {
    let value = workspace_json(document)?;
    if document.schema_version == crate::replicated_namespace::SCHEMA_VERSION {
        return crate::replicated_namespace::project(&value);
    }
    if document.schema_version != WORKSPACE_SCHEMA
        || value["schema_version"].as_i64() != Some(WORKSPACE_SCHEMA)
    {
        return Err(ReadError::new(
            "MIGRATION_REQUIRED",
            "Open this Workspace in Memoka to migrate it first",
        ));
    }
    let id = value["main_namespace"]["namespace_id"]
        .as_str()
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Namespace ID is missing"))?;
    validate_uuid_v7(id, "namespaceId")?;
    let raw_entries = value["main_namespace"]["entries"]
        .as_object()
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Namespace entries are missing"))?;
    if raw_entries.len() > 1_000_000 {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Namespace traversal limit exceeded",
        ));
    }
    let mut entries = BTreeMap::new();
    for (entry_id, value) in raw_entries {
        validate_uuid_v7(entry_id, "entryId")?;
        let mut entry: Entry = serde_json::from_value(value.clone())?;
        entry.entry_id = entry_id.clone();
        entries.insert(entry_id.clone(), entry);
    }
    let notes: BTreeMap<String, Value> = serde_json::from_value(value["notes"].clone())?;
    let namespace = Namespace {
        namespace_id: id.to_owned(),
        entries,
        notes,
    };
    namespace.validate()?;
    Ok(namespace)
}

impl Namespace {
    pub fn validate(&self) -> Result<(), ReadError> {
        let invalid = |message: &str| ReadError::new("INVALID_NAMESPACE", message);
        let mut placements = BTreeSet::new();
        for (id, note) in &self.notes {
            validate_uuid_v7(id, "noteId")?;
            if note.get("parent_note_id").is_some() || note.get("note_position").is_some() {
                return Err(invalid("Note placement must live in Namespace"));
            }
            if !note["title_cache"].is_string() {
                return Err(invalid("Note title cache is invalid"));
            }
        }
        for (id, entry) in &self.entries {
            if self.notes.contains_key(id) {
                return Err(invalid("Namespace Entry ID must not reuse a Note ID"));
            }
            if entry.deleted_at.is_some() != entry.trash_operation_id.is_some() {
                return Err(invalid("Namespace Trash metadata must be paired"));
            }
            if let Some(id) = &entry.trash_operation_id {
                validate_uuid_v7(id, "trashOperationId")?;
            }
            if !valid_position(&entry.position) {
                return Err(invalid("Invalid Namespace position"));
            }
            if let Some(parent_id) = &entry.parent_entry_id {
                let parent = self
                    .entries
                    .get(parent_id)
                    .ok_or_else(|| invalid("Namespace parent is missing"))?;
                if parent_id == id || (entry.deleted_at.is_none() && parent.deleted_at.is_some()) {
                    return Err(invalid("Invalid Namespace parent"));
                }
            }
            if let Some(target) = &entry.target {
                if target.kind != "note"
                    || target.id == *id
                    || !placements.insert(target.id.clone())
                {
                    return Err(invalid("Invalid or repeated resource placement"));
                }
                let note = self
                    .notes
                    .get(&target.id)
                    .ok_or_else(|| invalid("Namespace target Note is missing"))?;
                if entry.name.is_some()
                    || note["deleted_at"].as_str() != entry.deleted_at.as_deref()
                    || note["trash_operation_id"].as_str() != entry.trash_operation_id.as_deref()
                {
                    return Err(invalid("Namespace and Note metadata disagree"));
                }
            } else if entry
                .name
                .as_ref()
                .is_none_or(|name| name.contains(['\r', '\n']))
            {
                return Err(invalid("Group name must be a single line"));
            }
        }
        if placements.len() != self.notes.len() {
            return Err(invalid("Every Note must have exactly one Namespace entry"));
        }
        let mut completed = BTreeSet::new();
        for id in self.entries.keys() {
            let mut path = BTreeSet::new();
            let mut cursor = Some(id.as_str());
            while let Some(id) = cursor {
                if completed.contains(id) {
                    break;
                }
                if !path.insert(id.to_owned()) {
                    return Err(invalid("Namespace contains a cycle"));
                }
                cursor = self.entries[id].parent_entry_id.as_deref();
            }
            completed.extend(path);
        }
        Ok(())
    }

    pub fn ordered(&self, include_trash: bool) -> Vec<(&Entry, usize)> {
        let mut children: BTreeMap<Option<&str>, Vec<&Entry>> = BTreeMap::new();
        for entry in self
            .entries
            .values()
            .filter(|entry| include_trash || entry.deleted_at.is_none())
        {
            children
                .entry(entry.parent_entry_id.as_deref())
                .or_default()
                .push(entry);
        }
        for siblings in children.values_mut() {
            siblings.sort_by(|a, b| (&a.position, &a.entry_id).cmp(&(&b.position, &b.entry_id)));
        }
        let mut pending = children
            .get(&None)
            .into_iter()
            .flatten()
            .rev()
            .map(|entry| (*entry, 0))
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        while let Some((entry, depth)) = pending.pop() {
            result.push((entry, depth));
            for child in children
                .get(&Some(entry.entry_id.as_str()))
                .into_iter()
                .flatten()
                .rev()
            {
                pending.push((*child, depth + 1));
            }
        }
        result
    }

    pub fn name(&self, entry: &Entry) -> String {
        match &entry.target {
            Some(target) => self.notes[&target.id]["title_cache"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("新しいノート")
                .to_owned(),
            None => entry
                .name
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("無題のグループ")
                .to_owned(),
        }
    }

    pub fn path(&self, entry_id: &str) -> Vec<String> {
        let mut result = Vec::new();
        let mut cursor = self.entries.get(entry_id);
        while let Some(entry) = cursor {
            result.push(self.name(entry));
            cursor = entry
                .parent_entry_id
                .as_ref()
                .and_then(|id| self.entries.get(id));
        }
        result.reverse();
        result
    }

    pub fn note_entry(&self, note_id: &str) -> Option<&Entry> {
        self.entries.values().find(|entry| {
            entry
                .target
                .as_ref()
                .is_some_and(|target| target.id == note_id)
        })
    }
}

/// Canonical fractional index grammar shared with jittered-fractional-indexing.
pub fn valid_position(position: &str) -> bool {
    let bytes = position.as_bytes();
    let Some(head) = bytes.first().copied() else {
        return false;
    };
    let integer_length = match head {
        b'a'..=b'z' => usize::from(head - b'a') + 2,
        b'A'..=b'Z' => usize::from(b'Z' - head) + 2,
        _ => return false,
    };
    if bytes.len() < integer_length || !bytes[1..].iter().all(u8::is_ascii_alphanumeric) {
        return false;
    }
    if bytes.len() > integer_length && bytes.last() == Some(&b'0') {
        return false;
    }
    !(head == b'A' && bytes[1..integer_length].iter().all(|b| *b == b'0'))
}

/// Deterministic, domain-separated UUIDv7 identities make retry independent of
/// the process RNG. Sorted assignment preserves all old ID tie-break orders.
pub(crate) fn migration_id(workspace_id: &str, key: &str) -> String {
    let hash = Sha256::digest(format!("memoka:namespace:v3:{workspace_id}:{key}"));
    let mut hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .into_bytes();
    let timestamp = workspace_id.replace('-', "");
    hex[..12].copy_from_slice(&timestamp.as_bytes()[..12]);
    hex[12] = b'7';
    hex[16] = b'8';
    let hex = std::str::from_utf8(&hex[..32]).unwrap();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub fn migrate_workspace(
    document: &PersistedDocument,
) -> Result<(Vec<u8>, BTreeMap<String, String>), ReadError> {
    let value = workspace_json(document)?;
    if document.schema_version != 2 || value["schema_version"].as_i64() != Some(2) {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Unsupported Workspace migration",
        ));
    }
    let notes = value["notes"]
        .as_object()
        .ok_or_else(|| ReadError::new("INVALID_DATA", "Legacy Notes are missing"))?;
    let mut note_ids = notes.keys().cloned().collect::<Vec<_>>();
    note_ids.sort();
    let mut entry_ids = note_ids
        .iter()
        .map(|id| migration_id(&document.document_id, id))
        .collect::<Vec<_>>();
    entry_ids.sort();
    let mapping = note_ids
        .into_iter()
        .zip(entry_ids)
        .collect::<BTreeMap<_, _>>();
    let doc = decode_document(document)?;
    let root = doc.get_or_insert_map("workspace");
    let mut txn = doc.transact_mut();
    let Some(Out::YMap(note_map)) = root.get(&txn, "notes") else {
        return Err(ReadError::new("INVALID_DATA", "Legacy Note map is invalid"));
    };
    let namespace = root.insert(&mut txn, "main_namespace", MapPrelim::default());
    namespace.insert(
        &mut txn,
        "namespace_id",
        migration_id(&document.document_id, "main-namespace"),
    );
    let entries = namespace.insert(&mut txn, "entries", MapPrelim::default());
    for (note_id, old) in notes {
        validate_uuid_v7(note_id, "noteId")?;
        let entry = entries.insert(&mut txn, mapping[note_id].as_str(), MapPrelim::default());
        let parent = old["parent_note_id"]
            .as_str()
            .map(|id| {
                mapping
                    .get(id)
                    .cloned()
                    .ok_or_else(|| ReadError::new("INVALID_NAMESPACE", "Legacy parent is missing"))
            })
            .transpose()?;
        let parent = parent.map_or(Any::Null, |id| Any::String(id.into()));
        entry.insert(&mut txn, "parent_entry_id", parent);
        let position = old["note_position"].as_str().ok_or_else(|| {
            ReadError::new("INVALID_NAMESPACE", "Legacy Note position is missing")
        })?;
        entry.insert(&mut txn, "position", position);
        entry.insert(
            &mut txn,
            "target",
            Any::from_json(&json!({"kind":"note", "id":note_id}).to_string())
                .map_err(|_| ReadError::new("INVALID_DATA", "Cannot encode resource reference"))?,
        );
        for key in [
            "created_at",
            "updated_at",
            "deleted_at",
            "trash_operation_id",
        ] {
            entry.insert(
                &mut txn,
                key,
                Any::from_json(&old[key].to_string())
                    .map_err(|_| ReadError::new("INVALID_DATA", "Invalid legacy metadata"))?,
            );
        }
        let Some(Out::YMap(note)) = note_map.get(&txn, note_id) else {
            return Err(ReadError::new(
                "INVALID_DATA",
                "Legacy Note metadata is not a map",
            ));
        };
        note.remove(&mut txn, "parent_note_id");
        note.remove(&mut txn, "note_position");
    }
    root.insert(&mut txn, "schema_version", WORKSPACE_SCHEMA);
    let bytes = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let migrated = PersistedDocument {
        schema_version: WORKSPACE_SCHEMA,
        snapshot: bytes.clone(),
        snapshot_revision: document.revision,
        updates: Vec::new(),
        ..document.clone()
    };
    read_namespace(&migrated)?;
    Ok((bytes, mapping))
}
