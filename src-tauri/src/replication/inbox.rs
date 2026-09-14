//! Decode and authenticate large payloads on a private reader. Only the bounded
//! durable inbox transaction runs through the Workspace owner.
use super::{
    ReplicaConfig, ReplicationEngine, direct::FrameKind, journal, owner::ReplicationOwner,
    protocol::*, publication, rpc,
};
use crate::{document_model::ReadError, persistence::ProductStore};
use std::sync::Arc;
enum Content {
    Batch(ChangeBatch),
    Checkpoint(Checkpoint),
}
struct PreparedInbox {
    config: ReplicaConfig,
    content: Content,
    signed: SignedContent,
    hash: String,
    author_key: String,
}
impl PreparedInbox {
    fn prepare(
        root: &std::path::Path,
        config: &ReplicaConfig,
        signed: SignedContent,
        kind: FrameKind,
        hash: String,
    ) -> Result<Self, ReadError> {
        let mut reader = publication::read_snapshot(root, config)?;
        let content = match kind {
            FrameKind::Batch => {
                let batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES)?;
                batch.validate()?;
                if batch.group_id != config.group_id || batch.workspace_id != config.workspace_id {
                    return Err(error(
                        "SYNC_GROUP",
                        "Change belongs to another synchronization group",
                    ));
                }
                let member = journal::member(&reader.connection, &batch.origin, false)?;
                signed.verify("batch", &member.public_key, MAX_BATCH_BYTES)?;
                Content::Batch(batch)
            }
            FrameKind::Checkpoint => Content::Checkpoint(
                ReplicationEngine::new(&mut reader).validate_checkpoint(&signed, false)?,
            ),
            _ => return Err(error("SYNC_PROTOCOL", "Unsupported inbox content")),
        };
        let origin = match &content {
            Content::Batch(b) => &b.origin,
            Content::Checkpoint(c) => &c.issuer,
        };
        let author_key = journal::member(&reader.connection, origin, false)?.public_key;
        Ok(Self {
            config: config.clone(),
            content,
            signed,
            hash,
            author_key,
        })
    }
    fn commit(self, store: &mut ProductStore) -> Result<ReplicaFrontier, ReadError> {
        publication::check_config(store, &self.config)?;
        let origin = match &self.content {
            Content::Batch(b) => &b.origin,
            Content::Checkpoint(c) => &c.issuer,
        };
        if journal::member(&store.connection, origin, false)?.public_key != self.author_key {
            return Err(error("SYNC_KEY", "Issuer changed during verification"));
        }
        let mut engine = ReplicationEngine::new(store);
        match self.content {
            Content::Batch(batch) => {
                engine.receive_validated_batch(&batch, &self.signed, &self.hash)
            }
            Content::Checkpoint(checkpoint) => {
                engine.receive_validated_checkpoint(&checkpoint, &self.signed, &self.hash)
            }
        }
    }
}
pub(super) async fn receive<O: ReplicationOwner>(
    owner: Arc<O>,
    config: ReplicaConfig,
    peer: Origin,
    peer_key: String,
    kind: FrameKind,
    signed: SignedContent,
) -> Result<ReplicaFrontier, ReadError> {
    let expected = config.clone();
    let origin = peer.clone();
    let key = peer_key.clone();
    let root = owner
        .dispatch(move |store| {
            rpc::check_peer(store, &expected, &origin, &key)?;
            Ok(store.root.clone())
        })
        .await?;
    let expected = config.clone();
    let bytes = signed.content.len() as i64;
    let (prepared, hash) = tokio::task::spawn_blocking(move || {
        let hash = digest(&signed.content);
        (
            PreparedInbox::prepare(&root, &expected, signed, kind, hash.clone()),
            hash,
        )
    })
    .await
    .map_err(|_| error("SYNC_INBOX", "Content verification failed"))?;
    owner.dispatch(move |store| {
        rpc::check_peer(store, &config, &peer, &peer_key)?;
        let result = prepared.and_then(|prepared| prepared.commit(store));
        if let Err(failure) = &result {
            if !matches!(failure.code.as_str(), "SYNC_LIMIT" | "SYNC_PAUSED") {
                store.connection.execute("INSERT OR IGNORE INTO sync_quarantine(content_hash,reason,received_at,bytes) VALUES(?1,?2,?3,?4)", rusqlite::params![hash,failure.code,journal::now(),bytes])?;
                store.connection.execute("DELETE FROM sync_quarantine WHERE rowid NOT IN (SELECT rowid FROM sync_quarantine ORDER BY rowid DESC LIMIT 256)", [])?;
            }
        }
        result
    }).await
}
