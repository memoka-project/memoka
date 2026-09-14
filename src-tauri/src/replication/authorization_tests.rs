use std::sync::Mutex;

use super::*;
#[path = "rpc_tests.rs"]
mod rpc_tests;
use crate::replication::{
    authorization::{self, AuthorityAction, AuthorityGraph},
    identity, invitation,
};
use crate::{credentials::Credentials, document_model::ReadError};

#[derive(Default)]
struct MemoryCredentials(Mutex<BTreeMap<String, String>>);
impl Credentials for MemoryCredentials {
    fn get(&self, id: &str) -> Result<String, ReadError> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| error("SYNC_CREDENTIALS", "Locked"))
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), ReadError> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

struct AuthorityFixture {
    config: ReplicaConfig,
    members: Vec<ReplicaMember>,
    keys: Vec<SigningKey>,
    records: Vec<SignedContent>,
    genesis: String,
}
impl AuthorityFixture {
    fn new() -> Self {
        Self::for_workspace(id())
    }
    fn for_workspace(workspace_id: String) -> Self {
        let keys: Vec<_> = (21..=25)
            .map(|seed| SigningKey::from_bytes(&[seed; 32]))
            .collect();
        let members: Vec<_> = keys
            .iter()
            .enumerate()
            .map(|(index, key)| ReplicaMember {
                origin: Origin {
                    device_id: id(),
                    replica_id: id(),
                },
                public_key: hex(&key.verifying_key().to_bytes()),
                name: format!("Device {index}"),
                revoked: false,
            })
            .collect();
        let config = ReplicaConfig {
            workspace_id,
            group_id: id(),
            origin: members[0].origin.clone(),
            public_key: members[0].public_key.clone(),
            paused: false,
        };
        let signed = authorization::genesis(&config, &members[0], &keys[0]).unwrap();
        Self {
            genesis: digest(&signed.content),
            config,
            members,
            keys,
            records: vec![signed],
        }
    }
    fn graph(&self) -> AuthorityGraph {
        AuthorityGraph::verify(&self.genesis, &self.config, &self.records).unwrap()
    }
    fn config(&self, issuer: usize) -> ReplicaConfig {
        ReplicaConfig {
            origin: self.members[issuer].origin.clone(),
            public_key: self.members[issuer].public_key.clone(),
            ..self.config.clone()
        }
    }
    fn grant(&mut self, issuer: usize, recipient: usize) {
        let signed = self
            .graph()
            .append(
                &self.config(issuer),
                AuthorityAction::Grant {
                    member: self.members[recipient].clone(),
                },
                &self.keys[issuer],
            )
            .unwrap();
        self.records.push(signed);
    }
    fn revoke(&mut self, issuer: usize, recipient: usize) {
        let signed = self
            .graph()
            .append(
                &self.config(issuer),
                AuthorityAction::Revoke {
                    device_id: self.members[recipient].origin.device_id.clone(),
                },
                &self.keys[issuer],
            )
            .unwrap();
        self.records.push(signed);
    }
}

#[test]
fn any_registered_device_can_grant_and_revoke_without_cascading_old_grants() {
    let mut fixture = AuthorityFixture::new();
    fixture.grant(0, 1);
    fixture.grant(1, 2);
    fixture.revoke(2, 1);
    fixture.revoke(2, 0);
    fixture.grant(2, 3);
    let graph = fixture.graph();
    assert!(graph.members[&fixture.members[0].origin.device_id].revoked);
    assert!(graph.members[&fixture.members[1].origin.device_id].revoked);
    assert!(!graph.members[&fixture.members[2].origin.device_id].revoked);
    assert!(!graph.members[&fixture.members[3].origin.device_id].revoked);
    assert_eq!(
        graph
            .append(
                &fixture.config(1),
                AuthorityAction::Grant {
                    member: fixture.members[4].clone()
                },
                &fixture.keys[1]
            )
            .err()
            .unwrap()
            .code,
        "SYNC_REVOKED"
    );
    let mut reused = fixture.members[4].clone();
    reused.public_key = fixture.members[1].public_key.clone();
    assert_eq!(
        graph
            .append(
                &fixture.config(2),
                AuthorityAction::Grant { member: reused },
                &fixture.keys[2]
            )
            .err()
            .unwrap()
            .code,
        "SYNC_KEY_REUSE"
    );
    let mut shuffled = fixture.records.clone();
    shuffled.reverse();
    shuffled.extend(fixture.records.clone());
    assert_eq!(
        AuthorityGraph::verify(&fixture.genesis, &fixture.config, &shuffled)
            .unwrap()
            .members,
        graph.members
    );
}

#[test]
fn a_revoked_key_cannot_backdate_a_grant_using_an_old_causal_history() {
    let mut fixture = AuthorityFixture::new();
    fixture.grant(0, 1);
    fixture.grant(1, 2);
    let before = fixture.graph();
    fixture.revoke(0, 1);
    // A compromised/offline device can sign from an old graph. The revocation
    // excludes this grant by hash ancestry, regardless of its claimed clock.
    let forged = before
        .append(
            &fixture.config(1),
            AuthorityAction::Grant {
                member: fixture.members[3].clone(),
            },
            &fixture.keys[1],
        )
        .unwrap();
    fixture.records.push(forged);
    let graph = fixture.graph();
    assert!(!graph.members[&fixture.members[2].origin.device_id].revoked);
    assert!(graph.members[&fixture.members[3].origin.device_id].revoked);
    fixture.records.reverse();
    assert_eq!(fixture.graph().members, graph.members);
    // Subsequent revocation cannot revive the excluded identity.
    fixture.revoke(2, 0);
    assert!(fixture.graph().members[&fixture.members[3].origin.device_id].revoked);
}

#[test]
fn concurrent_revocations_remove_both_keys_and_never_choose_by_arrival_order() {
    let mut fixture = AuthorityFixture::new();
    fixture.grant(0, 1);
    let common = fixture.graph();
    fixture.revoke(0, 1);
    fixture.records.push(
        common
            .append(
                &fixture.config(1),
                AuthorityAction::Revoke {
                    device_id: fixture.members[0].origin.device_id.clone(),
                },
                &fixture.keys[1],
            )
            .unwrap(),
    );
    assert!(
        fixture
            .graph()
            .members
            .values()
            .all(|member| member.revoked)
    );
    fixture.records.reverse();
    assert!(
        fixture
            .graph()
            .members
            .values()
            .all(|member| member.revoked)
    );
}

#[test]
fn authorization_rejects_wrong_keys_groups_missing_parents_and_noncanonical_records() {
    let mut fixture = AuthorityFixture::new();
    fixture.grant(0, 1);
    let mut bad = fixture.records.clone();
    bad[1] = SignedContent::sign(bad[1].content.clone(), "authority", &fixture.keys[1]);
    assert_eq!(
        AuthorityGraph::verify(&fixture.genesis, &fixture.config, &bad)
            .err()
            .unwrap()
            .code,
        "SYNC_SIGNATURE"
    );
    let mut foreign = fixture.config.clone();
    foreign.group_id = id();
    assert_eq!(
        AuthorityGraph::verify(&fixture.genesis, &foreign, &fixture.records)
            .err()
            .unwrap()
            .code,
        "SYNC_GROUP"
    );
    fixture.grant(1, 2);
    assert_eq!(
        AuthorityGraph::verify(
            &fixture.genesis,
            &fixture.config,
            &[fixture.records[0].clone(), fixture.records[2].clone()]
        )
        .err()
        .unwrap()
        .code,
        "SYNC_AUTH_DEPENDENCY"
    );
    let mut bad = fixture.records.clone();
    bad[1].content.push(b' ');
    assert_eq!(
        AuthorityGraph::verify(&fixture.genesis, &fixture.config, &bad)
            .err()
            .unwrap()
            .code,
        "SYNC_ENCODING"
    );
}

fn enable_peer(credentials: &MemoryCredentials) -> Peer {
    let mut peer = peers().remove(0);
    crate::replication::clear_group_state(&peer.store.connection).unwrap();
    peer.config = peer.engine().enable("Local device", credentials).unwrap();
    let member = peer.engine().registered_devices().unwrap().remove(0);
    peer.key = identity::load(credentials, &peer.config.group_id, &member).unwrap();
    peer
}

#[test]
fn invitation_requires_explicit_matching_approval_and_survives_restarts_and_retries() {
    let credentials = MemoryCredentials::default();
    let mut inviter = enable_peer(&credentials);
    let now = 1_788_998_400;
    let created = inviter
        .engine()
        .create_invitation(vec!["127.0.0.1:4242".parse().unwrap()], &credentials, now)
        .unwrap();
    assert_eq!(created.expires_at, now + 600);
    assert!(!created.invitation_id.is_empty());
    let info = created.connection_info;
    let (invitation, signed) = invitation::parse(&info, now).unwrap();
    let candidate =
        identity::create(&credentials, &invitation.group_id, &id(), "Joining device").unwrap();
    let key = identity::load(&credentials, &invitation.group_id, &candidate).unwrap();
    let claim = invitation::claim(&invitation, &signed, candidate.clone(), &key).unwrap();
    assert_eq!(
        inviter
            .engine()
            .claim_invitation(&claim, &invitation.public_key, now)
            .unwrap_err()
            .code,
        "SYNC_KEY"
    );
    let pending = inviter
        .engine()
        .claim_invitation(&claim, &candidate.public_key, now)
        .unwrap();
    assert!(!pending.approved);
    assert_eq!(inviter.engine().registered_devices().unwrap().len(), 1);
    assert_eq!(
        inviter.engine().pending_devices(now).unwrap(),
        vec![pending]
    );
    assert_eq!(
        inviter
            .engine()
            .approve_invitation(
                &invitation.invitation_id,
                &invitation.public_key,
                &credentials,
                now
            )
            .unwrap_err()
            .code,
        "SYNC_KEY"
    );
    let mut inviter = inviter.reopen();
    assert!(
        !inviter
            .engine()
            .claim_invitation(&claim, &candidate.public_key, now)
            .unwrap()
            .approved
    );
    assert_eq!(
        inviter
            .engine()
            .approve_invitation(
                &invitation.invitation_id,
                &candidate.public_key,
                &credentials,
                now
            )
            .unwrap(),
        candidate
    );
    assert!(
        inviter
            .engine()
            .claim_invitation(&claim, &candidate.public_key, now + 1000)
            .unwrap()
            .approved
    );
    assert_eq!(
        inviter
            .engine()
            .approve_invitation(
                &invitation.invitation_id,
                &candidate.public_key,
                &credentials,
                now + 1000
            )
            .unwrap(),
        candidate
    );
    assert_eq!(inviter.engine().authority().unwrap().records().len(), 2);
    let candidate2 = identity::create(
        &credentials,
        &invitation.group_id,
        &id(),
        "Different device",
    )
    .unwrap();
    let key2 = identity::load(&credentials, &invitation.group_id, &candidate2).unwrap();
    let claim2 = invitation::claim(&invitation, &signed, candidate2.clone(), &key2).unwrap();
    assert_eq!(
        inviter
            .engine()
            .claim_invitation(&claim2, &candidate2.public_key, now)
            .unwrap_err()
            .code,
        "SYNC_INVITE_USED"
    );
    let revoke = AuthorityAction::Revoke {
        device_id: candidate.origin.device_id.clone(),
    };
    let key = inviter.key.clone();
    inviter.engine().authorize(revoke, &key).unwrap();
    assert_eq!(
        inviter
            .engine()
            .claim_invitation(&claim, &candidate.public_key, now + 1000)
            .unwrap_err()
            .code,
        "SYNC_REVOKED"
    );
}

#[test]
fn private_keys_and_invitation_secrets_never_enter_workspace_storage() {
    let credentials = MemoryCredentials::default();
    let mut peer = enable_peer(&credentials);
    let now = 1_788_998_400;
    let info = peer
        .engine()
        .create_invitation(vec!["127.0.0.1:4242".parse().unwrap()], &credentials, now)
        .unwrap()
        .connection_info;
    let (invitation, _) = invitation::parse(&info, now).unwrap();
    let settings: Vec<String> = peer
        .store
        .connection
        .prepare("SELECT value FROM settings")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let public = serde_json::to_vec(&peer.engine().authority().unwrap().records()).unwrap();
    let mut private: Vec<String> = credentials.0.lock().unwrap().values().cloned().collect();
    private.push(invitation.token);
    for value in private {
        assert!(!settings.iter().any(|setting| setting.contains(&value)));
        assert!(
            !public
                .windows(value.len())
                .any(|part| part == value.as_bytes())
        );
        for name in ["memoka.sqlite3", "memoka.sqlite3-wal"] {
            let bytes = std::fs::read(peer.root.path().join(name)).unwrap_or_default();
            assert!(
                !bytes
                    .windows(value.len())
                    .any(|part| part == value.as_bytes())
            );
        }
    }
    let config = peer.config.clone();
    crate::replication::clear_group_state(&peer.store.connection).unwrap();
    let mut peer = peer.reopen();
    assert!(!peer.engine().status().unwrap().enabled);
    assert!(peer.engine().registered_devices().unwrap().is_empty());
    assert_ne!(
        peer.engine()
            .enable("Restored device", &credentials)
            .unwrap()
            .origin
            .replica_id,
        config.origin.replica_id
    );
}

#[test]
fn expired_tampered_and_rejected_invitations_and_changed_address_keys_are_refused() {
    let credentials = MemoryCredentials::default();
    let mut peer = enable_peer(&credentials);
    let now = 1_788_998_400;
    let info = peer
        .engine()
        .create_invitation(vec!["127.0.0.1:4242".parse().unwrap()], &credentials, now)
        .unwrap()
        .connection_info;
    assert_eq!(
        invitation::parse(&info, now + 600).unwrap_err().code,
        "SYNC_INVITE_EXPIRED"
    );
    let (invitation, signed) = invitation::parse(&info, now).unwrap();
    let candidate =
        identity::create(&credentials, &invitation.group_id, &id(), "Joining device").unwrap();
    let key = identity::load(&credentials, &invitation.group_id, &candidate).unwrap();
    let mut claim = invitation::claim(&invitation, &signed, candidate.clone(), &key).unwrap();
    claim.token = "11".repeat(32);
    assert_eq!(
        peer.engine()
            .claim_invitation(&claim, &candidate.public_key, now)
            .unwrap_err()
            .code,
        "SYNC_INVITE"
    );
    claim.token = invitation.token;
    peer.engine()
        .reject_invitation(&invitation.invitation_id)
        .unwrap();
    assert_eq!(
        peer.engine()
            .claim_invitation(&claim, &candidate.public_key, now)
            .unwrap_err()
            .code,
        "SYNC_INVITE_USED"
    );
    let config = peer.config.clone();
    assert_eq!(
        peer.engine()
            .update_addresses(
                &config.origin.device_id,
                &candidate.public_key,
                &["127.0.0.1:4243".parse().unwrap()]
            )
            .unwrap_err()
            .code,
        "SYNC_KEY"
    );
    peer.engine()
        .update_addresses(
            &config.origin.device_id,
            &config.public_key,
            &["127.0.0.1:4243".parse().unwrap()],
        )
        .unwrap();
    for address in [
        "0.0.0.0:42",
        "127.0.0.1:0",
        "224.0.0.1:42",
        "255.255.255.255:42",
        "[ff02::1]:42",
    ] {
        assert_eq!(
            invitation::validate_addresses(&[address.parse().unwrap()])
                .unwrap_err()
                .code,
            "SYNC_ADDRESS"
        );
    }
}

#[test]
fn a_new_device_can_present_a_forwarded_registration_but_revoked_and_foreign_keys_cannot() {
    let mut peers = peers();
    let mut c = peers.pop().unwrap();
    let mut b = peers.pop().unwrap();
    let mut a = peers.pop().unwrap();
    let mut fixture = AuthorityFixture::for_workspace(a.config.workspace_id.clone());
    fixture.grant(0, 1);
    let older = fixture.records.clone();
    fixture.grant(1, 2);
    for (index, peer) in [&mut a, &mut b, &mut c].into_iter().enumerate() {
        crate::replication::clear_group_state(&peer.store.connection).unwrap();
        peer.config = fixture.config(index);
        peer.key = fixture.keys[index].clone();
        let records = if index == 0 { &older } else { &fixture.records };
        let config = peer.config.clone();
        peer.engine()
            .initialize_authenticated(&config, &fixture.genesis, records)
            .unwrap();
    }
    let hello = c.engine().hello().unwrap();
    assert_eq!(a.engine().registered_devices().unwrap().len(), 2);
    assert_eq!(
        a.engine()
            .authenticate_peer(&fixture.members[4].public_key, &hello)
            .unwrap_err()
            .code,
        "SYNC_KEY"
    );
    assert_eq!(a.engine().registered_devices().unwrap().len(), 2);
    a.engine()
        .authenticate_peer(&fixture.members[2].public_key, &hello)
        .unwrap();
    assert_eq!(a.engine().registered_devices().unwrap().len(), 3);
    let edit = c.edit("registered through B", false);
    c.store.commit(&edit).unwrap();
    a.receive(&c.outgoing());
    a.apply();
    assert!(a.projection().to_string().contains("registered through B"));
    let mut forged = hello.clone();
    forged.group_id = id();
    assert_eq!(
        a.engine()
            .authenticate_peer(&fixture.members[2].public_key, &forged)
            .unwrap_err()
            .code,
        "SYNC_GROUP"
    );
    let revoke = c
        .engine()
        .authorize(
            AuthorityAction::Revoke {
                device_id: fixture.members[1].origin.device_id.clone(),
            },
            &fixture.keys[2],
        )
        .unwrap();
    a.engine()
        .receive_authorizations(&fixture.members[2].origin, &[revoke])
        .unwrap();
    assert_eq!(
        a.engine()
            .authenticate_peer(&fixture.members[1].public_key, &b.engine().hello().unwrap())
            .unwrap_err()
            .code,
        "SYNC_REVOKED"
    );
    let mut a = a.reopen();
    assert!(
        a.engine()
            .registered_devices()
            .unwrap()
            .into_iter()
            .find(|member| member.origin == fixture.members[1].origin)
            .unwrap()
            .revoked
    );
    assert_eq!(
        a.engine()
            .receive_authorizations(&fixture.members[1].origin, &[])
            .unwrap_err()
            .code,
        "SYNC_REVOKED"
    );
}

#[test]
fn an_unavailable_credential_store_cannot_enable_a_group_or_replace_an_existing_key() {
    struct Locked;
    impl Credentials for Locked {
        fn get(&self, _: &str) -> Result<String, ReadError> {
            Err(error("SYNC_CREDENTIALS", "Locked"))
        }
        fn set(&self, _: &str, _: &str) -> Result<(), ReadError> {
            Err(error("SYNC_CREDENTIALS", "Locked"))
        }
        fn remove(&self, _: &str) {}
    }
    let mut peer = peers().remove(0);
    crate::replication::clear_group_state(&peer.store.connection).unwrap();
    assert_eq!(
        peer.engine().enable("Device", &Locked).unwrap_err().code,
        "SYNC_CREDENTIALS"
    );
    assert!(!peer.engine().status().unwrap().enabled);
    let credentials = MemoryCredentials::default();
    let config = peer.engine().enable("Device", &credentials).unwrap();
    assert_eq!(
        peer.engine().enable("Other", &Locked).unwrap_err().code,
        "SYNC_GROUP"
    );
    assert_eq!(peer.engine().configuration().unwrap().unwrap(), config);
    let member = peer.engine().registered_devices().unwrap().remove(0);
    credentials
        .set(
            &identity::credential_id(&config.group_id, &member).unwrap(),
            &"00".repeat(32),
        )
        .unwrap();
    assert_eq!(
        identity::load(&credentials, &config.group_id, &member)
            .err()
            .unwrap()
            .code,
        "SYNC_KEY"
    );
}
