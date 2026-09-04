use serde::Serialize;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::{Arc, Mutex};
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

#[derive(Clone, Default)]
struct NormalModeImeGuardState {
    value: Arc<Mutex<NormalModeImeGuardValue>>,
}

#[derive(Default)]
struct NormalModeImeGuardValue {
    generation: u64,
    active: bool,
}

impl NormalModeImeGuardState {
    fn update(&self, generation: u64, active: bool) {
        let mut value = self.value.lock().unwrap_or_else(|error| error.into_inner());
        if generation < value.generation {
            return;
        }
        value.generation = generation;
        value.active = active;
    }

    fn active(&self) -> bool {
        self.value
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
    }
}

#[tauri::command]
fn set_normal_mode_ime_guard(
    active: bool,
    generation: u64,
    state: tauri::State<'_, NormalModeImeGuardState>,
) {
    state.update(generation, active);
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
fn enable_linux_input_method_support(app: &tauri::App) -> tauri::Result<()> {
    use gtk::prelude::WidgetExt;
    use std::{cell::RefCell, rc::Rc, time::Duration};
    use webkit2gtk::{InputMethodContextExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let guard = app.state::<NormalModeImeGuardState>().inner().clone();
    window.with_webview(move |webview| {
        let webview = webview.inner();
        let input_context = webview.input_method_context();
        if let Some(input_context) = input_context.as_ref() {
            // Wry disables WebKitGTK preedit by default so Fcitx can draw the
            // composing text in its candidate window. That fallback is not
            // reliable in native-Wayland AppImages: composition is accepted,
            // but the in-progress text can remain completely invisible.
            // Memoka edits through contenteditable, so let WebKit render the
            // preedit range in the document like the development runtime.
            input_context.set_enable_preedit(true);
        }

        // WebKitGTK reports the first key handled by an active IME as
        // `Unidentified`, so the editor cannot recover whether the user typed
        // `i`, `u`, `g`, and so on. Observe the untranslated GDK event before
        // WebKit's class handler. While the focused editor is in Normal mode,
        // hold the event, deactivate Fcitx, then put the exact same event back
        // on the GTK queue. This preserves the user's keyboard layout and lets
        // WebKit deliver the original key as an ordinary Vim command.
        let controller = Rc::new(RefCell::new(None::<gio::DBusProxy>));
        let replayed = Rc::new(RefCell::new(None::<(u32, u16, u32)>));
        webview.connect_key_press_event(move |_webview, event| {
            let signature = (event.time(), event.hardware_keycode(), *event.keyval());
            if replayed.borrow().as_ref() == Some(&signature) {
                *replayed.borrow_mut() = None;
                return gtk::glib::Propagation::Proceed;
            }
            if event.is_modifier() || !guard.active() {
                return gtk::glib::Propagation::Proceed;
            }

            let proxy = {
                let mut slot = controller.borrow_mut();
                if slot.is_none() {
                    *slot = linux_fcitx_controller_proxy().ok();
                }
                slot.clone()
            };
            let Some(proxy) = proxy else {
                return gtk::glib::Propagation::Proceed;
            };
            let state = match linux_fcitx_state(&proxy) {
                Ok(state) => state,
                Err(()) => {
                    *controller.borrow_mut() = None;
                    return gtk::glib::Propagation::Proceed;
                }
            };
            if state != 2 {
                return gtk::glib::Propagation::Proceed;
            }
            if linux_fcitx_deactivate(&proxy).is_err() {
                *controller.borrow_mut() = None;
                return gtk::glib::Propagation::Proceed;
            }

            if let Some(input_context) = input_context.as_ref() {
                input_context.reset();
            }
            let replay_event = event.clone();
            let replayed = Rc::clone(&replayed);
            gtk::glib::timeout_add_local_once(Duration::from_millis(1), move || {
                *replayed.borrow_mut() = Some(signature);
                replay_event.put();
            });
            gtk::glib::Propagation::Stop
        });
    })
}

#[cfg(target_os = "linux")]
fn linux_fcitx_controller_proxy() -> Result<gio::DBusProxy, ()> {
    gio::DBusProxy::for_bus_sync(
        gio::BusType::Session,
        gio::DBusProxyFlags::DO_NOT_LOAD_PROPERTIES | gio::DBusProxyFlags::DO_NOT_AUTO_START,
        None,
        "org.fcitx.Fcitx5",
        "/controller",
        "org.fcitx.Fcitx.Controller1",
        gio::Cancellable::NONE,
    )
    .map_err(|_| ())
}

#[cfg(target_os = "linux")]
fn linux_fcitx_state(proxy: &gio::DBusProxy) -> Result<i32, ()> {
    use gio::prelude::DBusProxyExt;

    proxy
        .call_sync(
            "State",
            None,
            gio::DBusCallFlags::NONE,
            25,
            gio::Cancellable::NONE,
        )
        .map_err(|_| ())?
        .get::<(i32,)>()
        .map(|(state,)| state)
        .ok_or(())
}

#[cfg(target_os = "linux")]
fn linux_fcitx_deactivate(proxy: &gio::DBusProxy) -> Result<(), ()> {
    use gio::prelude::DBusProxyExt;

    proxy
        .call_sync(
            "Deactivate",
            None,
            gio::DBusCallFlags::NONE,
            25,
            gio::Cancellable::NONE,
        )
        .map(|_| ())
        .map_err(|_| ())
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
        .manage(NormalModeImeGuardState::default())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            enable_linux_input_method_support(app)?;
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
        set_normal_mode_ime_guard,
        input_method_environment,
        application_config::application_key_config_load,
        application_config::application_theme_save,
        application_config::application_font_family_save,
        application_config::application_zoom_percent_save,
        application_config::application_note_max_width_px_save,
        application_config::application_line_number_min_width_px_save,
        application_config::application_indent_width_px_save,
        application_config::application_japanese_word_segmentation_save,
        application_config::application_japanese_line_break_segmentation_save,
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
        portable_mirror::portable_mirror_status,
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
    use super::{
        NormalModeImeGuardState, classify_fcitx_deactivation, linux_input_method_environment,
    };

    #[test]
    fn keeps_the_newest_normal_mode_ime_guard_update() {
        let state = NormalModeImeGuardState::default();
        state.update(2, true);
        state.update(1, false);
        assert!(state.active());

        state.update(3, false);
        assert!(!state.active());
    }

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
