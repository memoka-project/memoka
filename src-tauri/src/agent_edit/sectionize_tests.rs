use super::*;

fn sectionize(temp: &tempfile::TempDir, section: &str, heading: &Value) -> SectionRequest {
    section_request(
        temp,
        json!({"op":"sectionize","section_id":section,"heading_block_id":heading["attrs"]["blockId"]}),
    )
}

#[test]
fn sectionize_preserves_rich_suffix_and_existing_children_and_replays_atomically() {
    let mut heading = p("日本語😀の見出し");
    heading["content"][0]["marks"] = json!([{"type":"bold"},{"type":"italic"}]);
    let mut linked = p("リンクと装飾");
    linked["content"][0]["marks"] = json!([{"type":"strike"},{"type":"highlight"},{"type":"link","attrs":{"href":"https://example.com"}}]);
    let mut cell = node("tableCell", vec![p("セル")]);
    cell["attrs"]["colspan"] = 2.into();
    cell["attrs"]["rowspan"] = 1.into();
    cell["attrs"]["colwidth"] = json!([80, 120]);
    let mut task = node(
        "listItem",
        vec![
            p("タスク"),
            node("bulletList", vec![node("listItem", vec![p("子")])]),
        ],
    );
    task["attrs"]["checked"] = true.into();
    let mut image = node("image", vec![]);
    image["attrs"]["src"] = "https://example.com/image.png".into();
    image["attrs"]["widthPercent"] = 45.into();
    let blocks = vec![
        p("前文"),
        heading.clone(),
        linked,
        node("table", vec![node("tableRow", vec![cell])]),
        node("bulletList", vec![task]),
        node(
            "codeBlock",
            vec![json!({"type":"text","text":"const x = 1;\n// 😀"})],
        ),
        node("blockquote", vec![p("引用")]),
        node(
            "details",
            vec![
                node("detailsSummary", vec![json!({"type":"text","text":"詳細"})]),
                node("detailsBody", vec![p("詳細本文")]),
            ],
        ),
        image,
        node("horizontalRule", vec![]),
        p(""),
    ];
    let temp = fixture(blocks);
    let before = current_note(&temp);
    let req = sectionize(&temp, NOTE, &heading);
    let preview = standalone(temp.path(), req.clone(), true).unwrap();
    assert_eq!(preview["status"], "preview");
    assert_eq!(preview["changes"][0]["title"], "日本語😀の見出し");
    assert_eq!(preview["changes"][0]["heading_before"], before.root.body[1]);
    assert_eq!(current_note(&temp).root, before.root);
    let applied = run(&temp, req.clone());
    let after = current_note(&temp);
    let new = &after.root.children[0];
    assert_eq!(new.title, "日本語😀の見出し");
    assert_eq!(new.body, before.root.body[2..]);
    assert!(new.children.is_empty());
    assert_eq!(after.root.body, before.root.body[..1]);
    assert_eq!(after.root.children[1..], before.root.children);
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(
        applied["sectionized_heading"],
        json!({"block_id":heading["attrs"]["blockId"],"section_id":new.section_id})
    );
    assert_eq!(
        applied["deleted_block_ids"],
        json!([heading["attrs"]["blockId"]])
    );
    assert_eq!(applied["created_block_ids"], json!([]));
    assert_eq!(
        read_for_edit(temp.path(), &new.section_id, 100, None).unwrap()["parent_section_id"],
        NOTE
    );
    assert_eq!(run(&temp, req)["replayed"], true);
    assert_eq!(current_note(&temp).revision, after.revision);
}

#[test]
fn sectionize_right_to_left_produces_siblings_and_can_consume_all_body_or_last_paragraph() {
    let headings = [p("一"), p("二"), p("三")];
    let temp = fixture(vec![
        headings[0].clone(),
        p("本文1"),
        headings[1].clone(),
        p("本文2"),
        headings[2].clone(),
    ]);
    let before = current_note(&temp);
    for heading in headings.iter().rev() {
        run(&temp, sectionize(&temp, NOTE, heading));
    }
    let after = current_note(&temp);
    assert!(after.root.body.is_empty());
    assert_eq!(
        after.root.children[..3]
            .iter()
            .map(|s| s.title.as_str())
            .collect::<Vec<_>>(),
        ["一", "二", "三"]
    );
    assert_eq!(after.root.children[0].body, before.root.body[1..2]);
    assert_eq!(after.root.children[1].body, before.root.body[3..4]);
    assert!(after.root.children[2].body.is_empty());
    assert_eq!(after.root.children[3..], before.root.children);
    // A non-root direct Paragraph uses the same operation, not a Root-only import.
    let parent = &after.root.children[0].section_id;
    run(
        &temp,
        sectionize(&temp, parent, &after.root.children[0].body[0]),
    );
    assert_eq!(
        current_note(&temp).root.children[0].children[0].title,
        "本文1"
    );
}

#[test]
fn sectionize_bounds_the_affected_suffix_not_the_untouched_prefix() {
    let heading = p("too much");
    let last = p("");
    let mut blocks = vec![heading.clone()];
    blocks.extend((0..5001).map(|_| p("retained")));
    blocks.push(last.clone());
    let temp = fixture(blocks);
    let before = current_note(&temp);
    let error = prepare(temp.path(), sectionize(&temp, NOTE, &heading))
        .err()
        .unwrap();
    assert!(error.message.contains("10000 nodes"));
    assert_eq!(current_note(&temp).root, before.root);
    run(&temp, sectionize(&temp, NOTE, &last));
    let after = current_note(&temp);
    assert_eq!(
        after.root.body,
        before.root.body[..before.root.body.len() - 1]
    );
    assert_eq!(after.root.children[0].title, "");
    assert!(after.root.children[0].body.is_empty());
}

fn root_body(doc: &yrs::Doc) -> yrs::XmlElementRef {
    let txn = doc.transact();
    let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap() else {
        panic!()
    };
    let XmlOut::Element(body) = root.get(&txn, 1).unwrap() else {
        panic!()
    };
    body
}

#[test]
fn sectionize_across_chunks_keeps_prefix_shared_types_and_whole_moved_chunk_ids() {
    for heading_index in [0, 255, 256, 260, 511, 512, 599] {
        let temp = fixture((0..600).map(|n| p(&format!("block {n}"))).collect());
        let store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
        let stored = load_document(&store.connection, "note", NOTE).unwrap();
        let doc = decode_document(&stored).unwrap();
        let body = root_body(&doc);
        projection::split_chunks(&mut doc.transact_mut(), &body).unwrap();
        store
            .connection
            .execute(
                "UPDATE documents SET snapshot=?1 WHERE kind='note' AND document_id=?2",
                params![
                    doc.transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                    NOTE
                ],
            )
            .unwrap();
        drop(store);
        let before = current_note(&temp);
        let req = sectionize(&temp, NOTE, &before.root.body[heading_index]);
        let prepared = prepare(temp.path(), req).unwrap();
        let txn = doc.transact();
        let chunks = body.children(&txn).collect::<Vec<_>>();
        let XmlOut::Element(first_chunk) = &chunks[0] else {
            panic!()
        };
        let XmlOut::Element(prefix) = first_chunk.get(&txn, 0).unwrap() else {
            panic!()
        };
        let whole_ids = chunks
            .iter()
            .skip(heading_index / 256 + 1)
            .map(|c| {
                let XmlOut::Element(c) = c else { panic!() };
                c.get_attribute(&txn, "chunkId").unwrap().to_string(&txn)
            })
            .collect::<Vec<_>>();
        drop(txn);
        use yrs::updates::decoder::Decode;
        doc.transact_mut()
            .apply_update(
                yrs::Update::decode_v1(
                    prepared
                        .documents
                        .iter()
                        .find(|d| d.kind == "note")
                        .unwrap()
                        .update
                        .as_ref()
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let body_after = root_body(&doc);
        assert_eq!(body_after, body);
        if heading_index > 0 {
            let txn = doc.transact();
            let XmlOut::Element(chunk) = body_after.get(&txn, 0).unwrap() else {
                panic!()
            };
            assert_eq!(chunk, *first_chunk);
            let XmlOut::Element(prefix_after) = chunk.get(&txn, 0).unwrap() else {
                panic!()
            };
            assert_eq!(prefix_after, prefix);
        }
        let mut store = ProductStore::open_existing_for_edit(temp.path()).unwrap();
        commit(&mut store, &prepared).unwrap();
        let after = current_note(&temp);
        assert_eq!(after.root.body, before.root.body[..heading_index]);
        assert_eq!(
            after.root.children[0].body,
            before.root.body[heading_index + 1..]
        );
        let txn = doc.transact();
        let XmlOut::Element(root) = txn.get_xml_fragment("body").unwrap().get(&txn, 0).unwrap()
        else {
            panic!()
        };
        let XmlOut::Element(children) = root.get(&txn, 2).unwrap() else {
            panic!()
        };
        let XmlOut::Element(section) = children.get(&txn, 0).unwrap() else {
            panic!()
        };
        let XmlOut::Element(moved) = section.get(&txn, 1).unwrap() else {
            panic!()
        };
        let ids = moved
            .children(&txn)
            .map(|c| {
                let XmlOut::Element(c) = c else { panic!() };
                c.get_attribute(&txn, "chunkId").unwrap().to_string(&txn)
            })
            .collect::<Vec<_>>();
        assert!(whole_ids.iter().all(|id| ids.contains(id)));
    }
}

#[test]
fn sectionize_rejects_nested_or_foreign_targets_link_titles_breaks_conflicts_and_depth() {
    let mut link = p("URL must not be lost");
    link["content"][0]["marks"] = json!([{"type":"link","attrs":{"href":"https://example.com"}}]);
    let breaking = node(
        "paragraph",
        vec![
            json!({"type":"text","text":"line1"}),
            node("hardBreak", vec![]),
            json!({"type":"text","text":"line2"}),
        ],
    );
    let nested = p("list heading");
    let list = node("bulletList", vec![node("listItem", vec![nested.clone()])]);
    let heading = p("heading");
    let temp = fixture(vec![
        link.clone(),
        breaking.clone(),
        list.clone(),
        heading.clone(),
    ]);
    let before = current_note(&temp);
    for (section, target, code) in [
        (NOTE, &link, "UNSUPPORTED_CONTENT"),
        (NOTE, &breaking, "UNSUPPORTED_CONTENT"),
        (NOTE, &nested, "INVALID_TARGET"),
        (NOTE, &list, "INVALID_TARGET"),
        (
            before.root.children[0].section_id.as_str(),
            &heading,
            "INVALID_TARGET",
        ),
    ] {
        assert_eq!(
            prepare(temp.path(), sectionize(&temp, section, target))
                .err()
                .unwrap()
                .code,
            code
        );
        assert_eq!(current_note(&temp).root, before.root);
    }
    let stale = sectionize(&temp, NOTE, &heading);
    let mut parent = NOTE.to_owned();
    for _ in 0..crate::document_model::MAX_SECTION_DEPTH {
        parent = create_section(&temp, &parent, "depth");
    }
    assert_eq!(
        prepare(temp.path(), stale).err().unwrap().code,
        "REVISION_CONFLICT"
    );
    let note = current_note(&temp);
    let mut leaf = &note.root;
    while let Some(child) = leaf.children.iter().find(|s| s.title == "depth") {
        leaf = child;
    }
    assert_eq!(
        prepare(temp.path(), sectionize(&temp, &parent, &leaf.body[0]))
            .err()
            .unwrap()
            .code,
        "SECTION_DEPTH_LIMIT"
    );
    assert_eq!(current_note(&temp).root, note.root);
}
