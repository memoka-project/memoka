//! The authenticated content is independent of transport and delivery envelopes.
//! No peer's local SQLite revision participates in replication ordering.
use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::document_model::ReadError;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CHECKPOINT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_MEMBERS: usize = 256;
pub const MAX_COUNTER: i64 = 9_007_199_254_740_991;
pub type Frontier = BTreeMap<String, i64>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplicaFrontier {
    pub received: Frontier,
    pub applied: Frontier,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub device_id: String,
    pub replica_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentUpdate {
    pub kind: String,
    pub document_id: String,
    pub schema_version: i64,
    #[serde(with = "binary")]
    pub update: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentReference {
    pub attachment_id: String,
    pub sha256: String,
    pub size: u64,
    pub original_filename: String,
    pub mime_type: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeBatch {
    pub version: u32,
    pub group_id: String,
    pub workspace_id: String,
    pub origin: Origin,
    pub sequence: i64,
    pub dependencies: Frontier,
    pub documents: Vec<DocumentUpdate>,
    pub attachments: Vec<AttachmentReference>,
}

/// An entire, consistent checkpoint is merged as CRDT updates. Its coverage is
/// advanced only in the transaction which persists all of those merged updates.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u32,
    pub checkpoint_id: String,
    pub group_id: String,
    pub workspace_id: String,
    pub issuer: Origin,
    pub included: Frontier,
    pub documents: Vec<DocumentUpdate>,
    pub attachments: Vec<AttachmentReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedContent {
    /// Canonical UTF-8 JSON; kept verbatim for forwarding and durable retries.
    #[serde(with = "binary")]
    pub content: Vec<u8>,
    pub signature: String,
}

impl SignedContent {
    pub fn sign(content: Vec<u8>, domain: &str, key: &SigningKey) -> Self {
        let signature = key.sign(&signing_message(domain, &content));
        Self {
            content,
            signature: hex(&signature.to_bytes()),
        }
    }

    pub fn verify(&self, domain: &str, public_key: &str, maximum: usize) -> Result<(), ReadError> {
        if self.content.len() > maximum {
            return Err(error("SYNC_LIMIT", "Replication content exceeds its limit"));
        }
        let key = VerifyingKey::from_bytes(&unhex::<32>(public_key)?)
            .map_err(|_| error("SYNC_KEY", "Invalid replication public key"))?;
        let signature = Signature::from_bytes(&unhex::<64>(&self.signature)?);
        key.verify_strict(&signing_message(domain, &self.content), &signature)
            .map_err(|_| error("SYNC_SIGNATURE", "Replication signature does not match"))
    }
}

fn signing_message(domain: &str, content: &[u8]) -> Vec<u8> {
    let mut message = format!("memoka/replication/{domain}/v1\0").into_bytes();
    message.extend_from_slice(&Sha256::digest(content));
    message
}

pub fn decode<T: for<'a> Deserialize<'a> + Serialize>(
    content: &[u8],
    maximum: usize,
) -> Result<T, ReadError> {
    if content.is_empty() || content.len() > maximum {
        return Err(error("SYNC_LIMIT", "Invalid replication content size"));
    }
    let value: T = serde_json::from_slice(content)?;
    if serde_json::to_vec(&value)? != content {
        return Err(error(
            "SYNC_ENCODING",
            "Replication content is not canonical",
        ));
    }
    Ok(value)
}

impl ChangeBatch {
    pub fn validate(&self) -> Result<(), ReadError> {
        validate_header(
            self.version,
            &self.group_id,
            &self.workspace_id,
            &self.origin,
        )?;
        validate_frontier(&self.dependencies)?;
        if self.sequence <= 0
            || self.sequence > MAX_COUNTER
            || self
                .dependencies
                .get(&self.origin.replica_id)
                .copied()
                .unwrap_or(0)
                != self.sequence - 1
            || self.documents.len() > 1024
            || self.attachments.len() > 1024
            || (self.documents.is_empty() && self.attachments.is_empty())
        {
            return Err(error(
                "SYNC_BATCH",
                "Invalid change sequence, dependency, or batch size",
            ));
        }
        validate_documents(&self.documents, &self.workspace_id)?;
        validate_attachments(&self.attachments)
    }
}

impl Checkpoint {
    pub fn validate(&self) -> Result<(), ReadError> {
        validate_header(
            self.version,
            &self.group_id,
            &self.workspace_id,
            &self.issuer,
        )?;
        id(&self.checkpoint_id)?;
        validate_frontier(&self.included)?;
        if self.documents.is_empty()
            || self.documents.len() > 100_000
            || self.attachments.len() > 100_000
        {
            return Err(error("SYNC_LIMIT", "Invalid checkpoint size"));
        }
        validate_documents(&self.documents, &self.workspace_id)?;
        if !self.documents.iter().any(|doc| doc.kind == "workspace") {
            return Err(error(
                "SYNC_CHECKPOINT",
                "Checkpoint has no Workspace document",
            ));
        }
        validate_attachments(&self.attachments)
    }
}

fn validate_header(
    version: u32,
    group: &str,
    workspace: &str,
    origin: &Origin,
) -> Result<(), ReadError> {
    if version != PROTOCOL_VERSION {
        return Err(error("SYNC_SCHEMA", "Unsupported replication protocol"));
    }
    for value in [group, workspace, &origin.device_id, &origin.replica_id] {
        id(value)?;
    }
    Ok(())
}

pub fn validate_frontier(frontier: &Frontier) -> Result<(), ReadError> {
    if frontier.len() > MAX_MEMBERS {
        return Err(error("SYNC_LIMIT", "Too many replica dependencies"));
    }
    for (replica, sequence) in frontier {
        id(replica)?;
        if *sequence <= 0 || *sequence > MAX_COUNTER {
            return Err(error("SYNC_FRONTIER", "Invalid replica frontier"));
        }
    }
    Ok(())
}

fn validate_documents(documents: &[DocumentUpdate], workspace_id: &str) -> Result<(), ReadError> {
    let mut seen = BTreeSet::new();
    let mut total = 0_usize;
    for doc in documents {
        id(&doc.document_id)?;
        if !matches!(
            (doc.kind.as_str(), doc.schema_version),
            ("note", 7) | ("workspace", 4)
        ) || (doc.kind == "workspace" && doc.document_id != workspace_id)
        {
            return Err(error(
                "SYNC_SCHEMA",
                "Replication requires NoteDoc 7 and WorkspaceMetadataDoc 4 of this Workspace",
            ));
        }
        total = total
            .checked_add(doc.update.len())
            .ok_or_else(|| error("SYNC_LIMIT", "Replication content size overflow"))?;
        if doc.update.is_empty()
            || total > MAX_CHECKPOINT_BYTES
            || !seen.insert((&doc.kind, &doc.document_id))
        {
            return Err(error(
                "SYNC_BATCH",
                "Invalid, duplicate, or oversized document update",
            ));
        }
    }
    Ok(())
}

pub fn validate_attachments(attachments: &[AttachmentReference]) -> Result<(), ReadError> {
    let mut seen = BTreeSet::new();
    let mut sizes = BTreeMap::new();
    for item in attachments {
        id(&item.attachment_id)?;
        unhex::<32>(&item.sha256)?;
        if sizes
            .insert(&item.sha256, item.size)
            .is_some_and(|size| size != item.size)
        {
            return Err(error(
                "SYNC_ATTACHMENT",
                "Attachment hash has conflicting sizes",
            ));
        }
        if !seen.insert(&item.attachment_id)
            || item.size > crate::attachment::MAX_ATTACHMENT_BYTES
            || item.original_filename.is_empty()
            || item.original_filename.len() > 1024
            || item.original_filename.contains(['/', '\\', '\0'])
            || item.original_filename.chars().any(char::is_control)
            || item.mime_type.len() > 256
            || item.mime_type.contains(['\r', '\n', '\0'])
            || chrono::DateTime::parse_from_rfc3339(&item.created_at).is_err()
        {
            return Err(error("SYNC_ATTACHMENT", "Invalid attachment reference"));
        }
    }
    Ok(())
}

pub fn id(value: &str) -> Result<(), ReadError> {
    crate::attachment::validate_uuid_v7(value, "replicationId").map_err(Into::into)
}
pub(super) fn read_size(row: &rusqlite::Row, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|failure| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(failure),
        )
    })
}
pub fn error(code: &str, message: &str) -> ReadError {
    ReadError::new(code, message)
}
pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn unhex<const N: usize>(value: &str) -> Result<[u8; N], ReadError> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(error(
            "SYNC_ENCODING",
            "Invalid hexadecimal replication value",
        ));
    }
    let mut output = [0; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
    }
    Ok(output)
}

pub(super) mod binary {
    use super::*;
    pub fn serialize<S: serde::Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(value))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() > MAX_CHECKPOINT_BYTES * 4 / 3 + 4 {
            return Err(serde::de::Error::custom(
                "Replication bytes exceed their limit",
            ));
        }
        STANDARD.decode(value).map_err(serde::de::Error::custom)
    }
}
