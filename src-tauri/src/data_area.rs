use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::persistence::{PersistenceError, ProductPersistenceState, ProductStore, sync_directory};
use crate::portable_mirror::PortableMirrorOperationState;

const DATA_AREA_SCHEMA_VERSION: u32 = 1;
const DATA_AREA_MARKER: &str = "data-area.json";
const SELECTION_FILE: &str = "selected-workspace.json";
pub(crate) const INTERNAL_DIRECTORY: &str = ".memoka";
pub(crate) const MIRROR_UPDATE_MARKER: &str = ".memoka-mirror-updating";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataAreaMarker {
    schema_version: u32,
    kind: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedWorkspace {
    schema_version: u32,
    path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataAreaStatus {
    selected: bool,
    path: Option<PathBuf>,
    mirror_needs_repair: bool,
}

pub(crate) fn prepare_data_area(path: &Path) -> Result<PathBuf, PersistenceError> {
    if path.as_os_str().is_empty() {
        return Err(PersistenceError::InvalidInput(
            "Workspace data area path is empty".to_owned(),
        ));
    }
    fs::create_dir_all(path)?;
    let canonical = fs::canonicalize(path)?;
    let metadata = fs::symlink_metadata(&canonical)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::InvalidInput(
            "Workspace data area must be a local directory".to_owned(),
        ));
    }
    let internal = canonical.join(INTERNAL_DIRECTORY);
    let marker_path = internal.join(DATA_AREA_MARKER);
    if marker_path.exists() {
        validate_marker(&marker_path)?;
        return Ok(canonical);
    }
    if internal.exists() {
        return Err(PersistenceError::InvalidInput(
            "The selected directory contains an unrecognized .memoka directory".to_owned(),
        ));
    }
    let mut entries = fs::read_dir(&canonical)?;
    if entries.next().transpose()?.is_some() {
        return Err(PersistenceError::InvalidInput(
            "A new Workspace data area must be an empty directory".to_owned(),
        ));
    }
    fs::create_dir(&internal)?;
    write_json_atomic(
        &marker_path,
        &DataAreaMarker {
            schema_version: DATA_AREA_SCHEMA_VERSION,
            kind: "memoka-data-area".to_owned(),
        },
    )?;
    sync_directory(&internal)?;
    sync_directory(&canonical)?;
    Ok(canonical)
}

pub(crate) fn open_data_area(path: &Path) -> Result<ProductStore, PersistenceError> {
    let canonical = fs::canonicalize(path)?;
    validate_marker(&canonical.join(INTERNAL_DIRECTORY).join(DATA_AREA_MARKER))?;
    ProductStore::open(canonical.join(INTERNAL_DIRECTORY))
}

pub(crate) fn load_selected_data_area(
    app: &AppHandle,
) -> Result<Option<PathBuf>, PersistenceError> {
    let path = selection_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let selection: SelectedWorkspace = serde_json::from_slice(&fs::read(path)?)?;
    if selection.schema_version != DATA_AREA_SCHEMA_VERSION {
        return Err(PersistenceError::InvalidInput(format!(
            "Unsupported selected Workspace schema: {}",
            selection.schema_version
        )));
    }
    let canonical = fs::canonicalize(&selection.path).map_err(|error| {
        PersistenceError::InvalidInput(format!(
            "The selected Workspace data area is unavailable ({}): {error}",
            selection.path.display()
        ))
    })?;
    validate_marker(&canonical.join(INTERNAL_DIRECTORY).join(DATA_AREA_MARKER))?;
    Ok(Some(canonical))
}

pub(crate) fn save_selected_data_area(
    app: &AppHandle,
    path: &Path,
) -> Result<(), PersistenceError> {
    let selection_path = selection_path(app)?;
    if let Some(parent) = selection_path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json_atomic(
        &selection_path,
        &SelectedWorkspace {
            schema_version: DATA_AREA_SCHEMA_VERSION,
            path: path.to_path_buf(),
        },
    )?;
    if let Some(parent) = selection_path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn selection_path(app: &AppHandle) -> Result<PathBuf, PersistenceError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SELECTION_FILE))
        .map_err(|error| {
            PersistenceError::InvalidInput(format!(
                "cannot resolve application config directory: {error}"
            ))
        })
}

fn validate_marker(path: &Path) -> Result<(), PersistenceError> {
    let marker: DataAreaMarker = serde_json::from_slice(&fs::read(path).map_err(|error| {
        PersistenceError::InvalidInput(format!(
            "Workspace data area marker is unavailable ({}): {error}",
            path.display()
        ))
    })?)?;
    if marker.schema_version != DATA_AREA_SCHEMA_VERSION || marker.kind != "memoka-data-area" {
        return Err(PersistenceError::InvalidInput(
            "Unsupported Workspace data area marker".to_owned(),
        ));
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), PersistenceError> {
    let staging = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&staging)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(staging, path)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn data_area_status(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
) -> Result<DataAreaStatus, String> {
    let path = state
        .ensure_selected_data_area(&app)
        .map_err(|error| error.to_string())?;
    Ok(DataAreaStatus {
        selected: path.is_some(),
        mirror_needs_repair: path
            .as_ref()
            .is_some_and(|path| path.join(MIRROR_UPDATE_MARKER).exists()),
        path,
    })
}

#[tauri::command]
pub(crate) fn data_area_activate(
    app: AppHandle,
    state: State<'_, ProductPersistenceState>,
    mirror_state: State<'_, PortableMirrorOperationState>,
    path: PathBuf,
) -> Result<DataAreaStatus, String> {
    if mirror_state
        .has_active_operations()
        .map_err(|error| error.to_string())?
    {
        return Err("portable mirror publication is still active".to_owned());
    }
    let path = state
        .activate_data_area(&app, path)
        .map_err(|error| error.to_string())?;
    Ok(DataAreaStatus {
        selected: true,
        mirror_needs_repair: path.join(MIRROR_UPDATE_MARKER).exists(),
        path: Some(path),
    })
}

#[cfg(test)]
mod tests {
    use super::{DATA_AREA_MARKER, INTERNAL_DIRECTORY, open_data_area, prepare_data_area};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn prepares_and_reopens_an_empty_data_area() {
        let temporary = tempdir().unwrap();
        let data_area = temporary.path().join("workspace");
        let prepared = prepare_data_area(&data_area).unwrap();
        assert!(
            prepared
                .join(INTERNAL_DIRECTORY)
                .join(DATA_AREA_MARKER)
                .is_file()
        );
        assert!(open_data_area(&prepared).is_ok());
        assert_eq!(prepare_data_area(&prepared).unwrap(), prepared);
    }

    #[test]
    fn refuses_to_claim_a_non_empty_unrecognized_directory() {
        let temporary = tempdir().unwrap();
        fs::write(temporary.path().join("owned.txt"), "keep").unwrap();
        let error = prepare_data_area(temporary.path()).unwrap_err();
        assert!(error.to_string().contains("must be an empty directory"));
        assert_eq!(
            fs::read_to_string(temporary.path().join("owned.txt")).unwrap(),
            "keep"
        );
    }
}
