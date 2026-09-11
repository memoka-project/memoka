//! Workspace lifetime, reconnect scheduling and explicit local device actions.
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use ed25519_dalek::SigningKey;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::{
    ReplicaConfig, ReplicaMember, ReplicationEngine, SyncStatus,
    authorization::AuthorityAction,
    direct::DirectEndpoint,
    exchange::{self, ExchangeState, PeerProgress},
    identity::{self, SyncCredentials},
    invitation::{self, PendingDevice},
    journal,
    owner::{AppOwner, ReplicationOwner},
    protocol::*,
    rpc::RpcBudget,
};
use crate::{
    document_model::ReadError,
    persistence::{ProductPersistenceState, ProductStore},
};

const MAX_CONNECTIONS: usize = 8;

#[derive(Clone)]
struct Route {
    public_key: String,
    addresses: Vec<SocketAddr>,
}
fn routes(store: &ProductStore) -> Result<Vec<Route>, ReadError> {
    let rows = store.connection.prepare("SELECT m.public_key,p.public_key,p.addresses FROM sync_peer_addresses p JOIN sync_members m ON m.device_id=p.device_id WHERE m.revoked=0 ORDER BY m.device_id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    rows.into_iter()
        .map(|(public_key, stored, json)| {
            if public_key != stored {
                return Err(error(
                    "SYNC_KEY",
                    "Stored direct address key differs from registered device",
                ));
            }
            let addresses: Vec<SocketAddr> = serde_json::from_str(&json)?;
            invitation::validate_addresses(&addresses)?;
            Ok(Route {
                public_key,
                addresses,
            })
        })
        .collect()
}

#[derive(Default)]
pub struct SyncRuntime {
    running: tokio::sync::Mutex<Option<Running>>,
}
struct Running {
    root: PathBuf,
    config: ReplicaConfig,
    endpoint: Arc<DirectEndpoint>,
    task: tokio::task::JoinHandle<()>,
    state: Arc<ExchangeState>,
    error: Arc<Mutex<Option<ReadError>>>,
    closed: bool,
}
impl Running {
    async fn shutdown(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
        self.endpoint.close().await;
        self.closed = true;
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
        if self.closed {
            return;
        }
        let endpoint = self.endpoint.clone();
        // Closing or switching Workspace waits only for local durability.
        tauri::async_runtime::spawn(async move {
            endpoint.close().await;
        });
    }
}

impl SyncRuntime {
    pub async fn stop(&self, workspace: Option<&str>) {
        let mut running = self.running.lock().await;
        if workspace.is_none()
            || running
                .as_ref()
                .is_some_and(|r| Some(r.config.workspace_id.as_str()) == workspace)
        {
            if let Some(previous) = running.take() {
                previous.shutdown().await;
            }
        }
    }
    pub async fn start(&self, app: &tauri::AppHandle, workspace_id: &str) -> Result<(), ReadError> {
        let mut running = self.running.lock().await;
        let config_app = app.clone();
        let workspace_id = workspace_id.to_owned();
        let configured = tokio::task::spawn_blocking(move || {
            config_app
                .state::<ProductPersistenceState>()
                .with_store(&config_app, |store| {
                    Ok((|| {
                        if store.manifest()?.active_workspace_id.as_deref()
                            != Some(workspace_id.as_str())
                        {
                            return Err(error(
                                "SYNC_WORKSPACE_CHANGED",
                                "The selected Workspace changed",
                            ));
                        }
                        let Some(config) = ReplicationEngine::new(store).configuration()? else {
                            return Ok(None);
                        };
                        if config.paused {
                            return Ok(None);
                        }
                        let member = journal::member(&store.connection, &config.origin, false)?;
                        let bind: String = store
                            .connection
                            .query_row(
                                "SELECT value FROM settings WHERE key='replication_bind'",
                                [],
                                |r| r.get(0),
                            )
                            .optional()?
                            .unwrap_or_else(|| "0.0.0.0:0".into());
                        let bind: SocketAddr = bind
                            .parse()
                            .map_err(|_| error("SYNC_ADDRESS", "Invalid local UDP address"))?;
                        Ok::<_, ReadError>(Some((
                            store.root.clone(),
                            config,
                            member,
                            bind,
                            routes(store)?,
                        )))
                    })())
                })
        })
        .await
        .map_err(|_| error("SYNC_OWNER", "Cannot load synchronization settings"))???;
        let Some((root, config, member, bind, routes)) = configured else {
            if let Some(previous) = running.take() {
                previous.shutdown().await;
            }
            return Ok(());
        };
        if let Some(current) = running.as_ref() {
            if current.root == root
                && current.config.origin == config.origin
                && current.config.group_id == config.group_id
                && !current.task.is_finished()
            {
                current.state.wake.notify_waiters();
                return Ok(());
            }
        }
        if let Some(previous) = running.take() {
            previous.shutdown().await;
        }
        let group = config.group_id.clone();
        let key =
            tokio::task::spawn_blocking(move || identity::load(&SyncCredentials, &group, &member))
                .await
                .map_err(|_| error("SYNC_CREDENTIALS", "Cannot load device identity"))??;
        let addresses: Vec<_> = routes
            .iter()
            .flat_map(|route| route.addresses.iter().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let endpoint = Arc::new(DirectEndpoint::bind(&key, bind, &addresses).await?);
        let owner = Arc::new(AppOwner {
            app: app.clone(),
            workspace: root.clone(),
            config: config.clone(),
            queue: Arc::new(tokio::sync::Semaphore::new(8)),
        });
        let saved_bind = SocketAddr::new(bind.ip(), endpoint.bound_address().port());
        owner
            .dispatch(move |store| {
                store.connection.execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES('replication_bind',?1)",
                    [saved_bind.to_string()],
                )?;
                Ok(())
            })
            .await?;
        let state = Arc::new(ExchangeState::new());
        let failure = Arc::new(Mutex::new(None));
        let task = {
            let endpoint = endpoint.clone();
            let state = state.clone();
            let config = config.clone();
            let failure = failure.clone();
            tokio::spawn(async move {
                let result = run(owner.clone(), config, endpoint.clone(), key, state).await;
                if let Ok(mut error) = failure.lock() {
                    *error = result.err();
                }
                owner.received();
                endpoint.close().await;
            })
        };
        *running = Some(Running {
            root,
            config,
            endpoint,
            task,
            state,
            error: failure,
            closed: false,
        });
        Ok(())
    }
}

async fn sign_and_checkpoint<O: ReplicationOwner>(
    owner: Arc<O>,
    key: SigningKey,
    state: Arc<ExchangeState>,
) -> Result<(), ReadError> {
    let mut checkpoint_retry_at = tokio::time::Instant::now();
    loop {
        let signer = key.clone();
        let (sequence, pending) = owner
            .dispatch(move |store| {
                let config = journal::required_config(&store.connection)?;
                let pending: bool = store.connection.query_row("SELECT EXISTS(SELECT 1 FROM sync_batches WHERE replica_id=?1 AND local=1 AND signature IS NULL)", [&config.origin.replica_id], |r| r.get(0))?;
                let sequence = journal::frontiers(&store.connection)?.applied.get(&config.origin.replica_id).copied().unwrap_or(0);
                Ok((sequence, pending.then(|| (store.root.clone(), config))))
            })
            .await?;
        state
            .send_schedule
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Delivery schedule is unavailable"))?
            .observe(tokio::time::Instant::now(), sequence);
        if let Some((root, config)) = pending {
            let signature = tokio::task::spawn_blocking(move || {
                super::signing::PreparedSignature::prepare(&root, &config, &signer)
            })
            .await
            .map_err(|_| error("SYNC_SIGNATURE", "Signature computation failed"))??;
            if let Some(signature) = signature {
                owner.dispatch(move |store| signature.commit(store)).await?;
            }
            state.wake.notify_waiters();
            continue;
        }
        let checkpoint = owner.dispatch(move |store| {
            let needed: bool = store.connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM sync_checkpoints) OR (SELECT COUNT(*)>2 FROM sync_checkpoints) OR EXISTS(SELECT 1 FROM sync_batches b JOIN sync_members m ON m.replica_id=b.replica_id WHERE m.revoked=1 AND b.applied_at IS NOT NULL AND b.signature IS NOT NULL) OR (SELECT COALESCE(SUM(length(content)),0)>67108864 OR COUNT(*)>=512 FROM sync_batches WHERE applied_at IS NOT NULL AND signature IS NOT NULL)", [], |r| r.get(0))?;
            Ok(if needed { Some((store.root.clone(), journal::required_config(&store.connection)?)) } else { None })
        }).await?;
        if let Some((root, config)) =
            checkpoint.filter(|_| tokio::time::Instant::now() >= checkpoint_retry_at)
        {
            state
                .send_schedule
                .lock()
                .map_err(|_| error("SYNC_OWNER", "Delivery schedule is unavailable"))?
                .release_all();
            let signer = key.clone();
            let result: Result<(), ReadError> = async {
                let prepared = tokio::task::spawn_blocking(move || {
                    super::PreparedCheckpointExport::prepare(&root, &config, &signer)
                })
                .await
                .map_err(|_| error("SYNC_CHECKPOINT", "Checkpoint preparation failed"))??;
                owner
                    .dispatch(move |store| prepared.commit(store, true))
                    .await?;
                Ok(())
            }
            .await;
            checkpoint_retry_at = tokio::time::Instant::now()
                + Duration::from_secs(if result.is_err() { 30 } else { 0 });
            if let Ok(mut failure) = state.background_error.lock() {
                *failure = result.err();
            }
            owner.received();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tauri::command]
pub async fn sync_start(app: tauri::AppHandle, workspace_id: String) -> Result<(), ReadError> {
    app.state::<SyncRuntime>().start(&app, &workspace_id).await
}

#[tauri::command]
pub async fn sync_stop(app: tauri::AppHandle, workspace_id: String) {
    app.state::<SyncRuntime>().stop(Some(&workspace_id)).await;
}

pub(super) async fn run<O: ReplicationOwner>(
    owner: Arc<O>,
    config: ReplicaConfig,
    endpoint: Arc<DirectEndpoint>,
    key: SigningKey,
    state: Arc<ExchangeState>,
) -> Result<(), ReadError> {
    let signing = sign_and_checkpoint(owner.clone(), key, state.clone());
    tokio::pin!(signing);
    let budget = Arc::new(RpcBudget::default());
    let mut connections = tokio::task::JoinSet::new();
    let mut active = BTreeMap::<String, usize>::new();
    let mut retry = BTreeMap::<String, (tokio::time::Instant, u32)>::new();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let accepting = endpoint.accept();
    tokio::pin!(accepting);
    loop {
        tokio::select! {
            result = &mut signing => return result,
            _ = tick.tick() => {
                let routes = owner.dispatch(|store| routes(store)).await?;
                let addresses: Vec<_> = routes.iter().flat_map(|route| route.addresses.iter().copied()).collect::<BTreeSet<_>>().into_iter().collect();
                endpoint.set_addresses(&addresses)?;
                for route in routes {
                    if connections.len() >= MAX_CONNECTIONS { break; }
                    let key = &route.public_key;
                    state.admit(key);
                    if key == &config.public_key || active.contains_key(key) { continue; }
                    if retry.get(key).is_some_and(|(at, _)| *at > tokio::time::Instant::now()) { continue; }
                    *active.entry(key.clone()).or_default() += 1;
                    let endpoint = endpoint.clone(); let owner = owner.clone(); let config = config.clone(); let budget = budget.clone(); let state = state.clone();
                    connections.spawn(async move {
                        let result = async {
                            let connection = endpoint.connect(&route.public_key, &route.addresses).await?;
                            tokio::time::timeout(Duration::from_secs(90), exchange::run(owner, config, connection, true, budget, state.clone())).await
                                .map_err(|_| error("SYNC_RECONNECT", "Refreshing direct connection"))?
                        }.await;
                        state.update(&route.public_key, |p| { if !p.connected { p.error = result.as_ref().err().cloned(); } });
                        (route.public_key, result)
                    });
                }
            }
            incoming = &mut accepting, if connections.len() < MAX_CONNECTIONS => {
                accepting.set(endpoint.accept());
                match incoming {
                    Ok(Some(connection)) => {
                        let key = connection.public_key();
                        // Deterministically retain one direction when both peers
                        // dial at once. One-way routes can still be accepted.
                        if active.contains_key(&key) && (config.public_key < key || state.snapshot().get(&key).is_some_and(|p| p.connected)) { connection.close(); continue; }
                        *active.entry(key.clone()).or_default() += 1;
                        let owner = owner.clone(); let config = config.clone(); let budget = budget.clone(); let state = state.clone();
                        connections.spawn(async move {
                            let result = tokio::time::timeout(Duration::from_secs(90), exchange::run(owner, config, connection, false, budget, state)).await
                                .map_err(|_| error("SYNC_RECONNECT", "Refreshing direct connection")).and_then(|result| result);
                            (key, result)
                        });
                    }
                    Ok(None) => return Ok(()),
                    Err(_) => {}, // A bad incoming handshake cannot stop registered peers.
                }
            }
            result = connections.join_next(), if !connections.is_empty() => {
                let result = result.ok_or_else(|| error("SYNC_STOPPED", "Connection task stopped"))?;
                let (key, result) = match result {
                    Ok(result) => result,
                    Err(error) if error.is_cancelled() => continue,
                    Err(_) => return Err(error("SYNC_PROTOCOL", "Connection task failed")),
                };
                if let Some(count) = active.get_mut(&key) { *count -= 1; if *count == 0 { active.remove(&key); } }
                let attempts = retry.get(&key).map_or(0, |(_, attempts)| *attempts).saturating_add(1).min(6);
                let delay = if result.as_ref().err().is_some_and(|e| e.code == "SYNC_RECONNECT") { 1 } else { (1_u64 << attempts).min(30) };
                retry.insert(key, (tokio::time::Instant::now() + Duration::from_secs(delay), attempts));
            }
            _ = state.reconnect.notified() => {
                connections.abort_all();
                while connections.join_next().await.is_some() {}
                active.clear(); retry.clear();
                state.wake.notify_waiters();
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub member: ReplicaMember,
    pub addresses: Vec<SocketAddr>,
    pub connection: PeerProgress,
    pub pending_received_count: i64,
    pub pending_applied_count: i64,
    pub pending_bytes: i64,
    pub checkpoint_required: bool,
    pub last_applied_at: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    pub workspace_id: Option<String>,
    pub config: Option<ReplicaConfig>,
    pub local: SyncStatus,
    pub devices: Vec<DeviceStatus>,
    pub pending: Vec<PendingDevice>,
    pub listening: Option<SocketAddr>,
    pub error: Option<ReadError>,
    pub attachment_transfers: Vec<super::AttachmentTransfer>,
    pub failures: Vec<(String, String)>,
}
pub fn status(store: &mut ProductStore) -> Result<SyncView, ReadError> {
    let workspace_id: Option<String> = store
        .connection
        .query_row(
            "SELECT value FROM settings WHERE key='active_workspace_id'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let engine = ReplicationEngine::new(store);
    let config = engine.configuration()?;
    let local = engine.status()?;
    let pending = engine.pending_devices(chrono::Utc::now().timestamp())?;
    let attachment_transfers = if config.is_some() {
        engine.pending_attachments(64)?
    } else {
        vec![]
    };
    let failures = if config.is_some() {
        engine.store.connection.prepare("SELECT content_hash,reason FROM sync_quarantine UNION SELECT content_hash,error FROM sync_batches WHERE error IS NOT NULL UNION SELECT content_hash,error FROM sync_checkpoint_inbox WHERE error IS NOT NULL LIMIT 50")?.query_map([], |r| Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<Vec<_>,_>>()?
    } else {
        vec![]
    };
    let routes = if config.is_some() {
        routes(engine.store)?
    } else {
        vec![]
    };
    let mut devices = Vec::new();
    for member in engine.registered_devices()? {
        let frontier: Option<(String, String, Option<String>)> = engine
            .store
            .connection
            .query_row(
                "SELECT received,applied,last_applied_at FROM sync_peer_frontiers WHERE peer_id=?1",
                [&member.origin.device_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (received, applied, last_applied_at) = match frontier {
            Some((received, applied, at)) => (
                serde_json::from_str::<Frontier>(&received)?,
                serde_json::from_str::<Frontier>(&applied)?,
                at,
            ),
            None => (Frontier::new(), Frontier::new(), None),
        };
        let (received, applied, last_applied_at) =
            if config.as_ref().is_some_and(|c| c.origin == member.origin) {
                (
                    local.frontier.received.clone(),
                    local.frontier.applied.clone(),
                    local.last_applied_at.clone(),
                )
            } else {
                (received, applied, last_applied_at)
            };
        let pending_count = |frontier: &Frontier| {
            local
                .frontier
                .applied
                .iter()
                .map(|(replica, seq)| (seq - frontier.get(replica).copied().unwrap_or(0)).max(0))
                .sum::<i64>()
        };
        let pending_received_count = pending_count(&received);
        let (count, bytes): (i64, i64) = engine.store.connection.query_row("SELECT COUNT(*),COALESCE(SUM(length(b.content)),0) FROM sync_batches b LEFT JOIN json_each(?1) f ON f.key=b.replica_id WHERE b.sequence>COALESCE(CAST(f.value AS INTEGER),0) AND b.error IS NULL", [serde_json::to_string(&received)?], |r| Ok((r.get(0)?,r.get(1)?)))?;
        let addresses = routes
            .iter()
            .find(|route| route.public_key == member.public_key)
            .map(|r| r.addresses.clone())
            .unwrap_or_default();
        devices.push(DeviceStatus {
            member,
            addresses,
            connection: PeerProgress::default(),
            pending_received_count,
            pending_applied_count: pending_count(&applied),
            pending_bytes: bytes,
            checkpoint_required: count < pending_received_count,
            last_applied_at,
        });
    }
    Ok(SyncView {
        workspace_id,
        attachment_transfers,
        failures,
        config,
        local,
        devices,
        pending,
        listening: None,
        error: None,
    })
}

#[tauri::command]
pub async fn sync_status(app: tauri::AppHandle) -> Result<SyncView, ReadError> {
    let status_app = app.clone();
    let mut view = tokio::task::spawn_blocking(move || {
        status_app
            .state::<ProductPersistenceState>()
            .with_store(&status_app, |store| Ok(status(store)))
    })
    .await
    .map_err(|_| error("SYNC_OWNER", "Cannot read synchronization status"))???;
    let state = app.state::<SyncRuntime>();
    let running = state.running.lock().await;
    if let Some(running) = running.as_ref().filter(|running| {
        view.config.as_ref().is_some_and(|c| {
            c.origin == running.config.origin && c.group_id == running.config.group_id
        })
    }) {
        if !running.task.is_finished() {
            view.listening = Some(running.endpoint.bound_address());
        }
        view.error = running.error.lock().ok().and_then(|e| e.clone());
        if view.error.is_none() {
            view.error = running
                .state
                .background_error
                .lock()
                .ok()
                .and_then(|e| e.clone());
        }
        let progress = running.state.snapshot();
        for device in &mut view.devices {
            if let Some(p) = progress.get(&device.member.public_key) {
                device.connection = p.clone();
            }
        }
    }
    Ok(view)
}

pub fn read_status(workspace: &std::path::Path) -> Result<serde_json::Value, ReadError> {
    let reader = crate::read_service::WorkspaceReader::open(workspace)?;
    let workspace_id = reader.workspace_id;
    let mut readonly = ProductStore {
        connection: reader.connection,
        root: reader.internal_root,
    };
    Ok(
        serde_json::json!({"schema_version":1,"workspace_id":workspace_id,"status":status(&mut readonly)?}),
    )
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SyncAction {
    Enable {
        name: String,
        bind: SocketAddr,
    },
    Pause {
        paused: bool,
    },
    Invite {
        addresses: Vec<SocketAddr>,
    },
    Approve {
        invitation_id: String,
        expected_public_key: String,
    },
    Reject {
        invitation_id: String,
    },
    Revoke {
        device_id: String,
        expected_public_key: String,
    },
    Addresses {
        device_id: String,
        expected_public_key: String,
        addresses: Vec<SocketAddr>,
    },
    Listen {
        bind: SocketAddr,
    },
    Reconnect,
    RetryAttachment {
        sha256: String,
    },
}
#[tauri::command]
pub async fn sync_action(
    app: tauri::AppHandle,
    workspace_id: String,
    action: SyncAction,
) -> Result<serde_json::Value, ReadError> {
    let reconnect = matches!(action, SyncAction::Reconnect | SyncAction::Addresses { .. });
    let restart = matches!(
        action,
        SyncAction::Listen { .. } | SyncAction::Pause { paused: true }
    );
    let write_app = app.clone();
    let selected_workspace = workspace_id.clone();
    let value = tokio::task::spawn_blocking(move || write_app.state::<ProductPersistenceState>().with_store(&write_app, |store| Ok((|| {
        if store.manifest()?.active_workspace_id.as_deref() != Some(workspace_id.as_str()) {
            return Err(error("SYNC_WORKSPACE_CHANGED", "The selected Workspace changed"));
        }
        let mut engine = ReplicationEngine::new(store);
        match action {
            SyncAction::Enable { name, bind } => {
                let workspace = engine.store.load_document("workspace", &workspace_id)?;
                let namespace = crate::namespace::read_namespace(&workspace)?;
                if namespace.notes.values().filter(|note| note["system_role"] == "help").count() != 1 { return Err(error("SYNC_HELP_REQUIRED", "Prepare the shared Help identity before enabling synchronization")); }
                let config = engine.enable(&name, &SyncCredentials)?;
                engine.store.connection.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('replication_bind',?1)", [bind.to_string()])?;
                Ok(serde_json::to_value(config)?)
            }
            SyncAction::Pause { paused } => { engine.set_paused(paused)?; Ok(serde_json::Value::Null) }
            SyncAction::Invite { addresses } => Ok(serde_json::json!({"connectionInfo":engine.create_invitation(addresses, &SyncCredentials, chrono::Utc::now().timestamp())?})),
            SyncAction::Approve { invitation_id, expected_public_key } => Ok(serde_json::to_value(engine.approve_invitation(&invitation_id, &expected_public_key, &SyncCredentials, chrono::Utc::now().timestamp())?)?),
            SyncAction::Reject { invitation_id } => { engine.reject_invitation(&invitation_id)?; Ok(serde_json::Value::Null) }
            SyncAction::Revoke { device_id, expected_public_key } => {
                let config = journal::required_config(&engine.store.connection)?;
                let member = engine.registered_devices()?.into_iter().find(|m| m.origin.device_id == device_id).ok_or_else(|| error("SYNC_UNREGISTERED", "Device is not registered"))?;
                if member.public_key != expected_public_key { return Err(error("SYNC_KEY", "Device differs from the reviewed key")); }
                let local = journal::member(&engine.store.connection, &config.origin, false)?;
                let key = identity::load(&SyncCredentials, &config.group_id, &local)?;
                let self_revoked = device_id == config.origin.device_id;
                engine.authorize(AuthorityAction::Revoke { device_id }, &key)?;
                Ok(serde_json::json!({"selfRevoked":self_revoked}))
            }
            SyncAction::Addresses { device_id, expected_public_key, addresses } => { engine.update_addresses(&device_id, &expected_public_key, &addresses)?; Ok(serde_json::Value::Null) }
            SyncAction::Listen { bind } => {
                journal::required_config(&engine.store.connection)?;
                engine.store.connection.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('replication_bind',?1)", [bind.to_string()])?;
                Ok(serde_json::Value::Null)
            }
            SyncAction::Reconnect => { journal::required_config(&engine.store.connection)?; Ok(serde_json::Value::Null) },
            SyncAction::RetryAttachment { sha256 } => Ok(serde_json::to_value(engine.retry_attachment(&sha256)?)?),
        }
    })()))).await.map_err(|_| error("SYNC_OWNER", "Device action failed"))???;
    if restart || value["selfRevoked"] == true {
        app.state::<SyncRuntime>()
            .stop(Some(&selected_workspace))
            .await;
    }
    if value["selfRevoked"] == true {
        return Ok(value);
    } else {
        app.state::<SyncRuntime>()
            .start(&app, &selected_workspace)
            .await?;
    }
    if reconnect {
        if let Some(running) = app.state::<SyncRuntime>().running.lock().await.as_ref() {
            running.state.reconnect.notify_one();
        }
    }
    Ok(value)
}
