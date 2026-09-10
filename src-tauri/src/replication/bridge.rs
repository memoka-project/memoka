use std::{path::PathBuf, sync::Mutex};

use serde::Serialize;
use tauri::Manager;

use super::{
    ReplicaConfig, ReplicationEngine,
    protocol::error,
    publication::{self, PreparedPublication, PublicationDocument, SyncDelivery},
};
use crate::{document_model::ReadError, persistence::ProductPersistenceState};

#[derive(Default)]
pub struct SyncPublications {
    pending: Mutex<Option<Pending>>,
}
impl SyncPublications {
    pub(crate) fn workspace_switch(&self) -> Result<impl Drop + '_, ReadError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Publication state is unavailable"))?;
        if pending.as_ref().is_some_and(|p| p.delivery.is_some()) {
            return Err(error(
                "SYNC_BUSY",
                "Publish the saved remote changes before switching Workspace",
            ));
        }
        // Hold the publication lock until the owner has switched, following
        // the same lock order as commit. Read-only candidates can be retried.
        *pending = None;
        Ok(pending)
    }
}
struct Pending {
    id: String,
    workspace: PathBuf,
    config: ReplicaConfig,
    prepared: Option<PreparedPublication>,
    delivery: Option<SyncDelivery>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreparation {
    pub id: String,
    pub workspace_id: String,
    pub group_id: String,
    pub documents: Vec<PublicationDocument>,
    pub affected_note_ids: Vec<String>,
    pub delivery: Option<SyncDelivery>,
}
impl Pending {
    fn description(&self) -> SyncPreparation {
        SyncPreparation {
            id: self.id.clone(),
            workspace_id: self.config.workspace_id.clone(),
            group_id: self.config.group_id.clone(),
            documents: self
                .prepared
                .as_ref()
                .map(|p| p.documents())
                .unwrap_or_default(),
            delivery: self.delivery.clone(),
            affected_note_ids: self
                .prepared
                .as_ref()
                .map(|p| p.affected_note_ids().to_vec())
                .or_else(|| self.delivery.as_ref().map(|d| d.affected_note_ids.clone()))
                .unwrap_or_default(),
        }
    }
}

#[tauri::command]
pub async fn sync_prepare(app: tauri::AppHandle) -> Result<Option<SyncPreparation>, ReadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let persistence = app.state::<ProductPersistenceState>();
        let (workspace, config) = persistence.with_store(&app, |store| {
            let root = store.root.clone();
            Ok((root, ReplicationEngine::new(store).configuration()))
        })?;
        let Some(config) = config? else {
            return Ok(None);
        };
        let state = app.state::<SyncPublications>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Publication state is unavailable"))?;
        if let Some(value) = pending.as_ref() {
            if value.workspace == workspace
                && value.config.group_id == config.group_id
                && value.config.origin == config.origin
            {
                return Ok(
                    (!config.paused || value.delivery.is_some()).then(|| value.description())
                );
            }
            // A closed Workspace recovers its already durable documents on its
            // next open. Never publish them into a different active Workspace.
            *pending = None;
        }
        if config.paused {
            return Ok(None);
        }
        let prepared = match PreparedPublication::prepare(&workspace, &config) {
            Ok(Some(prepared)) => prepared,
            Ok(None) => return Ok(None),
            Err(failure) => {
                persistence.with_store(&app, |store| {
                    Ok(publication::quarantine(store, &config, &failure))
                })??;
                return Err(failure);
            }
        };
        let entry = Pending {
            id: uuid::Uuid::now_v7().to_string(),
            workspace,
            config,
            prepared: Some(prepared),
            delivery: None,
        };
        let description = entry.description();
        *pending = Some(entry);
        Ok(Some(description))
    })
    .await
    .map_err(|_| error("SYNC_OWNER", "Publication preparation failed"))?
}

#[tauri::command]
pub async fn sync_commit(app: tauri::AppHandle, id: String) -> Result<SyncDelivery, ReadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SyncPublications>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| error("SYNC_OWNER", "Publication state is unavailable"))?;
        let entry = pending
            .as_mut()
            .filter(|value| value.id == id)
            .ok_or_else(|| error("SYNC_TICKET", "Publication ticket expired"))?;
        if let Some(delivery) = &entry.delivery {
            return Ok(delivery.clone());
        }
        let prepared = entry
            .prepared
            .as_ref()
            .ok_or_else(|| error("SYNC_TICKET", "Publication is not prepared"))?;
        let delivery = app
            .state::<ProductPersistenceState>()
            .with_store(&app, |store| {
                Ok({
                    if store.root != entry.workspace {
                        Err(error("SYNC_GROUP", "Workspace changed before publication"))
                    } else {
                        prepared.commit(store, &entry.config)
                    }
                })
            })??;
        entry.delivery = Some(delivery.clone());
        entry.prepared = None;
        Ok(delivery)
    })
    .await
    .map_err(|_| {
        error(
            "SYNC_RESPONSE_LOST",
            "Publication response was lost; retry the same ticket",
        )
    })?
}

#[tauri::command]
pub fn sync_cancel(id: String, state: tauri::State<'_, SyncPublications>) -> Result<(), ReadError> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| error("SYNC_OWNER", "Publication state is unavailable"))?;
    if let Some(entry) = pending.as_ref().filter(|entry| entry.id == id) {
        if entry.delivery.is_some() {
            return Err(error(
                "SYNC_RESPONSE_LOST",
                "Publish the retained committed delivery before releasing its ticket",
            ));
        }
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_ack(id: String, state: tauri::State<'_, SyncPublications>) {
    if let Ok(mut pending) = state.pending.lock()
        && pending
            .as_ref()
            .is_some_and(|entry| entry.id == id && entry.delivery.is_some())
    {
        *pending = None;
    }
}
