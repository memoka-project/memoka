//! Standalone adapter. Current reads never construct a Tauri application,
//! ProductStore, WebView or JavaScript runtime.
use crate::{
    backup, backup_management,
    document_model::ReadError,
    history,
    native_service::NativeService,
    read_service::{ReadRequest, checked_directory, plain_file},
    restic::{self, Password, Repository, Restic},
    workspace_owner::{self, BackupAction, Reply, Request, WorkspaceLease},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
};

const USAGE: &str = "Memoka CLI\n\n\
  memoka-cli workspaces --format json\n\
  memoka-cli tree [--workspace DIR] [--generation ID] [--include-trash] [--limit N] [--cursor CURSOR] --format json\n\
  memoka-cli search QUERY [--workspace DIR] [--generation ID] [--include-trash] [--limit N] [--cursor CURSOR] --format json\n\
  memoka-cli read --id ID [--workspace DIR] [--generation ID] [--include-trash] --format markdown|json\n\
  memoka-cli read --id ID --for-edit [--workspace DIR] [--limit N] [--cursor CURSOR] --format json\n\
  memoka-cli edit --input FILE|- [--workspace DIR] [--dry-run] --format json\n\
  memoka-cli note-edit --input FILE|- [--workspace DIR] [--dry-run] --format json\n\
  memoka-cli edit-schema --format json\n\
  memoka-cli attachment get --id ID --output NEW-FILE [--workspace DIR] [--generation ID] [--include-trash]\n\
  memoka-cli history [--id ID] [--workspace DIR] --format json\n\
  memoka-cli backup run|status|list|copy [--workspace DIR]\n\
  memoka-cli backup maintain [--workspace DIR] [--dry-run]\n\
  memoka-cli backup locks|unlock [--workspace DIR] [--destination ID]\n\
  memoka-cli cloud connect google-drive --name NAME [--client-file FILE] [--no-browser]\n\
  memoka-cli cloud list --format json\n\
  memoka-cli cloud reconnect --connection ID [--client-file FILE] [--no-browser]\n\
  memoka-cli cloud disconnect --connection ID [--stop-destinations]\n\
  memoka-cli backup list|check|restore --connection ID --drive-folder-id ID --password-stdin [--generation ID --target EMPTY-DIR]\n\
  memoka-cli backup list|check --repository DIR --insecure-no-password|--password-stdin [--full]\n\
  memoka-cli backup restore --repository DIR --generation ID --target EMPTY-DIR --insecure-no-password|--password-stdin\n\
  memoka-cli verify --source OLD-MIRROR\n\
  memoka-cli restore --source OLD-MIRROR --target EMPTY-DIR\n\n\
Omitted --workspace uses only the selected Workspace. Repository passwords may also be entered interactively. No password argument is accepted.\n\
Reading never migrates a Workspace. Open an old Workspace in Memoka first.\n";

struct Options {
    positional: Vec<String>,
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}
impl Options {
    fn parse(arguments: Vec<String>) -> Result<Self, ReadError> {
        let flag_names = [
            "--for-edit",
            "--include-trash",
            "--dry-run",
            "--full",
            "--password-stdin",
            "--insecure-no-password",
            "--no-browser",
            "--stop-destinations",
        ];
        let value_names = [
            "--input",
            "--workspace",
            "--repository",
            "--format",
            "--id",
            "--generation",
            "--limit",
            "--cursor",
            "--output",
            "--target",
            "--source",
            "--connection",
            "--drive-folder-id",
            "--client-file",
            "--name",
            "--destination",
        ];
        let mut result = Self {
            positional: Vec::new(),
            values: BTreeMap::new(),
            flags: BTreeSet::new(),
        };
        let mut args = arguments.into_iter();
        while let Some(value) = args.next() {
            if value == "--" {
                result.positional.extend(args);
                break;
            }
            if flag_names.contains(&value.as_str()) {
                if !result.flags.insert(value) {
                    return Err(argument("Duplicate option"));
                }
            } else if value_names.contains(&value.as_str()) {
                let next = args
                    .next()
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| argument("Missing option value"))?;
                if result.values.insert(value, next).is_some() {
                    return Err(argument("Duplicate option"));
                }
            } else if value.starts_with('-') {
                return Err(argument("Unknown option"));
            } else {
                result.positional.push(value);
            }
        }
        Ok(result)
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
    fn required(&self, name: &str) -> Result<&str, ReadError> {
        self.get(name)
            .ok_or_else(|| argument(&format!("Missing {name}")))
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
    fn allow(&self, names: &[&str]) -> Result<(), ReadError> {
        if self
            .values
            .keys()
            .chain(self.flags.iter())
            .any(|name| !names.contains(&name.as_str()))
        {
            return Err(argument(
                "This option is not supported by the selected command",
            ));
        }
        Ok(())
    }
    fn workspace(&self) -> Result<PathBuf, ReadError> {
        let path = if let Some(path) = self.get("--workspace") {
            PathBuf::from(path)
        } else {
            let selected = dirs::config_dir()
                .ok_or_else(|| ReadError::new("WORKSPACE_REQUIRED", "Pass --workspace explicitly"))?
                .join("dev.memoka.desktop/selected-workspace.json");
            if !selected.exists() {
                return Err(ReadError::new(
                    "WORKSPACE_REQUIRED",
                    "No Workspace is selected; pass --workspace explicitly",
                ));
            }
            plain_file(&selected)?;
            let value: Value = serde_json::from_slice(&fs::read(selected)?)?;
            if value["schemaVersion"] != 1 {
                return Err(ReadError::new(
                    "UNSUPPORTED_SCHEMA",
                    "Unsupported Workspace selection schema",
                ));
            }
            PathBuf::from(
                value["path"]
                    .as_str()
                    .ok_or_else(|| argument("Invalid Workspace selection"))?,
            )
        };
        fs::canonicalize(path).map_err(Into::into)
    }
    fn repository(&self) -> Result<Repository, ReadError> {
        if self.get("--workspace").is_some() {
            return Err(argument("Use either --repository or --workspace, not both"));
        }
        let cloud = self.get("--connection").is_some() || self.get("--drive-folder-id").is_some();
        if cloud && self.get("--repository").is_some() {
            return Err(argument(
                "Choose local --repository OR --connection with --drive-folder-id",
            ));
        }
        if cloud && self.flag("--insecure-no-password") {
            return Err(argument("Google Drive repositories require a password"));
        }
        let path = if cloud {
            crate::cloud::validate_connection_id(self.required("--connection")?)?;
            crate::cloud::validate_folder_id(self.required("--drive-folder-id")?)?;
            None
        } else {
            let path = PathBuf::from(self.required("--repository")?);
            checked_directory(&path)?;
            Some(fs::canonicalize(path)?)
        };
        let password = if self.flag("--insecure-no-password") {
            if self.flag("--password-stdin") {
                return Err(argument("Choose exactly one password mode"));
            }
            Password::Insecure
        } else {
            let secret = if self.flag("--password-stdin") {
                let mut bytes = Vec::new();
                io::stdin().take(64 * 1024 + 1).read_to_end(&mut bytes)?;
                if bytes.len() > 64 * 1024 {
                    return Err(argument("Password input exceeds the size limit"));
                }
                let mut value =
                    String::from_utf8(bytes).map_err(|_| argument("Password is not UTF-8"))?;
                if value.ends_with('\n') {
                    value.pop();
                    if value.ends_with('\r') {
                        value.pop();
                    }
                }
                value
            } else if io::stdin().is_terminal() {
                rpassword::prompt_password("Repository password: ").map_err(|_| {
                    ReadError::new(
                        "CREDENTIALS_UNAVAILABLE",
                        "Cannot read a repository password",
                    )
                })?
            } else {
                return Err(argument(
                    "Repository reads require --password-stdin or explicit --insecure-no-password",
                ));
            };
            if secret.is_empty() {
                return Err(argument(
                    "Empty passwords require explicit --insecure-no-password",
                ));
            }
            Password::Secret(secret)
        };
        match path {
            Some(path) => Ok(Repository::at(path, password)),
            None => crate::cloud::CloudService::discover()?.repository(
                self.required("--connection")?,
                self.required("--drive-folder-id")?,
                password,
                None,
                &Restic::discover(restic::cancellation())?,
            ),
        }
    }
}
fn argument(message: &str) -> ReadError {
    ReadError::new("INVALID_ARGUMENT", message)
}
fn print_json(value: &impl serde::Serialize) -> Result<(), ReadError> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

/// Installed only by the standalone executable, not by GUI queries/tests.
pub fn install_interrupt_handler() -> Result<(), ReadError> {
    crate::sidecar::install_cli_interrupt_handler()
}
pub fn run(arguments: Vec<String>) -> Result<(), ReadError> {
    if arguments.is_empty() || arguments.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{USAGE}");
        return Ok(());
    }
    if arguments == ["--version"] {
        println!("memoka-cli {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let options = Options::parse(arguments)?;
    let command = options
        .positional
        .first()
        .map(String::as_str)
        .ok_or_else(|| argument("Missing command"))?;
    if matches!(command, "verify" | "restore") {
        return legacy(&options, command);
    }
    let format = options.get("--format").unwrap_or("json");
    if format != "json" && !(format == "markdown" && command == "read") {
        return Err(argument("Unsupported output format"));
    }
    if command == "cloud" {
        return cloud_command(&options);
    }
    if command == "backup"
        && ["--repository", "--connection", "--drive-folder-id"]
            .iter()
            .any(|key| options.get(key).is_some())
    {
        return repository_command(&options);
    }
    let positional = options
        .positional
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if positional == ["edit-schema"] {
        options.allow(&["--format"])?;
        return print_json(&crate::agent_edit::schema());
    }
    if positional == ["workspaces"] {
        options.allow(&["--format"])?;
        return print_json(&crate::workspace_catalog::list(
            &crate::workspace_catalog::selection_path()?,
        )?);
    }
    let request = match positional.as_slice() {
        ["edit"] | ["note-edit"] => {
            options.allow(&["--workspace", "--format", "--input", "--dry-run"])?;
            let input = options.required("--input")?;
            let mut bytes = Vec::new();
            if input == "-" {
                io::stdin()
                    .take(crate::agent_edit::MAX_INPUT_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
            } else {
                plain_file(Path::new(input))?;
                fs::File::open(input)?
                    .take(crate::agent_edit::MAX_INPUT_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
            }
            if command == "note-edit" {
                Request::NoteEdit {
                    request: crate::agent_edit::parse_note_request(&bytes)?,
                    dry_run: options.flag("--dry-run"),
                }
            } else {
                Request::Edit {
                    request: crate::agent_edit::parse_request(&bytes)?,
                    dry_run: options.flag("--dry-run"),
                }
            }
        }
        ["read"] if options.flag("--for-edit") => {
            options.allow(&[
                "--workspace",
                "--format",
                "--id",
                "--for-edit",
                "--limit",
                "--cursor",
            ])?;
            if format != "json" {
                return Err(argument("--for-edit requires --format json"));
            }
            Request::ReadForEdit {
                id: options.required("--id")?.into(),
                limit: options
                    .get("--limit")
                    .unwrap_or("100")
                    .parse()
                    .map_err(|_| argument("Invalid limit"))?,
                cursor: options.get("--cursor").map(str::to_owned),
            }
        }
        ["tree"] | ["read"] | ["search", _] => {
            let allowed = if command == "read" {
                vec![
                    "--workspace",
                    "--format",
                    "--id",
                    "--generation",
                    "--include-trash",
                ]
            } else {
                vec![
                    "--workspace",
                    "--format",
                    "--generation",
                    "--include-trash",
                    "--limit",
                    "--cursor",
                ]
            };
            options.allow(&allowed)?;
            if command == "read" {
                options.required("--id")?;
            }
            let limit = options
                .get("--limit")
                .unwrap_or("100")
                .parse::<usize>()
                .map_err(|_| argument("limit must be an integer"))?;
            if !(1..=1000).contains(&limit) {
                return Err(argument("limit must be between 1 and 1000"));
            }
            Request::Query {
                request: ReadRequest {
                    command: command.into(),
                    id: options.get("--id").map(str::to_owned),
                    query: options.positional.get(1).cloned(),
                    include_trash: options.flag("--include-trash"),
                    limit,
                    cursor: options.get("--cursor").map(str::to_owned),
                    generation: options.get("--generation").map(str::to_owned),
                },
            }
        }
        ["attachment", "get"] => {
            options.allow(&[
                "--workspace",
                "--format",
                "--id",
                "--generation",
                "--include-trash",
                "--output",
            ])?;
            options.required("--output")?;
            Request::Attachment {
                id: options.required("--id")?.into(),
                include_trash: options.flag("--include-trash"),
                generation: options.get("--generation").map(str::to_owned),
            }
        }
        ["history"] => {
            options.allow(&["--workspace", "--format", "--id"])?;
            Request::History {
                id: options.get("--id").map(str::to_owned),
            }
        }
        ["backup", action] => {
            options.allow(match *action {
                "maintain" => &["--workspace", "--format", "--dry-run"],
                "check" => &["--workspace", "--format", "--full"],
                "locks" | "unlock" => &["--workspace", "--format", "--destination"],
                _ => &["--workspace", "--format"],
            })?;
            Request::Backup {
                action: match *action {
                    "run" => BackupAction::Run,
                    "status" => BackupAction::Status,
                    "list" => BackupAction::List,
                    "copy" => BackupAction::Copy,
                    "locks" | "unlock" => BackupAction::RepositoryLocks {
                        destination_id: options.get("--destination").map(str::to_owned),
                        repair: *action == "unlock",
                    },
                    "maintain" => BackupAction::Maintain {
                        dry_run: options.flag("--dry-run"),
                    },
                    "check" => BackupAction::Check {
                        full: options.flag("--full"),
                    },
                    _ => return Err(argument("Unknown backup operation")),
                },
            }
        }
        _ => {
            return Err(argument(
                "Unknown command or unexpected positional arguments; use --help",
            ));
        }
    };
    let request_id = match &request {
        Request::Edit { request, .. } => Some(request.request_id.clone()),
        Request::NoteEdit { request, .. } => Some(request.request_id.clone()),
        _ => None,
    };
    run_request(&options, request, format).map_err(|mut error| {
        if let Some(id) = request_id {
            if !error.details.is_object() {
                error.details = json!({});
            }
            error.details["request_id"] = id.into();
        }
        error
    })
}

fn run_request(options: &Options, request: Request, format: &str) -> Result<(), ReadError> {
    let workspace = options.workspace()?;
    // Publish a fresh Attachment only after complete transfer; never send the
    // host output path to IPC, and never overwrite an existing user file.
    let mut output = options
        .get("--output")
        .map(|path| -> Result<_, ReadError> {
            let path = PathBuf::from(path);
            if path.exists() {
                return Err(ReadError::new(
                    "TARGET_EXISTS",
                    "Attachment output must be a new file",
                ));
            }
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            checked_directory(parent)?;
            Ok((tempfile::NamedTempFile::new_in(parent)?, path))
        })
        .transpose()?;
    let result = match WorkspaceLease::acquire(&workspace) {
        Ok(lease) => {
            let service = NativeService::owned(lease);
            match service.query(request.clone())? {
                Reply::Json(value) => {
                    if matches!(
                        request,
                        Request::Backup {
                            action: BackupAction::Run
                        }
                    ) {
                        // The standalone process owns this worker and its lease.
                        if let Err(error) = service.wait_transfers() {
                            service.cancel()?;
                            let _ = service.wait_transfers();
                            return Err(error);
                        }
                    }
                    value
                }
                Reply::Attachment { metadata, mut file } => {
                    let (temporary, _) = output
                        .as_mut()
                        .ok_or_else(|| argument("Attachment output is required"))?;
                    io::copy(&mut file, temporary.as_file_mut())?;
                    serde_json::to_value(metadata)?
                }
            }
        }
        Err(error) if error.code == "WORKSPACE_LOCKED" => workspace_owner::request(
            &workspace,
            &request,
            output
                .as_mut()
                .map(|(file, _)| file.as_file_mut() as &mut dyn Write),
        )?,
        Err(error) => return Err(error),
    };
    if let Some((temporary, path)) = output {
        temporary.as_file().sync_all()?;
        temporary.persist_noclobber(&path).map_err(|_| {
            ReadError::new(
                "TARGET_EXISTS",
                "Could not publish a new Attachment file; existing files were not overwritten",
            )
        })?;
    }
    if format == "markdown" {
        print!(
            "{}",
            result["markdown"]
                .as_str()
                .ok_or_else(|| ReadError::new("IPC_PROTOCOL", "Missing Markdown response"))?
        );
        Ok(())
    } else {
        print_json(&result)
    }
}

fn repository_command(options: &Options) -> Result<(), ReadError> {
    let [_, action] = options.positional.as_slice() else {
        return Err(argument("Unexpected backup arguments"));
    };
    let mut allowed = match action.as_str() {
        "list" => vec![
            "--repository",
            "--format",
            "--insecure-no-password",
            "--password-stdin",
        ],
        "check" => vec![
            "--repository",
            "--format",
            "--insecure-no-password",
            "--password-stdin",
            "--full",
        ],
        "restore" => vec![
            "--repository",
            "--format",
            "--insecure-no-password",
            "--password-stdin",
            "--generation",
            "--target",
        ],
        _ => {
            return Err(argument(
                "This operation requires --workspace, not --repository",
            ));
        }
    };
    allowed.extend(["--connection", "--drive-folder-id"]);
    options.allow(&allowed)?;
    let repository = options.repository()?;
    let restic = Restic::discover(restic::cancellation())?;
    let result = match action.as_str() {
        "list" => {
            json!({"schema_version":1,"generations":backup::generations(&restic, &repository, None, None)?})
        }
        "check" => backup_management::check(&restic, &repository, options.flag("--full"))?,
        "restore" => {
            let generation = history::generation(
                &restic,
                &repository,
                options.required("--generation")?,
                None,
                None,
            )?;
            history::restore(
                &restic,
                &repository,
                &generation,
                Path::new(options.required("--target")?),
            )?;
            json!({"schema_version":1,"workspace_id":generation.descriptor.workspace_id,"generation_id":generation.descriptor.generation_id,"restored":true})
        }
        _ => unreachable!(),
    };
    print_json(&result)
}
fn cloud_command(options: &Options) -> Result<(), ReadError> {
    let positional: Vec<_> = options.positional.iter().map(String::as_str).collect();
    let service = crate::cloud::CloudService::discover()?
        .with_profile(options.get("--client-file").map(PathBuf::from));
    match positional.as_slice() {
        ["cloud", "list"] => {
            options.allow(&["--format"])?;
            print_json(&service.list()?)
        }
        ["cloud", "disconnect"] => {
            options.allow(&["--connection", "--format", "--stop-destinations"])?;
            service.disconnect(
                options.required("--connection")?,
                options.flag("--stop-destinations"),
            )?;
            print_json(
                &json!({"schema_version":3,"disconnected":true,"google_authorization_revoked":false}),
            )
        }
        ["cloud", "connect", "google-drive"] | ["cloud", "reconnect"] => {
            let reconnect = positional[1] == "reconnect";
            if reconnect {
                options.allow(&["--connection", "--client-file", "--no-browser", "--format"])?;
            } else {
                options.allow(&["--name", "--client-file", "--no-browser", "--format"])?;
            }
            let status = service.start_auth(
                if reconnect {
                    String::new()
                } else {
                    options.required("--name")?.into()
                },
                if reconnect {
                    Some(options.required("--connection")?.into())
                } else {
                    None
                },
                !options.flag("--no-browser"),
            )?;
            let mut printed_url = false;
            loop {
                let status = crate::cloud::auth_status(&status.operation_id)?;
                if !printed_url && let Some(url) = &status.authorization_url {
                    eprintln!("Open in your browser (temporary authorization URL):\n{url}");
                    printed_url = true;
                }
                if status.phase == "success" {
                    return print_json(
                        &json!({"schema_version":3,"connection_id":status.connection_id,"experimental":true}),
                    );
                }
                if let Some(error) = status.error {
                    return Err(error);
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
        _ => Err(argument("Unknown cloud operation")),
    }
}
fn legacy(options: &Options, command: &str) -> Result<(), ReadError> {
    if options.positional.len() != 1 {
        return Err(argument("Unexpected legacy command arguments"));
    }
    options.allow(if command == "verify" {
        &["--source"]
    } else {
        &["--source", "--target"]
    })?;
    let source = Path::new(options.required("--source")?);
    if command == "verify" {
        let manifest = crate::portable_mirror::verify_portable_mirror(source)?;
        println!(
            "verified Workspace {}: {} files",
            manifest.workspace_id,
            manifest.files.len()
        );
    } else {
        crate::portable_mirror::restore_portable_mirror(
            source,
            Path::new(options.required("--target")?),
        )?;
        println!("restored Workspace");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_refuses_secret_argv_duplicates_and_unknown_options() {
        for args in [
            vec!["backup", "list", "--password", "secret"],
            vec!["tree", "--limit", "1", "--limit", "2"],
            vec!["read", "--sql", "SELECT"],
            vec!["read", "--workspace"],
        ] {
            assert!(Options::parse(args.iter().map(|v| v.to_string()).collect()).is_err());
        }
    }
    #[test]
    fn secret_modes_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let options = Options::parse(vec![
            "--repository".into(),
            temp.path().display().to_string(),
            "--password-stdin".into(),
            "--insecure-no-password".into(),
        ])
        .unwrap();
        assert_eq!(options.repository().unwrap_err().code, "INVALID_ARGUMENT");
    }
    #[test]
    fn cloud_locator_validation_precedes_any_password_or_network_access() {
        for args in [
            vec!["--connection", "bad", "--repository", "/unused"],
            vec!["--connection", "bad", "--workspace", "/unused"],
            vec!["--connection", "bad", "--insecure-no-password"],
            vec!["--connection", "../untrusted", "--drive-folder-id", "root"],
            vec![
                "--connection",
                "01a0bdc7-cd00-7000-8000-000000000001",
                "--drive-folder-id",
                "../path",
            ],
            vec!["--connection", "01a0bdc7-cd00-7000-8000-000000000001"],
        ] {
            let options =
                Options::parse(args.iter().map(|value| value.to_string()).collect()).unwrap();
            assert!(options.repository().is_err());
        }
    }
}
