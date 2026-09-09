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
use yrs::updates::decoder::Decode;
use yrs::{Map, ReadTxn, StateVector, Transact};

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
    let output = Command::new(&executable)
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
    let catalog = Command::new(&executable)
        .args(["workspaces", "--format", "json"])
        .env("XDG_CONFIG_HOME", &config)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .output()
        .unwrap();
    assert!(
        catalog.status.success(),
        "{}",
        String::from_utf8_lossy(&catalog.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&catalog.stdout).unwrap()["items"],
        json!([])
    );
    assert!(!config.exists());
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
fn lock_commands_are_explicit_scoped_and_do_not_create_history_or_accept_force_flags() {
    let workspace = fixture();
    // Match ProductStore's WAL mode: history listing can update a derived
    // catalog while WorkspaceReader holds a read transaction.
    Connection::open(workspace.path().join(".memoka/memoka.sqlite3"))
        .unwrap()
        .execute_batch("PRAGMA journal_mode=WAL;")
        .unwrap();
    let initial = cli(workspace.path(), &["backup", "run"]);
    assert!(
        initial.status.success(),
        "{}",
        String::from_utf8_lossy(&initial.stderr)
    );
    let before = cli(workspace.path(), &["backup", "list"]);
    assert!(
        before.status.success(),
        "{}; initial: {}",
        String::from_utf8_lossy(&before.stderr),
        String::from_utf8_lossy(&initial.stdout)
    );
    for (action, repair) in [("locks", false), ("unlock", true)] {
        let output = cli(workspace.path(), &["backup", action]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["schema_version"], 3);
        assert_eq!(value["unlock_attempted"], repair);
        assert_eq!(value["locks"], json!([]));
        assert_eq!(value["repository_id"].as_str().unwrap().len(), 64);
    }
    for options in [
        vec!["backup", "unlock", "--remove-all"],
        vec!["backup", "unlock", "--force"],
        vec!["backup", "unlock", "--destination", "missing"],
        vec![
            "backup",
            "unlock",
            "--repository",
            "/not-an-authorized-target",
        ],
    ] {
        let output = cli(workspace.path(), &options);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    let after = cli(workspace.path(), &["backup", "list"]);
    assert!(after.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&before.stdout).unwrap(),
        serde_json::from_slice::<Value>(&after.stdout).unwrap()
    );
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

#[test]
fn editing_cli_is_headless_atomic_and_does_not_fallback_from_owner_failure() {
    let workspace = fixture();
    let note = "01a30000-0000-7000-8000-000000000002";
    let path = workspace.path().join(".memoka/memoka.sqlite3");
    let before = hash_file(&path).unwrap();
    let old = cli(
        workspace.path(),
        &["read", "--id", note, "--for-edit", "--format", "json"],
    );
    assert!(!old.status.success());
    assert!(old.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&old.stdout).unwrap()["error"]["code"],
        "MIGRATION_REQUIRED"
    );
    assert_eq!(hash_file(&path).unwrap(), before);

    // Upgrade only this private fixture's Note metadata (v3 bodies already use
    // chunks). A separate native suite tests GUI preflight/rollback migration.
    let db = Connection::open(&path).unwrap();
    let snapshot: Vec<u8> = db
        .query_row(
            "SELECT snapshot FROM documents WHERE kind='note' AND document_id=?1",
            [note],
            |r| r.get(0),
        )
        .unwrap();
    let document = yrs::Doc::new();
    document
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&snapshot).unwrap())
        .unwrap();
    document
        .get_or_insert_map("meta")
        .insert(&mut document.transact_mut(), "schema_version", 6);
    let migrated = document
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    db.execute("UPDATE documents SET snapshot=?1,schema_version=6,revision=8,snapshot_revision=8 WHERE kind='note' AND document_id=?2",params![migrated,note]).unwrap();
    db.execute_batch("ALTER TABLE document_updates ADD COLUMN operation_id TEXT;
        CREATE TABLE agent_edit_receipts(workspace_id TEXT,request_id TEXT,request_hash TEXT,result_json TEXT,PRIMARY KEY(workspace_id,request_id));
        CREATE TABLE workspace_search_invalidations(kind TEXT,document_id TEXT,source_revision INTEGER,PRIMARY KEY(kind,document_id));
        UPDATE settings SET value='6' WHERE key='database_schema_version';").unwrap();
    drop(db);
    let view: Value = serde_json::from_slice(
        &cli(
            workspace.path(),
            &["read", "--id", note, "--for-edit", "--format", "json"],
        )
        .stdout,
    )
    .unwrap();
    assert_eq!(view["representation"], "edit_view");
    let request = json!({"schema_version":1,"workspace_id":view["workspace_id"],"note_id":note,"expected_revision":view["revision"],"request_id":uuid::Uuid::now_v7().to_string(),
        "edits":[{"op":"append_markdown","section_id":note,"markdown":"CLI日本語😀"}]});
    let input = workspace.path().join("request.json");
    fs::write(&input, serde_json::to_vec(&request).unwrap()).unwrap();
    let args = [
        "edit",
        "--input",
        input.to_str().unwrap(),
        "--format",
        "json",
    ];
    let lease = WorkspaceLease::acquire(workspace.path()).unwrap();
    let server = Server::start(
        lease.clone(),
        Arc::new(|_| Err(ReadError::new("SAVE_BARRIER_TIMEOUT", "injected"))),
    )
    .unwrap();
    let output = cli(workspace.path(), &args);
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let failed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(failed["error"]["code"], "SAVE_BARRIER_TIMEOUT");
    assert_eq!(failed["request_id"], request["request_id"]);
    drop(server);
    drop(lease);
    let applied = cli(workspace.path(), &args);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stdout)
    );
    let applied: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(applied["applied_edits"], 1);
    let replay = cli(workspace.path(), &args);
    assert!(replay.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&replay.stdout).unwrap()["replayed"],
        true
    );
    let markdown = cli(
        workspace.path(),
        &["read", "--id", note, "--format", "markdown"],
    );
    assert_eq!(
        String::from_utf8(markdown.stdout)
            .unwrap()
            .matches("CLI日本語😀")
            .count(),
        1
    );
    fs::write(&input, b"{\"schema_version\":1,\"schema_version\":1}").unwrap();
    let malformed = cli(workspace.path(), &args);
    assert!(!malformed.status.success());
    assert!(malformed.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&malformed.stdout).unwrap()["error"]["code"],
        "INVALID_REQUEST"
    );
    let tree: Value =
        serde_json::from_slice(&cli(workspace.path(), &["tree", "--format", "json"]).stdout)
            .unwrap();
    let note_request = json!({"schema_version":1,"workspace_id":view["workspace_id"],
        "expected_workspace_revision":tree["source"]["workspace_metadata_revision"],"request_id":uuid::Uuid::now_v7().to_string(),
        "action":{"op":"create","title":"CLIから作成😀","parent_entry_id":null,"placement":{"kind":"last"},"markdown":"- [x] 検証"}});
    fs::write(&input, serde_json::to_vec(&note_request).unwrap()).unwrap();
    let args = [
        "note-edit",
        "--input",
        input.to_str().unwrap(),
        "--format",
        "json",
    ];
    let lease = WorkspaceLease::acquire(workspace.path()).unwrap();
    let server = Server::start(
        lease.clone(),
        Arc::new(|_| Err(ReadError::new("SAVE_BARRIER_TIMEOUT", "injected"))),
    )
    .unwrap();
    let rejected: Value = serde_json::from_slice(&cli(workspace.path(), &args).stdout).unwrap();
    assert_eq!(rejected["error"]["code"], "SAVE_BARRIER_TIMEOUT");
    assert_eq!(rejected["request_id"], note_request["request_id"]);
    drop(server);
    drop(lease);
    let preview = cli(
        workspace.path(),
        &[
            "note-edit",
            "--input",
            input.to_str().unwrap(),
            "--dry-run",
            "--format",
            "json",
        ],
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&preview.stdout).unwrap()["status"],
        "preview",
        "{}",
        String::from_utf8_lossy(&preview.stdout)
    );
    let output = cli(workspace.path(), &args);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let created: Value = serde_json::from_slice(&output.stdout).unwrap();
    let replay: Value = serde_json::from_slice(&cli(workspace.path(), &args).stdout).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["note_id"], created["note_id"]);
    let result = cli(
        workspace.path(),
        &[
            "read",
            "--id",
            created["note_id"].as_str().unwrap(),
            "--format",
            "json",
        ],
    );
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["section"]["title"], "CLIから作成😀");
    assert!(result["markdown"].as_str().unwrap().contains("- [x] 検証"));
}
