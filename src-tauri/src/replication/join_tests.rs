use super::*;
use crate::replication::join;

#[tokio::test]
async fn fresh_receive_requires_reviewed_approval_resumes_its_identity_and_opens_only_after_durable_documents()
 {
    let credentials = MemoryCredentials::default();
    let mut peer = peers().remove(0);
    crate::replication::clear_group_state(&peer.store.connection).unwrap();
    peer.config = peer.engine().enable("Inviter", &credentials).unwrap();
    let member = peer.engine().registered_devices().unwrap().remove(0);
    peer.key = identity::load(&credentials, &peer.config.group_id, &member).unwrap();
    let endpoint = DirectEndpoint::bind(&peer.key, "127.0.0.1:0".parse().unwrap(), &[])
        .await
        .unwrap();
    let created = peer
        .engine()
        .create_invitation(
            vec![endpoint.bound_address()],
            &credentials,
            chrono::Utc::now().timestamp(),
        )
        .unwrap();
    let info = created.connection_info;
    let key = peer.key.clone();
    peer.engine().create_checkpoint(&key, false).unwrap();
    let expected = peer.projection();
    let inviter = MemoryOwner::new(peer);
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("Received");
    assert!(join::prepare(&destination, &info, "", &credentials).is_err());
    let (receipt, owner, key, claim) =
        join::prepare(&destination, &info, "New laptop", &credentials).unwrap();
    let fingerprint = hex(&key.verifying_key().to_bytes());
    assert!(claim.is_some());
    assert!(
        owner
            .dispatch(|store| Ok(store.manifest()?.active_workspace_id))
            .await
            .unwrap()
            .is_none()
    );
    drop(receipt);
    drop(owner);
    drop(key);
    drop(claim);
    let (receipt, owner, key, claim) = join::prepare(&destination, "", "", &credentials).unwrap();
    assert_eq!(hex(&key.verifying_key().to_bytes()), fingerprint);
    let view = Arc::new(Mutex::new(join::JoinView {
        path: destination.clone(),
        phase: "connecting".into(),
        name: "New laptop".into(),
        fingerprint: fingerprint.clone(),
        error: None,
    }));
    let task = tokio::spawn(join::receive(receipt, owner.clone(), key, claim, view));
    let incoming = tokio::time::timeout(std::time::Duration::from_secs(5), endpoint.accept())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let session = Arc::new(RpcSession::new(
        inviter.clone(),
        inviter.config(),
        incoming.public_key(),
        Arc::new(RpcBudget::default()),
    ));
    let server = tokio::spawn(session.serve(incoming.clone()));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if !inviter
                .peer
                .lock()
                .unwrap()
                .engine()
                .pending_devices(chrono::Utc::now().timestamp())
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        owner
            .dispatch(|store| Ok(store.manifest()?.active_workspace_id))
            .await
            .unwrap()
            .is_none()
    );
    let (invitation, _) = invitation::parse(&info, chrono::Utc::now().timestamp()).unwrap();
    {
        let mut peer = inviter.peer.lock().unwrap();
        assert!(
            peer.engine()
                .approve_invitation(
                    &invitation.invitation_id,
                    &"0".repeat(64),
                    &credentials,
                    chrono::Utc::now().timestamp()
                )
                .is_err()
        );
        peer.engine()
            .approve_invitation(
                &invitation.invitation_id,
                &fingerprint,
                &credentials,
                chrono::Utc::now().timestamp(),
            )
            .unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(owner);
    let store = crate::data_area::open_data_area(&destination).unwrap();
    let actual = store
        .load_document("note", "01a30000-0000-7000-8000-000000000002")
        .unwrap();
    assert_eq!(
        serde_json::to_value(crate::replicated_note::read(&actual).unwrap()).unwrap(),
        expected
    );
    assert_ne!(
        store.manifest().unwrap().replica_id,
        inviter.config().origin.replica_id
    );
    let pending: bool = store
        .connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key='replication_join')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!pending);
    let contents = std::fs::read(destination.join(".memoka/memoka.sqlite3")).unwrap();
    assert!(!String::from_utf8_lossy(&contents).contains(&invitation.token));
    drop(store);
    assert_eq!(
        join::prepare(&destination, &info, "Again", &credentials)
            .err()
            .unwrap()
            .code,
        "SYNC_JOIN_DESTINATION"
    );
    server.abort();
    let _ = server.await;
    incoming.close();
    endpoint.close().await;
}

#[test]
fn initial_receive_refuses_existing_or_nonempty_destinations_without_changing_them() {
    let credentials = MemoryCredentials::default();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Existing");
    crate::data_area::prepare_data_area(&path).unwrap();
    drop(crate::data_area::open_data_area(&path).unwrap());
    let db = path.join(".memoka/memoka.sqlite3");
    let before = std::fs::read(&db).unwrap();
    assert_eq!(
        join::prepare(&path, "invalid", "Name", &credentials)
            .err()
            .unwrap()
            .code,
        "SYNC_JOIN_DESTINATION"
    );
    assert_eq!(std::fs::read(db).unwrap(), before);
    let fresh = directory.path().join("Fresh");
    assert!(join::prepare(&fresh, "invalid", "Name", &credentials).is_err());
    assert!(!fresh.exists());
}
