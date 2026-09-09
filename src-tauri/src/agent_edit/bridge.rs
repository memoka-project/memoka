//! Two-phase GUI bridge: prepare off-thread, commit durably, then publish to
//! live Yjs documents. An IPC disconnect is never permission to write around
//! the owner. Completed deliveries remain available until frontend ack.
use super::*;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, mpsc},
    time::Duration,
};
use tauri::{Emitter, Manager};

struct Pending {
    workspace: PathBuf,
    request: AgentRequest,
    dry_run: bool,
    prepared: Option<PreparedEdit>,
    delivery: Option<Value>,
    sender: mpsc::Sender<Result<Value, ReadError>>,
}
#[derive(Default)]
pub struct AgentEdits {
    pending: Mutex<HashMap<String, Pending>>,
    test_fault: Mutex<Option<crate::persistence::CommitFault>>,
}
fn busy() -> ReadError {
    ReadError::new(
        "EDIT_BUSY",
        "The editor cannot accept an external edit now; retry after editing settles",
    )
}
impl AgentEdits {
    pub fn busy(&self) -> bool {
        self.pending.lock().map_or(true, |p| !p.is_empty())
    }
    pub fn dispatch(
        &self,
        app: &tauri::AppHandle,
        workspace: PathBuf,
        request: impl Into<AgentRequest>,
        dry_run: bool,
    ) -> Result<Value, ReadError> {
        let request = request.into();
        request.validate()?;
        // Stable receipts win over liveness, revision, IME and busy checks.
        let reader = WorkspaceReader::open(&workspace)?;
        require_edit_schema(&reader)?;
        if reader.workspace_id != request.workspace_id() {
            return Err(ReadError::new(
                "WORKSPACE_MISMATCH",
                "Workspace identity does not match",
            ));
        }
        if let Some(result) = receipt(&reader.connection, request.clone())? {
            return Ok(result);
        }
        drop(reader);
        if app
            .state::<crate::persistence::ProductPersistenceState>()
            .native_service()?
            .departing()
        {
            return Err(busy());
        }
        let id = uuid::Uuid::now_v7().to_string();
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| busy())?;
            // Bounded and serialized across Workspace metadata writes.
            if !pending.is_empty() {
                return Err(busy());
            }
            pending.insert(
                id.clone(),
                Pending {
                    workspace,
                    request: request.clone(),
                    dry_run,
                    prepared: None,
                    delivery: None,
                    sender,
                },
            );
        }
        if app
            .emit(
                "memoka-agent-edit",
                json!({"id":id,"request":request.identity()}),
            )
            .is_err()
        {
            self.pending.lock().map_err(|_| busy())?.remove(&id);
            return Err(busy());
        }
        match receiver.recv_timeout(Duration::from_secs(25)) {
            Ok(result) => result,
            Err(_) => {
                let mut pending = self.pending.lock().map_err(|_| busy())?;
                if pending.get(&id).is_some_and(|p| p.delivery.is_none()) {
                    pending.remove(&id);
                    return Err(busy());
                }
                Err(ReadError::new(
                    "AGENT_RESPONSE_LOST",
                    "Delivery is unconfirmed; resend exactly the same request_id",
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn agent_edit_prepare(app: tauri::AppHandle, id: String) -> Result<Value, ReadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentEdits>();
        let (workspace, request, dry_run) = {
            let pending = state.pending.lock().map_err(|_| busy())?;
            let entry = pending.get(&id).ok_or_else(busy)?;
            if let Some(delivery) = &entry.delivery {
                return Ok(json!({"complete":true,"delivery":delivery}));
            }
            (
                entry.workspace.clone(),
                entry.request.clone(),
                entry.dry_run,
            )
        };
        let prepared = prepare(&workspace, request)?;
        let mut pending = state.pending.lock().map_err(|_| busy())?;
        let entry = pending.get_mut(&id).ok_or_else(busy)?;
        if dry_run || prepared.replayed {
            let result = if dry_run {
                preview(&prepared)
            } else {
                prepared.result
            };
            let delivery = json!({"result":result,"documents":[]});
            entry.delivery = Some(delivery.clone());
            return Ok(json!({"complete":true,"delivery":delivery}));
        }
        entry.prepared = Some(prepared);
        Ok(json!({"complete":false}))
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Edit preparation failed"))?
}

#[tauri::command]
pub async fn agent_edit_commit(app: tauri::AppHandle, id: String) -> Result<Value, ReadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentEdits>();
        // Keep the pending ticket locked through SQL commit: a timed-out
        // request can be cancelled before commit, never halfway through it.
        let mut pending = state.pending.lock().map_err(|_| busy())?;
        let entry = pending.get_mut(&id).ok_or_else(busy)?;
        if let Some(delivery) = &entry.delivery {
            return Ok(delivery.clone());
        }
        let persistence = app.state::<crate::persistence::ProductPersistenceState>();
        let service = persistence.native_service()?;
        if service.workspace != entry.workspace || service.departing() {
            return Err(busy());
        }
        let prepared = entry.prepared.as_ref().ok_or_else(busy)?;
        let fault = state.test_fault.lock().map_err(|_| busy())?.take();
        let committed =
            persistence.with_store(&app, |store| Ok(commit_with_fault(store, prepared, fault)))?;
        let response_lost = committed
            .as_ref()
            .err()
            .is_some_and(|e| e.code == "AGENT_RESPONSE_LOST");
        let result = match committed {
            Ok(result) => result,
            Err(_) if response_lost => prepared.result.clone(),
            Err(error) => return Err(error),
        };
        let documents = prepared
            .documents
            .iter()
            .map(|document| {
                json!({"kind":document.kind,"document_id":document.document_id,
            "revision":document.base_revision+1,"update":document.update.as_ref().or(document.snapshot.as_ref())})
            })
            .collect::<Vec<_>>();
        let delivery = json!({"result":result,"documents":documents});
        entry.delivery = Some(delivery.clone());
        if response_lost {
            return Err(ReadError::new(
                "AGENT_RESPONSE_LOST",
                "Commit response was lost; recover retained delivery",
            ));
        }
        Ok(delivery)
    })
    .await
    .map_err(|_| {
        ReadError::new(
            "AGENT_RESPONSE_LOST",
            "Commit response was lost; retry the same request",
        )
    })?
}

/// Internal E2E hook; not part of the edit protocol and disabled in releases.
#[tauri::command]
pub fn agent_edit_test_fault(
    fault: Option<crate::persistence::CommitFault>,
    state: tauri::State<'_, AgentEdits>,
) -> Result<(), ReadError> {
    if !cfg!(debug_assertions) {
        return Err(invalid("Fault injection requires a debug build"));
    }
    *state.test_fault.lock().map_err(|_| busy())? = fault;
    Ok(())
}

#[tauri::command]
pub fn agent_edit_ack(id: String, error: Option<ReadError>, state: tauri::State<'_, AgentEdits>) {
    if let Ok(mut pending) = state.pending.lock() {
        if let Some(entry) = pending.remove(&id) {
            let result = match (error, entry.delivery) {
                (None, Some(delivery)) => Ok(delivery["result"].clone()),
                (_, Some(_)) => Err(ReadError::new(
                    "AGENT_RESPONSE_LOST",
                    "Durable edit needs delivery reconciliation; resend the same request",
                )),
                (Some(error), None) => Err(error),
                _ => Err(busy()),
            };
            let _ = entry.sender.send(result);
        }
    }
}
