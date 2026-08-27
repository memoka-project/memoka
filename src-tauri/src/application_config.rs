use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationConfigFile {
    leader: Option<String>,
    keymap: Option<KeymapConfigFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeymapConfigFile {
    shared_navigation: Option<BTreeMap<String, Vec<String>>>,
    tree_normal: Option<BTreeMap<String, Vec<String>>>,
    visual_char: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationKeyConfigOverride {
    leader_key: Option<String>,
    shared_navigation_bindings: Option<BTreeMap<String, Vec<String>>>,
    tree_bindings: Option<BTreeMap<String, Vec<String>>>,
    inline_format_bindings: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationKeyConfigLoadResult {
    config_path: String,
    config: Option<ApplicationKeyConfigOverride>,
    warning: Option<String>,
}

#[tauri::command]
pub fn application_key_config_load(app: AppHandle) -> ApplicationKeyConfigLoadResult {
    let path = match app.path().app_config_dir() {
        Ok(directory) => directory.join("config.toml"),
        Err(error) => {
            return ApplicationKeyConfigLoadResult {
                config_path: "config.toml".to_owned(),
                config: None,
                warning: Some(format!(
                    "config.toml: 設定ディレクトリを取得できません: {error}"
                )),
            };
        }
    };
    load_application_key_config(&path)
}

fn load_application_key_config(path: &Path) -> ApplicationKeyConfigLoadResult {
    let config_path = path.display().to_string();
    if !path.exists() {
        return ApplicationKeyConfigLoadResult {
            config_path,
            config: None,
            warning: None,
        };
    }
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            return warning_result(path, format!("設定を読み込めません: {error}"));
        }
    };
    let parsed = match toml::from_str::<ApplicationConfigFile>(&source) {
        Ok(parsed) => parsed,
        Err(error) => {
            return warning_result(path, format!("TOMLを解釈できません: {error}"));
        }
    };
    let keymap = parsed.keymap;
    ApplicationKeyConfigLoadResult {
        config_path,
        config: Some(ApplicationKeyConfigOverride {
            leader_key: parsed.leader,
            shared_navigation_bindings: keymap
                .as_ref()
                .and_then(|value| value.shared_navigation.clone()),
            tree_bindings: keymap.as_ref().and_then(|value| value.tree_normal.clone()),
            inline_format_bindings: keymap.and_then(|value| value.visual_char),
        }),
        warning: None,
    }
}

fn warning_result(path: &Path, detail: String) -> ApplicationKeyConfigLoadResult {
    ApplicationKeyConfigLoadResult {
        config_path: path.display().to_string(),
        config: None,
        warning: Some(format!(
            "{}: {detail}; 既定キー設定を使用します",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::load_application_key_config;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn loads_partial_key_configuration_without_creating_the_file() {
        let directory = tempdir().expect("tempdir");
        let missing = directory.path().join("config.toml");
        let absent = load_application_key_config(&missing);
        assert!(absent.config.is_none());
        assert!(absent.warning.is_none());
        assert!(!missing.exists());

        fs::write(
            &missing,
            r#"
leader = ";"

[keymap.shared_navigation]
"cursor.logical-up" = ["w"]

[keymap.tree_normal]
"note.create_child" = ["C"]

[keymap.visual_char]
"selection.format" = ["M"]
"#,
        )
        .expect("write fixture");
        let loaded = load_application_key_config(&missing);
        let config = loaded.config.expect("config");
        assert_eq!(config.leader_key.as_deref(), Some(";"));
        assert_eq!(
            config
                .shared_navigation_bindings
                .expect("shared")
                .get("cursor.logical-up"),
            Some(&vec!["w".to_owned()])
        );
        assert_eq!(
            config
                .inline_format_bindings
                .expect("visual char")
                .get("selection.format"),
            Some(&vec!["M".to_owned()])
        );
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn rejects_the_entire_file_when_toml_contains_unknown_fields() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("config.toml");
        fs::write(&path, "unknown = true\n").expect("write fixture");
        let loaded = load_application_key_config(&path);
        assert!(loaded.config.is_none());
        assert!(
            loaded
                .warning
                .expect("warning")
                .contains(&path.display().to_string())
        );
    }
}
