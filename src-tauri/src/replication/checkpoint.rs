use rusqlite::{OptionalExtension, params};
use yrs::{ReadTxn, StateVector, Transact};

use super::{
    apply::{persist_attachment_metadata, prepare_documents, validate_attachment_identity},
    journal::*,
    protocol::*,
};
use crate::{
    document_model::ReadError,
    persistence::{CommitFault, DocumentCommitInput, PersistenceCommitRequest},
};

pub struct PreparedCheckpoint {
    pub(super) checkpoint: Checkpoint,
    pub(super) signed: SignedContent,
    pub(super) documents: Vec<DocumentCommitInput>,
    pub(super) affected_note_ids: Vec<String>,
    pub(super) local_help_note_ids: Vec<String>,
}

impl ReplicationEngine<'_> {
    pub fn initial_checkpoint(&self) -> Result<Option<SignedContent>, ReadError> {
        // An accepted checkpoint remains locally useful after its signer is
        // revoked, but a new peer must receive an active device's signature.
        Ok(self.store.connection.query_row(
            "SELECT c.content,c.signature FROM sync_checkpoints c JOIN sync_members m ON m.device_id=c.issuer_device_id AND m.replica_id=c.issuer_replica_id WHERE m.revoked=0 ORDER BY c.rowid DESC LIMIT 1",
            [], |r| Ok(SignedContent { content: r.get(0)?, signature: r.get(1)? }),
        ).optional()?)
    }

    pub fn create_checkpoint(
        &mut self,
        key: &ed25519_dalek::SigningKey,
        compact: bool,
    ) -> Result<SignedContent, ReadError> {
        let transaction = self.store.connection.transaction()?;
        let prepared = build_export(&transaction, key)?;
        prepared.persist(&transaction, compact)?;
        transaction.commit()?;
        Ok(prepared.signed)
    }

    pub fn checkpoint_for(&self, received: &Frontier) -> Result<Option<SignedContent>, ReadError> {
        validate_frontier(received)?;
        let known = frontiers(&self.store.connection)?.applied;
        let mut missing = Vec::new();
        for (replica, sequence) in known {
            let from = received.get(&replica).copied().unwrap_or(0);
            if sequence <= from {
                continue;
            }
            let count: i64 = self.store.connection.query_row("SELECT COUNT(*) FROM sync_batches b JOIN sync_members m ON m.replica_id=b.replica_id WHERE m.revoked=0 AND b.replica_id=?1 AND b.sequence>?2 AND b.sequence<=?3 AND b.signature IS NOT NULL AND b.error IS NULL", params![replica,from,sequence], |r| r.get(0))?;
            if count < sequence - from {
                missing.push((replica, from));
            }
        }
        if missing.is_empty() {
            return Ok(None);
        }
        let candidates = self
            .store
            .connection
            .prepare("SELECT c.checkpoint_id,c.included FROM sync_checkpoints c JOIN sync_members m ON m.device_id=c.issuer_device_id AND m.replica_id=c.issuer_replica_id WHERE m.revoked=0 ORDER BY c.rowid DESC")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, included) in candidates {
            let included: Frontier = serde_json::from_str(&included)?;
            if missing
                .iter()
                .any(|(replica, from)| included.get(replica).copied().unwrap_or(0) > *from)
            {
                let signed: SignedContent = self.store.connection.query_row(
                    "SELECT content,signature FROM sync_checkpoints WHERE checkpoint_id=?1",
                    [id],
                    |r| {
                        Ok(SignedContent {
                            content: r.get(0)?,
                            signature: r.get(1)?,
                        })
                    },
                )?;
                return Ok(Some(signed));
            }
        }
        Err(error(
            "SYNC_CHECKPOINT",
            "Compacted change range has no retained checkpoint",
        ))
    }

    pub(super) fn validate_checkpoint(
        &self,
        signed: &SignedContent,
        accepted: bool,
    ) -> Result<Checkpoint, ReadError> {
        let config = required_config(&self.store.connection)?;
        let checkpoint: Checkpoint = decode(&signed.content, MAX_CHECKPOINT_BYTES)?;
        checkpoint.validate()?;
        if checkpoint.workspace_id != config.workspace_id || checkpoint.group_id != config.group_id
        {
            return Err(error(
                "SYNC_GROUP",
                "Checkpoint belongs to another synchronization group",
            ));
        }
        let member = member(&self.store.connection, &checkpoint.issuer, accepted)?;
        signed.verify("checkpoint", &member.public_key, MAX_CHECKPOINT_BYTES)?;
        let current = frontiers(&self.store.connection)?;
        if checkpoint
            .included
            .get(&config.origin.replica_id)
            .copied()
            .unwrap_or(0)
            > current
                .applied
                .get(&config.origin.replica_id)
                .copied()
                .unwrap_or(0)
        {
            return Err(error(
                "SYNC_REPLICA_REUSE",
                "Checkpoint contains unknown changes from this Workspace copy; restored copies must join as a new replica",
            ));
        }
        for replica in checkpoint.included.keys() {
            let registered: bool = self.store.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_members WHERE replica_id=?1)",
                [replica],
                |r| r.get(0),
            )?;
            if !registered {
                return Err(error(
                    "SYNC_UNREGISTERED",
                    "Checkpoint requires missing membership records",
                ));
            }
        }
        Ok(checkpoint)
    }

    /// The durable receive ACK includes checkpoint coverage before publication,
    /// while applied coverage changes only in the owner's document transaction.
    pub fn receive_checkpoint(
        &mut self,
        signed: &SignedContent,
    ) -> Result<ReplicaFrontier, ReadError> {
        if required_config(&self.store.connection)?.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let checkpoint = self.validate_checkpoint(signed, false)?;
        let hash = digest(&signed.content);
        self.receive_validated_checkpoint(&checkpoint, signed, &hash)
    }

    pub(super) fn receive_validated_checkpoint(
        &mut self,
        checkpoint: &Checkpoint,
        signed: &SignedContent,
        hash: &str,
    ) -> Result<ReplicaFrontier, ReadError> {
        let tx = self.store.connection.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT content_hash FROM sync_checkpoint_inbox WHERE checkpoint_id=?1",
                [&checkpoint.checkpoint_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = existing {
            if prior != hash {
                return Err(error(
                    "SYNC_EQUIVOCATION",
                    "Checkpoint ID was reused with different content",
                ));
            }
            return frontiers(&tx);
        }
        let (count, bytes) = inbox_usage(&tx)?;
        if count >= MAX_PENDING_BATCHES as i64
            || bytes.saturating_add(signed.content.len() as i64) > MAX_INBOX_BYTES as i64
        {
            return Err(error(
                "SYNC_LIMIT",
                "Persistent inbox is full; apply pending changes first",
            ));
        }
        tx.execute("INSERT INTO sync_checkpoint_inbox(checkpoint_id,content_hash,content,signature,received_at) VALUES(?1,?2,?3,?4,?5)",params![checkpoint.checkpoint_id,hash,signed.content,signed.signature,now()])?;
        for (replica, sequence) in &checkpoint.included {
            advance_received(&tx, replica, *sequence)?;
        }
        let frontier = frontiers(&tx)?;
        tx.commit()?;
        Ok(frontier)
    }

    pub fn prepare_next_checkpoint(&mut self) -> Result<Option<PreparedCheckpoint>, ReadError> {
        self.prepare_checkpoint_inner(true)
    }

    pub(super) fn prepare_checkpoint_readonly(
        &self,
    ) -> Result<Option<PreparedCheckpoint>, ReadError> {
        self.prepare_checkpoint_inner(false)
    }

    fn prepare_checkpoint_inner(
        &self,
        quarantine: bool,
    ) -> Result<Option<PreparedCheckpoint>, ReadError> {
        if required_config(&self.store.connection)?.paused {
            return Ok(None);
        }
        let next: Option<(String,SignedContent)> = self.store.connection.query_row(
            "SELECT checkpoint_id,content,signature FROM sync_checkpoint_inbox WHERE applied_at IS NULL AND error IS NULL ORDER BY length(content),received_at LIMIT 1",[],
            |r| Ok((r.get(0)?,SignedContent { content: r.get(1)?,signature: r.get(2)? }))).optional()?;
        let Some((id, signed)) = next else {
            return Ok(None);
        };
        match self.prepare_checkpoint(&signed) {
            Ok(prepared) => Ok(Some(prepared)),
            Err(failure) => {
                if quarantine {
                    self.store.connection.execute(
                        "UPDATE sync_checkpoint_inbox SET error=?2 WHERE checkpoint_id=?1",
                        params![id, failure.code],
                    )?;
                    return Err(failure);
                }
                let detail = serde_json::json!({"syncInbox":{"kind":"checkpoint","checkpointId":id,"hash":digest(&signed.content)},"cause":failure.details});
                Err(failure.with_details(detail))
            }
        }
    }

    pub fn prepare_checkpoint(
        &self,
        signed: &SignedContent,
    ) -> Result<PreparedCheckpoint, ReadError> {
        let accepted: bool = self.store.connection.query_row("SELECT EXISTS(SELECT 1 FROM sync_checkpoint_inbox WHERE content_hash=?1 AND signature=?2)",params![digest(&signed.content),signed.signature],|r| r.get(0))?;
        let checkpoint = self.validate_checkpoint(signed, accepted)?;
        let (documents, affected_note_ids, local_help_note_ids) =
            prepare_documents(&self.store.connection, &checkpoint.documents)?;
        validate_attachment_identity(&self.store.connection, &checkpoint.attachments)?;
        Ok(PreparedCheckpoint {
            checkpoint,
            signed: signed.clone(),
            documents,
            affected_note_ids,
            local_help_note_ids,
        })
    }

    pub fn commit_checkpoint(
        &mut self,
        prepared: &PreparedCheckpoint,
        fault: Option<CommitFault>,
    ) -> Result<ReplicaFrontier, ReadError> {
        if fault == Some(CommitFault::BeforeCommit) {
            return Err(
                crate::persistence::PersistenceError::Injected(CommitFault::BeforeCommit).into(),
            );
        }
        let transaction = self.store.connection.transaction()?;
        let checkpoint = &prepared.checkpoint;
        let receipt: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT content_hash,applied_at FROM sync_checkpoint_inbox WHERE checkpoint_id=?1",
                [&checkpoint.checkpoint_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((hash, applied)) = receipt {
            if hash != digest(&prepared.signed.content) {
                return Err(error(
                    "SYNC_EQUIVOCATION",
                    "Checkpoint receipt differs from the prepared content",
                ));
            }
            if applied.is_some() {
                return frontiers(&transaction);
            }
        }
        let old: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT content FROM sync_checkpoints WHERE checkpoint_id=?1",
                [&checkpoint.checkpoint_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            if old != prepared.signed.content {
                return Err(error(
                    "SYNC_EQUIVOCATION",
                    "Checkpoint ID was reused with different content",
                ));
            }
            return frontiers(&transaction);
        }
        let request = PersistenceCommitRequest {
            operation_id: format!("sync-checkpoint:{}", checkpoint.checkpoint_id),
            scope: "workspace-structure".into(),
            documents: prepared.documents.clone(),
            local_states: vec![],
            search_index_metadata_only_note_id: None,
            fault,
        };
        let before =
            crate::workspace_migration::canonical_workspace_before(&transaction, &request)?;
        super::apply::register_local_help(&transaction, &prepared.local_help_note_ids)?;
        crate::persistence::commit_documents(&transaction, &request)?;
        persist_attachment_metadata(&transaction, &checkpoint.attachments)?;
        crate::workspace_migration::advance_content_epoch(&transaction, &request, before)?;
        for (replica, sequence) in &checkpoint.included {
            transaction.execute("INSERT INTO sync_frontiers(replica_id,received,applied) VALUES(?1,?2,?2) ON CONFLICT(replica_id) DO UPDATE SET received=MAX(received,?2),applied=MAX(applied,?2)", params![replica,sequence])?;
            transaction.execute("UPDATE sync_batches SET applied_at=COALESCE(applied_at,?3) WHERE replica_id=?1 AND sequence<=?2 AND error IS NULL", params![replica,sequence,now()])?;
            advance_received(&transaction, replica, *sequence)?;
        }
        save_checkpoint(&transaction, checkpoint, &prepared.signed)?;
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
                "Checkpoint response was lost; retry its durable receipt",
            ));
        }
        Ok(frontier)
    }
}

fn save_checkpoint(
    connection: &rusqlite::Connection,
    checkpoint: &Checkpoint,
    signed: &SignedContent,
) -> Result<(), ReadError> {
    connection.execute("INSERT INTO sync_checkpoint_inbox(checkpoint_id,content_hash,signature,received_at,applied_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(checkpoint_id) DO UPDATE SET content=NULL,applied_at=?4",params![checkpoint.checkpoint_id,digest(&signed.content),signed.signature,now()])?;
    connection.execute("INSERT INTO sync_checkpoints(checkpoint_id,content,signature,created_at,included,issuer_device_id,issuer_replica_id) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![checkpoint.checkpoint_id,signed.content,signed.signature,now(),serde_json::to_string(&checkpoint.included)?,checkpoint.issuer.device_id,checkpoint.issuer.replica_id])?;
    // The newest full checkpoint covers all earlier local compaction ranges.
    // Imported checkpoints can have incomparable coverage, so keep them until
    // a newly authored full checkpoint includes the entire merged frontier.
    let config = required_config(connection)?;
    if checkpoint.issuer == config.origin {
        let previous = connection
            .prepare("SELECT checkpoint_id,included FROM sync_checkpoints WHERE checkpoint_id<>?1")?
            .query_map([&checkpoint.checkpoint_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, coverage) in previous {
            let coverage: Frontier = serde_json::from_str(&coverage)?;
            // A reader prepared earlier can be behind a checkpoint merged
            // while it was signing. Preserve incomparable recovery ranges.
            if coverage.iter().all(|(replica, seq)| {
                checkpoint.included.get(replica).copied().unwrap_or(0) >= *seq
            }) {
                connection.execute("DELETE FROM sync_checkpoints WHERE checkpoint_id=?1", [id])?;
            }
        }
    }
    Ok(())
}

/// A consistent export is serialized and signed on a private read-only reader.
/// Installing its immutable payload only holds the owner for the SQL commit.
pub struct PreparedCheckpointExport {
    config: ReplicaConfig,
    checkpoint: Checkpoint,
    signed: SignedContent,
}
impl PreparedCheckpointExport {
    pub fn prepare(
        root: &std::path::Path,
        config: &ReplicaConfig,
        key: &ed25519_dalek::SigningKey,
    ) -> Result<Self, ReadError> {
        let reader = super::publication::read_snapshot(root, config)?;
        build_export(&reader.connection, key)
    }
    pub fn commit(
        self,
        store: &mut crate::persistence::ProductStore,
        compact: bool,
    ) -> Result<(), ReadError> {
        super::publication::check_config(store, &self.config)?;
        let transaction = store.connection.transaction()?;
        member(&transaction, &self.config.origin, false)?;
        let applied = frontiers(&transaction)?.applied;
        if self
            .checkpoint
            .included
            .iter()
            .any(|(replica, seq)| applied.get(replica).copied().unwrap_or(0) < *seq)
        {
            return Err(error(
                "SYNC_FRONTIER",
                "Export exceeds the local applied frontier",
            ));
        }
        self.persist(&transaction, compact)?;
        transaction.commit()?;
        Ok(())
    }
    fn persist(&self, connection: &rusqlite::Connection, compact: bool) -> Result<(), ReadError> {
        save_checkpoint(connection, &self.checkpoint, &self.signed)?;
        if compact {
            for (replica, sequence) in &self.checkpoint.included {
                connection.execute("DELETE FROM sync_batches WHERE replica_id=?1 AND sequence<=?2 AND applied_at IS NOT NULL AND signature IS NOT NULL", params![replica,sequence])?;
            }
        }
        Ok(())
    }
}
fn build_export(
    connection: &rusqlite::Connection,
    key: &ed25519_dalek::SigningKey,
) -> Result<PreparedCheckpointExport, ReadError> {
    let config = required_config(connection)?;
    member(connection, &config.origin, false)?;
    if hex(&key.verifying_key().to_bytes()) != config.public_key {
        return Err(error("SYNC_KEY", "Checkpoint signing key does not match"));
    }
    let ids = connection.prepare("SELECT kind,document_id FROM documents WHERE document_id NOT IN (SELECT document_id FROM sync_local_documents) ORDER BY kind,document_id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    if ids.len() > 100_000 {
        return Err(error("SYNC_LIMIT", "Checkpoint has too many documents"));
    }
    let mut documents = Vec::with_capacity(ids.len());
    let mut bytes = 0_usize;
    for (kind, id) in ids {
        let stored = crate::workspace_migration::load_document(connection, &kind, &id)?;
        let doc = crate::document_model::decode_document(&stored)?;
        let update = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        bytes = bytes.saturating_add(update.len());
        if bytes > MAX_CHECKPOINT_BYTES / 4 * 3 {
            return Err(error(
                "SYNC_LIMIT",
                "Checkpoint exceeds its bounded working set",
            ));
        }
        documents.push(DocumentUpdate {
            kind,
            document_id: id,
            schema_version: stored.schema_version,
            update,
        });
    }
    let attachments = connection.prepare("SELECT attachment_id,sha256,size,original_filename,mime_type,created_at FROM attachments ORDER BY attachment_id LIMIT 100001")?
        .query_map([], |r| Ok(AttachmentReference { attachment_id: r.get(0)?,sha256: r.get(1)?,size: read_size(r,2)?,original_filename: r.get(3)?,mime_type: r.get(4)?,created_at: r.get(5)? }))?.collect::<Result<Vec<_>,_>>()?;
    let checkpoint = Checkpoint {
        version: PROTOCOL_VERSION,
        checkpoint_id: uuid::Uuid::now_v7().to_string(),
        group_id: config.group_id.clone(),
        workspace_id: config.workspace_id.clone(),
        issuer: config.origin.clone(),
        included: frontiers(connection)?.applied,
        documents,
        attachments,
    };
    checkpoint.validate()?;
    let content = serde_json::to_vec(&checkpoint)?;
    if content.len() > MAX_CHECKPOINT_BYTES {
        return Err(error("SYNC_LIMIT", "Encoded checkpoint exceeds its limit"));
    }
    let signed = SignedContent::sign(content, "checkpoint", key);
    Ok(PreparedCheckpointExport {
        config,
        checkpoint,
        signed,
    })
}
