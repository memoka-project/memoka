use crate::{
    document_model::{decode_document, read_note},
    namespace::read_namespace,
    persistence::{PersistedDocument, ProductStore},
    read_service::hash_file,
    workspace_migration::{load_document, preflight},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};
use yrs::{Map, ReadTxn, StateVector, Transact, Xml, XmlElementPrelim, XmlFragment, XmlOut};

const NOTE: &str = "01a30000-0000-7000-8000-000000000002";
fn legacy_fixture() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    drop(ProductStore::open(directory.path()).unwrap());
    let connection = Connection::open(directory.path().join("memoka.sqlite3")).unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/reader-contract.json")).unwrap();
    for value in fixture["legacy_documents"].as_array().unwrap() {
        let doc = PersistedDocument {
            kind: value["kind"].as_str().unwrap().into(),
            document_id: value["document_id"].as_str().unwrap().into(),
            schema_version: 2,
            revision: 7,
            snapshot_revision: 7,
            snapshot: value["snapshot"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u8)
                .collect(),
            updates: Vec::new(),
        };
        connection
            .execute(
                "INSERT INTO documents VALUES (?1,?2,2,7,7,?3)",
                params![doc.kind, doc.document_id, doc.snapshot],
            )
            .unwrap();
        if doc.kind == "workspace" {
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings VALUES ('active_workspace_id',?1)",
                    [doc.document_id],
                )
                .unwrap();
        }
    }
    connection
        .execute(
            "UPDATE settings SET value='4' WHERE key='database_schema_version'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO local_window_state VALUES ('application',?1,'old-ui')",[json!({"schemaVersion":8,"tabs":[{"leftSidebar":{"tree":{"selectedNoteId":NOTE,"collapsedNoteIds":[NOTE]}}}]}).to_string()]).unwrap();
    directory
}
fn contents(path: &Path) -> BTreeMap<String, String> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let value = if entry.file_type().unwrap().is_file() {
                hash_file(&entry.path()).unwrap()
            } else {
                format!("{:?}", contents(&entry.path()))
            };
            (name, value)
        })
        .collect()
}
#[test]
fn legacy_migration_preserves_rich_content_identity_and_rollback_image() {
    for version in [2, 3, 4] {
        let fixture = legacy_fixture();
        let path = fixture.path().join("memoka.sqlite3");
        {
            let db = Connection::open(&path).unwrap();
            db.execute(
                "UPDATE settings SET value=?1 WHERE key='database_schema_version'",
                [version.to_string()],
            )
            .unwrap();
        }
        let before = contents(fixture.path());
        let prepared = preflight(fixture.path()).unwrap().unwrap();
        assert_eq!(prepared.documents.len(), 2);
        assert_eq!(contents(fixture.path()), before, "preflight must not write");
        let original = Connection::open(&path).unwrap();
        let original_note = load_document(&original, "note", NOTE).unwrap();
        let expected = read_note(&original_note, true).unwrap();
        drop(original);
        drop(ProductStore::open(fixture.path()).unwrap());
        let migrated = Connection::open(&path).unwrap();
        let note = load_document(&migrated, "note", NOTE).unwrap();
        assert_eq!(note.schema_version, 3);
        assert_eq!(note.revision, 8);
        assert_eq!(read_note(&note, false).unwrap().root, expected.root);
        let workspace = load_document(
            &migrated,
            "workspace",
            "01a30000-0000-7000-8000-000000000001",
        )
        .unwrap();
        let namespace = read_namespace(&workspace).unwrap();
        assert_eq!(namespace.entries.len(), 1);
        let state: String = migrated
            .query_row(
                "SELECT state_json FROM local_window_state WHERE window_id='application'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let state: Value = serde_json::from_str(&state).unwrap();
        assert_eq!(
            state["tabs"][0]["leftSidebar"]["tree"]["selectedEntryId"],
            prepared.entry_ids[NOTE]
        );
        let rollback = Connection::open(
            fixture
                .path()
                .join("migration-backups/before-namespace-v5.sqlite3"),
        )
        .unwrap();
        let rollback_note = load_document(&rollback, "note", NOTE).unwrap();
        assert_eq!(rollback_note.snapshot, original_note.snapshot);
        assert_eq!(rollback_note.revision, 7);
        assert_eq!(preflight(fixture.path()).unwrap().is_none(), true);
    }
}

#[test]
fn duplicate_section_owners_are_rejected_before_migration_writes() {
    let directory = legacy_fixture();
    let second_id = "01a30000-0000-7000-8000-000000000099";
    {
        let connection = Connection::open(directory.path().join("memoka.sqlite3")).unwrap();
        let original = load_document(&connection, "note", NOTE).unwrap();
        let doc = decode_document(&original).unwrap();
        {
            let mut txn = doc.transact_mut();
            txn.get_map("meta")
                .unwrap()
                .insert(&mut txn, "note_id", second_id);
            let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap()
            else {
                panic!("root");
            };
            let XmlOut::Element(header) = root.get(&txn, 0).unwrap() else {
                panic!("header");
            };
            header.insert_attribute(&mut txn, "sectionId", second_id);
        }
        let snapshot = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        connection
            .execute(
                "INSERT INTO documents VALUES ('note',?1,2,7,7,?2)",
                params![second_id, snapshot],
            )
            .unwrap();
    }
    let before = contents(directory.path());
    let error = preflight(directory.path()).err().unwrap();
    assert_eq!(error.code, "MIGRATION_PREFLIGHT_FAILED");
    assert!(error.details.to_string().contains("DUPLICATE_SECTION_ID"));
    assert_eq!(contents(directory.path()), before);
}

#[test]
fn preflight_replays_committed_wal_without_touching_the_source() {
    let fixture = legacy_fixture();
    let db = Connection::open(fixture.path().join("memoka.sqlite3")).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;",
    )
    .unwrap();
    db.execute(
        "UPDATE documents SET revision=8,snapshot_revision=8 WHERE kind='note'",
        [],
    )
    .unwrap();
    assert!(
        fs::metadata(fixture.path().join("memoka.sqlite3-wal"))
            .unwrap()
            .len()
            > 0
    );
    let before = contents(fixture.path());
    let prepared = preflight(fixture.path()).unwrap().unwrap();
    assert_eq!(
        prepared
            .documents
            .iter()
            .find(|(doc, _)| doc.kind == "note")
            .unwrap()
            .0
            .revision,
        8
    );
    assert_eq!(contents(fixture.path()), before);
    db.execute(
        "UPDATE documents SET schema_version=99 WHERE kind='note'",
        [],
    )
    .unwrap();
    let before = contents(fixture.path());
    assert!(
        preflight(fixture.path()).is_err(),
        "must not validate the older WAL-free state"
    );
    assert_eq!(contents(fixture.path()), before);
}

#[test]
fn migration_distinguishes_known_missing_attachments_from_corruption() {
    let fixture = legacy_fixture();
    let id = "01a30000-0000-7000-8000-000000000077";
    let hash = "a".repeat(64);
    let db = Connection::open(fixture.path().join("memoka.sqlite3")).unwrap();
    db.execute("INSERT INTO attachment_objects(sha256,size,created_at) VALUES (?1,3,'2026-09-06T00:00:00Z')", [&hash]).unwrap();
    db.execute("INSERT INTO attachments(attachment_id,sha256,size,original_filename,mime_type,created_at) VALUES (?1,?2,3,'missing.txt','text/plain','2026-09-06T00:00:00Z')", params![id, hash]).unwrap();
    drop(db);
    let before = contents(fixture.path());
    assert_eq!(
        preflight(fixture.path()).unwrap().unwrap().known_missing,
        vec![id]
    );
    assert_eq!(contents(fixture.path()), before);
    let dir = fixture.path().join("attachments/objects/aa");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(&hash[2..]), b"bad").unwrap();
    let before = contents(fixture.path());
    assert_eq!(
        preflight(fixture.path()).err().unwrap().code,
        "ATTACHMENT_CORRUPT"
    );
    assert_eq!(contents(fixture.path()), before);
}

#[test]
fn over_depth_final_update_in_trash_or_help_is_rejected_before_any_migration_write() {
    for role in ["regular", "trash", "help"] {
        let fixture = legacy_fixture();
        let connection = Connection::open(fixture.path().join("memoka.sqlite3")).unwrap();
        let original = load_document(&connection, "note", NOTE).unwrap();
        let doc = decode_document(&original).unwrap();
        let vector = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let body = txn.get_xml_fragment("body").unwrap();
            let XmlOut::Element(mut parent) = body.get(&txn, 0).unwrap() else {
                panic!()
            };
            for depth in 1..=6 {
                let XmlOut::Element(children) = parent.get(&txn, 2).unwrap() else {
                    panic!()
                };
                let section = children.push_back(&mut txn, XmlElementPrelim::empty("section"));
                let header = section.push_back(&mut txn, XmlElementPrelim::empty("sectionHeader"));
                header.insert_attribute(
                    &mut txn,
                    "sectionId",
                    format!("01a30000-0000-7000-8000-{:012x}", 100 + depth),
                );
                header.insert_attribute(&mut txn, "tags", "[]");
                section.push_back(&mut txn, XmlElementPrelim::empty("sectionBody"));
                section.push_back(&mut txn, XmlElementPrelim::empty("sectionChildren"));
                parent = section;
            }
        }
        let update = doc.transact().encode_state_as_update_v1(&vector);
        connection
            .execute(
                "INSERT INTO document_updates VALUES ('note',?1,8,'legacy-update',?2)",
                params![NOTE, update],
            )
            .unwrap();
        connection
            .execute("UPDATE documents SET revision=8 WHERE kind='note'", [])
            .unwrap();
        if role != "regular" {
            let ws = load_document(
                &connection,
                "workspace",
                "01a30000-0000-7000-8000-000000000001",
            )
            .unwrap();
            let doc = decode_document(&ws).unwrap();
            let mut txn = doc.transact_mut();
            let workspace = txn.get_map("workspace").unwrap();
            let yrs::Out::YMap(notes) = workspace.get(&txn, "notes").unwrap() else {
                panic!()
            };
            let yrs::Out::YMap(note) = notes.get(&txn, NOTE).unwrap() else {
                panic!()
            };
            if role == "help" {
                note.insert(&mut txn, "system_role", "memoka-help");
            } else {
                note.insert(&mut txn, "deleted_at", "2026-09-06T00:00:00Z");
                note.insert(
                    &mut txn,
                    "trash_operation_id",
                    "01a30000-0000-7000-8000-000000000099",
                );
            }
            let bytes = txn.encode_state_as_update_v1(&StateVector::default());
            connection
                .execute(
                    "UPDATE documents SET snapshot=?1 WHERE kind='workspace'",
                    [bytes],
                )
                .unwrap();
        }
        drop(connection);
        let before = contents(fixture.path());
        let error = preflight(fixture.path()).err().unwrap();
        assert_eq!(error.code, "MIGRATION_PREFLIGHT_FAILED");
        assert!(error.details.to_string().contains("SECTION_DEPTH_LIMIT"));
        assert!(ProductStore::open(fixture.path()).is_err());
        assert_eq!(
            contents(fixture.path()),
            before,
            "invalid {role} must preserve source bytes and directory contents"
        );
    }
}
