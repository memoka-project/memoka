import type { NoteDocument } from "./documents";
import { inlineMarkdownText } from "./inline-markdown";
import {
  BOOTSTRAP_ORIGIN,
  createNoteDocument,
  replaceNoteSectionTree,
} from "./documents";
import {
  deriveSectionCatalog,
  sectionSnapshot,
  type SectionSnapshot,
} from "./section-model";

export const SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION = 1;

export interface SectionMarkdownManifestEntry {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  readonly order: number;
  readonly file: string;
}

export interface SectionMarkdownManifest {
  readonly schemaVersion: 1;
  readonly noteId: string;
  readonly rootSectionId: string;
  readonly sections: readonly SectionMarkdownManifestEntry[];
}

export interface SectionMarkdownBackup {
  readonly manifest: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface SectionMarkdownFileData {
  sectionId: string;
  noteId: string;
  parentSectionId: string | null;
  order: number;
  title: string;
  emoji?: string;
  tags: string[];
  body: unknown[];
}

export interface SectionMarkdownRenderOptions {
  readonly resolveInternalLink?: (
    targetSectionId: string,
    label: string,
  ) => string;
  readonly resolveAttachment?: (
    attachmentId: string,
    kind: "image" | "attachment",
  ) => string;
}

export function createSectionMarkdownBackup(
  note: NoteDocument,
): SectionMarkdownBackup {
  const catalog = deriveSectionCatalog(note.noteId, note.rootSection);
  const snapshotById = flattenSnapshots(sectionSnapshot(note.rootSection));
  const siblingOrder = new Map<string | null, number>();
  const entries: SectionMarkdownManifestEntry[] = [];
  const files: Record<string, string> = {};
  for (const section of catalog) {
    const order = siblingOrder.get(section.parentSectionId) ?? 0;
    siblingOrder.set(section.parentSectionId, order + 1);
    const file = `sections/${section.sectionId}.md`;
    const snapshot = snapshotById.get(section.sectionId);
    if (!snapshot)
      throw new Error(`Missing Section snapshot: ${section.sectionId}`);
    entries.push({
      sectionId: section.sectionId,
      parentSectionId: section.parentSectionId,
      order,
      file,
    });
    files[file] = encodeSectionMarkdownFile({
      sectionId: section.sectionId,
      noteId: note.noteId,
      parentSectionId: section.parentSectionId,
      order,
      title: snapshot.title,
      emoji: snapshot.emoji,
      tags: [...snapshot.tags],
      body: [...snapshot.body],
    });
  }
  const manifest: SectionMarkdownManifest = {
    schemaVersion: SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION,
    noteId: note.noteId,
    rootSectionId: note.noteId,
    sections: entries,
  };
  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    files,
  };
}

export function restoreSectionMarkdownBackup(
  backup: SectionMarkdownBackup,
  timestamps: { createdAt?: string; updatedAt?: string } = {},
): NoteDocument {
  const manifest = parseManifest(backup.manifest);
  const expectedFiles = new Set(manifest.sections.map(({ file }) => file));
  const actualFiles = Object.keys(backup.files);
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error("Section backup files do not match its Manifest");
  }

  const dataById = new Map<string, SectionMarkdownFileData>();
  for (const entry of manifest.sections) {
    const source = backup.files[entry.file];
    if (source === undefined)
      throw new Error(`Missing Section file: ${entry.file}`);
    const data = decodeSectionFile(source);
    if (
      data.sectionId !== entry.sectionId ||
      data.noteId !== manifest.noteId ||
      data.parentSectionId !== entry.parentSectionId ||
      data.order !== entry.order
    ) {
      throw new Error(
        `Section file metadata disagrees with Manifest: ${entry.file}`,
      );
    }
    if (dataById.has(data.sectionId)) {
      throw new Error(`Duplicate Section file: ${data.sectionId}`);
    }
    dataById.set(data.sectionId, data);
  }

  const root = rebuildSnapshotTree(manifest, dataById);
  const updatedAt = timestamps.updatedAt ?? "";
  const note = createNoteDocument(manifest.noteId, [], "", {
    createdAt: timestamps.createdAt,
    updatedAt,
  });
  replaceNoteSectionTree(note, root, updatedAt, BOOTSTRAP_ORIGIN);
  return note;
}

function parseManifest(source: string): SectionMarkdownManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Section backup Manifest is not valid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Section backup Manifest must be an object");
  }
  const manifest = value as Partial<SectionMarkdownManifest>;
  if (
    manifest.schemaVersion !== SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION ||
    typeof manifest.noteId !== "string" ||
    manifest.rootSectionId !== manifest.noteId ||
    !Array.isArray(manifest.sections) ||
    manifest.sections.length === 0
  ) {
    throw new Error("Unsupported Section backup Manifest");
  }
  const files = new Set<string>();
  const ids = new Set<string>();
  for (const entry of manifest.sections) {
    if (
      !entry ||
      typeof entry.sectionId !== "string" ||
      (entry.parentSectionId !== null &&
        typeof entry.parentSectionId !== "string") ||
      !Number.isSafeInteger(entry.order) ||
      entry.order < 0 ||
      typeof entry.file !== "string" ||
      !/^sections\/[0-9a-f-]+\.md$/u.test(entry.file) ||
      files.has(entry.file) ||
      ids.has(entry.sectionId)
    ) {
      throw new Error("Section backup Manifest contains an invalid entry");
    }
    files.add(entry.file);
    ids.add(entry.sectionId);
  }
  if (!ids.has(manifest.rootSectionId)) {
    throw new Error("Section backup root is missing");
  }
  return manifest as SectionMarkdownManifest;
}

export function encodeSectionMarkdownFile(
  data: SectionMarkdownFileData,
  options: SectionMarkdownRenderOptions = {},
): string {
  const fields: Array<[string, unknown]> = [
    ["memoka_section_backup", SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION],
    ["section_id", data.sectionId],
    ["note_id", data.noteId],
    ["parent_section_id", data.parentSectionId],
    ["order", data.order],
    ["title", data.title],
    ["emoji", data.emoji ?? null],
    ["tags", data.tags],
    ["body_payload_hex", utf8ToHex(JSON.stringify(data.body))],
  ];
  const frontmatter = fields
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n${renderSectionMarkdown(data.title, data.body, options)}`;
}

function decodeSectionFile(source: string): SectionMarkdownFileData {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  if (!match) throw new Error("Section file has invalid frontmatter");
  const values = new Map<string, unknown>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new Error("Section frontmatter line is invalid");
    const name = line.slice(0, separator);
    if (values.has(name)) throw new Error(`Duplicate frontmatter key: ${name}`);
    try {
      values.set(name, JSON.parse(line.slice(separator + 2)));
    } catch {
      throw new Error(`Invalid frontmatter value: ${name}`);
    }
  }
  const required = [
    "memoka_section_backup",
    "section_id",
    "note_id",
    "parent_section_id",
    "order",
    "title",
    "emoji",
    "tags",
    "body_payload_hex",
  ];
  if (
    values.size !== required.length ||
    required.some((key) => !values.has(key))
  ) {
    throw new Error("Section frontmatter keys are incomplete");
  }
  const sectionId = values.get("section_id");
  const noteId = values.get("note_id");
  const parentSectionId = values.get("parent_section_id");
  const order = values.get("order");
  const title = values.get("title");
  const emoji = values.get("emoji");
  const tags = values.get("tags");
  const payload = values.get("body_payload_hex");
  if (
    values.get("memoka_section_backup") !==
      SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION ||
    typeof sectionId !== "string" ||
    typeof noteId !== "string" ||
    (parentSectionId !== null && typeof parentSectionId !== "string") ||
    !Number.isSafeInteger(order) ||
    Number(order) < 0 ||
    typeof title !== "string" ||
    (emoji !== null && typeof emoji !== "string") ||
    !Array.isArray(tags) ||
    tags.some((tag) => typeof tag !== "string") ||
    typeof payload !== "string"
  ) {
    throw new Error("Section frontmatter contains invalid metadata");
  }
  let body: unknown;
  try {
    body = JSON.parse(hexToUtf8(payload));
  } catch {
    throw new Error("Section body payload is invalid");
  }
  if (!Array.isArray(body))
    throw new Error("Section body payload must be an array");
  const expectedMarkdown = renderSectionMarkdown(title, body);
  if ((match[2] ?? "") !== expectedMarkdown) {
    throw new Error(
      "Section Markdown mirror does not match its structured payload",
    );
  }
  return {
    sectionId,
    noteId,
    parentSectionId,
    order: Number(order),
    title,
    emoji: typeof emoji === "string" && emoji ? emoji : undefined,
    tags: tags as string[],
    body,
  };
}

function rebuildSnapshotTree(
  manifest: SectionMarkdownManifest,
  dataById: ReadonlyMap<string, SectionMarkdownFileData>,
): SectionSnapshot {
  type MutableSnapshot = {
    sectionId: string;
    title: string;
    emoji?: string;
    tags: string[];
    body: unknown[];
    children: MutableSnapshot[];
  };
  const snapshots = new Map<string, MutableSnapshot>();
  for (const data of dataById.values()) {
    snapshots.set(data.sectionId, {
      sectionId: data.sectionId,
      title: data.title,
      emoji: data.emoji,
      tags: [...data.tags],
      body: [...data.body],
      children: [],
    });
  }
  const childrenByParent = new Map<string, SectionMarkdownManifestEntry[]>();
  for (const entry of manifest.sections) {
    if (entry.sectionId === manifest.rootSectionId) {
      if (entry.parentSectionId !== null || entry.order !== 0) {
        throw new Error("Root Section must be the only top-level entry");
      }
      continue;
    }
    if (!entry.parentSectionId || !snapshots.has(entry.parentSectionId)) {
      throw new Error(`Section parent is missing: ${entry.sectionId}`);
    }
    const siblings = childrenByParent.get(entry.parentSectionId) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.parentSectionId, siblings);
  }
  for (const [parentId, entries] of childrenByParent) {
    entries.sort((left, right) => left.order - right.order);
    entries.forEach((entry, index) => {
      if (entry.order !== index) {
        throw new Error(`Section sibling order has a gap below ${parentId}`);
      }
      snapshots.get(parentId)!.children.push(snapshots.get(entry.sectionId)!);
    });
  }
  const root = snapshots.get(manifest.rootSectionId);
  if (!root) throw new Error("Root Section snapshot is missing");
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.sectionId)) {
      throw new Error("Section backup contains a cycle");
    }
    visited.add(current.sectionId);
    pending.push(...current.children);
  }
  if (visited.size !== snapshots.size) {
    throw new Error("Section backup contains unreachable Sections");
  }
  return root;
}

function flattenSnapshots(root: SectionSnapshot): Map<string, SectionSnapshot> {
  const result = new Map<string, SectionSnapshot>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    result.set(current.sectionId, current);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      pending.push(current.children[index]!);
    }
  }
  return result;
}

export function renderSectionMarkdown(
  title: string,
  body: readonly unknown[],
  options: SectionMarkdownRenderOptions = {},
): string {
  const rendered = body
    .map((block) => renderBlock(block, "", options))
    .join("");
  return `# ${escapeInline(title)}\n\n${rendered}`;
}

function renderBlock(
  value: unknown,
  indentation = "",
  options: SectionMarkdownRenderOptions = {},
): string {
  const node = snapshotNode(value);
  if (node.type === "paragraph")
    return `${renderInlineChildren(node, options)}\n\n`;
  if (node.type === "horizontalRule") return `${indentation}---\n\n`;
  if (node.type === "blockquote") {
    const content = node.content
      .map((child) => renderBlock(child, "", options))
      .join("")
      .replace(/\n+$/u, "");
    const quoted = content
      .split("\n")
      .map((line) => `${indentation}>${line ? ` ${line}` : ""}`)
      .join("\n");
    return `${quoted}\n\n`;
  }
  if (node.type === "codeBlock" || node.type === "sourceBlock") {
    const language =
      node.type === "codeBlock" ? stringAttr(node, "language") : "markdown";
    return `\`\`\`${language}\n${nodeText(node)}\n\`\`\`\n\n`;
  }
  if (node.type === "image") {
    const alt = stringAttr(node, "alt");
    const attachmentId = stringAttr(node, "attachmentId");
    const attachment = options.resolveAttachment
      ? options.resolveAttachment(attachmentId, "image")
      : attachmentTarget(attachmentId);
    return `![${escapeInline(alt)}](${attachment})\n\n`;
  }
  if (node.type === "attachment") {
    const label = stringAttr(node, "label") || "Attachment";
    const attachmentId = stringAttr(node, "attachmentId");
    const attachment = options.resolveAttachment
      ? options.resolveAttachment(attachmentId, "attachment")
      : attachmentTarget(attachmentId);
    return `[${escapeInline(label)}](${attachment})\n\n`;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const ordered = node.type === "orderedList";
    const start = Number(node.attrs.start ?? 1);
    return `${node.content
      .map((item, index) =>
        renderListItem(
          item,
          ordered ? `${start + index}.` : "-",
          indentation,
          options,
        ),
      )
      .join("")}\n`;
  }
  if (node.type === "table") return renderTable(node);
  if (node.type === "hardBreak") return "  \n";
  return node.content
    .map((child) => renderBlock(child, indentation, options))
    .join("");
}

function renderListItem(
  value: unknown,
  marker: string,
  indentation: string,
  options: SectionMarkdownRenderOptions,
): string {
  const item = snapshotNode(value);
  const first = item.content[0] ? snapshotNode(item.content[0]) : null;
  let result = `${indentation}${marker} ${first ? renderInlineChildren(first, options) : ""}\n`;
  const childIndent = `${indentation}${" ".repeat(marker.length + 1)}`;
  for (const child of item.content.slice(1)) {
    result += renderBlock(child, childIndent, options)
      .split("\n")
      .filter((line, index, lines) => line || index < lines.length - 1)
      .map((line) => (line ? `${childIndent}${line}\n` : ""))
      .join("");
  }
  return result;
}

function renderTable(table: SnapshotNode): string {
  const rows = table.content.map(snapshotNode);
  if (rows.length === 0) return "";
  const rendered = rows.map((row) =>
    row.content.map((cell) => escapeTable(nodeText(snapshotNode(cell)))),
  );
  const width = Math.max(...rendered.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  return `${line(rendered[0] ?? [])}\n${line(Array.from({ length: width }, () => "---"))}\n${rendered.slice(1).map(line).join("\n")}\n\n`;
}

interface SnapshotNode {
  type: string;
  text?: string;
  attrs: Record<string, unknown>;
  marks: Array<{ name: string; attrs: Record<string, unknown> }>;
  content: unknown[];
}

function snapshotNode(value: unknown): SnapshotNode {
  if (!value || typeof value !== "object") throw new Error("Invalid body node");
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string")
    throw new Error("Body node type is missing");
  return {
    type: record.type,
    text: typeof record.text === "string" ? record.text : undefined,
    attrs:
      record.attrs && typeof record.attrs === "object"
        ? (record.attrs as Record<string, unknown>)
        : {},
    marks: Array.isArray(record.marks)
      ? record.marks.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const mark = value as Record<string, unknown>;
          if (typeof mark.type !== "string") return [];
          return [
            {
              name: mark.type,
              attrs:
                mark.attrs && typeof mark.attrs === "object"
                  ? (mark.attrs as Record<string, unknown>)
                  : {},
            },
          ];
        })
      : [],
    content: Array.isArray(record.content) ? record.content : [],
  };
}

function renderInlineChildren(
  node: SnapshotNode,
  options: SectionMarkdownRenderOptions = {},
): string {
  return node.content
    .map((child) => {
      const inline = snapshotNode(child);
      if (inline.type === "text") {
        return inlineMarkdownText(inline.text ?? "", inline.marks);
      }
      if (inline.type === "hardBreak") return "  \n";
      if (inline.type === "internalSectionLink") {
        const targetSectionId = stringAttr(inline, "targetSectionId");
        const label = nodeText(inline);
        const target = options.resolveInternalLink
          ? options.resolveInternalLink(targetSectionId, label)
          : targetSectionId;
        return `[[${target}|${escapeInline(label)}]]`;
      }
      return escapeInline(nodeText(inline));
    })
    .join("");
}

function nodeText(node: SnapshotNode): string {
  if (node.type === "text") return node.text ?? "";
  return node.content.map((child) => nodeText(snapshotNode(child))).join("");
}

function stringAttr(node: SnapshotNode, name: string): string {
  const value = node.attrs[name];
  return value === null || value === undefined ? "" : String(value);
}

function attachmentTarget(value: string): string {
  return value.startsWith("attachment:") ? value : `attachment:${value}`;
}

function escapeInline(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(/[[\]_*`#]/gu, "\\$&");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();
}

function utf8ToHex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToUtf8(value: string): string {
  if (!/^(?:[0-9a-f]{2})*$/u.test(value))
    throw new Error("Invalid hex payload");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
