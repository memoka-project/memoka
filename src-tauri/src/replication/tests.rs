use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use serde_json::Value;
use yrs::{Map, Out, ReadTxn, Text, Transact, XmlFragment};

use super::{protocol::*, *};
use crate::{
    document_model::{decode_document, read_note},
    persistence::{
        CommitFault, DocumentCommitInput, PersistedDocument, PersistenceCommitRequest, ProductStore,
    },
};

const AT: &str = "2026-09-10T00:00:00.000Z";
#[path = "authorization_tests.rs"]
mod authorization_tests;
#[path = "publication_tests.rs"]
mod publication_tests;
struct Peer {
    store: ProductStore,
    root: tempfile::TempDir,
    key: SigningKey,
    config: ReplicaConfig,
}
fn id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn peers() -> Vec<Peer> {
    seed_peers(false)
}
fn seed_peers(help: bool) -> Vec<Peer> {
    let source: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/reader-contract.json")).unwrap();
    let group = id();
    let keys: Vec<_> = (1..=3)
        .map(|seed| SigningKey::from_bytes(&[seed; 32]))
        .collect();
    let members: Vec<_> = keys
        .iter()
        .enumerate()
        .map(|(index, key)| ReplicaMember {
            origin: Origin {
                device_id: id(),
                replica_id: id(),
            },
            public_key: hex(&key.verifying_key().to_bytes()),
            name: format!("Device {index}"),
            revoked: false,
        })
        .collect();
    let documents: Vec<_> = source["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let mut doc = PersistedDocument {
                kind: row["kind"].as_str().unwrap().into(),
                document_id: row["document_id"].as_str().unwrap().into(),
                schema_version: row["schema_version"].as_i64().unwrap(),
                revision: 1,
                snapshot_revision: 1,
                snapshot: serde_json::from_value(row["snapshot"].clone()).unwrap(),
                updates: vec![],
            };
            doc.snapshot = if doc.kind == "note" {
                crate::replicated_note::edit::migrate(&doc, &members[0].origin.replica_id).unwrap()
            } else {
                crate::replicated_namespace::migrate(&doc, &members[0].origin.replica_id).unwrap()
            };
            doc.schema_version = if doc.kind == "note" { 7 } else { 4 };
            if help && doc.kind == "workspace" {
                let ydoc = decode_document(&doc).unwrap();
                {
                    let mut txn = ydoc.transact_mut();
                    let root = txn.get_map("workspace").unwrap();
                    let Out::YMap(notes) = root.get(&txn, "notes").unwrap() else {
                        panic!()
                    };
                    let Out::YMap(note) = notes
                        .get(&txn, "01a30000-0000-7000-8000-000000000002")
                        .unwrap()
                    else {
                        panic!()
                    };
                    note.insert(&mut txn, "system_role", "help");
                }
                doc.snapshot = ydoc
                    .transact()
                    .encode_state_as_update_v1(&yrs::StateVector::default());
            }
            doc
        })
        .collect();
    let workspace_id = documents
        .iter()
        .find(|doc| doc.kind == "workspace")
        .unwrap()
        .document_id
        .clone();
    keys.into_iter()
        .enumerate()
        .map(|(index, key)| {
            let root = tempfile::tempdir().unwrap();
            let mut store = ProductStore::open(root.path()).unwrap();
            let config = ReplicaConfig {
                workspace_id: workspace_id.clone(),
                group_id: group.clone(),
                origin: members[index].origin.clone(),
                public_key: members[index].public_key.clone(),
                paused: false,
            };
            store
                .commit(&PersistenceCommitRequest {
                    operation_id: id(),
                    scope: "bootstrap".into(),
                    documents: documents
                        .iter()
                        .map(|doc| DocumentCommitInput {
                            kind: doc.kind.clone(),
                            document_id: doc.document_id.clone(),
                            schema_version: doc.schema_version,
                            base_revision: 0,
                            snapshot: Some(doc.snapshot.clone()),
                            update: None,
                        })
                        .collect(),
                    local_states: vec![],
                    search_index_metadata_only_note_id: None,
                    fault: None,
                })
                .unwrap();
            ReplicationEngine::new(&mut store)
                .initialize(&config, &members)
                .unwrap();
            Peer {
                store,
                root,
                key,
                config,
            }
        })
        .collect()
}

impl Peer {
    fn engine(&mut self) -> ReplicationEngine<'_> {
        ReplicationEngine::new(&mut self.store)
    }
    fn note(&self) -> PersistedDocument {
        self.store
            .load_document("note", "01a30000-0000-7000-8000-000000000002")
            .unwrap()
    }
    fn projection(&self) -> Value {
        serde_json::to_value(crate::replicated_note::read(&self.note()).unwrap()).unwrap()
    }
    fn outgoing(&mut self) -> Vec<SignedContent> {
        let mut engine = ReplicationEngine::new(&mut self.store);
        while engine.sign_next(&self.key).unwrap() {}
        engine.outgoing(&BTreeMap::new(), MAX_BATCH_BYTES).unwrap()
    }
    fn reopen(self) -> Self {
        let Self {
            store,
            root,
            key,
            config,
        } = self;
        drop(store);
        let store = ProductStore::open(root.path()).unwrap();
        Self {
            store,
            root,
            key,
            config,
        }
    }
    fn receive(&mut self, batches: &[SignedContent]) {
        for batch in batches {
            self.engine().receive(batch).unwrap();
        }
    }
    fn apply(&mut self) {
        while let Some(prepared) = self.engine().prepare_next().unwrap() {
            self.engine().commit_prepared(&prepared, None).unwrap();
        }
    }
    fn edit(&self, suffix: &str, move_child: bool) -> PersistenceCommitRequest {
        let source = self.note();
        let mut root = read_note(&source, true).unwrap().root;
        root.body[0]["content"][0]["text"] = format!(
            "{}{}",
            root.body[0]["content"][0]["text"].as_str().unwrap(),
            suffix
        )
        .into();
        if move_child {
            let children = std::mem::take(&mut root.children);
            root.children.push(crate::document_model::Section {
                section_id: id(),
                title: "Destination".into(),
                emoji: None,
                tags: vec![],
                body: vec![],
                children,
            });
        }
        let update = crate::replicated_note::edit::reconcile(
            &source,
            &root,
            &self.config.origin.replica_id,
            AT,
        )
        .unwrap();
        PersistenceCommitRequest {
            operation_id: id(),
            scope: "note-doc".into(),
            documents: vec![DocumentCommitInput {
                kind: source.kind,
                document_id: source.document_id,
                schema_version: 7,
                base_revision: source.revision,
                snapshot: None,
                update: Some(update),
            }],
            local_states: vec![],
            search_index_metadata_only_note_id: None,
            fault: None,
        }
    }
}

#[test]
fn local_commit_and_unsigned_outbox_survive_restart_and_response_loss_atomically() {
    let mut peer = peers().remove(0);
    let before = peer.note();
    let mut request = peer.edit("pending", false);
    request.fault = Some(CommitFault::BeforeSqlCommit);
    assert!(peer.store.commit(&request).is_err());
    assert_eq!(peer.note(), before);
    assert_eq!(peer.engine().status().unwrap().pending_signature_count, 0);
    request.fault = Some(CommitFault::AfterCommitResponse);
    assert!(peer.store.commit(&request).is_err());
    assert_eq!(peer.engine().status().unwrap().pending_signature_count, 1);
    let mut peer = peer.reopen();
    request.fault = None;
    assert!(peer.store.commit(&request).unwrap().deduplicated);
    assert_eq!(peer.outgoing().len(), 1);
    assert!(peer.projection().to_string().contains("pending"));
}

#[test]
fn checkpoint_inbox_survives_restart_before_apply_and_retains_a_compacted_receipt() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    let edit = a.edit("checkpoint change", false);
    a.store.commit(&edit).unwrap();
    a.outgoing();
    let key = a.key.clone();
    let checkpoint = a.engine().create_checkpoint(&key, true).unwrap();
    let edit = b.edit("unsent local change", false);
    b.store.commit(&edit).unwrap();
    let before = b.note();
    let frontier = b.engine().receive_checkpoint(&checkpoint).unwrap();
    assert_eq!(frontier.received.get(&a.config.origin.replica_id), Some(&1));
    assert_eq!(frontier.applied.get(&a.config.origin.replica_id), None);
    assert_eq!(b.note(), before);
    assert_eq!(b.engine().status().unwrap().pending_apply_count, 1);
    assert_eq!(
        b.engine().status().unwrap().pending_apply_bytes,
        checkpoint.content.len() as i64
    );
    let mut b = b.reopen();
    b.engine().receive_checkpoint(&checkpoint).unwrap();
    assert_eq!(b.engine().status().unwrap().pending_apply_count, 1);
    // The already saved checkpoint remains applicable if its issuer is later
    // removed. New checkpoint deliveries from that key are refused.
    b.store
        .connection
        .execute(
            "UPDATE sync_members SET revoked=1 WHERE replica_id=?1",
            [&a.config.origin.replica_id],
        )
        .unwrap();
    assert_eq!(
        b.engine().receive_checkpoint(&checkpoint).unwrap_err().code,
        "SYNC_REVOKED"
    );
    let prepared = b.engine().prepare_next_checkpoint().unwrap().unwrap();
    assert!(
        b.engine()
            .commit_checkpoint(&prepared, Some(CommitFault::BeforeSqlCommit))
            .is_err()
    );
    assert_eq!(b.note(), before);
    assert!(
        b.engine()
            .commit_checkpoint(&prepared, Some(CommitFault::AfterCommitResponse))
            .is_err()
    );
    let applied = b.note();
    assert_eq!(b.engine().status().unwrap().pending_apply_count, 0);
    let key = b.key.clone();
    b.engine().create_checkpoint(&key, true).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(b.note(), applied);
    assert!(b.projection().to_string().contains("unsent local change"));
    assert!(b.projection().to_string().contains("checkpoint change"));
    assert!(b.engine().prepare_next_checkpoint().unwrap().is_none());
}

#[test]
fn later_batches_wait_for_a_received_checkpoint_to_be_applied() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    let edit = a.edit("included", false);
    a.store.commit(&edit).unwrap();
    a.outgoing();
    let key = a.key.clone();
    let checkpoint = a.engine().create_checkpoint(&key, true).unwrap();
    b.engine().receive_checkpoint(&checkpoint).unwrap();
    let edit = a.edit("later", false);
    a.store.commit(&edit).unwrap();
    b.receive(&a.outgoing());
    assert_eq!(
        b.engine().status().unwrap().frontier.received[&a.config.origin.replica_id],
        2
    );
    assert!(b.engine().prepare_next().unwrap().is_none());
    let prepared = b.engine().prepare_next_checkpoint().unwrap().unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    b.apply();
    assert_eq!(
        b.engine().status().unwrap().frontier.applied[&a.config.origin.replica_id],
        2
    );
    assert_eq!(a.projection(), b.projection());
}

#[test]
fn invalid_checkpoint_content_is_quarantined_without_changing_documents() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.remove(0);
    let key = a.key.clone();
    let signed = a.engine().create_checkpoint(&key, false).unwrap();
    b.engine().receive_checkpoint(&signed).unwrap();
    let mut changed: Checkpoint = decode(&signed.content, MAX_CHECKPOINT_BYTES).unwrap();
    changed.documents.reverse();
    let changed = SignedContent::sign(serde_json::to_vec(&changed).unwrap(), "checkpoint", &key);
    assert_eq!(
        b.engine().receive_checkpoint(&changed).unwrap_err().code,
        "SYNC_EQUIVOCATION"
    );
    let prepared = b.engine().prepare_next_checkpoint().unwrap().unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    let mut bad: Checkpoint = decode(&signed.content, MAX_CHECKPOINT_BYTES).unwrap();
    bad.checkpoint_id = id();
    bad.documents
        .iter_mut()
        .find(|document| document.kind == "note")
        .unwrap()
        .update = vec![255, 255];
    let signed = SignedContent::sign(serde_json::to_vec(&bad).unwrap(), "checkpoint", &key);
    let before = b.note();
    b.engine().receive_checkpoint(&signed).unwrap();
    assert!(b.engine().prepare_next_checkpoint().is_err());
    assert_eq!(b.note(), before);
    assert_eq!(b.engine().status().unwrap().quarantined_count, 1);
    assert!(b.engine().prepare_next_checkpoint().unwrap().is_none());
}

#[test]
fn three_replicas_converge_under_reorder_duplicates_disconnect_and_forwarding() {
    let mut peers = peers();
    let mut c = peers.pop().unwrap();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("A1", true);
    a.store.commit(&request).unwrap();
    let request = a.edit("A2", false);
    a.store.commit(&request).unwrap();
    let request = b.edit("B", false);
    b.store.commit(&request).unwrap();
    let request = c.edit("C", false);
    c.store.commit(&request).unwrap();
    let outgoing = a.outgoing();
    b.receive(&outgoing[1..]);
    let status = b.engine().status().unwrap();
    assert_eq!(
        status.frontier.received.get(&a.config.origin.replica_id),
        None
    );
    assert!(b.engine().prepare_next().unwrap().is_none());
    let original = b.note();
    b.receive(&outgoing[..1]);
    b.receive(&outgoing[..1]);
    assert_eq!(b.note(), original);
    assert_eq!(
        b.engine().status().unwrap().frontier.received[&a.config.origin.replica_id],
        2
    );
    b = b.reopen();
    b.apply();
    // C receives A's signature via B without any direct A -> C exchange.
    let forwarded = b.outgoing();
    c.receive(&forwarded);
    c.apply();
    let returned = c.outgoing();
    b.receive(&returned);
    b.apply();
    let returned = b.outgoing();
    a.receive(&returned);
    a.apply();
    assert_eq!(a.projection(), b.projection());
    assert_eq!(b.projection(), c.projection());
    assert_eq!(
        a.engine().status().unwrap().frontier.applied,
        b.engine().status().unwrap().frontier.applied
    );
    assert!(c.projection().to_string().contains("A1A2"));
    assert!(c.projection().to_string().contains("Destination"));
    let status = c.engine().status().unwrap();
    let bad = ReplicaFrontier {
        applied: BTreeMap::from([(a.config.origin.replica_id.clone(), 99)]),
        received: BTreeMap::new(),
    };
    assert!(
        b.engine()
            .acknowledge(&c.config.origin.device_id, &bad)
            .is_err()
    );
    b.engine()
        .acknowledge(&c.config.origin.device_id, &status.frontier)
        .unwrap();
}

#[test]
fn received_multidocument_batches_rollback_together_and_resume_after_lost_commit_response() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let mut request = a.edit("atomic", false);
    let workspace = a
        .store
        .load_document("workspace", &a.config.workspace_id)
        .unwrap();
    let doc = decode_document(&workspace).unwrap();
    let vector = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let root = txn.get_map("workspace").unwrap();
        let Out::YMap(notes) = root.get(&txn, "notes").unwrap() else {
            panic!()
        };
        let Out::YMap(note) = notes.get(&txn, &request.documents[0].document_id).unwrap() else {
            panic!()
        };
        note.insert(&mut txn, "updated_at", AT);
    }
    request.scope = "workspace-structure".into();
    request.documents.push(DocumentCommitInput {
        kind: "workspace".into(),
        document_id: workspace.document_id.clone(),
        schema_version: 4,
        base_revision: workspace.revision,
        snapshot: None,
        update: Some(doc.transact().encode_state_as_update_v1(&vector)),
    });
    a.store.commit(&request).unwrap();
    b.receive(&a.outgoing());
    let old_note = b.note();
    let old_workspace = b
        .store
        .load_document("workspace", &b.config.workspace_id)
        .unwrap();
    let prepared = b.engine().prepare_next().unwrap().unwrap();
    assert!(
        b.engine()
            .commit_prepared(&prepared, Some(CommitFault::BeforeSqlCommit))
            .is_err()
    );
    assert_eq!(b.note(), old_note);
    assert_eq!(
        b.store
            .load_document("workspace", &b.config.workspace_id)
            .unwrap(),
        old_workspace
    );
    assert!(b.engine().status().unwrap().frontier.applied.is_empty());
    b = b.reopen();
    let prepared = b.engine().prepare_next().unwrap().unwrap();
    assert!(
        b.engine()
            .commit_prepared(&prepared, Some(CommitFault::AfterCommitResponse))
            .is_err()
    );
    let expected = b.note();
    b = b.reopen();
    b.engine().commit_prepared(&prepared, None).unwrap();
    assert_eq!(b.note(), expected);
    assert_eq!(b.engine().status().unwrap().pending_apply_count, 0);
    ReplicationEngine::new(&mut b.store)
        .create_checkpoint(&b.key, true)
        .unwrap();
    b = b.reopen();
    let replayed = b.engine().commit_prepared(&prepared, None).unwrap();
    assert_eq!(replayed.documents.len(), 2);
    assert_eq!(b.note(), expected);
}

#[test]
fn deletion_only_updates_are_delivered_even_when_state_vectors_match() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let source = a.note();
    let doc = decode_document(&source).unwrap();
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let content = txn.get_map("content").unwrap();
        let block = read_note(&source, true).unwrap().root.body[0]["attrs"]["blockId"]
            .as_str()
            .unwrap()
            .to_owned();
        let Out::YMap(body) = content.get(&txn, &block).unwrap() else {
            panic!()
        };
        let Out::YXmlFragment(inline) = body.get(&txn, "inline").unwrap() else {
            panic!()
        };
        let yrs::XmlOut::Text(text) = inline.get(&txn, 0).unwrap() else {
            panic!()
        };
        text.remove_range(&mut txn, 0, 3);
    }
    assert_eq!(doc.transact().state_vector(), before);
    let mut request = a.edit("unused", false);
    request.documents[0].update = Some(doc.transact().encode_state_as_update_v1(&before));
    a.store.commit(&request).unwrap();
    b.receive(&a.outgoing());
    b.apply();
    assert_eq!(a.projection(), b.projection());
    assert_eq!(
        b.engine().status().unwrap().frontier.applied[&a.config.origin.replica_id],
        1
    );
}

#[test]
fn checkpoint_compaction_merges_offline_unsent_edits_and_retains_delete_information() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let source = a.note();
    let mut root = read_note(&source, true).unwrap().root;
    let removed = root.children.remove(0).section_id;
    let mut request = a.edit("unused", false);
    request.documents[0].update = Some(
        crate::replicated_note::edit::reconcile(&source, &root, &a.config.origin.replica_id, AT)
            .unwrap(),
    );
    a.store.commit(&request).unwrap();
    a.outgoing();
    let checkpoint = ReplicationEngine::new(&mut a.store)
        .create_checkpoint(&a.key, true)
        .unwrap();
    assert!(
        a.engine()
            .outgoing(&BTreeMap::new(), MAX_BATCH_BYTES)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        a.engine().checkpoint_for(&BTreeMap::new()).unwrap(),
        Some(checkpoint.clone())
    );
    let edit = b.edit("OFFLINE", false);
    b.store.commit(&edit).unwrap();
    let before = b.note();
    let prepared = b.engine().prepare_checkpoint(&checkpoint).unwrap();
    assert!(
        b.engine()
            .commit_checkpoint(&prepared, Some(CommitFault::BeforeSqlCommit))
            .is_err()
    );
    assert_eq!(b.note(), before);
    b = b.reopen();
    let prepared = b.engine().prepare_checkpoint(&checkpoint).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(b.engine().status().unwrap().pending_signature_count, 1);
    assert!(b.projection().to_string().contains("OFFLINE"));
    assert!(
        b.projection()["recovery"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["entityId"] == removed)
    );
    a.receive(&b.outgoing());
    a.apply();
    assert_eq!(a.projection(), b.projection());
    let again = b.note();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(b.note(), again);
}

#[test]
fn invalid_signature_schema_identity_and_rewritten_history_are_quarantined() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("signed", false);
    a.store.commit(&request).unwrap();
    let signed = a.outgoing().remove(0);
    let mut corrupt = signed.clone();
    corrupt.signature.replace_range(0..2, "00");
    assert_eq!(
        b.engine().receive(&corrupt).unwrap_err().code,
        "SYNC_SIGNATURE"
    );
    let mut batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES).unwrap();
    batch.documents[0].schema_version = 6;
    let corrupt = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &a.key);
    assert_eq!(
        b.engine().receive(&corrupt).unwrap_err().code,
        "SYNC_SCHEMA"
    );
    b.engine().receive(&signed).unwrap();
    b.apply();
    batch = decode(&signed.content, MAX_BATCH_BYTES).unwrap();
    batch.documents[0].update = vec![0, 0];
    let changed = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &a.key);
    assert_eq!(
        b.engine().receive(&changed).unwrap_err().code,
        "SYNC_EQUIVOCATION"
    );
    let old = b.note();
    let doc = decode_document(&a.note()).unwrap();
    let vector = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let placements = txn.get_map("placements").unwrap();
        let key = placements.iter(&txn).next().unwrap().0.to_owned();
        placements.remove(&mut txn, &key);
    }
    batch.sequence = 2;
    batch
        .dependencies
        .insert(a.config.origin.replica_id.clone(), 1);
    batch.documents[0].update = doc.transact().encode_state_as_update_v1(&vector);
    let rewritten = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &a.key);
    b.engine().receive(&rewritten).unwrap();
    assert_eq!(
        b.engine().prepare_next().err().unwrap().code,
        "SYNC_STRUCTURE"
    );
    assert_eq!(b.note(), old);
    assert_eq!(b.engine().status().unwrap().quarantined_count, 4);
}

#[test]
fn preparation_does_not_overwrite_a_later_owner_commit() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("REMOTE", false);
    a.store.commit(&request).unwrap();
    b.receive(&a.outgoing());
    let prepared = b.engine().prepare_next().unwrap().unwrap();
    let request = b.edit("LOCAL", false);
    b.store.commit(&request).unwrap();
    let before = b.note();
    assert!(b.engine().commit_prepared(&prepared, None).is_err());
    assert_eq!(b.note(), before);
    b.apply();
    assert!(b.projection().to_string().contains("LOCAL"));
    assert!(b.projection().to_string().contains("REMOTE"));
    assert_eq!(b.engine().status().unwrap().pending_signature_count, 1);
}

fn attachment_batch(peer: &Peer, bytes: &[u8]) -> (SignedContent, String) {
    let hash = digest(bytes);
    let batch = ChangeBatch {
        version: PROTOCOL_VERSION,
        group_id: peer.config.group_id.clone(),
        workspace_id: peer.config.workspace_id.clone(),
        origin: peer.config.origin.clone(),
        sequence: 1,
        dependencies: BTreeMap::new(),
        documents: vec![],
        attachments: vec![AttachmentReference {
            attachment_id: id(),
            sha256: hash.clone(),
            size: bytes.len() as u64,
            original_filename: "添付.bin".into(),
            mime_type: "application/octet-stream".into(),
            created_at: AT.into(),
        }],
    };
    (
        SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &peer.key),
        hash,
    )
}

#[test]
fn missing_staging_after_restart_is_visible_and_can_be_retried() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let a = peers.pop().unwrap();
    let (batch, hash) = attachment_batch(&a, b"contents");
    b.receive(&[batch]);
    b.apply();
    b.engine().begin_attachment(&hash).unwrap();
    b.engine()
        .write_attachment_chunk(&hash, 0, b"cont", None)
        .unwrap();
    std::fs::remove_file(
        b.root
            .path()
            .join("attachments/sync-staging")
            .join(format!("{hash}.part")),
    )
    .unwrap();
    b = b.reopen();
    assert_eq!(
        b.engine().begin_attachment(&hash).unwrap_err().code,
        "SYNC_ATTACHMENT_CORRUPT"
    );
    assert_eq!(
        b.engine().pending_attachments(8).unwrap()[0]
            .error
            .as_deref(),
        Some("MISSING_BYTES")
    );
    b.engine().retry_attachment(&hash).unwrap();
    assert_eq!(b.engine().begin_attachment(&hash).unwrap().received, 0);
    b.engine()
        .write_attachment_chunk(&hash, 0, b"contents", None)
        .unwrap();
    assert!(b.engine().finish_attachment(&hash, None).unwrap().complete);
}

#[test]
fn attachment_chunks_resume_from_durable_offsets_and_publish_only_verified_cas_content() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let a = peers.pop().unwrap();
    let data: Vec<u8> = (0..600_000).map(|index| (index % 251) as u8).collect();
    let (batch, hash) = attachment_batch(&a, &data);
    b.receive(&[batch]);
    b.apply();
    assert_eq!(b.engine().pending_attachments(8).unwrap().len(), 1);
    assert_eq!(b.engine().begin_attachment(&hash).unwrap().received, 0);
    let first = &data[..super::attachments::ATTACHMENT_CHUNK_BYTES];
    assert!(
        b.engine()
            .write_attachment_chunk(&hash, 0, first, Some(CommitFault::BeforeSqlCommit))
            .is_err()
    );
    b = b.reopen();
    assert_eq!(b.engine().begin_attachment(&hash).unwrap().received, 0);
    assert!(
        b.engine()
            .write_attachment_chunk(&hash, 0, first, Some(CommitFault::AfterCommitResponse))
            .is_err()
    );
    b = b.reopen();
    assert_eq!(
        b.engine().begin_attachment(&hash).unwrap().received,
        first.len() as u64
    );
    assert_eq!(
        b.engine()
            .write_attachment_chunk(&hash, 0, first, None)
            .unwrap()
            .received,
        first.len() as u64
    );
    assert_eq!(
        b.engine()
            .write_attachment_chunk(&hash, 0, &[42], None)
            .unwrap_err()
            .code,
        "SYNC_ATTACHMENT_RETRY"
    );
    let mut offset = first.len();
    while offset < data.len() {
        let end = (offset + super::attachments::ATTACHMENT_CHUNK_BYTES).min(data.len());
        b.engine()
            .write_attachment_chunk(&hash, offset as u64, &data[offset..end], None)
            .unwrap();
        offset = end;
    }
    assert!(
        b.engine()
            .finish_attachment(&hash, Some(CommitFault::BeforeSqlCommit))
            .is_err()
    );
    b = b.reopen();
    assert!(b.engine().begin_attachment(&hash).unwrap().complete);
    assert!(b.engine().pending_attachments(8).unwrap().is_empty());
    let mut loaded = Vec::new();
    while loaded.len() < data.len() {
        loaded.extend(
            b.engine()
                .attachment_chunk(
                    &hash,
                    loaded.len() as u64,
                    super::attachments::ATTACHMENT_CHUNK_BYTES,
                )
                .unwrap(),
        );
    }
    assert_eq!(loaded, data);
    assert_eq!(
        b.engine()
            .attachment_chunk(&hash, data.len() as u64 + 1, 64)
            .unwrap_err()
            .code,
        "SYNC_ATTACHMENT_OFFSET"
    );
}

#[test]
fn attachment_size_hash_and_changed_retry_are_rejected_and_corrupt_files_are_quarantined() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let a = peers.pop().unwrap();
    let (batch, hash) = attachment_batch(&a, b"content");
    b.receive(&[batch]);
    b.apply();
    b.engine().begin_attachment(&hash).unwrap();
    assert_eq!(
        b.engine()
            .write_attachment_chunk(&hash, 0, b"too large", None)
            .unwrap_err()
            .code,
        "SYNC_ATTACHMENT_SIZE"
    );
    b.engine()
        .write_attachment_chunk(&hash, 0, b"corrupt", None)
        .unwrap();
    assert_eq!(
        b.engine().finish_attachment(&hash, None).unwrap_err().code,
        "SYNC_ATTACHMENT_HASH"
    );
    assert!(
        !b.root
            .path()
            .join("attachments/objects")
            .join(&hash[..2])
            .join(&hash[2..])
            .exists()
    );
    assert_eq!(
        std::fs::read_dir(b.root.path().join("attachments/sync-quarantine"))
            .unwrap()
            .count(),
        1
    );
    b = b.reopen();
    assert_eq!(
        b.engine().begin_attachment(&hash).unwrap().error.as_deref(),
        Some("SHA256_MISMATCH")
    );
    assert_eq!(b.engine().retry_attachment(&hash).unwrap().received, 0);
    b.engine()
        .write_attachment_chunk(&hash, 0, b"content", None)
        .unwrap();
    assert!(b.engine().finish_attachment(&hash, None).unwrap().complete);
}

#[test]
fn checkpoint_closes_received_gaps_without_losing_already_saved_later_batches() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("one", false);
    a.store.commit(&request).unwrap();
    a.outgoing();
    let checkpoint = ReplicationEngine::new(&mut a.store)
        .create_checkpoint(&a.key, true)
        .unwrap();
    let request = a.edit("two", false);
    a.store.commit(&request).unwrap();
    b.receive(&a.outgoing());
    assert!(b.engine().status().unwrap().frontier.received.is_empty());
    let prepared = b.engine().prepare_checkpoint(&checkpoint).unwrap();
    let frontier = b.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(frontier.received[&a.config.origin.replica_id], 2);
    assert_eq!(frontier.applied[&a.config.origin.replica_id], 1);
    b.apply();
    assert_eq!(a.projection(), b.projection());
    let status = b.engine().status().unwrap();
    a.engine()
        .acknowledge(&b.config.origin.device_id, &status.frontier)
        .unwrap();
}

#[test]
fn forwarding_selects_a_checkpoint_that_actually_covers_the_missing_compacted_range() {
    let mut peers = peers();
    let mut c = peers.pop().unwrap();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("A", false);
    a.store.commit(&request).unwrap();
    a.outgoing();
    let from_a = ReplicationEngine::new(&mut a.store)
        .create_checkpoint(&a.key, true)
        .unwrap();
    let prepared = b.engine().prepare_checkpoint(&from_a).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    let request = c.edit("C", false);
    c.store.commit(&request).unwrap();
    c.outgoing();
    let from_c = ReplicationEngine::new(&mut c.store)
        .create_checkpoint(&c.key, true)
        .unwrap();
    let prepared = b.engine().prepare_checkpoint(&from_c).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    let c_frontier = c.engine().status().unwrap().frontier.received;
    assert_eq!(
        b.engine().checkpoint_for(&c_frontier).unwrap(),
        Some(from_a)
    );
    let a_frontier = a.engine().status().unwrap().frontier.received;
    assert_eq!(
        b.engine().checkpoint_for(&a_frontier).unwrap(),
        Some(from_c)
    );
}

#[test]
fn pause_preserves_local_changes_and_attachment_staging_has_a_disk_budget() {
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    a.engine().set_paused(true).unwrap();
    let request = a.edit("paused edit", false);
    a.store.commit(&request).unwrap();
    assert!(a.outgoing().is_empty());
    assert_eq!(
        a.engine().status().unwrap().frontier.applied[&a.config.origin.replica_id],
        1
    );
    a.engine().set_paused(false).unwrap();
    b.receive(&a.outgoing());
    b.apply();
    let attachments: Vec<_> = (0..9)
        .map(|index| AttachmentReference {
            attachment_id: id(),
            sha256: digest(&[index]),
            size: crate::attachment::MAX_ATTACHMENT_BYTES,
            original_filename: format!("{index}.bin"),
            mime_type: "application/octet-stream".into(),
            created_at: AT.into(),
        })
        .collect();
    let batch = ChangeBatch {
        version: PROTOCOL_VERSION,
        group_id: a.config.group_id.clone(),
        workspace_id: a.config.workspace_id.clone(),
        origin: a.config.origin.clone(),
        sequence: 2,
        dependencies: BTreeMap::from([(a.config.origin.replica_id.clone(), 1)]),
        documents: vec![],
        attachments: attachments.clone(),
    };
    let signed = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &a.key);
    b.engine().set_paused(true).unwrap();
    assert_eq!(b.engine().receive(&signed).unwrap_err().code, "SYNC_PAUSED");
    b.engine().set_paused(false).unwrap();
    b.receive(&[signed]);
    b.apply();
    for attachment in &attachments[..8] {
        b.engine().begin_attachment(&attachment.sha256).unwrap();
    }
    assert_eq!(
        b.engine()
            .begin_attachment(&attachments[8].sha256)
            .unwrap_err()
            .code,
        "SYNC_LIMIT"
    );
    let status = b.engine().status().unwrap();
    assert_eq!(status.pending_attachment_count, 9);
    assert_eq!(
        status.pending_attachment_bytes,
        crate::attachment::MAX_ATTACHMENT_BYTES as i64 * 9
    );
}

#[test]
fn managed_help_placement_is_shared_but_its_body_and_manual_edits_stay_local() {
    let mut peers = seed_peers(true);
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let request = a.edit("A private Help edit", false);
    a.store.commit(&request).unwrap();
    let local = b.edit("B private Help edit", false);
    b.store.commit(&local).unwrap();
    assert!(a.outgoing().is_empty());
    assert!(b.outgoing().is_empty());
    let before = b.note();
    let checkpoint = ReplicationEngine::new(&mut a.store)
        .create_checkpoint(&a.key, true)
        .unwrap();
    let content: Checkpoint = decode(&checkpoint.content, MAX_CHECKPOINT_BYTES).unwrap();
    assert_eq!(content.documents.len(), 1);
    assert_eq!(content.documents[0].kind, "workspace");
    let prepared = b.engine().prepare_checkpoint(&checkpoint).unwrap();
    b.engine().commit_checkpoint(&prepared, None).unwrap();
    assert_eq!(b.note(), before);
    let batch = ChangeBatch {
        version: PROTOCOL_VERSION,
        group_id: a.config.group_id.clone(),
        workspace_id: a.config.workspace_id.clone(),
        origin: a.config.origin.clone(),
        sequence: 1,
        dependencies: BTreeMap::new(),
        documents: vec![DocumentUpdate {
            kind: "note".into(),
            document_id: request.documents[0].document_id.clone(),
            schema_version: 7,
            update: request.documents[0].update.clone().unwrap(),
        }],
        attachments: vec![],
    };
    let signed = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &a.key);
    b.engine().receive(&signed).unwrap();
    assert_eq!(
        b.engine().prepare_next().err().unwrap().code,
        "SYNC_LOCAL_DOCUMENT"
    );
    assert_eq!(b.note(), before);
}

#[test]
fn restored_group_state_cannot_authorize_old_keys_or_reuse_old_frontiers() {
    let mut peer = peers().remove(0);
    let request = peer.edit("retained after restore", false);
    peer.store.commit(&request).unwrap();
    let old_batch = peer.outgoing().remove(0);
    let original = peer.note();
    {
        let transaction = peer.store.connection.transaction().unwrap();
        super::clear_group_state(&transaction).unwrap();
        transaction.commit().unwrap();
    }
    assert_eq!(peer.engine().status().unwrap(), SyncStatus::default());
    assert_eq!(peer.note(), original);
    let key = SigningKey::from_bytes(&[17; 32]);
    let member = ReplicaMember {
        origin: Origin {
            device_id: id(),
            replica_id: id(),
        },
        public_key: hex(&key.verifying_key().to_bytes()),
        name: "Restored copy".into(),
        revoked: false,
    };
    let config = ReplicaConfig {
        workspace_id: peer.config.workspace_id.clone(),
        group_id: id(),
        origin: member.origin.clone(),
        public_key: member.public_key.clone(),
        paused: false,
    };
    peer.engine().initialize(&config, &[member]).unwrap();
    let mut batch: ChangeBatch = decode(&old_batch.content, MAX_BATCH_BYTES).unwrap();
    batch.group_id = config.group_id;
    let forged = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &peer.key);
    assert_eq!(
        peer.engine().receive(&forged).unwrap_err().code,
        "SYNC_UNREGISTERED"
    );
    assert!(peer.engine().status().unwrap().frontier.applied.is_empty());
}

#[cfg(unix)]
#[test]
fn attachment_paths_reject_symlinked_parents_and_hard_linked_staging_files() {
    use std::os::unix::fs::symlink;
    let mut peers = peers();
    let mut b = peers.pop().unwrap();
    let a = peers.pop().unwrap();
    let (batch, hash) = attachment_batch(&a, b"private");
    b.receive(&[batch]);
    b.apply();
    let outside = tempfile::tempdir().unwrap();
    let private = outside.path().join("private.txt");
    std::fs::write(&private, b"private").unwrap();
    let staging = b.root.path().join("attachments/sync-staging");
    std::fs::create_dir_all(&staging).unwrap();
    let part = staging.join(format!("{hash}.part"));
    std::fs::hard_link(&private, &part).unwrap();
    assert_eq!(
        b.engine().begin_attachment(&hash).unwrap_err().code,
        "UNSAFE_PATH"
    );
    assert_eq!(std::fs::read(&private).unwrap(), b"private");
    std::fs::remove_file(&part).unwrap();
    std::fs::remove_dir(&staging).unwrap();
    symlink(outside.path(), &staging).unwrap();
    assert_eq!(
        b.engine().begin_attachment(&hash).unwrap_err().code,
        "UNSAFE_PATH"
    );
    let objects = b.root.path().join("attachments/objects");
    symlink(outside.path(), &objects).unwrap();
    assert_eq!(
        b.engine().attachment_chunk(&hash, 0, 64).unwrap_err().code,
        "UNSAFE_PATH"
    );
    assert_eq!(std::fs::read(&private).unwrap(), b"private");
}
