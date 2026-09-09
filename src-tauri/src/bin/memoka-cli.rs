use memoka_desktop::{cli, document_model::ReadError};

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let legacy = matches!(
        arguments.first().map(String::as_str),
        Some("verify" | "restore")
    );
    let agent = arguments
        .first()
        .is_some_and(|arg| matches!(arg.as_str(), "edit" | "note-edit" | "section-edit"))
        || arguments.iter().any(|arg| arg == "--for-edit");
    if let Err(error) = cli::install_interrupt_handler().and_then(|_| cli::run(arguments)) {
        if agent {
            println!(
                "{}",
                memoka_desktop::agent_edit::error_response(
                    error.details["request_id"].as_str(),
                    &error
                )
            );
        } else {
            eprintln!(
                "{}",
                serde_json::to_string(&error).expect("serializable diagnostic")
            );
        }
        std::process::exit(if legacy { 1 } else { exit_code(&error) });
    }
}

fn exit_code(error: &ReadError) -> i32 {
    match error.code.as_str() {
        "INVALID_ARGUMENT" => 2,
        "NOT_FOUND" | "WORKSPACE_REQUIRED" => 3,
        "IN_TRASH" => 4,
        "UNSUPPORTED_SCHEMA" | "MIGRATION_REQUIRED" | "SECTION_DEPTH_LIMIT" => 5,
        "CONFIG_BUSY"
        | "WORKSPACE_LOCKED"
        | "OWNER_UNAVAILABLE"
        | "IPC_TIMEOUT"
        | "BACKUP_BUSY"
        | "REPOSITORY_LOCKED"
        | "SAVE_BARRIER_TIMEOUT" => 6,
        "CREDENTIALS" | "CREDENTIALS_UNAVAILABLE" | "IPC_ACCESS_DENIED" => 7,
        "REPOSITORY_MISSING"
        | "REPOSITORY_MISMATCH"
        | "BACKUP_UNINITIALIZED"
        | "ADDITIONAL_OFFLINE"
        | "ADDITIONAL_UNCONFIGURED" => 8,
        "HISTORY_CORRUPT"
        | "ATTACHMENT_CORRUPT"
        | "INVALID_DATA"
        | "INCOMPLETE_GENERATION"
        | "RESTIC_INCOMPLETE"
        | "UNSAFE_PATH" => 9,
        "CONFIG_CONFLICT" | "CURSOR_STALE" | "REVISION_CONFLICT" | "WORKSPACE_CHANGED" => 10,
        _ => 1,
    }
}
