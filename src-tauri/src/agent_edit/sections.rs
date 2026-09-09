//! Same-Note Section structure edits. Only the moved subtree is cloned;
//! unrelated Yjs types and every retained logical identity stay intact.
use super::*;
use crate::document_model::{MAX_SECTION_DEPTH, Note, Section, clone_xml_at};
use crate::persistence::PersistedDocument;
use yrs::types::ToJson;
use yrs::{Doc, Text, Xml, XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut, XmlTextPrelim};

pub(super) const MAX_SUBTREE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SectionRequest {
    #[schemars(range(min = 1, max = 1))]
    pub schema_version: u32,
    pub workspace_id: String,
    pub note_id: String,
    /// Note-wide revision from a fresh read --for-edit, not Workspace revision.
    #[schemars(range(min = 1, max = 9_007_199_254_740_991_i64))]
    pub expected_revision: i64,
    pub request_id: String,
    /// One structural operation. Read the result before constructing the next.
    pub action: SectionAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SectionPlacement {
    First,
    Last,
    Before { section_id: String },
    After { section_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMode {
    /// Only a childless Section whose Body contains no content except empty paragraphs.
    Empty,
    /// Explicitly remove the Section, its Body, and all descendant Sections.
    Subtree,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum SectionAction {
    /// Create a child with a fresh Section ID; existing parent Body stays intact.
    Create {
        parent_section_id: String,
        placement: SectionPlacement,
        title: String,
        /// Optional initial Body, using the same Markdown subset as append_markdown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        markdown: Option<String>,
    },
    /// Rename a non-root title as literal single-line text.
    Rename { section_id: String, title: String },
    /// Convert one direct Body Paragraph to a plain child title. Its following
    /// Body blocks become that first child's Body; existing children stay put.
    Sectionize {
        section_id: String,
        heading_block_id: String,
    },
    /// Reparent/reorder a non-root Section with all Body and descendants, in the same Note.
    Move {
        section_id: String,
        parent_section_id: String,
        placement: SectionPlacement,
    },
    /// Delete a non-root Section. Content removal requires explicit mode: subtree.
    Delete {
        section_id: String,
        mode: DeleteMode,
    },
}

impl SectionRequest {
    pub fn validate(&self) -> Result<(), ReadError> {
        validate_note_envelope(
            self.schema_version,
            &self.workspace_id,
            &self.note_id,
            self.expected_revision,
            &self.request_id,
        )?;
        if serde_json::to_vec(self)?.len() > MAX_INPUT_BYTES {
            return Err(invalid("Section request exceeds 1 MiB"));
        }
        match &self.action {
            SectionAction::Create {
                parent_section_id,
                placement,
                title,
                ..
            } => {
                validate_id(parent_section_id)?;
                validate_placement(placement)?;
                notes::validate_title(title)?;
            }
            SectionAction::Rename { section_id, title } => {
                self.non_root(section_id)?;
                notes::validate_title(title)?;
            }
            SectionAction::Sectionize {
                section_id,
                heading_block_id,
            } => {
                validate_id(section_id)?;
                validate_id(heading_block_id)?;
            }
            SectionAction::Move {
                section_id,
                parent_section_id,
                placement,
            } => {
                self.non_root(section_id)?;
                validate_id(parent_section_id)?;
                validate_placement(placement)?;
            }
            SectionAction::Delete { section_id, .. } => self.non_root(section_id)?,
        }
        Ok(())
    }

    fn non_root(&self, id: &str) -> Result<(), ReadError> {
        validate_id(id)?;
        if id == self.note_id {
            return Err(ReadError::new(
                "INVALID_TARGET",
                "Root cannot be renamed, moved or deleted here; rename a Note with note-edit",
            ));
        }
        Ok(())
    }
}

fn validate_placement(placement: &SectionPlacement) -> Result<(), ReadError> {
    if let SectionPlacement::Before { section_id } | SectionPlacement::After { section_id } =
        placement
    {
        validate_id(section_id)?;
    }
    Ok(())
}

struct Entry<'a> {
    model: &'a Section,
    node: XmlElementRef,
    header: XmlElementRef,
    body: XmlElementRef,
    children: XmlElementRef,
    parent_id: Option<&'a str>,
    index: u32,
    depth: usize,
}
struct Tree<'a> {
    entries: BTreeMap<&'a str, Entry<'a>>,
}
impl<'a> Tree<'a> {
    fn new(doc: &Doc, note: &'a Note) -> Result<Self, ReadError> {
        let txn = doc.transact();
        let fragment = txn
            .get_xml_fragment("body")
            .ok_or_else(|| invalid("Missing body"))?;
        let Some(XmlOut::Element(root)) = fragment.get(&txn, 0) else {
            return Err(invalid("Missing Root Section"));
        };
        let mut entries = BTreeMap::new();
        let mut pending = vec![(&note.root, root, None, 0, 0)];
        while let Some((model, node, parent_id, index, depth)) = pending.pop() {
            let Some(XmlOut::Element(header)) = node.get(&txn, 0) else {
                return Err(invalid("Missing Section header"));
            };
            let Some(XmlOut::Element(children)) = node.get(&txn, 2) else {
                return Err(invalid("Missing Section children"));
            };
            let Some(XmlOut::Element(body)) = node.get(&txn, 1) else {
                return Err(invalid("Missing Section body"));
            };
            for (index, child) in model.children.iter().enumerate() {
                let Some(XmlOut::Element(xml)) = children.get(&txn, index as u32) else {
                    return Err(invalid("Missing child Section"));
                };
                pending.push((
                    child,
                    xml,
                    Some(model.section_id.as_str()),
                    index as u32,
                    depth + 1,
                ));
            }
            entries.insert(
                model.section_id.as_str(),
                Entry {
                    model,
                    node,
                    header,
                    body,
                    children,
                    parent_id,
                    index,
                    depth,
                },
            );
        }
        Ok(Self { entries })
    }

    fn get(&self, id: &str) -> Result<&Entry<'a>, ReadError> {
        self.entries.get(id).ok_or_else(|| {
            ReadError::new(
                "INVALID_TARGET",
                "Section must belong to the requested live Note",
            )
            .with_details(json!({"section_id":id}))
        })
    }

    fn destination(
        &self,
        moving: Option<&str>,
        parent: &str,
        placement: &SectionPlacement,
    ) -> Result<u32, ReadError> {
        let mut ancestor = Some(parent);
        while let Some(id) = ancestor {
            if Some(id) == moving {
                return Err(ReadError::new(
                    "INVALID_TARGET",
                    "Cannot move below self or a descendant",
                ));
            }
            ancestor = self.get(id)?.parent_id;
        }
        let siblings = self
            .get(parent)?
            .model
            .children
            .iter()
            .filter(|s| Some(s.section_id.as_str()) != moving)
            .collect::<Vec<_>>();
        let offset = match placement {
            SectionPlacement::First => 0,
            SectionPlacement::Last => siblings.len(),
            SectionPlacement::Before { section_id } | SectionPlacement::After { section_id } => {
                let index = siblings
                    .iter()
                    .position(|s| &s.section_id == section_id)
                    .ok_or_else(|| {
                        ReadError::new(
                            "INVALID_TARGET",
                            "Anchor must be another direct child of the destination parent",
                        )
                    })?;
                index + usize::from(matches!(placement, SectionPlacement::After { .. }))
            }
        };
        Ok(offset as u32)
    }
}

fn subtree_info(section: &Section) -> Result<(Vec<String>, Vec<String>, usize), ReadError> {
    let mut section_ids = vec![];
    let mut block_ids = vec![];
    let mut height = 0;
    let mut remaining = MAX_NEW_BLOCKS;
    let mut pending = vec![(section, 0)];
    while let Some((section, depth)) = pending.pop() {
        remaining = remaining
            .checked_sub(1)
            .ok_or_else(|| invalid("Section subtree exceeds 10000 nodes"))?;
        section_ids.push(section.section_id.clone());
        height = height.max(depth);
        let mut blocks = section.body.iter().collect::<Vec<_>>();
        while let Some(block) = blocks.pop() {
            remaining = remaining
                .checked_sub(1)
                .ok_or_else(|| invalid("Section subtree exceeds 10000 nodes"))?;
            if let Some(id) = block["attrs"]["blockId"].as_str() {
                block_ids.push(id.to_owned());
            }
            if let Some(children) = block["content"].as_array() {
                blocks.extend(children);
            }
        }
        pending.extend(section.children.iter().rev().map(|s| (s, depth + 1)));
    }
    if serde_json::to_vec(section)?.len() > MAX_SUBTREE_BYTES {
        return Err(invalid(
            "Section subtree exceeds 8 MiB; edit a smaller subtree",
        ));
    }
    Ok((section_ids, block_ids, height))
}

fn check_depth(depth: usize) -> Result<(), ReadError> {
    if depth > MAX_SECTION_DEPTH {
        Err(ReadError::new(
            "SECTION_DEPTH_LIMIT",
            "Section depth exceeds the Note's supported limit",
        )
        .with_details(json!({"depth":depth,"max_depth":MAX_SECTION_DEPTH})))
    } else {
        Ok(())
    }
}

fn paragraph_title(paragraph: &Value) -> Result<String, ReadError> {
    if paragraph["type"] != "paragraph" {
        return Err(ReadError::new(
            "INVALID_TARGET",
            "Heading must be a direct Body Paragraph",
        ));
    }
    let mut title = String::new();
    for inline in paragraph["content"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
    {
        // Section titles are plain text. Do not silently lose link destinations,
        // dynamic labels, hard breaks or unknown semantic marks in the heading.
        if inline["type"] != "text"
            || inline["marks"].as_array().is_some_and(|marks| {
                marks.iter().any(|mark| {
                    !matches!(
                        mark["type"].as_str(),
                        Some("bold" | "italic" | "strike" | "code" | "highlight")
                    )
                })
            })
        {
            return Err(ReadError::new(
                "UNSUPPORTED_CONTENT",
                "Heading must be single-line text without links or inline atoms; text styling becomes Section styling",
            ));
        }
        title.push_str(inline["text"].as_str().unwrap_or(""));
    }
    notes::validate_title(&title)?;
    Ok(title)
}

/// Keep the prefix's existing Yjs types. Only the transferred suffix is cloned,
/// because integrated shared types cannot be reparented. Whole moved chunks keep
/// their IDs; splitting the boundary chunk needs a fresh chunk ID.
fn transfer_body_suffix(
    txn: &mut yrs::TransactionMut<'_>,
    source: &XmlElementRef,
    target: &XmlElementRef,
    heading_index: usize,
) -> Result<(), ReadError> {
    let chunks = source.children(txn).collect::<Vec<_>>();
    let mut offset = heading_index as u32;
    for (index, chunk) in chunks.iter().enumerate() {
        let XmlOut::Element(chunk) = chunk else {
            return Err(invalid("Invalid BodyChunk"));
        };
        let length = chunk.len(txn);
        if offset >= length {
            offset -= length;
            continue;
        }
        let trailing = chunk
            .children(txn)
            .skip(offset as usize + 1)
            .collect::<Vec<_>>();
        if !trailing.is_empty() {
            let copy = target.push_back(txn, XmlElementPrelim::empty("bodyChunk"));
            let attrs = chunk
                .attributes(txn)
                .map(|(key, value)| (key.to_owned(), value.to_json(txn)))
                .collect::<Vec<_>>();
            for (key, value) in attrs {
                copy.insert_attribute(txn, key, value);
            }
            copy.insert_attribute(txn, "chunkId", uuid::Uuid::now_v7().to_string());
            for block in trailing {
                clone_xml_at(txn, &block, &copy, copy.len(txn))?;
            }
        }
        for chunk in &chunks[index + 1..] {
            clone_xml_at(txn, chunk, target, target.len(txn))?;
        }
        let removal = index + usize::from(offset > 0);
        if offset > 0 {
            chunk.remove_range(txn, offset, length - offset);
        }
        let count = chunks.len() - removal;
        if count > 0 {
            source.remove_range(txn, removal as u32, count as u32);
        }
        return Ok(());
    }
    Err(invalid("Heading disappeared from Section Body"))
}

pub(super) fn prepare(
    workspace: &Path,
    request: SectionRequest,
) -> Result<PreparedEdit, ReadError> {
    request.validate()?;
    let reader = WorkspaceReader::open(workspace)?;
    require_edit_schema(&reader)?;
    if reader.workspace_id != request.workspace_id {
        return Err(ReadError::new(
            "WORKSPACE_MISMATCH",
            "Workspace identity does not match",
        ));
    }
    let agent = AgentRequest::from(request.clone());
    let fingerprint = agent.fingerprint()?;
    if let Some(result) = receipt(&reader.connection, agent.clone())? {
        return Ok(PreparedEdit {
            request: agent,
            fingerprint,
            documents: vec![],
            result,
            workspace_revision: reader.workspace_revision,
            replayed: true,
        });
    }
    live_note(&reader, &request.note_id)?;
    let stored = load_document(&reader.connection, "note", &request.note_id)?;
    if stored.schema_version != 6 {
        return Err(ReadError::new(
            "MIGRATION_REQUIRED",
            "Open the Note in the updated GUI first",
        ));
    }
    check_revision(request.expected_revision, stored.revision)?;
    let before = read_note(&stored, false)?;
    let doc = decode_document(&stored)?;
    let vector = doc.transact().state_vector();
    let tree = Tree::new(&doc, &before)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut changed = true;
    let mut result = json!({"schema_version":1,"ok":true,"request_id":request.request_id,
        "note_id":request.note_id,"revision_scope":"note","revision_before":stored.revision,
        "replayed":false,"validated_edits":1,"changed_block_ids":[],"created_block_ids":[],
        "deleted_block_ids":[],"affected_section_ids":[],"created_section_ids":[],"deleted_section_ids":[],
        "diff_truncated":false,"section_edit":true});
    {
        let mut txn = doc.transact_mut();
        match &request.action {
            SectionAction::Create {
                parent_section_id,
                placement,
                title,
                markdown,
            } => {
                let parent = tree.get(parent_section_id)?;
                check_depth(parent.depth + 1)?;
                let index = tree.destination(None, parent_section_id, placement)?;
                let blocks = match markdown {
                    Some(markdown) => markdown::parse(markdown, &reader)?,
                    None => vec![
                        json!({"type":"paragraph","attrs":{"blockId":uuid::Uuid::now_v7().to_string()},"content":[]}),
                    ],
                };
                let id = uuid::Uuid::now_v7().to_string();
                let model = Section {
                    section_id: id.clone(),
                    title: title.clone(),
                    emoji: None,
                    tags: vec![],
                    body: blocks,
                    children: vec![],
                };
                let (_, block_ids, _) = subtree_info(&model)?;
                let section =
                    parent
                        .children
                        .insert(&mut txn, index, XmlElementPrelim::empty("section"));
                let header = section.push_back(&mut txn, XmlElementPrelim::empty("sectionHeader"));
                header.insert_attribute(&mut txn, "sectionId", id.as_str());
                header.insert_attribute(&mut txn, "tags", "[]");
                header.push_back(&mut txn, XmlTextPrelim::new(title.as_str()));
                let body = section.push_back(&mut txn, XmlElementPrelim::empty("sectionBody"));
                let chunk = body.push_back(&mut txn, XmlElementPrelim::empty("bodyChunk"));
                chunk.insert_attribute(&mut txn, "chunkId", uuid::Uuid::now_v7().to_string());
                for (index, block) in model.body.iter().enumerate() {
                    projection::insert_block(&mut txn, &chunk, index as u32, block)?;
                }
                projection::split_chunks(&mut txn, &body)?;
                section.push_back(&mut txn, XmlElementPrelim::empty("sectionChildren"));
                result["section_id"] = id.clone().into();
                result["created_section_ids"] = json!([id]);
                result["affected_section_ids"] = json!([parent_section_id, id]);
                result["created_block_ids"] = json!(block_ids);
                result["changes"] = json!([{"operation":"create","section_id":id,"parent_section_id":parent_section_id,
                    "index":index,"title":title,"markdown":crate::markdown_read::section_markdown(&model, parent.depth+1, &reader.workspace_id)}]);
            }
            SectionAction::Rename { section_id, title } => {
                let entry = tree.get(section_id)?;
                changed = entry.model.title != *title;
                if changed {
                    let texts = entry.header.children(&txn).collect::<Vec<_>>();
                    let mut first = true;
                    for text in texts {
                        let XmlOut::Text(text) = text else {
                            return Err(invalid("Title must be text"));
                        };
                        let len = text.len(&txn);
                        text.remove_range(&mut txn, 0, len);
                        if first {
                            text.insert(&mut txn, 0, title);
                            first = false;
                        }
                    }
                    if first {
                        entry
                            .header
                            .push_back(&mut txn, XmlTextPrelim::new(title.as_str()));
                    }
                    result["changes"] = json!([{"operation":"rename","section_id":section_id,"before":entry.model.title,"after":title}]);
                    result["affected_section_ids"] = json!([section_id]);
                }
                result["section_id"] = section_id.clone().into();
            }
            SectionAction::Sectionize {
                section_id,
                heading_block_id,
            } => {
                let source = tree.get(section_id)?;
                check_depth(source.depth + 1)?;
                let index = source
                    .model
                    .body
                    .iter()
                    .position(|block| block["attrs"]["blockId"] == *heading_block_id)
                    .ok_or_else(|| {
                        ReadError::new(
                            "INVALID_TARGET",
                            "Heading must be a direct Body Paragraph of the requested Section",
                        )
                    })?;
                let heading = &source.model.body[index];
                let title = paragraph_title(heading)?;
                let id = uuid::Uuid::now_v7().to_string();
                let mut model = Section {
                    section_id: id.clone(),
                    title: title.clone(),
                    emoji: None,
                    tags: vec![],
                    body: source.model.body[index..].to_vec(),
                    children: vec![],
                };
                // Bound the entire affected range, including the consumed heading.
                let (_, block_ids, _) = subtree_info(&model)?;
                let moved = block_ids
                    .into_iter()
                    .filter(|b| b != heading_block_id)
                    .collect::<Vec<_>>();
                model.body.remove(0);
                let section =
                    source
                        .children
                        .insert(&mut txn, 0, XmlElementPrelim::empty("section"));
                let header = section.push_back(&mut txn, XmlElementPrelim::empty("sectionHeader"));
                header.insert_attribute(&mut txn, "sectionId", id.as_str());
                header.insert_attribute(&mut txn, "tags", "[]");
                header.push_back(&mut txn, XmlTextPrelim::new(title.as_str()));
                let body = section.push_back(&mut txn, XmlElementPrelim::empty("sectionBody"));
                transfer_body_suffix(&mut txn, &source.body, &body, index)?;
                section.push_back(&mut txn, XmlElementPrelim::empty("sectionChildren"));
                result["section_id"] = json!(id);
                result["created_section_ids"] = json!([id]);
                result["affected_section_ids"] = json!([section_id, id]);
                result["deleted_block_ids"] = json!([heading_block_id]);
                result["moved_block_ids"] = json!(moved);
                result["sectionized_heading"] =
                    json!({"block_id":heading_block_id,"section_id":id});
                result["changes"] = json!([{"operation":"sectionize","section_id":id,
                    "parent_section_id":section_id,"index":0,"heading_block_id":heading_block_id,
                    "heading_before":heading,"title":title,"moved_block_ids":moved,
                    "direct_body_block_count":model.body.len(),
                    "markdown":crate::markdown_read::section_markdown(&model, source.depth+1, &reader.workspace_id)}]);
            }
            SectionAction::Move {
                section_id,
                parent_section_id,
                placement,
            } => {
                let entry = tree.get(section_id)?;
                let parent = tree.get(parent_section_id)?;
                let index = tree.destination(Some(section_id), parent_section_id, placement)?;
                let (ids, _, height) = subtree_info(entry.model)?;
                check_depth(parent.depth + 1 + height)?;
                let same_parent = entry.parent_id == Some(parent_section_id.as_str());
                changed = !same_parent || index != entry.index;
                if changed {
                    let old_parent = tree.get(entry.parent_id.unwrap())?;
                    // Copy before deleting: integrated shared types cannot be moved.
                    let insertion = index + u32::from(same_parent && entry.index < index);
                    clone_xml_at(
                        &mut txn,
                        &XmlOut::Element(entry.node.clone()),
                        &parent.children,
                        insertion,
                    )?;
                    let removal = entry.index + u32::from(same_parent && insertion <= entry.index);
                    old_parent.children.remove_range(&mut txn, removal, 1);
                    result["affected_section_ids"] = json!(ids);
                    result["changes"] = json!([{"operation":"move","section_id":section_id,
                        "before_parent_section_id":entry.parent_id,"before_index":entry.index,
                        "after_parent_section_id":parent_section_id,"after_index":index,"subtree_section_ids":ids}]);
                }
                result["section_id"] = section_id.clone().into();
            }
            SectionAction::Delete { section_id, mode } => {
                let entry = tree.get(section_id)?;
                if matches!(mode, DeleteMode::Empty)
                    && (!entry.model.children.is_empty()
                        || entry.model.body.iter().any(|b| {
                            b["type"] != "paragraph"
                                || b["content"].as_array().is_some_and(|v| !v.is_empty())
                        }))
                {
                    return Err(ReadError::new(
                        "SECTION_NOT_EMPTY",
                        "Body or child Sections would be lost; explicit subtree mode is required",
                    ));
                }
                let (ids, block_ids, _) = subtree_info(entry.model)?;
                let parent = tree.get(entry.parent_id.unwrap())?;
                parent.children.remove_range(&mut txn, entry.index, 1);
                result["section_id"] = section_id.clone().into();
                result["affected_section_ids"] = json!([entry.parent_id]);
                result["deleted_section_ids"] = json!(ids);
                result["deleted_block_ids"] = json!(block_ids);
                result["fallback_section_id"] = json!(entry.parent_id);
                result["changes"] = json!([{"operation":"delete","section_id":section_id,"parent_section_id":entry.parent_id,
                    "index":entry.index,"deleted_section_ids":ids,"markdown":crate::markdown_read::section_markdown(entry.model, entry.depth, &reader.workspace_id)}]);
            }
        }
        if changed {
            txn.get_map("meta")
                .ok_or_else(|| invalid("Missing Note metadata"))?
                .insert(&mut txn, "updated_at", now.as_str());
        }
    }
    let mut documents = vec![];
    if changed {
        read_note(
            &PersistedDocument {
                snapshot: doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                snapshot_revision: stored.revision,
                updates: vec![],
                ..stored.clone()
            },
            false,
        )?;
        documents.push(DocumentCommitInput {
            kind: "note".into(),
            document_id: request.note_id.clone(),
            schema_version: 6,
            base_revision: stored.revision,
            snapshot: None,
            update: Some(doc.transact().encode_state_as_update_v1(&vector)),
        });
        let workspace = load_document(&reader.connection, "workspace", &reader.workspace_id)?;
        let metadata = decode_document(&workspace)?;
        let vector = metadata.transact().state_vector();
        {
            let mut txn = metadata.transact_mut();
            let root = txn
                .get_map("workspace")
                .ok_or_else(|| invalid("Missing Workspace"))?;
            let Some(yrs::Out::YMap(notes)) = root.get(&txn, "notes") else {
                return Err(invalid("Missing Notes"));
            };
            let Some(yrs::Out::YMap(note)) = notes.get(&txn, &request.note_id) else {
                return Err(invalid("Missing Note metadata"));
            };
            note.insert(&mut txn, "updated_at", now.as_str());
        }
        documents.push(DocumentCommitInput {
            kind: "workspace".into(),
            document_id: reader.workspace_id.clone(),
            schema_version: workspace.schema_version,
            base_revision: reader.workspace_revision,
            snapshot: None,
            update: Some(metadata.transact().encode_state_as_update_v1(&vector)),
        });
    }
    result["status"] = if changed { "applied" } else { "no_change" }.into();
    result["revision_after"] = (stored.revision + i64::from(changed)).into();
    result["applied_edits"] = i64::from(changed).into();
    if !changed {
        result["changes"] = json!([]);
    }
    if serde_json::to_vec(&result["changes"])?.len() > MAX_DIFF_BYTES {
        result["changes"] = json!([]);
        result["diff_truncated"] = true.into();
    }
    if serde_json::to_vec(&result)?.len() > MAX_RESULT_BYTES {
        return Err(invalid("Section result exceeds 2 MiB"));
    }
    Ok(PreparedEdit {
        request: agent,
        fingerprint,
        documents,
        result,
        workspace_revision: reader.workspace_revision,
        replayed: false,
    })
}
