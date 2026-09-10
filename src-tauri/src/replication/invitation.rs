//! A connection string permits a request for approval, never document access.
//! Only a nonce hash and the signed candidate identity are persisted locally.
use std::{collections::BTreeSet, net::SocketAddr};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{
    ReplicaMember, ReplicationEngine,
    authorization::{self, AuthorityAction},
    identity, journal,
    protocol::*,
};
use crate::{credentials::Credentials, document_model::ReadError};

pub const INVITATION_LIFETIME_SECONDS: i64 = 600;
pub const MAX_CONNECTION_INFO_BYTES: usize = 16 * 1024;
const PREFIX: &str = "memoka-sync:";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub version: u32,
    pub invitation_id: String,
    pub workspace_id: String,
    pub group_id: String,
    pub genesis: String,
    pub inviter: Origin,
    pub public_key: String,
    pub addresses: Vec<SocketAddr>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinRequest {
    pub version: u32,
    pub invitation_id: String,
    pub invitation_digest: String,
    pub member: ReplicaMember,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinClaim {
    pub token: String,
    pub request: SignedContent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingDevice {
    pub invitation_id: String,
    pub member: ReplicaMember,
    pub fingerprint: String,
    pub expires_at: i64,
    pub approved: bool,
}

pub fn validate_addresses(addresses: &[SocketAddr]) -> Result<(), ReadError> {
    if addresses.is_empty()
        || addresses.len() > 16
        || addresses.iter().collect::<BTreeSet<_>>().len() != addresses.len()
        || addresses.iter().any(|address| {
            address.port() == 0
                || address.ip().is_unspecified()
                || address.ip().is_multicast()
                || matches!(address.ip(), std::net::IpAddr::V4(ip) if ip.is_broadcast())
        })
    {
        return Err(error(
            "SYNC_ADDRESS",
            "Specify one to sixteen distinct unicast IP addresses with ports",
        ));
    }
    Ok(())
}

pub fn parse(connection_info: &str, now: i64) -> Result<(Invitation, SignedContent), ReadError> {
    if connection_info.len() > MAX_CONNECTION_INFO_BYTES {
        return Err(error(
            "SYNC_LIMIT",
            "Connection information exceeds its limit",
        ));
    }
    let encoded = connection_info
        .trim()
        .strip_prefix(PREFIX)
        .ok_or_else(|| error("SYNC_INVITE", "Invalid connection information"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| error("SYNC_INVITE", "Invalid connection information encoding"))?;
    let signed: SignedContent = decode(&bytes, MAX_CONNECTION_INFO_BYTES)?;
    let invitation: Invitation = decode(&signed.content, MAX_CONNECTION_INFO_BYTES)?;
    invitation.validate(now)?;
    signed.verify(
        "invitation",
        &invitation.public_key,
        MAX_CONNECTION_INFO_BYTES,
    )?;
    Ok((invitation, signed))
}

impl Invitation {
    fn validate(&self, now: i64) -> Result<(), ReadError> {
        if self.version != PROTOCOL_VERSION {
            return Err(error("SYNC_SCHEMA", "Unsupported invitation version"));
        }
        for value in [
            &self.invitation_id,
            &self.workspace_id,
            &self.group_id,
            &self.inviter.device_id,
            &self.inviter.replica_id,
        ] {
            id(value)?;
        }
        for value in [&self.genesis, &self.public_key, &self.token] {
            unhex::<32>(value)?;
        }
        validate_addresses(&self.addresses)?;
        if self.issued_at < 0
            || self.expires_at.checked_sub(self.issued_at) != Some(INVITATION_LIFETIME_SECONDS)
            || self.issued_at > now.saturating_add(120)
            || self.expires_at <= now
        {
            return Err(error(
                "SYNC_INVITE_EXPIRED",
                "Invitation expired or the device clocks do not agree",
            ));
        }
        Ok(())
    }
}

pub fn claim(
    invitation: &Invitation,
    signed: &SignedContent,
    member: ReplicaMember,
    key: &SigningKey,
) -> Result<JoinClaim, ReadError> {
    authorization::validate_member(&member)?;
    if hex(&key.verifying_key().to_bytes()) != member.public_key
        || signed.content != serde_json::to_vec(invitation)?
    {
        return Err(error(
            "SYNC_KEY",
            "Join identity or invitation does not match",
        ));
    }
    let request = JoinRequest {
        version: PROTOCOL_VERSION,
        invitation_id: invitation.invitation_id.clone(),
        invitation_digest: digest(&signed.content),
        member,
    };
    Ok(JoinClaim {
        token: invitation.token.clone(),
        request: SignedContent::sign(serde_json::to_vec(&request)?, "join", key),
    })
}

impl ReplicationEngine<'_> {
    pub(crate) fn create_invitation(
        &mut self,
        addresses: Vec<SocketAddr>,
        credentials: &dyn Credentials,
        now: i64,
    ) -> Result<String, ReadError> {
        validate_addresses(&addresses)?;
        let config = journal::required_config(&self.store.connection)?;
        let member = journal::member(&self.store.connection, &config.origin, false)?;
        if config.paused {
            return Err(error(
                "SYNC_PAUSED",
                "Resume synchronization before inviting a device",
            ));
        }
        let graph = self.authority()?;
        let key = identity::load(credentials, &config.group_id, &member)?;
        let mut nonce = [0; 32];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let invitation = Invitation {
            version: PROTOCOL_VERSION,
            invitation_id: uuid::Uuid::now_v7().to_string(),
            workspace_id: config.workspace_id,
            group_id: config.group_id,
            genesis: graph.genesis,
            inviter: config.origin,
            public_key: config.public_key,
            addresses,
            issued_at: now,
            expires_at: now
                .checked_add(INVITATION_LIFETIME_SECONDS)
                .ok_or_else(|| error("SYNC_INVITE", "Invalid invitation time"))?,
            token: hex(&nonce),
        };
        invitation.validate(now)?;
        let signed = SignedContent::sign(serde_json::to_vec(&invitation)?, "invitation", &key);
        let info = format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&signed)?)
        );
        if info.len() > MAX_CONNECTION_INFO_BYTES {
            return Err(error(
                "SYNC_LIMIT",
                "Connection information exceeds its limit",
            ));
        }
        let tx = self.store.connection.transaction()?;
        tx.execute(
            "DELETE FROM sync_invitations WHERE expires_at<=?1 AND state<>'approved'",
            [now],
        )?;
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sync_invitations WHERE state IN ('open','claimed')",
            [],
            |r| r.get(0),
        )?;
        if pending >= 16 {
            return Err(error("SYNC_LIMIT", "Too many pending invitations"));
        }
        tx.execute("INSERT INTO sync_invitations(invitation_id,token_hash,invitation_digest,expires_at,state) VALUES(?1,?2,?3,?4,'open')",
            params![invitation.invitation_id, digest(&nonce), digest(&signed.content), invitation.expires_at])?;
        tx.commit()?;
        Ok(info)
    }

    /// The transport's authenticated public key must be the candidate's key.
    /// A first claim consumes the invitation; identical retries remain possible.
    pub fn claim_invitation(
        &mut self,
        claim: &JoinClaim,
        remote_public_key: &str,
        now: i64,
    ) -> Result<PendingDevice, ReadError> {
        let config = journal::required_config(&self.store.connection)?;
        journal::member(&self.store.connection, &config.origin, false)?;
        if config.paused {
            return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
        }
        let request: JoinRequest = decode(&claim.request.content, MAX_CONNECTION_INFO_BYTES)?;
        id(&request.invitation_id)?;
        unhex::<32>(&request.invitation_digest)?;
        authorization::validate_member(&request.member)?;
        if request.version != PROTOCOL_VERSION || request.member.public_key != remote_public_key {
            return Err(error(
                "SYNC_KEY",
                "Join request does not match the connected device",
            ));
        }
        claim
            .request
            .verify("join", remote_public_key, MAX_CONNECTION_INFO_BYTES)?;
        let token = unhex::<32>(&claim.token)?;
        let tx = self.store.connection.transaction()?;
        let row: Option<(String,String,i64,String,Option<Vec<u8>>)> = tx.query_row(
            "SELECT token_hash,invitation_digest,expires_at,state,claim_content FROM sync_invitations WHERE invitation_id=?1", [&request.invitation_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let (token_hash, invitation_digest, expires_at, state, existing) =
            row.ok_or_else(|| error("SYNC_INVITE", "Invitation does not exist"))?;
        if token_hash != digest(&token) || invitation_digest != request.invitation_digest {
            return Err(error("SYNC_INVITE", "Invitation secret does not match"));
        }
        if state == "rejected"
            || existing
                .as_ref()
                .is_some_and(|value| value != &claim.request.content)
        {
            return Err(error(
                "SYNC_INVITE_USED",
                "Invitation was already used by another request",
            ));
        }
        if state == "approved" {
            journal::member(&tx, &request.member.origin, false)?;
        } else if expires_at <= now {
            return Err(error("SYNC_INVITE_EXPIRED", "Invitation expired"));
        }
        tx.execute("UPDATE sync_invitations SET state=CASE WHEN state='open' THEN 'claimed' ELSE state END,claim_content=?2,claim_signature=?3 WHERE invitation_id=?1",
            params![request.invitation_id, claim.request.content, claim.request.signature])?;
        tx.commit()?;
        Ok(PendingDevice {
            invitation_id: request.invitation_id,
            fingerprint: identity::fingerprint(&request.member.public_key)?,
            member: request.member,
            expires_at,
            approved: state == "approved",
        })
    }

    pub fn pending_devices(&self, now: i64) -> Result<Vec<PendingDevice>, ReadError> {
        if self.configuration()?.is_none() {
            return Ok(vec![]);
        }
        let rows = self.store.connection.prepare("SELECT invitation_id,claim_content,expires_at FROM sync_invitations WHERE state='claimed' AND expires_at>?1 ORDER BY expires_at")?
            .query_map([now], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?,r.get::<_,i64>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        rows.into_iter()
            .map(|(invitation_id, content, expires_at)| {
                let request: JoinRequest = decode(&content, MAX_CONNECTION_INFO_BYTES)?;
                Ok(PendingDevice {
                    invitation_id,
                    fingerprint: identity::fingerprint(&request.member.public_key)?,
                    member: request.member,
                    expires_at,
                    approved: false,
                })
            })
            .collect()
    }

    /// expected_public_key binds the button to the identity the user reviewed.
    pub(crate) fn approve_invitation(
        &mut self,
        invitation: &str,
        expected_public_key: &str,
        credentials: &dyn Credentials,
        now: i64,
    ) -> Result<ReplicaMember, ReadError> {
        id(invitation)?;
        let config = journal::required_config(&self.store.connection)?;
        let local = journal::member(&self.store.connection, &config.origin, false)?;
        let key = identity::load(credentials, &config.group_id, &local)?;
        let (content, state, expires_at): (Vec<u8>,String,i64) = self.store.connection.query_row(
            "SELECT claim_content,state,expires_at FROM sync_invitations WHERE invitation_id=?1 AND claim_content IS NOT NULL", [invitation],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?
            .ok_or_else(|| error("SYNC_INVITE", "No device is waiting for approval"))?;
        let request: JoinRequest = decode(&content, MAX_CONNECTION_INFO_BYTES)?;
        if request.member.public_key != expected_public_key {
            return Err(error(
                "SYNC_KEY",
                "Pending device differs from the reviewed key",
            ));
        }
        if state == "approved" {
            return journal::member(&self.store.connection, &request.member.origin, false);
        }
        if state != "claimed" || expires_at <= now {
            return Err(error(
                "SYNC_INVITE_EXPIRED",
                "Invitation is no longer awaiting approval",
            ));
        }
        let graph = self.authority()?;
        let signed = graph.append(
            &config,
            AuthorityAction::Grant {
                member: request.member.clone(),
            },
            &key,
        )?;
        let mut records = graph.records();
        records.push(signed);
        let graph = authorization::AuthorityGraph::verify(&graph.genesis, &config, &records)?;
        let tx = self.store.connection.transaction()?;
        authorization::persist(&tx, &graph)?;
        tx.execute(
            "UPDATE sync_invitations SET state='approved' WHERE invitation_id=?1",
            [invitation],
        )?;
        tx.commit()?;
        Ok(request.member)
    }

    pub fn reject_invitation(&mut self, invitation: &str) -> Result<(), ReadError> {
        id(invitation)?;
        self.store.connection.execute("UPDATE sync_invitations SET state='rejected' WHERE invitation_id=?1 AND state IN ('open','claimed')", [invitation])?;
        Ok(())
    }

    pub fn update_addresses(
        &mut self,
        device_id: &str,
        expected_public_key: &str,
        addresses: &[SocketAddr],
    ) -> Result<(), ReadError> {
        id(device_id)?;
        validate_addresses(addresses)?;
        let member = self
            .registered_devices()?
            .into_iter()
            .find(|member| member.origin.device_id == device_id)
            .ok_or_else(|| error("SYNC_UNREGISTERED", "Device is not registered"))?;
        if member.revoked {
            return Err(error("SYNC_REVOKED", "Device was revoked"));
        }
        if member.public_key != expected_public_key {
            return Err(error(
                "SYNC_KEY",
                "Address update does not match the registered public key",
            ));
        }
        self.store.connection.execute("INSERT INTO sync_peer_addresses(device_id,public_key,addresses) VALUES(?1,?2,?3) ON CONFLICT(device_id) DO UPDATE SET addresses=excluded.addresses",
            params![device_id, expected_public_key, serde_json::to_string(addresses)?])?;
        Ok(())
    }
}
