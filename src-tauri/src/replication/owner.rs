//! The transport has no SQLite connection of its own. Every durable action is
//! dispatched through the existing Workspace owner's persistence boundary.
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};

use tauri::{Emitter, Manager};

use super::{ReplicaConfig, protocol::error};
use crate::{
    document_model::ReadError,
    persistence::{ProductPersistenceState, ProductStore},
};

pub type OwnerFuture<T> = Pin<Box<dyn Future<Output = Result<T, ReadError>> + Send>>;
pub trait ReplicationOwner: Send + Sync + 'static {
    fn dispatch<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut ProductStore) -> Result<T, ReadError> + Send + 'static,
    ) -> OwnerFuture<T>;
    /// Coalesced by the frontend. Receiving bytes does not publish a document.
    fn received(&self);
}

pub(crate) struct AppOwner {
    pub app: tauri::AppHandle,
    pub workspace: PathBuf,
    pub config: ReplicaConfig,
    pub queue: Arc<tokio::sync::Semaphore>,
}
impl ReplicationOwner for AppOwner {
    fn dispatch<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut ProductStore) -> Result<T, ReadError> + Send + 'static,
    ) -> OwnerFuture<T> {
        let app = self.app.clone();
        let workspace = self.workspace.clone();
        let expected = self.config.clone();
        let queue = self.queue.clone();
        Box::pin(async move {
            let permit = queue
                .acquire_owned()
                .await
                .map_err(|_| error("SYNC_STOPPED", "Workspace synchronization stopped"))?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                app.state::<ProductPersistenceState>()
                    .with_store(&app, |store| {
                        Ok({
                            if store.root != workspace {
                                Err(error(
                                    "SYNC_WORKSPACE_CHANGED",
                                    "The selected Workspace changed",
                                ))
                            } else {
                                super::publication::check_config(store, &expected)
                                    .and_then(|()| action(store))
                            }
                        })
                    })?
            })
            .await
            .map_err(|_| error("SYNC_OWNER", "Workspace owner task failed"))?
        })
    }
    fn received(&self) {
        let _ = self.app.emit("memoka-sync-pending",serde_json::json!({"workspaceId":self.config.workspace_id,"groupId":self.config.group_id}));
    }
}
