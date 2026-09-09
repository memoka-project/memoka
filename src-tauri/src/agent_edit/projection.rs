use super::*;
use crate::document_model::Note;
use yrs::types::{Attrs, ToJson};
use yrs::{Doc, Text, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut, XmlTextRef};

#[derive(Clone)]
struct Piece {
    node: XmlTextRef,
    offset: usize,
    len: usize,
}
#[derive(Clone)]
struct Segment {
    text: String,
    attrs: Attrs,
    pieces: Vec<Piece>,
}
struct Block {
    id: String,
    node: XmlElementRef,
    parent: Option<String>,
    segments: Vec<Segment>,
    read_only: Option<&'static str>,
}
struct TopBlock {
    id: String,
    chunk: XmlElementRef,
    offset: u32,
}
pub(super) struct Section {
    body: XmlElementRef,
    blocks: Vec<Block>,
    top: Vec<TopBlock>,
}
pub(super) struct Index {
    pub sections: BTreeMap<String, Section>,
}

fn attr<T: ReadTxn>(node: &XmlElementRef, txn: &T, key: &str) -> String {
    node.get_attribute(txn, key)
        .map(|v| v.to_string(txn))
        .unwrap_or_default()
}
fn checked<T: ReadTxn>(node: &XmlElementRef, txn: &T) -> Option<bool> {
    node.get_attribute(txn, "checked")
        .and_then(|v| match v.to_json(txn) {
            yrs::Any::Bool(v) => Some(v),
            _ => None,
        })
}
fn segments<T: ReadTxn>(node: &XmlElementRef, txn: &T) -> Vec<Segment> {
    let mut result: Vec<Segment> = vec![];
    let mut boundary = true;
    for child in node.children(txn) {
        let XmlOut::Text(text) = child else {
            boundary = true;
            continue;
        };
        let mut offset = 0;
        for delta in text.diff(txn, |_| ()) {
            let yrs::Out::Any(yrs::Any::String(value)) = delta.insert else {
                boundary = true;
                continue;
            };
            let attrs = delta.attributes.map(|v| *v).unwrap_or_default();
            if !value.is_empty() {
                if boundary || result.last().is_none_or(|s| s.attrs != attrs) {
                    result.push(Segment {
                        text: String::new(),
                        attrs,
                        pieces: vec![],
                    });
                }
                let segment = result.last_mut().unwrap();
                segment.text.push_str(&value);
                segment.pieces.push(Piece {
                    node: text.clone(),
                    offset,
                    len: value.len(),
                });
                boundary = false;
            }
            offset += value.len();
        }
    }
    result
}

impl Index {
    pub fn new(doc: &Doc) -> Result<Self, ReadError> {
        let txn = doc.transact();
        let body = txn
            .get_xml_fragment("body")
            .ok_or_else(|| invalid("Missing Note body"))?;
        let mut pending = body.children(&txn).collect::<Vec<_>>();
        let mut sections = BTreeMap::new();
        while let Some(XmlOut::Element(section)) = pending.pop() {
            let parts = section.children(&txn).collect::<Vec<_>>();
            let [
                XmlOut::Element(header),
                XmlOut::Element(body),
                XmlOut::Element(children),
            ] = parts.as_slice()
            else {
                return Err(invalid("Invalid Section structure"));
            };
            pending.extend(children.children(&txn));
            let id = attr(header, &txn, "sectionId");
            let mut entry = Section {
                body: body.clone(),
                blocks: vec![],
                top: vec![],
            };
            for chunk in body.children(&txn) {
                let XmlOut::Element(chunk) = chunk else {
                    return Err(invalid("Invalid BodyChunk"));
                };
                for (offset, block) in chunk.children(&txn).enumerate() {
                    let XmlOut::Element(block) = block else {
                        return Err(invalid("Invalid body Block"));
                    };
                    entry.top.push(TopBlock {
                        id: attr(&block, &txn, "blockId"),
                        chunk: chunk.clone(),
                        offset: offset as u32,
                    });
                    let mut nested = vec![(block, None, false)];
                    while let Some((node, parent, protected)) = nested.pop() {
                        let name = node.tag().as_ref();
                        let protected = protected
                            || matches!(
                                name,
                                "table"
                                    | "tableRow"
                                    | "tableCell"
                                    | "tableHeader"
                                    | "codeBlock"
                                    | "sourceBlock"
                                    | "detailsSummary"
                            );
                        let block_id = attr(&node, &txn, "blockId");
                        let editable = name == "paragraph" && !protected;
                        let mut text_segments = if editable {
                            segments(&node, &txn)
                        } else {
                            vec![]
                        };
                        let too_large = editable && {
                            let mut remaining = 2_000_000;
                            let value = crate::document_model::xml_json(
                                &txn,
                                XmlOut::Element(node.clone()),
                                0,
                                &mut BTreeSet::new(),
                                &mut remaining,
                            )?
                            .pop()
                            .unwrap();
                            let text = serde_json::to_vec(
                                &text_segments
                                    .iter()
                                    .map(|s| json!({"text":s.text}))
                                    .collect::<Vec<_>>(),
                            )?
                            .len();
                            let markdown =
                                serde_json::to_vec(&crate::markdown_read::block_markdown(
                                    &value,
                                    "00000000-0000-7000-8000-000000000000",
                                ))?
                                .len();
                            text + markdown + 1024 > 256 * 1024
                        };
                        if too_large {
                            text_segments.clear();
                        }
                        entry.blocks.push(Block {
                            id: block_id.clone(),
                            node: node.clone(),
                            parent,
                            segments: text_segments,
                            read_only: if too_large {
                                Some("BLOCK_TOO_LARGE")
                            } else if editable {
                                None
                            } else {
                                Some("TEXT_EDIT_UNSUPPORTED")
                            },
                        });
                        let children = node
                            .children(&txn)
                            .filter_map(|child| match child {
                                XmlOut::Element(child)
                                    if !matches!(
                                        child.tag().as_ref(),
                                        "hardBreak" | "internalSectionLink"
                                    ) =>
                                {
                                    Some((child, Some(block_id.clone()), protected))
                                }
                                _ => None,
                            })
                            .collect::<Vec<_>>();
                        nested.extend(children.into_iter().rev());
                    }
                }
            }
            sections.insert(id, entry);
        }
        Ok(Self { sections })
    }

    pub fn read(
        &self,
        doc: &Doc,
        note: &Note,
        workspace_id: &str,
        section_id: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<Value, ReadError> {
        if !(1..=1000).contains(&limit) {
            return Err(invalid("limit must be between 1 and 1000"));
        }
        let section = &self.sections[section_id];
        let prefix = format!(
            "edit-v1:{workspace_id}:{}:{section_id}:{}:",
            note.note_id, note.revision
        );
        let start = cursor
            .map(|c| {
                c.strip_prefix(&prefix)
                    .and_then(|v| v.parse::<usize>().ok())
                    .ok_or_else(|| {
                        ReadError::new(
                            "CURSOR_STALE",
                            "Read this Section again; the target or Note revision changed",
                        )
                    })
            })
            .transpose()?
            .unwrap_or(0);
        if start > section.blocks.len() {
            return Err(invalid("cursor is out of range"));
        }
        let txn = doc.transact();
        let mut blocks = Vec::new();
        let mut bytes = 0;
        let mut end = start;
        for block in section.blocks.iter().skip(start).take(limit) {
            let mut remaining = 2_000_000;
            let value = crate::document_model::xml_json(
                &txn,
                XmlOut::Element(block.node.clone()),
                0,
                &mut BTreeSet::new(),
                &mut remaining,
            )?
            .pop()
            .unwrap();
            let mut row = json!({"block_id":block.id,"kind":block.node.tag().as_ref(),"parent_block_id":block.parent,"insert_anchor":block.parent.is_none(),
                "editable_segments":block.segments.iter().map(|s|json!({"text":s.text})).collect::<Vec<_>>(),
                "markdown":crate::markdown_read::block_markdown(&value,workspace_id)});
            if let Some(reason) = block.read_only {
                row["read_only_reason"] = reason.into();
            }
            if block.read_only == Some("BLOCK_TOO_LARGE") {
                row["markdown"] = Value::Null;
                row["omitted"] = true.into();
            }
            if block.node.tag().as_ref() == "listItem" {
                row["checked"] = json!(checked(&block.node, &txn));
            }
            if serde_json::to_vec(&row)?.len() > 256 * 1024 {
                row["editable_segments"] = json!([]);
                row["markdown"] = Value::Null;
                row["read_only_reason"] = "BLOCK_TOO_LARGE".into();
                row["omitted"] = true.into();
            }
            let size = serde_json::to_vec(&row)?.len();
            if bytes + size > MAX_INPUT_BYTES && !blocks.is_empty() {
                break;
            }
            bytes += size;
            blocks.push(row);
            end += 1;
        }
        let mut pending = vec![&note.root];
        let mut children = vec![];
        while let Some(section) = pending.pop() {
            if section.section_id == section_id {
                children = section
                    .children
                    .iter()
                    .map(|child| json!({"section_id":child.section_id,"title":child.title}))
                    .collect();
                break;
            }
            pending.extend(&section.children);
        }
        let result = json!({"schema_version":1,"representation":"edit_view","source":"current","workspace_id":workspace_id,"note_id":note.note_id,
            "section_id":section_id,"revision":note.revision,"scope":"body","blocks":blocks,"children":children,"total":section.blocks.len(),
            "next_cursor":if end<section.blocks.len(){Some(format!("{prefix}{end}"))}else{None}});
        if serde_json::to_vec(&result)?.len() > MAX_RESULT_BYTES {
            return Err(invalid("Section edit view exceeds the response limit"));
        }
        Ok(result)
    }

    pub fn plan(
        &self,
        doc: &Doc,
        reader: &WorkspaceReader,
        request: &EditRequest,
    ) -> Result<Changes, ReadError> {
        let txn = doc.transact();
        let mut result = Changes::default();
        for (operation_index, edit) in request.edits.iter().enumerate() {
            let action = (|| {
                let section = self.sections.get(edit.section_id()).ok_or_else(|| {
                    ReadError::new("INVALID_TARGET", "Section does not belong to this Note")
                })?;
                match edit {
                    Edit::ReplaceText {
                        block_id,
                        old_text,
                        new_text,
                        ..
                    } => {
                        let blocks = section
                            .blocks
                            .iter()
                            .filter(|b| block_id.as_ref().is_none_or(|id| id == &b.id))
                            .collect::<Vec<_>>();
                        if blocks.is_empty() && block_id.is_some() {
                            return Err(ReadError::new(
                                "INVALID_TARGET",
                                "Block does not belong to this Section body",
                            ));
                        }
                        if block_id.is_some() && blocks.iter().all(|b| b.read_only.is_some()) {
                            return Err(unsupported("This Block does not expose editable text"));
                        }
                        let mut matches = vec![];
                        let mut count = 0;
                        for block in blocks {
                            for (segment_index, segment) in block.segments.iter().enumerate() {
                                // char_indices counts overlapping matches and never splits UTF-8.
                                for (start, _) in
                                    segment.text.char_indices().filter(|(start, _)| {
                                        segment.text[*start..].starts_with(old_text)
                                    })
                                {
                                    count += 1;
                                    if matches.len() < 5 {
                                        matches.push((block, segment_index, start));
                                    }
                                }
                            }
                        }
                        if count == 0 {
                            return Err(ReadError::new(
                                "MATCH_NOT_FOUND",
                                "old_text was not found in one editable segment",
                            ));
                        }
                        if count > 1 {
                            return Err(ReadError::new("AMBIGUOUS_MATCH","old_text must match exactly once; narrow the Block or text")
                            .with_details(json!({"count":count,"candidates":matches.iter().map(|(b,i,start)|json!({"block_id":b.id,"context":b.segments[*i].text[*start..].chars().take(80).collect::<String>()})).collect::<Vec<_>>(),"truncated":count>5})));
                        }
                        let (block, segment_index, start) = matches[0];
                        let end = start + old_text.len();
                        if result.replacements.iter().any(|r| {
                            r.block == block.id
                                && r.segment_index == segment_index
                                && start < r.end
                                && r.start < end
                        }) {
                            return Err(ReadError::new(
                                "OVERLAPPING_EDITS",
                                "Replacement ranges overlap",
                            ));
                        }
                        result.replacements.push(Replacement {
                            block: block.id.clone(),
                            segment_index,
                            segment: block.segments[segment_index].clone(),
                            start,
                            end,
                            new_text: new_text.clone(),
                            changed: old_text != new_text,
                        });
                        if old_text != new_text {
                            result.count += 1;
                        }
                    }
                    Edit::SetTaskChecked {
                        block_id,
                        checked: desired,
                        ..
                    } => {
                        let block = section
                            .blocks
                            .iter()
                            .find(|b| &b.id == block_id)
                            .ok_or_else(|| {
                                ReadError::new(
                                    "INVALID_TARGET",
                                    "Task does not belong to this Section body",
                                )
                            })?;
                        let current = checked(&block.node, &txn)
                            .filter(|_| block.node.tag().as_ref() == "listItem")
                            .ok_or_else(|| {
                                unsupported("set_task_checked requires an existing task ListItem")
                            })?;
                        if result.tasks.iter().any(|t| &t.id == block_id) {
                            return Err(ReadError::new(
                                "OVERLAPPING_EDITS",
                                "Task state is assigned more than once",
                            ));
                        }
                        result.tasks.push(Task {
                            id: block_id.clone(),
                            node: block.node.clone(),
                            checked: *desired,
                            changed: current != *desired,
                        });
                        if current != *desired {
                            result.count += 1;
                        }
                    }
                    Edit::AppendMarkdown { markdown, .. }
                    | Edit::InsertMarkdown { markdown, .. } => {
                        let gap=match edit {
                            Edit::InsertMarkdown {anchor_block_id,position,..}=> section.top.iter().position(|b|&b.id==anchor_block_id).map(|i|i+usize::from(matches!(position,InsertPosition::After)))
                                .ok_or_else(||ReadError::new("INVALID_TARGET","Insertion anchors must be top-level Blocks in this Section body"))?,
                            _=>section.top.len(),
                        };
                        let blocks = markdown::parse(markdown, reader)?;
                        let ids = block_ids(&blocks);
                        result.created.extend(ids);
                        if result.created.len() > MAX_NEW_BLOCKS {
                            return Err(invalid("Batch creates too many Blocks"));
                        }
                        result
                            .gaps
                            .entry((edit.section_id().to_owned(), gap))
                            .or_default()
                            .extend(blocks);
                        result.count += 1;
                    }
                }
                Ok(())
            })();
            if let Err(mut error) = action {
                if !error.details.is_object() {
                    error.details = json!({});
                }
                error.details["operation_index"] = operation_index.into();
                error.details["section_id"] = edit.section_id().into();
                return Err(error);
            }
        }
        Ok(result)
    }
}

struct Replacement {
    block: String,
    segment_index: usize,
    segment: Segment,
    start: usize,
    end: usize,
    new_text: String,
    changed: bool,
}
struct Task {
    id: String,
    node: XmlElementRef,
    checked: bool,
    changed: bool,
}
#[derive(Default)]
pub(super) struct Changes {
    replacements: Vec<Replacement>,
    tasks: Vec<Task>,
    gaps: BTreeMap<(String, usize), Vec<Value>>,
    created: Vec<String>,
    count: usize,
}
impl Changes {
    pub fn changed_count(&self) -> usize {
        self.count
    }
    pub fn apply(
        mut self,
        doc: &Doc,
        index: &Index,
    ) -> Result<(BTreeSet<String>, Vec<String>), ReadError> {
        let mut changed = BTreeSet::new();
        let mut txn = doc.transact_mut();
        self.replacements.sort_by(|a, b| {
            (&b.block, b.segment_index, b.start).cmp(&(&a.block, a.segment_index, a.start))
        });
        for replacement in self.replacements.iter().filter(|r| r.changed) {
            let mut offset = 0;
            let mut deletions = vec![];
            let mut insertion = None;
            for piece in &replacement.segment.pieces {
                let from = replacement.start.max(offset);
                let to = replacement.end.min(offset + piece.len);
                if from < to {
                    let local = piece.offset + from - offset;
                    insertion.get_or_insert((piece.node.clone(), local));
                    deletions.push((piece.node.clone(), local, to - from));
                }
                offset += piece.len;
            }
            for (text, start, len) in deletions.into_iter().rev() {
                text.remove_range(&mut txn, start as u32, len as u32);
            }
            if let Some((text, offset)) = insertion {
                if !replacement.new_text.is_empty() {
                    text.insert_with_attributes(
                        &mut txn,
                        offset as u32,
                        &replacement.new_text,
                        replacement.segment.attrs.clone(),
                    );
                }
            }
            changed.insert(replacement.block.clone());
        }
        for task in self.tasks.iter().filter(|t| t.changed) {
            task.node
                .insert_attribute(&mut txn, "checked", task.checked);
            changed.insert(task.id.clone());
        }
        for section in index.sections.values() {
            let parents = section
                .blocks
                .iter()
                .map(|block| (block.id.as_str(), block.parent.as_deref()))
                .collect::<BTreeMap<_, _>>();
            for id in changed.clone() {
                let mut parent = parents.get(id.as_str()).copied().flatten();
                while let Some(id) = parent {
                    changed.insert(id.to_owned());
                    parent = parents.get(id).copied().flatten();
                }
            }
        }
        let mut changed_sections = index
            .sections
            .iter()
            .filter(|(_, section)| section.blocks.iter().any(|b| changed.contains(&b.id)))
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>();
        for ((section_id, gap), blocks) in self.gaps.into_iter().rev() {
            let section = &index.sections[&section_id];
            let (chunk, offset) = if let Some(anchor) = section.top.get(gap) {
                (anchor.chunk.clone(), anchor.offset)
            } else if let Some(last) = section.top.last() {
                let estimated = blocks.iter().map(json_text_len).sum::<usize>();
                if last.chunk.len(&txn) as usize + blocks.len() > 512
                    || xml_text_len(&txn, &XmlOut::Element(last.chunk.clone())) + estimated
                        > 256 * 1024
                {
                    // Fresh append-only chunks leave the existing Yjs elements
                    // (and users' Undo references to them) untouched.
                    let chunk = section
                        .body
                        .push_back(&mut txn, XmlElementPrelim::empty("bodyChunk"));
                    chunk.insert_attribute(&mut txn, "chunkId", uuid::Uuid::now_v7().to_string());
                    (chunk, 0)
                } else {
                    (last.chunk.clone(), last.offset + 1)
                }
            } else {
                let chunk = section
                    .body
                    .push_back(&mut txn, XmlElementPrelim::empty("bodyChunk"));
                chunk.insert_attribute(&mut txn, "chunkId", uuid::Uuid::now_v7().to_string());
                (chunk, 0)
            };
            for (ordinal, block) in blocks.iter().enumerate() {
                insert_block(&mut txn, &chunk, offset + ordinal as u32, block)?;
            }
            changed_sections.insert(section_id);
        }
        for section_id in changed_sections {
            split_chunks(&mut txn, &index.sections[&section_id].body)?;
        }
        Ok((changed, self.created))
    }
}

fn json_text_len(node: &Value) -> usize {
    node["text"].as_str().map_or(0, str::len)
        + 64
        + node["content"]
            .as_array()
            .map_or(0, |children| children.iter().map(json_text_len).sum())
}

fn block_ids(blocks: &[Value]) -> Vec<String> {
    let mut result = Vec::new();
    let mut pending = blocks.iter().rev().collect::<Vec<_>>();
    while let Some(block) = pending.pop() {
        if let Some(id) = block["attrs"]["blockId"].as_str() {
            result.push(id.to_string());
        }
        if let Some(children) = block["content"].as_array() {
            pending.extend(children.iter().rev());
        }
    }
    result
}

pub(super) fn insert_block(
    txn: &mut yrs::TransactionMut,
    parent: &XmlElementRef,
    offset: u32,
    value: &Value,
) -> Result<XmlElementRef, ReadError> {
    let node = parent.insert(
        txn,
        offset,
        XmlElementPrelim::empty(
            value["type"]
                .as_str()
                .ok_or_else(|| invalid("Missing Block type"))?,
        ),
    );
    if let Some(attrs) = value["attrs"].as_object() {
        for (key, value) in attrs {
            node.insert_attribute(
                txn,
                key.as_str(),
                yrs::Any::from_json(&value.to_string())
                    .map_err(|_| invalid("Invalid Block attribute"))?,
            );
        }
    }
    if let Some(children) = value["content"].as_array() {
        let mut text: Option<XmlTextRef> = None;
        for child in children {
            if child["type"] == "text" {
                let target = text
                    .get_or_insert_with(|| node.push_back(txn, yrs::XmlTextPrelim::new("")))
                    .clone();
                let mut attrs = Attrs::new();
                for mark in child["marks"].as_array().map_or(&[][..], Vec::as_slice) {
                    let name = mark["type"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid mark"))?;
                    let attributes = mark.get("attrs").cloned().unwrap_or_else(|| json!({}));
                    attrs.insert(
                        name.into(),
                        yrs::Any::from_json(&attributes.to_string())
                            .map_err(|_| invalid("Invalid mark attributes"))?,
                    );
                }
                let end = target.len(txn);
                target.insert_with_attributes(
                    txn,
                    end,
                    child["text"].as_str().unwrap_or(""),
                    attrs,
                );
            } else {
                text = None;
                insert_block(txn, &node, node.len(txn), child)?;
            }
        }
    }
    Ok(node)
}

pub(super) fn split_chunks(txn: &mut yrs::TransactionMut, body: &XmlElementRef) -> Result<(), ReadError> {
    let chunks = body.children(txn).collect::<Vec<_>>();
    for (chunk_index, chunk) in chunks.into_iter().enumerate().rev() {
        let XmlOut::Element(chunk) = chunk else {
            return Err(invalid("Invalid chunk"));
        };
        let children = chunk.children(txn).collect::<Vec<_>>();
        let sizes = children
            .iter()
            .map(|b| xml_text_len(txn, b) + 64)
            .collect::<Vec<_>>();
        if children.len() <= 512 && sizes.iter().sum::<usize>() <= 256 * 1024 {
            continue;
        }
        let mut starts = vec![0usize];
        let mut bytes = 0;
        let mut count = 0;
        for (index, size) in sizes.iter().enumerate() {
            if count > 0 && (count >= 256 || bytes + size > 128 * 1024) {
                starts.push(index);
                bytes = 0;
                count = 0;
            }
            bytes += size;
            count += 1;
        }
        if starts.len() < 2 {
            continue;
        }
        starts.push(children.len());
        for (group, bounds) in starts.windows(2).enumerate().skip(1) {
            let next = body.insert(
                txn,
                (chunk_index + group) as u32,
                XmlElementPrelim::empty("bodyChunk"),
            );
            next.insert_attribute(txn, "chunkId", uuid::Uuid::now_v7().to_string());
            for child in &children[bounds[0]..bounds[1]] {
                crate::document_model::clone_xml_into(txn, child, &next)?;
            }
        }
        chunk.remove_range(txn, starts[1] as u32, (children.len() - starts[1]) as u32);
    }
    Ok(())
}
fn xml_text_len<T: ReadTxn>(txn: &T, node: &XmlOut) -> usize {
    match node {
        XmlOut::Text(text) => text
            .diff(txn, |_| ())
            .iter()
            .map(|d| match &d.insert {
                yrs::Out::Any(yrs::Any::String(s)) => s.len(),
                _ => 0,
            })
            .sum(),
        XmlOut::Element(el) => el.children(txn).map(|c| xml_text_len(txn, &c)).sum(),
        _ => 0,
    }
}
