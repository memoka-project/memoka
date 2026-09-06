//! Text interchange, not a second persistence layer. No URL is ever fetched.
use crate::document_model::Section;
use serde_json::Value;

pub fn uri(workspace: &str, kind: &str, id: &str) -> String {
    format!("memoka://workspace/{workspace}/{kind}/{id}")
}

pub fn section_markdown(section: &Section, depth: usize, workspace: &str) -> String {
    let mut out = format!("{} {}\n\n", "#".repeat(depth + 1), escape(&section.title));
    for block in &section.body {
        out.push_str(&block_markdown(block, workspace));
    }
    for child in &section.children {
        out.push_str(&section_markdown(child, depth + 1, workspace));
    }
    out
}

fn content(node: &Value) -> &[Value] {
    node["content"].as_array().map_or(&[], Vec::as_slice)
}
fn attr<'a>(node: &'a Value, name: &str) -> &'a str {
    node["attrs"][name].as_str().unwrap_or("")
}
pub fn plain_text(node: &Value) -> String {
    match node["type"].as_str().unwrap_or("") {
        "text" => node["text"].as_str().unwrap_or("").into(),
        "hardBreak" => "\n".into(),
        "internalSectionLink" => attr(node, "label").into(),
        "image" => attr(node, "alt").into(),
        "attachment" => attr(node, "label").into(),
        _ => content(node).iter().map(plain_text).collect(),
    }
}

/// The same body-only logical rows as workspaceSearchLines in the frontend.
/// Lists count each Item (not their containers); Tables count rows, not cells.
#[derive(Debug, PartialEq)]
pub struct SearchLine {
    pub block_id: String,
    pub text: String,
    pub line_index: usize,
    pub source_offset: usize,
}
pub fn search_lines(body: &[Value]) -> Vec<SearchLine> {
    fn compact(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
    fn is_list(node: &Value) -> bool {
        matches!(
            node["type"].as_str(),
            Some("bulletList" | "orderedList" | "bullet_list" | "ordered_list")
        )
    }
    let mut rows = Vec::new();
    let mut pending = body.iter().rev().collect::<Vec<_>>();
    while let Some(node) = pending.pop() {
        let block_id = attr(node, "blockId");
        let mut append = |text: String, line_index: usize, source_offset: usize| {
            if !block_id.is_empty() {
                rows.push(SearchLine {
                    block_id: block_id.into(),
                    text,
                    line_index,
                    source_offset,
                });
            }
        };
        match node["type"].as_str().unwrap_or("") {
            "paragraph" | "codeBlock" | "sourceBlock" | "code_block" | "source_block" => {
                let mut offset = 0;
                for (index, text) in plain_text(node).split('\n').enumerate() {
                    append(text.into(), index, offset);
                    // ProseMirror/JavaScript offsets count UTF-16 code units.
                    offset += text.encode_utf16().count() + 1;
                }
            }
            "image" | "attachment" => append(plain_text(node), 0, 0),
            "listItem" | "list_item" => {
                append(
                    compact(
                        &content(node)
                            .iter()
                            .filter(|child| !is_list(child))
                            .map(plain_text)
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    0,
                    0,
                );
                pending.extend(content(node).iter().rev().filter(|child| is_list(child)));
            }
            "tableRow" | "table_row" => append(
                content(node)
                    .iter()
                    .map(|cell| compact(&plain_text(cell)))
                    .collect::<Vec<_>>()
                    .join(" | "),
                0,
                0,
            ),
            _ => pending.extend(content(node).iter().rev()),
        }
    }
    rows
}

pub fn resolve_link_labels(
    section: &mut Section,
    titles: &std::collections::BTreeMap<String, String>,
) {
    fn visit(node: &mut Value, titles: &std::collections::BTreeMap<String, String>) {
        if node["type"] == "internalSectionLink" {
            if let Some(title) = node["attrs"]["targetSectionId"]
                .as_str()
                .and_then(|id| titles.get(id))
            {
                node["attrs"]["label"] = title.clone().into();
            }
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for child in children {
                visit(child, titles);
            }
        }
    }
    for block in &mut section.body {
        visit(block, titles);
    }
    for child in &mut section.children {
        resolve_link_labels(child, titles);
    }
}
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if "\\[]_*`#~<>|".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out.replace("==", "\\=\\=")
}
fn html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn fence(text: &str, minimum: usize) -> String {
    let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(minimum.max(longest + 1))
}
fn inline(node: &Value, workspace: &str) -> String {
    match node["type"].as_str().unwrap_or("") {
        "text" => {
            let text = node["text"].as_str().unwrap_or("");
            let marks = node["marks"].as_array().map_or(&[][..], Vec::as_slice);
            let code = marks.iter().any(|mark| mark["type"] == "code");
            let core = if code { text } else { text.trim() };
            if core.is_empty() {
                return text.into();
            }
            let before = if code {
                ""
            } else {
                &text[..text.len() - text.trim_start().len()]
            };
            let after = if code {
                ""
            } else {
                &text[text.trim_end().len()..]
            };
            let mut result = if code {
                let ticks = fence(core, 1);
                let pad = if core.starts_with(['`', ' ']) || core.ends_with(['`', ' ']) {
                    " "
                } else {
                    ""
                };
                format!("{ticks}{pad}{core}{pad}{ticks}")
            } else {
                escape(core)
            };
            for mark in marks.iter().rev() {
                match mark["type"].as_str().unwrap_or("") {
                    "bold" | "strong" => result = format!("**{result}**"),
                    "italic" | "em" => result = format!("*{result}*"),
                    "strike" => result = format!("~~{result}~~"),
                    "highlight" => result = format!("=={result}=="),
                    "link" => {
                        let href = attr(mark, "href")
                            .replace('>', "%3E")
                            .replace('<', "%3C")
                            .replace('\n', "%0A")
                            .replace('\r', "%0D");
                        result = format!("[{result}](<{href}>)");
                    }
                    _ => {}
                }
            }
            format!("{before}{result}{after}")
        }
        "hardBreak" => "  \n".into(),
        "internalSectionLink" => {
            let id = attr(node, "targetSectionId");
            let label = if !attr(node, "label").is_empty() {
                attr(node, "label").to_owned()
            } else {
                content(node).iter().map(plain_text).collect()
            };
            format!("[{}]({})", escape(&label), uri(workspace, "section", id))
        }
        _ => content(node)
            .iter()
            .map(|node| inline(node, workspace))
            .collect(),
    }
}
pub fn block_markdown(node: &Value, workspace: &str) -> String {
    match node["type"].as_str().unwrap_or("") {
        "paragraph" => format!("{}\n\n", inline(node, workspace)),
        "horizontalRule" => "---\n\n".into(),
        "codeBlock" | "sourceBlock" => {
            let text = plain_text(node);
            let ticks = fence(&text, 3);
            let language = if node["type"] == "sourceBlock" {
                "markdown"
            } else {
                attr(node, "language")
            };
            format!(
                "{ticks}{}\n{text}\n{ticks}\n\n",
                language.replace(['\n', '\r', '`'], "")
            )
        }
        "blockquote" => {
            let mut text = String::new();
            let alert = attr(node, "alertType");
            if !alert.is_empty() {
                text = format!(
                    "[!{}]{}{}\n",
                    alert.to_uppercase(),
                    match attr(node, "alertFold") {
                        "expanded" => "+",
                        "collapsed" => "-",
                        _ => "",
                    },
                    if attr(node, "alertTitle").is_empty() {
                        String::new()
                    } else {
                        format!(" {}", attr(node, "alertTitle"))
                    }
                );
            }
            text.push_str(
                &content(node)
                    .iter()
                    .map(|child| block_markdown(child, workspace))
                    .collect::<String>(),
            );
            format!(
                "{}\n\n",
                text.trim_end_matches('\n')
                    .split('\n')
                    .map(|line| if line.is_empty() {
                        ">".into()
                    } else {
                        format!("> {line}")
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        }
        "bulletList" | "orderedList" => {
            let start = node["attrs"]["start"].as_i64().unwrap_or(1);
            let mut text = String::new();
            for (index, item) in content(node).iter().enumerate() {
                let marker = if node["type"] == "orderedList" {
                    format!("{}. ", start + index as i64)
                } else {
                    "- ".into()
                };
                let padding = " ".repeat(marker.len());
                let body = content(item)
                    .iter()
                    .map(|child| block_markdown(child, workspace))
                    .collect::<String>();
                let mut lines = body.trim_end_matches('\n').split('\n');
                text.push_str(&format!("{marker}{}\n", lines.next().unwrap_or("")));
                for line in lines {
                    text.push_str(&format!("{padding}{line}\n"));
                }
            }
            text.push('\n');
            text
        }
        "table" => {
            let rows = content(node);
            if rows.is_empty() {
                return String::new();
            }
            let width = rows.iter().map(|row| content(row).len()).max().unwrap_or(0);
            let mut out = String::new();
            for (index, row) in rows.iter().enumerate() {
                let cells = content(row)
                    .iter()
                    .map(|cell| {
                        content(cell)
                            .iter()
                            .map(|node| {
                                inline(node, workspace)
                                    .replace("  \n", "<br>")
                                    .replace('\n', "<br>")
                            })
                            .collect::<Vec<_>>()
                            .join("<br>")
                    })
                    .collect::<Vec<_>>();
                out.push_str(&format!(
                    "| {} |\n",
                    (0..width)
                        .map(|i| cells.get(i).cloned().unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join(" | ")
                ));
                if index == 0 {
                    out.push_str(&format!(
                        "| {} |\n",
                        (0..width)
                            .map(|i| {
                                match content(row).get(i).map(|cell| attr(cell, "textAlign")) {
                                    Some("left") => ":---",
                                    Some("right") => "---:",
                                    Some("center") => ":---:",
                                    _ => "---",
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" | ")
                    ));
                }
            }
            out.push('\n');
            out
        }
        "image" | "attachment" => {
            let id = attr(node, "attachmentId");
            let url = uri(workspace, "attachment", id);
            if node["type"] == "image" {
                let width = node["attrs"]["width"]
                    .as_f64()
                    .or_else(|| attr(node, "width").parse().ok())
                    .unwrap_or(100.0);
                if (10.0..100.0).contains(&width) {
                    format!(
                        "<img src=\"{}\" alt=\"{}\" width=\"{width:.0}%\">\n\n",
                        html(&url),
                        html(attr(node, "alt"))
                    )
                } else {
                    format!("![{}]({url})\n\n", escape(attr(node, "alt")))
                }
            } else {
                format!("[{}]({url})\n\n", escape(attr(node, "label")))
            }
        }
        _ => content(node)
            .iter()
            .map(|child| block_markdown(child, workspace))
            .collect(),
    }
}
