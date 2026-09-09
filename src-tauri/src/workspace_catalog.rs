//! A bounded per-user list of explicitly opened Workspaces, not filesystem
//! discovery. Listing never selects, opens, initializes, or migrates a Workspace.
use crate::{document_model::ReadError, private_files, read_service::plain_file};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const LIMIT: usize = 100;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    schema_version: u32,
    path: PathBuf,
    #[serde(default)]
    recent_paths: Vec<PathBuf>,
}
pub(crate) fn selection_path() -> Result<PathBuf, ReadError> {
    Ok(dirs::config_dir()
        .ok_or_else(|| {
            ReadError::new(
                "CONFIG_UNAVAILABLE",
                "Cannot locate application configuration",
            )
        })?
        .join("dev.memoka.desktop/selected-workspace.json"))
}
fn read(path: &Path) -> Result<Option<Selection>, ReadError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => plain_file(path)?,
    };
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err(ReadError::new(
            "INVALID_DATA",
            "Workspace catalog exceeds size limit",
        ));
    }
    let value: Selection = serde_json::from_slice(&bytes)?;
    if value.schema_version != 1
        || !value.path.is_absolute()
        || value.recent_paths.len() > LIMIT
        || value.recent_paths.iter().any(|path| !path.is_absolute())
    {
        return Err(ReadError::new(
            "UNSUPPORTED_SCHEMA",
            "Invalid Workspace selection or catalog",
        ));
    }
    Ok(Some(value))
}
pub(crate) fn save_selection(file: &Path, selected: &Path) -> Result<(), ReadError> {
    let selected = fs::canonicalize(selected)?;
    let _lease = private_files::Lease::acquire(file.with_extension("lock"))?;
    let previous = read(file)?;
    let mut recent = Vec::new();
    recent.push(selected.clone());
    if let Some(previous) = previous {
        for path in std::iter::once(previous.path).chain(previous.recent_paths) {
            if !recent.contains(&path) && recent.len() < LIMIT {
                recent.push(path);
            }
        }
    }
    private_files::atomic_json(
        file,
        &Selection {
            schema_version: 1,
            path: selected,
            recent_paths: recent,
        },
    )
}
pub(crate) fn list(file: &Path) -> Result<Value, ReadError> {
    let mut items = Vec::new();
    if let Some(selection) = read(file)? {
        let mut paths = Vec::new();
        for path in std::iter::once(selection.path.clone()).chain(selection.recent_paths) {
            if paths.contains(&path) {
                continue;
            }
            paths.push(path.clone());
            // Availability is a directory/marker check, not a database-health
            // assertion. tree/read provide Workspace identity and diagnostics.
            let available = path.is_dir() && path.join(".memoka/data-area.json").is_file();
            items
                .push(json!({"path":path,"selected":path == selection.path,"available":available}));
        }
    }
    Ok(json!({"schema_version":1,"source":"known_workspaces","items":items,"total":items.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_legacy_and_missing_workspaces_are_listed_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config/selected-workspace.json");
        assert_eq!(list(&file).unwrap()["total"], 0);
        assert!(!file.parent().unwrap().exists());
        fs::create_dir(file.parent().unwrap()).unwrap();
        let absent = temp.path().join("not-mounted");
        let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"path":absent})).unwrap();
        fs::write(&file, &bytes).unwrap();
        let result = list(&file).unwrap();
        assert_eq!(result["items"][0]["available"], false);
        assert_eq!(result["items"][0]["selected"], true);
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert!(!absent.exists());
    }
    #[test]
    fn switching_keeps_deduplicated_mru_paths_and_does_not_scan_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config/selected-workspace.json");
        let a = crate::data_area::prepare_data_area(&temp.path().join("日本語 A")).unwrap();
        let b = crate::data_area::prepare_data_area(&temp.path().join("B")).unwrap();
        crate::data_area::prepare_data_area(&temp.path().join("Unopened")).unwrap();
        save_selection(&file, &a).unwrap();
        save_selection(&file, &b).unwrap();
        save_selection(&file, &a).unwrap();
        let items = list(&file).unwrap()["items"].clone();
        assert_eq!(items.as_array().unwrap().len(), 2);
        assert_eq!(items[0]["path"], a.to_string_lossy().as_ref());
        assert_eq!(items[1]["path"], b.to_string_lossy().as_ref());
        assert_eq!(items[1]["selected"], false);
        assert_eq!(items[0]["available"], true);
    }
}
