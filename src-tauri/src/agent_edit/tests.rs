use super::*;
use yrs::{Xml, XmlElementPrelim, XmlFragment, XmlOut};
const NOTE: &str = "01a30000-0000-7000-8000-000000000002";
const WORKSPACE: &str = "01a30000-0000-7000-8000-000000000001";
fn node(kind: &str, children: Vec<Value>) -> Value {
    json!({"type":kind,"attrs":{"blockId":uuid::Uuid::now_v7().to_string()},"content":children})
}
fn p(text: &str) -> Value {
    node("paragraph", vec![json!({"type":"text","text":text})])
}
fn fixture(blocks: Vec<Value>) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    crate::backup::tests::fixture(temp.path());
    let store = ProductStore::open(temp.path().join(".memoka")).unwrap();
    let stored = load_document(&store.connection, "note", NOTE).unwrap();
    let doc = decode_document(&stored).unwrap();
    {
        let mut txn = doc.transact_mut();
        txn.get_map("meta")
            .unwrap()
            .insert(&mut txn, "schema_version", 6);
        let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap()
        else {
            panic!()
        };
        let XmlOut::Element(body) = root.get(&txn, 1).unwrap() else {
            panic!()
        };
        let len = body.len(&txn);
        body.remove_range(&mut txn, 0, len);
        if !blocks.is_empty() {
            let chunk = body.push_back(&mut txn, XmlElementPrelim::empty("bodyChunk"));
            chunk.insert_attribute(&mut txn, "chunkId", uuid::Uuid::now_v7().to_string());
            for (i, block) in blocks.iter().enumerate() {
                projection::insert_block(&mut txn, &chunk, i as u32, block).unwrap();
            }
        }
    }
    store.connection.execute("UPDATE documents SET schema_version=6,snapshot=?1 WHERE kind='note' AND document_id=?2",params![doc.transact().encode_state_as_update_v1(&StateVector::default()),NOTE]).unwrap();
    temp
}
fn request(edits: Vec<Value>) -> EditRequest {
    parse_request(&serde_json::to_vec(&json!({"schema_version":1,"workspace_id":WORKSPACE,"note_id":NOTE,"expected_revision":1,"request_id":uuid::Uuid::now_v7().to_string(),"edits":edits})).unwrap()).unwrap()
}
fn replace(old: &str, new: &str) -> Value {
    json!({"op":"replace_text","section_id":NOTE,"scope":"body","old_text":old,"new_text":new})
}
fn append(markdown: &str) -> Value {
    json!({"op":"append_markdown","section_id":NOTE,"markdown":markdown})
}
fn view(temp: &tempfile::TempDir) -> Value {
    read_for_edit(temp.path(), NOTE, 100, None).unwrap()
}
fn run(temp: &tempfile::TempDir, request: impl Into<AgentRequest>) -> Value {
    standalone(temp.path(), request, false).unwrap()
}

fn note_request(temp: &tempfile::TempDir, action: Value) -> NoteRequest {
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    parse_note_request(&serde_json::to_vec(&json!({"schema_version":1,"workspace_id":WORKSPACE,
        "expected_workspace_revision":reader.workspace_revision,"request_id":uuid::Uuid::now_v7().to_string(),"action":action})).unwrap()).unwrap()
}
fn create_action(title: &str, parent: Option<&str>) -> Value {
    json!({"op":"create","title":title,"parent_entry_id":parent,"placement":{"kind":"last"},"markdown":"**記事**\n\n- [x] 確認\n- [ ] 次回"})
}
#[test]
fn note_creation_is_atomic_previewable_replayable_and_preserves_existing_notes() {
    let temp = fixture(vec![p("元の本文")]);
    let before = view(&temp);
    let request = note_request(&temp, create_action("新しい記事", None));
    let preview = standalone(temp.path(), request.clone(), true).unwrap();
    assert_eq!(preview["status"], "preview");
    assert_eq!(
        preview["workspace_revision_before"],
        preview["workspace_revision_after"]
    );
    assert_eq!(
        WorkspaceReader::open(temp.path())
            .unwrap()
            .namespace
            .notes
            .len(),
        1
    );
    let result = run(&temp, request.clone());
    let note_id = result["note_id"].as_str().unwrap();
    validate_id(note_id).unwrap();
    assert_ne!(note_id, result["entry_id"].as_str().unwrap());
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    assert_eq!(reader.namespace.notes.len(), 2);
    assert_eq!(reader.namespace.notes[note_id]["title_cache"], "新しい記事");
    let entry = reader.namespace.note_entry(note_id).unwrap();
    assert!(entry.parent_entry_id.is_none());
    let note = read_note(
        &load_document(&reader.connection, "note", note_id).unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(note.revision, 1);
    assert_eq!(note.root.section_id, note_id);
    assert_eq!(note.root.body[0]["content"][0]["marks"][0]["type"], "bold");
    assert_eq!(note.root.body[1]["content"][0]["attrs"]["checked"], true);
    drop(reader);
    assert_eq!(view(&temp)["blocks"], before["blocks"]);
    assert_eq!(view(&temp)["revision"], before["revision"]);
    let replay = run(&temp, request.clone());
    assert_eq!(replay["note_id"], result["note_id"]);
    assert_eq!(replay["replayed"], true);
    let mut reused = request;
    if let NoteAction::Create { title, .. } = &mut reused.action {
        *title = "別内容".into();
    }
    assert_eq!(
        prepare(temp.path(), reused).err().unwrap().code,
        "REQUEST_ID_REUSED"
    );
}

#[test]
fn root_rename_changes_only_title_and_preserves_body_ids_and_noop_revisions() {
    let temp = fixture(vec![p("変更しない😀")]);
    let before = view(&temp);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let created_at = reader.namespace.notes[NOTE]["created_at"].clone();
    drop(reader);
    let renamed = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"rename","note_id":NOTE,"expected_revision":1,"title":"日本語の新題"}),
        ),
    );
    assert_eq!(renamed["revision_scope"], "note");
    assert_eq!(renamed["revision_after"], 2);
    assert_eq!(view(&temp)["blocks"], before["blocks"]);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let note = read_note(
        &load_document(&reader.connection, "note", NOTE).unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(note.root.title, "日本語の新題");
    assert_eq!(reader.namespace.notes[NOTE]["title_cache"], "日本語の新題");
    assert_eq!(reader.namespace.notes[NOTE]["created_at"], created_at);
    let revision = reader.workspace_revision;
    drop(reader);
    let no_change = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"rename","note_id":NOTE,"expected_revision":2,"title":"日本語の新題"}),
        ),
    );
    assert_eq!(no_change["status"], "no_change");
    assert_eq!(no_change["workspace_revision_after"], revision);
    assert_eq!(no_change["revision_after"], 2);
    let stale = note_request(
        &temp,
        json!({"op":"rename","note_id":NOTE,"expected_revision":1,"title":"古い意図"}),
    );
    assert_eq!(
        prepare(temp.path(), stale).err().unwrap().code,
        "REVISION_CONFLICT"
    );
}

#[test]
fn placement_moves_keep_subtrees_note_revisions_and_timestamps() {
    let temp = fixture(vec![p("元の本文")]);
    let original = WorkspaceReader::open(temp.path())
        .unwrap()
        .namespace
        .note_entry(NOTE)
        .unwrap()
        .entry_id
        .clone();
    let parent = run(&temp, note_request(&temp, create_action("親", None)));
    let parent_entry = parent["entry_id"].as_str().unwrap();
    let child = run(
        &temp,
        note_request(&temp, create_action("子", Some(parent_entry))),
    );
    let child_entry = child["entry_id"].as_str().unwrap();
    let before = WorkspaceReader::open(temp.path()).unwrap();
    let notes = before.namespace.notes.clone();
    let revisions = before.document_revisions.clone();
    drop(before);
    let cycle = note_request(
        &temp,
        json!({"op":"move","entry_id":parent_entry,"parent_entry_id":child_entry,"placement":{"kind":"last"}}),
    );
    assert_eq!(
        prepare(temp.path(), cycle).err().unwrap().code,
        "INVALID_TARGET"
    );
    let moved = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"move","entry_id":parent_entry,"parent_entry_id":original,"placement":{"kind":"first"}}),
        ),
    );
    assert_eq!(moved["status"], "applied");
    let after = WorkspaceReader::open(temp.path()).unwrap();
    assert_eq!(
        after.namespace.entries[child_entry]
            .parent_entry_id
            .as_deref(),
        Some(parent_entry)
    );
    assert_eq!(
        after.namespace.entries[parent_entry]
            .parent_entry_id
            .as_deref(),
        Some(original.as_str())
    );
    assert_eq!(after.namespace.notes, notes);
    assert_eq!(after.document_revisions, revisions);
    drop(after);
    let noop = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"move","entry_id":parent_entry,"parent_entry_id":original,"placement":{"kind":"last"}}),
        ),
    );
    assert_eq!(noop["status"], "no_change");
    let top = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"move","entry_id":child_entry,"parent_entry_id":null,"placement":{"kind":"before","entry_id":original}}),
        ),
    );
    assert_eq!(top["status"], "applied");
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    assert_eq!(reader.namespace.ordered(false)[0].0.entry_id, child_entry);
}

#[test]
fn note_commands_reject_stale_workspace_and_rollback_failed_creation() {
    let temp = fixture(vec![p("元の本文")]);
    let req = note_request(&temp, create_action("記事", None));
    let prepared = prepare(temp.path(), req.clone()).unwrap();
    let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
    for fault in [
        crate::persistence::CommitFault::BeforeCommit,
        crate::persistence::CommitFault::BeforeSqlCommit,
    ] {
        assert!(commit_with_fault(&mut store, &prepared, Some(fault)).is_err());
        assert_eq!(
            WorkspaceReader::open(temp.path())
                .unwrap()
                .namespace
                .notes
                .len(),
            1
        );
        assert!(receipt(&store.connection, req.clone()).unwrap().is_none());
    }
    assert_eq!(
        commit_with_fault(
            &mut store,
            &prepared,
            Some(crate::persistence::CommitFault::AfterCommitResponse)
        )
        .unwrap_err()
        .code,
        "AGENT_RESPONSE_LOST"
    );
    let replay = run(&temp, req.clone());
    assert_eq!(replay["replayed"], true);
    assert_eq!(
        WorkspaceReader::open(temp.path())
            .unwrap()
            .namespace
            .notes
            .len(),
        2
    );
    let mut stale = req;
    stale.request_id = uuid::Uuid::now_v7().to_string();
    assert_eq!(
        prepare(temp.path(), stale).err().unwrap().code,
        "WORKSPACE_CHANGED"
    );
    let unsupported = note_request(
        &temp,
        json!({"op":"create","title":"拒否","parent_entry_id":null,"placement":{"kind":"first"},"markdown":"# heading"}),
    );
    assert_eq!(
        prepare(temp.path(), unsupported).err().unwrap().code,
        "UNSUPPORTED_CONTENT"
    );
    assert_eq!(
        WorkspaceReader::open(temp.path())
            .unwrap()
            .namespace
            .notes
            .len(),
        2
    );
}

#[test]
fn note_command_commit_rechecks_workspace_and_rejects_protected_targets() {
    let temp = fixture(vec![p("内容")]);
    let req = note_request(&temp, create_action("staged", None));
    let prepared = prepare(temp.path(), req.clone()).unwrap();
    let empty = run(
        &temp,
        note_request(
            &temp,
            json!({"op":"create","title":"","parent_entry_id":null,"placement":{"kind":"first"}}),
        ),
    );
    let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
    assert_eq!(
        commit_with_fault(&mut store, &prepared, None)
            .unwrap_err()
            .code,
        "WORKSPACE_CHANGED"
    );
    assert!(receipt(&store.connection, req).unwrap().is_none());
    let new_note = read_note(
        &load_document(
            &store.connection,
            "note",
            empty["note_id"].as_str().unwrap(),
        )
        .unwrap(),
        false,
    )
    .unwrap();
    assert_eq!(new_note.root.title, "");
    assert_eq!(new_note.root.body.len(), 1);
    assert_eq!(new_note.root.body[0]["type"], "paragraph");

    let persisted = load_document(&store.connection, "workspace", WORKSPACE).unwrap();
    let doc = decode_document(&persisted).unwrap();
    {
        let mut txn = doc.transact_mut();
        let workspace = txn.get_map("workspace").unwrap();
        let Some(yrs::Out::YMap(notes)) = workspace.get(&txn, "notes") else {
            panic!()
        };
        let Some(yrs::Out::YMap(note)) = notes.get(&txn, NOTE) else {
            panic!()
        };
        note.insert(&mut txn, "system_role", "help");
    }
    store.connection.execute("UPDATE documents SET snapshot=?1,snapshot_revision=revision WHERE kind='workspace' AND document_id=?2",
        params![doc.transact().encode_state_as_update_v1(&StateVector::default()),WORKSPACE]).unwrap();
    store
        .connection
        .execute(
            "DELETE FROM document_updates WHERE kind='workspace' AND document_id=?1",
            [WORKSPACE],
        )
        .unwrap();
    let namespace = WorkspaceReader::open(temp.path()).unwrap().namespace;
    let entry_id = &namespace.note_entry(NOTE).unwrap().entry_id;
    for action in [
        json!({"op":"rename","note_id":NOTE,"expected_revision":1,"title":"forbidden"}),
        json!({"op":"move","entry_id":entry_id,"parent_entry_id":null,"placement":{"kind":"last"}}),
    ] {
        assert_eq!(
            prepare(temp.path(), note_request(&temp, action))
                .err()
                .unwrap()
                .code,
            "READ_ONLY_TARGET"
        );
    }
    assert_eq!(
        WorkspaceReader::open(temp.path())
            .unwrap()
            .namespace
            .notes
            .len(),
        2
    );
    assert!(parse_note_request(br#"{"schema_version":1,"schema_version":1}"#).is_err());
}
#[test]
fn unicode_segments_literal_replacement_and_replay_survive_restart() {
    let mut paragraph = p("");
    paragraph["content"] = json!([
        {"type":"text","text":"日本語😀e\u{301}","marks":[{"type":"bold"}]},
        {"type":"text","text":"漢字","marks":[{"type":"bold"}]},
        {"type":"text","text":"別の装飾","marks":[{"type":"italic"}]},
        {"type":"hardBreak"},{"type":"text","text":"末尾"}
    ]);
    let temp = fixture(vec![paragraph.clone()]);
    assert_eq!(
        view(&temp)["blocks"][0]["editable_segments"],
        json!([{"text":"日本語😀e\u{301}漢字"},{"text":"別の装飾"},{"text":"末尾"}])
    );
    let request = request(vec![replace("😀e\u{301}漢字", "**字**")]);
    let result = run(&temp, request.clone());
    assert_eq!(result["revision_after"], 2);
    assert_eq!(result["applied_edits"], 1);
    assert_eq!(
        view(&temp)["blocks"][0]["block_id"],
        paragraph["attrs"]["blockId"]
    );
    assert_eq!(
        view(&temp)["blocks"][0]["editable_segments"][0]["text"],
        "日本語**字**"
    );
    let replay = run(&temp, request.clone());
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["revision_after"], 2);
    let mut reused = request;
    reused.edits = vec![Edit::AppendMarkdown {
        section_id: NOTE.into(),
        markdown: "other".into(),
    }];
    assert_eq!(
        prepare(temp.path(), reused).err().unwrap().code,
        "REQUEST_ID_REUSED"
    );
}
#[test]
fn no_match_ambiguity_overlap_and_atomic_batch_rejection() {
    let temp = fixture(vec![p("aaaa"), p("second")]);
    assert_eq!(
        prepare(temp.path(), request(vec![replace("aa", "x")]))
            .err()
            .unwrap()
            .code,
        "AMBIGUOUS_MATCH"
    );
    assert_eq!(
        prepare(temp.path(), request(vec![replace("missing", "x")]))
            .err()
            .unwrap()
            .code,
        "MATCH_NOT_FOUND"
    );
    assert_eq!(
        prepare(
            temp.path(),
            request(vec![replace("second", "x"), replace("second", "y")])
        )
        .err()
        .unwrap()
        .code,
        "OVERLAPPING_EDITS"
    );
    assert_eq!(
        prepare(
            temp.path(),
            request(vec![replace("second", "x"), append("# forbidden")])
        )
        .err()
        .unwrap()
        .code,
        "UNSUPPORTED_CONTENT"
    );
    assert_eq!(view(&temp)["revision"], 1);
}
#[test]
fn mark_hardbreak_and_atomic_boundaries_are_not_crossed() {
    let temp = fixture(vec![node(
        "paragraph",
        vec![
            json!({"type":"text","text":"first"}),
            json!({"type":"hardBreak"}),
            json!({"type":"text","text":"second"}),
        ],
    )]);
    assert_eq!(
        prepare(temp.path(), request(vec![replace("firstsecond", "x")]))
            .err()
            .unwrap()
            .code,
        "MATCH_NOT_FOUND"
    );
}

#[test]
fn protected_content_and_mark_boundaries_are_not_editable() {
    let marked = node(
        "paragraph",
        vec![
            json!({"type":"text","text":"left","marks":[{"type":"bold"}]}),
            json!({"type":"text","text":"right","marks":[{"type":"italic"}]}),
            json!({"type":"internalSectionLink","attrs":{"targetSectionId":NOTE},"content":[{"type":"text","text":"linked title"}]}),
            json!({"type":"text","text":"tail"}),
        ],
    );
    let cell = p("cell text");
    let code = node("codeBlock", vec![json!({"type":"text","text":"code text"})]);
    let table = node(
        "table",
        vec![node(
            "tableRow",
            vec![node("tableCell", vec![cell.clone()])],
        )],
    );
    let temp = fixture(vec![marked, code.clone(), table]);
    for old in ["leftright", "righttail", "linked title"] {
        assert_eq!(
            prepare(temp.path(), request(vec![replace(old, "x")]))
                .err()
                .unwrap()
                .code,
            "MATCH_NOT_FOUND"
        );
    }
    for (block, old) in [(cell, "cell text"), (code, "code text")] {
        let mut edit = replace(old, "x");
        edit["block_id"] = block["attrs"]["blockId"].clone();
        assert_eq!(
            prepare(temp.path(), request(vec![edit]))
                .err()
                .unwrap()
                .code,
            "UNSUPPORTED_CONTENT"
        );
    }
    run(&temp, request(vec![replace("left", "日本語")]));
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let note = read_note(
        &load_document(&reader.connection, "note", NOTE).unwrap(),
        false,
    )
    .unwrap();
    let text = serde_json::to_string(&note.root).unwrap();
    assert!(text.contains("linked title"));
    assert!(text.contains("targetSectionId"));
    assert!(text.contains("bold"));
}

#[test]
fn invalid_fields_ids_newlines_and_empty_operations_are_rejected() {
    let valid = serde_json::to_value(request(vec![replace("old", "new")])).unwrap();
    let mut cases = vec![];
    for (field, value) in [
        ("unknown", json!(true)),
        ("schema_version", json!(2)),
        ("expected_revision", json!(0)),
        ("note_id", json!("../note")),
        ("request_id", json!("01A30000-0000-7000-8000-000000000001")),
        ("edits", json!([])),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        cases.push(invalid);
    }
    for (field, value) in [
        ("unknown", json!(true)),
        ("old_text", json!("")),
        ("old_text", json!("a\nb")),
        ("new_text", json!("a\rb")),
        ("scope", json!("title")),
        ("block_id", json!("not-an-id")),
        ("op", json!("remove_note")),
    ] {
        let mut invalid = valid.clone();
        invalid["edits"][0][field] = value;
        cases.push(invalid);
    }
    for invalid in cases {
        assert!(
            parse_request(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn empty_tasks_and_escaped_literal_markers_round_trip() {
    let temp = fixture(vec![]);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let parsed = markdown::parse("- [ ]\n- [x]\n- \\[x\\]", &reader).unwrap();
    let items = parsed[0]["content"].as_array().unwrap();
    assert_eq!(items[0]["attrs"]["checked"], false);
    assert_eq!(items[1]["attrs"]["checked"], true);
    assert!(items[2]["attrs"]["checked"].is_null());
    for item in &items[..2] {
        assert_eq!(item["content"][0]["content"], json!([]));
    }
}

#[test]
fn oversized_rows_and_diffs_are_explicitly_bounded() {
    let block = p(&"large".repeat(40_000));
    let temp = fixture(vec![block.clone()]);
    let result = view(&temp);
    assert_eq!(result["blocks"][0]["omitted"], true);
    assert_eq!(result["blocks"][0]["read_only_reason"], "BLOCK_TOO_LARGE");
    assert_eq!(result["blocks"][0]["editable_segments"], json!([]));
    let mut edit = replace("large", "x");
    edit["block_id"] = block["attrs"]["blockId"].clone();
    assert_eq!(
        prepare(temp.path(), request(vec![edit]))
            .err()
            .unwrap()
            .code,
        "UNSUPPORTED_CONTENT"
    );
    let prepared = prepare(temp.path(), request(vec![append(&"日".repeat(40_000))])).unwrap();
    let preview = preview(&prepared);
    assert_eq!(preview["diff_truncated"], true);
    assert!(serde_json::to_vec(&preview).unwrap().len() < MAX_RESULT_BYTES);
    assert!(
        preview["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["unified_diff"].as_str().unwrap().len())
            .sum::<usize>()
            <= MAX_DIFF_BYTES
    );
    assert_eq!(view(&temp)["revision"], 1);
}

#[test]
fn simultaneously_prepared_retries_commit_once() {
    let temp = fixture(vec![p("original")]);
    let request = request(vec![append("once")]);
    let first = prepare(temp.path(), request.clone()).unwrap();
    let second = prepare(temp.path(), request.clone()).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
            barrier.wait();
            commit(&mut store, &first).unwrap()
        });
        let b = scope.spawn(|| {
            let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
            barrier.wait();
            commit(&mut store, &second).unwrap()
        });
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| r["replayed"] == true).count(), 1);
    assert_eq!(view(&temp)["revision"], 2);
    assert_eq!(view(&temp)["total"], 2);
}

#[test]
fn sections_are_scoped_but_share_one_revision_and_preview_does_not_reserve_it() {
    let temp = fixture(vec![p("same phrase")]);
    let initial = view(&temp);
    let child = initial["children"][0]["section_id"].as_str().unwrap();
    let mut child_append = append("same phrase\n\nchild only");
    child_append["section_id"] = child.into();
    run(&temp, request(vec![child_append]));
    let child_before = read_for_edit(temp.path(), child, 100, None).unwrap();
    // Neither the duplicate in the child nor text found only in the child is
    // considered when resolving an operation against the parent's direct Body.
    let root_request = EditRequest {
        expected_revision: 2,
        ..request(vec![replace("same phrase", "parent changed")])
    };
    let prepared_root = prepare(temp.path(), root_request).unwrap();
    assert_eq!(preview(&prepared_root)["status"], "preview");
    let mut child_edit = replace("same phrase", "child changed");
    child_edit["section_id"] = child.into();
    let child_request = EditRequest {
        expected_revision: 2,
        ..request(vec![child_edit])
    };
    let prepared_child = prepare(temp.path(), child_request.clone()).unwrap();
    assert_eq!(
        prepare(
            temp.path(),
            EditRequest {
                expected_revision: 2,
                ..request(vec![replace("child only", "x")])
            }
        )
        .err()
        .unwrap()
        .code,
        "MATCH_NOT_FOUND"
    );
    let mut foreign_block = replace("same phrase", "x");
    foreign_block["section_id"] = child.into();
    foreign_block["block_id"] = initial["blocks"][0]["block_id"].clone();
    assert_eq!(
        prepare(
            temp.path(),
            EditRequest {
                expected_revision: 2,
                ..request(vec![foreign_block])
            }
        )
        .err()
        .unwrap()
        .code,
        "INVALID_TARGET"
    );
    let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
    commit(&mut store, &prepared_root).unwrap();
    assert_eq!(
        commit(&mut store, &prepared_child).unwrap_err().code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        prepare(temp.path(), child_request).err().unwrap().code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        read_for_edit(temp.path(), child, 100, None).unwrap()["blocks"],
        child_before["blocks"]
    );
    assert_eq!(view(&temp)["revision"], 3);
}
#[test]
fn same_gap_insertions_keep_request_order_and_all_operations_use_base_snapshot() {
    let first = p("first");
    let last = p("last");
    let anchor = first["attrs"]["blockId"].clone();
    let temp = fixture(vec![first, last.clone()]);
    let result = run(
        &temp,
        request(vec![
            json!({"op":"insert_markdown","section_id":NOTE,"anchor_block_id":anchor,"position":"after","markdown":"one"}),
            json!({"op":"insert_markdown","section_id":NOTE,"anchor_block_id":last["attrs"]["blockId"],"position":"before","markdown":"two"}),
            replace("last", "end"),
            append("three"),
            append("four"),
        ]),
    );
    assert_eq!(result["created_block_ids"].as_array().unwrap().len(), 4);
    let texts = view(&temp)["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["editable_segments"][0]["text"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        json!(["first", "one", "two", "end", "three", "four"])
            .as_array()
            .unwrap()
            .clone()
    );
    assert_eq!(
        prepare(
            temp.path(),
            EditRequest {
                expected_revision: 2,
                ..request(vec![append("new"), replace("new", "later")])
            }
        )
        .err()
        .unwrap()
        .code,
        "MATCH_NOT_FOUND"
    );
}
#[test]
fn task_markdown_and_state_are_atomic_with_text_edits() {
    let temp = fixture(vec![p("original")]);
    run(
        &temp,
        request(vec![append(
            "- [ ] タスク **重要**\n  - [x] 子\n\n> ordinary quote",
        )]),
    );
    let state = view(&temp);
    let blocks = state["blocks"].as_array().unwrap();
    let task = blocks.iter().find(|b| b["checked"] == false).unwrap()["block_id"].clone();
    let req = EditRequest {
        expected_revision: 2,
        ..request(vec![
            json!({"op":"set_task_checked","section_id":NOTE,"block_id":task,"checked":true}),
            replace("タスク ", "完了 "),
        ])
    };
    let result = run(&temp, req);
    assert_eq!(result["applied_edits"], 2);
    let view = view(&temp);
    assert!(
        view["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["block_id"] == task && b["checked"] == true)
    );
    let duplicate =
        json!({"op":"set_task_checked","section_id":NOTE,"block_id":task,"checked":false});
    assert_eq!(
        prepare(
            temp.path(),
            EditRequest {
                expected_revision: 3,
                ..request(vec![duplicate.clone(), duplicate])
            }
        )
        .err()
        .unwrap()
        .code,
        "OVERLAPPING_EDITS"
    );
}
#[test]
fn noop_receipt_and_dry_run_do_not_advance_content_or_revision() {
    let temp = fixture(vec![p("same")]);
    let epoch = WorkspaceReader::open(temp.path()).unwrap().content_epoch;
    let req = request(vec![replace("same", "same")]);
    let preview = standalone(temp.path(), req.clone(), true).unwrap();
    assert_eq!(preview["status"], "preview");
    assert!(
        receipt(
            &WorkspaceReader::open(temp.path()).unwrap().connection,
            req.clone()
        )
        .unwrap()
        .is_none()
    );
    let result = run(&temp, req.clone());
    assert_eq!(result["status"], "no_change");
    assert_eq!(result["revision_after"], 1);
    assert_eq!(
        WorkspaceReader::open(temp.path()).unwrap().content_epoch,
        epoch
    );
    assert_eq!(run(&temp, req)["replayed"], true);
}
#[test]
fn revision_cursor_and_precommit_failures_are_safe() {
    let temp = fixture(vec![p("first"), p("second")]);
    let cursor = read_for_edit(temp.path(), NOTE, 1, None).unwrap()["next_cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let prepared = prepare(temp.path(), request(vec![replace("first", "changed")])).unwrap();
    let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
    let mut input = PersistenceCommitRequest {
        operation_id: "agent-test".into(),
        scope: "workspace-structure".into(),
        documents: prepared.documents.clone(),
        local_states: vec![],
        search_index_metadata_only_note_id: Some(NOTE.into()),
        fault: Some(crate::persistence::CommitFault::BeforeSqlCommit),
    };
    assert!(store.commit_agent_edit(&input, &prepared).is_err());
    assert_eq!(view(&temp)["revision"], 1);
    assert!(
        receipt(&store.connection, prepared.request.clone())
            .unwrap()
            .is_none()
    );
    input.fault = Some(crate::persistence::CommitFault::AfterCommitResponse);
    assert_eq!(
        store.commit_agent_edit(&input, &prepared).unwrap_err().code,
        "AGENT_RESPONSE_LOST"
    );
    assert_eq!(run(&temp, prepared.request.clone())["replayed"], true);
    assert_eq!(
        read_for_edit(temp.path(), NOTE, 1, Some(&cursor))
            .unwrap_err()
            .code,
        "CURSOR_STALE"
    );
    assert_eq!(
        prepare(temp.path(), request(vec![replace("second", "x")]))
            .err()
            .unwrap()
            .code,
        "REVISION_CONFLICT"
    );
}
#[test]
fn request_and_markdown_limits_reject_without_writes() {
    assert!(parse_request(br#"{"schema_version":1,"schema_version":1}"#).is_err());
    assert!(parse_request(&vec![b' '; MAX_INPUT_BYTES + 1]).is_err());
    let temp = fixture(vec![p("safe")]);
    for markdown in [
        "# title",
        "- # nested title",
        "```\ncode\n```",
        "| A | B |\n|---|---|\n|x|y|",
        "> [!NOTE]\n> alert",
        "<details>hello</details>",
        "![image](https://example.org/a.png)",
        "[link](file:///tmp/file)",
    ] {
        assert_eq!(
            prepare(temp.path(), request(vec![append(markdown)]))
                .err()
                .unwrap()
                .code,
            "UNSUPPORTED_CONTENT",
            "{markdown}"
        );
    }
    assert_eq!(view(&temp)["revision"], 1);
}

#[test]
fn nested_paragraphs_are_editable_but_not_insertion_anchors_or_child_sections() {
    let nested = p("same");
    let direct = p("same");
    let temp = fixture(vec![
        direct.clone(),
        node("blockquote", vec![nested.clone()]),
    ]);
    let before = view(&temp);
    assert!(!before["children"].as_array().unwrap().is_empty());
    assert_eq!(before["blocks"].as_array().unwrap().len(), 3);
    assert_eq!(
        prepare(temp.path(), request(vec![replace("same", "new")]))
            .err()
            .unwrap()
            .code,
        "AMBIGUOUS_MATCH"
    );
    let mut scoped = replace("same", "new");
    scoped["block_id"] = nested["attrs"]["blockId"].clone();
    let result = run(&temp, request(vec![scoped]));
    assert_eq!(result["changed_block_ids"].as_array().unwrap().len(), 2);
    assert_eq!(
        view(&temp)["blocks"][0]["editable_segments"][0]["text"],
        "same"
    );
    assert_eq!(
        view(&temp)["blocks"][2]["editable_segments"][0]["text"],
        "new"
    );
    let insert = json!({"op":"insert_markdown","section_id":NOTE,"anchor_block_id":nested["attrs"]["blockId"],"position":"before","markdown":"no"});
    assert_eq!(
        prepare(
            temp.path(),
            EditRequest {
                expected_revision: 2,
                ..request(vec![insert])
            }
        )
        .err()
        .unwrap()
        .code,
        "INVALID_TARGET"
    );
    assert_eq!(view(&temp)["children"], before["children"]);
}

#[test]
fn base_snapshot_offsets_do_not_shift_and_empty_replacement_keeps_paragraph() {
    let paragraph = p("AAA BBB CCC");
    let temp = fixture(vec![paragraph.clone(), p("delete")]);
    run(
        &temp,
        request(vec![
            replace("AAA", "長い置換😀"),
            replace("CCC", "C"),
            replace("BBB", ""),
            replace("delete", ""),
        ]),
    );
    let result = view(&temp);
    assert_eq!(result["revision"], 2);
    assert_eq!(
        result["blocks"][0]["editable_segments"][0]["text"],
        "長い置換😀  C"
    );
    assert_eq!(
        result["blocks"][0]["block_id"],
        paragraph["attrs"]["blockId"]
    );
    assert_eq!(result["blocks"][1]["kind"], "paragraph");
    assert_eq!(result["blocks"][1]["editable_segments"], json!([]));
}

#[test]
fn native_markdown_preserves_composed_marks_and_escapes_without_fetching_links() {
    let temp = fixture(vec![]);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let blocks = markdown::parse("==plain== ==**bold**== ==_italic_== ==[linked](https://127.0.0.1:1)== ==`code`==\n\n`==literal code==` \\=\\=literal\\=\\= $(not-a-command)", &reader).unwrap();
    let inline = blocks[0]["content"].as_array().unwrap();
    for (text, other) in [
        ("plain", None),
        ("bold", Some("bold")),
        ("italic", Some("italic")),
        ("linked", Some("link")),
        ("code", Some("code")),
    ] {
        let item = inline
            .iter()
            .find(|v| v["text"] == text)
            .unwrap_or_else(|| panic!("missing {text}: {blocks:?}"));
        let marks = item["marks"].as_array().unwrap();
        assert!(marks.iter().any(|m| m["type"] == "highlight"), "{item}");
        if let Some(other) = other {
            assert!(marks.iter().any(|m| m["type"] == other));
        }
    }
    for item in blocks[1]["content"].as_array().unwrap() {
        assert!(
            !item["marks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["type"] == "highlight")
        );
    }
    let link = format!("[target](memoka://workspace/{WORKSPACE}/section/{NOTE})");
    assert_eq!(
        markdown::parse(&link, &reader).unwrap()[0]["content"][0]["type"],
        "internalSectionLink"
    );
    assert!(
        markdown::parse(
            &link.replace(WORKSPACE, "01a30000-0000-7000-8000-000000000099"),
            &reader
        )
        .is_err()
    );
    drop(reader);
    run(&temp, request(vec![append("empty body append")]));
    assert_eq!(
        view(&temp)["blocks"][0]["editable_segments"][0]["text"],
        "empty body append"
    );
}

#[test]
fn limits_rechunk_append_only_without_replacing_existing_yjs_elements() {
    let existing = (0..300).map(|i| p(&format!("old{i}"))).collect::<Vec<_>>();
    let temp = fixture(existing.clone());
    let old = decode_document(
        &load_document(
            &WorkspaceReader::open(temp.path()).unwrap().connection,
            "note",
            NOTE,
        )
        .unwrap(),
    )
    .unwrap();
    let index = projection::Index::new(&old).unwrap();
    let markdown = (0..600).map(|i| format!("new{i}\n\n")).collect::<String>();
    let req = request(vec![append(&markdown)]);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let existing_chunk = {
        let txn = old.transact();
        let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap()
        else {
            panic!()
        };
        let XmlOut::Element(body) = root.get(&txn, 1).unwrap() else {
            panic!()
        };
        let XmlOut::Element(chunk) = body.get(&txn, 0).unwrap() else {
            panic!()
        };
        chunk
    };
    let elements = || {
        existing_chunk
            .children(&old.transact())
            .map(|node| match node {
                XmlOut::Element(node) => node,
                _ => panic!(),
            })
            .collect::<Vec<_>>()
    };
    let existing_elements = elements();
    index
        .plan(&old, &reader, &req)
        .unwrap()
        .apply(&old, &index)
        .unwrap();
    assert_eq!(elements(), existing_elements);
    drop(reader);
    run(&temp, req);
    let view = read_for_edit(temp.path(), NOTE, 1000, None).unwrap();
    assert_eq!(view["total"], 900);
    for (i, block) in existing.iter().enumerate() {
        assert_eq!(view["blocks"][i]["block_id"], block["attrs"]["blockId"]);
    }
    let doc = decode_document(
        &load_document(
            &WorkspaceReader::open(temp.path()).unwrap().connection,
            "note",
            NOTE,
        )
        .unwrap(),
    )
    .unwrap();
    let txn = doc.transact();
    let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap() else {
        panic!()
    };
    let XmlOut::Element(body) = root.get(&txn, 1).unwrap() else {
        panic!()
    };
    for chunk in body.children(&txn) {
        let XmlOut::Element(chunk) = chunk else {
            panic!()
        };
        assert!(chunk.len(&txn) <= 512);
    }
}

#[test]
fn old_database_requires_gui_migration_and_receipts_survive_later_revisions() {
    let temp = fixture(vec![p("safe")]);
    let first = request(vec![append("once")]);
    run(&temp, first.clone());
    run(
        &temp,
        EditRequest {
            expected_revision: 2,
            ..request(vec![replace("safe", "later")])
        },
    );
    let replay = run(&temp, first.clone());
    assert_eq!(replay["revision_after"], 2);
    assert_eq!(view(&temp)["revision"], 3);
    let reader = WorkspaceReader::open(temp.path()).unwrap();
    let copy = temp.path().join("receipt-backup.sqlite3");
    rusqlite::backup::Backup::new(&reader.connection, &mut Connection::open(&copy).unwrap())
        .unwrap()
        .run_to_completion(128, std::time::Duration::from_millis(1), None)
        .unwrap();
    assert_eq!(
        receipt(&Connection::open(copy).unwrap(), first.clone())
            .unwrap()
            .unwrap()["replayed"],
        true
    );
    drop(reader);
    let db = Connection::open(temp.path().join(".memoka/memoka.sqlite3")).unwrap();
    db.execute(
        "UPDATE settings SET value='5' WHERE key='database_schema_version'",
        [],
    )
    .unwrap();
    assert_eq!(
        standalone(temp.path(), request(vec![append("no")]), false)
            .unwrap_err()
            .code,
        "MIGRATION_REQUIRED"
    );
    assert_eq!(
        db.query_row(
            "SELECT value FROM settings WHERE key='database_schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "5"
    );
}
