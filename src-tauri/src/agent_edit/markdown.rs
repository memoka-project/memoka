//! A deliberately closed Markdown subset. Unsupported structures are errors,
//! never flattened into paragraphs or silently stored in a Source block.
use super::*;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

fn block(kind: &str) -> Value {
    json!({"type":kind,"attrs":{"blockId":uuid::Uuid::now_v7().to_string()},"content":[]})
}
fn append(stack: &mut [Value], value: Value) {
    stack.last_mut().unwrap()["content"]
        .as_array_mut()
        .unwrap()
        .push(value);
}
fn inline(stack: &mut [Value], value: Value) {
    let parent = stack.last_mut().unwrap();
    if parent["type"] == "paragraph" {
        parent["content"].as_array_mut().unwrap().push(value);
        return;
    }
    let children = parent["content"].as_array_mut().unwrap();
    if children.last().is_none_or(|v| v["type"] != "paragraph") {
        children.push(block("paragraph"));
    }
    children.last_mut().unwrap()["content"]
        .as_array_mut()
        .unwrap()
        .push(value);
}
fn text(stack: &mut [Value], value: &str, marks: &[Value]) {
    if value.is_empty() {
        return;
    }
    inline(stack, json!({"type":"text","text":value,"marks":marks}));
}
// Pair only literal, unescaped delimiters in inline text. Parser offsets keep
// code spans, link destinations, entities and block boundaries out of this
// pass. Collision-free sentinels survive nested emphasis in the second pass.
fn highlight_source(source: &str, options: Options) -> (String, String, String) {
    let token = loop {
        let token = format!("MEMOKAHIGHLIGHT{}", uuid::Uuid::now_v7().simple());
        if !source.contains(&token) {
            break token;
        }
    };
    let open = format!("@{token}OPEN@");
    let close = format!("@{token}CLOSE@");
    let mut pairs = BTreeMap::new();
    let mut opening = None;
    let mut internal = false;
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        match event {
            Event::Text(_) if !internal => {
                let bytes = source.as_bytes();
                let mut i = range.start;
                while i + 1 < range.end {
                    let escaped =
                        bytes[..i].iter().rev().take_while(|b| **b == b'\\').count() % 2 == 1;
                    if bytes[i] == b'=' && bytes[i + 1] == b'=' && !escaped {
                        if let Some(start) = opening {
                            if !source[start + 2..i].trim().is_empty() {
                                pairs.insert(start, true);
                                pairs.insert(i, false);
                                opening = None;
                            } else {
                                opening = Some(i);
                            }
                        } else {
                            opening = Some(i);
                        }
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => internal = dest_url.starts_with("memoka:"),
            Event::End(TagEnd::Link) => internal = false,
            Event::Start(Tag::Paragraph | Tag::Item | Tag::BlockQuote(_) | Tag::List(_))
            | Event::End(
                TagEnd::Paragraph | TagEnd::Item | TagEnd::BlockQuote(_) | TagEnd::List(_),
            ) => opening = None,
            _ => (),
        }
    }
    let mut output = String::with_capacity(source.len());
    let mut previous = 0;
    for (position, opening) in pairs {
        output.push_str(&source[previous..position]);
        output.push_str(if opening { &open } else { &close });
        previous = position + 2;
    }
    output.push_str(&source[previous..]);
    (output, open, close)
}

fn with_highlight(marks: &[Value], active: bool) -> Vec<Value> {
    let mut marks = marks.to_vec();
    if active {
        marks.push(json!({"type":"highlight"}));
    }
    marks
}

fn highlighted(
    stack: &mut [Value],
    value: &str,
    marks: &[Value],
    active: &mut bool,
    open: &str,
    close: &str,
) {
    let mut rest = value;
    loop {
        let next = [
            (rest.find(open), true, open.len()),
            (rest.find(close), false, close.len()),
        ]
        .into_iter()
        .filter_map(|(offset, state, len)| offset.map(|o| (o, state, len)))
        .min();
        let Some((offset, state, len)) = next else {
            break;
        };
        text(stack, &rest[..offset], &with_highlight(marks, *active));
        *active = state;
        rest = &rest[offset + len..];
    }
    text(stack, rest, &with_highlight(marks, *active));
}
fn internal_target(reader: &WorkspaceReader, url: &tauri::Url) -> Result<Value, ReadError> {
    let parts = url
        .path_segments()
        .map(|p| p.collect::<Vec<_>>())
        .unwrap_or_default();
    if url.host_str() != Some("workspace")
        || parts.len() != 3
        || parts[0] != reader.workspace_id
        || parts[1] != "section"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(unsupported(
            "Internal links must identify a Section in this Workspace",
        ));
    }
    validate_id(parts[2])?;
    for id in reader.document_revisions.keys() {
        if reader.namespace.notes[id]["deleted_at"].is_string() {
            continue;
        }
        let note = read_note(&load_document(&reader.connection, "note", id)?, false)?;
        let mut pending = vec![&note.root];
        while let Some(section) = pending.pop() {
            if section.section_id == parts[2] {
                return Ok(
                    json!({"type":"internalSectionLink","attrs":{"targetSectionId":section.section_id},"content":[{"type":"text","text":if section.title.is_empty(){"無題のセクション"}else{&section.title}}]}),
                );
            }
            pending.extend(&section.children);
        }
    }
    Err(ReadError::new(
        "INVALID_TARGET",
        "Internal link target does not exist",
    ))
}
pub(super) fn parse(source: &str, reader: &WorkspaceReader) -> Result<Vec<Value>, ReadError> {
    if source.trim().is_empty() {
        return Err(invalid("markdown must contain at least one Block"));
    }
    let options = Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM;
    let (source, highlight_open, highlight_close) = highlight_source(source, options);
    let mut highlight_active = false;
    let mut stack = vec![json!({"type":"document","content":[]})];
    let mut marks = vec![];
    let mut internal = None;
    let mut empty_task_markers = BTreeMap::new();
    let mut count = 0;
    for (event, range) in Parser::new_ext(&source, options).into_offset_iter() {
        if stack.len() > 128 || count > MAX_NEW_BLOCKS {
            return Err(invalid("Markdown structure exceeds the editing limit"));
        }
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    stack.push(block("paragraph"));
                    count += 1;
                }
                Tag::List(start) => {
                    let mut node = block(if start.is_some() {
                        "orderedList"
                    } else {
                        "bulletList"
                    });
                    if let Some(start) = start {
                        node["attrs"]["start"] = start.into();
                    }
                    stack.push(node);
                    count += 1;
                }
                Tag::Item => {
                    let mut item = block("listItem");
                    let first = source[range.clone()].lines().next().unwrap_or("");
                    if let Some((_, rest)) = first.split_once(char::is_whitespace) {
                        let marker = rest.trim();
                        if matches!(marker, "[ ]" | "[x]" | "[X]") {
                            item["attrs"]["checked"] = (marker != "[ ]").into();
                            let start = range.start + first.find('[').unwrap();
                            empty_task_markers.insert(start, start + 3);
                        }
                    }
                    stack.push(item);
                    count += 1;
                }
                Tag::BlockQuote(None) => {
                    let first = source[range]
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim_start_matches(['>', ' ', '\t']);
                    if first.starts_with("[!") {
                        return Err(unsupported(
                            "Alerts and callouts are not supported by agent insertion",
                        ));
                    }
                    stack.push(block("blockquote"));
                    count += 1;
                }
                Tag::Emphasis => marks.push(json!({"type":"italic"})),
                Tag::Strong => marks.push(json!({"type":"bold"})),
                Tag::Strikethrough => marks.push(json!({"type":"strike"})),
                Tag::Link {
                    dest_url, title, ..
                } => {
                    let url = tauri::Url::parse(&dest_url)
                        .map_err(|_| unsupported("Links must use an absolute, safe URL"))?;
                    if url.scheme() == "memoka" {
                        internal = Some(internal_target(reader, &url)?);
                    } else if matches!(url.scheme(), "https" | "http" | "mailto" | "tel") {
                        marks.push(json!({"type":"link","attrs":{"href":dest_url.as_ref(),"title":if title.is_empty(){None}else{Some(title.as_ref())},"target":"_blank","rel":"noopener noreferrer nofollow"}}));
                    } else {
                        return Err(unsupported("Unsupported link scheme"));
                    }
                }
                _ => {
                    return Err(unsupported(
                        "This Markdown contains a structure not supported by agent insertion",
                    ));
                }
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph | TagEnd::List(_) | TagEnd::Item | TagEnd::BlockQuote(_) => {
                    let mut node = stack
                        .pop()
                        .ok_or_else(|| invalid("Invalid Markdown structure"))?;
                    if node["type"] == "listItem" && node["content"].as_array().unwrap().is_empty()
                    {
                        node["content"]
                            .as_array_mut()
                            .unwrap()
                            .push(block("paragraph"));
                    }
                    append(&mut stack, node);
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                    marks.pop();
                }
                TagEnd::Link => {
                    if let Some(node) = internal.take() {
                        inline(&mut stack, node);
                    } else {
                        marks.pop();
                    }
                }
                _ => return Err(unsupported("Unsupported Markdown structure")),
            },
            Event::Text(value) => {
                if empty_task_markers
                    .range(..=range.start)
                    .next_back()
                    .is_some_and(|(_, end)| range.end <= *end)
                {
                    continue;
                }
                if internal.is_none() {
                    highlighted(
                        &mut stack,
                        &value,
                        &marks,
                        &mut highlight_active,
                        &highlight_open,
                        &highlight_close,
                    );
                }
            }
            Event::Code(value) => {
                if internal.is_none() {
                    let mut code = with_highlight(&marks, highlight_active);
                    code.push(json!({"type":"code"}));
                    text(&mut stack, &value, &code);
                }
            }
            Event::SoftBreak => {
                if internal.is_none() {
                    text(&mut stack, " ", &with_highlight(&marks, highlight_active));
                }
            }
            Event::HardBreak => {
                if internal.is_none() {
                    inline(&mut stack, json!({"type":"hardBreak"}));
                }
            }
            Event::TaskListMarker(checked) => {
                let item = stack
                    .iter_mut()
                    .rev()
                    .find(|v| v["type"] == "listItem")
                    .ok_or_else(|| invalid("Task marker outside ListItem"))?;
                item["attrs"]["checked"] = checked.into();
            }
            _ => {
                return Err(unsupported(
                    "Raw HTML, rules, embedded files, and unsupported Markdown cannot be inserted",
                ));
            }
        }
    }
    if stack.len() != 1 {
        return Err(invalid("Invalid Markdown structure"));
    }
    Ok(stack.pop().unwrap()["content"].as_array().unwrap().clone())
}
