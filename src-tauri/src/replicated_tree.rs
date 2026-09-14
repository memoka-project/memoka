//! Shared acyclic parent-history projection for Note and Workspace.
use crate::attachment::validate_uuid_v7;
use crate::document_model::ReadError;
use crate::namespace::valid_position;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

fn invalid(message: &str) -> ReadError {
    ReadError::new("INVALID_DATA", message)
}
fn checked_id(id: &str) -> Result<(), ReadError> {
    validate_uuid_v7(id, "replicated identity").map_err(|_| invalid("Invalid replicated identity"))
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Placement {
    // This field order is the cross-language operation priority.
    pub(crate) counter: u64,
    pub(crate) replica_id: String,
    pub(crate) operation_id: String,
    pub(crate) entity_id: String,
    pub(crate) parent_id: String,
    pub(crate) region: String,
    pub(crate) position: String,
}

pub(crate) fn derive_tree(
    root: &str,
    entities: &BTreeSet<String>,
    placements: &BTreeMap<String, Placement>,
) -> Result<BTreeMap<String, Placement>, ReadError> {
    let mut latest: BTreeMap<String, Placement> = BTreeMap::new();
    let mut alternatives: BTreeMap<String, Vec<Placement>> = BTreeMap::new();
    for (id, edge) in placements {
        checked_id(id)?;
        checked_id(&edge.replica_id)?;
        checked_id(&edge.entity_id)?;
        checked_id(&edge.parent_id)?;
        if &edge.operation_id != id
            || edge.counter == 0
            || edge.counter > 9_007_199_254_740_991
            || !valid_position(&edge.position)
            || edge.region.is_empty()
            || edge.region.len() > 80
            || edge.entity_id == edge.parent_id
            || edge.entity_id == root
            || !entities.contains(&edge.entity_id)
            || !entities.contains(&edge.parent_id)
        {
            return Err(invalid("Invalid replicated placement"));
        }
        if latest
            .get(&edge.entity_id)
            .is_none_or(|previous| previous < edge)
        {
            latest.insert(edge.entity_id.clone(), edge.clone());
        }
        alternatives
            .entry(edge.parent_id.clone())
            .or_default()
            .push(edge.clone());
    }
    if entities
        .iter()
        .any(|id| id != root && !latest.contains_key(id))
    {
        return Err(invalid("Node has no placement"));
    }
    let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (id, edge) in &latest {
        reverse
            .entry(edge.parent_id.clone())
            .or_default()
            .insert(id.clone());
    }
    let mut rooted = BTreeSet::new();
    let mut queue = BinaryHeap::new();
    attach(root, &reverse, &alternatives, &mut rooted, &mut queue);
    while let Some(edge) = queue.pop() {
        if rooted.contains(&edge.entity_id) {
            continue;
        }
        let old = latest.insert(edge.entity_id.clone(), edge.clone()).unwrap();
        reverse
            .get_mut(&old.parent_id)
            .unwrap()
            .remove(&edge.entity_id);
        reverse
            .entry(edge.parent_id.clone())
            .or_default()
            .insert(edge.entity_id.clone());
        attach(
            &edge.entity_id,
            &reverse,
            &alternatives,
            &mut rooted,
            &mut queue,
        );
    }
    if rooted.len() != entities.len() {
        return Err(invalid("Replicated tree has no rooted parent history"));
    }
    Ok(latest)
}

fn attach(
    first: &str,
    reverse: &BTreeMap<String, BTreeSet<String>>,
    alternatives: &BTreeMap<String, Vec<Placement>>,
    rooted: &mut BTreeSet<String>,
    queue: &mut BinaryHeap<Placement>,
) {
    let mut pending = vec![first.to_owned()];
    while let Some(id) = pending.pop() {
        if !rooted.insert(id.clone()) {
            continue;
        }
        queue.extend(alternatives.get(&id).into_iter().flatten().cloned());
        pending.extend(reverse.get(&id).into_iter().flatten().cloned());
    }
}
