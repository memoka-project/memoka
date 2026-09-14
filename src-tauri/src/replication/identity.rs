//! Device secrets live only in the OS credential store. A Workspace contains
//! public identities and an opaque credential reference, never private keys.
use ed25519_dalek::SigningKey;
use rand::RngCore;
use zeroize::Zeroizing;

use super::{ReplicaMember, protocol::*};
use crate::{credentials::Credentials, document_model::ReadError};

pub(crate) struct SyncCredentials;
impl Credentials for SyncCredentials {
    fn get(&self, id: &str) -> Result<String, ReadError> {
        entry(id)?.get_password().map_err(|_| unavailable())
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), ReadError> {
        entry(id)?.set_password(secret).map_err(|_| unavailable())
    }
    fn remove(&self, id: &str) {
        if let Ok(entry) = entry(id) {
            let _ = entry.delete_credential();
        }
    }
}
fn entry(id: &str) -> Result<keyring::Entry, ReadError> {
    keyring::Entry::new("dev.memoka.desktop.sync", id).map_err(|_| unavailable())
}
fn unavailable() -> ReadError {
    error(
        "SYNC_CREDENTIALS",
        "The OS credential store is unavailable or locked",
    )
}

pub(crate) fn credential_id(group: &str, member: &ReplicaMember) -> Result<String, ReadError> {
    id(group)?;
    id(&member.origin.device_id)?;
    id(&member.origin.replica_id)?;
    Ok(format!(
        "{group}/{}/{}",
        member.origin.device_id, member.origin.replica_id
    ))
}

pub(crate) fn create(
    credentials: &dyn Credentials,
    group: &str,
    replica: &str,
    name: &str,
) -> Result<ReplicaMember, ReadError> {
    id(replica)?;
    let mut secret = Zeroizing::new([0_u8; 32]);
    rand::rngs::OsRng.fill_bytes(secret.as_mut());
    let key = SigningKey::from_bytes(&secret);
    let member = ReplicaMember {
        origin: Origin {
            device_id: uuid::Uuid::now_v7().to_string(),
            replica_id: replica.into(),
        },
        public_key: hex(&key.verifying_key().to_bytes()),
        name: name.into(),
        revoked: false,
    };
    super::authorization::validate_member(&member)?;
    let reference = credential_id(group, &member)?;
    credentials.set(&reference, &Zeroizing::new(hex(secret.as_ref())))?;
    // Detect failed persistence before making the identity available to the UI.
    if let Err(failure) = load(credentials, group, &member) {
        credentials.remove(&reference);
        return Err(failure);
    }
    Ok(member)
}

pub(crate) fn load(
    credentials: &dyn Credentials,
    group: &str,
    member: &ReplicaMember,
) -> Result<SigningKey, ReadError> {
    let secret = Zeroizing::new(credentials.get(&credential_id(group, member)?)?);
    let bytes = Zeroizing::new(unhex::<32>(&secret)?);
    let key = SigningKey::from_bytes(&bytes);
    if hex(&key.verifying_key().to_bytes()) != member.public_key {
        return Err(error(
            "SYNC_KEY",
            "Stored secret does not match this device",
        ));
    }
    Ok(key)
}

pub fn fingerprint(public_key: &str) -> Result<String, ReadError> {
    unhex::<32>(public_key)?;
    // All 256 bits remain visible; grouping only improves visual comparison.
    Ok(public_key
        .as_bytes()
        .chunks(8)
        .map(|part| std::str::from_utf8(part).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" "))
}
