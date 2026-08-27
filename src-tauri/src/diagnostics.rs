use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplicationDiagnosticsInfo {
    application_version: String,
    tauri_version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    bundle_type: String,
    log_directory: String,
    updater_configured: bool,
}

#[tauri::command]
pub(crate) fn application_diagnostics_info(
    app: AppHandle,
) -> Result<ApplicationDiagnosticsInfo, String> {
    Ok(ApplicationDiagnosticsInfo {
        application_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION,
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        bundle_type: distribution_kind(),
        log_directory: app
            .path()
            .app_log_dir()
            .map_err(|error| error.to_string())?
            .display()
            .to_string(),
        updater_configured: option_env!("MEMOKA_UPDATER_PUBLIC_KEY")
            .is_some_and(|key| !key.trim().is_empty()),
    })
}

#[tauri::command]
pub(crate) fn application_diagnostics_record(event: String) -> Result<(), String> {
    let event = match event.as_str() {
        "application-ready"
        | "workspace-open-failed"
        | "update-check-started"
        | "update-available"
        | "update-not-available"
        | "update-check-failed"
        | "update-install-started"
        | "update-install-failed" => event,
        _ => return Err("unsupported diagnostic event".to_owned()),
    };
    // The command accepts an allowlisted event only. It intentionally has no
    // free-form detail parameter so note text, paths, search terms and IDs
    // cannot accidentally enter the release diagnostic log.
    log::info!(target: "memoka::event", "event={event}");
    Ok(())
}

fn distribution_kind() -> String {
    #[cfg(target_os = "windows")]
    return "windows".to_owned();
    #[cfg(target_os = "linux")]
    return if std::env::var_os("APPIMAGE").is_some() {
        "appimage".to_owned()
    } else {
        "linux".to_owned()
    };
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return std::env::consts::OS.to_owned();
}

#[cfg(test)]
mod tests {
    use super::application_diagnostics_record;

    #[test]
    fn diagnostic_events_are_a_fixed_vocabulary() {
        assert!(application_diagnostics_record("application-ready".to_owned()).is_ok());
        assert!(application_diagnostics_record("note-title=secret".to_owned()).is_err());
    }
}
