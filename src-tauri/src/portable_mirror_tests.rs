use super::*;
use crate::{document_model::read_note, namespace::read_namespace};
use serde_json::Value;

fn fixture() -> (tempfile::TempDir, PortableMirrorManifest, Value) {
    let source = tempfile::tempdir().unwrap();
    let contract: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/reader-contract.json")).unwrap();
    let mut manifest = PortableMirrorManifest {
        schema_version: 1,
        generated_at: "2026-09-05T00:00:00.000Z".into(),
        workspace_id: contract["legacy_documents"][0]["document_id"]
            .as_str()
            .unwrap()
            .into(),
        notes: Vec::new(),
        documents: Vec::new(),
        attachments: Vec::new(),
        files: Vec::new(),
    };
    for value in contract["legacy_documents"].as_array().unwrap() {
        let id = value["document_id"].as_str().unwrap();
        let kind = value["kind"].as_str().unwrap();
        let bytes = value["snapshot"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        let path = format!("{kind}.yjs");
        let entry = store_file(source.path(), &path, "document", &bytes);
        manifest.documents.push(PortableMirrorDocumentEntry {
            kind: kind.into(),
            document_id: id.into(),
            schema_version: 2,
            source_revision: 7,
            path: path.clone(),
            sha256: entry.sha256.clone(),
            size: entry.size,
        });
        manifest.files.push(entry);
        if kind == "note" {
            let markdown = store_file(source.path(), "Note.md", "markdown", b"# Legacy Note\n");
            manifest.notes.push(PortableMirrorNoteEntry {
                note_id: id.into(),
                parent_note_id: None,
                deleted_at: None,
                markdown_path: markdown.path.clone(),
                sections: Vec::new(),
            });
            manifest.files.push(markdown);
        }
    }
    write_json_file(&source.path().join(PORTABLE_MANIFEST_FILE), &manifest).unwrap();
    (source, manifest, contract["expected"].clone())
}
fn store_file(root: &Path, path: &str, kind: &str, bytes: &[u8]) -> PortableMirrorFileEntry {
    fs::write(root.join(path), bytes).unwrap();
    PortableMirrorFileEntry {
        path: path.into(),
        sha256: Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        size: bytes.len() as u64,
        kind: kind.into(),
    }
}

#[test]
fn restores_old_mirror_into_current_namespace_and_h6_validated_baseline() {
    let (source, manifest, expected) = fixture();
    let before = fs::read(source.path().join(PORTABLE_MANIFEST_FILE)).unwrap();
    verify_portable_mirror(source.path()).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let target = destination.path().join("restored");
    restore_portable_mirror(source.path(), &target).unwrap();
    let store = ProductStore::open(target.join(".memoka")).unwrap();
    let note = store
        .load_document("note", &manifest.notes[0].note_id)
        .unwrap();
    assert_eq!(note.schema_version, 4);
    assert_eq!(note.revision, 1);
    assert_eq!(note.snapshot_revision, 1);
    assert!(note.updates.is_empty());
    assert_eq!(
        serde_json::to_value(read_note(&note, false).unwrap().root).unwrap(),
        expected
    );
    let workspace = store
        .load_document("workspace", &manifest.workspace_id)
        .unwrap();
    let namespace = read_namespace(&workspace).unwrap();
    assert_eq!(namespace.entries.len(), 1);
    assert_ne!(
        namespace.note_entry(&note.document_id).unwrap().entry_id,
        note.document_id
    );
    assert!(!target.join(".memoka-backups").exists());
    assert_eq!(
        fs::read(source.path().join(PORTABLE_MANIFEST_FILE)).unwrap(),
        before
    );
}

#[test]
fn refuses_corrupt_recovery_before_creating_restore_target() {
    let (source, mut manifest, _) = fixture();
    let broken = store_file(source.path(), "note.yjs", "document", b"not a Yjs update");
    let document = manifest
        .documents
        .iter_mut()
        .find(|doc| doc.kind == "note")
        .unwrap();
    document.sha256 = broken.sha256.clone();
    document.size = broken.size;
    *manifest
        .files
        .iter_mut()
        .find(|entry| entry.path == "note.yjs")
        .unwrap() = broken;
    write_json_file(&source.path().join(PORTABLE_MANIFEST_FILE), &manifest).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let target = destination.path().join("new");
    assert!(restore_portable_mirror(source.path(), &target).is_err());
    assert!(!target.exists());
}

#[test]
fn refuses_incomplete_or_tampered_mirrors_and_does_not_overwrite_targets() {
    let (source, _, _) = fixture();
    fs::write(source.path().join(MIRROR_UPDATE_MARKER), b"incomplete").unwrap();
    assert!(
        verify_portable_mirror(source.path())
            .unwrap_err()
            .to_string()
            .contains("incomplete")
    );
    fs::remove_file(source.path().join(MIRROR_UPDATE_MARKER)).unwrap();
    let destination = tempfile::tempdir().unwrap();
    fs::write(destination.path().join("note.MD"), "keep").unwrap();
    assert!(restore_portable_mirror(source.path(), destination.path()).is_err());
    assert_eq!(
        fs::read_to_string(destination.path().join("note.MD")).unwrap(),
        "keep"
    );
    fs::write(source.path().join("Note.md"), b"tampered").unwrap();
    assert!(verify_portable_mirror(source.path()).is_err());
}
