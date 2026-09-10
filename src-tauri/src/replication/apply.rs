use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use yrs::{Doc, Map, MapRef, Out, ReadTxn, SharedRef, Transact, types::ToJson};

use super::{journal::*, protocol::*};
use crate::{
    document_model::{ReadError, decode_document},
    persistence::{
        CommitFault, DocumentCommitInput, DocumentRevision, PersistedDocument, PersistedUpdate,
        PersistenceCommitRequest,
    },
};

pub struct PreparedApplication {
    pub(super) batch: ChangeBatch,
    pub(super) content_hash: String,
    pub(super) documents: Vec<DocumentCommitInput>,
    pub(super) affected_note_ids: Vec<String>,
    pub(super) local_help_note_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBatch {
    pub origin: Origin,
    pub sequence: i64,
    pub documents: Vec<DocumentRevision>,
    pub updates: Vec<DocumentUpdate>,
    pub frontier: ReplicaFrontier,
}

impl ReplicationEngine<'_> {
    /// Validation reads one bounded batch off the persistent inbox. It makes no
    /// live-document or SQLite document change and may run off the GUI thread.
    pub fn prepare_next(&mut self) -> Result<Option<PreparedApplication>, ReadError> {
        self.prepare_next_inner(true)
    }

    pub(super) fn prepare_next_readonly(&self) -> Result<Option<PreparedApplication>, ReadError> {
        self.prepare_next_inner(false)
    }

    fn prepare_next_inner(
        &self,
        quarantine: bool,
    ) -> Result<Option<PreparedApplication>, ReadError> {
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Ok(None);
        }
        let frontier = frontiers(&self.store.connection)?.applied;
        let candidates = self.store.connection.prepare("SELECT b.replica_id,b.sequence,b.dependencies FROM sync_batches b LEFT JOIN sync_frontiers f ON f.replica_id=b.replica_id WHERE b.applied_at IS NULL AND b.error IS NULL AND b.sequence=COALESCE(f.applied,0)+1 ORDER BY length(b.content),b.received_at LIMIT 256")?
            .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        for (replica, sequence, dependencies) in candidates {
            let dependencies: Frontier = serde_json::from_str(&dependencies)?;
            if !dependencies
                .iter()
                .all(|(id, seq)| frontier.get(id).copied().unwrap_or(0) >= *seq)
            {
                continue;
            }
            let signed = self.store.connection.query_row(
                "SELECT content,signature FROM sync_batches WHERE replica_id=?1 AND sequence=?2",
                params![replica, sequence],
                |r| {
                    Ok(SignedContent {
                        content: r.get(0)?,
                        signature: r.get(1)?,
                    })
                },
            )?;
            let prepare = || -> Result<PreparedApplication, ReadError> {
                let batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES)?;
                batch.validate()?;
                // A later revocation cannot undo a previously accepted edit.
                let member = member(&self.store.connection, &batch.origin, true)?;
                signed.verify("batch", &member.public_key, MAX_BATCH_BYTES)?;
                let (documents, affected_note_ids, local_help_note_ids) =
                    prepare_documents(&self.store.connection, &batch.documents)?;
                validate_attachment_identity(&self.store.connection, &batch.attachments)?;
                Ok(PreparedApplication {
                    batch,
                    content_hash: digest(&signed.content),
                    documents,
                    affected_note_ids,
                    local_help_note_ids,
                })
            };
            match prepare() {
                Ok(value) => return Ok(Some(value)),
                Err(failure) => {
                    if quarantine {
                        self.store.connection.execute(
                            "UPDATE sync_batches SET error=?3 WHERE replica_id=?1 AND sequence=?2",
                            params![replica, sequence, failure.code],
                        )?;
                        return Err(failure);
                    }
                    let detail = serde_json::json!({"syncInbox":{"kind":"batch","replicaId":replica,"sequence":sequence,"hash":digest(&signed.content)},"cause":failure.details});
                    return Err(failure.with_details(detail));
                }
            }
        }
        Ok(None)
    }

    /// The caller owns the Workspace save queue, has flushed local edits, and
    /// has deferred this operation while an affected Note is composing.
    pub fn commit_prepared(
        &mut self,
        prepared: &PreparedApplication,
        fault: Option<CommitFault>,
    ) -> Result<AppliedBatch, ReadError> {
        if fault == Some(CommitFault::BeforeCommit) {
            return Err(
                crate::persistence::PersistenceError::Injected(CommitFault::BeforeCommit).into(),
            );
        }
        let transaction = self.store.connection.transaction()?;
        let batch = &prepared.batch;
        let current = frontiers(&transaction)?;
        let stored: Option<(String, Option<String>, Option<String>)> = transaction.query_row("SELECT content_hash,applied_at,result FROM sync_batches WHERE replica_id=?1 AND sequence=?2", params![batch.origin.replica_id,batch.sequence], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let stored = if let Some(stored) = stored {
            stored
        } else {
            let receipt: (String, Option<String>) = transaction.query_row(
                "SELECT content_hash,result FROM sync_receipts WHERE replica_id=?1 AND sequence=?2",
                params![batch.origin.replica_id, batch.sequence],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if current
                .applied
                .get(&batch.origin.replica_id)
                .copied()
                .unwrap_or(0)
                < batch.sequence
            {
                return Err(error(
                    "SYNC_RECEIPT",
                    "Unapplied replication payload is missing",
                ));
            }
            (receipt.0, Some("checkpoint".into()), receipt.1)
        };
        if stored.0 != prepared.content_hash {
            return Err(error(
                "SYNC_EQUIVOCATION",
                "Prepared batch no longer matches its receipt",
            ));
        }
        if stored.1.is_some() {
            let documents = serde_json::from_str(stored.2.as_deref().unwrap_or("[]"))?;
            return Ok(AppliedBatch {
                origin: batch.origin.clone(),
                sequence: batch.sequence,
                documents,
                updates: batch.documents.clone(),
                frontier: current,
            });
        }
        if current
            .applied
            .get(&batch.origin.replica_id)
            .copied()
            .unwrap_or(0)
            + 1
            != batch.sequence
            || !batch
                .dependencies
                .iter()
                .all(|(id, seq)| current.applied.get(id).copied().unwrap_or(0) >= *seq)
        {
            return Err(error(
                "SYNC_DEPENDENCY",
                "Batch dependencies are not applied",
            ));
        }
        let request = PersistenceCommitRequest {
            operation_id: format!("sync:{}:{}", batch.origin.replica_id, batch.sequence),
            scope: "workspace-structure".into(),
            documents: prepared.documents.clone(),
            local_states: vec![],
            search_index_metadata_only_note_id: None,
            fault,
        };
        let before =
            crate::workspace_migration::canonical_workspace_before(&transaction, &request)?;
        register_local_help(&transaction, &prepared.local_help_note_ids)?;
        let revisions = crate::persistence::commit_documents(&transaction, &request)?;
        persist_attachment_metadata(&transaction, &batch.attachments)?;
        crate::workspace_migration::advance_content_epoch(&transaction, &request, before)?;
        if !batch.attachments.is_empty() {
            crate::workspace_migration::bump_content_epoch(&transaction)?;
        }
        transaction.execute(
            "UPDATE sync_batches SET applied_at=?3,result=?4 WHERE replica_id=?1 AND sequence=?2",
            params![
                batch.origin.replica_id,
                batch.sequence,
                now(),
                serde_json::to_string(&revisions)?
            ],
        )?;
        transaction.execute(
            "UPDATE sync_frontiers SET applied=?2 WHERE replica_id=?1",
            params![batch.origin.replica_id, batch.sequence],
        )?;
        transaction.execute(
            "UPDATE sync_receipts SET result=?3 WHERE replica_id=?1 AND sequence=?2",
            params![
                batch.origin.replica_id,
                batch.sequence,
                serde_json::to_string(&revisions)?
            ],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_last_applied_at',?1)",
            [now()],
        )?;
        let frontier = frontiers(&transaction)?;
        if fault == Some(CommitFault::BeforeSqlCommit) {
            return Err(crate::persistence::PersistenceError::Injected(
                CommitFault::BeforeSqlCommit,
            )
            .into());
        }
        transaction.commit()?;
        if fault == Some(CommitFault::AfterCommitResponse) {
            return Err(error(
                "SYNC_RESPONSE_LOST",
                "Application response was lost; retry the durable receipt",
            ));
        }
        Ok(AppliedBatch {
            origin: batch.origin.clone(),
            sequence: batch.sequence,
            documents: revisions,
            updates: batch.documents.clone(),
            frontier,
        })
    }
}

pub(super) fn prepare_documents(
    connection: &Connection,
    updates: &[DocumentUpdate],
) -> Result<(Vec<DocumentCommitInput>, Vec<String>, Vec<String>), ReadError> {
    let mut result = Vec::with_capacity(updates.len());
    let mut affected = std::collections::BTreeSet::new();
    let mut help = std::collections::BTreeSet::new();
    let incoming_notes: std::collections::BTreeSet<_> = updates
        .iter()
        .filter(|u| u.kind == "note")
        .map(|u| u.document_id.as_str())
        .collect();
    for update in updates {
        let local: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_local_documents WHERE document_id=?1)",
            [&update.document_id],
            |r| r.get(0),
        )?;
        if local {
            return Err(error(
                "SYNC_LOCAL_DOCUMENT",
                "Managed Help content is local to each device",
            ));
        }
        let existing: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE kind=?1 AND document_id=?2)",
            params![update.kind, update.document_id],
            |r| r.get(0),
        )?;
        let mut document = if existing {
            crate::workspace_migration::load_document(
                connection,
                &update.kind,
                &update.document_id,
            )?
        } else {
            PersistedDocument {
                kind: update.kind.clone(),
                document_id: update.document_id.clone(),
                schema_version: update.schema_version,
                revision: 0,
                snapshot_revision: 0,
                snapshot: update.update.clone(),
                updates: vec![],
            }
        };
        if document.schema_version != update.schema_version {
            return Err(error(
                "SYNC_SCHEMA",
                "Mixed document schemas cannot synchronize",
            ));
        }
        let before = if existing {
            Some(decode_document(&document)?)
        } else {
            None
        };
        let namespace_before = if existing && update.kind == "workspace" {
            Some(crate::namespace::read_namespace(&document)?)
        } else {
            None
        };
        let base_revision = document.revision;
        if existing {
            document.revision += 1;
            document.updates.push(PersistedUpdate {
                revision: document.revision,
                update: update.update.clone(),
            });
        }
        // Decode and interpret before committing any of the batch's documents.
        // Unknown schemas, damaged updates and invalid IDs stay in quarantine.
        let decoded = decode_document(&document)?;
        if decoded.transact().store().pending_update().is_some()
            || decoded.transact().store().pending_ds().is_some()
        {
            return Err(error(
                "SYNC_DEPENDENCY",
                "Document update contains unresolved CRDT dependencies",
            ));
        }
        if let Some(before) = &before {
            validate_transition(before, &decoded, &update.kind)?;
        }
        match update.kind.as_str() {
            "note" => {
                crate::replicated_note::read(&document)?;
                affected.insert(update.document_id.clone());
            }
            "workspace" => {
                let namespace = crate::namespace::read_namespace(&document)?;
                for (id, metadata) in &namespace.notes {
                    if metadata["system_role"] == "help" {
                        help.insert(id.clone());
                    } else if namespace_before
                        .as_ref()
                        .is_none_or(|n| !n.notes.contains_key(id))
                        && !incoming_notes.contains(id.as_str())
                    {
                        let present: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE kind='note' AND document_id=?1)", [id], |r| r.get(0))?;
                        if !present {
                            return Err(error(
                                "SYNC_DEPENDENCY",
                                "A new Note placement requires its document in the same batch",
                            ));
                        }
                    }
                }
                for (id, entry) in &namespace.entries {
                    let old = namespace_before.as_ref().and_then(|n| n.entries.get(id));
                    if old.map(|e| e.deleted_at.is_some()) != Some(entry.deleted_at.is_some())
                        && let Some(target) = &entry.target
                    {
                        affected.insert(target.id.clone());
                    }
                }
            }
            _ => return Err(error("SYNC_SCHEMA", "Unknown replicated document kind")),
        }
        result.push(DocumentCommitInput {
            kind: update.kind.clone(),
            document_id: update.document_id.clone(),
            schema_version: update.schema_version,
            base_revision,
            snapshot: (!existing).then(|| update.update.clone()),
            update: existing.then(|| update.update.clone()),
        });
    }
    if updates
        .iter()
        .any(|u| u.kind == "note" && help.contains(&u.document_id))
    {
        return Err(error(
            "SYNC_LOCAL_DOCUMENT",
            "Managed Help body cannot be delivered with its shared placement",
        ));
    }
    Ok((
        result,
        affected.into_iter().collect(),
        help.into_iter().collect(),
    ))
}

pub(super) fn register_local_help(
    connection: &Connection,
    ids: &[String],
) -> Result<(), ReadError> {
    for id in ids {
        connection.execute(
            "INSERT OR IGNORE INTO sync_local_documents(document_id) VALUES(?1)",
            [id],
        )?;
    }
    Ok(())
}

fn map(txn: &impl ReadTxn, parent: &MapRef, key: &str) -> Result<MapRef, ReadError> {
    match parent.get(txn, key) {
        Some(Out::YMap(map)) => Ok(map),
        _ => Err(error("SYNC_STRUCTURE", "Shared map identity is missing")),
    }
}
fn stable_map(before: &MapRef, after: &MapRef) -> Result<(), ReadError> {
    if before.hook() != after.hook() {
        return Err(error(
            "SYNC_STRUCTURE",
            "Shared content was replaced instead of moved",
        ));
    }
    Ok(())
}
fn immutable_values(
    before: &MapRef,
    old: &impl ReadTxn,
    after: &MapRef,
    new: &impl ReadTxn,
) -> Result<(), ReadError> {
    for (key, value) in before.iter(old) {
        if after
            .get(new, key)
            .is_none_or(|next| value.to_json(old) != next.to_json(new))
        {
            return Err(error(
                "SYNC_STRUCTURE",
                "Immutable entity or operation was removed or changed",
            ));
        }
    }
    Ok(())
}

fn immutable_fields(
    before: &MapRef,
    old: &impl ReadTxn,
    after: &MapRef,
    new: &impl ReadTxn,
    keys: &[&str],
) -> Result<(), ReadError> {
    for key in keys {
        if before.get(old, key).map(|value| value.to_json(old))
            != after.get(new, key).map(|value| value.to_json(new))
        {
            return Err(error(
                "SYNC_STRUCTURE",
                "Document identity, creation metadata, or content layout changed",
            ));
        }
    }
    Ok(())
}

/// Authenticated peers still cannot silently replace stable objects, erase a
/// deletion record, or rewrite an already published structural operation.
pub(super) fn validate_transition(before: &Doc, after: &Doc, kind: &str) -> Result<(), ReadError> {
    let old = before.transact();
    let new = after.transact();
    if kind == "note" {
        let before_meta = old
            .get_map("meta")
            .ok_or_else(|| error("SYNC_STRUCTURE", "Note metadata is missing"))?;
        let after_meta = new
            .get_map("meta")
            .ok_or_else(|| error("SYNC_STRUCTURE", "Note metadata is missing"))?;
        immutable_fields(
            &before_meta,
            &old,
            &after_meta,
            &new,
            &["note_id", "schema_version", "created_at", "content_layout"],
        )?;
        for name in ["entities", "placements", "deletions", "restorations"] {
            if let Some(left) = old.get_map(name) {
                let right = new
                    .get_map(name)
                    .ok_or_else(|| error("SYNC_STRUCTURE", "Shared operation map disappeared"))?;
                immutable_values(&left, &old, &right, &new)?;
            }
        }
        if let Some(left) = old.get_map("content") {
            let right = new
                .get_map("content")
                .ok_or_else(|| error("SYNC_STRUCTURE", "Content registry disappeared"))?;
            for (id, _) in left.iter(&old) {
                let left = map(&old, &left, id)?;
                let right = map(&new, &right, id)?;
                stable_map(&left, &right)?;
                stable_map(&map(&old, &left, "attrs")?, &map(&new, &right, "attrs")?)?;
                match (left.get(&old, "inline"), right.get(&new, "inline")) {
                    (Some(Out::YXmlFragment(a)), Some(Out::YXmlFragment(b)))
                        if a.hook() == b.hook() => {}
                    _ => {
                        return Err(error(
                            "SYNC_STRUCTURE",
                            "Stable inline fragment was removed or replaced",
                        ));
                    }
                }
            }
        }
    } else {
        let left = old
            .get_map("workspace")
            .ok_or_else(|| error("SYNC_STRUCTURE", "Workspace root is missing"))?;
        let right = new
            .get_map("workspace")
            .ok_or_else(|| error("SYNC_STRUCTURE", "Workspace root is missing"))?;
        immutable_fields(
            &left,
            &old,
            &right,
            &new,
            &["workspace_id", "schema_version"],
        )?;
        let left_ns = map(&old, &left, "main_namespace")?;
        let right_ns = map(&new, &right, "main_namespace")?;
        stable_map(&left_ns, &right_ns)?;
        immutable_fields(&left_ns, &old, &right_ns, &new, &["namespace_id"])?;
        for name in ["placements", "deletions", "restorations"] {
            immutable_values(
                &map(&old, &left_ns, name)?,
                &old,
                &map(&new, &right_ns, name)?,
                &new,
            )?;
        }
        for (left, right) in [
            (
                map(&old, &left_ns, "entries")?,
                map(&new, &right_ns, "entries")?,
            ),
            (map(&old, &left, "notes")?, map(&new, &right, "notes")?),
        ] {
            stable_map(&left, &right)?;
            for (id, _) in left.iter(&old) {
                let left = map(&old, &left, id)?;
                let right = map(&new, &right, id)?;
                stable_map(&left, &right)?;
                immutable_fields(
                    &left,
                    &old,
                    &right,
                    &new,
                    &["target", "created_at", "system_role"],
                )?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate_attachment_identity(
    connection: &Connection,
    references: &[AttachmentReference],
) -> Result<(), ReadError> {
    validate_attachments(references)?;
    for item in references {
        let old = connection.query_row("SELECT sha256,size,original_filename,mime_type,created_at FROM attachments WHERE attachment_id=?1", [&item.attachment_id], |r| Ok(AttachmentReference { attachment_id: item.attachment_id.clone(),sha256: r.get(0)?,size: read_size(r,1)?,original_filename: r.get(2)?,mime_type: r.get(3)?,created_at: r.get(4)? })).optional()?;
        if old.is_some_and(|old| old != *item) {
            return Err(error(
                "SYNC_ATTACHMENT",
                "Existing attachment identity changed",
            ));
        }
    }
    Ok(())
}

pub(super) fn persist_attachment_metadata(
    connection: &Connection,
    references: &[AttachmentReference],
) -> Result<(), ReadError> {
    validate_attachment_identity(connection, references)?;
    for item in references {
        let known: Option<i64> = connection
            .query_row(
                "SELECT size FROM attachment_objects WHERE sha256=?1",
                [&item.sha256],
                |r| r.get(0),
            )
            .optional()?;
        if known.is_some_and(|size| size != item.size as i64) {
            return Err(error(
                "SYNC_ATTACHMENT",
                "Attachment hash has conflicting sizes",
            ));
        }
        connection.execute(
            "INSERT OR IGNORE INTO attachment_objects(sha256,size,created_at) VALUES(?1,?2,?3)",
            params![item.sha256, item.size as i64, item.created_at],
        )?;
        connection.execute("INSERT OR IGNORE INTO attachments(attachment_id,sha256,size,original_filename,mime_type,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![item.attachment_id,item.sha256,item.size as i64,item.original_filename,item.mime_type,item.created_at])?;
        connection.execute(
            "INSERT OR IGNORE INTO sync_attachment_transfers(sha256,size) VALUES(?1,?2)",
            params![item.sha256, item.size as i64],
        )?;
    }
    Ok(())
}
