use ed25519_dalek::SigningKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::protocol::*;
use crate::{
    document_model::ReadError,
    persistence::{PersistenceCommitRequest, ProductStore},
};

pub(super) const MAX_INBOX_BYTES: usize = 1024 * 1024 * 1024;
pub(super) const MAX_PENDING_BATCHES: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaConfig {
    pub workspace_id: String,
    pub group_id: String,
    pub origin: Origin,
    pub public_key: String,
    pub paused: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaMember {
    pub origin: Origin,
    pub public_key: String,
    pub name: String,
    pub revoked: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub paused: bool,
    pub frontier: ReplicaFrontier,
    pub pending_apply_count: i64,
    pub pending_apply_bytes: i64,
    pub pending_signature_count: i64,
    pub pending_attachment_count: i64,
    pub pending_attachment_bytes: i64,
    pub quarantined_count: i64,
    pub last_applied_at: Option<String>,
}

/// Constructed only with the existing owner store, never a second SQLite writer.
pub struct ReplicationEngine<'a> {
    pub(crate) store: &'a mut ProductStore,
}

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), ReadError> {
    connection.execute_batch("
        CREATE TABLE IF NOT EXISTS sync_members (
            replica_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS sync_authorizations (
            record_hash TEXT PRIMARY KEY, content BLOB NOT NULL, signature TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_invitations (
            invitation_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, invitation_digest TEXT NOT NULL,
            expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','claimed','approved','rejected')),
            claim_content BLOB, claim_signature TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_peer_addresses (
            device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, addresses TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_local_documents (document_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS sync_frontiers (
            replica_id TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sync_batches (
            replica_id TEXT NOT NULL, sequence INTEGER NOT NULL, device_id TEXT NOT NULL,
            dependencies TEXT NOT NULL, content BLOB NOT NULL, content_hash TEXT NOT NULL,
            signature TEXT, local INTEGER NOT NULL CHECK(local IN (0,1)),
            received_at TEXT NOT NULL, applied_at TEXT, error TEXT, result TEXT,
            PRIMARY KEY(replica_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS sync_ready ON sync_batches(applied_at,error,received_at);
        CREATE TABLE IF NOT EXISTS sync_receipts (
            replica_id TEXT NOT NULL, sequence INTEGER NOT NULL, content_hash TEXT NOT NULL,
            result TEXT,
            PRIMARY KEY(replica_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS sync_checkpoints (
            checkpoint_id TEXT PRIMARY KEY, content BLOB NOT NULL, signature TEXT NOT NULL,
            created_at TEXT NOT NULL, included TEXT NOT NULL, issuer_device_id TEXT, issuer_replica_id TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_checkpoint_inbox (
            checkpoint_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, content BLOB,
            signature TEXT NOT NULL, received_at TEXT NOT NULL, applied_at TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_peer_frontiers (
            peer_id TEXT PRIMARY KEY, received TEXT NOT NULL, applied TEXT NOT NULL, updated_at TEXT NOT NULL, last_applied_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_quarantine (
            content_hash TEXT PRIMARY KEY, reason TEXT NOT NULL, received_at TEXT NOT NULL, bytes INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_attachment_transfers (
            sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
            complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)), error TEXT,
            active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
        );
    ")?;
    for (table, column, definition) in [
        ("sync_checkpoints", "issuer_device_id", "TEXT"),
        ("sync_checkpoints", "issuer_replica_id", "TEXT"),
        ("sync_batches", "result", "TEXT"),
        ("sync_receipts", "result", "TEXT"),
        (
            "sync_attachment_transfers",
            "active",
            "INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))",
        ),
        ("sync_peer_frontiers", "last_applied_at", "TEXT"),
    ] {
        let exists: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [column],
            |r| r.get(0),
        )?;
        if !exists {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    // Upgrade internal v7 checkpoints once during open, outside normal saves.
    connection.execute_batch("UPDATE sync_checkpoints SET issuer_device_id=json_extract(CAST(content AS TEXT),'$.issuer.deviceId'),issuer_replica_id=json_extract(CAST(content AS TEXT),'$.issuer.replicaId') WHERE issuer_device_id IS NULL OR issuer_replica_id IS NULL")?;
    connection.execute_batch("CREATE INDEX IF NOT EXISTS sync_attachment_active ON sync_attachment_transfers(active,complete,error)")?;
    Ok(())
}

/// Restore and a newly created group must not inherit an old authorization or
/// a delivery frontier. Shared CRDT data and structural deletion histories stay.
pub(crate) fn clear_group_state(connection: &Connection) -> Result<(), ReadError> {
    let tables = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'sync_*'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for table in tables {
        connection.execute(
            &format!("DELETE FROM \"{}\"", table.replace('"', "\"\"")),
            [],
        )?;
    }
    connection.execute("DELETE FROM settings WHERE key GLOB 'replication_*' OR key IN ('replica_id','local_replica_id')",[])?;
    Ok(())
}

pub(super) fn config(connection: &Connection) -> Result<Option<ReplicaConfig>, ReadError> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key='replication_config'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    value
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

pub(super) fn required_config(connection: &Connection) -> Result<ReplicaConfig, ReadError> {
    config(connection)?.ok_or_else(|| error("SYNC_DISABLED", "Device synchronization is disabled"))
}

pub(super) fn frontiers(connection: &Connection) -> Result<ReplicaFrontier, ReadError> {
    let rows = connection
        .prepare("SELECT replica_id, received, applied FROM sync_frontiers ORDER BY replica_id")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ReplicaFrontier {
        received: rows
            .iter()
            .filter(|row| row.1 > 0)
            .map(|row| (row.0.clone(), row.1))
            .collect(),
        applied: rows
            .into_iter()
            .filter(|row| row.2 > 0)
            .map(|row| (row.0, row.2))
            .collect(),
    })
}

pub(super) fn member(
    connection: &Connection,
    origin: &Origin,
    accept_revoked: bool,
) -> Result<ReplicaMember, ReadError> {
    let member = connection
        .query_row(
            "SELECT device_id, public_key, name, revoked FROM sync_members WHERE replica_id=?1",
            [&origin.replica_id],
            |r| {
                Ok(ReplicaMember {
                    origin: Origin {
                        replica_id: origin.replica_id.clone(),
                        device_id: r.get(0)?,
                    },
                    public_key: r.get(1)?,
                    name: r.get(2)?,
                    revoked: r.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            error(
                "SYNC_UNREGISTERED",
                "Replica is not registered in this group",
            )
        })?;
    if member.origin != *origin || (!accept_revoked && member.revoked) {
        return Err(error(
            "SYNC_REVOKED",
            "Replica identity is revoked or does not match its device",
        ));
    }
    Ok(member)
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn inbox_usage(connection: &Connection) -> Result<(i64, i64), ReadError> {
    connection.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM (SELECT length(content) AS bytes FROM sync_batches WHERE applied_at IS NULL UNION ALL SELECT length(content) AS bytes FROM sync_checkpoint_inbox WHERE applied_at IS NULL)",[],|r| Ok((r.get(0)?,r.get(1)?))).map_err(Into::into)
}

pub(super) fn advance_received(
    connection: &Connection,
    replica: &str,
    minimum: i64,
) -> Result<(), ReadError> {
    let mut received: i64 = connection.query_row(
        "SELECT COALESCE((SELECT received FROM sync_frontiers WHERE replica_id=?1),0)",
        [replica],
        |r| r.get(0),
    )?;
    received = received.max(minimum);
    while received < MAX_COUNTER
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_receipts WHERE replica_id=?1 AND sequence=?2)",
            params![replica, received + 1],
            |r| r.get::<_, bool>(0),
        )?
    {
        received += 1;
    }
    connection.execute("INSERT INTO sync_frontiers(replica_id,received,applied) VALUES(?1,?2,0) ON CONFLICT(replica_id) DO UPDATE SET received=?2",params![replica,received])?;
    Ok(())
}

/// Called inside the same SQLite transaction as the local documents. Signing
/// follows durable capture, so an unavailable credential store never loses edits.
pub(crate) fn journal_local_commit(
    connection: &Connection,
    request: &PersistenceCommitRequest,
) -> Result<(), ReadError> {
    let Some(config) = config(connection)? else {
        return Ok(());
    };
    let mut documents = Vec::new();
    // Only creation can introduce a managed Help identity. Normal typing does
    // not scan Workspace metadata or export its locally generated content.
    if request
        .documents
        .iter()
        .any(|doc| doc.kind == "note" && doc.base_revision == 0)
    {
        let workspace = crate::workspace_migration::load_document(
            connection,
            "workspace",
            &config.workspace_id,
        )?;
        let namespace = crate::namespace::read_namespace(&workspace)?;
        let ids: Vec<_> = namespace
            .notes
            .iter()
            .filter(|(_, metadata)| metadata["system_role"] == "help")
            .map(|(id, _)| id.clone())
            .collect();
        super::apply::register_local_help(connection, &ids)?;
    }
    for input in &request.documents {
        let local: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_local_documents WHERE document_id=?1)",
            [&input.document_id],
            |r| r.get(0),
        )?;
        if local {
            continue;
        }
        documents.push(DocumentUpdate {
            kind: input.kind.clone(),
            document_id: input.document_id.clone(),
            schema_version: input.schema_version,
            update: input
                .update
                .as_ref()
                .or(input.snapshot.as_ref())
                .ok_or_else(|| error("SYNC_BATCH", "Local commit has no update"))?
                .clone(),
        });
    }
    if !documents.is_empty() {
        journal_local(connection, &config, documents, vec![])?;
    }
    Ok(())
}

pub(crate) fn journal_local_attachments(
    connection: &Connection,
    attachments: Vec<AttachmentReference>,
) -> Result<(), ReadError> {
    let Some(config) = config(connection)? else {
        return Ok(());
    };
    if !attachments.is_empty() {
        journal_local(connection, &config, vec![], attachments)?;
    }
    Ok(())
}

fn journal_local(
    connection: &Connection,
    config: &ReplicaConfig,
    documents: Vec<DocumentUpdate>,
    attachments: Vec<AttachmentReference>,
) -> Result<(), ReadError> {
    let dependencies = frontiers(connection)?.applied;
    let sequence = dependencies
        .get(&config.origin.replica_id)
        .copied()
        .unwrap_or(0)
        + 1;
    let batch = ChangeBatch {
        version: PROTOCOL_VERSION,
        group_id: config.group_id.clone(),
        workspace_id: config.workspace_id.clone(),
        origin: config.origin.clone(),
        sequence,
        dependencies,
        documents,
        attachments,
    };
    batch.validate()?;
    let content = serde_json::to_vec(&batch)?;
    if content.len() > MAX_BATCH_BYTES {
        return Err(error("SYNC_LIMIT", "Local change batch exceeds its limit"));
    }
    let at = now();
    insert_batch(connection, &batch, &content, None, true, &at)?;
    connection.execute(
        "UPDATE sync_batches SET applied_at=?3 WHERE replica_id=?1 AND sequence=?2",
        params![batch.origin.replica_id, sequence, at],
    )?;
    connection.execute("INSERT INTO sync_frontiers(replica_id,received,applied) VALUES(?1,?2,?2) ON CONFLICT(replica_id) DO UPDATE SET received=?2,applied=?2", params![batch.origin.replica_id, sequence])?;
    Ok(())
}

pub(super) fn insert_batch(
    connection: &Connection,
    batch: &ChangeBatch,
    content: &[u8],
    signature: Option<&str>,
    local: bool,
    at: &str,
) -> Result<(), ReadError> {
    let hash = digest(content);
    connection.execute("INSERT INTO sync_batches(replica_id,sequence,device_id,dependencies,content,content_hash,signature,local,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![batch.origin.replica_id,batch.sequence,batch.origin.device_id,serde_json::to_string(&batch.dependencies)?,content,hash,signature,local,at])?;
    connection.execute(
        "INSERT INTO sync_receipts(replica_id,sequence,content_hash) VALUES(?1,?2,?3)",
        params![batch.origin.replica_id, batch.sequence, hash],
    )?;
    Ok(())
}

impl<'a> ReplicationEngine<'a> {
    pub fn new(store: &'a mut ProductStore) -> Self {
        Self { store }
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<(), ReadError> {
        let mut config = required_config(&self.store.connection)?;
        config.paused = paused;
        self.store.connection.execute(
            "UPDATE settings SET value=?1 WHERE key='replication_config'",
            [serde_json::to_string(&config)?],
        )?;
        Ok(())
    }

    /// Membership has already been authenticated by device management. This is
    /// an internal boundary; no transport request can install arbitrary members.
    #[cfg(test)]
    pub(crate) fn initialize(
        &mut self,
        config: &ReplicaConfig,
        members: &[ReplicaMember],
    ) -> Result<(), ReadError> {
        self.initialize_group(config, members, None)
    }

    pub(crate) fn initialize_authenticated(
        &mut self,
        config: &ReplicaConfig,
        genesis: &str,
        records: &[SignedContent],
    ) -> Result<(), ReadError> {
        let graph = super::authorization::AuthorityGraph::verify(genesis, config, records)?;
        let members: Vec<_> = graph.members.values().cloned().collect();
        self.initialize_group(config, &members, Some(&graph))
    }

    fn initialize_group(
        &mut self,
        config: &ReplicaConfig,
        members: &[ReplicaMember],
        authority: Option<&super::authorization::AuthorityGraph>,
    ) -> Result<(), ReadError> {
        if super::journal::config(&self.store.connection)?.is_some() {
            return Err(error(
                "SYNC_GROUP",
                "Workspace already belongs to a synchronization group",
            ));
        }
        for value in [
            &config.workspace_id,
            &config.group_id,
            &config.origin.device_id,
            &config.origin.replica_id,
        ] {
            id(value)?;
        }
        unhex::<32>(&config.public_key)?;
        if members.is_empty()
            || members.len() > MAX_MEMBERS
            || !members.iter().any(|member| {
                member.origin == config.origin
                    && member.public_key == config.public_key
                    && !member.revoked
            })
        {
            return Err(error("SYNC_MEMBERS", "Group does not contain this replica"));
        }
        let workspace = self
            .store
            .load_document("workspace", &config.workspace_id)?;
        let unsupported: bool = self.store.connection.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE (kind='note' AND schema_version<>7) OR (kind='workspace' AND schema_version<>4) OR kind NOT IN ('workspace','note'))", [], |r| r.get(0))?;
        if unsupported {
            return Err(error(
                "SYNC_SCHEMA",
                "Workspace migration is required before enabling synchronization",
            ));
        }
        let namespace = crate::namespace::read_namespace(&workspace)?;
        let raw = crate::document_model::workspace_json(&workspace)?;
        let transaction = self.store.connection.transaction()?;
        clear_group_state(&transaction)?;
        for member in members {
            id(&member.origin.device_id)?;
            id(&member.origin.replica_id)?;
            unhex::<32>(&member.public_key)?;
            if member.name.is_empty()
                || member.name.len() > 256
                || member.name.chars().any(char::is_control)
            {
                return Err(error("SYNC_MEMBERS", "Invalid device name"));
            }
            transaction.execute("INSERT INTO sync_members(replica_id,device_id,public_key,name,revoked) VALUES(?1,?2,?3,?4,?5)", params![member.origin.replica_id,member.origin.device_id,member.public_key,member.name,member.revoked])?;
        }
        for note_id in namespace.notes.keys() {
            if raw["notes"][note_id]["system_role"] == "help" {
                transaction.execute(
                    "INSERT INTO sync_local_documents(document_id) VALUES(?1)",
                    [note_id],
                )?;
            }
        }
        transaction.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_config',?1)",
            [serde_json::to_string(config)?],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('replica_id',?1)",
            [&config.origin.replica_id],
        )?;
        if let Some(graph) = authority {
            super::authorization::persist(&transaction, graph)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn status(&self) -> Result<SyncStatus, ReadError> {
        let config = config(&self.store.connection)?;
        if config.is_none() {
            return Ok(SyncStatus::default());
        }
        let (count, bytes): (i64, i64) = self.store.connection.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM (SELECT length(content) AS bytes FROM sync_batches WHERE applied_at IS NULL AND error IS NULL UNION ALL SELECT length(content) AS bytes FROM sync_checkpoint_inbox WHERE applied_at IS NULL AND error IS NULL)", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(SyncStatus {
            enabled: config.is_some(), paused: config.is_some_and(|value| value.paused), frontier: frontiers(&self.store.connection)?, pending_apply_count: count, pending_apply_bytes: bytes,
            pending_signature_count: self.store.connection.query_row("SELECT COUNT(*) FROM sync_batches WHERE local=1 AND signature IS NULL", [], |r| r.get(0))?,
            pending_attachment_count: self.store.connection.query_row("SELECT COUNT(*) FROM sync_attachment_transfers WHERE complete=0", [], |r| r.get(0))?,
            pending_attachment_bytes: self.store.connection.query_row("SELECT COALESCE(SUM(size-received),0) FROM sync_attachment_transfers WHERE complete=0", [], |r| r.get(0))?,
            quarantined_count: self.store.connection.query_row("SELECT (SELECT COUNT(*) FROM sync_quarantine)+(SELECT COUNT(*) FROM sync_batches WHERE error IS NOT NULL)+(SELECT COUNT(*) FROM sync_checkpoint_inbox WHERE error IS NOT NULL)+(SELECT COUNT(*) FROM sync_attachment_transfers WHERE error IS NOT NULL)", [], |r| r.get(0))?,
            last_applied_at: self.store.connection.query_row("SELECT value FROM settings WHERE key='replication_last_applied_at'", [], |r| r.get(0)).optional()?,
        })
    }

    /// One bounded signing task; callers schedule additional tasks in background.
    pub fn sign_next(&mut self, key: &SigningKey) -> Result<bool, ReadError> {
        let config = required_config(&self.store.connection)?;
        member(&self.store.connection, &config.origin, false)?;
        if hex(&key.verifying_key().to_bytes()) != config.public_key {
            return Err(error(
                "SYNC_KEY",
                "Signing key does not belong to this replica",
            ));
        }
        let row = self.store.connection.query_row("SELECT sequence, content FROM sync_batches WHERE replica_id=?1 AND local=1 AND signature IS NULL ORDER BY sequence LIMIT 1", [&config.origin.replica_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).optional()?;
        let Some((sequence, content)) = row else {
            return Ok(false);
        };
        let signed = SignedContent::sign(content, "batch", key);
        self.store.connection.execute("UPDATE sync_batches SET signature=?3 WHERE replica_id=?1 AND sequence=?2 AND signature IS NULL", params![config.origin.replica_id,sequence,signed.signature])?;
        Ok(true)
    }

    /// Durably receives a signed batch; this ACK says nothing about document
    /// application. Out-of-order receipts cannot advance a frontier past a gap.
    pub fn receive(&mut self, signed: &SignedContent) -> Result<ReplicaFrontier, ReadError> {
        let result = self.receive_verified(signed);
        if let Err(failure) = &result {
            if failure.code != "SYNC_LIMIT" && failure.code != "SYNC_PAUSED" {
                let connection = &self.store.connection;
                connection.execute("INSERT OR IGNORE INTO sync_quarantine(content_hash,reason,received_at,bytes) VALUES(?1,?2,?3,?4)", params![digest(&signed.content),failure.code,now(),signed.content.len() as i64])?;
                connection.execute("DELETE FROM sync_quarantine WHERE rowid NOT IN (SELECT rowid FROM sync_quarantine ORDER BY rowid DESC LIMIT 256)", [])?;
            }
        }
        result
    }

    fn receive_verified(&mut self, signed: &SignedContent) -> Result<ReplicaFrontier, ReadError> {
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES)?;
        batch.validate()?;
        if batch.group_id != config.group_id || batch.workspace_id != config.workspace_id {
            return Err(error(
                "SYNC_GROUP",
                "Change belongs to another synchronization group",
            ));
        }
        let member = member(&self.store.connection, &batch.origin, false)?;
        signed.verify("batch", &member.public_key, MAX_BATCH_BYTES)?;
        self.receive_validated_batch(&batch, signed, &digest(&signed.content))
    }

    pub(super) fn receive_validated_batch(
        &mut self,
        batch: &ChangeBatch,
        signed: &SignedContent,
        content_hash: &str,
    ) -> Result<ReplicaFrontier, ReadError> {
        let config = required_config(&self.store.connection)?;
        let transaction = self.store.connection.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT content_hash FROM sync_receipts WHERE replica_id=?1 AND sequence=?2",
                params![batch.origin.replica_id, batch.sequence],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(hash) = existing {
            if hash != content_hash {
                return Err(error(
                    "SYNC_EQUIVOCATION",
                    "Replica sequence was reused with different content",
                ));
            }
            return frontiers(&transaction);
        }
        let current = frontiers(&transaction)?;
        if current
            .applied
            .get(&batch.origin.replica_id)
            .copied()
            .unwrap_or(0)
            >= batch.sequence
        {
            return Ok(current);
        }
        if batch.origin == config.origin {
            return Err(error(
                "SYNC_REPLICA_REUSE",
                "Unknown changes claim this Workspace copy's replica identity",
            ));
        }
        let (count, bytes) = inbox_usage(&transaction)?;
        if count >= MAX_PENDING_BATCHES as i64
            || bytes.saturating_add(signed.content.len() as i64) > MAX_INBOX_BYTES as i64
        {
            return Err(error(
                "SYNC_LIMIT",
                "Persistent inbox is full; apply pending changes before receiving more",
            ));
        }
        insert_batch(
            &transaction,
            &batch,
            &signed.content,
            Some(&signed.signature),
            false,
            &now(),
        )?;
        advance_received(&transaction, &batch.origin.replica_id, 0)?;
        let result = frontiers(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Forward original signed content even when its author is not connected.
    /// A single oversized item may exceed the scheduling budget, never the cap.
    pub fn outgoing(
        &self,
        received: &Frontier,
        byte_budget: usize,
    ) -> Result<Vec<SignedContent>, ReadError> {
        self.outgoing_released(received, byte_budget, MAX_COUNTER)
    }

    pub(super) fn outgoing_released(
        &self,
        received: &Frontier,
        byte_budget: usize,
        local_sequence: i64,
    ) -> Result<Vec<SignedContent>, ReadError> {
        validate_frontier(received)?;
        if byte_budget == 0 || byte_budget > MAX_BATCH_BYTES {
            return Err(error("SYNC_LIMIT", "Invalid outgoing byte budget"));
        }
        let config = required_config(&self.store.connection)?;
        if config.paused {
            return Ok(vec![]);
        }
        let rows = self.store.connection.prepare("SELECT b.replica_id,b.sequence,length(b.content) FROM sync_members m LEFT JOIN json_each(?1) peer ON peer.key=m.replica_id JOIN sync_batches b ON b.replica_id=m.replica_id AND b.sequence>COALESCE(CAST(peer.value AS INTEGER),0) WHERE m.revoked=0 AND b.signature IS NOT NULL AND b.error IS NULL AND (b.replica_id<>?2 OR b.sequence<=?3) ORDER BY b.sequence,b.replica_id LIMIT 64")?
            .query_map(params![serde_json::to_string(received)?,config.origin.replica_id,local_sequence], |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?,read_size(r,2)? as usize)))?.collect::<Result<Vec<_>,_>>()?;
        let mut result = Vec::new();
        let mut used = 0;
        for (replica, sequence, size) in rows {
            if sequence <= received.get(&replica).copied().unwrap_or(0) {
                continue;
            }
            if !result.is_empty() && used + size > byte_budget {
                break;
            }
            result.push(self.store.connection.query_row(
                "SELECT content,signature FROM sync_batches WHERE replica_id=?1 AND sequence=?2",
                params![replica, sequence],
                |r| {
                    Ok(SignedContent {
                        content: r.get(0)?,
                        signature: r.get(1)?,
                    })
                },
            )?);
            used += size;
            if used >= byte_budget || result.len() >= 64 {
                break;
            }
        }
        Ok(result)
    }

    pub fn acknowledge(
        &mut self,
        peer_id: &str,
        frontier: &ReplicaFrontier,
    ) -> Result<(), ReadError> {
        id(peer_id)?;
        validate_frontier(&frontier.received)?;
        validate_frontier(&frontier.applied)?;
        let known = frontiers(&self.store.connection)?;
        for (replica, applied) in &frontier.applied {
            if frontier.received.get(replica).copied().unwrap_or(0) < *applied {
                return Err(error(
                    "SYNC_FRONTIER",
                    "Applied acknowledgment exceeds received acknowledgment",
                ));
            }
        }
        for (replica, received) in &frontier.received {
            if known.received.get(replica).copied().unwrap_or(0) < *received {
                return Err(error("SYNC_FRONTIER", "Peer acknowledged unknown changes"));
            }
        }
        let registered: bool = self.store.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_members WHERE device_id=?1 AND revoked=0)",
            [peer_id],
            |r| r.get(0),
        )?;
        if !registered {
            return Err(error(
                "SYNC_UNREGISTERED",
                "Acknowledgment comes from an unregistered device",
            ));
        }
        let previous: Option<(String, String)> = self
            .store
            .connection
            .query_row(
                "SELECT received,applied FROM sync_peer_frontiers WHERE peer_id=?1",
                [peer_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let mut merged = frontier.clone();
        let previous_applied: Frontier = previous
            .as_ref()
            .map(|(_, applied)| serde_json::from_str(applied))
            .transpose()?
            .unwrap_or_default();
        if let Some((received, applied)) = previous {
            for (old, target) in [
                (received, &mut merged.received),
                (applied, &mut merged.applied),
            ] {
                for (replica, sequence) in serde_json::from_str::<Frontier>(&old)? {
                    let current = target.entry(replica).or_default();
                    *current = (*current).max(sequence);
                }
            }
        }
        let applied_at = (previous_applied != merged.applied).then(now);
        self.store.connection.execute("INSERT INTO sync_peer_frontiers(peer_id,received,applied,updated_at,last_applied_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(peer_id) DO UPDATE SET received=excluded.received,applied=excluded.applied,updated_at=excluded.updated_at,last_applied_at=COALESCE(excluded.last_applied_at,sync_peer_frontiers.last_applied_at)", params![peer_id,serde_json::to_string(&merged.received)?,serde_json::to_string(&merged.applied)?,now(),applied_at])?;
        Ok(())
    }
}
