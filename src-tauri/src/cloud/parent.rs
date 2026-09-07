//! Parent folders are containers, never Restic repositories. Only newly
//! provisioned children receive the repository marker and writer binding.
use super::{CloudConnection, CloudService, drive, validate_folder_id};
use crate::{
    document_model::ReadError, private_files, read_service::plain_file, restic::Cancellation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupParent {
    pub folder_id: String,
    pub name: String,
    #[serde(default)]
    pub automatic: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub parent: BackupParent,
    pub folder_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContainerCreation {
    folder_id: String,
    nonce: String,
    confirmed: bool,
}
const FIELDS: &str = "id,name,mimeType,driveId,trashed,shortcutDetails,appProperties,parents,capabilities(canAddChildren)";
fn invalid() -> ReadError {
    ReadError::new(
        "CLOUD_PARENT_INVALID",
        "書き込み可能なマイドライブの通常フォルダーを選択してください。バックアップ自体・その内部・ショートカット・共有ドライブは選べません。",
    )
}
fn folder(value: &Value, id: &str) -> Result<(), ReadError> {
    validate_folder_id(id)?;
    if value["id"] != id
        || value["mimeType"] != drive::FOLDER
        || value["trashed"] == true
        || value.get("driveId").is_some()
        || value.get("shortcutDetails").is_some()
        || value["appProperties"]["memoka_backup"] == "1"
    {
        return Err(invalid());
    }
    Ok(())
}
fn named(value: &Value, automatic: bool) -> Result<BackupParent, ReadError> {
    let id = value["id"].as_str().ok_or_else(invalid)?;
    folder(value, id)?;
    let name = value["name"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or_else(invalid)?;
    if value["capabilities"]["canAddChildren"] != true {
        return Err(invalid());
    }
    Ok(BackupParent {
        folder_id: id.into(),
        name: name.into(),
        automatic,
    })
}
pub(super) fn validate(
    token: &str,
    id: &str,
    automatic: bool,
    cancel: &Cancellation,
) -> Result<BackupParent, ReadError> {
    validate_with(id, automatic, |id| {
        drive::request(
            reqwest::Method::GET,
            &format!("/{id}"),
            &[("fields", FIELDS)],
            None,
            token,
            cancel,
        )
    })
}
fn validate_with(
    id: &str,
    automatic: bool,
    mut get: impl FnMut(&str) -> Result<Value, ReadError>,
) -> Result<BackupParent, ReadError> {
    validate_folder_id(id)?;
    let value = get(id)?;
    let result = named(&value, automatic)?;
    // Selecting My Drive itself would reintroduce top-level backup clutter.
    let parents = value["parents"]
        .as_array()
        .filter(|p| p.len() == 1)
        .ok_or_else(invalid)?;
    let mut next = parents[0].as_str().ok_or_else(invalid)?.to_owned();
    let mut seen = BTreeSet::from([id.to_owned()]);
    for _ in 0..128 {
        validate_folder_id(&next)?;
        if !seen.insert(next.clone()) {
            return Err(invalid());
        }
        let ancestor = match get(&next) {
            Ok(value) => value,
            // drive.file does not grant access to arbitrary ancestors of a
            // picked folder. Never broaden the scope to enumerate them.
            Err(e) if e.code == "CLOUD_ROOT_UNAVAILABLE" => return Ok(result),
            Err(e) => return Err(e),
        };
        folder(&ancestor, &next)?;
        // Drive omits parents on the actual My Drive root.
        if ancestor.get("parents").is_none() {
            return Ok(result);
        }
        let parents = ancestor["parents"].as_array().ok_or_else(invalid)?;
        if parents.is_empty() {
            return Ok(result);
        }
        if parents.len() != 1 {
            return Err(invalid());
        }
        next = parents[0].as_str().ok_or_else(invalid)?.into();
    }
    Err(invalid())
}

pub(super) fn generate_id(token: &str, cancel: &Cancellation) -> Result<String, ReadError> {
    generate_with(|method, path, query, body| {
        drive::request(method, path, query, body, token, cancel)
    })
}
fn generate_with(
    mut request: impl FnMut(
        reqwest::Method,
        &str,
        &[(&str, &str)],
        Option<Value>,
    ) -> Result<Value, ReadError>,
) -> Result<String, ReadError> {
    let result = request(
        reqwest::Method::GET,
        "/generateIds",
        &[("count", "1"), ("space", "drive"), ("type", "files")],
        None,
    )?;
    let ids = result["ids"]
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or_else(invalid)?;
    let id = ids[0].as_str().ok_or_else(invalid)?;
    validate_folder_id(id)?;
    Ok(id.into())
}

/// A reserved ID is persisted before POST. An ambiguous response is retried
/// with that same ID, never by creating another randomly named folder.
fn provision_with(
    id: &str,
    name: &str,
    parent: &str,
    properties: Value,
    mut request: impl FnMut(
        reqwest::Method,
        &str,
        &[(&str, &str)],
        Option<Value>,
    ) -> Result<Value, ReadError>,
) -> Result<Value, ReadError> {
    validate_folder_id(id)?;
    if parent != "root" {
        validate_folder_id(parent)?;
    }
    let path = format!("/{id}");
    let result = match request(reqwest::Method::GET, &path, &[("fields", FIELDS)], None) {
        Ok(value) => value,
        Err(e) if e.code == "CLOUD_ROOT_UNAVAILABLE" => {
            match request(
                reqwest::Method::POST,
                "",
                &[("fields", FIELDS)],
                Some(
                    json!({"id":id,"name":name,"mimeType":drive::FOLDER,"parents":[parent],"appProperties":properties}),
                ),
            ) {
                Ok(value) => value,
                Err(e) if e.code == "CLOUD_ALREADY_EXISTS" => {
                    request(reqwest::Method::GET, &path, &[("fields", FIELDS)], None)?
                }
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    if result["id"] != id
        || result["mimeType"] != drive::FOLDER
        || result["trashed"] == true
        || result.get("driveId").is_some()
        || result.get("shortcutDetails").is_some()
        || (parent != "root" && result["parents"] != json!([parent]))
        || !properties
            .as_object()
            .ok_or_else(invalid)?
            .iter()
            .all(|(key, value)| result["appProperties"][key] == *value)
    {
        return Err(ReadError::new(
            "CLOUD_INIT_AMBIGUOUS",
            "作成予定のDriveフォルダーと実体が一致しません。移動・上書き・削除は行いません。",
        ));
    }
    Ok(result)
}

pub(super) fn resolve(
    service: &CloudService,
    meta: &CloudConnection,
    token: &str,
    cancel: &Cancellation,
) -> Result<BackupParent, ReadError> {
    resolve_with(service, meta, |method, path, query, body| {
        drive::request(method, path, query, body, token, cancel)
    })
}
fn resolve_with(
    service: &CloudService,
    meta: &CloudConnection,
    mut request: impl FnMut(
        reqwest::Method,
        &str,
        &[(&str, &str)],
        Option<Value>,
    ) -> Result<Value, ReadError>,
) -> Result<BackupParent, ReadError> {
    if let Some(parent) = &meta.backup_parent {
        return validate_with(&parent.folder_id, parent.automatic, |id| {
            request(
                reqwest::Method::GET,
                &format!("/{id}"),
                &[("fields", FIELDS)],
                None,
            )
        });
    }
    // Serialize default-container discovery across this OS user's connections
    // to the same account/client. This is not a distributed Drive lock.
    let hash = Sha256::digest(format!("{}\n{}", meta.oauth_client_id, meta.account_id).as_bytes());
    let key = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let _lease = private_files::Lease::acquire(
        service
            .root
            .join("leases")
            .join(format!("parent-{key}.lock")),
    )?;
    let path = service
        .root
        .join("parent-operations")
        .join(format!("{key}.json"));
    private_files::directory(path.parent().ok_or_else(invalid)?)?;
    let mut pending: Option<ContainerCreation> = if path.exists() {
        if plain_file(&path)?.len() > 65536 {
            return Err(invalid());
        }
        Some(serde_json::from_slice(&fs::read(&path)?).map_err(|_| invalid())?)
    } else {
        None
    };
    if pending.as_ref().is_none_or(|intent| intent.confirmed) {
        let result = request(
            reqwest::Method::GET,
            "",
            &[
                (
                    "q",
                    "trashed = false and appProperties has { key='memoka_container' and value='1' }",
                ),
                ("pageSize", "100"),
                ("fields", &format!("files({FIELDS}),nextPageToken")),
            ],
            None,
        )?;
        let files = result["files"].as_array().ok_or_else(invalid)?;
        if files.len() > 1 || result.get("nextPageToken").is_some() {
            return Err(ReadError::new(
                "CLOUD_INIT_AMBIGUOUS",
                "Memokaの親フォルダーが複数あります。「既存フォルダーを選択」で使用先を選んでください。",
            ));
        }
        if let Some(value) = files.first() {
            if value["appProperties"]["memoka_container"] != "1" {
                return Err(invalid());
            }
            return validate_with(value["id"].as_str().ok_or_else(invalid)?, true, |id| {
                request(
                    reqwest::Method::GET,
                    &format!("/{id}"),
                    &[("fields", FIELDS)],
                    None,
                )
            });
        }
        pending = Some(ContainerCreation {
            folder_id: generate_with(&mut request)?,
            nonce: uuid::Uuid::now_v7().to_string(),
            confirmed: false,
        });
        private_files::atomic_json(&path, pending.as_ref().unwrap())?;
    }
    let mut pending = pending.ok_or_else(invalid)?;
    super::validate_connection_id(&pending.nonce)?;
    let value = provision_with(
        &pending.folder_id,
        "Memoka",
        "root",
        json!({"memoka_container":"1", "memoka_nonce":pending.nonce}),
        request,
    )?;
    let parent = named(&value, true)?;
    pending.confirmed = true;
    private_files::atomic_json(&path, &pending)?;
    Ok(parent)
}

pub(super) fn provision_backup(
    token: &str,
    placement: &Placement,
    workspace: &str,
    destination: &str,
    nonce: &str,
    cancel: &Cancellation,
) -> Result<Value, ReadError> {
    for id in [workspace, destination, nonce] {
        super::validate_connection_id(id)?;
    }
    validate(
        token,
        &placement.parent.folder_id,
        placement.parent.automatic,
        cancel,
    )?;
    let value = provision_with(
        &placement.folder_id,
        &format!("Backup-{workspace}-{destination}"),
        &placement.parent.folder_id,
        json!({"memoka_backup":"1","memoka_workspace_id":workspace,"memoka_destination_id":destination,"memoka_nonce":nonce}),
        |method, path, query, body| drive::request(method, path, query, body, token, cancel),
    )?;
    drive::validate_root_object(&value, &placement.folder_id)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Method;
    fn missing() -> ReadError {
        ReadError::new("CLOUD_ROOT_UNAVAILABLE", "not granted or missing")
    }
    fn item(id: &str, parent: &str) -> Value {
        json!({"id":id,"name":"User folder 日本語","mimeType":drive::FOLDER,"parents":[parent],"capabilities":{"canAddChildren":true}})
    }
    #[test]
    fn parent_validation_accepts_user_folders_but_rejects_unsafe_locations() {
        let chosen = item("chosen123", "ancestor1");
        let mut root = item("ancestor1", "unused123");
        root.as_object_mut().unwrap().remove("parents");
        let selected = validate_with("chosen123", false, |id| {
            Ok(if id == "chosen123" {
                chosen.clone()
            } else {
                root.clone()
            })
        })
        .unwrap();
        assert_eq!(selected.name, "User folder 日本語");
        assert!(!selected.automatic);
        // Scope stays drive.file: ungranted ancestors are not enumerated.
        assert!(
            validate_with("chosen123", false, |id| if id == "chosen123" {
                Ok(chosen.clone())
            } else {
                Err(missing())
            })
            .is_ok()
        );
        for (key, value) in [
            ("mimeType", json!("text/plain")),
            ("trashed", json!(true)),
            ("driveId", json!("shared-drive")),
            ("shortcutDetails", json!({})),
            ("capabilities", json!({"canAddChildren":false})),
            ("parents", json!([])),
            ("parents", json!(["chosen123"])),
            ("appProperties", json!({"memoka_backup":"1"})),
        ] {
            let mut bad = chosen.clone();
            bad[key] = value;
            assert!(
                validate_with("chosen123", false, |_| Ok(bad.clone())).is_err(),
                "{key}"
            );
        }
        let mut repository = item("ancestor1", "root12345");
        repository["appProperties"] = json!({"memoka_backup":"1"});
        assert!(
            validate_with("chosen123", false, |id| Ok(if id == "chosen123" {
                chosen.clone()
            } else {
                repository.clone()
            }))
            .is_err()
        );
        assert_eq!(
            validate_with("chosen123", false, |_| Err(ReadError::new(
                "CLOUD_RATE_LIMIT",
                "retry"
            )))
            .unwrap_err()
            .code,
            "CLOUD_RATE_LIMIT"
        );
    }
    #[test]
    fn reserved_child_reconciles_conflict_and_rejects_another_folder_without_writing_it() {
        let properties = json!({"memoka_backup":"1","memoka_nonce":"nonce"});
        let mut remote = item("reserved1", "parent123");
        remote["appProperties"] = properties.clone();
        let mut calls = 0;
        let result = provision_with(
            "reserved1",
            "Backup-test",
            "parent123",
            properties.clone(),
            |method, path, _, body| {
                calls += 1;
                match calls {
                    1 => {
                        assert_eq!((method, path), (Method::GET, "/reserved1"));
                        Err(missing())
                    }
                    2 => {
                        assert_eq!((method, path), (Method::POST, ""));
                        let body = body.unwrap();
                        assert_eq!(body["id"], "reserved1");
                        assert_eq!(body["parents"], json!(["parent123"]));
                        assert_eq!(body["name"], "Backup-test");
                        Err(ReadError::new("CLOUD_ALREADY_EXISTS", "409"))
                    }
                    3 => {
                        assert_eq!((method, path), (Method::GET, "/reserved1"));
                        Ok(remote.clone())
                    }
                    _ => panic!("must never create another ID"),
                }
            },
        )
        .unwrap();
        assert_eq!(result["id"], "reserved1");
        for (key, value) in [
            ("parents", json!(["other123"])),
            ("id", json!("other123")),
            (
                "appProperties",
                json!({"memoka_backup":"1","memoka_nonce":"other"}),
            ),
            ("trashed", json!(true)),
        ] {
            let mut bad = remote.clone();
            bad[key] = value;
            assert_eq!(
                provision_with(
                    "reserved1",
                    "Backup-test",
                    "parent123",
                    properties.clone(),
                    |method, _, _, _| {
                        assert_eq!(method, Method::GET);
                        Ok(bad.clone())
                    }
                )
                .unwrap_err()
                .code,
                "CLOUD_INIT_AMBIGUOUS"
            );
        }
    }
    fn service(path: &std::path::Path) -> CloudService {
        CloudService {
            root: path.join("cloud"),
            profile_file: None,
            credentials: std::sync::Arc::new(crate::credentials::OsCredentials),
        }
    }
    #[test]
    fn default_parent_reserves_before_post_and_recovers_after_lost_response() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path());
        let meta = super::super::tests::metadata(&uuid::Uuid::now_v7().to_string());
        let mut stored = None;
        let result = resolve_with(&service, &meta, |method, path, query, body| {
            if method == Method::GET && path.is_empty() {
                let q = query.iter().find(|(k, _)| *k == "q").unwrap().1;
                assert!(q.contains("memoka_container"));
                assert!(!q.contains("name ="));
                return Ok(json!({"files":[]}));
            }
            if path == "/generateIds" {
                return Ok(json!({"ids":["reserved1"]}));
            }
            if method == Method::GET {
                return Err(missing());
            }
            assert_eq!(method, Method::POST);
            let entries: Vec<_> = fs::read_dir(service.root.join("parent-operations"))
                .unwrap()
                .collect();
            let pending: ContainerCreation =
                serde_json::from_slice(&fs::read(entries[0].as_ref().unwrap().path()).unwrap())
                    .unwrap();
            let mut body = body.unwrap();
            assert_eq!(body["id"], pending.folder_id);
            assert!(!pending.confirmed);
            assert_eq!(body["appProperties"]["memoka_nonce"], pending.nonce);
            assert_eq!(body["name"], "Memoka");
            assert_eq!(body["parents"], json!(["root"]));
            body["parents"] = json!(["actual-root"]);
            body["capabilities"] = json!({"canAddChildren":true});
            stored = Some(body);
            Err(ReadError::new("CLOUD_IO", "response lost"))
        });
        assert_eq!(result.unwrap_err().code, "CLOUD_IO");
        let result = resolve_with(&service, &meta, |method, path, _, _| {
            assert_eq!((method, path), (Method::GET, "/reserved1"));
            Ok(stored.clone().unwrap())
        })
        .unwrap();
        assert_eq!(result.folder_id, "reserved1");
        assert!(result.automatic);
        // Another connection for this account discovers the marked container,
        // even after a rename. No additional folder is created.
        let result = resolve_with(&service, &meta, |method, path, _, _| {
            assert_eq!(method, Method::GET);
            match path {
                "" => Ok(json!({"files":[stored.clone().unwrap()]})),
                "/reserved1" => {
                    let mut value = stored.clone().unwrap();
                    value["name"] = json!("Renamed Memoka");
                    Ok(value)
                }
                "/actual-root" => Err(missing()),
                _ => panic!("unexpected request {path}"),
            }
        })
        .unwrap();
        assert_eq!(result.name, "Renamed Memoka");
    }
    #[test]
    fn ambiguous_defaults_and_missing_remembered_parent_never_fall_back_to_create() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path());
        let mut meta = super::super::tests::metadata(&uuid::Uuid::now_v7().to_string());
        assert_eq!(
            resolve_with(&service, &meta, |method, path, _, _| {
                assert_eq!((method, path), (Method::GET, ""));
                Ok(json!({"files":[item("parent123","root12345"),item("parent456","root12345")]}))
            })
            .unwrap_err()
            .code,
            "CLOUD_INIT_AMBIGUOUS"
        );
        meta.backup_parent = Some(BackupParent {
            folder_id: "chosen123".into(),
            name: "Remembered".into(),
            automatic: false,
        });
        assert_eq!(
            resolve_with(&service, &meta, |method, path, _, _| {
                assert_eq!((method, path), (Method::GET, "/chosen123"));
                Err(missing())
            })
            .unwrap_err()
            .code,
            "CLOUD_ROOT_UNAVAILABLE"
        );
    }
}
