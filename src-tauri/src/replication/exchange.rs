//! Transport workers exchange immutable changes through the owner. Publishing
//! into documents is exclusively the separate GUI save/publication boundary.
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use super::{
    ReplicaConfig, ReplicationEngine, SyncStatus,
    authorization::PeerHello,
    direct::{DirectConnection, FrameKind},
    journal::now,
    owner::ReplicationOwner,
    protocol::*,
    rpc::{self, AttachmentRequest, CheckpointRequest, RpcBudget, RpcSession},
};
use crate::document_model::ReadError;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerProgress {
    pub connected: bool,
    pub exchanging: bool,
    pub checkpoint: bool,
    pub attachments: bool,
    pub last_contact_at: Option<String>,
    pub frontier: ReplicaFrontier,
    pub error: Option<ReadError>,
}

pub struct ExchangeState {
    pub(super) send_schedule: Arc<Mutex<super::send_schedule::SendSchedule>>,
    pub(crate) background_error: Mutex<Option<ReadError>>,
    peers: Mutex<BTreeMap<String, PeerProgress>>,
    live: Mutex<BTreeMap<String, usize>>,
    pub(crate) wake: tokio::sync::Notify,
    pub(crate) reconnect: tokio::sync::Notify,
    pub(crate) attachment: tokio::sync::Semaphore,
    checkpoint: tokio::sync::Semaphore,
    batch: tokio::sync::Semaphore,
}
impl Default for ExchangeState {
    fn default() -> Self {
        Self {
            send_schedule: Arc::new(Mutex::new(Default::default())),
            background_error: Mutex::new(None),
            peers: Mutex::new(BTreeMap::new()),
            live: Mutex::new(BTreeMap::new()),
            wake: tokio::sync::Notify::new(),
            reconnect: tokio::sync::Notify::new(),
            attachment: tokio::sync::Semaphore::new(1),
            checkpoint: tokio::sync::Semaphore::new(1),
            batch: tokio::sync::Semaphore::new(2),
        }
    }
}
impl ExchangeState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn snapshot(&self) -> BTreeMap<String, PeerProgress> {
        self.peers.lock().map(|p| p.clone()).unwrap_or_default()
    }
    pub fn admit(&self, key: &str) {
        if let Ok(mut peers) = self.peers.lock() {
            if peers.len() < MAX_MEMBERS {
                peers.entry(key.into()).or_default();
            }
        }
    }
    fn connected(&self, key: &str, joined: bool) {
        if let Ok(mut live) = self.live.lock() {
            let count = live.entry(key.into()).or_default();
            *count = if joined {
                count.saturating_add(1)
            } else {
                count.saturating_sub(1)
            };
            self.update(key, |p| p.connected = *count > 0);
        }
    }
    pub fn update(&self, key: &str, change: impl FnOnce(&mut PeerProgress)) {
        if let Ok(mut peers) = self.peers.lock() {
            if let Some(peer) = peers.get_mut(key) {
                change(peer);
            }
        }
    }
}

struct Exchange<O: ReplicationOwner> {
    owner: Arc<O>,
    config: ReplicaConfig,
    connection: DirectConnection,
    peer: Origin,
    state: Arc<ExchangeState>,
    checkpoint_needed: tokio::sync::Notify,
}
impl<O: ReplicationOwner> Exchange<O> {
    async fn local(&self) -> Result<SyncStatus, ReadError> {
        let config = self.config.clone();
        let key = self.connection.public_key();
        let peer = self.peer.clone();
        self.owner
            .dispatch(move |store| {
                rpc::check_peer(store, &config, &peer, &key)?;
                ReplicationEngine::new(store).status()
            })
            .await
    }
    async fn accept(&self, reply: rpc::RpcReply) -> Result<bool, ReadError> {
        let peer = self.peer.clone();
        let key = self.connection.public_key();
        let config = self.config.clone();
        let kind = reply.kind;
        if matches!(kind, FrameKind::Batch | FrameKind::Checkpoint) {
            let before = self.local().await?.frontier;
            let signed = SignedContent {
                content: reply.content,
                signature: reply
                    .signature
                    .ok_or_else(|| error("SYNC_SIGNATURE", "Missing content signature"))?,
            };
            let frontier =
                super::inbox::receive(self.owner.clone(), config, peer, key, kind, signed).await?;
            self.owner.received();
            return Ok(before.received != frontier.received);
        }
        let (changed, frontier) = self
            .owner
            .dispatch(move |store| {
                rpc::check_peer(store, &config, &peer, &key)?;
                let mut engine = ReplicationEngine::new(store);
                let before = engine.status()?.frontier;
                match reply.kind {
                    FrameKind::Frontier => {
                        let frontier: ReplicaFrontier = decode(&reply.content, kind.limit())?;
                        rpc::observe_frontier(&mut engine, &peer, &frontier)?;
                        let gap = frontier.applied.iter().any(|(replica, sequence)| {
                            before.received.get(replica).copied().unwrap_or(0) < *sequence
                        });
                        Ok((gap, Some(frontier)))
                    }
                    FrameKind::Authority => {
                        let records: Vec<SignedContent> = decode(&reply.content, kind.limit())?;
                        engine.receive_authorizations(&peer, &records)?;
                        Ok((true, None))
                    }
                    _ => Err(error("SYNC_PROTOCOL", "Unexpected exchange response")),
                }
            })
            .await?;
        if let Some(frontier) = frontier {
            if changed {
                self.checkpoint_needed.notify_one();
            }
            self.state
                .update(&self.connection.public_key(), |progress| {
                    progress.frontier = frontier;
                    progress.last_contact_at = Some(now());
                });
        } else {
            self.owner.received();
        }
        // Frontier differences wake checkpoints but must not busy-loop the
        // small-change worker while compaction or an offline author is pending.
        Ok(changed && kind != FrameKind::Frontier)
    }
    async fn changes(&self) -> Result<(), ReadError> {
        loop {
            let local = self.local().await?;
            let permit = self
                .state
                .batch
                .acquire()
                .await
                .map_err(|_| error("SYNC_STOPPED", "Change worker stopped"))?;
            self.state
                .update(&self.connection.public_key(), |p| p.exchanging = true);
            let reply = rpc::request_json(
                &self.connection,
                &self.config,
                FrameKind::ChangesRequest,
                &local.frontier,
            )
            .await?;
            let kind = reply.kind;
            let changed = self.accept(reply).await?;
            drop(permit);
            self.state
                .update(&self.connection.public_key(), |p| p.exchanging = false);
            if kind == FrameKind::Batch && !changed {
                self.checkpoint_needed.notify_one();
            }
            // A gap/deletion-only batch may leave the received frontier intact.
            // Avoid spinning on that same durable receipt while its checkpoint
            // or dependencies are still in transit.
            if !changed {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                    _ = self.state.wake.notified() => {},
                }
            }
        }
    }
    async fn checkpoints(&self) -> Result<(), ReadError> {
        loop {
            let local = self.local().await?;
            let permit = self
                .state
                .checkpoint
                .acquire()
                .await
                .map_err(|_| error("SYNC_STOPPED", "Checkpoint worker stopped"))?;
            self.state
                .update(&self.connection.public_key(), |p| p.checkpoint = true);
            let reply = rpc::request_json(
                &self.connection,
                &self.config,
                FrameKind::CheckpointRequest,
                &CheckpointRequest {
                    received: local.frontier.received,
                    initial: false,
                },
            )
            .await?;
            let authority = reply.kind == FrameKind::Authority;
            self.accept(reply).await?;
            drop(permit);
            self.state
                .update(&self.connection.public_key(), |p| p.checkpoint = false);
            if authority {
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {},
                _ = self.checkpoint_needed.notified() => {},
            }
        }
    }
    async fn attachments(&self) -> Result<(), ReadError> {
        let mut unavailable = BTreeMap::new();
        loop {
            self.local().await?;
            let _permit = self
                .state
                .attachment
                .acquire()
                .await
                .map_err(|_| error("SYNC_STOPPED", "Attachment worker stopped"))?;
            let candidates = self
                .owner
                .dispatch(|store| ReplicationEngine::new(store).pending_attachments(64))
                .await?;
            let instant = tokio::time::Instant::now();
            unavailable.retain(|_, retry| *retry > instant);
            let candidate = candidates
                .into_iter()
                .find(|item| item.error.is_none() && !unavailable.contains_key(&item.sha256));
            let Some(candidate) = candidate else {
                drop(_permit);
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            };
            self.state
                .update(&self.connection.public_key(), |p| p.attachments = true);
            let hash = candidate.sha256.clone();
            let prepared = self
                .owner
                .dispatch(move |store| ReplicationEngine::new(store).prepare_attachment_file(&hash))
                .await?;
            if prepared.object_exists() {
                let publication = tokio::task::spawn_blocking(move || prepared.publish(None))
                    .await
                    .map_err(|_| error("SYNC_ATTACHMENT", "Attachment verification failed"))?;
                self.owner
                    .dispatch(move |store| publication.commit(store, None))
                    .await?;
                self.state
                    .update(&self.connection.public_key(), |p| p.attachments = false);
                self.owner.received();
                continue;
            }
            let hash = candidate.sha256.clone();
            let current = self
                .owner
                .dispatch(move |store| ReplicationEngine::new(store).begin_attachment(&hash))
                .await?;
            if current.complete || current.error.is_some() {
                self.state
                    .update(&self.connection.public_key(), |p| p.attachments = false);
                continue;
            }
            let request = AttachmentRequest {
                sha256: current.sha256.clone(),
                offset: current.received,
                length: (current.size - current.received)
                    .min(super::attachments::ATTACHMENT_CHUNK_BYTES as u64)
                    as usize,
            };
            if request.length > 0 {
                let reply = match rpc::request_json(
                    &self.connection,
                    &self.config,
                    FrameKind::AttachmentRequest,
                    &request,
                )
                .await
                {
                    Ok(reply) => reply,
                    Err(failure)
                        if matches!(
                            failure.code.as_str(),
                            "NOT_FOUND" | "IO" | "SYNC_ATTACHMENT" | "SYNC_ATTACHMENT_MISSING"
                        ) =>
                    {
                        unavailable.insert(current.sha256, instant + Duration::from_secs(10));
                        self.state.update(&self.connection.public_key(), |p| {
                            p.attachments = false;
                            p.error = Some(failure);
                        });
                        continue;
                    }
                    Err(failure) => return Err(failure),
                };
                if reply.content.len() != request.length {
                    return Err(error(
                        "SYNC_ATTACHMENT_SIZE",
                        "Attachment response length differs from request",
                    ));
                }
                let hash = current.sha256.clone();
                let offset = current.received;
                self.owner
                    .dispatch(move |store| {
                        ReplicationEngine::new(store).write_attachment_chunk(
                            &hash,
                            offset,
                            &reply.content,
                            None,
                        )
                    })
                    .await?;
            }
            if current.received + request.length as u64 == current.size {
                let hash = current.sha256;
                let prepared = self
                    .owner
                    .dispatch(move |store| {
                        ReplicationEngine::new(store).prepare_attachment_file(&hash)
                    })
                    .await?;
                let publication = tokio::task::spawn_blocking(move || prepared.publish(None))
                    .await
                    .map_err(|_| error("SYNC_ATTACHMENT", "Attachment verification failed"))?;
                self.owner
                    .dispatch(move |store| publication.commit(store, None))
                    .await?;
                self.owner.received();
            }
            self.state
                .update(&self.connection.public_key(), |p| p.attachments = false);
        }
    }
}

/// Both directions serve authenticated requests and pull independently. No
/// designated leader or direct connection to each change's issuer is needed.
pub async fn run<O: ReplicationOwner>(
    owner: Arc<O>,
    config: ReplicaConfig,
    connection: DirectConnection,
    outgoing: bool,
    budget: Arc<RpcBudget>,
    state: Arc<ExchangeState>,
) -> Result<(), ReadError> {
    let key = connection.public_key();
    struct Close<O: ReplicationOwner> {
        connection: DirectConnection,
        owner: Arc<O>,
        state: Arc<ExchangeState>,
        authenticated: Arc<AtomicBool>,
    }
    impl<O: ReplicationOwner> Drop for Close<O> {
        fn drop(&mut self) {
            self.connection.close();
            if self.authenticated.load(Ordering::Acquire) {
                self.state.connected(&self.connection.public_key(), false);
            }
            self.state.update(&self.connection.public_key(), |p| {
                p.exchanging = false;
                p.checkpoint = false;
                p.attachments = false;
            });
            self.owner.received();
        }
    }
    let authenticated = Arc::new(AtomicBool::new(false));
    let _close = Close {
        connection: connection.clone(),
        owner: owner.clone(),
        state: state.clone(),
        authenticated: authenticated.clone(),
    };
    let session = Arc::new(
        RpcSession::new(owner.clone(), config.clone(), key.clone(), budget)
            .with_send_schedule(state.send_schedule.clone()),
    );
    let exchange = async {
        if !outgoing {
            tokio::time::timeout(Duration::from_secs(600), session.authenticated_peer())
                .await
                .map_err(|_| error("SYNC_TIMEOUT", "Device approval timed out"))??;
        }
        let hello = owner
            .dispatch(|store| ReplicationEngine::new(store).hello())
            .await?;
        let reply = rpc::request_json(&connection, &config, FrameKind::Hello, &hello).await?;
        let hello: PeerHello = decode(&reply.content, FrameKind::HelloReply.limit())?;
        let remote_key = key.clone();
        let peer = owner
            .dispatch(move |store| {
                ReplicationEngine::new(store).authenticate_peer(&remote_key, &hello)
            })
            .await?;
        state.admit(&key);
        state.connected(&key, true);
        state
            .send_schedule
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Delivery schedule is unavailable"))?
            .release_all();
        authenticated.store(true, Ordering::Release);
        state.update(&key, |p| {
            p.error = None;
            p.last_contact_at = Some(now());
        });
        owner.received();
        let workers = Exchange {
            owner: owner.clone(),
            config,
            connection: connection.clone(),
            peer: peer.origin,
            state: state.clone(),
            checkpoint_needed: tokio::sync::Notify::new(),
        };
        tokio::select! {
            result = workers.changes() => result,
            result = workers.checkpoints() => result,
            result = workers.attachments() => result,
        }
    };
    let result = tokio::select! {
        result = session.clone().serve(connection.clone()) => result,
        result = exchange => result,
    };
    connection.close();
    state.update(&key, |p| {
        p.exchanging = false;
        p.checkpoint = false;
        p.attachments = false;
        p.error = result.as_ref().err().cloned();
    });
    owner.received();
    result
}
