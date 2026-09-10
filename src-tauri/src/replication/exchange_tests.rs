use super::*;
use crate::replication::exchange::{self, ExchangeState};

async fn wait(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn authenticated_quic_resumes_an_attachment_and_publishes_verified_bytes() {
    let network = Network::new(true).await;
    let bytes: Vec<u8> = (0..900_000).map(|i| (i % 251) as u8).collect();
    let (signed, hash) = {
        let mut b = network.b.peer.lock().unwrap();
        let (signed, hash) = attachment_batch(&b, &bytes);
        let batch: ChangeBatch = decode(&signed.content, MAX_BATCH_BYTES).unwrap();
        let attachment = &batch.attachments[0];
        b.store
            .connection
            .execute(
                "INSERT INTO attachment_objects(sha256,size,created_at) VALUES(?1,?2,?3)",
                rusqlite::params![hash, bytes.len() as i64, AT],
            )
            .unwrap();
        b.store.connection.execute("INSERT INTO attachments(attachment_id,sha256,size,original_filename,mime_type,created_at) VALUES(?1,?2,?3,?4,?5,?6)", rusqlite::params![attachment.attachment_id,hash,attachment.size as i64,attachment.original_filename,attachment.mime_type,attachment.created_at]).unwrap();
        let object = b
            .root
            .path()
            .join("attachments/objects")
            .join(&hash[..2])
            .join(&hash[2..]);
        std::fs::create_dir_all(object.parent().unwrap()).unwrap();
        std::fs::write(object, &bytes).unwrap();
        crate::replication::journal_local_attachments(&b.store.connection, batch.attachments)
            .unwrap();
        (b.outgoing().remove(0), hash)
    };
    {
        let mut a = network.a.peer.lock().unwrap();
        a.receive(&[signed]);
        a.apply();
        a.engine().begin_attachment(&hash).unwrap();
        // The previous connection ended after this durably acknowledged chunk.
        a.engine()
            .write_attachment_chunk(&hash, 0, &bytes[..256 * 1024], None)
            .unwrap();
    }
    let progress = Arc::new(ExchangeState::new());
    let worker = tokio::spawn(exchange::run(
        network.a.clone(),
        network.a.config(),
        network.connection.clone(),
        true,
        Arc::new(RpcBudget::default()),
        progress.clone(),
    ));
    wait(|| {
        if worker.is_finished() {
            panic!("Transfer worker stopped: {:?}", progress.snapshot());
        }
        network
            .a
            .peer
            .lock()
            .unwrap()
            .engine()
            .pending_attachments(8)
            .unwrap()
            .is_empty()
    })
    .await;
    let a = network.a.peer.lock().unwrap();
    let object = a
        .root
        .path()
        .join("attachments/objects")
        .join(&hash[..2])
        .join(&hash[2..]);
    assert_eq!(std::fs::read(object).unwrap(), bytes);
    let state = a
        .store
        .connection
        .query_row(
            "SELECT received,complete FROM sync_attachment_transfers WHERE sha256=?1",
            [&hash],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)),
        )
        .unwrap();
    assert_eq!(state, (bytes.len() as i64, true));
    drop(a);
    worker.abort();
    let _ = worker.await;
    network.close().await;
}

#[tokio::test]
async fn continuous_exchange_receives_both_directions_without_touching_documents() {
    let network = Network::new(false).await;
    network.service.abort();
    tokio::task::yield_now().await;
    let a_state = Arc::new(ExchangeState::new());
    let b_state = Arc::new(ExchangeState::new());
    let a = tokio::spawn(exchange::run(
        network.a.clone(),
        network.a.config(),
        network.connection.clone(),
        true,
        Arc::new(RpcBudget::default()),
        a_state.clone(),
    ));
    let b = tokio::spawn(exchange::run(
        network.b.clone(),
        network.b.config(),
        network._incoming.clone(),
        false,
        Arc::new(RpcBudget::default()),
        b_state.clone(),
    ));
    wait(|| {
        a_state.snapshot().values().any(|p| p.connected)
            && b_state.snapshot().values().any(|p| p.connected)
    })
    .await;
    let original_a = network.a.peer.lock().unwrap().projection();
    {
        let mut peer = network.a.peer.lock().unwrap();
        let edit = peer.edit("A edited", true);
        peer.store.commit(&edit).unwrap();
        peer.outgoing();
    }
    {
        let mut peer = network.b.peer.lock().unwrap();
        let edit = peer.edit("B edited", false);
        peer.store.commit(&edit).unwrap();
        peer.outgoing();
    }
    a_state.wake.notify_waiters();
    b_state.wake.notify_waiters();
    wait(|| {
        network
            .a
            .peer
            .lock()
            .unwrap()
            .engine()
            .status()
            .unwrap()
            .pending_apply_count
            == 1
            && network
                .b
                .peer
                .lock()
                .unwrap()
                .engine()
                .status()
                .unwrap()
                .pending_apply_count
                == 1
    })
    .await;
    assert!(
        !network
            .a
            .peer
            .lock()
            .unwrap()
            .projection()
            .to_string()
            .contains("B edited")
    );
    network.a.peer.lock().unwrap().apply();
    network.b.peer.lock().unwrap().apply();
    assert_eq!(
        network.a.peer.lock().unwrap().projection(),
        network.b.peer.lock().unwrap().projection()
    );
    assert_ne!(network.a.peer.lock().unwrap().projection(), original_a);
    let applied = network
        .a
        .peer
        .lock()
        .unwrap()
        .engine()
        .status()
        .unwrap()
        .frontier
        .applied;
    wait(|| {
        b_state
            .snapshot()
            .values()
            .any(|p| p.frontier.applied == applied)
    })
    .await;
    network
        .a
        .peer
        .lock()
        .unwrap()
        .engine()
        .set_paused(true)
        .unwrap();
    wait(|| a.is_finished() && b.is_finished()).await;
    assert!(!a_state.snapshot().values().any(|p| p.connected));
    assert!(a.await.unwrap().is_err());
    assert!(b.await.unwrap().is_err());
    network.close().await;
}

#[tokio::test]
async fn newly_authorized_issuer_proof_precedes_its_forwarded_change() {
    let network = Network::new(true).await;
    let (member, key) = {
        let key = SigningKey::from_bytes(&[88; 32]);
        (
            ReplicaMember {
                origin: Origin {
                    device_id: id(),
                    replica_id: id(),
                },
                public_key: hex(&key.verifying_key().to_bytes()),
                name: "Third device".into(),
                revoked: false,
            },
            key,
        )
    };
    let batch = {
        let mut b = network.b.peer.lock().unwrap();
        let issuer_key = b.key.clone();
        b.engine()
            .authorize(
                AuthorityAction::Grant {
                    member: member.clone(),
                },
                &issuer_key,
            )
            .unwrap();
        let edit = b.edit("from third device", false);
        let batch = ChangeBatch {
            version: PROTOCOL_VERSION,
            group_id: b.config.group_id.clone(),
            workspace_id: b.config.workspace_id.clone(),
            origin: member.origin.clone(),
            sequence: 1,
            dependencies: Frontier::new(),
            documents: edit
                .documents
                .iter()
                .map(|doc| DocumentUpdate {
                    kind: doc.kind.clone(),
                    document_id: doc.document_id.clone(),
                    schema_version: doc.schema_version,
                    update: doc.update.clone().unwrap(),
                })
                .collect(),
            attachments: vec![],
        };
        batch
    };
    let signed = SignedContent::sign(serde_json::to_vec(&batch).unwrap(), "batch", &key);
    network.b.peer.lock().unwrap().receive(&[signed]);
    let frontier = ReplicaFrontier::default();
    let reply = rpc::request_json(
        &network.connection,
        &network.a.config(),
        FrameKind::ChangesRequest,
        &frontier,
    )
    .await
    .unwrap();
    assert_eq!(reply.kind, FrameKind::Authority);
    let records: Vec<SignedContent> = decode(&reply.content, FrameKind::Authority.limit()).unwrap();
    network
        .a
        .peer
        .lock()
        .unwrap()
        .engine()
        .receive_authorizations(&network.b.config().origin, &records)
        .unwrap();
    let reply = rpc::request_json(
        &network.connection,
        &network.a.config(),
        FrameKind::ChangesRequest,
        &frontier,
    )
    .await
    .unwrap();
    assert_eq!(reply.kind, FrameKind::Batch);
    network.a.peer.lock().unwrap().receive(&[SignedContent {
        content: reply.content,
        signature: reply.signature.unwrap(),
    }]);
    network.a.peer.lock().unwrap().apply();
    assert!(
        network
            .a
            .peer
            .lock()
            .unwrap()
            .projection()
            .to_string()
            .contains("from third device")
    );
    network.close().await;
}

#[tokio::test]
async fn controller_signs_automatically_and_recovers_offline_edits_after_peer_restart() {
    let network = Network::new(false).await;
    network.service.abort();
    network.connection.close();
    network._incoming.close();
    tokio::task::yield_now().await;
    let key_a = network.a.peer.lock().unwrap().key.clone();
    let key_b = network.b.peer.lock().unwrap().key.clone();
    let client_address = network.client.bound_address();
    let server_address = network.server.bound_address();
    for (owner, other, address) in [
        (&network.a, &network.b, server_address),
        (&network.b, &network.a, client_address),
    ] {
        let config = other.config();
        owner
            .peer
            .lock()
            .unwrap()
            .engine()
            .update_addresses(&config.origin.device_id, &config.public_key, &[address])
            .unwrap();
    }
    let a_state = Arc::new(ExchangeState::new());
    let b_state = Arc::new(ExchangeState::new());
    let client = Arc::new(network.client);
    let server = Arc::new(network.server);
    let a = tokio::spawn(crate::replication::controller::run(
        network.a.clone(),
        network.a.config(),
        client.clone(),
        key_a,
        a_state.clone(),
    ));
    let b = tokio::spawn(crate::replication::controller::run(
        network.b.clone(),
        network.b.config(),
        server.clone(),
        key_b.clone(),
        b_state.clone(),
    ));
    wait(|| {
        a_state.snapshot().values().any(|p| p.connected)
            && b_state.snapshot().values().any(|p| p.connected)
    })
    .await;
    {
        let mut peer = network.a.peer.lock().unwrap();
        let edit = peer.edit("before restart", false);
        peer.store.commit(&edit).unwrap();
    }
    wait(|| {
        network
            .b
            .peer
            .lock()
            .unwrap()
            .engine()
            .status()
            .unwrap()
            .pending_apply_count
            > 0
    })
    .await;
    network.b.peer.lock().unwrap().apply();
    b.abort();
    let _ = b.await;
    server.close().await;
    wait(|| a_state.snapshot().values().all(|p| !p.connected)).await;
    {
        let mut peer = network.a.peer.lock().unwrap();
        let edit = peer.edit("offline edit", false);
        peer.store.commit(&edit).unwrap();
    }
    let server = Arc::new(
        DirectEndpoint::bind(&key_b, server_address, &[client_address])
            .await
            .unwrap(),
    );
    let b_state = Arc::new(ExchangeState::new());
    let b = tokio::spawn(crate::replication::controller::run(
        network.b.clone(),
        network.b.config(),
        server.clone(),
        key_b,
        b_state,
    ));
    a_state.reconnect.notify_one();
    wait(|| {
        network
            .b
            .peer
            .lock()
            .unwrap()
            .engine()
            .status()
            .unwrap()
            .pending_apply_count
            > 0
    })
    .await;
    network.b.peer.lock().unwrap().apply();
    assert_eq!(
        network.a.peer.lock().unwrap().projection(),
        network.b.peer.lock().unwrap().projection()
    );
    a.abort();
    b.abort();
    let _ = tokio::join!(a, b);
    tokio::join!(client.close(), server.close());
}
