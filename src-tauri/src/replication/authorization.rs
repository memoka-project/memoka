//! A signed causal authorization graph, independent of document revisions.
//! Revocation is permanent. It preserves grants in its causal past, while an
//! unobserved concurrent grant requires a fresh approval from an active device.
use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::SigningKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{ReplicaConfig, ReplicaMember, ReplicationEngine, journal, protocol::*};
use crate::document_model::ReadError;

pub const MAX_AUTH_RECORDS: usize = 4096;
pub const MAX_AUTH_RECORD_BYTES: usize = 32 * 1024;
pub const MAX_AUTH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AuthorityAction {
    Genesis { member: ReplicaMember },
    Grant { member: ReplicaMember },
    Revoke { device_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityRecord {
    pub version: u32,
    pub group_id: String,
    pub workspace_id: String,
    pub issuer: Origin,
    pub counter: i64,
    /// Sorted hashes of all known graph heads, not wall-clock timestamps.
    pub parents: Vec<String>,
    pub action: AuthorityAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerHello {
    pub version: u32,
    pub group_id: String,
    pub workspace_id: String,
    pub origin: Origin,
    pub genesis: String,
    pub records: Vec<SignedContent>,
}

#[derive(Clone)]
struct VerifiedRecord {
    index: usize,
    value: AuthorityRecord,
    signed: SignedContent,
    ancestors: Ancestors,
}

/// A bounded bitset avoids allocating a quadratic number of hash strings.
#[derive(Clone, Default)]
struct Ancestors(Vec<u64>);
impl Ancestors {
    fn insert(&mut self, index: usize) {
        self.0.resize(self.0.len().max(index / 64 + 1), 0);
        self.0[index / 64] |= 1 << (index % 64);
    }
    fn contains(&self, index: usize) -> bool {
        self.0
            .get(index / 64)
            .is_some_and(|word| word & (1 << (index % 64)) != 0)
    }
    fn extend(&mut self, other: &Self) {
        self.0.resize(self.0.len().max(other.0.len()), 0);
        for (index, word) in other.0.iter().enumerate() {
            self.0[index] |= word;
        }
    }
}

pub struct AuthorityGraph {
    pub genesis: String,
    records: BTreeMap<String, VerifiedRecord>,
    pub members: BTreeMap<String, ReplicaMember>,
    pub heads: BTreeSet<String>,
}

pub(super) fn validate_member(value: &ReplicaMember) -> Result<(), ReadError> {
    id(&value.origin.device_id)?;
    id(&value.origin.replica_id)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&unhex::<32>(&value.public_key)?)
        .map_err(|_| error("SYNC_KEY", "Invalid device public key"))?;
    if key.is_weak()
        || value.revoked
        || value.name.trim().is_empty()
        || value.name.len() > 256
        || value.name.chars().any(char::is_control)
    {
        return Err(error(
            "SYNC_MEMBERS",
            "Invalid registration identity or name",
        ));
    }
    Ok(())
}

impl AuthorityGraph {
    pub fn verify(
        genesis: &str,
        config: &ReplicaConfig,
        signed: &[SignedContent],
    ) -> Result<Self, ReadError> {
        unhex::<32>(genesis)?;
        if signed.is_empty()
            || signed.len() > MAX_AUTH_RECORDS
            || signed.iter().map(|r| r.content.len()).sum::<usize>() > MAX_AUTH_BYTES
        {
            return Err(error(
                "SYNC_LIMIT",
                "Authorization history exceeds its limit",
            ));
        }
        let mut pending = BTreeMap::new();
        for signed in signed {
            let value: AuthorityRecord = decode(&signed.content, MAX_AUTH_RECORD_BYTES)?;
            if value.version != PROTOCOL_VERSION
                || value.group_id != config.group_id
                || value.workspace_id != config.workspace_id
            {
                return Err(error(
                    "SYNC_GROUP",
                    "Authorization belongs to another group or schema",
                ));
            }
            id(&value.group_id)?;
            id(&value.workspace_id)?;
            id(&value.issuer.device_id)?;
            id(&value.issuer.replica_id)?;
            if value.counter < 1
                || value.counter > MAX_COUNTER
                || value.parents.len() > MAX_MEMBERS
                || value.parents.windows(2).any(|pair| pair[0] >= pair[1])
            {
                return Err(error("SYNC_AUTH", "Invalid authorization clock or parents"));
            }
            for parent in &value.parents {
                unhex::<32>(parent)?;
            }
            let hash = digest(&signed.content);
            if let Some((_, prior)) = pending.insert(hash, (value, signed.clone()))
                && prior != *signed
            {
                return Err(error("SYNC_AUTH", "Conflicting authorization signatures"));
            }
        }
        if !pending.contains_key(genesis) {
            return Err(error(
                "SYNC_AUTH_DEPENDENCY",
                "Pinned group genesis is missing",
            ));
        }
        let mut records: BTreeMap<String, VerifiedRecord> = BTreeMap::new();
        let mut grants: BTreeMap<String, (String, ReplicaMember)> = BTreeMap::new();
        let mut replicas = BTreeSet::new();
        let mut keys = BTreeSet::new();
        while !pending.is_empty() {
            let ready = pending
                .iter()
                .find(|(_, (v, _))| v.parents.iter().all(|parent| records.contains_key(parent)))
                .map(|(hash, _)| hash.clone())
                .ok_or_else(|| {
                    error(
                        "SYNC_AUTH_DEPENDENCY",
                        "Authorization dependency is missing or cyclic",
                    )
                })?;
            let (value, signed) = pending.remove(&ready).unwrap();
            let mut ancestors = Ancestors::default();
            let mut counter = 1;
            for parent in &value.parents {
                let prior = &records[parent];
                counter = counter.max(prior.value.counter + 1);
                ancestors.insert(prior.index);
                ancestors.extend(&prior.ancestors);
            }
            if value.counter != counter {
                return Err(error(
                    "SYNC_AUTH",
                    "Authorization clock does not match its causal parents",
                ));
            }
            let member = match &value.action {
                AuthorityAction::Genesis { member } => {
                    if ready != genesis
                        || !value.parents.is_empty()
                        || member.origin != value.issuer
                    {
                        return Err(error("SYNC_AUTH", "Unexpected group genesis"));
                    }
                    member
                }
                _ => {
                    let (grant, member) = grants.get(&value.issuer.device_id).ok_or_else(|| {
                        error(
                            "SYNC_UNREGISTERED",
                            "Authorization issuer has no registration",
                        )
                    })?;
                    if member.origin != value.issuer || !ancestors.contains(records[grant].index) {
                        return Err(error(
                            "SYNC_AUTH",
                            "Authorization omits the issuer's registration",
                        ));
                    }
                    if records.values().any(|record| ancestors.contains(record.index) && matches!(&record.value.action,
                        AuthorityAction::Revoke { device_id } if device_id == &value.issuer.device_id))
                    {
                        return Err(error("SYNC_REVOKED", "Authorization was issued after observing revocation"));
                    }
                    member
                }
            };
            signed.verify("authority", &member.public_key, MAX_AUTH_RECORD_BYTES)?;
            match &value.action {
                AuthorityAction::Genesis { member } | AuthorityAction::Grant { member } => {
                    validate_member(member)?;
                    if grants.contains_key(&member.origin.device_id)
                        || !replicas.insert(member.origin.replica_id.clone())
                        || !keys.insert(member.public_key.clone())
                    {
                        return Err(error(
                            "SYNC_KEY_REUSE",
                            "A device identity or key was already registered",
                        ));
                    }
                    grants.insert(
                        member.origin.device_id.clone(),
                        (ready.clone(), member.clone()),
                    );
                    if grants.len() > MAX_MEMBERS {
                        return Err(error("SYNC_LIMIT", "Group registration limit reached"));
                    }
                }
                AuthorityAction::Revoke { device_id } => {
                    let (grant, _) = grants.get(device_id).ok_or_else(|| {
                        error("SYNC_UNREGISTERED", "Revocation target has no registration")
                    })?;
                    if !ancestors.contains(records[grant].index) {
                        return Err(error(
                            "SYNC_AUTH",
                            "Revocation omits the target's registration",
                        ));
                    }
                }
            }
            records.insert(
                ready,
                VerifiedRecord {
                    index: records.len(),
                    value,
                    signed,
                    ancestors,
                },
            );
        }

        // Never revive an identity. Remove grants outside a revoking device's
        // observed history, including their unestablished descendant grants.
        // Established descendants remain authorized when their issuer is removed.
        let mut eligible: BTreeSet<_> = grants.keys().cloned().collect();
        loop {
            let remove: Vec<_> = grants.iter().filter_map(|(device, (hash, _))| {
                if hash == genesis || !eligible.contains(device) { return None; }
                let grant = &records[hash];
                let issuer = &grant.value.issuer.device_id;
                let excluded = !eligible.contains(issuer) || records.values().any(|record|
                    matches!(&record.value.action, AuthorityAction::Revoke { device_id } if device_id == issuer)
                    && !record.ancestors.contains(grant.index));
                excluded.then(|| device.clone())
            }).collect();
            if remove.is_empty() {
                break;
            }
            for device in remove {
                eligible.remove(&device);
            }
        }
        let mut members = BTreeMap::new();
        for (device, (_, mut member)) in grants {
            // Excluded registrations keep their identities reserved forever.
            member.revoked = !eligible.contains(&device) || records.values().any(|record|
                matches!(&record.value.action, AuthorityAction::Revoke { device_id } if device_id == &device));
            members.insert(device, member);
        }
        let parents: BTreeSet<_> = records
            .values()
            .flat_map(|r| r.value.parents.iter().cloned())
            .collect();
        let heads = records
            .keys()
            .filter(|hash| !parents.contains(*hash))
            .cloned()
            .collect();
        Ok(Self {
            genesis: genesis.into(),
            records,
            members,
            heads,
        })
    }

    pub fn records(&self) -> Vec<SignedContent> {
        self.records
            .values()
            .map(|record| record.signed.clone())
            .collect()
    }

    pub fn append(
        &self,
        config: &ReplicaConfig,
        action: AuthorityAction,
        key: &SigningKey,
    ) -> Result<SignedContent, ReadError> {
        let member = self
            .members
            .get(&config.origin.device_id)
            .ok_or_else(|| error("SYNC_UNREGISTERED", "This device is not registered"))?;
        if member.revoked {
            return Err(error("SYNC_REVOKED", "This device was revoked"));
        }
        if member.origin != config.origin
            || member.public_key != hex(&key.verifying_key().to_bytes())
        {
            return Err(error("SYNC_KEY", "Signing key does not match this device"));
        }
        if matches!(action, AuthorityAction::Genesis { .. }) {
            return Err(error("SYNC_AUTH", "Group genesis is immutable"));
        }
        let value = AuthorityRecord {
            version: PROTOCOL_VERSION,
            group_id: config.group_id.clone(),
            workspace_id: config.workspace_id.clone(),
            issuer: config.origin.clone(),
            counter: self
                .records
                .values()
                .map(|r| r.value.counter)
                .max()
                .unwrap_or(0)
                + 1,
            parents: self.heads.iter().cloned().collect(),
            action,
        };
        let signed = SignedContent::sign(serde_json::to_vec(&value)?, "authority", key);
        let mut all = self.records();
        all.push(signed.clone());
        Self::verify(&self.genesis, config, &all)?;
        Ok(signed)
    }
}

pub fn genesis(
    config: &ReplicaConfig,
    member: &ReplicaMember,
    key: &SigningKey,
) -> Result<SignedContent, ReadError> {
    let value = AuthorityRecord {
        version: PROTOCOL_VERSION,
        group_id: config.group_id.clone(),
        workspace_id: config.workspace_id.clone(),
        issuer: config.origin.clone(),
        counter: 1,
        parents: vec![],
        action: AuthorityAction::Genesis {
            member: member.clone(),
        },
    };
    let signed = SignedContent::sign(serde_json::to_vec(&value)?, "authority", key);
    AuthorityGraph::verify(
        &digest(&signed.content),
        config,
        std::slice::from_ref(&signed),
    )?;
    Ok(signed)
}

pub(super) fn persist(connection: &Connection, graph: &AuthorityGraph) -> Result<(), ReadError> {
    for (hash, record) in &graph.records {
        connection.execute("INSERT OR IGNORE INTO sync_authorizations(record_hash,content,signature) VALUES(?1,?2,?3)",
            params![hash, record.signed.content, record.signed.signature])?;
    }
    for member in graph.members.values() {
        connection.execute("INSERT INTO sync_members(replica_id,device_id,public_key,name,revoked) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(replica_id) DO UPDATE SET revoked=MAX(revoked,excluded.revoked)",
            params![member.origin.replica_id, member.origin.device_id, member.public_key, member.name, member.revoked])?;
    }
    connection.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_genesis',?1)",
        [&graph.genesis],
    )?;
    Ok(())
}

impl ReplicationEngine<'_> {
    pub fn hello(&self) -> Result<PeerHello, ReadError> {
        let config = journal::required_config(&self.store.connection)?;
        journal::member(&self.store.connection, &config.origin, false)?;
        let graph = self.authority()?;
        Ok(PeerHello {
            version: PROTOCOL_VERSION,
            group_id: config.group_id,
            workspace_id: config.workspace_id,
            origin: config.origin,
            genesis: graph.genesis.clone(),
            records: graph.records(),
        })
    }

    /// A newly registered C may first contact A with B's signed registration.
    /// The locally pinned genesis, never the caller's asserted Workspace ID,
    /// authenticates that chain before granting access to any documents.
    pub fn authenticate_peer(
        &mut self,
        remote_public_key: &str,
        hello: &PeerHello,
    ) -> Result<ReplicaMember, ReadError> {
        let config = journal::required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        if hello.version != PROTOCOL_VERSION
            || hello.group_id != config.group_id
            || hello.workspace_id != config.workspace_id
        {
            return Err(error(
                "SYNC_GROUP",
                "Connected replica belongs to another group or schema",
            ));
        }
        if hello.records.len() > MAX_AUTH_RECORDS
            || hello.records.iter().map(|r| r.content.len()).sum::<usize>() > MAX_AUTH_BYTES
        {
            return Err(error("SYNC_LIMIT", "Authorization proof exceeds its limit"));
        }
        let local = self.authority()?;
        if local.genesis != hello.genesis {
            return Err(error(
                "SYNC_GROUP",
                "Authorization genesis does not match this group",
            ));
        }
        let mut records = local.records();
        records.extend(
            hello
                .records
                .iter()
                .filter(|r| !local.records.contains_key(&digest(&r.content)))
                .cloned(),
        );
        let graph = AuthorityGraph::verify(&local.genesis, &config, &records)?;
        let peer = graph.members.get(&hello.origin.device_id).ok_or_else(|| {
            error(
                "SYNC_UNREGISTERED",
                "Connected device has no valid registration",
            )
        })?;
        if peer.public_key != remote_public_key || peer.origin != hello.origin {
            return Err(error(
                "SYNC_KEY",
                "Authorization proof differs from the connected key",
            ));
        }
        if peer.revoked {
            return Err(error("SYNC_REVOKED", "Connected device was revoked"));
        }
        let peer = peer.clone();
        let tx = self.store.connection.transaction()?;
        persist(&tx, &graph)?;
        tx.commit()?;
        // Retain a legitimate revocation of ourselves, then stop serving data.
        journal::member(&self.store.connection, &config.origin, false)?;
        Ok(peer)
    }

    pub fn authority(&self) -> Result<AuthorityGraph, ReadError> {
        let config = journal::required_config(&self.store.connection)?;
        let genesis: String = self
            .store
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key='replication_genesis'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| error("SYNC_AUTH", "Group has no pinned authorization genesis"))?;
        let records = self
            .store
            .connection
            .prepare("SELECT content,signature FROM sync_authorizations ORDER BY record_hash")?
            .query_map([], |r| {
                Ok(SignedContent {
                    content: r.get(0)?,
                    signature: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        AuthorityGraph::verify(&genesis, &config, &records)
    }

    /// Called only on an authenticated connection from a currently registered
    /// device. Original signatures survive forwarding through another device.
    pub fn receive_authorizations(
        &mut self,
        peer: &Origin,
        incoming: &[SignedContent],
    ) -> Result<(), ReadError> {
        journal::member(&self.store.connection, peer, false)?;
        let config = journal::required_config(&self.store.connection)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let graph = self.authority()?;
        let mut combined = graph.records();
        combined.extend(
            incoming
                .iter()
                .filter(|record| !graph.records.contains_key(&digest(&record.content)))
                .cloned(),
        );
        let graph = AuthorityGraph::verify(&graph.genesis, &config, &combined)?;
        let tx = self.store.connection.transaction()?;
        persist(&tx, &graph)?;
        tx.commit()?;
        Ok(())
    }

    pub fn authorize(
        &mut self,
        action: AuthorityAction,
        key: &SigningKey,
    ) -> Result<SignedContent, ReadError> {
        let config = journal::required_config(&self.store.connection)?;
        let graph = self.authority()?;
        let signed = graph.append(&config, action, key)?;
        let mut records = graph.records();
        records.push(signed.clone());
        let graph = AuthorityGraph::verify(&graph.genesis, &config, &records)?;
        let tx = self.store.connection.transaction()?;
        persist(&tx, &graph)?;
        tx.commit()?;
        Ok(signed)
    }
}
