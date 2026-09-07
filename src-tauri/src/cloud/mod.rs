//! OS-user cloud connections. No Workspace database, GTK, WebView, browser
//! session or original connection ID is needed by standalone recovery.
mod drive;
mod oauth;
use crate::{
    credentials::{Credentials, OsCredentials},
    document_model::ReadError,
    private_files::{self, Lease},
    rclone::{DriveRepository, Rclone},
    read_service::plain_file,
    restic::{self, Cancellation, Password, Repository, Restic},
};
pub(crate) use drive::validate_repository_layout;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, atomic::Ordering},
    time::{Duration, Instant},
};
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

pub fn validate_connection_id(id: &str) -> Result<(), ReadError> {
    if uuid::Uuid::parse_str(id)
        .is_ok_and(|value| value.to_string() == id && value.get_version_num() == 7)
    {
        Ok(())
    } else {
        Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Cloud connection ID must be a lowercase UUIDv7",
        ))
    }
}
pub fn validate_folder_id(id: &str) -> Result<(), ReadError> {
    if (8..=256).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && id != "appDataFolder"
    {
        Ok(())
    } else {
        Err(ReadError::new(
            "INVALID_ARGUMENT",
            "Invalid dedicated Google Drive folder ID",
        ))
    }
}
pub(crate) fn random_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub workspace_id: String,
    pub destination_id: String,
    pub root_folder_id: String,
    pub repository_id: String,
    pub credential_ref: String,
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudConnection {
    pub schema_version: u32,
    pub id: String,
    pub provider: String,
    pub oauth_profile_id: String,
    pub oauth_client_id: String,
    pub granted_scopes: Vec<String>,
    pub account_display_label: String,
    pub account_id: String,
    pub encrypted_config_ref: String,
    pub config_key_ref: String,
    pub credential_revision: u64,
    pub auth_state: String,
    pub last_verified_at: Option<String>,
    #[serde(default)]
    pub bindings: Vec<Binding>,
}
#[derive(Clone)]
pub struct CloudService {
    root: PathBuf,
    profile_file: Option<PathBuf>,
    credentials: Arc<dyn Credentials>,
}
impl CloudService {
    pub fn discover() -> Result<Self, ReadError> {
        let root = dirs::config_dir()
            .ok_or_else(|| {
                ReadError::new(
                    "CLOUD_CONFIG_UNAVAILABLE",
                    "Cannot locate per-user application configuration",
                )
            })?
            .join("dev.memoka.desktop/cloud-connections");
        Ok(Self {
            root,
            profile_file: std::env::var_os("MEMOKA_GOOGLE_OAUTH_CLIENT_FILE").map(PathBuf::from),
            credentials: Arc::new(OsCredentials),
        })
    }
    pub fn with_profile(mut self, file: Option<PathBuf>) -> Self {
        if file.is_some() {
            self.profile_file = file;
        }
        self
    }
    fn directory(&self, id: &str) -> Result<PathBuf, ReadError> {
        validate_connection_id(id)?;
        Ok(self.root.join(id))
    }
    fn lease(&self, id: &str) -> Result<Arc<Lease>, ReadError> {
        validate_connection_id(id)?;
        Ok(Arc::new(Lease::acquire(
            self.root
                .join("leases")
                .join(format!("connection-{id}.lock")),
        )?))
    }
    fn repository_lease(&self, id: &str) -> Result<Arc<Lease>, ReadError> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Invalid repository identity",
            ));
        }
        Ok(Arc::new(Lease::acquire(
            self.root
                .join("leases")
                .join(format!("repository-{id}.lock")),
        )?))
    }
    pub fn connection(&self, id: &str) -> Result<CloudConnection, ReadError> {
        for ancestor in self.directory(id)?.ancestors() {
            crate::read_service::checked_directory(ancestor)?;
        }
        let path = self.directory(id)?.join("metadata.json");
        if plain_file(&path)?.len() > 4 * 1024 * 1024 {
            return Err(state_error());
        }
        let meta: CloudConnection = serde_json::from_slice(&fs::read(path)?)
            .map_err(|_| ReadError::new("CLOUD_STATE_IO", "Invalid cloud connection metadata"))?;
        if meta.id != id
            || meta.schema_version != 1
            || meta.provider != "google_drive"
            || meta.granted_scopes != [SCOPE]
        {
            return Err(ReadError::new(
                "UNSUPPORTED_SCHEMA",
                "Unsupported cloud connection/provider/scope",
            ));
        }
        validate_connection_id(
            meta.encrypted_config_ref
                .strip_suffix(".conf")
                .ok_or_else(|| {
                    ReadError::new("UNSAFE_PATH", "Invalid encrypted config reference")
                })?,
        )?;
        if !meta.config_key_ref.starts_with(&format!("cloud:{id}:")) {
            return Err(ReadError::new(
                "UNSAFE_PATH",
                "Invalid config key reference",
            ));
        }
        Ok(meta)
    }
    pub fn list(&self) -> Result<Value, ReadError> {
        let mut values = Vec::new();
        if self.root.exists() {
            crate::read_service::checked_directory(&self.root)?;
            for entry in fs::read_dir(&self.root)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if validate_connection_id(&name).is_ok()
                    && entry.path().join("metadata.json").exists()
                {
                    values.push(self.connection(&name)?);
                }
            }
        }
        values.sort_by(|a, b| a.id.cmp(&b.id));
        // Metadata/config-profile reads only: no keyring, network, subprocess.
        let availability = oauth::Profile::load(self.profile_file.as_deref());
        Ok(
            json!({"schema_version":3,"experimental":true,"configured":availability.is_ok(),"configuration_error":availability.err(),"connections":values}),
        )
    }
    pub fn disconnect(&self, id: &str, stop_destinations: bool) -> Result<(), ReadError> {
        let _lease = self.lease(id)?;
        let mut meta = self.connection(id)?;
        if !meta.bindings.is_empty() && !stop_destinations {
            return Err(ReadError::new(
                "CLOUD_CONNECTION_IN_USE",
                "Remove the listed destinations or explicitly stop their shared connection before disconnecting",
            )
            .with_details(json!({"destinations":meta.bindings})));
        }
        let directory = self.directory(id)?;
        private_files::inspect(&directory)?;
        if !meta.bindings.is_empty() {
            // Retain non-secret references for reconnect. This stops every use
            // of the connection without modifying other Workspace databases.
            meta.auth_state = "disconnected".into();
            private_files::atomic_json(&directory.join("metadata.json"), &meta)?;
            let config = directory.join(&meta.encrypted_config_ref);
            if plain_file(&config).is_ok() {
                fs::remove_file(config)?;
            }
            self.credentials.remove(&meta.config_key_ref);
            return Ok(());
        }
        // Only a validated UUID directory owned by this adapter. Remote files
        // and the Google project's authorization are deliberately untouched.
        fs::remove_dir_all(&directory)?;
        self.credentials.remove(&meta.config_key_ref);
        Ok(())
    }
    pub(crate) fn bind(&self, id: &str, binding: Binding) -> Result<(), ReadError> {
        // Called while the operation already owns this connection's lease.
        let mut meta = self.connection(id)?;
        meta.bindings.retain(|b| {
            b.workspace_id != binding.workspace_id || b.destination_id != binding.destination_id
        });
        meta.bindings.push(binding);
        private_files::atomic_json(&self.directory(id)?.join("metadata.json"), &meta)
    }
    pub fn recovery_information(
        &self,
        workspace: &Path,
        destination: &str,
    ) -> Result<Value, ReadError> {
        let target = crate::backup_settings::destination(workspace, destination)?;
        let crate::backup_settings::DestinationLocation::GoogleDrive {
            connection_id,
            root_folder_id,
            ..
        } = target.location
        else {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Recovery information is for a Google Drive destination",
            ));
        };
        let meta = self.connection(&connection_id)?;
        Ok(
            json!({"provider":"google_drive","root_folder_id":root_folder_id,"workspace_id":crate::read_service::WorkspaceReader::open(workspace)?.workspace_id,"repository_id":target.repository_id,"oauth_profile_id":meta.oauth_profile_id,"oauth_client_id":meta.oauth_client_id}),
        )
    }
    pub fn initialization_intents(&self, id: &str) -> Result<Vec<DriveInitIntent>, ReadError> {
        // Validate connection/ancestors before opening any sibling state file.
        self.connection(id)?;
        let path = self.directory(id)?.join("operation-state.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        if plain_file(&path)?.len() > 4 * 1024 * 1024 {
            return Err(state_error());
        }
        let intents: Vec<DriveInitIntent> =
            serde_json::from_slice(&fs::read(path)?).map_err(|_| state_error())?;
        for intent in &intents {
            validate_connection_id(&intent.id)?;
            validate_connection_id(&intent.workspace_id)?;
            validate_connection_id(&intent.nonce)?;
            if intent.connection_id != id {
                return Err(state_error());
            }
            if let Some(folder) = &intent.root_folder_id {
                validate_folder_id(folder)?;
            }
        }
        Ok(intents)
    }
    pub fn configure_destination(
        &self,
        workspace: &Path,
        connection_id: &str,
        retry_intent: Option<&str>,
        secret: String,
        retention: crate::backup_settings::Retention,
        restic: &Restic,
    ) -> Result<(), ReadError> {
        use crate::backup_settings::{self as settings, AdditionalTarget, DestinationLocation};
        retention.validate()?;
        if secret.is_empty() {
            return Err(ReadError::new(
                "CREDENTIALS",
                "An encrypted Drive repository requires a nonempty password",
            ));
        }
        let lease = self.lease(connection_id)?;
        let meta = self.connection(connection_id)?;
        let workspace_id = crate::read_service::WorkspaceReader::open(workspace)?.workspace_id;
        let source = crate::backup::local_repository(workspace, restic, false)?;
        let mut intents = self.initialization_intents(connection_id)?;
        let index = if let Some(id) = retry_intent {
            intents
                .iter()
                .position(|intent| intent.id == id && intent.workspace_id == workspace_id)
                .ok_or_else(|| {
                    ReadError::new(
                        "NOT_FOUND",
                        "Initialization intent does not belong to this Workspace",
                    )
                })?
        } else {
            intents.push(DriveInitIntent {
                id: uuid::Uuid::now_v7().to_string(),
                workspace_id: workspace_id.clone(),
                connection_id: connection_id.into(),
                nonce: uuid::Uuid::now_v7().to_string(),
                phase: "planned".into(),
                root_folder_id: None,
                display_name: None,
                repository_id: None,
            });
            intents.len() - 1
        };
        let path = self.directory(connection_id)?.join("operation-state.json");
        private_files::atomic_json(&path, &intents)?;
        let mut context = self.context(&meta, lease, "")?;
        let token = drive::access_token(&context, &restic.cancel)?;
        if intents[index].root_folder_id.is_none() {
            let may_create = intents[index].phase == "planned";
            // Persist before sending. An ambiguous/lost response never causes
            // a second folder; the nonce is used to reconcile the first.
            intents[index].phase = "folder-requested".into();
            private_files::atomic_json(&path, &intents)?;
            let folder = drive::create_or_find_root(
                &token,
                &workspace_id,
                &intents[index].id,
                &intents[index].nonce,
                may_create,
                &restic.cancel,
            )?;
            intents[index].root_folder_id = folder["id"].as_str().map(str::to_string);
            intents[index].display_name = folder["name"].as_str().map(str::to_string);
            intents[index].phase = "folder-created".into();
            private_files::atomic_json(&path, &intents)?;
        }
        let folder = intents[index]
            .root_folder_id
            .clone()
            .ok_or_else(state_error)?;
        drive::validate_root(&token, &folder, &restic.cancel)?;
        context.folder_id = folder.clone();
        let repo = Repository::drive(context, Password::Secret(secret));
        let found = restic.repository_id(&repo);
        let repository_id = match found {
            Ok(id) => {
                if intents[index]
                    .repository_id
                    .as_ref()
                    .is_some_and(|old| old != &id)
                {
                    return Err(ReadError::new(
                        "REPOSITORY_MISMATCH",
                        "Initialized repository identity changed",
                    ));
                }
                id
            }
            Err(error)
                if error.code == "REPOSITORY_MISSING" && intents[index].repository_id.is_none() =>
            {
                intents[index].phase = "initializing".into();
                private_files::atomic_json(&path, &intents)?;
                restic.initialize(&repo, Some(&source))?
            }
            Err(error) => return Err(error),
        };
        let _repository_lease = self.repository_lease(&repository_id)?;
        let config = settings::config(workspace)?;
        if config
            .destinations
            .iter()
            .any(|t| t.repository_id == repository_id && t.id != intents[index].id)
        {
            return Err(ReadError::new(
                "DESTINATION_EXISTS",
                "This repository is already registered in this Workspace",
            ));
        }
        intents[index].repository_id = Some(repository_id.clone());
        intents[index].phase = "saving-credential".into();
        private_files::atomic_json(&path, &intents)?;
        let credential_ref = format!("repo:{repository_id}");
        if let Password::Secret(secret) = &repo.password {
            self.credentials.set(&credential_ref, secret)?;
        }
        let id = intents[index].id.clone();
        // Register the binding before the Workspace config. A crash may leave
        // a conservative reference, never a target using an untracked token.
        self.bind(
            connection_id,
            Binding {
                workspace_id,
                destination_id: id.clone(),
                root_folder_id: folder.clone(),
                repository_id: repository_id.clone(),
                credential_ref: credential_ref.clone(),
                enabled: true,
            },
        )?;
        if !settings::config(workspace)?
            .destinations
            .iter()
            .any(|t| t.id == id)
        {
            settings::save_setting(
                workspace,
                &format!("backup.cache.{repository_id}"),
                &Vec::<crate::backup::Generation>::new(),
            )?;
            settings::save_setting(
                workspace,
                &format!("backup.inventory_uncertain.{repository_id}"),
                &false,
            )?;
        }
        settings::update_config(workspace, |config| {
            if !config.destinations.iter().any(|t| t.id == id) {
                config.destinations.push(AdditionalTarget {
                    id,
                    enabled: true,
                    retention,
                    repository_id,
                    credential_ref,
                    location: DestinationLocation::GoogleDrive {
                        connection_id: connection_id.into(),
                        root_folder_id: folder,
                        display_name: intents[index]
                            .display_name
                            .clone()
                            .unwrap_or_else(|| "Memoka Backup".into()),
                    },
                });
            }
            Ok(())
        })?;
        intents.remove(index);
        private_files::atomic_json(&path, &intents)?;
        Ok(())
    }
    pub fn update_binding(
        &self,
        id: &str,
        workspace_id: &str,
        destination: &str,
        enabled: Option<bool>,
    ) -> Result<(), ReadError> {
        let _lease = self.lease(id)?;
        let mut meta = self.connection(id)?;
        if let Some(enabled) = enabled {
            for binding in &mut meta.bindings {
                if binding.workspace_id == workspace_id && binding.destination_id == destination {
                    binding.enabled = enabled;
                }
            }
        } else {
            meta.bindings
                .retain(|b| b.workspace_id != workspace_id || b.destination_id != destination);
        }
        private_files::atomic_json(&self.directory(id)?.join("metadata.json"), &meta)
    }
    pub fn repository(
        &self,
        id: &str,
        folder: &str,
        password: Password,
        repository_id: Option<&str>,
        restic: &Restic,
    ) -> Result<Repository, ReadError> {
        self.open_repository(id, folder, password, repository_id, restic, None)
    }
    /// Automatic backup/maintenance/recovery is only available to the OS-user
    /// registration that created this destination. A recovery connection may
    /// read the same folder, but cannot adopt it as a writer just by knowing
    /// the Workspace ID, folder ID and password.
    pub(crate) fn registered_repository(
        &self,
        workspace_id: &str,
        target: &crate::backup_settings::AdditionalTarget,
        password: Password,
        restic: &Restic,
    ) -> Result<Repository, ReadError> {
        let crate::backup_settings::DestinationLocation::GoogleDrive {
            connection_id,
            root_folder_id,
            ..
        } = &target.location
        else {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Expected a Google Drive destination",
            ));
        };
        let repository = self.open_repository(
            connection_id,
            root_folder_id,
            password,
            Some(&target.repository_id),
            restic,
            Some((workspace_id, target)),
        )?;
        Ok(repository.with_automatic_lock_recovery(target.repository_id.clone()))
    }
    fn open_repository(
        &self,
        id: &str,
        folder: &str,
        password: Password,
        repository_id: Option<&str>,
        restic: &Restic,
        writer: Option<(&str, &crate::backup_settings::AdditionalTarget)>,
    ) -> Result<Repository, ReadError> {
        validate_folder_id(folder)?;
        if !matches!(&password, Password::Secret(secret) if !secret.is_empty()) {
            return Err(ReadError::new(
                "CREDENTIALS",
                "Google Drive repositories require a nonempty Restic password",
            ));
        }
        let lease = self.lease(id)?;
        let meta = self.connection(id)?;
        if let Some((workspace_id, target)) = writer {
            validate_writer_binding(&meta, workspace_id, target)?;
        }
        let context = self.context(&meta, lease, folder)?;
        let token = drive::access_token(&context, &restic.cancel)?;
        let root = drive::validate_root(&token, folder, &restic.cancel)?;
        if let Some((workspace_id, target)) = writer {
            if root["appProperties"]["memoka_workspace_id"] != workspace_id
                || root["appProperties"]["memoka_destination_id"] != target.id
            {
                return Err(ReadError::new(
                    "CLOUD_WRITER_MISMATCH",
                    "Driveの保存先登録が一致しません。この端末用の保存先を新しく追加してください。",
                ));
            }
        }
        let mut context = context;
        if let Some(expected) = repository_id {
            context._repository_lease = Some(self.repository_lease(expected)?);
        }
        let repo = Repository::drive(context, password);
        let found = restic.repository_id(&repo)?;
        if repository_id.is_some_and(|id| id != found) {
            return Err(ReadError::new(
                "REPOSITORY_MISMATCH",
                "Google Drive repository identity changed",
            ));
        }
        let mut context = repo.drive_context().unwrap().clone();
        if repository_id.is_none() {
            context._repository_lease = Some(self.repository_lease(&found)?);
        }
        context.verified_repository_id = Some(found);
        Ok(Repository::drive(context, repo.password))
    }
    fn context(
        &self,
        meta: &CloudConnection,
        lease: Arc<Lease>,
        folder: &str,
    ) -> Result<DriveRepository, ReadError> {
        if meta.auth_state != "connected" {
            return Err(ReadError::new(
                "CLOUD_REAUTH_REQUIRED",
                "This Google connection was disconnected on this device; reconnect explicitly",
            ));
        }
        let key = self.credentials.get(&meta.config_key_ref)?;
        let config = self.directory(&meta.id)?.join(&meta.encrypted_config_ref);
        private_files::inspect(&self.directory(&meta.id)?)?;
        crate::rclone::ensure_encrypted(&config)?;
        Ok(DriveRepository {
            rclone: Rclone::discover()?,
            config,
            key: Arc::new(zeroize::Zeroizing::new(key)),
            folder_id: folder.into(),
            _lease: lease,
            _repository_lease: None,
            verified_repository_id: None,
        })
    }
    pub fn start_auth(
        &self,
        name: String,
        reconnect: Option<String>,
        open_browser: bool,
    ) -> Result<AuthStatus, ReadError> {
        let profile = oauth::Profile::load(self.profile_file.as_deref())?;
        let id = reconnect
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        validate_connection_id(&id)?;
        if name.len() > 200 {
            return Err(ReadError::new(
                "INVALID_ARGUMENT",
                "Connection label is too long",
            ));
        }
        let operation_id = uuid::Uuid::now_v7().to_string();
        let status = AuthStatus {
            operation_id: operation_id.clone(),
            connection_id: id.clone(),
            phase: "starting".into(),
            authorization_url: None,
            error: None,
        };
        let operation = Arc::new(AuthOperation {
            status: Mutex::new(status.clone()),
            cancel: restic::cancellation(),
            started: Instant::now(),
        });
        {
            let mut operations = auth_operations().lock().map_err(|_| state_error())?;
            operations.retain(|_, op| op.started.elapsed() < Duration::from_secs(900));
            if operations.len() >= 32 {
                return Err(ReadError::new(
                    "BACKUP_BUSY",
                    "Too many authentication sessions; cancel or retry later",
                ));
            }
            operations.insert(operation_id, operation.clone());
        }
        let service = self.clone();
        std::thread::spawn(move || {
            let outcome = service.authenticate(
                &id,
                &name,
                reconnect.is_some(),
                profile,
                &operation,
                open_browser,
            );
            if let Ok(mut state) = operation.status.lock() {
                state.authorization_url = None;
                match outcome {
                    Ok(()) => state.phase = "success".into(),
                    Err(error) => {
                        state.phase = match error.code.as_str() {
                            "CANCELLED" => "cancelled",
                            "TIMEOUT" => "expired",
                            "CLOUD_AUTH_DENIED" => "denied",
                            _ => "error",
                        }
                        .into();
                        state.error = Some(error);
                    }
                }
            }
        });
        Ok(status)
    }
    fn authenticate(
        &self,
        id: &str,
        name: &str,
        reconnect: bool,
        profile: oauth::Profile,
        operation: &AuthOperation,
        open_browser: bool,
    ) -> Result<(), ReadError> {
        let lease = self.lease(id)?;
        let old = if reconnect {
            Some(self.connection(id)?)
        } else {
            None
        };
        if old
            .as_ref()
            .is_some_and(|m| m.oauth_client_id != profile.client_id)
        {
            return Err(ReadError::new(
                "CLOUD_CLIENT_CHANGED",
                "Reconnect requires the same OAuth client; use a separate recovery connection for a changed client",
            ));
        }
        let rclone = Rclone::discover()?;
        let directory = self.directory(id)?;
        private_files::directory(&directory)?;
        let reference = format!("{}.conf", uuid::Uuid::now_v7());
        let config = directory.join(&reference);
        let revision = old.as_ref().map_or(1, |m| m.credential_revision + 1);
        let key_ref = format!("cloud:{id}:{revision}");
        let key = Arc::new(zeroize::Zeroizing::new(random_key()));
        // Fail before opening a browser if persistent credentials cannot be
        // protected. A failed reconnect never changes the previous key.
        self.credentials.set(&key_ref, &key)?;
        let result = (|| {
            let token = oauth::authorize(&profile, operation, open_browser)?;
            operation.phase("saving")?;
            rclone.create_config(
                &config,
                &key,
                &profile.client_id,
                &profile.client_secret,
                token,
                &operation.cancel,
            )?;
            operation.phase("verifying")?;
            let mut context = DriveRepository {
                rclone,
                config: config.clone(),
                key,
                folder_id: String::new(),
                _lease: lease,
                _repository_lease: None,
                verified_repository_id: None,
            };
            let access = drive::access_token(&context, &operation.cancel)?;
            let account_id = drive::account_id(&access, &operation.cancel)?;
            if old
                .as_ref()
                .is_some_and(|meta| meta.account_id != account_id)
            {
                return Err(ReadError::new(
                    "CLOUD_ACCOUNT_CHANGED",
                    "Reconnect selected a different Google account; the previous connection was not changed",
                ));
            }
            if let Some(old) = &old {
                for binding in &old.bindings {
                    operation.check()?;
                    drive::validate_root(&access, &binding.root_folder_id, &operation.cancel)?;
                    context.folder_id = binding.root_folder_id.clone();
                    context._repository_lease =
                        Some(self.repository_lease(&binding.repository_id)?);
                    let password = self.credentials.get(&binding.credential_ref)?;
                    let restic = Restic::discover(operation.cancel.clone())?.within(
                        Duration::from_secs(300).saturating_sub(operation.started.elapsed()),
                    );
                    let repo = Repository::drive(context.clone(), Password::Secret(password));
                    if restic.repository_id(&repo)? != binding.repository_id {
                        return Err(ReadError::new(
                            "REPOSITORY_MISMATCH",
                            "Reconnect would switch to a different repository",
                        ));
                    }
                    context._repository_lease = None;
                }
            }
            let metadata = CloudConnection {
                schema_version: 1,
                id: id.into(),
                provider: "google_drive".into(),
                oauth_profile_id: profile.id,
                oauth_client_id: profile.client_id,
                granted_scopes: vec![SCOPE.into()],
                account_display_label: if reconnect {
                    old.as_ref().unwrap().account_display_label.clone()
                } else {
                    name.into()
                },
                account_id,
                encrypted_config_ref: reference,
                config_key_ref: key_ref.clone(),
                credential_revision: revision,
                auth_state: "connected".into(),
                last_verified_at: Some(chrono::Utc::now().to_rfc3339()),
                bindings: old.as_ref().map_or_else(Vec::new, |m| m.bindings.clone()),
            };
            // Cancellation and commit share a lock; a late callback cannot
            // commit after cancel was acknowledged to the user.
            let _state = operation.status.lock().map_err(|_| state_error())?;
            operation.check()?;
            private_files::atomic_json(&directory.join("metadata.json"), &metadata)?;
            if let Some(old) = &old {
                let previous = directory.join(&old.encrypted_config_ref);
                if plain_file(&previous).is_ok() {
                    let _ = fs::remove_file(previous);
                }
                self.credentials.remove(&old.config_key_ref);
            }
            Ok(())
        })();
        if result.is_err() {
            self.credentials.remove(&key_ref);
            if plain_file(&config).is_ok() {
                let _ = fs::remove_file(config);
            }
        }
        result
    }
}
fn validate_writer_binding(
    meta: &CloudConnection,
    workspace_id: &str,
    target: &crate::backup_settings::AdditionalTarget,
) -> Result<(), ReadError> {
    let crate::backup_settings::DestinationLocation::GoogleDrive {
        connection_id,
        root_folder_id,
        ..
    } = &target.location
    else {
        return Err(state_error());
    };
    if meta.id == *connection_id
        && meta.bindings.iter().any(|b| {
            b.workspace_id == workspace_id
                && b.destination_id == target.id
                && b.root_folder_id == *root_folder_id
                && b.repository_id == target.repository_id
                && b.credential_ref == target.credential_ref
        })
    {
        return Ok(());
    }
    Err(ReadError::new(
        "CLOUD_WRITER_NOT_REGISTERED",
        "このDrive保存先はこの端末に書き込み用として登録されていません。復旧元は読み取り専用で使用し、この端末用の保存先を新しく追加してください。",
    ))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriveInitIntent {
    pub id: String,
    pub workspace_id: String,
    pub connection_id: String,
    pub nonce: String,
    pub phase: String,
    pub root_folder_id: Option<String>,
    pub display_name: Option<String>,
    pub repository_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct AuthStatus {
    pub operation_id: String,
    pub connection_id: String,
    pub phase: String,
    pub authorization_url: Option<String>,
    pub error: Option<ReadError>,
}
struct AuthOperation {
    status: Mutex<AuthStatus>,
    cancel: Cancellation,
    started: Instant,
}
impl AuthOperation {
    fn check(&self) -> Result<(), ReadError> {
        if self.started.elapsed() >= Duration::from_secs(300) {
            return Err(ReadError::new(
                "TIMEOUT",
                "Google authorization expired after five minutes",
            ));
        }
        if self.cancel.load(Ordering::Acquire) || crate::sidecar::interrupted() {
            Err(ReadError::new("CANCELLED", "Cloud connection cancelled"))
        } else {
            Ok(())
        }
    }
    fn phase(&self, phase: &str) -> Result<(), ReadError> {
        self.check()?;
        self.status.lock().map_err(|_| state_error())?.phase = phase.into();
        Ok(())
    }
}
fn state_error() -> ReadError {
    ReadError::new("CLOUD_STATE_IO", "Cannot access cloud operation state")
}
fn auth_operations() -> &'static Mutex<BTreeMap<String, Arc<AuthOperation>>> {
    static AUTH: OnceLock<Mutex<BTreeMap<String, Arc<AuthOperation>>>> = OnceLock::new();
    AUTH.get_or_init(Default::default)
}
pub fn auth_status(id: &str) -> Result<AuthStatus, ReadError> {
    let operation = auth_operations()
        .lock()
        .map_err(|_| state_error())?
        .get(id)
        .cloned()
        .ok_or_else(|| ReadError::new("NOT_FOUND", "Unknown cloud authentication operation"))?;
    Ok(operation.status.lock().map_err(|_| state_error())?.clone())
}
pub fn cancel_auth(id: &str) -> Result<(), ReadError> {
    let operation = auth_operations()
        .lock()
        .map_err(|_| state_error())?
        .get(id)
        .cloned()
        .ok_or_else(|| ReadError::new("NOT_FOUND", "Unknown cloud authentication operation"))?;
    let _status = operation.status.lock().map_err(|_| state_error())?;
    operation.cancel.store(true, Ordering::Release);
    Ok(())
}
pub fn cancel_all_auth() {
    if let Ok(operations) = auth_operations().lock() {
        for operation in operations.values() {
            if let Ok(_state) = operation.status.lock() {
                operation.cancel.store(true, Ordering::Release);
            }
        }
    }
}
pub(crate) fn auth_running() -> bool {
    auth_operations().lock().map_or(true, |operations| {
        operations.values().any(|operation| {
            operation.status.lock().map_or(true, |state| {
                matches!(
                    state.phase.as_str(),
                    "starting" | "waiting-browser" | "exchanging" | "saving" | "verifying"
                )
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct TestCredentials {
        values: Mutex<BTreeMap<String, String>>,
        locked: std::sync::atomic::AtomicBool,
    }
    impl Credentials for TestCredentials {
        fn get(&self, id: &str) -> Result<String, ReadError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(crate::credentials::credentials_error());
            }
            self.values
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(crate::credentials::credentials_error)
        }
        fn set(&self, id: &str, secret: &str) -> Result<(), ReadError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(crate::credentials::credentials_error());
            }
            self.values.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn remove(&self, id: &str) {
            self.values.lock().unwrap().remove(id);
        }
    }
    fn metadata(id: &str) -> CloudConnection {
        CloudConnection {
            schema_version: 1,
            id: id.into(),
            provider: "google_drive".into(),
            oauth_profile_id: "test".into(),
            oauth_client_id: "offline.apps.googleusercontent.com".into(),
            granted_scopes: vec![SCOPE.into()],
            account_display_label: "test".into(),
            account_id: "original-account".into(),
            encrypted_config_ref: format!("{}.conf", uuid::Uuid::now_v7()),
            config_key_ref: format!("cloud:{id}:1"),
            credential_revision: 1,
            auth_state: "connected".into(),
            last_verified_at: None,
            bindings: Vec::new(),
        }
    }
    #[test]
    fn same_workspace_and_password_do_not_authorize_a_different_devices_writer() {
        use crate::backup_settings::{AdditionalTarget, DestinationLocation, Retention};
        let connection = uuid::Uuid::now_v7().to_string();
        let workspace = uuid::Uuid::now_v7().to_string();
        let destination = uuid::Uuid::now_v7().to_string();
        let mut original = metadata(&connection);
        let target = AdditionalTarget {
            id: destination.clone(),
            enabled: true,
            retention: Retention::default(),
            repository_id: "a".repeat(64),
            credential_ref: "repo:test".into(),
            location: DestinationLocation::GoogleDrive {
                connection_id: connection.clone(),
                root_folder_id: "folder123".into(),
                display_name: "renamed folder".into(),
            },
        };
        // Another OS user/PC's connection has no writer registrations, even
        // when it can authenticate to the same account and recover this ID.
        assert_eq!(
            validate_writer_binding(&original, &workspace, &target)
                .unwrap_err()
                .code,
            "CLOUD_WRITER_NOT_REGISTERED"
        );
        original.bindings.push(Binding {
            workspace_id: workspace.clone(),
            destination_id: destination,
            root_folder_id: "folder123".into(),
            repository_id: target.repository_id.clone(),
            credential_ref: target.credential_ref.clone(),
            enabled: true,
        });
        validate_writer_binding(&original, &workspace, &target).unwrap();
        assert!(
            validate_writer_binding(&original, &uuid::Uuid::now_v7().to_string(), &target).is_err()
        );
        let mut replaced = target.clone();
        replaced.repository_id = "b".repeat(64);
        assert!(validate_writer_binding(&original, &workspace, &replaced).is_err());
        original.bindings.clear();
        assert!(validate_writer_binding(&original, &workspace, &target).is_err());
    }
    #[test]
    fn failed_reconnect_locked_keyring_and_cancel_leave_the_previous_connection_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(TestCredentials::default());
        let service = CloudService {
            root: dir.path().join("cloud"),
            profile_file: None,
            credentials: credentials.clone(),
        };
        let id = uuid::Uuid::now_v7().to_string();
        let meta = metadata(&id);
        let directory = service.directory(&id).unwrap();
        private_files::atomic_json(&directory.join("metadata.json"), &meta).unwrap();
        let key = random_key();
        credentials.set(&meta.config_key_ref, &key).unwrap();
        let original = fs::read(directory.join("metadata.json")).unwrap();
        for (client, locked, cancelled, expected) in [
            (
                "different.apps.googleusercontent.com",
                false,
                false,
                "CLOUD_CLIENT_CHANGED",
            ),
            (
                "offline.apps.googleusercontent.com",
                true,
                false,
                "CREDENTIALS_UNAVAILABLE",
            ),
            (
                "offline.apps.googleusercontent.com",
                false,
                true,
                "CANCELLED",
            ),
        ] {
            credentials.locked.store(locked, Ordering::Relaxed);
            let operation = AuthOperation {
                status: Mutex::new(AuthStatus {
                    operation_id: "test".into(),
                    connection_id: id.clone(),
                    phase: "starting".into(),
                    authorization_url: None,
                    error: None,
                }),
                cancel: restic::cancellation(),
                started: Instant::now(),
            };
            operation.cancel.store(cancelled, Ordering::Release);
            let profile = oauth::Profile {
                id: "test".into(),
                client_id: client.into(),
                client_secret: zeroize::Zeroizing::new("dummy-client-secret".into()),
            };
            assert_eq!(
                service
                    .authenticate(&id, "", true, profile, &operation, false)
                    .unwrap_err()
                    .code,
                expected
            );
            assert_eq!(fs::read(directory.join("metadata.json")).unwrap(), original);
            assert_eq!(
                credentials.values.lock().unwrap().get(&meta.config_key_ref),
                Some(&key)
            );
            assert!(operation.status.lock().unwrap().authorization_url.is_none());
        }
    }
    #[test]
    fn removing_one_binding_keeps_shared_credentials_and_disconnect_requires_explicit_stop() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(TestCredentials::default());
        let service = CloudService {
            root: dir.path().join("cloud"),
            profile_file: None,
            credentials: credentials.clone(),
        };
        let id = uuid::Uuid::now_v7().to_string();
        let mut meta = metadata(&id);
        for destination in ["a", "b"] {
            meta.bindings.push(Binding {
                workspace_id: "workspace".into(),
                destination_id: destination.into(),
                root_folder_id: "folder123".into(),
                repository_id: "a".repeat(64),
                credential_ref: "repo:key".into(),
                enabled: true,
            });
        }
        private_files::atomic_json(
            &service.directory(&id).unwrap().join("metadata.json"),
            &meta,
        )
        .unwrap();
        credentials
            .set(&meta.config_key_ref, "dummy-encryption-key")
            .unwrap();
        service.update_binding(&id, "workspace", "a", None).unwrap();
        assert_eq!(service.connection(&id).unwrap().bindings.len(), 1);
        assert!(credentials.get(&meta.config_key_ref).is_ok());
        assert_eq!(
            service.disconnect(&id, false).unwrap_err().code,
            "CLOUD_CONNECTION_IN_USE"
        );
        service.disconnect(&id, true).unwrap();
        let disconnected = service.connection(&id).unwrap();
        assert_eq!(disconnected.auth_state, "disconnected");
        assert_eq!(disconnected.bindings[0].destination_id, "b");
        assert!(credentials.get(&meta.config_key_ref).is_err());
        assert_eq!(
            service
                .context(&disconnected, service.lease(&id).unwrap(), "folder123")
                .unwrap_err()
                .code,
            "CLOUD_REAUTH_REQUIRED"
        );
    }
    #[test]
    fn locator_rejects_paths_queries_remote_names_and_special_roots() {
        for value in [
            "",
            "root",
            "appDataFolder",
            "a:b",
            "../folder",
            "abc/defghijk",
            "folder?x=y",
            "日本語folder",
            "https://drive.google.com/",
        ] {
            assert!(validate_folder_id(value).is_err(), "{value}");
        }
        assert!(validate_folder_id("1A2b3C4_d-E5f6G7").is_ok());
        assert!(validate_connection_id("../../credentials").is_err());
    }
    #[test]
    fn status_without_configuration_creates_no_state() {
        let dir = tempfile::tempdir().unwrap();
        let service = CloudService {
            root: dir.path().join("not-created"),
            profile_file: None,
            credentials: Arc::new(OsCredentials),
        };
        assert_eq!(service.list().unwrap()["connections"], json!([]));
        assert!(!service.root.exists());
    }
}
