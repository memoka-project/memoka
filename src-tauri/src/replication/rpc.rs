//! Authenticated direct requests only persist inbox/authorization state. They
//! never call commit_prepared/commit_checkpoint or change a live Editor.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

use serde::{Deserialize, Serialize};

use super::{
    ReplicaConfig, ReplicationEngine,
    authorization::PeerHello,
    direct::{DeliveryEnvelope, DirectConnection, FrameKind, IncomingFrame},
    invitation::{JoinClaim, PendingDevice},
    journal,
    owner::ReplicationOwner,
    protocol::*,
};
use crate::document_model::ReadError;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRequest {
    pub sha256: String,
    pub offset: u64,
    pub length: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRequest {
    pub received: Frontier,
    pub initial: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinStatus {
    pub pending: PendingDevice,
    pub hello: Option<PeerHello>,
}

pub struct RpcReply {
    pub kind: FrameKind,
    pub content: Vec<u8>,
    pub signature: Option<String>,
}
impl RpcReply {
    fn json(kind: FrameKind, value: &impl Serialize) -> Result<Self, ReadError> {
        Ok(Self {
            kind,
            content: serde_json::to_vec(value)?,
            signature: None,
        })
    }
    fn signed(kind: FrameKind, signed: SignedContent) -> Self {
        Self {
            kind,
            content: signed.content,
            signature: Some(signed.signature),
        }
    }
}

/// Shared across the Workspace, including unauthenticated connection attempts.
pub struct RpcBudget {
    streams: Arc<tokio::sync::Semaphore>,
    handshakes: Arc<tokio::sync::Semaphore>,
    bulk_mebibytes: Arc<tokio::sync::Semaphore>,
}
impl Default for RpcBudget {
    fn default() -> Self {
        Self {
            streams: Arc::new(tokio::sync::Semaphore::new(32)),
            handshakes: Arc::new(tokio::sync::Semaphore::new(2)),
            bulk_mebibytes: Arc::new(tokio::sync::Semaphore::new(256)),
        }
    }
}

pub struct RpcSession<O: ReplicationOwner> {
    send_schedule: Option<Arc<Mutex<super::send_schedule::SendSchedule>>>,
    owner: Arc<O>,
    config: ReplicaConfig,
    public_key: String,
    peer: Mutex<Option<Origin>>,
    authenticated: tokio::sync::Notify,
    advertised_authority: Arc<AtomicI64>,
    budget: Arc<RpcBudget>,
}
impl<O: ReplicationOwner> RpcSession<O> {
    pub fn new(
        owner: Arc<O>,
        config: ReplicaConfig,
        public_key: String,
        budget: Arc<RpcBudget>,
    ) -> Self {
        Self {
            send_schedule: None,
            owner,
            config,
            public_key,
            peer: Mutex::new(None),
            authenticated: tokio::sync::Notify::new(),
            advertised_authority: Arc::new(AtomicI64::new(0)),
            budget,
        }
    }

    pub(super) fn with_send_schedule(
        mut self,
        schedule: Arc<Mutex<super::send_schedule::SendSchedule>>,
    ) -> Self {
        self.send_schedule = Some(schedule);
        self
    }

    pub async fn authenticated_peer(&self) -> Result<Origin, ReadError> {
        loop {
            let notification = self.authenticated.notified();
            if let Some(peer) = self
                .peer
                .lock()
                .map_err(|_| error("SYNC_OWNER", "Connection state is unavailable"))?
                .clone()
            {
                return Ok(peer);
            }
            notification.await;
        }
    }

    pub async fn serve(self: Arc<Self>, connection: DirectConnection) -> Result<(), ReadError> {
        let mut tasks = tokio::task::JoinSet::new();
        // accept_request also reads the header after accepting a stream. Keep
        // that future alive when another handler finishes, otherwise select!
        // drops the partially read stream and resets a valid peer request.
        let accepting = connection.accept_request();
        tokio::pin!(accepting);
        loop {
            tokio::select! {
                frame = &mut accepting, if tasks.len() < 8 => {
                    let frame = frame?;
                    accepting.set(connection.accept_request());
                    let session = self.clone();
                    tasks.spawn(async move { session.respond(frame).await });
                }
                result = tasks.join_next(), if !tasks.is_empty() => {
                    result.ok_or_else(|| error("SYNC_STOPPED", "Connection handler stopped"))?
                        .map_err(|_| error("SYNC_PROTOCOL", "Connection handler failed"))??;
                }
            }
        }
    }

    async fn respond(&self, mut frame: IncomingFrame) -> Result<(), ReadError> {
        let reply = self.handle(&mut frame).await;
        let (reply, close) = match reply {
            Ok(reply) => (reply, false),
            Err(failure) => {
                self.owner.received();
                let close = matches!(
                    failure.code.as_str(),
                    "SYNC_REVOKED" | "SYNC_KEY" | "SYNC_GROUP" | "SYNC_UNREGISTERED"
                );
                (RpcReply::json(FrameKind::Error, &failure)?, close)
            }
        };
        let header = DeliveryEnvelope::new(
            &self.config.group_id,
            &self.config.workspace_id,
            reply.kind,
            &reply.content,
            reply.signature,
        );
        frame.reply(&header, &reply.content).await?;
        if close {
            return Err(error("SYNC_UNREGISTERED", "Connection is not authorized"));
        }
        Ok(())
    }

    async fn handle(&self, frame: &mut IncomingFrame) -> Result<RpcReply, ReadError> {
        if frame.header.group_id != self.config.group_id
            || frame.header.workspace_id != self.config.workspace_id
        {
            return Err(error(
                "SYNC_GROUP",
                "Request belongs to another group or Workspace",
            ));
        }
        let _stream = self
            .budget
            .streams
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| error("SYNC_STOPPED", "Synchronization stopped"))?;
        let kind = frame.header.kind;
        let is_hello = matches!(kind, FrameKind::Hello | FrameKind::Join);
        if !is_hello {
            let peer = self
                .peer
                .lock()
                .map_err(|_| error("SYNC_OWNER", "Connection state is unavailable"))?
                .clone()
                .ok_or_else(|| {
                    error(
                        "SYNC_UNREGISTERED",
                        "Authenticate before exchanging document data",
                    )
                })?;
            let key = self.public_key.clone();
            let config = self.config.clone();
            self.owner
                .dispatch(move |store| check_peer(store, &config, &peer, &key))
                .await?;
        }
        let _handshake = if is_hello {
            Some(
                self.budget
                    .handshakes
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| error("SYNC_STOPPED", "Synchronization stopped"))?,
            )
        } else {
            None
        };
        let _bulk = if frame.header.length > 64 * 1024 && !is_hello {
            Some(
                self.budget
                    .bulk_mebibytes
                    .clone()
                    .acquire_many_owned(frame.header.length.div_ceil(1024 * 1024) as u32)
                    .await
                    .map_err(|_| error("SYNC_STOPPED", "Synchronization stopped"))?,
            )
        } else {
            None
        };
        let content = frame.content().await?;
        let signature = frame.header.signature.clone();
        let key = self.public_key.clone();
        let config = self.config.clone();
        if kind == FrameKind::Hello {
            let hello: PeerHello = decode(&content, kind.limit())?;
            let (peer, hello, revision) = self
                .owner
                .dispatch(move |store| {
                    let mut engine = ReplicationEngine::new(store);
                    let peer = engine.authenticate_peer(&key, &hello)?;
                    Ok((
                        peer.origin,
                        engine.hello()?,
                        authority_revision(&engine.store.connection)?,
                    ))
                })
                .await?;
            *self
                .peer
                .lock()
                .map_err(|_| error("SYNC_OWNER", "Connection state is unavailable"))? = Some(peer);
            self.advertised_authority.store(revision, Ordering::Release);
            self.authenticated.notify_waiters();
            self.owner.received();
            return RpcReply::json(FrameKind::HelloReply, &hello);
        }
        if kind == FrameKind::Join {
            let claim: JoinClaim = decode(&content, kind.limit())?;
            let status = self
                .owner
                .dispatch(move |store| {
                    let mut engine = ReplicationEngine::new(store);
                    let pending =
                        engine.claim_invitation(&claim, &key, chrono::Utc::now().timestamp())?;
                    let hello = if pending.approved {
                        Some(engine.hello()?)
                    } else {
                        None
                    };
                    Ok(JoinStatus { pending, hello })
                })
                .await?;
            self.owner.received();
            return RpcReply::json(FrameKind::JoinStatus, &status);
        }
        let peer = self
            .peer
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Connection state is unavailable"))?
            .clone()
            .ok_or_else(|| error("SYNC_UNREGISTERED", "Connection is not authenticated"))?;
        let advertised = self.advertised_authority.clone();
        if matches!(kind, FrameKind::Batch | FrameKind::Checkpoint) {
            let signed = SignedContent {
                content,
                signature: signature.ok_or_else(|| {
                    error("SYNC_SIGNATURE", "Signed content requires a signature")
                })?,
            };
            let frontier =
                super::inbox::receive(self.owner.clone(), config, peer, key, kind, signed).await?;
            self.owner.received();
            return RpcReply::json(FrameKind::Frontier, &frontier);
        }
        let send_schedule = self.send_schedule.clone();
        let reply = self
            .owner
            .dispatch(move |store| {
                // Recheck after a possibly long content transfer or local pause.
                check_peer(store, &config, &peer, &key)?;
                let mut engine = ReplicationEngine::new(store);
                // A newly authorized issuer's records must arrive before its
                // forwarded changes. An immutable SQL row watermark avoids
                // verifying the whole authorization graph on every idle poll.
                if matches!(
                    kind,
                    FrameKind::ChangesRequest | FrameKind::CheckpointRequest
                ) {
                    let revision = authority_revision(&engine.store.connection)?;
                    if advertised.load(Ordering::Acquire) != revision {
                        let records = engine.authority()?.records();
                        advertised.store(revision, Ordering::Release);
                        return RpcReply::json(FrameKind::Authority, &records);
                    }
                }
                match kind {
                    FrameKind::Frontier | FrameKind::ChangesRequest => {
                        let frontier: ReplicaFrontier = decode(&content, kind.limit())?;
                        observe_frontier(&mut engine, &peer, &frontier)?;
                        let local = journal::frontiers(&engine.store.connection)?
                            .applied
                            .get(&config.origin.replica_id)
                            .copied()
                            .unwrap_or(0);
                        let released = if let Some(schedule) = &send_schedule {
                            schedule
                                .lock()
                                .map_err(|_| {
                                    error("SYNC_OWNER", "Delivery schedule is unavailable")
                                })?
                                .observe(tokio::time::Instant::now(), local)
                        } else {
                            MAX_COUNTER
                        };
                        if kind == FrameKind::ChangesRequest
                            && let Some(signed) = engine
                                .outgoing_released(&frontier.received, 1, released)?
                                .into_iter()
                                .next()
                        {
                            return Ok(RpcReply::signed(FrameKind::Batch, signed));
                        }
                        RpcReply::json(FrameKind::Frontier, &engine.status()?.frontier)
                    }
                    FrameKind::CheckpointRequest => {
                        let request: CheckpointRequest = decode(&content, kind.limit())?;
                        validate_frontier(&request.received)?;
                        let checkpoint = if request.initial {
                            engine.initial_checkpoint()?
                        } else {
                            engine.checkpoint_for(&request.received)?
                        };
                        match checkpoint {
                            Some(signed) => {
                                if let Some(schedule) = &send_schedule {
                                    schedule
                                        .lock()
                                        .map_err(|_| {
                                            error("SYNC_OWNER", "Delivery schedule is unavailable")
                                        })?
                                        .release_all();
                                }
                                Ok(RpcReply::signed(FrameKind::Checkpoint, signed))
                            }
                            None => RpcReply::json(FrameKind::Frontier, &engine.status()?.frontier),
                        }
                    }
                    FrameKind::AttachmentRequest => {
                        let request: AttachmentRequest = decode(&content, kind.limit())?;
                        Ok(RpcReply {
                            kind: FrameKind::AttachmentChunk,
                            content: engine.attachment_chunk(
                                &request.sha256,
                                request.offset,
                                request.length,
                            )?,
                            signature: None,
                        })
                    }
                    FrameKind::Authority => {
                        let records: Vec<SignedContent> = decode(&content, kind.limit())?;
                        engine.receive_authorizations(&peer, &records)?;
                        RpcReply::json(FrameKind::Frontier, &engine.status()?.frontier)
                    }
                    _ => Err(error("SYNC_PROTOCOL", "Unexpected request kind")),
                }
            })
            .await?;
        if matches!(
            kind,
            FrameKind::Batch | FrameKind::Checkpoint | FrameKind::Authority
        ) {
            self.owner.received();
        }
        Ok(reply)
    }
}

pub(super) fn check_peer(
    store: &crate::persistence::ProductStore,
    expected: &ReplicaConfig,
    peer: &Origin,
    key: &str,
) -> Result<(), ReadError> {
    let config = journal::required_config(&store.connection)?;
    if config.workspace_id != expected.workspace_id
        || config.group_id != expected.group_id
        || config.origin != expected.origin
    {
        return Err(error(
            "SYNC_GROUP",
            "Workspace synchronization group changed",
        ));
    }
    if config.paused {
        return Err(error("SYNC_PAUSED", "Device synchronization is paused"));
    }
    journal::member(&store.connection, &config.origin, false)?;
    let member = journal::member(&store.connection, peer, false)?;
    if member.public_key != key {
        return Err(error(
            "SYNC_KEY",
            "Connection does not match the registered key",
        ));
    }
    Ok(())
}

fn authority_revision(connection: &rusqlite::Connection) -> Result<i64, ReadError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM sync_authorizations",
            [],
            |r| r.get(0),
        )
        .map_err(Into::into)
}

/// A peer can know third-party changes we have not received. Such positions
/// are exchange hints; only locally known positions are stored as delivery ACKs.
pub(super) fn observe_frontier(
    engine: &mut ReplicationEngine<'_>,
    peer: &Origin,
    value: &ReplicaFrontier,
) -> Result<(), ReadError> {
    validate_frontier(&value.received)?;
    validate_frontier(&value.applied)?;
    for (replica, applied) in &value.applied {
        if *applied > value.received.get(replica).copied().unwrap_or(0) {
            return Err(error(
                "SYNC_FRONTIER",
                "Applied frontier exceeds received frontier",
            ));
        }
    }
    let known = engine.status()?.frontier;
    let config = journal::required_config(&engine.store.connection)?;
    if value
        .received
        .get(&config.origin.replica_id)
        .copied()
        .unwrap_or(0)
        > known
            .received
            .get(&config.origin.replica_id)
            .copied()
            .unwrap_or(0)
    {
        return Err(error(
            "SYNC_REPLICA_REUSE",
            "Peer has unknown changes from this Workspace copy",
        ));
    }
    let clamp = |source: &Frontier| {
        source
            .iter()
            .filter_map(|(replica, sequence)| {
                let sequence = (*sequence).min(known.received.get(replica).copied().unwrap_or(0));
                (sequence > 0).then(|| (replica.clone(), sequence))
            })
            .collect()
    };
    engine.acknowledge(
        &peer.device_id,
        &ReplicaFrontier {
            received: clamp(&value.received),
            applied: clamp(&value.applied),
        },
    )
}

pub async fn request_json<T: Serialize>(
    connection: &DirectConnection,
    config: &ReplicaConfig,
    kind: FrameKind,
    value: &T,
) -> Result<RpcReply, ReadError> {
    request(connection, config, kind, &serde_json::to_vec(value)?, None).await
}
pub async fn request(
    connection: &DirectConnection,
    config: &ReplicaConfig,
    kind: FrameKind,
    content: &[u8],
    signature: Option<String>,
) -> Result<RpcReply, ReadError> {
    let header = DeliveryEnvelope::new(
        &config.group_id,
        &config.workspace_id,
        kind,
        content,
        signature,
    );
    let (reply, content) = connection.request(&header, content).await?;
    if reply.group_id != config.group_id || reply.workspace_id != config.workspace_id {
        return Err(error(
            "SYNC_GROUP",
            "Response belongs to another Workspace or group",
        ));
    }
    if reply.kind == FrameKind::Error {
        return Err(decode(&content, FrameKind::Error.limit())?);
    }
    Ok(RpcReply {
        kind: reply.kind,
        content,
        signature: reply.signature,
    })
}
