//! Initial replication owns a fresh, unopened Workspace. Its public receipt is
//! resumable; invitation secrets and device keys remain in OS credentials.
use super::{
    ReplicaConfig, ReplicaMember, ReplicationEngine,
    authorization::{self, AuthorityGraph, PeerHello},
    direct::{DirectEndpoint, FrameKind},
    identity::{self, SyncCredentials},
    invitation, journal,
    owner::{OwnerFuture, ReplicationOwner},
    protocol::*,
    publication::PreparedPublication,
    rpc::{self, CheckpointRequest, RpcBudget, RpcSession},
};
use crate::{
    credentials::Credentials, document_model::ReadError, persistence::ProductStore,
    workspace_owner::WorkspaceLease,
};
use ed25519_dalek::SigningKey;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

const RECEIPT: &str = "replication_join";
const PREPARING: &str = "replication_join_preparing";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct JoinReceipt {
    config: ReplicaConfig,
    member: ReplicaMember,
    genesis: String,
    inviter: Origin,
    inviter_key: String,
    addresses: Vec<std::net::SocketAddr>,
    issued_at: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinView {
    pub path: PathBuf,
    pub phase: String,
    pub name: String,
    pub fingerprint: String,
    pub error: Option<ReadError>,
}
struct OwnedStore {
    store: ProductStore,
    _lease: WorkspaceLease,
}
pub(super) struct JoinOwner {
    inner: Arc<Mutex<OwnedStore>>,
}
impl ReplicationOwner for JoinOwner {
    fn dispatch<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut ProductStore) -> Result<T, ReadError> + Send + 'static,
    ) -> OwnerFuture<T> {
        let inner = self.inner.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut owner = inner
                    .lock()
                    .map_err(|_| error("SYNC_OWNER", "Initial receive owner is unavailable"))?;
                action(&mut owner.store)
            })
            .await
            .map_err(|_| error("SYNC_OWNER", "Initial receive owner failed"))?
        })
    }
    fn received(&self) {}
}
pub(super) fn prepare(
    path: &Path,
    connection_info: &str,
    name: &str,
    credentials: &dyn Credentials,
) -> Result<
    (
        JoinReceipt,
        Arc<JoinOwner>,
        SigningKey,
        Option<invitation::JoinClaim>,
    ),
    ReadError,
> {
    // A normal Workspace (including a restored backup) never enters this path.
    let internal = path.join(crate::data_area::INTERNAL_DIRECTORY);
    if internal.exists() {
        let db = internal.join("memoka.sqlite3");
        crate::read_service::plain_file(&db)?;
        let connection =
            rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let pending: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1) OR (EXISTS(SELECT 1 FROM settings WHERE key=?2) AND NOT EXISTS(SELECT 1 FROM documents) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='replication_config'))",
            [RECEIPT, PREPARING],
            |r| r.get(0),
        )?;
        if !pending {
            return Err(error(
                "SYNC_JOIN_DESTINATION",
                "Receive into a new empty directory; existing Workspaces cannot be merged",
            ));
        }
    } else {
        invitation::parse(connection_info, chrono::Utc::now().timestamp())?;
    }
    let path = crate::data_area::prepare_data_area(path)?;
    let lease = WorkspaceLease::acquire(&path)?;
    let store = crate::data_area::open_data_area(&path)?;
    let previous: Option<String> = store
        .connection
        .query_row("SELECT value FROM settings WHERE key=?1", [RECEIPT], |r| {
            r.get(0)
        })
        .optional()?;
    let receipt = if let Some(previous) = previous {
        serde_json::from_str::<JoinReceipt>(&previous)?
    } else {
        let populated: bool =
            store
                .connection
                .query_row("SELECT EXISTS(SELECT 1 FROM documents)", [], |r| r.get(0))?;
        if populated || journal::config(&store.connection)?.is_some() {
            return Err(error(
                "SYNC_JOIN_DESTINATION",
                "Initial receive cannot replace an existing Workspace",
            ));
        }
        let (invitation, _) = invitation::parse(connection_info, chrono::Utc::now().timestamp())?;
        // A failed key-store operation or name validation must leave this
        // fresh destination retryable without admitting any existing copy.
        store.connection.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')",
            [PREPARING],
        )?;
        let replica = store.manifest()?.replica_id;
        let member = identity::create(credentials, &invitation.group_id, &replica, name)?;
        let credential = identity::credential_id(&invitation.group_id, &member)?;
        let result: Result<JoinReceipt, ReadError> = (|| {
            credentials.set(&format!("{credential}/invitation"), connection_info)?;
            let receipt = JoinReceipt {
                config: ReplicaConfig {
                    workspace_id: invitation.workspace_id,
                    group_id: invitation.group_id,
                    origin: member.origin.clone(),
                    public_key: member.public_key.clone(),
                    paused: false,
                },
                member,
                genesis: invitation.genesis,
                inviter: invitation.inviter,
                inviter_key: invitation.public_key,
                addresses: invitation.addresses,
                issued_at: invitation.issued_at,
            };
            store.connection.execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)",
                params![RECEIPT, serde_json::to_string(&receipt)?],
            )?;
            store
                .connection
                .execute("DELETE FROM settings WHERE key=?1", [PREPARING])?;
            Ok(receipt)
        })();
        if result.is_err() {
            credentials.remove(&credential);
            credentials.remove(&format!("{credential}/invitation"));
        }
        result?
    };
    if store.manifest()?.replica_id != receipt.config.origin.replica_id {
        return Err(error(
            "SYNC_REPLICA_REUSE",
            "Initial receive receipt belongs to a different Workspace copy",
        ));
    }
    let key = identity::load(credentials, &receipt.config.group_id, &receipt.member)?;
    let claim = if journal::config(&store.connection)?.is_some() {
        None
    } else {
        let secret = zeroize::Zeroizing::new(credentials.get(&format!(
            "{}/invitation",
            identity::credential_id(&receipt.config.group_id, &receipt.member)?
        ))?);
        // Resending the same saved claim can recover an approval after expiry.
        // The inviter still checks expiry for all unapproved claims.
        let (invitation, signed) = invitation::parse(&secret, receipt.issued_at)?;
        if invitation.workspace_id != receipt.config.workspace_id
            || invitation.group_id != receipt.config.group_id
            || invitation.public_key != receipt.inviter_key
            || invitation.genesis != receipt.genesis
        {
            return Err(error(
                "SYNC_INVITE",
                "Saved invitation differs from this receive receipt",
            ));
        }
        Some(invitation::claim(
            &invitation,
            &signed,
            receipt.member.clone(),
            &key,
        )?)
    };
    Ok((
        receipt,
        Arc::new(JoinOwner {
            inner: Arc::new(Mutex::new(OwnedStore {
                store,
                _lease: lease,
            })),
        }),
        key,
        claim,
    ))
}

pub(super) fn accept_approval(
    store: &mut ProductStore,
    receipt: &JoinReceipt,
    hello: &PeerHello,
) -> Result<(), ReadError> {
    if hello.version != PROTOCOL_VERSION
        || hello.group_id != receipt.config.group_id
        || hello.workspace_id != receipt.config.workspace_id
        || hello.genesis != receipt.genesis
        || hello.origin != receipt.inviter
    {
        return Err(error(
            "SYNC_GROUP",
            "Approval does not match the pinned invitation",
        ));
    }
    let graph = AuthorityGraph::verify(&receipt.genesis, &receipt.config, &hello.records)?;
    let inviter = graph
        .members
        .get(&receipt.inviter.device_id)
        .filter(|m| {
            !m.revoked && m.origin == receipt.inviter && m.public_key == receipt.inviter_key
        })
        .ok_or_else(|| error("SYNC_REVOKED", "Inviting device is no longer authorized"))?;
    let candidate = graph
        .members
        .get(&receipt.member.origin.device_id)
        .filter(|m| !m.revoked && *m == &receipt.member)
        .ok_or_else(|| error("SYNC_UNREGISTERED", "This device has not been approved"))?;
    let existing = journal::config(&store.connection)?;
    if existing.as_ref().is_some_and(|c| c != &receipt.config) {
        return Err(error("SYNC_GROUP", "Destination belongs to another group"));
    }
    let tx = store.connection.transaction()?;
    authorization::persist(&tx, &graph)?;
    tx.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_config',?1)",
        [serde_json::to_string(&receipt.config)?],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('replica_id',?1)",
        [&candidate.origin.replica_id],
    )?;
    tx.execute("INSERT OR REPLACE INTO sync_peer_addresses(device_id,public_key,addresses) VALUES(?1,?2,?3)", params![inviter.origin.device_id,inviter.public_key,serde_json::to_string(&receipt.addresses)?])?;
    tx.commit()?;
    Ok(())
}
fn phase(view: &Arc<Mutex<JoinView>>, value: &str) {
    if let Ok(mut view) = view.lock() {
        view.phase = value.into();
        view.error = None;
    }
}
struct Server(tokio::task::JoinHandle<Result<(), ReadError>>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn receive(
    receipt: JoinReceipt,
    owner: Arc<JoinOwner>,
    key: SigningKey,
    claim: Option<invitation::JoinClaim>,
    view: Arc<Mutex<JoinView>>,
) -> Result<(), ReadError> {
    let bind = if receipt.addresses[0].is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let endpoint = DirectEndpoint::bind(&key, bind.parse().unwrap(), &receipt.addresses).await?;
    let result = async {
        phase(&view, "connecting");
        log::info!(
            target: "memoka::sync",
            "event=join-connect addresses={:?} inviter_key={}",
            receipt.addresses,
            &receipt.inviter_key[..12.min(receipt.inviter_key.len())]
        );
        let connection = endpoint.connect(&receipt.inviter_key, &receipt.addresses).await?;
        if let Some(claim) = claim {
            phase(&view, "approval");
            loop {
                let reply = rpc::request_json(&connection, &receipt.config, FrameKind::Join, &claim).await?;
                let status: rpc::JoinStatus = decode(&reply.content, FrameKind::JoinStatus.limit())?;
                if status.pending.member != receipt.member { return Err(error("SYNC_KEY", "Approval response changed the candidate identity")); }
                if let Some(hello) = status.hello {
                    let receipt = receipt.clone();
                    owner.dispatch(move |store| accept_approval(store, &receipt, &hello)).await?;
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        let session = Arc::new(RpcSession::new(owner.clone(), receipt.config.clone(), receipt.inviter_key.clone(), Arc::new(RpcBudget::default())));
        let server = Server(tokio::spawn(session.serve(connection.clone())));
        let hello = owner.dispatch(|store| ReplicationEngine::new(store).hello()).await?;
        let reply = rpc::request_json(&connection, &receipt.config, FrameKind::Hello, &hello).await?;
        let hello: PeerHello = decode(&reply.content, FrameKind::HelloReply.limit())?;
        let peer_key = receipt.inviter_key.clone();
        owner.dispatch(move |store| ReplicationEngine::new(store).authenticate_peer(&peer_key, &hello)).await?;
        phase(&view, "receiving");
        loop {
            // First recover a checkpoint persisted before an earlier shutdown.
            let root = owner.dispatch(|store| Ok(store.root.clone())).await?;
            let config = receipt.config.clone();
            let prepared = tokio::task::spawn_blocking(move || PreparedPublication::prepare(&root, &config)).await.map_err(|_| error("SYNC_JOIN", "Initial document validation failed"))??;
            if let Some(prepared) = prepared {
                phase(&view, "applying");
                let config = receipt.config.clone();
                owner.dispatch(move |store| prepared.commit(store, &config)).await?;
            }
            let complete = owner.dispatch(|store| {
                let Some(id) = store.manifest()?.active_workspace_id else { return Ok(false); };
                let workspace = store.load_document("workspace", &id)?;
                let namespace = crate::namespace::read_namespace(&workspace)?;
                for (id, metadata) in &namespace.notes {
                    if metadata["system_role"] == "help" {
                        store.connection.execute("INSERT OR IGNORE INTO sync_local_documents(document_id) VALUES(?1)", [id])?;
                    } else if !store.connection.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE kind='note' AND document_id=?1)", [id], |r| r.get::<_,bool>(0))? { return Ok(false); }
                }
                Ok(true)
            }).await?;
            if complete { break; }
            let reply = rpc::request_json(&connection, &receipt.config, FrameKind::CheckpointRequest, &CheckpointRequest { received: Frontier::new(), initial: true }).await?;
            match reply.kind {
                FrameKind::Checkpoint => {
                    let signed = SignedContent { content: reply.content, signature: reply.signature.ok_or_else(|| error("SYNC_SIGNATURE", "Initial checkpoint is not signed"))? };
                    owner.dispatch(move |store| ReplicationEngine::new(store).receive_checkpoint(&signed)).await?;
                }
                FrameKind::Authority => {
                    let records: Vec<SignedContent> = decode(&reply.content, reply.kind.limit())?;
                    let inviter = receipt.inviter.clone();
                    owner.dispatch(move |store| ReplicationEngine::new(store).receive_authorizations(&inviter, &records)).await?;
                }
                FrameKind::Frontier => tokio::time::sleep(Duration::from_millis(500)).await,
                _ => return Err(error("SYNC_PROTOCOL", "Expected an initial checkpoint")),
            }
        }
        connection.close();
        server.0.abort();
        while Arc::strong_count(&owner.inner) > 1 { tokio::time::sleep(Duration::from_millis(10)).await; }
        owner.dispatch(|store| { store.connection.execute("DELETE FROM settings WHERE key=?1", [RECEIPT])?; Ok(()) }).await?;
        Ok(())
    }.await;
    endpoint.close().await;
    result
}

#[derive(Default)]
pub struct JoinRuntime {
    job: tokio::sync::Mutex<Option<JoinJob>>,
}
struct JoinJob {
    task: tokio::task::JoinHandle<()>,
    view: Arc<Mutex<JoinView>>,
    cancel: tokio::sync::watch::Sender<bool>,
}
impl Drop for JoinJob {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        self.task.abort();
    }
}

#[tauri::command]
pub async fn sync_join_start(
    app: tauri::AppHandle,
    path: PathBuf,
    connection_info: String,
    name: String,
) -> Result<JoinView, ReadError> {
    let state = app.state::<JoinRuntime>();
    let mut job = state.job.lock().await;
    if job.as_ref().is_some_and(|job| !job.task.is_finished()) {
        return Err(error(
            "SYNC_JOIN_BUSY",
            "An initial receive is already running",
        ));
    }
    let destination = path.clone();
    let (receipt, owner, key, claim) = tokio::task::spawn_blocking(move || {
        prepare(&destination, &connection_info, &name, &SyncCredentials)
    })
    .await
    .map_err(|_| error("SYNC_JOIN", "Cannot prepare initial receive"))??;
    let view = JoinView {
        path,
        phase: "connecting".into(),
        name: receipt.member.name.clone(),
        fingerprint: identity::fingerprint(&receipt.member.public_key)?,
        error: None,
    };
    let shared = Arc::new(Mutex::new(view.clone()));
    let progress = shared.clone();
    let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let credential = identity::credential_id(&receipt.config.group_id, &receipt.member).ok();
        let receiving = async {
            let mut attempts = 0_u32;
            loop {
                let result = receive(
                    receipt.clone(),
                    owner.clone(),
                    key.clone(),
                    claim.clone(),
                    progress.clone(),
                )
                .await;
                let failure = match result {
                    Ok(()) => return Ok(()),
                    Err(failure) => failure,
                };
                if !matches!(
                    failure.code.as_str(),
                    "SYNC_CONNECT"
                        | "SYNC_TIMEOUT"
                        | "SYNC_DISCONNECTED"
                        | "SYNC_FRAME"
                        | "SYNC_RECONNECT"
                ) {
                    return Err(failure);
                }
                if let Ok(mut view) = progress.lock() {
                    view.phase = "retrying".into();
                    view.error = Some(failure);
                }
                attempts = attempts.saturating_add(1).min(5);
                tokio::time::sleep(Duration::from_secs((1_u64 << attempts).min(30))).await;
            }
        };
        let result = tokio::select! {
            result = receiving => Some(result),
            _ = cancelled.changed() => None,
        };
        // Cancellation drops network work immediately, then drains already
        // dispatched local transactions before releasing the directory lease.
        while Arc::strong_count(&owner.inner) > 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(owner); // Release the private owner before the GUI opens this copy.
        if let Ok(mut view) = progress.lock() {
            match result {
                Some(Ok(())) => {
                    view.phase = "ready".into();
                    view.error = None;
                    if let Some(id) = credential {
                        SyncCredentials.remove(&format!("{id}/invitation"));
                    }
                }
                Some(Err(failure)) => {
                    view.phase = "error".into();
                    view.error = Some(failure);
                }
                None => {}
            }
        }
    });
    *job = Some(JoinJob {
        task,
        view: shared,
        cancel,
    });
    Ok(view)
}
#[tauri::command]
pub async fn sync_join_status(app: tauri::AppHandle) -> Result<Option<JoinView>, ReadError> {
    let state = app.state::<JoinRuntime>();
    let job = state.job.lock().await;
    job.as_ref()
        .map(|job| {
            job.view
                .lock()
                .map(|v| v.clone())
                .map_err(|_| error("SYNC_JOIN", "Initial receive status is unavailable"))
        })
        .transpose()
}
#[tauri::command]
pub async fn sync_join_stop(app: tauri::AppHandle) {
    let state = app.state::<JoinRuntime>();
    let mut job = state.job.lock().await;
    if let Some(mut previous) = job.take() {
        let _ = previous.cancel.send(true);
        let _ = (&mut previous.task).await;
    }
}
