//! Shared GUI/CLI application boundary. Repository work never holds the Core
//! persistence mutex, and copy's source lease does not exclude local capture.
use crate::{
    backup, backup_management,
    document_model::ReadError,
    history,
    read_service::WorkspaceReader,
    restic::{self, Restic},
    workspace_owner::{BackupAction, Reply, Request},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, atomic::Ordering},
    time::Duration,
};

pub struct NativeService {
    pub workspace: PathBuf,
    capture: Mutex<()>,
    copy: Mutex<()>,
    repositories: RwLock<()>,
    preview: Mutex<()>,
    operations: crate::background_operation::Operations,
    _lease: Option<crate::workspace_owner::WorkspaceLease>,
}
fn busy() -> ReadError {
    ReadError::new(
        "BACKUP_BUSY",
        "The requested repository operation is already running; retry later",
    )
}
impl NativeService {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            capture: Mutex::new(()),
            copy: Mutex::new(()),
            repositories: RwLock::new(()),
            preview: Mutex::new(()),
            operations: Default::default(),
            _lease: None,
        }
    }
    pub fn owned(lease: crate::workspace_owner::WorkspaceLease) -> Self {
        let mut value = Self::new(lease.workspace.clone());
        value._lease = Some(lease);
        value
    }
    pub fn cancel(&self) -> Result<(), ReadError> {
        self.operations.cancel()
    }
    pub fn resume(&self) -> Result<(), ReadError> {
        self.operations.resume()
    }
    pub fn running(&self) -> bool {
        self.operations.running()
    }
    pub fn query(&self, request: Request) -> Result<Reply, ReadError> {
        match request {
            Request::Activate => Err(ReadError::new(
                "OWNER_UNAVAILABLE",
                "No GUI activation handler is installed",
            )),
            Request::Backup { action } => self.backup(action).map(Reply::Json),
            Request::History { id } => {
                let operation = self.operations.begin()?;
                let _lease = self.repositories.try_read().map_err(|_| busy())?;
                let restic = Restic::discover(operation.cancel.clone())?;
                history::list(&self.workspace, &restic, id.as_deref()).map(Reply::Json)
            }
            Request::Query { request } => {
                if let Some(generation) = &request.generation {
                    let operation = self.operations.begin()?;
                    let _lease = self.repositories.try_read().map_err(|_| busy())?;
                    let _preview = self.preview.lock().map_err(|_| busy())?;
                    let restic = Restic::discover(operation.cancel.clone())?;
                    let repo = backup::local_repository(&self.workspace, &restic, false)?;
                    let workspace_id = WorkspaceReader::open(&self.workspace)?.workspace_id;
                    let generation = history::generation(
                        &restic,
                        &repo,
                        generation,
                        Some(&workspace_id),
                        Some(&self.workspace),
                    )?;
                    let mut reader = history::open(&self.workspace, &restic, &repo, &generation)?;
                    reader.reader.query(&request).map(Reply::Json)
                } else {
                    WorkspaceReader::open(&self.workspace)?
                        .query(&request)
                        .map(Reply::Json)
                }
            }
            Request::Attachment {
                id,
                include_trash,
                generation,
            } => {
                let (metadata, file) = if let Some(generation) = generation {
                    let operation = self.operations.begin()?;
                    let _lease = self.repositories.try_read().map_err(|_| busy())?;
                    let _preview = self.preview.lock().map_err(|_| busy())?;
                    let restic = Restic::discover(operation.cancel.clone())?;
                    let repo = backup::local_repository(&self.workspace, &restic, false)?;
                    let workspace_id = WorkspaceReader::open(&self.workspace)?.workspace_id;
                    let generation = history::generation(
                        &restic,
                        &repo,
                        &generation,
                        Some(&workspace_id),
                        Some(&self.workspace),
                    )?;
                    let mut reader = history::open(&self.workspace, &restic, &repo, &generation)?;
                    history::materialize_attachment(&restic, &repo, &generation, &reader, &id)?;
                    reader.reader.attachment_file(&id, include_trash)?
                } else {
                    WorkspaceReader::open(&self.workspace)?.attachment_file(&id, include_trash)?
                };
                Ok(Reply::Attachment { metadata, file })
            }
        }
    }
    pub fn backup(&self, action: BackupAction) -> Result<Value, ReadError> {
        match action {
            BackupAction::Status => {
                let mut status = backup::status(&self.workspace)?;
                if status.phase.is_empty() {
                    status.phase = "uninitialized".into();
                }
                Ok(
                    json!({"schema_version":1,"config":backup::config(&self.workspace)?,"status":status,"content_epoch":backup::content_epoch(&self.workspace)?}),
                )
            }
            BackupAction::Run => self.run_cycle(Duration::from_secs(30)),
            BackupAction::Copy => {
                let operation = self.operations.begin()?;
                self.copy(Duration::from_secs(3600), operation.cancel.clone())
            }
            BackupAction::List => {
                let operation = self.operations.begin()?;
                let _lease = self.repositories.try_read().map_err(|_| busy())?;
                history::list(
                    &self.workspace,
                    &Restic::discover(operation.cancel.clone())?,
                    None,
                )
            }
            BackupAction::Maintain { dry_run } => {
                let operation = self.operations.begin()?;
                self.maintain(dry_run, true, operation.cancel.clone())
            }
            BackupAction::IdleMaintain => {
                let operation = self.operations.begin()?;
                if !backup_management::idle_maintenance_due(&self.workspace)? {
                    return Ok(json!({"schema_version":1,"skipped":true}));
                }
                self.maintain(false, true, operation.cancel.clone())
            }
            BackupAction::Check { full } => {
                let operation = self.operations.begin()?;
                let _lease = self.repositories.try_write().map_err(|_| busy())?;
                let restic = Restic::discover(operation.cancel.clone())?;
                let repo = backup::local_repository(&self.workspace, &restic, false)?;
                backup_management::check(&restic, &repo, full)
            }
        }
    }
    pub fn run_cycle(&self, copy_budget: Duration) -> Result<Value, ReadError> {
        let operation = self.operations.begin()?;
        let local = {
            let _capture = self.capture.try_lock().map_err(|_| busy())?;
            let _lease = self.repositories.try_read().map_err(|_| busy())?;
            let restic = Restic::discover(operation.cancel.clone())?;
            backup::run_local(&self.workspace, &restic)?
        };
        // Failures of the independent additional target never invalidate local
        // success, but remain visible as typed status and in this response.
        if operation.cancel.load(Ordering::Acquire) {
            return Err(ReadError::new(
                "CANCELLED",
                "Backup stopped after confirmed local capture",
            ));
        }
        let additional = if backup::config(&self.workspace)?.additional.is_some() {
            Some(self.copy(copy_budget, operation.cancel.clone()))
        } else {
            None
        };
        // A failed transfer is not a successful cycle. Do not immediately
        // delete retained generations as its "success cleanup". Independent
        // later idle/manual maintenance still applies local retention, so an
        // offline destination cannot pin pending generations indefinitely.
        let maintenance = if local.is_some()
            && !additional.as_ref().is_some_and(Result::is_err)
            && !operation.cancel.load(Ordering::Acquire)
        {
            Some(
                match self.maintain(false, false, operation.cancel.clone()) {
                    Ok(value) => value,
                    Err(error) => json!({"error":error}),
                },
            )
        } else {
            None
        };
        let additional = additional.map(|result| match result {
            Ok(value) => value,
            Err(error) => json!({"error":error}),
        });
        Ok(
            json!({"schema_version":1,"local_generation":local,"additional":additional,"maintenance":maintenance}),
        )
    }
    fn copy(&self, budget: Duration, cancel: restic::Cancellation) -> Result<Value, ReadError> {
        let _copy = self.copy.try_lock().map_err(|_| busy())?;
        let _lease = self.repositories.try_read().map_err(|_| busy())?;
        if cancel.load(Ordering::Acquire) {
            return Err(ReadError::new("CANCELLED", "Additional copy cancelled"));
        }
        backup::update_status(&self.workspace, |status| {
            status.additional_phase = "copying".into()
        })?;
        let result = Restic::discover(cancel)
            .and_then(|restic| backup_management::copy(&self.workspace, &restic, budget));
        if let Err(error) = &result {
            backup::update_status(&self.workspace, |status| {
                status.additional_phase = "error".into();
                status.additional_error = Some(error.clone());
            })?;
        }
        result
    }
    fn maintain(
        &self,
        dry_run: bool,
        prune: bool,
        cancel: restic::Cancellation,
    ) -> Result<Value, ReadError> {
        let _lease = self.repositories.try_write().map_err(|_| busy())?;
        backup::update_status(&self.workspace, |status| {
            status.phase = "maintaining".into()
        })?;
        let result = (|| {
            let restic = Restic::discover(cancel)?;
            let local = backup::local_repository(&self.workspace, &restic, false)?;
            let local = backup_management::maintain_repository(
                &self.workspace,
                &restic,
                &local,
                dry_run,
                prune,
            )?;
            let additional = if backup::config(&self.workspace)?.additional.is_some()
                && backup::status(&self.workspace)?.additional_error.is_none()
            {
                let target = backup_management::additional_repository(&self.workspace, &restic)?;
                Some(backup_management::maintain_repository(
                    &self.workspace,
                    &restic,
                    &target,
                    dry_run,
                    prune,
                )?)
            } else {
                None
            };
            Ok(json!({"schema_version":1,"dry_run":dry_run,"local":local,"additional":additional}))
        })();
        backup::update_status(&self.workspace, |status| {
            status.maintenance_error = result.as_ref().err().cloned();
            status.phase = "idle".into();
        })?;
        result
    }
    pub fn configure_additional(&self, parent: &Path, secret: String) -> Result<(), ReadError> {
        let operation = self.operations.begin()?;
        let _lease = self.repositories.try_write().map_err(|_| busy())?;
        backup_management::configure_additional(
            &self.workspace,
            &Restic::discover(operation.cancel.clone())?,
            parent,
            secret,
        )
    }
    pub fn detach_additional(&self) -> Result<(), ReadError> {
        let _operation = self.operations.begin()?;
        let _lease = self.repositories.try_write().map_err(|_| busy())?;
        backup_management::detach_additional(&self.workspace)
    }
}

#[tauri::command]
pub(crate) async fn workspace_native_query(
    request: Request,
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<Value, ReadError> {
    let service = state.native_service()?;
    tauri::async_runtime::spawn_blocking(move || match service.query(request)? {
        Reply::Json(value) => Ok(value),
        Reply::Attachment { .. } => Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Use Attachment export for binary data",
        )),
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Native operation could not complete"))?
}
#[tauri::command]
pub(crate) async fn workspace_backup_cancel(
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<(), ReadError> {
    let service = state.native_service()?;
    service.cancel()?;
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        while service.running() {
            if started.elapsed() > Duration::from_secs(30) {
                return Err(ReadError::new(
                    "CANCEL_TIMEOUT",
                    "Backup cancellation has not completed; Memoka remains open",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(())
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Cancellation did not complete"))?
}
#[tauri::command]
pub(crate) fn workspace_backup_resume(
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<(), ReadError> {
    state.native_service()?.resume()
}
#[tauri::command]
pub(crate) async fn workspace_backup_settings(
    interval_minutes: u32,
    additional_directory: Option<PathBuf>,
    password: Option<String>,
    detach: bool,
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<(), ReadError> {
    let service = state.native_service()?;
    if !(1..=1440).contains(&interval_minutes) {
        return Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Backup interval must be 1–1440 minutes",
        ));
    }
    if detach && additional_directory.is_some() {
        return Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Cannot attach and detach at the same time",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(directory) = additional_directory {
            service.configure_additional(
                &directory,
                password.ok_or_else(|| {
                    ReadError::new("CREDENTIALS", "A nonempty password is required")
                })?,
            )?;
        } else if let Some(password) = password {
            if detach {
                return Err(ReadError::new(
                    "INVALID_ARGUMENT",
                    "Cannot replace credentials while detaching",
                ));
            }
            let target = backup::config(&service.workspace)?
                .additional
                .ok_or_else(|| {
                    ReadError::new(
                        "ADDITIONAL_UNCONFIGURED",
                        "No additional repository is configured",
                    )
                })?;
            let parent = target.path.parent().ok_or_else(|| {
                ReadError::new("UNSAFE_PATH", "Invalid additional repository path")
            })?;
            service.configure_additional(parent, password)?;
        }
        if detach {
            service.detach_additional()?;
        }
        backup::set_interval(&service.workspace, interval_minutes)
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Settings could not be saved"))?
}
#[tauri::command]
pub(crate) async fn workspace_history_attachment_export(
    id: String,
    generation: String,
    target: PathBuf,
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<(), ReadError> {
    let service = state.native_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Reply::Attachment { mut file, .. } = service.query(Request::Attachment {
            id,
            generation: Some(generation),
            include_trash: true,
        })?
        else {
            return Err(ReadError::new("IPC_PROTOCOL", "Missing Attachment"));
        };
        let parent = target
            .parent()
            .ok_or_else(|| ReadError::new("UNSAFE_PATH", "Choose an absolute output path"))?;
        crate::read_service::checked_directory(parent)?;
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut file, output.as_file_mut())?;
        output.as_file().sync_all()?;
        output
            .persist_noclobber(target)
            .map_err(|_| ReadError::new("TARGET_EXISTS", "Attachment output must be a new file"))?;
        Ok(())
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Attachment export failed"))?
}

/// Pending frontend barrier acknowledgements contain only random request IDs,
/// not note text. No WebView/JS engine is needed in the standalone path.
#[derive(Default)]
pub struct SaveBarriers {
    pending: Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<bool>>>,
}
impl SaveBarriers {
    pub fn wait(&self, app: &tauri::AppHandle) -> Result<(), ReadError> {
        use tauri::Emitter;
        let id = uuid::Uuid::now_v7().to_string();
        let (sender, receiver) = std::sync::mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| busy())?
            .insert(id.clone(), sender);
        if app.emit("memoka-save-barrier", &id).is_err() {
            self.pending.lock().map_err(|_| busy())?.remove(&id);
            return Err(ReadError::new(
                "SAVE_BARRIER_FAILED",
                "Cannot request confirmed Core state",
            ));
        }
        let result = receiver.recv_timeout(Duration::from_secs(15));
        self.pending.lock().map_err(|_| busy())?.remove(&id);
        match result {
            Ok(true) => Ok(()),
            Ok(false) => Err(ReadError::new(
                "SAVE_BARRIER_FAILED",
                "Confirmed Core state could not be saved",
            )),
            Err(_) => Err(ReadError::new(
                "SAVE_BARRIER_TIMEOUT",
                "The editor did not confirm its durable state in time",
            )),
        }
    }
    pub fn acknowledge(&self, id: &str, saved: bool) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(sender) = pending.remove(id) {
                let _ = sender.send(saved);
            }
        }
    }
}
#[tauri::command]
pub(crate) fn workspace_save_barrier_ack(
    id: String,
    saved: bool,
    state: tauri::State<'_, SaveBarriers>,
) {
    state.acknowledge(&id, saved);
}

pub(crate) fn gui_handler(
    app: tauri::AppHandle,
    service: Arc<NativeService>,
) -> crate::workspace_owner::Handler {
    Arc::new(move |request| {
        use tauri::Manager;
        if matches!(request, Request::Activate) {
            crate::foreground_existing_instance(&app).map_err(|_| {
                ReadError::new("ACTIVATION_FAILED", "Cannot activate the existing editor")
            })?;
            return Ok(Reply::Json(json!({"activated":true})));
        }
        if app
            .state::<crate::persistence::ProductPersistenceState>()
            .native_service()?
            .workspace
            != service.workspace
        {
            return Err(ReadError::new(
                "WORKSPACE_CHANGED",
                "The editor switched to another Workspace",
            ));
        }
        if request.needs_barrier() {
            app.state::<SaveBarriers>().wait(&app)?;
        }
        if app
            .state::<crate::persistence::ProductPersistenceState>()
            .native_service()?
            .workspace
            != service.workspace
        {
            return Err(ReadError::new(
                "WORKSPACE_CHANGED",
                "The editor switched to another Workspace",
            ));
        }
        service.query(request)
    })
}

pub(crate) fn history_attachment_response(
    service: Result<Arc<NativeService>, ReadError>,
    path: &str,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::Read;
    let result = (|| {
        let decoded = path
            .trim_start_matches('/')
            .replace("%2F", "/")
            .replace("%2f", "/");
        let parts = decoded.split('/').collect::<Vec<_>>();
        if parts.len() != 2 {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Invalid history Attachment address",
            ));
        }
        let Reply::Attachment { metadata, file } = service?.query(Request::Attachment {
            generation: Some(parts[0].into()),
            id: parts[1].into(),
            include_trash: true,
        })?
        else {
            return Err(ReadError::new("NOT_FOUND", "Missing Attachment"));
        };
        if !["image/png", "image/jpeg", "image/gif", "image/webp"]
            .contains(&metadata.mime_type.as_str())
            || metadata.size > 64 * 1024 * 1024
        {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Use explicit export for this Attachment",
            ));
        }
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != metadata.size {
            return Err(ReadError::new(
                "ATTACHMENT_CORRUPT",
                "Incomplete Attachment",
            ));
        }
        Ok((metadata.mime_type, bytes))
    })();
    match result {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(bytes)
            .expect("valid response"),
        Err(_error) => tauri::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain")
            .body(b"Historical Attachment unavailable".to_vec())
            .expect("valid response"),
    }
}
