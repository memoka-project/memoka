//! Prepare from a consistent read-only snapshot without holding the owner's
//! save mutex. The GUI publishes only updates committed by that owner.
use std::{path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;

use super::{
    PreparedApplication, PreparedCheckpoint, ReplicaConfig, ReplicationEngine, journal, protocol::*,
};
use crate::{
    document_model::ReadError,
    persistence::{DocumentCommitInput, DocumentRevision, ProductStore},
};

pub(super) enum PreparedPublication {
    Batch(PreparedApplication),
    Checkpoint(PreparedCheckpoint),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationDocument {
    pub kind: String,
    pub document_id: String,
    pub base_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedDocument {
    pub kind: String,
    pub document_id: String,
    pub revision: i64,
    #[serde(with = "super::protocol::binary")]
    pub update: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDelivery {
    pub workspace_id: String,
    pub group_id: String,
    pub documents: Vec<PublishedDocument>,
    pub affected_note_ids: Vec<String>,
    pub local_help_note_ids: Vec<String>,
    pub frontier: ReplicaFrontier,
    pub workspace_revision_before: Option<i64>,
}

impl PreparedPublication {
    fn local_help_note_ids(&self) -> &[String] {
        match self {
            Self::Batch(value) => &value.local_help_note_ids,
            Self::Checkpoint(value) => &value.local_help_note_ids,
        }
    }
    pub fn affected_note_ids(&self) -> &[String] {
        match self {
            Self::Batch(value) => &value.affected_note_ids,
            Self::Checkpoint(value) => &value.affected_note_ids,
        }
    }
    fn inputs(&self) -> &[DocumentCommitInput] {
        match self {
            Self::Batch(value) => &value.documents,
            Self::Checkpoint(value) => &value.documents,
        }
    }
    pub fn documents(&self) -> Vec<PublicationDocument> {
        self.inputs()
            .iter()
            .map(|doc| PublicationDocument {
                kind: doc.kind.clone(),
                document_id: doc.document_id.clone(),
                base_revision: doc.base_revision,
            })
            .collect()
    }
    pub fn prepare(root: &Path, config: &ReplicaConfig) -> Result<Option<Self>, ReadError> {
        let mut reader = read_snapshot(root, config)?;
        let engine = ReplicationEngine::new(&mut reader);
        if let Some(batch) = engine.prepare_next_readonly()? {
            return Ok(Some(Self::Batch(batch)));
        }
        Ok(engine.prepare_checkpoint_readonly()?.map(Self::Checkpoint))
    }
    pub fn commit(
        &self,
        store: &mut ProductStore,
        config: &ReplicaConfig,
    ) -> Result<SyncDelivery, ReadError> {
        check_config(store, config)?;
        // Build the publication payload before changing SQLite. There must be
        // no fallible serialization/validation after a successful commit.
        let mut documents = self
            .inputs()
            .iter()
            .map(|doc| {
                Ok(PublishedDocument {
                    kind: doc.kind.clone(),
                    document_id: doc.document_id.clone(),
                    revision: doc
                        .base_revision
                        .checked_add(1)
                        .ok_or_else(|| error("SYNC_REVISION", "Document revision overflow"))?,
                    update: doc
                        .update
                        .as_ref()
                        .or(doc.snapshot.as_ref())
                        .ok_or_else(|| error("SYNC_PUBLICATION", "Prepared update is missing"))?
                        .clone(),
                })
            })
            .collect::<Result<Vec<_>, ReadError>>()?;
        let mut engine = ReplicationEngine::new(store);
        let (revisions, frontier) = match self {
            Self::Batch(batch) => {
                let result = engine.commit_prepared(batch, None)?;
                (result.documents, result.frontier)
            }
            Self::Checkpoint(checkpoint) => {
                let frontier = engine.commit_checkpoint(checkpoint, None)?;
                let revisions = checkpoint
                    .documents
                    .iter()
                    .map(|doc| DocumentRevision {
                        kind: doc.kind.clone(),
                        document_id: doc.document_id.clone(),
                        revision: doc.base_revision + 1,
                    })
                    .collect();
                (revisions, frontier)
            }
        };
        let workspace_revision_before = self
            .inputs()
            .iter()
            .find(|doc| doc.kind == "workspace")
            .map(|doc| doc.base_revision);
        for doc in &mut documents {
            if let Some(revision) = revisions
                .iter()
                .find(|rev| rev.kind == doc.kind && rev.document_id == doc.document_id)
            {
                doc.revision = revision.revision;
            }
            // A checkpoint can already cover this batch. Its update remains
            // idempotent; the GUI never rewinds a later document revision.
        }
        Ok(SyncDelivery {
            workspace_id: config.workspace_id.clone(),
            group_id: config.group_id.clone(),
            documents,
            affected_note_ids: self.affected_note_ids().to_vec(),
            local_help_note_ids: self.local_help_note_ids().to_vec(),
            frontier,
            workspace_revision_before,
        })
    }
}

pub(super) fn check_config(
    store: &ProductStore,
    expected: &ReplicaConfig,
) -> Result<(), ReadError> {
    let config = journal::required_config(&store.connection)?;
    if config.workspace_id != expected.workspace_id
        || config.group_id != expected.group_id
        || config.origin != expected.origin
    {
        return Err(error(
            "SYNC_GROUP",
            "Publication belongs to another Workspace copy or group",
        ));
    }
    if config.paused {
        return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
    }
    Ok(())
}

pub(super) fn quarantine(
    store: &mut ProductStore,
    config: &ReplicaConfig,
    failure: &ReadError,
) -> Result<(), ReadError> {
    check_config(store, config)?;
    let record = &failure.details["syncInbox"];
    let Some(hash) = record["hash"].as_str() else {
        return Ok(());
    };
    unhex::<32>(hash)?;
    match record["kind"].as_str() {
        Some("batch") => {
            store.connection.execute("UPDATE sync_batches SET error=?1 WHERE replica_id=?2 AND sequence=?3 AND content_hash=?4 AND applied_at IS NULL",
                params![failure.code,record["replicaId"].as_str(),record["sequence"].as_i64(),hash])?;
        }
        Some("checkpoint") => {
            store.connection.execute("UPDATE sync_checkpoint_inbox SET error=?1 WHERE checkpoint_id=?2 AND content_hash=?3 AND applied_at IS NULL",params![failure.code,record["checkpointId"].as_str(),hash])?;
        }
        _ => {}
    }
    Ok(())
}

/// The transaction remains open until this private reader is dropped.
pub(super) fn read_snapshot(
    root: &Path,
    config: &ReplicaConfig,
) -> Result<ProductStore, ReadError> {
    let path = root.join("memoka.sqlite3");
    crate::read_service::plain_file(&path)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(1))?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN DEFERRED")?;
    let reader = ProductStore {
        connection,
        root: root.to_owned(),
    };
    check_config(&reader, config)?;
    Ok(reader)
}
