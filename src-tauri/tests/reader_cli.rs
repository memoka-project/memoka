use memoka_desktop::{
    document_model::ReadError,
    native_service::NativeService,
    read_service::hash_file,
    workspace_owner::{Server, WorkspaceLease},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs,
    process::{Command, Output},
    sync::Arc,
};

fn fixture() -> tempfile::TempDir {
    let workspace = tempfile::tempdir().unwrap();
    let internal = workspace.path().join(".memoka");
    fs::create_dir(&internal).unwrap();
    fs::write(
        internal.join("data-area.json"),
        br#"{"schemaVersion":1,"kind":"memoka-data-area"}"#,
    )
    .unwrap();
    let db = Connection::open(internal.join("memoka.sqlite3")).unwrap();
    db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE documents(kind TEXT,document_id TEXT,schema_version INTEGER,revision INTEGER,snapshot_revision INTEGER,snapshot BLOB,PRIMARY KEY(kind,document_id));
        CREATE TABLE document_updates(kind TEXT,document_id TEXT,revision INTEGER,update_blob BLOB);
        CREATE TABLE attachments(attachment_id TEXT,sha256 TEXT,size INTEGER,original_filename TEXT,mime_type TEXT,created_at TEXT,known_missing INTEGER);").unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/reader-contract.json")).unwrap();
    for doc in fixture["documents"].as_array().unwrap() {
        let bytes = doc["snapshot"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        db.execute(
            "INSERT INTO documents VALUES (?1,?2,?3,7,7,?4)",
            params![
                doc["kind"].as_str(),
                doc["document_id"].as_str(),
                doc["schema_version"].as_i64(),
                bytes
            ],
        )
        .unwrap();
        if doc["kind"] == "workspace" {
            db.execute(
                "INSERT INTO settings VALUES ('active_workspace_id',?1)",
                [doc["document_id"].as_str().unwrap()],
            )
            .unwrap();
        }
    }
    db.execute_batch(
        "INSERT INTO settings VALUES ('database_schema_version','5'),('content_epoch','3');",
    )
    .unwrap();
    workspace
}
fn cli(workspace: &std::path::Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_memoka-cli"))
        .args(arguments)
        .arg("--workspace")
        .arg(workspace)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .output()
        .unwrap()
}
#[cfg(target_os = "linux")]
#[test]
fn unconfigured_cloud_cli_is_headless_workspace_free_and_needs_no_sidecar() {
    let temp = tempfile::tempdir().unwrap();
    let installation = temp.path().join("installation 日本語 with spaces");
    fs::create_dir(&installation).unwrap();
    let executable = installation.join("memoka-cli");
    fs::copy(env!("CARGO_BIN_EXE_memoka-cli"), &executable).unwrap();
    let config = temp.path().join("isolated-config");
    let output = Command::new(executable)
        .args(["cloud", "list", "--format", "json"])
        .env("XDG_CONFIG_HOME", &config)
        .env(
            "MEMOKA_GOOGLE_OAUTH_CLIENT_FILE",
            temp.path().join("missing-client.json"),
        )
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema_version"], 3);
    assert_eq!(value["configured"], false);
    assert_eq!(value["connections"], json!([]));
    assert!(!config.exists());
    assert!(!installation.join("rclone").exists());
    assert!(!installation.join("restic").exists());
}
#[test]
fn current_read_is_headless_and_does_not_migrate_initialize_or_sync_help() {
    let workspace = fixture();
    let database = workspace.path().join(".memoka/memoka.sqlite3");
    let before = hash_file(&database).unwrap();
    let read = cli(
        workspace.path(),
        &[
            "read",
            "--id",
            "01a30000-0000-7000-8000-000000000002",
            "--format",
            "markdown",
        ],
    );
    assert!(
        read.status.success(),
        "{}",
        String::from_utf8_lossy(&read.stderr)
    );
    let markdown = String::from_utf8(read.stdout).unwrap();
    assert!(markdown.starts_with("# 読み出し"), "{markdown}");
    for syntax in ["**", "~~", "==", "[!WARNING]-", "|", "memoka://workspace/"] {
        assert!(markdown.contains(syntax), "missing {syntax}: {markdown}");
    }
    let tree = cli(workspace.path(), &["tree", "--format", "json"]);
    assert!(tree.status.success());
    let tree: Value = serde_json::from_slice(&tree.stdout).unwrap();
    assert_eq!(tree["schema_version"], 1);
    assert_eq!(tree["total"], 1);
    let search = cli(
        workspace.path(),
        &["search", "子", "--format", "json", "--limit", "1"],
    );
    assert!(search.status.success());
    assert_eq!(hash_file(&database).unwrap(), before);
    assert!(!workspace.path().join(".memoka-backups").exists());
    assert!(!workspace.path().join(".memoka/history-cache").exists());
}
#[test]
fn search_uses_body_logical_rows_unicode_and_query_bound_cursors() {
    let workspace = fixture();
    // Contract shared with workspace-search.test.ts: headings don't consume
    // body rows, nested Items are separate and a table row joins its cells.
    for (query, text, number, offset) in [
        ("親", "親", 3, 0),
        ("子", "子", 4, 0),
        ("注意", "注意", 5, 0),
        ("```", "```", 7, 12),
        ("見出し 右", "見出し | 右", 9, 0),
        ("太字 値", "太字 | 値|1", 10, 0),
        ("一致語", "本文 一致語", 12, 0),
        ("ＥＸＴＥＲＮＡＬ", "external", 2, 28),
    ] {
        let output = cli(workspace.path(), &["search", query, "--format", "json"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        let row = value["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "body" && row["text"] == text)
            .unwrap();
        assert_eq!(row["logical_line_number"], number);
        assert_eq!(row["source_offset"], offset);
    }
    let page: Value = serde_json::from_slice(
        &cli(
            workspace.path(),
            &["search", "子", "--limit", "1", "--format", "json"],
        )
        .stdout,
    )
    .unwrap();
    assert!(page["items"][0]["logical_line_number"].is_null());
    let cursor = page["next_cursor"].as_str().unwrap();
    let next = cli(
        workspace.path(),
        &[
            "search", "子", "--cursor", cursor, "--limit", "1", "--format", "json",
        ],
    );
    assert!(next.status.success());
    let stale = cli(
        workspace.path(),
        &["search", "親", "--cursor", cursor, "--format", "json"],
    );
    assert!(!stale.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&stale.stderr).unwrap()["code"],
        "CURSOR_STALE"
    );
}

#[test]
fn cli_uses_owner_and_does_not_fallback_after_a_barrier_failure() {
    let workspace = fixture();
    let lease = WorkspaceLease::acquire(workspace.path()).unwrap();
    let service = Arc::new(NativeService::new(workspace.path().into()));
    let server = Server::start(
        lease.clone(),
        Arc::new(move |request| service.query(request)),
    )
    .unwrap();
    let result = cli(workspace.path(), &["tree", "--format", "json"]);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    drop(server);
    let server = Server::start(
        lease,
        Arc::new(|_| {
            Err(ReadError::new(
                "SAVE_BARRIER_TIMEOUT",
                "fixture barrier timeout",
            ))
        }),
    )
    .unwrap();
    let result = cli(workspace.path(), &["tree", "--format", "json"]);
    assert_eq!(result.status.code(), Some(6));
    assert!(result.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stderr).unwrap()["code"],
        "SAVE_BARRIER_TIMEOUT"
    );
    drop(server);
}
#[test]
fn old_schema_is_refused_without_modification() {
    let workspace = fixture();
    let path = workspace.path().join(".memoka/memoka.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE settings SET value='4' WHERE key='database_schema_version'",
        [],
    )
    .unwrap();
    drop(db);
    let before = hash_file(&path).unwrap();
    let output = cli(workspace.path(), &["tree"]);
    assert_eq!(output.status.code(), Some(5));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["code"],
        json!("MIGRATION_REQUIRED")
    );
    assert_eq!(hash_file(&path).unwrap(), before);
}
