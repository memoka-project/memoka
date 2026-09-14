//! Bounded inbox publication: retain every signed receipt, publish each document once.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{OptionalExtension, params};

use super::{apply, journal::*, protocol::*};
use crate::{
    document_model::ReadError,
    persistence::{
        CommitFault, DocumentCommitInput, DocumentRevision, PersistenceCommitRequest, ProductStore,
    },
};

pub(super) const MAX_PUBLICATION_BATCHES: usize = 128;
pub(super) const MAX_PUBLICATION_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct PreparedBatchGroup {
    batches: Vec<(ChangeBatch, String)>,
    pub documents: Vec<DocumentCommitInput>,
    pub affected_note_ids: Vec<String>,
    pub local_help_note_ids: Vec<String>,
}

impl PreparedBatchGroup {
    pub fn prepare(store: &ProductStore) -> Result<Option<Self>, ReadError> {
        let config = required_config(&store.connection)?;
        if config.paused {
            return Ok(None);
        }
        let mut frontier = frontiers(&store.connection)?.applied;
        let mut batches = Vec::new();
        let mut overlay = BTreeMap::new();
        let mut documents: BTreeMap<(String, String), DocumentCommitInput> = BTreeMap::new();
        let mut affected = BTreeSet::new();
        let mut help = BTreeSet::new();
        let mut attachments: BTreeMap<String, AttachmentReference> = BTreeMap::new();
        let mut bytes = 0;
        while batches.len() < MAX_PUBLICATION_BATCHES {
            // One next sequence per issuer, relative to this group's virtual frontier.
            let candidates = store.connection.prepare("SELECT b.replica_id,b.sequence,b.dependencies,length(b.content) FROM sync_members m LEFT JOIN json_each(?1) f ON f.key=m.replica_id JOIN sync_batches b ON b.replica_id=m.replica_id AND b.sequence=COALESCE(CAST(f.value AS INTEGER),0)+1 WHERE b.applied_at IS NULL AND b.error IS NULL ORDER BY length(b.content),b.received_at,b.replica_id LIMIT 256")?
                .query_map([serde_json::to_string(&frontier)?], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,read_size(r,3)? as usize)))?
                .collect::<Result<Vec<_>,_>>()?;
            let mut next = None;
            for (replica, sequence, dependencies, size) in candidates {
                let dependencies: Frontier = serde_json::from_str(&dependencies)?;
                if dependencies
                    .iter()
                    .all(|(id, seq)| frontier.get(id).copied().unwrap_or(0) >= *seq)
                {
                    next = Some((replica, sequence, size));
                    break;
                }
            }
            let Some((replica, sequence, size)) = next else {
                break;
            };
            if !batches.is_empty() && bytes + size > MAX_PUBLICATION_BYTES {
                break;
            }
            let signed = store.connection.query_row(
                "SELECT content,signature FROM sync_batches WHERE replica_id=?1 AND sequence=?2",
                params![replica, sequence],
                |r| {
                    Ok(SignedContent {
                        content: r.get(0)?,
                        signature: r.get(1)?,
                    })
                },
            )?;
            let hash = digest(&signed.content);
            let prepared = (|| -> Result<ChangeBatch, ReadError> {
                let batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES)?;
                batch.validate()?;
                if batch.origin.replica_id != replica
                    || batch.sequence != sequence
                    || batch.group_id != config.group_id
                    || batch.workspace_id != config.workspace_id
                    || !batch
                        .dependencies
                        .iter()
                        .all(|(id, seq)| frontier.get(id).copied().unwrap_or(0) >= *seq)
                {
                    return Err(error("SYNC_BATCH", "Inbox identity or dependency changed"));
                }
                let author = member(&store.connection, &batch.origin, true)?;
                signed.verify("batch", &author.public_key, MAX_BATCH_BYTES)?;
                let (inputs, ids, local_help) = apply::prepare_documents_overlaid(
                    &store.connection,
                    &batch.documents,
                    &mut overlay,
                    &help,
                )?;
                apply::validate_attachment_identity(&store.connection, &batch.attachments)?;
                for attachment in &batch.attachments {
                    if attachments
                        .get(&attachment.attachment_id)
                        .is_some_and(|old| old != attachment)
                    {
                        return Err(error(
                            "SYNC_ATTACHMENT",
                            "Attachment identity changed inside publication",
                        ));
                    }
                    attachments.insert(attachment.attachment_id.clone(), attachment.clone());
                }
                affected.extend(ids);
                help.extend(local_help);
                for input in inputs {
                    let key = (input.kind.clone(), input.document_id.clone());
                    if let Some(previous) = documents.get_mut(&key) {
                        let old = previous
                            .update
                            .as_ref()
                            .or(previous.snapshot.as_ref())
                            .unwrap();
                        let update = input.update.as_ref().or(input.snapshot.as_ref()).unwrap();
                        let merged = yrs::merge_updates_v1([old.as_slice(), update.as_slice()])
                            .map_err(|_| {
                                error("SYNC_ENCODING", "Cannot merge publication updates")
                            })?;
                        if previous.snapshot.is_some() {
                            previous.snapshot = Some(merged);
                        } else {
                            previous.update = Some(merged);
                        }
                    } else {
                        documents.insert(key, input);
                    }
                }
                if documents
                    .values()
                    .any(|d| d.kind == "note" && help.contains(&d.document_id))
                {
                    return Err(error(
                        "SYNC_LOCAL_DOCUMENT",
                        "Managed Help content cannot be published",
                    ));
                }
                Ok(batch)
            })();
            let batch = prepared.map_err(|failure| {
                let details = serde_json::json!({"syncInbox":{"kind":"batch","replicaId":replica,"sequence":sequence,"hash":hash},"cause":failure.details});
                failure.with_details(details)
            })?;
            bytes += size;
            frontier.insert(replica, sequence);
            batches.push((batch, hash));
        }
        if batches.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            batches,
            documents: documents.into_values().collect(),
            affected_note_ids: affected.into_iter().collect(),
            local_help_note_ids: help.into_iter().collect(),
        }))
    }

    pub fn commit(
        &self,
        store: &mut ProductStore,
        fault: Option<CommitFault>,
    ) -> Result<(Vec<DocumentRevision>, ReplicaFrontier), ReadError> {
        if fault == Some(CommitFault::BeforeCommit) {
            return Err(
                crate::persistence::PersistenceError::Injected(CommitFault::BeforeCommit).into(),
            );
        }
        let transaction = store.connection.transaction()?;
        let current = frontiers(&transaction)?;
        let mut frontier = current.applied.clone();
        let mut applied = 0;
        let mut previous_revisions = BTreeMap::new();
        for (batch, hash) in &self.batches {
            let receipt: (String, Option<String>) = transaction.query_row(
                "SELECT content_hash,result FROM sync_receipts WHERE replica_id=?1 AND sequence=?2",
                params![batch.origin.replica_id, batch.sequence],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if receipt.0 != *hash {
                return Err(error("SYNC_EQUIVOCATION", "Prepared receipt changed"));
            }
            if current
                .applied
                .get(&batch.origin.replica_id)
                .copied()
                .unwrap_or(0)
                >= batch.sequence
            {
                applied += 1;
                let revisions: Vec<DocumentRevision> =
                    serde_json::from_str(receipt.1.as_deref().unwrap_or("[]"))?;
                for revision in revisions {
                    previous_revisions.insert(
                        (revision.kind.clone(), revision.document_id.clone()),
                        revision,
                    );
                }
                continue;
            }
            let stored: Option<(String, Option<String>)> = transaction.query_row("SELECT content_hash,error FROM sync_batches WHERE replica_id=?1 AND sequence=?2 AND applied_at IS NULL",params![batch.origin.replica_id,batch.sequence],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if stored
                .as_ref()
                .is_none_or(|(stored, error)| stored != hash || error.is_some())
            {
                return Err(error("SYNC_BATCH", "Prepared inbox entry is unavailable"));
            }
            if frontier.get(&batch.origin.replica_id).copied().unwrap_or(0) + 1 != batch.sequence
                || !batch
                    .dependencies
                    .iter()
                    .all(|(id, seq)| frontier.get(id).copied().unwrap_or(0) >= *seq)
            {
                return Err(error("SYNC_DEPENDENCY", "Publication dependencies changed"));
            }
            frontier.insert(batch.origin.replica_id.clone(), batch.sequence);
        }
        if applied == self.batches.len() {
            return Ok((previous_revisions.into_values().collect(), current));
        }
        if applied != 0 {
            return Err(error(
                "SYNC_DEPENDENCY",
                "Reprepare the uncovered publication after checkpoint application",
            ));
        }
        let request = PersistenceCommitRequest {
            operation_id: format!("sync-group:{}", self.batches[0].1),
            scope: "workspace-structure".into(),
            documents: self.documents.clone(),
            local_states: vec![],
            search_index_metadata_only_note_id: None,
            fault,
        };
        let before =
            crate::workspace_migration::canonical_workspace_before(&transaction, &request)?;
        apply::register_local_help(&transaction, &self.local_help_note_ids)?;
        let revisions = crate::persistence::commit_documents(&transaction, &request)?;
        let result = serde_json::to_string(&revisions)?;
        let at = now();
        let mut has_attachments = false;
        for (batch, _) in &self.batches {
            apply::persist_attachment_metadata(&transaction, &batch.attachments)?;
            has_attachments |= !batch.attachments.is_empty();
            transaction.execute("UPDATE sync_batches SET applied_at=?3,result=?4 WHERE replica_id=?1 AND sequence=?2", params![batch.origin.replica_id,batch.sequence,at,result])?;
            transaction.execute(
                "UPDATE sync_frontiers SET applied=?2 WHERE replica_id=?1",
                params![batch.origin.replica_id, batch.sequence],
            )?;
            transaction.execute(
                "UPDATE sync_receipts SET result=?3 WHERE replica_id=?1 AND sequence=?2",
                params![batch.origin.replica_id, batch.sequence, result],
            )?;
        }
        crate::workspace_migration::advance_content_epoch(&transaction, &request, before)?;
        if has_attachments {
            crate::workspace_migration::bump_content_epoch(&transaction)?;
        }
        transaction.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_last_applied_at',?1)",
            [&at],
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
                "Retry the durable publication receipts",
            ));
        }
        Ok((revisions, frontier))
    }
}
