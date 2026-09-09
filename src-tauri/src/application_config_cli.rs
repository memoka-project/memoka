//! Application-wide settings: one bounded, comment-preserving transaction.
//! Uses the same validation/lock/publication as GUI setting commands, no Workspace.
use super::*;
use crate::{
    document_model::ReadError,
    private_files,
    read_service::{checked_directory, plain_file},
};
use schemars::JsonSchema;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::PathBuf,
};

const KEYS: &[&str] = &[
    "theme",
    "font_family",
    "zoom_percent",
    "note_max_width_px",
    "line_number_min_width_px",
    "indent_width_px",
    "japanese.word_segmentation",
    "japanese.line_break_segmentation",
];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfigRequest {
    schema_version: u32,
    expected_revision: String,
    #[serde(default)]
    set: BTreeMap<String, Value>,
    #[serde(default)]
    unset: Vec<String>,
}

fn invalid(message: impl Into<String>) -> ReadError {
    ReadError::new("INVALID_ARGUMENT", &message.into())
}
fn invalid_config(message: impl Into<String>) -> ReadError {
    ReadError::new("CONFIG_INVALID", &message.into())
}

pub(crate) fn path() -> Result<PathBuf, ReadError> {
    Ok(dirs::config_dir()
        .ok_or_else(|| {
            ReadError::new(
                "CONFIG_UNAVAILABLE",
                "Cannot locate application configuration",
            )
        })?
        .join("dev.memoka.desktop/config.toml"))
}

pub(super) fn read_source(path: &Path) -> Result<String, ReadError> {
    // No directory creation or chmod during reads/previews, including a missing config.
    for ancestor in path.ancestors().skip(1) {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => checked_directory(ancestor)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
        Ok(_) => plain_file(path)?,
    };
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(invalid_config("Configuration exceeds 256 KiB"));
    }
    String::from_utf8(bytes).map_err(|_| invalid_config("Configuration must be UTF-8"))
}

pub(super) fn revision(source: &str) -> String {
    Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub(super) fn revision_at(path: &Path) -> Result<String, ReadError> {
    Ok(revision(&read_source(path)?))
}

pub(super) fn lock(path: &Path) -> Result<private_files::Lease, ReadError> {
    private_files::Lease::acquire(path.with_extension("lock")).map_err(|e| {
        if e.code == "BACKUP_BUSY" {
            ReadError::new(
                "CONFIG_BUSY",
                "Another process is saving application settings; retry after reading again",
            )
        } else {
            e
        }
    })
}

pub(super) fn persist(path: &Path, output: &str) -> Result<(), ReadError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Invalid configuration path"))?;
    if path.exists() {
        plain_file(path)?;
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    private_files::protect(temporary.path())?;
    temporary.write_all(output.as_bytes())?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    // persist atomically replaces on both Unix and Windows; never delete the original first.
    temporary
        .persist(path)
        .map_err(|e| ReadError::new("CONFIG_IO", &e.error.to_string()))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn values(source: &str) -> Result<Value, ReadError> {
    let config = validate_source(source).map_err(invalid_config)?;
    Ok(json!({
        "theme":config.theme.unwrap_or_else(|| DEFAULT_APPLICATION_THEME.as_str().to_owned()),
        "font_family":config.font_family.unwrap_or_else(|| DEFAULT_APPLICATION_FONT_FAMILY.to_owned()),
        "zoom_percent":config.zoom_percent.unwrap_or(DEFAULT_APPLICATION_ZOOM_PERCENT),
        "note_max_width_px":config.note_max_width_px.unwrap_or(DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX),
        "line_number_min_width_px":config.line_number_min_width_px.unwrap_or(DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX),
        "indent_width_px":config.indent_width_px.unwrap_or(DEFAULT_APPLICATION_INDENT_WIDTH_PX),
        "japanese.word_segmentation":config.japanese.as_ref().and_then(|j| j.word_segmentation).unwrap_or(DEFAULT_JAPANESE_WORD_SEGMENTATION),
        "japanese.line_break_segmentation":config.japanese.as_ref().and_then(|j| j.line_break_segmentation).unwrap_or(DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION),
        "themes":config.themes,
    }))
}

pub(crate) fn get(path: &Path) -> Result<Value, ReadError> {
    let source = read_source(path)?;
    Ok(
        json!({"schema_version":1,"ok":true,"scope":"application","config_path":path,"revision":revision(&source),"values":values(&source)?}),
    )
}

pub(crate) fn schema() -> Value {
    json!({"schema_version":1,"cli_version":env!("CARGO_PKG_VERSION"),"scope":"application",
        "request":schemars::schema_for!(ConfigRequest),"custom_theme":schemars::schema_for!(CustomTheme),
        "set_keys":KEYS,"custom_theme_key":"themes.<id> (replace one complete definition)",
        "theme_id":"[a-z][a-z0-9-]{0,47}; built-in IDs are reserved",
        "theme_bases":["nightfox","dayfox","dawnfox","duskfox","nordfox","terafox","carbonfox"],
        "palette_fields":PALETTE_FIELDS,"color":"#RRGGBB; no CSS, scripts, URLs or external files",
        "constraints":{"zoom_percent":"50..200, step 10","note_max_width_px":"0 or 320..4096","line_number_min_width_px":"0 or 240..4096","indent_width_px":"16..64","font_family":"1..256 UTF-8 bytes; no control characters, semicolons or braces","japanese.word_segmentation":["fine","budoux","unicode"],"japanese.line_break_segmentation":["fine","budoux","native"]},
        "limits":{"input_bytes":MAX_CONFIG_BYTES,"config_bytes":MAX_CONFIG_BYTES,"edits":128,"themes":64},
        "get":"config get --format json","set":"config set --input FILE|- --format json [--dry-run]",
        "conflict":"expected_revision is SHA-256 of the exact config bytes; reread on conflict, no force or auto-rebase",
        "reload":"appearance and Japanese segmentation reload in running GUIs; keymaps and credentials are not writable here"})
}

pub(crate) fn parse(bytes: &[u8]) -> Result<ConfigRequest, ReadError> {
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(invalid("Request exceeds 256 KiB"));
    }
    let request: ConfigRequest = crate::agent_edit::parse_unique_request(bytes)?;
    if request.schema_version != 1
        || request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid(
            "Expected schema_version 1 and a lowercase SHA-256 expected_revision from config get",
        ));
    }
    let count = request.set.len() + request.unset.len();
    if !(1..=128).contains(&count) {
        return Err(invalid("Provide 1..128 settings"));
    }
    let mut keys = BTreeSet::new();
    for key in request.set.keys().chain(&request.unset) {
        key_parts(key)?;
        if !keys.insert(key) {
            return Err(invalid("Duplicate or overlapping set/unset key"));
        }
    }
    Ok(request)
}

fn key_parts(key: &str) -> Result<Vec<&str>, ReadError> {
    if KEYS.contains(&key) {
        return Ok(key.split('.').collect());
    }
    if key.strip_prefix("themes.").is_some_and(custom_theme_id) {
        return Ok(key.split('.').collect());
    }
    Err(invalid(format!(
        "Setting is not writable through this API: {key}"
    )))
}

fn item(value: &Value) -> Result<toml_edit::Item, ReadError> {
    match value {
        Value::String(s) => Ok(toml_edit::value(s)),
        Value::Bool(b) => Ok(toml_edit::value(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(toml_edit::value)
            .ok_or_else(|| invalid("Expected an integer")),
        Value::Object(map) => {
            let mut table = toml_edit::Table::new();
            for (k, v) in map {
                table.insert(k, item(v)?);
            }
            Ok(toml_edit::Item::Table(table))
        }
        _ => Err(invalid(
            "Unsupported setting value; use unset to restore a default",
        )),
    }
}

pub(crate) fn set(path: &Path, request: &ConfigRequest, dry_run: bool) -> Result<Value, ReadError> {
    let _lease = if dry_run { None } else { Some(lock(path)?) };
    let source = read_source(path)?;
    let before = values(&source)?;
    let revision_before = revision(&source);
    if revision_before != request.expected_revision {
        return Err(ReadError::new(
            "CONFIG_CONFLICT",
            "Application settings changed; read config get and reconsider the requested changes",
        ));
    }
    let mut document = source
        .parse::<Document>()
        .map_err(|e| invalid_config(e.to_string()))?;
    for (key, value) in &request.set {
        let parts = key_parts(key)?;
        let (leaf, parents) = parts.split_last().unwrap();
        let mut target = document.as_item_mut();
        for part in parents {
            target = &mut target[*part];
        }
        if target.is_none() {
            *target = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let inline_parent = target.is_inline_table();
        let target = &mut target[*leaf];
        let mut replacement = item(value)?;
        if inline_parent {
            replacement = toml_edit::Item::Value(
                replacement
                    .into_value()
                    .map_err(|_| invalid("Invalid inline setting"))?,
            );
        }
        // Retain the comment/format decoration when replacing a scalar.
        if let (Some(old), Some(new)) = (target.as_value(), replacement.as_value_mut()) {
            *new.decor_mut() = old.decor().clone();
        }
        *target = replacement;
    }
    let mut removed = Vec::new();
    for key in &request.unset {
        let parts = key_parts(key)?;
        let item = if parts.len() == 1 {
            document.remove(parts[0])
        } else {
            document
                .get_mut(parts[0])
                .and_then(toml_edit::Item::as_table_like_mut)
                .and_then(|parent| parent.remove(parts[1]))
        };
        if item.is_some() {
            removed.push(key);
        }
    }
    let mut output = document.to_string();
    if !output.ends_with('\n') && !output.is_empty() {
        output.push('\n');
    }
    let after = values(&output).map_err(|e| invalid(e.message))?;
    // Setting an already-effective value is a semantic no-op, including omitted defaults.
    let changed = before != after || !removed.is_empty();
    let revision_after = if changed {
        revision(&output)
    } else {
        revision_before.clone()
    };
    let changes: Vec<Value> = before
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, old)| {
            (after[key] != *old).then(|| json!({"key":key,"before":old,"after":after[key]}))
        })
        .collect();
    if !dry_run && changed {
        persist(path, &output)?;
    }
    Ok(
        json!({"schema_version":1,"ok":true,"scope":"application","config_path":path,
        "status":if dry_run {"preview"} else if changed {"applied"} else {"no_change"},
        "revision_before":revision_before,"revision_after":revision_after,"changes":changes,"unset_keys":removed,"values":after}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(path: &Path, changes: Value) -> ConfigRequest {
        parse(&serde_json::to_vec(&json!({"schema_version":1,"expected_revision":revision_at(path).unwrap(),"set":changes})).unwrap()).unwrap()
    }

    #[test]
    fn preview_and_get_are_read_only_and_absent_defaults_are_noops() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config/config.toml");
        assert_eq!(get(&path).unwrap()["values"]["theme"], "nightfox");
        let change = request(&path, json!({"theme":"dayfox","zoom_percent":120}));
        assert_eq!(set(&path, &change, true).unwrap()["status"], "preview");
        assert!(!path.parent().unwrap().exists());
        let noop = request(&path, json!({"zoom_percent":100}));
        assert_eq!(set(&path, &noop, false).unwrap()["status"], "no_change");
        assert!(!path.exists());
        assert_eq!(set(&path, &change, false).unwrap()["status"], "applied");
        assert_eq!(
            set(&path, &change, false).unwrap_err().code,
            "CONFIG_CONFLICT"
        );
        let bytes = fs::read(&path).unwrap();
        let noop = request(&path, json!({"theme":"dayfox"}));
        assert_eq!(set(&path, &noop, false).unwrap()["status"], "no_change");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn custom_theme_and_selection_commit_together_and_preserve_unrelated_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "# My preferences\ntheme = 'nightfox' # favorite theme\nzoom_percent = 100 # zoom comment\nleader = ';'\n[vim]\nwhichwrap = false\n").unwrap();
        let change = request(
            &path,
            json!({"theme":"my-night","themes.my-night":{"base":"nightfox","name":"夜のテーマ","palette":{"bg1":"#121212","orange":"#ff9933"}},"zoom_percent":120,"japanese.word_segmentation":"unicode"}),
        );
        let preview = set(&path, &change, true).unwrap();
        let applied = set(&path, &change, false).unwrap();
        assert_eq!(preview["revision_after"], applied["revision_after"]);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# My preferences"));
        assert!(text.contains("zoom_percent = 120 # zoom comment"));
        assert!(text.contains("leader = ';'"));
        assert!(text.contains("whichwrap = false"));
        let loaded = load_application_key_config(&path);
        assert_eq!(loaded.theme, "my-night");
        assert_eq!(
            loaded.custom_themes["my-night"].palette["orange"],
            "#ff9933"
        );
        assert!(loaded.warning.is_none());
        save_application_theme(&path, ApplicationTheme::Dayfox).unwrap();
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("theme = \"dayfox\" # favorite theme")
        );
        assert_eq!(
            get(&path).unwrap()["values"]["themes"]["my-night"]["base"],
            "nightfox"
        );
        fs::write(
            &path,
            "themes = { one = { base = 'dayfox' } }\njapanese = { word_segmentation = 'fine' }\n",
        )
        .unwrap();
        let inline = request(
            &path,
            json!({"themes.two":{"base":"nightfox","palette":{"blue":"#123456"}},"theme":"two","japanese.word_segmentation":"budoux"}),
        );
        set(&path, &inline, false).unwrap();
        let values = get(&path).unwrap()["values"].clone();
        assert_eq!(values["themes"]["one"]["base"], "dayfox");
        assert_eq!(values["themes"]["two"]["palette"]["blue"], "#123456");
        assert_eq!(values["japanese.word_segmentation"], "budoux");
    }

    #[test]
    fn rejects_bad_values_duplicate_keys_unknown_settings_and_partial_batches() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "font_family = '日本語, serif'\n").unwrap();
        let original = fs::read(&path).unwrap();
        for changes in [
            json!({"theme":"unknown"}),
            json!({"zoom_percent":101}),
            json!({"theme":"dayfox","indent_width_px":0}),
            json!({"font_family":"x; color:red"}),
            json!({"themes.bad":{"base":"bad"}}),
            json!({"themes.bad":{"base":"nightfox","palette":{"bg1":"url(https://example.com)"}}}),
            json!({"themes.bad":{"base":"nightfox","palette":{"typo":"#123456"}}}),
            json!({"japanese.word_segmentation":"unknown"}),
            json!({"zoom_percent":"120"}),
            json!({"note_max_width_px":4097}),
        ] {
            assert!(set(&path, &request(&path, changes), false).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        for changes in [
            json!({"leader":";"}),
            json!({"backup.password":"secret"}),
            json!({"themes.nightfox":{"base":"dayfox"}}),
            json!({"themes.a.b":{}}),
            json!({"vim.whichwrap":false}),
        ] {
            assert!(parse(&serde_json::to_vec(&json!({"schema_version":1,"expected_revision":revision_at(&path).unwrap(),"set":changes})).unwrap()).is_err());
        }
        let revision = revision_at(&path).unwrap();
        let duplicate = format!(
            r##"{{"schema_version":1,"expected_revision":"{revision}","set":{{"theme":"nightfox","theme":"dayfox"}}}}"##
        );
        assert!(parse(duplicate.as_bytes()).is_err());
        assert!(parse(&vec![b' '; MAX_CONFIG_BYTES + 1]).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn resets_defaults_removes_themes_and_does_not_remove_an_active_theme() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let initial = request(
            &path,
            json!({"theme":"custom","themes.custom":{"base":"dayfox"},"zoom_percent":120}),
        );
        set(&path, &initial, false).unwrap();
        let remove = parse(&serde_json::to_vec(&json!({"schema_version":1,"expected_revision":revision_at(&path).unwrap(),"unset":["themes.custom"]})).unwrap()).unwrap();
        assert!(set(&path, &remove, false).is_err());
        let reset = parse(&serde_json::to_vec(&json!({"schema_version":1,"expected_revision":revision_at(&path).unwrap(),"unset":["theme","themes.custom","zoom_percent"]})).unwrap()).unwrap();
        let result = set(&path, &reset, false).unwrap();
        assert_eq!(result["values"]["theme"], "nightfox");
        assert_eq!(result["values"]["zoom_percent"], 100);
        assert_eq!(result["values"]["themes"], json!({}));
        fs::write(&path, "zoom_percent = 100\n").unwrap();
        let reset = parse(&serde_json::to_vec(&json!({"schema_version":1,"expected_revision":revision_at(&path).unwrap(),"unset":["zoom_percent"]})).unwrap()).unwrap();
        assert_eq!(set(&path, &reset, false).unwrap()["status"], "applied");
        assert!(!fs::read_to_string(&path).unwrap().contains("zoom_percent"));
    }

    #[test]
    fn gui_and_cli_share_a_lock_and_detect_changes_in_unrelated_keys_or_comments() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "# first\n").unwrap();
        let change = request(&path, json!({"zoom_percent":120}));
        let lease = lock(&path).unwrap();
        assert_eq!(set(&path, &change, false).unwrap_err().code, "CONFIG_BUSY");
        assert!(save_application_theme(&path, ApplicationTheme::Dayfox).is_err());
        drop(lease);
        fs::write(&path, "# another user edit\n").unwrap();
        assert_eq!(
            set(&path, &change, false).unwrap_err().code,
            "CONFIG_CONFLICT"
        );
        save_application_theme(&path, ApplicationTheme::Dayfox).unwrap();
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("# another user edit")
        );
        fs::write(&path, "theme = 'invalid'\n").unwrap();
        assert_eq!(get(&path).unwrap_err().code, "CONFIG_INVALID");
        assert!(save_application_font_family(&path, "serif").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "theme = 'invalid'\n");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_config_and_parent_symlinks_without_overwriting_targets() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.toml");
        let link = temp.path().join("config.toml");
        fs::write(&target, "# preserved\n").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(get(&link).unwrap_err().code, "UNSAFE_PATH");
        assert!(save_application_theme(&link, ApplicationTheme::Dayfox).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "# preserved\n");
    }
}
