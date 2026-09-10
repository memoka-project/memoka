use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::*;
use crate::replication::{
    direct::{DirectConnection, DirectEndpoint, FrameKind},
    owner::{OwnerFuture, ReplicationOwner},
    rpc::{self, CheckpointRequest, RpcBudget, RpcSession},
};

struct MemoryOwner {
    peer: Arc<Mutex<Peer>>,
    received: AtomicUsize,
}
#[path = "exchange_tests.rs"]
mod exchange_tests;
#[path = "join_tests.rs"]
mod join_tests;
impl ReplicationOwner for MemoryOwner {
    fn dispatch<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut ProductStore) -> Result<T, ReadError> + Send + 'static,
    ) -> OwnerFuture<T> {
        let peer = self.peer.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || action(&mut peer.lock().unwrap().store))
                .await
                .unwrap()
        })
    }
    fn received(&self) {
        self.received.fetch_add(1, Ordering::Relaxed);
    }
}
impl MemoryOwner {
    fn new(peer: Peer) -> Arc<Self> {
        Arc::new(Self {
            peer: Arc::new(Mutex::new(peer)),
            received: AtomicUsize::new(0),
        })
    }
    fn config(&self) -> ReplicaConfig {
        self.peer.lock().unwrap().config.clone()
    }
}

struct Network {
    a: Arc<MemoryOwner>,
    b: Arc<MemoryOwner>,
    client: DirectEndpoint,
    server: DirectEndpoint,
    connection: DirectConnection,
    _incoming: DirectConnection,
    service: tokio::task::JoinHandle<Result<(), ReadError>>,
}
impl Network {
    async fn new(authenticate: bool) -> Self {
        let mut peers = peers();
        let mut b = peers.pop().unwrap();
        let mut a = peers.remove(0);
        let mut fixture = AuthorityFixture::for_workspace(a.config.workspace_id.clone());
        fixture.grant(0, 1);
        for (index, peer) in [&mut a, &mut b].into_iter().enumerate() {
            crate::replication::clear_group_state(&peer.store.connection).unwrap();
            peer.config = fixture.config(index);
            peer.key = fixture.keys[index].clone();
            let config = peer.config.clone();
            peer.engine()
                .initialize_authenticated(&config, &fixture.genesis, &fixture.records)
                .unwrap();
        }
        let server = DirectEndpoint::bind(&b.key, "127.0.0.1:0".parse().unwrap(), &[])
            .await
            .unwrap();
        let client = DirectEndpoint::bind(
            &a.key,
            "127.0.0.1:0".parse().unwrap(),
            &[server.bound_address()],
        )
        .await
        .unwrap();
        let key = server.public_key();
        let addresses = [server.bound_address()];
        let (connection, incoming) =
            tokio::join!(client.connect(&key, &addresses), server.accept());
        let connection = connection.unwrap();
        let incoming = incoming.unwrap().unwrap();
        let a = MemoryOwner::new(a);
        let b = MemoryOwner::new(b);
        let session = Arc::new(RpcSession::new(
            b.clone(),
            b.config(),
            incoming.public_key(),
            Arc::new(RpcBudget::default()),
        ));
        let service = tokio::spawn(session.serve(incoming.clone()));
        let network = Self {
            a,
            b,
            client,
            server,
            connection,
            _incoming: incoming,
            service,
        };
        if authenticate {
            let hello = network
                .a
                .dispatch(|store| ReplicationEngine::new(store).hello())
                .await
                .unwrap();
            let reply = rpc::request_json(
                &network.connection,
                &network.a.config(),
                FrameKind::Hello,
                &hello,
            )
            .await
            .unwrap();
            assert_eq!(reply.kind, FrameKind::HelloReply);
            let hello = decode(&reply.content, FrameKind::HelloReply.limit()).unwrap();
            let key = network.connection.public_key();
            network
                .a
                .dispatch(move |store| {
                    ReplicationEngine::new(store).authenticate_peer(&key, &hello)
                })
                .await
                .unwrap();
        }
        network
    }
    async fn close(self) {
        self.connection.close();
        self.service.abort();
        let _ = self.service.await;
        tokio::join!(self.client.close(), self.server.close());
    }
}

#[tokio::test]
async fn direct_rpc_persists_received_batches_but_only_the_owner_applies_them() {
    let network = Network::new(true).await;
    let before = network.b.peer.lock().unwrap().note();
    let signed = {
        let mut a = network.a.peer.lock().unwrap();
        let edit = a.edit("over authenticated QUIC", false);
        a.store.commit(&edit).unwrap();
        a.outgoing().remove(0)
    };
    let reply = rpc::request(
        &network.connection,
        &network.a.config(),
        FrameKind::Batch,
        &signed.content,
        Some(signed.signature.clone()),
    )
    .await
    .unwrap();
    let frontier: ReplicaFrontier = decode(&reply.content, FrameKind::Frontier.limit()).unwrap();
    assert_eq!(frontier.received[&network.a.config().origin.replica_id], 1);
    assert!(frontier.applied.is_empty());
    assert_eq!(network.b.peer.lock().unwrap().note(), before);
    assert!(network.b.received.load(Ordering::Relaxed) > 0);
    network
        .b
        .dispatch(|store| {
            let mut engine = ReplicationEngine::new(store);
            let prepared = engine.prepare_next()?.unwrap();
            engine.commit_prepared(&prepared, None)
        })
        .await
        .unwrap();
    let applied = network.b.peer.lock().unwrap().note();
    assert_ne!(applied.revision, before.revision);
    let repeated = rpc::request(
        &network.connection,
        &network.a.config(),
        FrameKind::Batch,
        &signed.content,
        Some(signed.signature),
    )
    .await
    .unwrap();
    let frontier: ReplicaFrontier = decode(&repeated.content, FrameKind::Frontier.limit()).unwrap();
    assert_eq!(frontier.applied[&network.a.config().origin.replica_id], 1);
    assert_eq!(network.b.peer.lock().unwrap().note(), applied);
    {
        let mut b = network.b.peer.lock().unwrap();
        let edit = b.edit("return path", false);
        b.store.commit(&edit).unwrap();
        b.outgoing();
    }
    let frontier = network
        .a
        .dispatch(|store| Ok(ReplicationEngine::new(store).status()?.frontier))
        .await
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
    let signed = SignedContent {
        content: reply.content,
        signature: reply.signature.unwrap(),
    };
    network
        .a
        .dispatch(move |store| {
            let mut engine = ReplicationEngine::new(store);
            engine.receive(&signed)?;
            let prepared = engine.prepare_next()?.unwrap();
            engine.commit_prepared(&prepared, None)
        })
        .await
        .unwrap();
    assert_eq!(
        network.a.peer.lock().unwrap().projection(),
        network.b.peer.lock().unwrap().projection()
    );
    network.close().await;
}

#[tokio::test]
async fn direct_rpc_requires_group_authentication_before_sending_a_checkpoint() {
    let network = Network::new(false).await;
    {
        let mut b = network.b.peer.lock().unwrap();
        let key = b.key.clone();
        b.engine().create_checkpoint(&key, false).unwrap();
    }
    let request = CheckpointRequest {
        received: Frontier::new(),
        initial: true,
    };
    let error = rpc::request_json(
        &network.connection,
        &network.a.config(),
        FrameKind::CheckpointRequest,
        &request,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "SYNC_UNREGISTERED");
    network.close().await;
}

#[tokio::test]
async fn active_connections_recheck_pause_and_revocation_for_each_request() {
    let network = Network::new(true).await;
    network
        .b
        .dispatch(|store| ReplicationEngine::new(store).set_paused(true))
        .await
        .unwrap();
    let frontier = ReplicaFrontier::default();
    assert_eq!(
        rpc::request_json(
            &network.connection,
            &network.a.config(),
            FrameKind::Frontier,
            &frontier
        )
        .await
        .err()
        .unwrap()
        .code,
        "SYNC_PAUSED"
    );
    network
        .b
        .dispatch(|store| ReplicationEngine::new(store).set_paused(false))
        .await
        .unwrap();
    rpc::request_json(
        &network.connection,
        &network.a.config(),
        FrameKind::Frontier,
        &frontier,
    )
    .await
    .unwrap();
    {
        let mut b = network.b.peer.lock().unwrap();
        let key = b.key.clone();
        b.engine()
            .authorize(
                AuthorityAction::Revoke {
                    device_id: network.a.config().origin.device_id,
                },
                &key,
            )
            .unwrap();
    }
    assert_eq!(
        rpc::request_json(
            &network.connection,
            &network.a.config(),
            FrameKind::ChangesRequest,
            &frontier
        )
        .await
        .err()
        .unwrap()
        .code,
        "SYNC_REVOKED"
    );
    network.close().await;
}

#[tokio::test]
async fn checkpoint_requests_are_signed_and_received_before_owner_publication() {
    let network = Network::new(true).await;
    {
        let mut b = network.b.peer.lock().unwrap();
        let edit = b.edit("checkpoint through QUIC", false);
        b.store.commit(&edit).unwrap();
        b.outgoing();
        let key = b.key.clone();
        b.engine().create_checkpoint(&key, true).unwrap();
    }
    let request = CheckpointRequest {
        received: Frontier::new(),
        initial: true,
    };
    let reply = rpc::request_json(
        &network.connection,
        &network.a.config(),
        FrameKind::CheckpointRequest,
        &request,
    )
    .await
    .unwrap();
    assert_eq!(reply.kind, FrameKind::Checkpoint);
    let signed = SignedContent {
        content: reply.content,
        signature: reply.signature.unwrap(),
    };
    let before = network.a.peer.lock().unwrap().note();
    network
        .a
        .dispatch(move |store| ReplicationEngine::new(store).receive_checkpoint(&signed))
        .await
        .unwrap();
    assert_eq!(network.a.peer.lock().unwrap().note(), before);
    network
        .a
        .dispatch(|store| {
            let mut engine = ReplicationEngine::new(store);
            let prepared = engine.prepare_next_checkpoint()?.unwrap();
            engine.commit_checkpoint(&prepared, None)
        })
        .await
        .unwrap();
    assert_eq!(
        network.a.peer.lock().unwrap().projection(),
        network.b.peer.lock().unwrap().projection()
    );
    network.close().await;
}
