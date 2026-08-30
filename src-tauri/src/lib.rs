use serde::Serialize;
#[cfg(target_os = "linux")]
use std::process::Command;
use tauri::Manager;

mod application_config;
mod attachment;
mod clipboard;
mod data_area;
mod diagnostics;
mod persistence;
pub mod portable_mirror;
mod search_index;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InputMethodDeactivation {
    supported: bool,
    inactive: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InputMethodEnvironment {
    supported: bool,
    stable_route: bool,
    gtk_im_module: Option<String>,
    detail: String,
}

#[tauri::command]
async fn deactivate_input_method() -> InputMethodDeactivation {
    #[cfg(target_os = "linux")]
    {
        match tauri::async_runtime::spawn_blocking(linux_deactivate_input_method).await {
            Ok(result) => result,
            Err(error) => InputMethodDeactivation {
                supported: true,
                inactive: false,
                detail: format!("fcitx5-remote-task-failed:{error}"),
            },
        }
    }

    #[cfg(target_os = "windows")]
    {
        match tauri::async_runtime::spawn_blocking(windows_deactivate_input_method).await {
            Ok(result) => result,
            Err(error) => InputMethodDeactivation {
                supported: true,
                inactive: false,
                detail: format!("windows-ime-task-failed:{error}"),
            },
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        InputMethodDeactivation {
            supported: false,
            inactive: false,
            detail: "platform-adapter-not-implemented".to_owned(),
        }
    }
}

#[cfg(any(
    target_os = "windows",
    all(test, feature = "windows-clipboard-contract")
))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_deactivate_input_method() -> InputMethodDeactivation {
    use windows_sys::Win32::UI::Input::Ime::{
        ImmGetContext, ImmGetOpenStatus, ImmReleaseContext, ImmSetOpenStatus,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
    };

    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return InputMethodDeactivation {
            supported: true,
            inactive: false,
            detail: "windows-ime-no-foreground-window".to_owned(),
        };
    }
    let thread_id = unsafe { GetWindowThreadProcessId(window, std::ptr::null_mut()) };
    let mut gui_thread = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let input_window = if thread_id != 0
        && unsafe { GetGUIThreadInfo(thread_id, &mut gui_thread) } != 0
        && !gui_thread.hwndFocus.is_null()
    {
        // GetForegroundWindow returns Wry's top-level HWND, while the active
        // IMM context normally belongs to the focused WebView2 child HWND.
        gui_thread.hwndFocus
    } else {
        window
    };
    let context = unsafe { ImmGetContext(input_window) };
    if context.is_null() {
        return InputMethodDeactivation {
            supported: false,
            inactive: false,
            detail: "windows-ime-no-imm-context".to_owned(),
        };
    }
    let changed = unsafe { ImmSetOpenStatus(context, 0) } != 0;
    let inactive = unsafe { ImmGetOpenStatus(context) } == 0;
    unsafe {
        ImmReleaseContext(input_window, context);
    }
    InputMethodDeactivation {
        supported: true,
        inactive,
        detail: if inactive {
            if changed {
                "windows-ime-inactive"
            } else {
                "windows-ime-already-inactive"
            }
        } else {
            "windows-ime-deactivation-refused"
        }
        .to_owned(),
    }
}

#[cfg(target_os = "linux")]
fn linux_deactivate_input_method() -> InputMethodDeactivation {
    match Command::new("fcitx5-remote")
        .args(["--check", "-c"])
        .output()
    {
        Ok(output) => classify_fcitx_deactivation(output.status.success(), output.status.code()),
        Err(error) => InputMethodDeactivation {
            supported: false,
            inactive: false,
            detail: format!("fcitx5-remote-unavailable:{error}"),
        },
    }
}

#[cfg(target_os = "linux")]
fn classify_fcitx_deactivation(success: bool, exit_code: Option<i32>) -> InputMethodDeactivation {
    if success {
        return InputMethodDeactivation {
            supported: true,
            inactive: true,
            detail: "fcitx5-inactive".to_owned(),
        };
    }
    InputMethodDeactivation {
        supported: true,
        inactive: false,
        detail: format!("fcitx5-remote-exit:{}", exit_code.unwrap_or(-1)),
    }
}

#[tauri::command]
fn input_method_environment() -> InputMethodEnvironment {
    #[cfg(target_os = "linux")]
    {
        linux_input_method_environment(std::env::var("GTK_IM_MODULE").ok())
    }

    #[cfg(target_os = "windows")]
    {
        InputMethodEnvironment {
            supported: true,
            stable_route: true,
            gtk_im_module: None,
            detail: "windows-webview2-imm32".to_owned(),
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    InputMethodEnvironment {
        supported: false,
        stable_route: false,
        gtk_im_module: None,
        detail: "platform-route-not-inspected".to_owned(),
    }
}

#[cfg(target_os = "linux")]
fn linux_input_method_environment(gtk_im_module: Option<String>) -> InputMethodEnvironment {
    let stable_route = gtk_im_module.as_deref() == Some("fcitx");
    InputMethodEnvironment {
        supported: true,
        stable_route,
        detail: if stable_route {
            "fcitx-gtk-module".to_owned()
        } else {
            "wayland-preedit-risk".to_owned()
        },
        gtk_im_module,
    }
}

#[cfg(target_os = "linux")]
fn enable_linux_input_method_preedit(app: &tauri::App) -> tauri::Result<()> {
    use webkit2gtk::{InputMethodContextExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.with_webview(|webview| {
        if let Some(input_context) = webview.inner().input_method_context() {
            // Wry disables WebKitGTK preedit by default so Fcitx can draw the
            // composing text in its candidate window. That fallback is not
            // reliable in native-Wayland AppImages: composition is accepted,
            // but the in-progress text can remain completely invisible.
            // Memoka edits through contenteditable, so let WebKit render the
            // preedit range in the document like the development runtime.
            input_context.set_enable_preedit(true);
        }
    })
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn foreground_existing_instance(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // selected-workspace.json is application-global, so every ordinary second
    // launch targets the same selected data area. Register the official
    // single-instance plugin before every other plugin to reject that process
    // before it can open SQLite/CRDT state, then foreground the owner Window.
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, _arguments, _working_directory| {
            if let Err(error) = foreground_existing_instance(app) {
                log::warn!(target: "memoka::event", "event=existing-instance-focus-failed error={error}");
            } else {
                log::info!(target: "memoka::event", "event=existing-instance-focused");
            }
        },
    ));
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    // A development build has no release signing key and must not expose a
    // half-configured updater command. Release CI supplies the public key at
    // compile time together with the complete plugin configuration.
    let builder = match option_env!("MEMOKA_UPDATER_PUBLIC_KEY") {
        Some(public_key) if !public_key.trim().is_empty() => builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(public_key)
                .build(),
        ),
        _ => builder,
    };
    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .filter(|metadata| metadata.target().starts_with("memoka"))
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "linux")]
            enable_linux_input_method_preedit(app)?;
            log::info!(target: "memoka::event", "event=application-started");
            Ok(())
        })
        .manage(persistence::ProductPersistenceState::default())
        .manage(portable_mirror::PortableMirrorOperationState::default())
        .register_uri_scheme_protocol("memoka-attachment", |context, request| {
            attachment::attachment_protocol_response(context.app_handle(), request.uri().path())
        });
    let builder = builder.invoke_handler(tauri::generate_handler![
        deactivate_input_method,
        input_method_environment,
        application_config::application_key_config_load,
        clipboard::clipboard_write_rich,
        clipboard::clipboard_read_preferred,
        clipboard::clipboard_read_explicit,
        data_area::data_area_status,
        data_area::data_area_activate,
        diagnostics::application_diagnostics_info,
        diagnostics::application_diagnostics_record,
        attachment::attachment_batch_begin,
        attachment::attachment_batch_write_chunk,
        attachment::attachment_batch_commit,
        attachment::attachment_batch_cancel,
        attachment::attachment_import_native_paths,
        attachment::attachment_resolve,
        attachment::attachment_open,
        attachment::attachment_copy_files,
        persistence::persistence_manifest,
        persistence::persistence_commit,
        persistence::persistence_compact,
        persistence::persistence_load_document,
        persistence::persistence_load_local_states,
        persistence::workspace_search_index_rebuild,
        persistence::workspace_search_index_replace_document,
        persistence::workspace_search_index_update_hierarchy,
        persistence::workspace_search_index_query,
        portable_mirror::portable_mirror_list_attachments,
        portable_mirror::portable_mirror_begin,
        portable_mirror::portable_mirror_write_chunk,
        portable_mirror::portable_mirror_commit,
        portable_mirror::portable_mirror_cancel
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running Memoka");
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{classify_fcitx_deactivation, linux_input_method_environment};

    #[test]
    fn reports_a_successful_fcitx_deactivation() {
        let result = classify_fcitx_deactivation(true, Some(0));
        assert!(result.supported);
        assert!(result.inactive);
        assert_eq!(result.detail, "fcitx5-inactive");
    }

    #[test]
    fn reports_a_failed_fcitx_deactivation_without_claiming_inactive() {
        let result = classify_fcitx_deactivation(false, Some(7));
        assert!(result.supported);
        assert!(!result.inactive);
        assert_eq!(result.detail, "fcitx5-remote-exit:7");
    }

    #[test]
    fn marks_fcitx_gtk_module_as_the_stable_gnome_route() {
        let environment = linux_input_method_environment(Some("fcitx".to_owned()));
        assert!(environment.supported);
        assert!(environment.stable_route);
        assert_eq!(environment.detail, "fcitx-gtk-module");
    }

    #[test]
    fn warns_when_wayland_text_input_can_reintroduce_preedit_corruption() {
        let environment = linux_input_method_environment(None);
        assert!(environment.supported);
        assert!(!environment.stable_route);
        assert_eq!(environment.detail, "wayland-preedit-risk");
    }
}
