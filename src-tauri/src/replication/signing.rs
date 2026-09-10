//! Signature computation never holds the Workspace owner's save mutex.
use super::{ReplicaConfig, journal, protocol::*, publication};
use crate::{document_model::ReadError, persistence::ProductStore};
use ed25519_dalek::SigningKey;
use rusqlite::{OptionalExtension, params};

pub(super) struct PreparedSignature {
    config: ReplicaConfig,
    sequence: i64,
    hash: String,
    signature: String,
}
impl PreparedSignature {
    pub fn prepare(
        root: &std::path::Path,
        config: &ReplicaConfig,
        key: &SigningKey,
    ) -> Result<Option<Self>, ReadError> {
        let reader = publication::read_snapshot(root, config)?;
        journal::member(&reader.connection, &config.origin, false)?;
        if hex(&key.verifying_key().to_bytes()) != config.public_key {
            return Err(error(
                "SYNC_KEY",
                "Signing key does not belong to this replica",
            ));
        }
        let row = reader.connection.query_row("SELECT sequence,content,content_hash FROM sync_batches WHERE replica_id=?1 AND local=1 AND signature IS NULL ORDER BY sequence LIMIT 1", [&config.origin.replica_id], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,String>(2)?))).optional()?;
        row.map(|(sequence, content, hash)| {
            if content.len() > MAX_BATCH_BYTES || digest(&content) != hash {
                return Err(error("SYNC_SIGNATURE", "Local journal content is damaged"));
            }
            let signed = SignedContent::sign(content, "batch", key);
            Ok(Self {
                config: config.clone(),
                sequence,
                hash,
                signature: signed.signature,
            })
        })
        .transpose()
    }
    pub fn commit(self, store: &mut ProductStore) -> Result<(), ReadError> {
        publication::check_config(store, &self.config)?;
        journal::member(&store.connection, &self.config.origin, false)?;
        store.connection.execute("UPDATE sync_batches SET signature=?4 WHERE replica_id=?1 AND sequence=?2 AND content_hash=?3 AND local=1 AND signature IS NULL", params![self.config.origin.replica_id,self.sequence,self.hash,self.signature])?;
        Ok(())
    }
}
