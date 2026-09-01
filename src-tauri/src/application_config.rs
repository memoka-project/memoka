use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Manager};
use toml_edit::{Document, value};

const DEFAULT_APPLICATION_THEME: ApplicationTheme = ApplicationTheme::Nightfox;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ApplicationTheme {
    Nightfox,
    Dayfox,
    Dawnfox,
    Duskfox,
    Nordfox,
    Terafox,
    Carbonfox,
}

impl ApplicationTheme {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "nightfox" => Some(Self::Nightfox),
            "dayfox" => Some(Self::Dayfox),
            "dawnfox" => Some(Self::Dawnfox),
            "duskfox" => Some(Self::Duskfox),
            "nordfox" => Some(Self::Nordfox),
            "terafox" => Some(Self::Terafox),
            "carbonfox" => Some(Self::Carbonfox),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Nightfox => "nightfox",
            Self::Dayfox => "dayfox",
            Self::Dawnfox => "dawnfox",
            Self::Duskfox => "duskfox",
            Self::Nordfox => "nordfox",
            Self::Terafox => "terafox",
            Self::Carbonfox => "carbonfox",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationConfigFile {
    theme: Option<ApplicationTheme>,
    leader: Option<String>,
    keymap: Option<KeymapConfigFile>,
    shutdown: Option<ShutdownConfigFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeymapConfigFile {
    shared_navigation: Option<BTreeMap<String, Vec<String>>>,
    tree_normal: Option<BTreeMap<String, Vec<String>>>,
    visual_char: Option<BTreeMap<String, Vec<String>>>,
    table: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShutdownConfigFile {
    wait_for_mirror: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationKeyConfigOverride {
    leader_key: Option<String>,
    shared_navigation_bindings: Option<BTreeMap<String, Vec<String>>>,
    tree_bindings: Option<BTreeMap<String, Vec<String>>>,
    inline_format_bindings: Option<BTreeMap<String, Vec<String>>>,
    table_bindings: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationKeyConfigLoadResult {
    config_path: String,
    config: Option<ApplicationKeyConfigOverride>,
    theme: ApplicationTheme,
    wait_for_mirror_on_exit: bool,
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
                theme: DEFAULT_APPLICATION_THEME,
                wait_for_mirror_on_exit: true,
                warning: Some(format!(
                    "config.toml: 設定ディレクトリを取得できません: {error}"
                )),
            };
        }
    };
    load_application_key_config(&path)
}

#[tauri::command]
pub fn application_theme_save(app: AppHandle, theme: String) -> Result<(), String> {
    let theme = ApplicationTheme::parse(&theme)
        .ok_or_else(|| format!("未対応のカラーテーマです: {theme}"))?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("設定ディレクトリを取得できません: {error}"))?;
    save_application_theme(&directory.join("config.toml"), theme)
}

fn load_application_key_config(path: &Path) -> ApplicationKeyConfigLoadResult {
    let config_path = path.display().to_string();
    if !path.exists() {
        return ApplicationKeyConfigLoadResult {
            config_path,
            config: None,
            theme: DEFAULT_APPLICATION_THEME,
            wait_for_mirror_on_exit: true,
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
    let wait_for_mirror_on_exit = parsed
        .shutdown
        .as_ref()
        .and_then(|shutdown| shutdown.wait_for_mirror)
        .unwrap_or(true);
    let theme = parsed.theme.unwrap_or(DEFAULT_APPLICATION_THEME);
    let keymap = parsed.keymap;
    ApplicationKeyConfigLoadResult {
        config_path,
        config: Some(ApplicationKeyConfigOverride {
            leader_key: parsed.leader,
            shared_navigation_bindings: keymap
                .as_ref()
                .and_then(|value| value.shared_navigation.clone()),
            tree_bindings: keymap.as_ref().and_then(|value| value.tree_normal.clone()),
            inline_format_bindings: keymap.as_ref().and_then(|value| value.visual_char.clone()),
            table_bindings: keymap.and_then(|value| value.table),
        }),
        theme,
        wait_for_mirror_on_exit,
        warning: None,
    }
}

fn save_application_theme(path: &Path, theme: ApplicationTheme) -> Result<(), String> {
    let source = if path.exists() {
        fs::read_to_string(path)
            .map_err(|error| format!("{}: 設定を読み込めません: {error}", path.display()))?
    } else {
        String::new()
    };
    if !source.trim().is_empty() {
        toml::from_str::<ApplicationConfigFile>(&source).map_err(|error| {
            format!(
                "{}: 既存設定が不正なためテーマを保存できません: {error}",
                path.display()
            )
        })?;
    }
    let mut document = source
        .parse::<Document>()
        .map_err(|error| format!("{}: 既存設定を編集できません: {error}", path.display()))?;
    document["theme"] = value(theme.as_str());
    let mut output = document.to_string();
    if !output.ends_with('\n') {
        output.push('\n');
    }
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "{}: 設定ディレクトリを作成できません: {error}",
                directory.display()
            )
        })?;
    }
    let staging = path.with_extension("toml.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&staging)
        .map_err(|error| format!("{}: 一時設定を書き込めません: {error}", staging.display()))?;
    file.write_all(output.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("{}: 設定を確定できません: {error}", staging.display()))?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("{}: 旧設定を置換できません: {error}", path.display()))?;
    }
    fs::rename(&staging, path)
        .map_err(|error| format!("{}: 設定ファイルを公開できません: {error}", path.display()))?;
    Ok(())
}

fn warning_result(path: &Path, detail: String) -> ApplicationKeyConfigLoadResult {
    ApplicationKeyConfigLoadResult {
        config_path: path.display().to_string(),
        config: None,
        theme: DEFAULT_APPLICATION_THEME,
        wait_for_mirror_on_exit: true,
        warning: Some(format!(
            "{}: {detail}; 既定キー設定を使用します",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{ApplicationTheme, load_application_key_config, save_application_theme};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn loads_partial_key_configuration_without_creating_the_file() {
        let directory = tempdir().expect("tempdir");
        let missing = directory.path().join("config.toml");
        let absent = load_application_key_config(&missing);
        assert!(absent.config.is_none());
        assert_eq!(absent.theme, ApplicationTheme::Nightfox);
        assert!(absent.warning.is_none());
        assert!(!missing.exists());

        fs::write(
            &missing,
            r#"
leader = ";"
theme = "duskfox"

[keymap.shared_navigation]
"cursor.logical-up" = ["w"]

[keymap.tree_normal]
"note.create_child" = ["C"]

[keymap.visual_char]
"selection.format" = ["M"]

[keymap.table]
"table.action_picker" = ["Leader A"]
"mode.visual-block" = ["Ctrl+v"]

[shutdown]
wait_for_mirror = false
"#,
        )
        .expect("write fixture");
        let loaded = load_application_key_config(&missing);
        let config = loaded.config.expect("config");
        assert_eq!(config.leader_key.as_deref(), Some(";"));
        assert_eq!(loaded.theme, ApplicationTheme::Duskfox);
        assert_eq!(
            config
                .shared_navigation_bindings
                .expect("shared")
                .get("cursor.logical-up"),
            Some(&vec!["w".to_owned()])
        );
        assert_eq!(
            config
                .table_bindings
                .expect("table")
                .get("table.action_picker"),
            Some(&vec!["Leader A".to_owned()])
        );
        assert_eq!(
            config
                .inline_format_bindings
                .expect("visual char")
                .get("selection.format"),
            Some(&vec!["M".to_owned()])
        );
        assert!(!loaded.wait_for_mirror_on_exit);
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn updates_only_the_theme_and_preserves_comments_and_other_settings() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("config.toml");
        fs::write(
            &path,
            r#"# personal config
leader = ";"

[shutdown]
wait_for_mirror = false
"#,
        )
        .expect("write fixture");

        save_application_theme(&path, ApplicationTheme::Dayfox).expect("save theme");
        let updated = fs::read_to_string(&path).expect("read updated config");
        assert!(updated.contains("# personal config"));
        assert!(updated.contains("leader = \";\""));
        assert!(updated.contains("wait_for_mirror = false"));
        assert!(updated.contains("theme = \"dayfox\""));
        let loaded = load_application_key_config(&path);
        assert_eq!(loaded.theme, ApplicationTheme::Dayfox);
        assert!(!loaded.wait_for_mirror_on_exit);
    }

    #[test]
    fn refuses_to_overwrite_invalid_existing_configuration() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("config.toml");
        let invalid = "theme = \"unknownfox\"\n";
        fs::write(&path, invalid).expect("write invalid fixture");

        let error = save_application_theme(&path, ApplicationTheme::Nightfox)
            .expect_err("invalid config must be preserved");
        assert!(error.contains("既存設定が不正"));
        assert_eq!(fs::read_to_string(path).expect("read fixture"), invalid);
    }

    #[test]
    fn rejects_the_entire_file_when_toml_contains_unknown_fields() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("config.toml");
        fs::write(&path, "unknown = true\n").expect("write fixture");
        let loaded = load_application_key_config(&path);
        assert!(loaded.config.is_none());
        assert!(loaded.wait_for_mirror_on_exit);
        assert!(
            loaded
                .warning
                .expect("warning")
                .contains(&path.display().to_string())
        );
    }
}
