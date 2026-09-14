//! Shared GUI/CLI application boundary. Repository work never holds the Core
//! persistence mutex, and copy's source lease does not exclude local capture.
use crate::{
    backup, backup_management, backup_settings,
    document_model::ReadError,
    history,
    read_service::WorkspaceReader,
    restic::{self, Restic},
    workspace_owner::{BackupAction, Reply, Request},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct NativeService {
    pub workspace: PathBuf,
    capture: Arc<Mutex<()>>,
    copy: Arc<Mutex<()>>,
    repositories: Arc<RwLock<()>>,
    preview: Arc<Mutex<()>>,
    operations: Arc<crate::background_operation::Operations>,
    cloud_job: Arc<Mutex<Option<CloudJob>>>,
    cloud_paused: Arc<AtomicBool>,
    departure: Arc<Mutex<Option<String>>>,
    backup_checkpoint: Arc<Mutex<Option<crate::backup_checkpoint::BackupCheckpoint>>>,
    local_maintenance_pending: Arc<AtomicBool>,
    settings: Arc<Mutex<()>>,
    _lease: Option<Arc<crate::workspace_owner::WorkspaceLease>>,
}
struct CloudJob {
    cancel: restic::Cancellation,
    target: Arc<Mutex<Option<String>>>,
    forced: Arc<Mutex<std::collections::VecDeque<String>>>,
    allow_maintenance: Arc<AtomicBool>,
}
struct CloudCompletion {
    jobs: Arc<Mutex<Option<CloudJob>>>,
    cancel: restic::Cancellation,
}
impl Drop for CloudCompletion {
    fn drop(&mut self) {
        if let Ok(mut job) = self.jobs.lock() {
            if job
                .as_ref()
                .is_some_and(|job| Arc::ptr_eq(&job.cancel, &self.cancel))
            {
                *job = None;
            }
        }
    }
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
            capture: Default::default(),
            copy: Default::default(),
            repositories: Default::default(),
            preview: Default::default(),
            operations: Default::default(),
            cloud_job: Default::default(),
            cloud_paused: Default::default(),
            departure: Default::default(),
            backup_checkpoint: Default::default(),
            local_maintenance_pending: Default::default(),
            settings: Default::default(),
            _lease: None,
        }
    }
    pub fn owned(lease: crate::workspace_owner::WorkspaceLease) -> Self {
        let mut value = Self::new(lease.workspace.clone());
        value._lease = Some(Arc::new(lease));
        value
    }
    pub fn cancel(&self) -> Result<(), ReadError> {
        self.cloud_paused.store(true, Ordering::Release);
        self.cancel_cloud(None)?;
        crate::cloud::cancel_all_auth();
        self.operations.cancel()
    }
    pub fn resume(&self) -> Result<(), ReadError> {
        if self.cloud_paused.load(Ordering::Acquire) && self.cloud_running() {
            return Err(busy());
        }
        self.operations.resume()?;
        self.cloud_paused.store(false, Ordering::Release);
        Ok(())
    }
    pub fn running(&self) -> bool {
        self.operations.running() || self.cloud_running() || crate::cloud::auth_running()
    }
    fn cloud_running(&self) -> bool {
        self.cloud_job.lock().map_or(true, |job| job.is_some())
    }
    pub fn cancel_cloud(&self, id: Option<&str>) -> Result<(), ReadError> {
        if let Some(job) = self.cloud_job.lock().map_err(|_| busy())?.as_ref() {
            if let Some(id) = id {
                job.forced
                    .lock()
                    .map_err(|_| busy())?
                    .retain(|item| item != id);
            }
            let target = job.target.lock().map_err(|_| busy())?;
            if id.is_none() || target.is_none() || target.as_deref() == id {
                job.cancel.store(true, Ordering::Release);
            }
        }
        Ok(())
    }
    pub fn schedule_cloud(&self, force: Option<String>) -> Result<Value, ReadError> {
        self.schedule_cloud_work(force, false)
    }
    fn schedule_cloud_work(&self, force: Option<String>, idle: bool) -> Result<Value, ReadError> {
        let allow_maintenance = idle || force.is_some();
        let mut job = self.cloud_job.lock().map_err(|_| busy())?;
        if self.cloud_paused.load(Ordering::Acquire) {
            return Err(ReadError::new(
                "CANCELLED",
                "Background operations are paused",
            ));
        }
        if let Some(id) = &force {
            let target = backup_settings::destination(&self.workspace, id)?;
            if !target.enabled || !target.location.is_cloud() {
                return Err(ReadError::new(
                    "INVALID_ARGUMENT",
                    "Choose an enabled Google Drive destination",
                ));
            }
        }
        if let Some(job) = job.as_ref() {
            if allow_maintenance {
                job.allow_maintenance.store(true, Ordering::Release);
            }
            if let Some(id) = force {
                let mut queue = job.forced.lock().map_err(|_| busy())?;
                if !queue.contains(&id) {
                    queue.push_back(id);
                }
            }
            return Ok(json!({"schema_version":3,"already_running":true,"queued":true}));
        }
        if !backup::config(&self.workspace)?
            .destinations
            .iter()
            .any(|t| t.enabled && t.location.is_cloud())
        {
            return Ok(json!({"schema_version":3,"queued":false}));
        }
        if !allow_maintenance && self.cloud_work_is_current()? {
            return Ok(json!({"schema_version":3,"queued":false,"reason":"already-uploaded"}));
        }
        let cancel = restic::cancellation();
        let allow_maintenance = Arc::new(AtomicBool::new(allow_maintenance));
        let target = Arc::new(Mutex::new(None));
        let forced = Arc::new(Mutex::new(
            force.into_iter().collect::<std::collections::VecDeque<_>>(),
        ));
        *job = Some(CloudJob {
            cancel: cancel.clone(),
            target: target.clone(),
            forced: forced.clone(),
            allow_maintenance: allow_maintenance.clone(),
        });
        let service = self.clone();
        std::thread::spawn(move || {
            let _completion = CloudCompletion {
                jobs: service.cloud_job.clone(),
                cancel: cancel.clone(),
            };
            let base = Restic::discover(cancel.clone()).and_then(|r| r.with_transfer_cache());
            loop {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let maintenance_at_start = allow_maintenance.load(Ordering::Acquire);
                let result = (|| {
                    let force = forced.lock().map_err(|_| busy())?.pop_front();
                    let _source_lease = service.repositories.try_read().map_err(|_| busy())?;
                    let policy = if service.departing() {
                        backup_management::CloudWorkPolicy::UploadOnly
                    } else if maintenance_at_start {
                        backup_management::CloudWorkPolicy::All
                    } else {
                        backup_management::CloudWorkPolicy::UploadAndVerify
                    };
                    if force.is_none()
                        && policy != backup_management::CloudWorkPolicy::All
                        && service.cloud_work_is_current()?
                    {
                        return Ok(false);
                    }
                    let restic = base
                        .as_ref()
                        .map_err(Clone::clone)?
                        .within(Duration::from_secs(3600));
                    backup_management::cloud_unit(
                        &service.workspace,
                        &restic,
                        force.as_deref(),
                        policy,
                        |id| {
                            if let Ok(mut value) = target.lock() {
                                *value = Some(id.into());
                            }
                        },
                    )
                })();
                match result {
                    Ok(true) => {
                        // An idle request can yield between successful cloud
                        // generations. An endless pending queue must not pin
                        // the local retention set forever. Never treat a
                        // failed transfer as successful deletion cleanup.
                        let last_succeeded = target
                            .lock()
                            .ok()
                            .and_then(|id| id.clone())
                            .and_then(|id| {
                                backup::status(&service.workspace)
                                    .ok()
                                    .and_then(|status| status.destinations.get(&id).cloned())
                            })
                            .is_some_and(|status| {
                                status.error.is_none()
                                    && status.maintenance_error.is_none()
                                    && status.verification_error.is_none()
                            });
                        if last_succeeded
                            && !cancel.load(Ordering::Acquire)
                            && !service.departing()
                            && service
                                .local_maintenance_pending
                                .swap(false, Ordering::AcqRel)
                        {
                            if service
                                .maintain(false, true, cancel.clone())
                                .is_err_and(|error| error.code == "BACKUP_BUSY")
                            {
                                service
                                    .local_maintenance_pending
                                    .store(true, Ordering::Release);
                            }
                        }
                        continue;
                    }
                    Ok(false) => {
                        // Enqueue and the empty -> stopped transition use the
                        // same lock. Do not drop an explicit retry queued just
                        // as the last background unit finishes.
                        if let Ok(mut job) = service.cloud_job.lock() {
                            if forced.lock().is_ok_and(|queue| !queue.is_empty()) {
                                continue;
                            }
                            // Do not lose an idle request arriving just as an
                            // upload/verification worker discovers an empty queue.
                            if !maintenance_at_start
                                && allow_maintenance.load(Ordering::Acquire)
                                && !service.departing()
                            {
                                continue;
                            }
                            *job = None;
                        }
                        break;
                    }
                    Err(error) => {
                        if error.code != "BACKUP_BUSY" {
                            let _ = backup::update_status(&service.workspace, |status| {
                                let ids = if let Ok(Some(id)) = target.lock().map(|s| s.clone()) {
                                    vec![id]
                                } else {
                                    backup::config(&service.workspace)
                                        .map(|config| {
                                            config
                                                .destinations
                                                .into_iter()
                                                .filter(|t| t.enabled && t.location.is_cloud())
                                                .map(|t| t.id)
                                                .collect()
                                        })
                                        .unwrap_or_default()
                                };
                                for id in ids {
                                    let state = status.destinations.entry(id).or_default();
                                    state.phase = "error".into();
                                    state.error = Some(error.clone());
                                }
                            });
                        }
                        break;
                    }
                }
            }
        });
        Ok(json!({"schema_version":3,"queued":true}))
    }
    pub fn wait_transfers(&self) -> Result<Value, ReadError> {
        // Standalone CLI waits own the process lifetime, not a GUI departure.
        self.wait_transfers_for(None)
    }
    pub(crate) fn departing(&self) -> bool {
        self.departure.lock().map_or(true, |id| id.is_some())
    }
    fn wait_transfers_for(&self, departure_id: Option<&str>) -> Result<Value, ReadError> {
        while self.cloud_running() {
            if let Some(id) = departure_id {
                if self.departure.lock().map_err(|_| busy())?.as_deref() != Some(id) {
                    // Withdrawing quit/switch/update only detaches this wait.
                    // Never signal the worker or alter its transfer status.
                    return Ok(json!({"schema_version":3,"detached":true}));
                }
            }
            if crate::sidecar::interrupted() {
                self.cancel_cloud(None)?;
                while self.cloud_running() {
                    std::thread::sleep(Duration::from_millis(25));
                }
                return Err(ReadError::new("CANCELLED", "Backup interrupted"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.backup(BackupAction::Status)
    }
    pub fn query(&self, request: Request) -> Result<Reply, ReadError> {
        match request {
            Request::SyncStatus => {
                crate::replication::controller::read_status(&self.workspace).map(Reply::Json)
            }
            Request::SectionEdit { request, dry_run } => {
                if self._lease.is_none() || self.departing() {
                    return Err(ReadError::new(
                        "EDIT_BUSY",
                        "Editing requires the Workspace owner",
                    ));
                }
                crate::agent_edit::standalone(&self.workspace, request, dry_run).map(Reply::Json)
            }
            Request::NoteEdit { request, dry_run } => {
                if self._lease.is_none() || self.departing() {
                    return Err(ReadError::new(
                        "EDIT_BUSY",
                        "Editing requires the Workspace owner",
                    ));
                }
                crate::agent_edit::standalone(&self.workspace, request, dry_run).map(Reply::Json)
            }
            Request::Edit { request, dry_run } => {
                if self._lease.is_none() || self.departing() {
                    return Err(ReadError::new(
                        "EDIT_BUSY",
                        "Editing requires the Workspace owner",
                    ));
                }
                crate::agent_edit::standalone(&self.workspace, request, dry_run).map(Reply::Json)
            }
            Request::ReadForEdit { id, limit, cursor } => {
                crate::agent_edit::read_for_edit(&self.workspace, &id, limit, cursor.as_deref())
                    .map(Reply::Json)
            }
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
                let config = backup::config(&self.workspace)?;
                let mut status = backup::status(&self.workspace)?;
                if status.phase.is_empty() {
                    status.phase = "uninitialized".into();
                }
                status
                    .destinations
                    .retain(|id, _| config.destinations.iter().any(|target| &target.id == id));
                for target in &config.destinations {
                    let value = status.destinations.entry(target.id.clone()).or_default();
                    if let Some(progress) =
                        crate::backup_progress::live(&self.workspace, &target.id)
                    {
                        value.progress = Some(progress);
                    }
                    if !target.enabled {
                        value.phase = if self.running()
                            && matches!(
                                value.phase.as_str(),
                                "copying" | "verifying" | "maintaining"
                            ) {
                            "stopping"
                        } else {
                            "disabled"
                        }
                        .into();
                    } else if value.phase.is_empty() {
                        value.phase = "pending".into();
                    }
                }
                Ok(
                    json!({"schema_version":3,"config":config,"status":status,"content_epoch":backup::content_epoch(&self.workspace)?}),
                )
            }
            BackupAction::Run => self.run_cycle(),
            BackupAction::RepositoryLocks {
                destination_id,
                repair,
            } => self.repository_locks(destination_id.as_deref(), repair),
            BackupAction::CloudTick { id } => self.schedule_cloud(id),
            BackupAction::WaitTransfers { departure_id } => {
                self.wait_transfers_for(departure_id.as_deref())
            }
            BackupAction::Departure { active, id } => {
                // Stop only at unit boundaries. Never cancel an in-flight
                // upload (or its repository lock cleanup) to meet an exit timer.
                let mut departure = self.departure.lock().map_err(|_| busy())?;
                if active {
                    *departure = Some(id);
                } else if departure.as_deref() == Some(&id) {
                    // A delayed cancellation cannot clear a newer departure.
                    *departure = None;
                }
                Ok(json!({"schema_version":3,"departing":departure.is_some()}))
            }
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
                self.invalidate_backup_checkpoint();
                let operation = self.operations.begin()?;
                let mut result = self.maintain(dry_run, true, operation.cancel.clone())?;
                // Release the local writer lease before any network work.
                // Connection/repository leases serialize cloud maintenance.
                let restic =
                    Restic::discover(operation.cancel.clone())?.within(Duration::from_secs(3600));
                let cloud = self.maintain_destinations(&restic, dry_run, true, true)?;
                if let Some(destinations) = result["destinations"].as_array_mut() {
                    destinations.extend(cloud);
                }
                Ok(result)
            }
            BackupAction::IdleMaintain => {
                self.schedule_cloud_work(None, true)?;
                if self.cloud_running() {
                    if backup_management::idle_maintenance_due(&self.workspace)? {
                        self.local_maintenance_pending
                            .store(true, Ordering::Release);
                    }
                    return Ok(
                        json!({"schema_version":3,"skipped":true,"reason":"copy-source-reader-active"}),
                    );
                }
                let operation = self.operations.begin()?;
                if !backup_management::idle_maintenance_due(&self.workspace)? {
                    return Ok(json!({"schema_version":3,"skipped":true}));
                }
                self.maintain(false, true, operation.cancel.clone())
            }
            BackupAction::Check { full } => {
                self.invalidate_backup_checkpoint();
                let operation = self.operations.begin()?;
                let _lease = self.repositories.try_write().map_err(|_| busy())?;
                let restic = Restic::discover(operation.cancel.clone())?;
                let repo = backup::local_repository(&self.workspace, &restic, false)?;
                backup_management::check(&restic, &repo, full)
            }
        }
    }
    fn backup_is_current(&self) -> bool {
        self.backup_checkpoint.lock().is_ok_and(|checkpoint| {
            checkpoint
                .as_ref()
                .is_some_and(|checkpoint| checkpoint.is_current(&self.workspace).unwrap_or(false))
        })
    }
    fn cloud_work_is_current(&self) -> Result<bool, ReadError> {
        Ok(self.backup_is_current()
            && (self.departing() || !backup_management::verification_due(&self.workspace)?))
    }
    fn invalidate_backup_checkpoint(&self) {
        if let Ok(mut checkpoint) = self.backup_checkpoint.lock() {
            *checkpoint = None;
        }
    }
    pub fn run_cycle(&self) -> Result<Value, ReadError> {
        let operation = self.operations.begin()?;
        let local = {
            let _capture = self.capture.try_lock().map_err(|_| busy())?;
            let _lease = self.repositories.try_read().map_err(|_| busy())?;
            if self.backup_is_current() {
                return Ok(
                    json!({"schema_version":3,"local_generation":null,"destinations":[],"transfer_error":null,"maintenance":null,"skipped":true,"reason":"already-uploaded"}),
                );
            }
            self.invalidate_backup_checkpoint();
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
        let transfers = self.copy_local(operation.cancel.clone());
        let transfer_failed = transfers.as_ref().map_or(true, |value| {
            value["destinations"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.get("error").is_some()))
        });
        // A failed transfer is not a successful cycle. Do not immediately
        // delete retained generations as its "success cleanup". Independent
        // later idle/manual maintenance still applies local retention, so an
        // offline destination cannot pin pending generations indefinitely.
        let maintenance = if local.is_some()
            && !transfer_failed
            && !operation.cancel.load(Ordering::Acquire)
            && !self.departing()
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
        let (destinations, error) = match transfers {
            Ok(value) => (value["destinations"].clone(), None),
            Err(error) => (json!([]), Some(error)),
        };
        if !transfer_failed && !operation.cancel.load(Ordering::Acquire) {
            // Failure to cache is only a missed optimization. Never turn a
            // successfully verified backup into an error or trust stale proof.
            if let (Ok(_capture), Ok(_lease)) =
                (self.capture.try_lock(), self.repositories.try_read())
            {
                if let Ok(mut checkpoint) = self.backup_checkpoint.lock() {
                    *checkpoint =
                        crate::backup_checkpoint::BackupCheckpoint::record(&self.workspace)
                            .ok()
                            .flatten();
                }
            }
        }
        if !operation.cancel.load(Ordering::Acquire) {
            self.schedule_cloud(None)?;
        }
        Ok(
            json!({"schema_version":3,"local_generation":local,"destinations":destinations,"transfer_error":error,"maintenance":maintenance}),
        )
    }
    fn repository_locks(
        &self,
        destination_id: Option<&str>,
        repair: bool,
    ) -> Result<Value, ReadError> {
        let operation = self.operations.begin()?;
        // Exclude our capture/copy/preview/retention workers for the entire
        // check/recovery. Cloud's connection/repository OS leases also exclude
        // another local Workspace/CLI, while Restic protects remote readers.
        let _lease = self.repositories.try_write().map_err(|_| {
            ReadError::new(
                "BACKUP_BUSY",
                "バックアップ処理が実行中です。完了または中止後にロックを確認してください。",
            )
        })?;
        let restic = Restic::discover(operation.cancel.clone())?;
        let target = destination_id
            .map(|id| backup_settings::destination(&self.workspace, id))
            .transpose()?;
        let repo = match &target {
            Some(target) => {
                backup_management::additional_repository(&self.workspace, target, &restic)?
            }
            None => backup::local_repository(&self.workspace, &restic, false)?,
        };
        let expected =
            match &target {
                Some(target) => target.repository_id.clone(),
                None => backup_settings::read_local_repository_id(&self.workspace)?.ok_or_else(
                    || ReadError::new("REPOSITORY_MISSING", "Local history is not initialized"),
                )?,
            };
        let report = if repair {
            crate::backup_locks::recover(&restic, &repo, &expected)?
        } else {
            crate::backup_locks::inspect(&restic, &repo, &expected)?
        };
        if repair && report.locks.is_empty() {
            backup::update_status(&self.workspace, |status| {
                let clear = |error: &mut Option<ReadError>| {
                    if error
                        .as_ref()
                        .is_some_and(|e| e.code == "REPOSITORY_LOCKED")
                    {
                        *error = None;
                        true
                    } else {
                        false
                    }
                };
                if let Some(target) = &target {
                    if let Some(s) = status.destinations.get_mut(&target.id) {
                        let cleared = clear(&mut s.error)
                            | clear(&mut s.maintenance_error)
                            | clear(&mut s.verification_error);
                        if cleared
                            && s.error.is_none()
                            && s.maintenance_error.is_none()
                            && s.verification_error.is_none()
                        {
                            s.failure_count = 0;
                            s.next_retry_at = None;
                            s.phase = if target.enabled {
                                "pending"
                            } else {
                                "disabled"
                            }
                            .into();
                        }
                    }
                } else {
                    clear(&mut status.local_error);
                    clear(&mut status.maintenance_error);
                }
                // Protection, transfer queues, history and the previous failed
                // progress remain unchanged: unlocking is not a successful copy.
            })?;
        }
        Ok(serde_json::to_value(report)?)
    }
    fn copy(&self, budget: Duration, cancel: restic::Cancellation) -> Result<Value, ReadError> {
        self.invalidate_backup_checkpoint();
        let _copy = self.copy.try_lock().map_err(|_| busy())?;
        let _lease = self.repositories.try_read().map_err(|_| busy())?;
        if cancel.load(Ordering::Acquire) {
            return Err(ReadError::new("CANCELLED", "Additional copy cancelled"));
        }
        let result = Restic::discover(cancel)
            .and_then(|restic| backup_management::copy(&self.workspace, &restic, budget));
        if let Err(error) = &result {
            let targets = backup::config(&self.workspace)?.destinations;
            backup::update_status(&self.workspace, |status| {
                for target in targets.iter().filter(|item| item.enabled) {
                    let state = status.destinations.entry(target.id.clone()).or_default();
                    state.phase = "error".into();
                    state.error = Some(error.clone());
                }
            })?;
        }
        result
    }
    fn copy_local(&self, cancel: restic::Cancellation) -> Result<Value, ReadError> {
        let _copy = self.copy.try_lock().map_err(|_| busy())?;
        let _lease = self.repositories.try_read().map_err(|_| busy())?;
        let restic = Restic::discover(cancel)?;
        backup_management::copy_local(&self.workspace, &restic)
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
            let destinations = self.maintain_destinations(&restic, dry_run, prune, false)?;
            Ok(
                json!({"schema_version":3,"dry_run":dry_run,"local":local,"destinations":destinations}),
            )
        })();
        backup::update_status(&self.workspace, |status| {
            status.maintenance_error = result.as_ref().err().cloned();
            status.phase = "idle".into();
        })?;
        if result.is_err() {
            self.invalidate_backup_checkpoint();
        }
        // Successful idle maintenance that changed no snapshot need not throw
        // away the receipt. Actual forget/prune changes fail its file check.
        result
    }
    fn maintain_destinations(
        &self,
        restic: &Restic,
        dry_run: bool,
        prune: bool,
        cloud: bool,
    ) -> Result<Vec<Value>, ReadError> {
        let mut destinations = Vec::new();
        for target in backup::config(&self.workspace)?
            .destinations
            .into_iter()
            .filter(|target| target.enabled && target.location.is_cloud() == cloud)
        {
            if restic.cancel.load(Ordering::Acquire) {
                return Err(ReadError::new("CANCELLED", "Maintenance cancelled"));
            }
            if !backup_settings::destination(&self.workspace, &target.id)?.enabled {
                continue;
            }
            let status = backup::status(&self.workspace)?;
            if !status
                .destinations
                .get(&target.id)
                .is_some_and(|state| state.error.is_none() && state.protected_capture_at.is_some())
            {
                continue;
            }
            backup::update_status(&self.workspace, |status| {
                status
                    .destinations
                    .entry(target.id.clone())
                    .or_default()
                    .phase = "maintaining".into();
            })?;
            let outcome =
                backup_management::additional_repository(&self.workspace, &target, restic)
                    .and_then(|repo| {
                        backup_management::maintain_repository(
                            &self.workspace,
                            restic,
                            &repo,
                            dry_run,
                            prune,
                        )
                    });
            let error = outcome
                .as_ref()
                .err()
                .filter(|error| error.code != "DESTINATION_DISABLED")
                .cloned();
            backup::update_status(&self.workspace, |status| {
                let state = status.destinations.entry(target.id.clone()).or_default();
                state.phase = "idle".into();
                state.maintenance_error = error.clone();
            })?;
            destinations.push(match outcome {
                Ok(plan) => json!({"id":target.id,"plan":plan}),
                Err(_) if error.is_none() => json!({"id":target.id,"skipped":true}),
                Err(_) => json!({"id":target.id,"error":error}),
            });
        }
        Ok(destinations)
    }
    pub fn settings(&self, request: BackupSettingsRequest) -> Result<(), ReadError> {
        self.invalidate_backup_checkpoint();
        // Metadata-only settings remain usable during copy/maintenance. Each
        // worker observes enabled state before starting the next unit of work.
        match request {
            BackupSettingsRequest::Local {
                interval_minutes,
                retention,
            } => backup_settings::set_local(&self.workspace, interval_minutes, retention),
            BackupSettingsRequest::Enabled { id, enabled } => {
                if !enabled {
                    self.cancel_cloud(Some(&id))?;
                }
                backup_settings::update_destination(&self.workspace, &id, |target| {
                    target.enabled = enabled
                })
            }
            BackupSettingsRequest::Retention { id, retention } => {
                retention.validate()?;
                backup_settings::update_destination(&self.workspace, &id, |target| {
                    target.retention = retention
                })
            }
            request => {
                let operation = self.operations.begin()?;
                let _settings = self.settings.try_lock().map_err(|_| busy())?;
                let _lease = self.repositories.try_read().map_err(|_| busy())?;
                match request {
                    BackupSettingsRequest::AddGoogleDrive {
                        connection_id,
                        retry_intent,
                        password,
                        retention,
                    } => crate::cloud::CloudService::discover()?.configure_destination(
                        &self.workspace,
                        &connection_id,
                        retry_intent.as_deref(),
                        password,
                        retention,
                        &Restic::discover(operation.cancel.clone())?,
                    ),
                    BackupSettingsRequest::Add {
                        directory,
                        password,
                        retention,
                    } => backup_management::configure_additional(
                        &self.workspace,
                        &Restic::discover(operation.cancel.clone())?,
                        &directory,
                        password,
                        retention,
                    ),
                    BackupSettingsRequest::Credential { id, password } => {
                        backup_management::register_credential(
                            &self.workspace,
                            &Restic::discover(operation.cancel.clone())?,
                            &id,
                            password,
                        )
                    }
                    BackupSettingsRequest::Remove { id } => {
                        self.cancel_cloud(Some(&id))?;
                        // A running target owns the connection. Retrying Remove
                        // after cancellation avoids changing its in-flight ledger.
                        backup_management::detach_additional(&self.workspace, &id)
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
}

// Do not derive Debug: requests may carry passwords, never returned in state.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BackupSettingsRequest {
    AddGoogleDrive {
        connection_id: String,
        retry_intent: Option<String>,
        password: String,
        retention: backup::Retention,
    },
    Local {
        interval_minutes: u32,
        retention: backup::Retention,
    },
    Add {
        directory: PathBuf,
        password: String,
        retention: backup::Retention,
    },
    Retention {
        id: String,
        retention: backup::Retention,
    },
    Enabled {
        id: String,
        enabled: bool,
    },
    Remove {
        id: String,
    },
    Credential {
        id: String,
        password: String,
    },
}

#[cfg(test)]
mod cloud_scheduler_tests {
    use super::*;
    #[test]
    fn verified_unchanged_cycles_skip_children_but_edits_and_cold_starts_do_not() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().to_owned();
        backup::tests::fixture(&workspace);
        let service = NativeService::new(workspace.clone());
        assert!(!service.backup_is_current());
        let started = std::time::Instant::now();
        let first = service.run_cycle().unwrap();
        let full_ms = started.elapsed().as_millis();
        assert!(first["local_generation"].is_object());
        assert!(service.backup_is_current());
        let before: Value = backup::setting(&workspace, "backup.status").unwrap();
        let started = std::time::Instant::now();
        let warm = service.run_cycle().unwrap();
        let warm_us = started.elapsed().as_micros();
        assert_eq!(warm["skipped"], true);
        assert_eq!(warm["reason"], "already-uploaded");
        assert_eq!(
            before,
            backup::setting::<Value>(&workspace, "backup.status").unwrap()
        );
        assert!(!service.cloud_running());

        // A persisted "idle" status cannot seed a process-local receipt.
        let reopened = NativeService::new(workspace.clone());
        assert!(!reopened.backup_is_current());
        let started = std::time::Instant::now();
        let cold = reopened.run_cycle().unwrap();
        let cold_ms = started.elapsed().as_millis();
        eprintln!(
            "backup cycle: capture {full_ms} ms; unchanged cold {cold_ms} ms, warm {warm_us} us (no Restic/transport)"
        );
        assert!(cold["local_generation"].is_null());
        assert!(cold.get("skipped").is_none());
        assert!(reopened.backup_is_current());
        service.backup(BackupAction::IdleMaintain).unwrap();
        assert!(
            service.backup_is_current(),
            "no-op idle retention must preserve the warm receipt"
        );
        let epoch = backup::content_epoch(&workspace).unwrap();
        backup::save_setting(&workspace, "content_epoch", &(epoch + 1)).unwrap();
        assert!(!service.backup_is_current());
        let changed = service.run_cycle().unwrap();
        assert_eq!(
            changed["local_generation"]["descriptor"]["content_epoch"],
            epoch + 1
        );
        assert_eq!(service.run_cycle().unwrap()["skipped"], true);
        let path = restic::Repository::local(&workspace)
            .local_path()
            .unwrap()
            .to_owned();
        let offline = temp.path().join("offline-history");
        std::fs::rename(&path, &offline).unwrap();
        assert!(!service.backup_is_current());
        assert_eq!(service.run_cycle().unwrap_err().code, "REPOSITORY_MISSING");
    }
    #[test]
    fn uploaded_cloud_generations_do_not_restart_jobs_or_cancel_running_verification() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().to_owned();
        backup::tests::fixture(&workspace);
        let service = NativeService::new(workspace.clone());
        let generation: backup::Generation =
            serde_json::from_value(service.run_cycle().unwrap()["local_generation"].clone())
                .unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let repository_id = "b".repeat(64);
        let mut config = backup::config(&workspace).unwrap();
        config.destinations.push(backup::AdditionalTarget {
            id: id.clone(),
            location: backup_settings::DestinationLocation::GoogleDrive {
                connection_id: uuid::Uuid::now_v7().to_string(),
                root_folder_id: "test-only-folder".into(),
                display_name: "test-only".into(),
            },
            repository_id: repository_id.clone(),
            credential_ref: "not-accessed".into(),
            enabled: true,
            retention: Default::default(),
        });
        backup::save_setting(&workspace, "backup.config", &config).unwrap();
        let ledger = backup_settings::TransferLedger {
            repository_id: Some(repository_id),
            awaiting_verification: std::collections::BTreeMap::from([(
                generation.descriptor.generation_id.clone(),
                generation,
            )]),
            ..Default::default()
        };
        backup_settings::save_transfer(&workspace, &id, &ledger, |s| {
            s.phase = "verification-pending".into();
        })
        .unwrap();
        // Model an upload acknowledgement without ever opening Google or the
        // OS credential store. The source was verified by the real local run.
        *service.backup_checkpoint.lock().unwrap() =
            crate::backup_checkpoint::BackupCheckpoint::record(&workspace).unwrap();
        assert!(service.backup_is_current());
        // Uploaded data may skip capture/copy, but must still wake verification
        // without waiting for an idle request. This check performs no I/O to Drive.
        assert!(backup_management::verification_due(&workspace).unwrap());
        assert!(!service.cloud_work_is_current().unwrap());
        service
            .backup(BackupAction::Departure {
                active: true,
                id: "quit".into(),
            })
            .unwrap();
        let before: Value = backup::setting(&workspace, "backup.status").unwrap();
        assert!(service.cloud_work_is_current().unwrap());
        assert_eq!(service.schedule_cloud(None).unwrap()["queued"], false);
        assert_eq!(service.run_cycle().unwrap()["skipped"], true);
        assert!(!service.cloud_running());
        let cancel = restic::cancellation();
        *service.cloud_job.lock().unwrap() = Some(CloudJob {
            cancel: cancel.clone(),
            target: Default::default(),
            forced: Default::default(),
            allow_maintenance: Default::default(),
        });
        assert_eq!(service.run_cycle().unwrap()["skipped"], true);
        assert!(service.cloud_running());
        assert!(!cancel.load(Ordering::Acquire));
        assert_eq!(
            before,
            backup::setting::<Value>(&workspace, "backup.status").unwrap()
        );
        *service.cloud_job.lock().unwrap() = None;
    }
    #[test]
    fn completion_from_previous_worker_cannot_clear_new_worker() {
        let jobs = Arc::new(Mutex::new(None));
        let old = CloudCompletion {
            jobs: jobs.clone(),
            cancel: restic::cancellation(),
        };
        let new_cancel = restic::cancellation();
        *jobs.lock().unwrap() = Some(CloudJob {
            cancel: new_cancel.clone(),
            target: Default::default(),
            forced: Default::default(),
            allow_maintenance: Default::default(),
        });
        drop(old);
        assert!(jobs.lock().unwrap().is_some());
        drop(CloudCompletion {
            jobs: jobs.clone(),
            cancel: new_cancel,
        });
        assert!(jobs.lock().unwrap().is_none());
    }
    #[test]
    fn idle_requests_enable_maintenance_but_departure_does_not_cancel_active_work() {
        let service = NativeService::new(PathBuf::from("unused"));
        let allow_maintenance = Arc::new(AtomicBool::new(false));
        let cancel = restic::cancellation();
        *service.cloud_job.lock().unwrap() = Some(CloudJob {
            cancel: cancel.clone(),
            target: Default::default(),
            forced: Default::default(),
            allow_maintenance: allow_maintenance.clone(),
        });
        service.schedule_cloud(None).unwrap();
        assert!(!allow_maintenance.load(Ordering::Acquire));
        service.schedule_cloud_work(None, true).unwrap();
        assert!(allow_maintenance.load(Ordering::Acquire));
        service
            .backup(BackupAction::Departure {
                active: true,
                id: "first".into(),
            })
            .unwrap();
        assert!(service.departing());
        assert!(!cancel.load(Ordering::Acquire));
        service
            .backup(BackupAction::Departure {
                active: false,
                id: "first".into(),
            })
            .unwrap();
        assert!(!service.departing());
        assert!(!cancel.load(Ordering::Acquire));
    }
    #[test]
    fn departure_wait_has_no_thirty_second_deadline() {
        let directory = tempfile::tempdir().unwrap();
        backup::tests::fixture(directory.path());
        let service = NativeService::new(directory.path().to_owned());
        service
            .backup(BackupAction::Departure {
                active: true,
                id: "first".into(),
            })
            .unwrap();
        let cancel = restic::cancellation();
        *service.cloud_job.lock().unwrap() = Some(CloudJob {
            cancel: cancel.clone(),
            target: Default::default(),
            forced: Default::default(),
            allow_maintenance: Default::default(),
        });
        let waiting = service.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            send.send(waiting.backup(BackupAction::WaitTransfers {
                departure_id: Some("first".into()),
            }))
            .unwrap();
        });
        let early = receive.recv_timeout(Duration::from_secs(31));
        let cancelled = cancel.load(Ordering::Acquire);
        *service.cloud_job.lock().unwrap() = None;
        thread.join().unwrap();
        assert!(matches!(
            early,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(!cancelled);
        assert!(receive.recv().unwrap().is_ok());
    }
    #[test]
    fn withdrawing_departure_detaches_only_its_wait_not_the_cloud_worker_or_cli() {
        let directory = tempfile::tempdir().unwrap();
        backup::tests::fixture(directory.path());
        let service = NativeService::new(directory.path().to_owned());
        let original_status: Value = backup::setting(directory.path(), "backup.status").unwrap();
        let cancel = restic::cancellation();
        *service.cloud_job.lock().unwrap() = Some(CloudJob {
            cancel: cancel.clone(),
            target: Default::default(),
            forced: Default::default(),
            allow_maintenance: Default::default(),
        });
        let departure = |active, id: &str| {
            service
                .backup(BackupAction::Departure {
                    active,
                    id: id.into(),
                })
                .unwrap()
        };
        departure(true, "first");
        let wait = |id: Option<&str>| {
            let waiting = service.clone();
            let id = id.map(String::from);
            let (send, receive) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                send.send(if let Some(id) = id {
                    waiting.backup(BackupAction::WaitTransfers {
                        departure_id: Some(id),
                    })
                } else {
                    waiting.wait_transfers()
                })
                .unwrap();
            });
            (thread, receive)
        };
        let (first, first_result) = wait(Some("first"));
        let (cli, cli_result) = wait(None);
        let still_waiting = first_result.recv_timeout(Duration::from_millis(100));
        // The next :qa can arrive before the first observer's next poll.
        departure(false, "first");
        departure(true, "second");
        let detached = first_result.recv_timeout(Duration::from_secs(2));
        let late_cancel = departure(false, "first");
        // An IPC wait arriving after withdrawal also cannot adopt the new ID.
        let late_wait = service.backup(BackupAction::WaitTransfers {
            departure_id: Some("first".into()),
        });
        let (second, second_result) = wait(Some("second"));
        let new_waiting = second_result.recv_timeout(Duration::from_millis(100));
        departure(false, "second");
        let second_detached = second_result.recv_timeout(Duration::from_secs(2));
        let cli_still_waiting = cli_result.recv_timeout(Duration::from_millis(100));
        let worker_still_running = service.cloud_running();
        let transfer_cancelled = cancel.load(Ordering::Acquire);
        let status_after: Value = backup::setting(directory.path(), "backup.status").unwrap();
        // Finish the simulated upload and reap test threads even on a failed assertion.
        *service.cloud_job.lock().unwrap() = None;
        first.join().unwrap();
        second.join().unwrap();
        cli.join().unwrap();
        assert!(matches!(
            still_waiting,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(detached.unwrap().unwrap()["detached"], true);
        assert_eq!(late_cancel["departing"], true);
        assert_eq!(late_wait.unwrap()["detached"], true);
        assert!(matches!(
            new_waiting,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(second_detached.unwrap().unwrap()["detached"], true);
        assert!(matches!(
            cli_still_waiting,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(cli_result.recv().unwrap().is_ok());
        assert!(worker_still_running);
        assert!(!transfer_cancelled);
        assert!(!service.cloud_paused.load(Ordering::Acquire));
        assert!(!service.departing());
        assert_eq!(original_status, status_after);
    }
    #[test]
    fn lock_recovery_excludes_in_process_work_and_does_not_capture_or_claim_protection() {
        let temp = tempfile::tempdir().unwrap();
        crate::backup::tests::fixture(temp.path());
        let restic = Restic::discover(restic::cancellation()).unwrap();
        crate::backup::run_local(temp.path(), &restic).unwrap();
        let before = backup::status(temp.path()).unwrap();
        let epoch = backup::content_epoch(temp.path()).unwrap();
        let service = NativeService::new(temp.path().into());
        {
            let _working = service.repositories.read().unwrap();
            assert_eq!(
                service.repository_locks(None, true).unwrap_err().code,
                "BACKUP_BUSY"
            );
        }
        backup::update_status(temp.path(), |s| {
            s.maintenance_error = Some(ReadError::new("REPOSITORY_LOCKED", "old lock"))
        })
        .unwrap();
        let observed = service.repository_locks(None, false).unwrap();
        assert_eq!(observed["locks"], json!([]));
        assert!(
            backup::status(temp.path())
                .unwrap()
                .maintenance_error
                .is_some()
        );
        service.repository_locks(None, true).unwrap();
        let after = backup::status(temp.path()).unwrap();
        assert!(after.maintenance_error.is_none());
        assert_eq!(before.last_local_capture_at, after.last_local_capture_at);
        assert_eq!(epoch, backup::content_epoch(temp.path()).unwrap());
        backup::update_status(temp.path(), |s| {
            s.maintenance_error = Some(ReadError::new("OTHER_ERROR", "unrelated"))
        })
        .unwrap();
        service.repository_locks(None, true).unwrap();
        assert_eq!(
            backup::status(temp.path())
                .unwrap()
                .maintenance_error
                .unwrap()
                .code,
            "OTHER_ERROR"
        );
    }
    #[test]
    fn explicit_cancel_stops_transfer_and_late_ticks_stay_paused() {
        let directory = tempfile::tempdir().unwrap();
        let service = NativeService::new(directory.path().to_owned());
        let cancel = restic::cancellation();
        *service.cloud_job.lock().unwrap() = Some(CloudJob {
            cancel: cancel.clone(),
            target: Arc::new(Mutex::new(Some("target".into()))),
            forced: Default::default(),
            allow_maintenance: Default::default(),
        });
        assert!(!cancel.load(Ordering::Acquire));
        assert!(service.cloud_running());
        service.cancel().unwrap();
        assert!(cancel.load(Ordering::Acquire));
        assert_eq!(service.schedule_cloud(None).unwrap_err().code, "CANCELLED");
        assert!(service.resume().is_err());
        *service.cloud_job.lock().unwrap() = None;
        service.resume().unwrap();
        assert!(!service.cloud_paused.load(Ordering::Acquire));
    }
    #[test]
    fn source_copy_reader_allows_capture_and_history_but_excludes_prune() {
        let service = NativeService::new(PathBuf::from("unused"));
        let _copy = service.repositories.try_read().unwrap();
        assert!(service.repositories.try_read().is_ok());
        assert!(service.capture.try_lock().is_ok());
        assert!(service.preview.try_lock().is_ok());
        assert!(service.repositories.try_write().is_err());
        assert!(service.settings.try_lock().is_ok());
    }
    #[test]
    fn status_overlays_live_progress_without_writing_or_opening_an_offline_target() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        backup::tests::fixture(&workspace);
        let mut config = backup::config(&workspace).unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        config.destinations.push(crate::backup::AdditionalTarget {
            id: id.clone(),
            location: backup_settings::DestinationLocation::LocalDirectory {
                path: temp.path().join("must-not-be-opened"),
            },
            repository_id: "b".repeat(64),
            credential_ref: "must-not-access-keyring".into(),
            enabled: true,
            retention: Default::default(),
        });
        backup::save_setting(&workspace, "backup.config", &config).unwrap();
        let service = NativeService::new(workspace.clone());
        let epoch = backup::content_epoch(&workspace).unwrap();
        let before: Value = backup::setting(&workspace, "backup.status").unwrap();
        let progress = crate::backup_progress::Progress::start(&workspace, &id, 4);
        progress.completed(3);
        progress.stage(crate::backup_progress::Stage::TargetVerification);
        for _ in 0..3 {
            let response = service.backup(BackupAction::Status).unwrap();
            assert_eq!(
                response["status"]["destinations"][&id]["progress"]["completed_generations"],
                3
            );
            assert_eq!(
                response["status"]["destinations"][&id]["progress"]["stage"],
                "target-verification"
            );
        }
        assert_eq!(
            backup::setting::<Value>(&workspace, "backup.status").unwrap(),
            before
        );
        assert_eq!(backup::content_epoch(&workspace).unwrap(), epoch);
        assert!(!temp.path().join("must-not-be-opened").exists());
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
    request: BackupSettingsRequest,
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<(), ReadError> {
    let service = state.native_service()?;
    tauri::async_runtime::spawn_blocking(move || service.settings(request))
        .await
        .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Settings could not be saved"))?
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CloudRequest {
    List,
    Connect {
        name: String,
    },
    Reconnect {
        connection_id: String,
    },
    PickBackupParent {
        connection_id: String,
    },
    UseDefaultBackupParent {
        connection_id: String,
    },
    AuthStatus {
        operation_id: String,
    },
    CancelAuth {
        operation_id: String,
    },
    Disconnect {
        connection_id: String,
        #[serde(default)]
        stop_destinations: bool,
    },
    Intents {
        connection_id: String,
    },
    RecoveryInformation {
        destination_id: String,
    },
    CancelTransfer {
        destination_id: String,
    },
}
#[tauri::command]
pub(crate) async fn workspace_cloud(
    request: CloudRequest,
    state: tauri::State<'_, crate::persistence::ProductPersistenceState>,
) -> Result<Value, ReadError> {
    let native = state.native_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        let service = crate::cloud::CloudService::discover()?;
        match request {
            CloudRequest::List => service.list(),
            CloudRequest::Connect { name } => {
                Ok(serde_json::to_value(service.start_auth(name, None, true)?)?)
            }
            CloudRequest::Reconnect { connection_id } => Ok(serde_json::to_value(
                service.start_auth(String::new(), Some(connection_id), true)?,
            )?),
            CloudRequest::PickBackupParent { connection_id } => Ok(serde_json::to_value(
                service.start_parent_selection(connection_id, true)?,
            )?),
            CloudRequest::UseDefaultBackupParent { connection_id } => {
                service.use_default_parent(&connection_id)?;
                Ok(json!({"updated":true}))
            }
            CloudRequest::AuthStatus { operation_id } => Ok(serde_json::to_value(
                crate::cloud::auth_status(&operation_id)?,
            )?),
            CloudRequest::CancelAuth { operation_id } => {
                crate::cloud::cancel_auth(&operation_id)?;
                Ok(json!({"cancelled":true}))
            }
            CloudRequest::Disconnect {
                connection_id,
                stop_destinations,
            } => {
                service.disconnect(&connection_id, stop_destinations)?;
                Ok(json!({"disconnected":true}))
            }
            CloudRequest::Intents { connection_id } => {
                let workspace_id = WorkspaceReader::open(&native.workspace)?.workspace_id;
                Ok(serde_json::to_value(
                    service
                        .initialization_intents(&connection_id)?
                        .into_iter()
                        .filter(|i| i.workspace_id == workspace_id)
                        .collect::<Vec<_>>(),
                )?)
            }
            CloudRequest::RecoveryInformation { destination_id } => {
                service.recovery_information(&native.workspace, &destination_id)
            }
            CloudRequest::CancelTransfer { destination_id } => {
                native.cancel_cloud(Some(&destination_id))?;
                Ok(json!({"cancelling":true}))
            }
        }
    })
    .await
    .map_err(|_| ReadError::new("BACKGROUND_FAILED", "Cloud operation could not complete"))?
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
        if matches!(request, Request::SyncStatus) {
            let status = tauri::async_runtime::block_on(
                crate::replication::controller::sync_status(app.clone()),
            )?;
            return Ok(Reply::Json(
                json!({"schema_version":1,"workspace_id":status.workspace_id,"status":status}),
            ));
        }
        if let Request::Edit { request, dry_run } = request {
            return app
                .state::<crate::agent_edit::bridge::AgentEdits>()
                .dispatch(&app, service.workspace.clone(), request, dry_run)
                .map(Reply::Json);
        }
        if let Request::NoteEdit { request, dry_run } = request {
            return app
                .state::<crate::agent_edit::bridge::AgentEdits>()
                .dispatch(&app, service.workspace.clone(), request, dry_run)
                .map(Reply::Json);
        }
        if let Request::SectionEdit { request, dry_run } = request {
            return app
                .state::<crate::agent_edit::bridge::AgentEdits>()
                .dispatch(&app, service.workspace.clone(), request, dry_run)
                .map(Reply::Json);
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
