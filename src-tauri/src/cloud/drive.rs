//! Minimal Drive control plane (folder identity/nonce validation only). All
//! repository transfer/encryption/refresh stays with Restic/rclone.
use super::oauth::http_client;
use crate::{document_model::ReadError, rclone::DriveRepository, restic::Cancellation};
use serde_json::{Value, json};
use std::{io::Read, sync::atomic::Ordering};
const API: &str = "https://www.googleapis.com/drive/v3/files";
pub(super) const FOLDER: &str = "application/vnd.google-apps.folder";
pub(super) fn access_token(
    context: &DriveRepository,
    cancel: &Cancellation,
) -> Result<zeroize::Zeroizing<String>, ReadError> {
    // about invokes the fixed backend's token source. Any refresh is written
    // to the encrypted canonical config under the same connection lease.
    context.rclone.json(
        &context.config,
        &context.key,
        &["about", "memoka_drive:", "--json"],
        cancel,
    )?;
    let dump = context
        .rclone
        .json(&context.config, &context.key, &["config", "dump"], cancel)?;
    let token = dump["memoka_drive"]["token"]
        .as_str()
        .ok_or_else(protocol)?;
    let token: Value = serde_json::from_str(token).map_err(|_| protocol())?;
    Ok(zeroize::Zeroizing::new(
        token["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(protocol)?
            .to_string(),
    ))
}
fn protocol() -> ReadError {
    ReadError::new("CLOUD_PROTOCOL", "Invalid Google Drive response")
}
pub(super) fn request(
    method: reqwest::Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
    token: &str,
    cancel: &Cancellation,
) -> Result<Value, ReadError> {
    if cancel.load(Ordering::Acquire) {
        return Err(ReadError::new(
            "CANCELLED",
            "Google Drive operation cancelled",
        ));
    }
    let mut url = url::Url::parse(&if path == "/about" {
        "https://www.googleapis.com/drive/v3/about".to_owned()
    } else {
        format!("{API}{path}")
    })
    .map_err(|_| protocol())?;
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    let mut request = http_client()?.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .map_err(|_| ReadError::new("CLOUD_IO", "Cannot contact Google Drive"))?;
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| protocol())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(protocol());
    }
    if cancel.load(Ordering::Acquire) {
        return Err(ReadError::new(
            "CANCELLED",
            "Google Drive operation cancelled",
        ));
    }
    if !status.is_success() {
        if status.as_u16() == 409 {
            return Err(ReadError::new(
                "CLOUD_ALREADY_EXISTS",
                "The reserved Drive file ID already exists",
            ));
        }
        if status.as_u16() == 404 {
            return Err(ReadError::new(
                "CLOUD_ROOT_UNAVAILABLE",
                "The backup folder is missing or this OAuth client/account cannot access it; it will not be recreated",
            ));
        }
        if status.as_u16() == 401 {
            return Err(ReadError::new(
                "CLOUD_REAUTH_REQUIRED",
                "Google authorization is no longer valid",
            ));
        }
        if status.as_u16() == 403 {
            let error = crate::rclone::classify_error(&bytes);
            return Err(if error.code == "CLOUD_IO" {
                ReadError::new(
                    "CLOUD_ACCESS_DENIED",
                    "Google denied this folder operation; verify the client/account and folder permission",
                )
            } else {
                error
            });
        }
        if status.as_u16() == 429 {
            return Err(ReadError::new(
                "CLOUD_RATE_LIMIT",
                "Google Drive rate limited the request",
            ));
        }
        if status.is_server_error() {
            return Err(ReadError::new(
                "CLOUD_TRANSIENT",
                "Google Drive is temporarily unavailable",
            ));
        }
        return Err(protocol());
    }
    serde_json::from_slice(&bytes).map_err(|_| protocol())
}
pub(super) fn validate_root(
    token: &str,
    id: &str,
    cancel: &Cancellation,
) -> Result<Value, ReadError> {
    super::validate_folder_id(id)?;
    let value = request(
        reqwest::Method::GET,
        &format!("/{id}"),
        &[(
            "fields",
            "id,name,mimeType,driveId,trashed,shortcutDetails,appProperties,parents",
        )],
        None,
        token,
        cancel,
    )?;
    validate_root_object(&value, id)?;
    Ok(value)
}
pub(super) fn account_id(token: &str, cancel: &Cancellation) -> Result<String, ReadError> {
    let value = request(
        reqwest::Method::GET,
        "/about",
        &[("fields", "user(permissionId)")],
        None,
        token,
        cancel,
    )?;
    value["user"]["permissionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(protocol)
}
pub(super) fn validate_root_object(value: &Value, id: &str) -> Result<(), ReadError> {
    if value["id"] != id
        || value["mimeType"] != FOLDER
        || value.get("driveId").is_some()
        || value.get("shortcutDetails").is_some()
        || value["trashed"] == true
        || value["appProperties"]["memoka_backup"] != "1"
    {
        return Err(ReadError::new(
            "CLOUD_ROOT_INVALID",
            "Select a dedicated Memoka folder in My Drive, not a shortcut, shared drive or arbitrary folder",
        ));
    }
    Ok(())
}
// Inspect original Drive metadata, not rclone's resolved/exported view: a
// shortcut to a pack must not masquerade as a regular binary file. This is
// metadata only; repository read/write remains exclusively Restic+rclone.
pub(crate) fn validate_repository_layout(
    context: &DriveRepository,
    cancel: &Cancellation,
    empty: bool,
) -> Result<(), ReadError> {
    let token = access_token(context, cancel)?;
    let began = std::time::Instant::now();
    let mut queue = vec![(context.folder_id.clone(), String::new())];
    let mut objects = 0usize;
    while let Some((parent, relative)) = queue.pop() {
        super::validate_folder_id(&parent)?;
        let query = format!("'{parent}' in parents and trashed = false");
        let mut page = String::new();
        let mut names = std::collections::BTreeSet::new();
        let mut pages = std::collections::BTreeSet::new();
        loop {
            if began.elapsed() >= std::time::Duration::from_secs(300) {
                return Err(ReadError::new(
                    "TIMEOUT",
                    "Drive layout validation exceeded its five-minute limit",
                ));
            }
            let value = request(
                reqwest::Method::GET,
                "",
                &[
                    ("q", &query),
                    ("pageSize", "1000"),
                    ("pageToken", &page),
                    (
                        "fields",
                        "files(id,name,mimeType,shortcutDetails,driveId),nextPageToken",
                    ),
                ],
                None,
                &token,
                cancel,
            )?;
            let entries = value["files"].as_array().ok_or_else(protocol)?;
            if empty && !entries.is_empty() {
                return Err(ReadError::new(
                    "REPOSITORY_NOT_EMPTY",
                    "Drive initialization requires an empty dedicated folder; existing objects were not changed",
                ));
            }
            for entry in entries {
                objects += 1;
                if objects > 1_000_000 {
                    return Err(unsafe_layout());
                }
                let name = check_layout_entry(&relative, entry)?;
                if !names.insert(name.clone()) {
                    return Err(unsafe_layout());
                }
                if entry["mimeType"] == FOLDER {
                    let id = entry["id"].as_str().ok_or_else(protocol)?;
                    queue.push((
                        id.into(),
                        if relative.is_empty() {
                            name
                        } else {
                            format!("{relative}/{name}")
                        },
                    ));
                }
            }
            let Some(next) = value["nextPageToken"].as_str() else {
                break;
            };
            if next.is_empty() || !pages.insert(next.to_owned()) {
                return Err(protocol());
            }
            page = next.into();
        }
    }
    Ok(())
}
fn unsafe_layout() -> ReadError {
    ReadError::new(
        "DRIVE_UNSAFE_LAYOUT",
        "Duplicate names, shortcuts or unexpected objects prevent repository maintenance; no cleanup was attempted",
    )
}
fn check_layout_entry(parent: &str, value: &Value) -> Result<String, ReadError> {
    let name = value["name"].as_str().ok_or_else(protocol)?;
    let mime = value["mimeType"].as_str().ok_or_else(protocol)?;
    if value.get("shortcutDetails").is_some()
        || value.get("driveId").is_some()
        || (mime.starts_with("application/vnd.google-apps.") && mime != FOLDER)
    {
        return Err(unsafe_layout());
    }
    let hex = |s: &str, len: usize| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let valid = if parent.is_empty() {
        if name == "config" {
            mime != FOLDER
        } else {
            ["data", "index", "keys", "locks", "snapshots"].contains(&name) && mime == FOLDER
        }
    } else if parent == "data" {
        hex(name, 2) && mime == FOLDER
    } else if ["index", "keys", "locks", "snapshots"].contains(&parent)
        || parent.strip_prefix("data/").is_some_and(|p| hex(p, 2))
    {
        hex(name, 64) && mime != FOLDER
    } else {
        false
    };
    if !valid {
        return Err(unsafe_layout());
    }
    Ok(name.into())
}
pub(super) fn create_or_find_root(
    token: &str,
    workspace: &str,
    destination: &str,
    nonce: &str,
    create: bool,
    cancel: &Cancellation,
) -> Result<Value, ReadError> {
    provision_root(
        workspace,
        destination,
        nonce,
        create,
        |method, query, body| request(method, "", query, body, token, cancel),
    )
}
fn provision_root(
    workspace: &str,
    destination: &str,
    nonce: &str,
    create: bool,
    mut request: impl FnMut(reqwest::Method, &[(&str, &str)], Option<Value>) -> Result<Value, ReadError>,
) -> Result<Value, ReadError> {
    super::validate_connection_id(workspace)?;
    super::validate_connection_id(destination)?;
    super::validate_connection_id(nonce)?;
    let query = format!(
        "trashed = false and appProperties has {{ key='memoka_nonce' and value='{nonce}' }}"
    );
    let value = request(
        reqwest::Method::GET,
        &[
            ("q", &query),
            (
                "fields",
                "files(id,name,mimeType,driveId,trashed,shortcutDetails,appProperties),nextPageToken",
            ),
            ("pageSize", "100"),
        ],
        None,
    )?;
    let files = value["files"].as_array().ok_or_else(protocol)?;
    if files.len() > 1 || value.get("nextPageToken").is_some() {
        return Err(ReadError::new(
            "CLOUD_INIT_AMBIGUOUS",
            "Multiple folders match this initialization intent; no folder was selected or deleted",
        ));
    }
    if let Some(file) = files.first() {
        let id = file["id"].as_str().ok_or_else(protocol)?;
        validate_root_object(file, id)?;
        if file["appProperties"]["memoka_workspace_id"] != workspace
            || file["appProperties"]["memoka_destination_id"] != destination
        {
            return Err(protocol());
        }
        return Ok(file.clone());
    }
    // Lost create responses are reconciled, not followed by another create.
    if !create {
        return Err(ReadError::new(
            "CLOUD_INIT_UNRESOLVED",
            "An earlier folder creation may still be pending; retry reconciliation later, without creating another folder",
        ));
    }
    let value = request(
        reqwest::Method::POST,
        &[("fields", "id,name,mimeType,appProperties")],
        Some(
            json!({"name":format!("MemokaBackup-{workspace}-{destination}"),"mimeType":FOLDER,"parents":["root"],"appProperties":{"memoka_backup":"1","memoka_workspace_id":workspace,"memoka_destination_id":destination,"memoka_nonce":nonce}}),
        ),
    )?;
    let id = value["id"].as_str().ok_or_else(protocol)?;
    super::validate_folder_id(id)?;
    validate_root_object(&value, id)?;
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_folder_create_is_reconciled_by_nonce_and_never_created_twice() {
        let workspace = uuid::Uuid::now_v7().to_string();
        let destination = uuid::Uuid::now_v7().to_string();
        let nonce = uuid::Uuid::now_v7().to_string();
        let root = json!({"id":"realFolder123","name":"renamed","mimeType":FOLDER,"appProperties":{"memoka_backup":"1","memoka_workspace_id":workspace,"memoka_destination_id":destination,"memoka_nonce":nonce}});
        let mut creates = 0;
        let failed = provision_root(&workspace, &destination, &nonce, true, |method, _, body| {
            if method == reqwest::Method::GET {
                return Ok(json!({"files":[]}));
            }
            creates += 1;
            assert_eq!(body.unwrap()["appProperties"]["memoka_nonce"], nonce);
            Err(ReadError::new("CLOUD_IO", "simulated lost response"))
        });
        assert!(failed.is_err());
        assert_eq!(creates, 1);
        for entries in [json!([]), json!([root.clone(), root.clone()])] {
            let result = provision_root(&workspace, &destination, &nonce, false, |method, _, _| {
                assert_eq!(method, reqwest::Method::GET);
                Ok(json!({"files":entries}))
            });
            assert!(matches!(
                result.unwrap_err().code.as_str(),
                "CLOUD_INIT_UNRESOLVED" | "CLOUD_INIT_AMBIGUOUS"
            ));
        }
        let found = provision_root(&workspace, &destination, &nonce, false, |method, _, _| {
            assert_eq!(method, reqwest::Method::GET);
            Ok(json!({"files":[root]}))
        })
        .unwrap();
        assert_eq!(found["id"], "realFolder123");
        assert_eq!(creates, 1);
    }
    #[test]
    fn layout_rejects_shortcut_docs_and_unknown_objects_before_maintenance() {
        let file =
            json!({"id":"123456789","name":"a".repeat(64),"mimeType":"application/octet-stream"});
        assert!(check_layout_entry("snapshots", &file).is_ok());
        assert!(check_layout_entry("data/aa", &file).is_ok());
        let mut shortcut = file.clone();
        shortcut["shortcutDetails"] = json!({"targetId":"other"});
        assert!(check_layout_entry("snapshots", &shortcut).is_err());
        let mut document = file.clone();
        document["mimeType"] = json!("application/vnd.google-apps.document");
        assert!(check_layout_entry("snapshots", &document).is_err());
        let mut unknown = file.clone();
        unknown["name"] = json!("unrecognized.txt");
        assert!(check_layout_entry("snapshots", &unknown).is_err());
        assert!(check_layout_entry("data/../../other", &file).is_err());
    }
    #[test]
    fn unexpected_drive_objects_are_not_repositories() {
        let root =
            json!({"id":"abc_123456","mimeType":FOLDER,"appProperties":{"memoka_backup":"1"}});
        assert!(validate_root_object(&root, "abc_123456").is_ok());
        for (key, value) in [
            ("mimeType", json!("application/vnd.google-apps.shortcut")),
            ("driveId", json!("shared")),
            ("trashed", json!(true)),
            ("appProperties", json!({})),
        ] {
            let mut bad = root.clone();
            bad[key] = value;
            assert!(validate_root_object(&bad, "abc_123456").is_err());
        }
    }
}
