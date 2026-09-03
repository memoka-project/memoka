use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Manager};
use toml_edit::{Document, value};

const DEFAULT_APPLICATION_THEME: ApplicationTheme = ApplicationTheme::Nightfox;
const DEFAULT_APPLICATION_FONT_FAMILY: &str =
    r#"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif"#;
const DEFAULT_APPLICATION_ZOOM_PERCENT: u16 = 100;
const MIN_APPLICATION_ZOOM_PERCENT: u16 = 50;
const MAX_APPLICATION_ZOOM_PERCENT: u16 = 200;
const APPLICATION_ZOOM_STEP_PERCENT: u16 = 10;

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
    font_family: Option<String>,
    zoom_percent: Option<u16>,
    leader: Option<String>,
    vim: Option<VimConfigFile>,
    keymap: Option<KeymapConfigFile>,
    shutdown: Option<ShutdownConfigFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VimConfigFile {
    whichwrap: Option<bool>,
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
    whichwrap: Option<bool>,
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
    font_family: String,
    zoom_percent: u16,
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
                font_family: DEFAULT_APPLICATION_FONT_FAMILY.to_owned(),
                zoom_percent: DEFAULT_APPLICATION_ZOOM_PERCENT,
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

#[tauri::command]
pub fn application_font_family_save(app: AppHandle, font_family: String) -> Result<(), String> {
    let font_family = validate_application_font_family(&font_family)?.to_owned();
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("設定ディレクトリを取得できません: {error}"))?;
    save_application_font_family(&directory.join("config.toml"), &font_family)
}

#[tauri::command]
pub fn application_zoom_percent_save(app: AppHandle, zoom_percent: u16) -> Result<(), String> {
    validate_application_zoom_percent(zoom_percent)?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("設定ディレクトリを取得できません: {error}"))?;
    save_application_zoom_percent(&directory.join("config.toml"), zoom_percent)
}

fn load_application_key_config(path: &Path) -> ApplicationKeyConfigLoadResult {
    let config_path = path.display().to_string();
    if !path.exists() {
        return ApplicationKeyConfigLoadResult {
            config_path,
            config: None,
            theme: DEFAULT_APPLICATION_THEME,
            font_family: DEFAULT_APPLICATION_FONT_FAMILY.to_owned(),
            zoom_percent: DEFAULT_APPLICATION_ZOOM_PERCENT,
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
    let font_family = match parsed.font_family.as_deref() {
        Some(value) => match validate_application_font_family(value) {
            Ok(value) => value.to_owned(),
            Err(error) => return warning_result(path, error),
        },
        None => DEFAULT_APPLICATION_FONT_FAMILY.to_owned(),
    };
    let zoom_percent = parsed
        .zoom_percent
        .unwrap_or(DEFAULT_APPLICATION_ZOOM_PERCENT);
    if let Err(error) = validate_application_zoom_percent(zoom_percent) {
        return warning_result(path, error);
    }
    let keymap = parsed.keymap;
    ApplicationKeyConfigLoadResult {
        config_path,
        config: Some(ApplicationKeyConfigOverride {
            leader_key: parsed.leader,
            whichwrap: parsed.vim.and_then(|value| value.whichwrap),
            shared_navigation_bindings: keymap
                .as_ref()
                .and_then(|value| value.shared_navigation.clone()),
            tree_bindings: keymap.as_ref().and_then(|value| value.tree_normal.clone()),
            inline_format_bindings: keymap.as_ref().and_then(|value| value.visual_char.clone()),
            table_bindings: keymap.and_then(|value| value.table),
        }),
        theme,
        font_family,
        zoom_percent,
        wait_for_mirror_on_exit,
        warning: None,
    }
}

fn save_application_theme(path: &Path, theme: ApplicationTheme) -> Result<(), String> {
    update_application_config(path, |document| {
        document["theme"] = value(theme.as_str());
    })
}

fn save_application_font_family(path: &Path, font_family: &str) -> Result<(), String> {
    update_application_config(path, |document| {
        document["font_family"] = value(font_family);
    })
}

fn save_application_zoom_percent(path: &Path, zoom_percent: u16) -> Result<(), String> {
    update_application_config(path, |document| {
        document["zoom_percent"] = value(i64::from(zoom_percent));
    })
}

fn update_application_config(
    path: &Path,
    update: impl FnOnce(&mut Document),
) -> Result<(), String> {
    let source = if path.exists() {
        fs::read_to_string(path)
            .map_err(|error| format!("{}: 設定を読み込めません: {error}", path.display()))?
    } else {
        String::new()
    };
    if !source.trim().is_empty() {
        toml::from_str::<ApplicationConfigFile>(&source).map_err(|error| {
            format!(
                "{}: 既存設定が不正なため設定を保存できません: {error}",
                path.display()
            )
        })?;
    }
    let mut document = source
        .parse::<Document>()
        .map_err(|error| format!("{}: 既存設定を編集できません: {error}", path.display()))?;
    update(&mut document);
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

fn validate_application_font_family(value: &str) -> Result<&str, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 256
        || normalized
            .chars()
            .any(|character| character.is_control() || matches!(character, ';' | '{' | '}'))
    {
        return Err("font_familyは1〜256文字の有効なCSS font-familyで指定してください".to_owned());
    }
    Ok(normalized)
}

fn validate_application_zoom_percent(value: u16) -> Result<(), String> {
    if !(MIN_APPLICATION_ZOOM_PERCENT..=MAX_APPLICATION_ZOOM_PERCENT).contains(&value)
        || value % APPLICATION_ZOOM_STEP_PERCENT != 0
    {
        return Err(format!(
            "zoom_percentは{MIN_APPLICATION_ZOOM_PERCENT}〜{MAX_APPLICATION_ZOOM_PERCENT}の{APPLICATION_ZOOM_STEP_PERCENT}%刻みで指定してください"
        ));
    }
    Ok(())
}

fn warning_result(path: &Path, detail: String) -> ApplicationKeyConfigLoadResult {
    ApplicationKeyConfigLoadResult {
        config_path: path.display().to_string(),
        config: None,
        theme: DEFAULT_APPLICATION_THEME,
        font_family: DEFAULT_APPLICATION_FONT_FAMILY.to_owned(),
        zoom_percent: DEFAULT_APPLICATION_ZOOM_PERCENT,
        wait_for_mirror_on_exit: true,
        warning: Some(format!(
            "{}: {detail}; 既定設定を使用します",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ApplicationTheme, DEFAULT_APPLICATION_FONT_FAMILY, DEFAULT_APPLICATION_ZOOM_PERCENT,
        load_application_key_config, save_application_font_family, save_application_theme,
        save_application_zoom_percent,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn loads_partial_key_configuration_without_creating_the_file() {
        let directory = tempdir().expect("tempdir");
        let missing = directory.path().join("config.toml");
        let absent = load_application_key_config(&missing);
        assert!(absent.config.is_none());
        assert_eq!(absent.theme, ApplicationTheme::Nightfox);
        assert_eq!(absent.font_family, DEFAULT_APPLICATION_FONT_FAMILY);
        assert_eq!(absent.zoom_percent, DEFAULT_APPLICATION_ZOOM_PERCENT);
        assert!(absent.warning.is_none());
        assert!(!missing.exists());

        fs::write(
            &missing,
            r#"
leader = ";"
theme = "duskfox"
font_family = 'Noto Sans CJK JP, sans-serif'
zoom_percent = 120

[vim]
whichwrap = false

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
        assert_eq!(loaded.font_family, "Noto Sans CJK JP, sans-serif");
        assert_eq!(loaded.zoom_percent, 120);
        assert_eq!(config.whichwrap, Some(false));
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
    fn updates_appearance_and_preserves_comments_and_other_settings() {
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
        save_application_font_family(&path, "Noto Serif CJK JP, serif").expect("save font family");
        save_application_zoom_percent(&path, 130).expect("save zoom");
        let updated = fs::read_to_string(&path).expect("read updated config");
        assert!(updated.contains("# personal config"));
        assert!(updated.contains("leader = \";\""));
        assert!(updated.contains("wait_for_mirror = false"));
        assert!(updated.contains("theme = \"dayfox\""));
        assert!(updated.contains("font_family = \"Noto Serif CJK JP, serif\""));
        assert!(updated.contains("zoom_percent = 130"));
        let loaded = load_application_key_config(&path);
        assert_eq!(loaded.theme, ApplicationTheme::Dayfox);
        assert_eq!(loaded.font_family, "Noto Serif CJK JP, serif");
        assert_eq!(loaded.zoom_percent, 130);
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

    #[test]
    fn rejects_invalid_font_and_zoom_settings() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("config.toml");
        fs::write(&path, "font_family = \"sans-serif; color: red\"\n").expect("write invalid font");
        let invalid_font = load_application_key_config(&path);
        assert!(invalid_font.config.is_none());
        assert!(
            invalid_font
                .warning
                .expect("font warning")
                .contains("font_family")
        );

        fs::write(&path, "zoom_percent = 125\n").expect("write invalid zoom");
        let invalid_zoom = load_application_key_config(&path);
        assert!(invalid_zoom.config.is_none());
        assert!(
            invalid_zoom
                .warning
                .expect("zoom warning")
                .contains("zoom_percent")
        );
    }
}
