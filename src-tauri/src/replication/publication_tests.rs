use super::*;
use crate::replication::publication::{self, PreparedPublication};

#[test]
fn workspace_only_trash_publication_identifies_notes_whose_composition_must_finish() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    let source = a
        .store
        .load_document("workspace", &a.config.workspace_id)
        .unwrap();
    let namespace = crate::namespace::read_namespace(&source).unwrap();
    let entry = namespace
        .entries
        .values()
        .find(|e| {
            e.target
                .as_ref()
                .is_some_and(|t| t.id == a.note().document_id)
        })
        .unwrap();
    let affected = entry.target.as_ref().unwrap().id.clone();
    let doc = decode_document(&source).unwrap();
    let update = {
        let mut txn = doc.transact_mut();
        let workspace = txn.get_map("workspace").unwrap();
        let Out::YMap(ns) = workspace.get(&txn, "main_namespace").unwrap() else {
            panic!()
        };
        let Out::YMap(deletions) = ns.get(&txn, "deletions").unwrap() else {
            panic!()
        };
        let operation = id();
        let deletion = serde_json::json!({"operationId":operation,"replicaId":a.config.origin.replica_id,"counter":9999,"entityIds":[entry.entry_id],"at":AT});
        deletions.insert(
            &mut txn,
            operation,
            yrs::Any::from_json(&deletion.to_string()).unwrap(),
        );
        txn.encode_update_v1()
    };
    a.store
        .commit(&PersistenceCommitRequest {
            operation_id: id(),
            scope: "workspace-structure".into(),
            documents: vec![DocumentCommitInput {
                kind: "workspace".into(),
                document_id: source.document_id,
                schema_version: 4,
                base_revision: source.revision,
                snapshot: None,
                update: Some(update),
            }],
            local_states: vec![],
            search_index_metadata_only_note_id: None,
            fault: None,
        })
        .unwrap();
    b.receive(&a.outgoing());
    let prepared = PreparedPublication::prepare(b.root.path(), &b.config)
        .unwrap()
        .unwrap();
    assert!(prepared.documents().iter().all(|d| d.kind == "workspace"));
    assert!(prepared.affected_note_ids().contains(&affected));
    let before = b.note();
    let delivery = prepared.commit(&mut b.store, &b.config).unwrap();
    assert!(delivery.affected_note_ids.contains(&affected));
    assert_eq!(b.note(), before);
}

#[test]
fn readonly_preparation_does_not_change_documents_or_hold_the_owner_writer() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    a.store.commit(&a.edit(" remote", false)).unwrap();
    b.receive(&a.outgoing());
    let before = b.note();
    let prepared = PreparedPublication::prepare(b.root.path(), &b.config)
        .unwrap()
        .unwrap();
    assert_eq!(b.note(), before);
    assert_eq!(prepared.documents().len(), 1);
    // Input continued while the read-only candidate was being prepared.
    b.store.commit(&b.edit(" local", false)).unwrap();
    assert!(prepared.commit(&mut b.store, &b.config).is_err());
    assert!(!b.projection().to_string().contains(" remote"));
    let prepared = PreparedPublication::prepare(b.root.path(), &b.config)
        .unwrap()
        .unwrap();
    let delivery = prepared.commit(&mut b.store, &b.config).unwrap();
    assert!(b.projection().to_string().contains(" remote"));
    assert!(b.projection().to_string().contains(" local"));
    assert_eq!(delivery.documents[0].revision, b.note().revision);
    let receipt = prepared.commit(&mut b.store, &b.config).unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        serde_json::to_value(delivery).unwrap()
    );
    assert!(
        PreparedPublication::prepare(b.root.path(), &b.config)
            .unwrap()
            .is_none()
    );
}

#[test]
fn readonly_export_preserves_checkpoints_merged_after_its_snapshot_and_later_local_input() {
    let mut peers = peers();
    let mut c = peers.pop().unwrap();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    a.store.commit(&a.edit(" A", false)).unwrap();
    b.receive(&a.outgoing());
    b.apply();
    let export = PreparedCheckpointExport::prepare(b.root.path(), &b.config, &b.key).unwrap();
    c.store.commit(&c.edit(" C", false)).unwrap();
    let key = c.key.clone();
    let from_c = c.engine().create_checkpoint(&key, true).unwrap();
    let prepared = b.engine().prepare_checkpoint(&from_c).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    b.store.commit(&b.edit(" B after snapshot", false)).unwrap();
    export.commit(&mut b.store, true).unwrap();
    assert!(b.projection().to_string().contains("B after snapshot"));
    let has_c = b
        .engine()
        .checkpoint_for(&a.engine().status().unwrap().frontier.received)
        .unwrap()
        .unwrap();
    let from_c_id: Checkpoint = decode(&from_c.content, MAX_CHECKPOINT_BYTES).unwrap();
    let retained: Checkpoint = decode(&has_c.content, MAX_CHECKPOINT_BYTES).unwrap();
    assert_eq!(retained.checkpoint_id, from_c_id.checkpoint_id);
    assert!(!b.outgoing().is_empty());
}

#[test]
fn accepted_edits_from_a_revoked_author_reach_a_third_device_in_an_active_peers_checkpoint() {
    let mut peers = peers();
    let mut c = peers.pop().unwrap();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    a.store
        .commit(&a.edit(" accepted before revocation", false))
        .unwrap();
    let batches = a.outgoing();
    b.receive(&batches);
    b.apply();
    let key = a.key.clone();
    let old_checkpoint = a.engine().create_checkpoint(&key, false).unwrap();
    let prepared = b.engine().prepare_checkpoint(&old_checkpoint).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    for peer in [&mut b, &mut c] {
        peer.store
            .connection
            .execute(
                "UPDATE sync_members SET revoked=1 WHERE replica_id=?1",
                [&a.config.origin.replica_id],
            )
            .unwrap();
    }
    assert!(b.outgoing().is_empty());
    assert!(b.engine().initial_checkpoint().unwrap().is_none());
    assert!(b.engine().checkpoint_for(&Frontier::new()).is_err());
    assert_eq!(
        c.engine().receive(&batches[0]).unwrap_err().code,
        "SYNC_REVOKED"
    );
    PreparedCheckpointExport::prepare(b.root.path(), &b.config, &b.key)
        .unwrap()
        .commit(&mut b.store, true)
        .unwrap();
    let checkpoint = b
        .engine()
        .checkpoint_for(&Frontier::new())
        .unwrap()
        .unwrap();
    assert!(b.engine().initial_checkpoint().unwrap().is_some());
    c.engine().receive_checkpoint(&checkpoint).unwrap();
    let prepared = c.engine().prepare_next_checkpoint().unwrap().unwrap();
    c.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(b.projection(), c.projection());
    assert!(
        c.projection()
            .to_string()
            .contains("accepted before revocation")
    );
}

#[test]
fn idle_acknowledgements_do_not_change_the_last_applied_time() {
    let mut peers = peers();
    let b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    a.store.commit(&a.edit(" change", false)).unwrap();
    let frontier = a.engine().status().unwrap().frontier;
    a.engine()
        .acknowledge(&b.config.origin.device_id, &frontier)
        .unwrap();
    a.store
        .connection
        .execute("UPDATE sync_peer_frontiers SET last_applied_at=?1", [AT])
        .unwrap();
    a.engine()
        .acknowledge(&b.config.origin.device_id, &frontier)
        .unwrap();
    let applied: String = a
        .store
        .connection
        .query_row("SELECT last_applied_at FROM sync_peer_frontiers", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(applied, AT);
}

#[test]
fn readonly_bad_checkpoint_is_quarantined_only_through_the_owner() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    let key = a.key.clone();
    let signed = a.engine().create_checkpoint(&key, false).unwrap();
    let mut checkpoint: Checkpoint = decode(&signed.content, MAX_CHECKPOINT_BYTES).unwrap();
    checkpoint
        .documents
        .iter_mut()
        .find(|doc| doc.kind == "note")
        .unwrap()
        .update = vec![255, 255];
    let signed = SignedContent::sign(serde_json::to_vec(&checkpoint).unwrap(), "checkpoint", &key);
    b.engine().receive_checkpoint(&signed).unwrap();
    let before = b.note();
    let failure = PreparedPublication::prepare(b.root.path(), &b.config)
        .err()
        .unwrap();
    assert_eq!(b.engine().status().unwrap().quarantined_count, 0);
    assert_eq!(b.note(), before);
    publication::quarantine(&mut b.store, &b.config, &failure).unwrap();
    assert_eq!(b.engine().status().unwrap().quarantined_count, 1);
    assert!(
        PreparedPublication::prepare(b.root.path(), &b.config)
            .unwrap()
            .is_none()
    );
}

#[test]
fn prepared_publication_rechecks_pause_and_workspace_copy_identity() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    a.store.commit(&a.edit(" remote", false)).unwrap();
    b.receive(&a.outgoing());
    let prepared = PreparedPublication::prepare(b.root.path(), &b.config)
        .unwrap()
        .unwrap();
    let before = b.note();
    b.engine().set_paused(true).unwrap();
    assert_eq!(
        prepared.commit(&mut b.store, &b.config).unwrap_err().code,
        "SYNC_PAUSED"
    );
    b.engine().set_paused(false).unwrap();
    let mut other = b.config.clone();
    other.origin.replica_id = id();
    assert_eq!(
        prepared.commit(&mut b.store, &other).unwrap_err().code,
        "SYNC_GROUP"
    );
    assert_eq!(b.note(), before);
    prepared.commit(&mut b.store, &b.config).unwrap();
}

#[test]
fn checkpoint_publication_and_covered_batch_retry_have_idempotent_deliveries() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    a.store.commit(&a.edit(" remote", false)).unwrap();
    b.receive(&a.outgoing());
    let batch = PreparedPublication::prepare(b.root.path(), &b.config)
        .unwrap()
        .unwrap();
    let key = a.key.clone();
    let signed = a.engine().create_checkpoint(&key, false).unwrap();
    b.engine().receive_checkpoint(&signed).unwrap();
    let prepared = b.engine().prepare_next_checkpoint().unwrap().unwrap();
    let checkpoint = PreparedPublication::Checkpoint(prepared);
    let delivery = checkpoint.commit(&mut b.store, &b.config).unwrap();
    assert_eq!(delivery.documents.len(), 2);
    let before = b.note();
    batch.commit(&mut b.store, &b.config).unwrap();
    checkpoint.commit(&mut b.store, &b.config).unwrap();
    assert_eq!(b.note(), before);
}
