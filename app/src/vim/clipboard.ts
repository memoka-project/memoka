import { invoke } from "@tauri-apps/api/core";
import {
  DOMSerializer,
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  markdownTextWithMarks,
  parseMarkdownPaste,
} from "../editor/markdown-paste";
import { normalizeExternalLink } from "../core/external-links";
import { defaultVimBlockSemantics } from "./block-semantics";
import type { VimRegister } from "./editor-commands";

export const MEMOKA_CLIPBOARD_MIME =
  "application/x-memoka-structured-blocks+json";
export const MARKDOWN_CLIPBOARD_MIME = "text/markdown";
export const MEMOKA_CLIPBOARD_SCHEMA_VERSION = 6;

interface TextClipboardPayload {
  schemaVersion: 6;
  kind: "text";
  text: string;
  slice?: {
    content: unknown;
    openStart: number;
    openEnd: number;
  };
}

interface BlockLinesClipboardPayload {
  schemaVersion: 6;
  kind: "block-lines";
  text: string;
  lineCount: number;
  behaviorId: string;
  blockNodeName: string;
  blockAttrs: Record<string, unknown>;
  slice?: {
    content: unknown;
    openStart: number;
    openEnd: number;
  };
}

interface StructureClipboardPayload {
  schemaVersion: 6;
  kind: "structure";
  text: string;
  structureKind: "block" | "list-item" | "table-row";
  nodeNames: string[];
  slice: {
    content: unknown;
    openStart: number;
    openEnd: number;
  };
}

interface SectionClipboardPayload {
  schemaVersion: 6;
  kind: "section";
  text: string;
  transfer: "copy" | "cut";
  sourceNoteId: string | null;
  sectionIds: string[];
  slice: {
    content: unknown;
    openStart: 0;
    openEnd: 0;
  };
}

type MemokaClipboardPayload =
  | TextClipboardPayload
  | BlockLinesClipboardPayload
  | StructureClipboardPayload
  | SectionClipboardPayload;

export interface VimClipboardFormats {
  [MEMOKA_CLIPBOARD_MIME]: string;
  "text/html": string;
  [MARKDOWN_CLIPBOARD_MIME]: string;
  "text/plain": string;
}

export type VimClipboardWriteResult = "rich" | "plain-text" | "unavailable";

export interface PreferredClipboardFormats {
  availableTypes: string[];
  internal: string | null;
  markdown: string | null;
  plain?: string | null;
  filePaths?: string[];
}

export type ExplicitClipboardFormat = "markdown" | "html";

export interface ExplicitClipboardContent {
  availableTypes: string[];
  sourceMime: string;
  content: string;
}

export type InternalLinkClipboardTitleResolver = (
  noteId: string,
) => string | null;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function structureHtml(register: VimRegister, schema: Schema): string {
  if (register.kind === "text") {
    if (register.slice) {
      const root = document.createElement("div");
      root.append(
        DOMSerializer.fromSchema(schema).serializeFragment(
          register.slice.content,
        ),
      );
      return root.innerHTML;
    }
    return `<p>${escapeHtml(register.text).replaceAll("\n", "<br>")}</p>`;
  }
  if (register.kind === "block-lines") {
    const type = schema.nodes[register.blockNodeName];
    if (!type) return `<pre><code>${escapeHtml(register.text)}</code></pre>`;
    try {
      const content = register.slice
        ? register.slice.content
        : register.text
          ? schema.text(register.text)
          : null;
      const node = type.create(register.blockAttrs, content);
      const root = document.createElement("div");
      root.append(DOMSerializer.fromSchema(schema).serializeNode(node));
      return root.innerHTML;
    } catch {
      return `<pre><code>${escapeHtml(register.text)}</code></pre>`;
    }
  }
  if (register.kind === "structure" && register.structureKind === "table-row") {
    const root = document.createElement("div");
    const table = document.createElement("table");
    const body = document.createElement("tbody");
    body.append(
      DOMSerializer.fromSchema(schema).serializeFragment(
        register.slice.content,
      ),
    );
    table.append(body);
    root.append(table);
    return root.innerHTML;
  }
  const root = document.createElement("div");
  root.append(
    DOMSerializer.fromSchema(schema).serializeFragment(register.slice.content),
  );
  return root.innerHTML;
}

function inlineMarkdown(
  node: ProseMirrorNode,
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): string {
  if (node.isText) {
    return markdownTextWithMarks(node.text ?? "", node.marks);
  }
  if (node.type.name === "hardBreak") return "  \n";
  if (node.type.name === "internalSectionLink") {
    const sectionId = String(node.attrs.targetSectionId ?? "");
    const label = resolveInternalLinkTitle?.(sectionId) ?? node.textContent;
    return `[[${sectionId}|${label}]]`;
  }
  let result = "";
  node.forEach((child) => {
    result += inlineMarkdown(child, resolveInternalLinkTitle);
  });
  return result;
}

function escapeTablePipes(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\\" && index + 1 < value.length) {
      result += `${character}${value[index + 1] ?? ""}`;
      index += 1;
      continue;
    }
    result += character === "|" ? "\\|" : character;
  }
  return result;
}

function tableCellMarkdown(
  cell: ProseMirrorNode,
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): string {
  const blocks: string[] = [];
  cell.forEach((child) => {
    blocks.push(
      child.type.name === "paragraph"
        ? inlineMarkdown(child, resolveInternalLinkTitle)
        : child.textContent,
    );
  });
  return escapeTablePipes(
    blocks
      .join("<br>")
      .replaceAll(/[ \t]*\r?\n[ \t]*/gu, "<br>")
      .trim(),
  );
}

function tableMarkdown(
  rows: readonly ProseMirrorNode[],
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): string {
  if (rows.length === 0) return "";
  const cells = rows.map((row) => {
    const result: ProseMirrorNode[] = [];
    row.forEach((cell) => result.push(cell));
    return result;
  });
  const columnCount = Math.max(0, ...cells.map(({ length }) => length));
  if (columnCount === 0) return "";
  const hasHeader = (cells[0] ?? []).some(
    ({ type }) => type.name === "tableHeader",
  );
  const alignments = Array.from<TableAlignment | null>({
    length: columnCount,
  }).fill(null);
  for (const row of cells) {
    for (let index = 0; index < columnCount; index += 1) {
      const alignment = row[index]?.attrs.align;
      if (
        alignments[index] === null &&
        (alignment === "left" ||
          alignment === "center" ||
          alignment === "right")
      ) {
        alignments[index] = alignment;
      }
    }
  }
  const renderRow = (row: readonly ProseMirrorNode[]): string =>
    `| ${Array.from({ length: columnCount }, (_, index) =>
      row[index] ? tableCellMarkdown(row[index], resolveInternalLinkTitle) : "",
    ).join(" | ")} |`;
  const header = hasHeader ? renderRow(cells[0] ?? []) : renderRow([]);
  const delimiter = `| ${alignments
    .map((alignment) =>
      alignment === "left"
        ? ":---"
        : alignment === "center"
          ? ":---:"
          : alignment === "right"
            ? "---:"
            : "---",
    )
    .join(" | ")} |`;
  const body = hasHeader ? cells.slice(1) : cells;
  return `${[header, delimiter, ...body.map(renderRow)].join("\n")}\n`;
}

type TableAlignment = "left" | "center" | "right";

function nodeMarkdown(
  node: ProseMirrorNode,
  indentation = "",
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): string {
  if (node.type.name === "section") {
    const header = node.firstChild;
    const body = node.childCount > 1 ? node.child(1) : null;
    const children = node.childCount > 2 ? node.child(2) : null;
    let result = `# ${header ? inlineMarkdown(header, resolveInternalLinkTitle) : "無題"}\n\n`;
    body?.forEach((child) => {
      result += nodeMarkdown(child, indentation, resolveInternalLinkTitle);
    });
    children?.forEach((child) => {
      if (result && !result.endsWith("\n\n")) result += "\n";
      result += nodeMarkdown(child, indentation, resolveInternalLinkTitle);
    });
    return result;
  }
  if (node.type.name === "paragraph") {
    return `${protectParagraphBlockStart(inlineMarkdown(node, resolveInternalLinkTitle))}\n`;
  }
  if (node.type.name === "horizontalRule") {
    return `${indentation}---\n`;
  }
  if (node.type.name === "blockquote") {
    const blocks: string[] = [];
    node.forEach((child) => {
      const markdown = nodeMarkdown(child, "", resolveInternalLinkTitle);
      blocks.push(markdown.replace(/\n+$/u, ""));
    });
    const quoted = blocks
      .join("\n\n")
      .split("\n")
      .map((line) => `${indentation}>${line ? ` ${line}` : ""}`)
      .join("\n");
    return `${quoted}\n`;
  }
  if (node.type.name === "codeBlock") {
    const language = String(node.attrs.language ?? "");
    return `\`\`\`${language}\n${node.textContent}\n\`\`\`\n`;
  }
  if (node.type.name === "sourceBlock") {
    return `${node.textContent}\n`;
  }
  if (node.type.name === "image") {
    const alt = escapeAttachmentLabel(String(node.attrs.alt ?? ""));
    const target = attachmentMarkdownTarget(
      node.attrs.attachmentId ?? node.attrs.src,
    );
    return `![${alt}](${target})\n`;
  }
  if (node.type.name === "attachment") {
    const label = escapeAttachmentLabel(
      String(node.attrs.label || "Attachment"),
    );
    const target = attachmentMarkdownTarget(node.attrs.attachmentId);
    return `[${label}](${target})\n`;
  }
  if (node.type.name === "table") {
    const rows: ProseMirrorNode[] = [];
    node.forEach((row) => rows.push(row));
    return tableMarkdown(rows, resolveInternalLinkTitle);
  }
  if (node.type.name === "tableRow") {
    return tableMarkdown([node], resolveInternalLinkTitle);
  }
  if (node.type.name === "bulletList" || node.type.name === "orderedList") {
    let result = "";
    const ordered = node.type.name === "orderedList";
    const rawStart = Number(node.attrs.start);
    const start =
      Number.isSafeInteger(rawStart) && rawStart >= 0 ? rawStart : 1;
    node.forEach((item, _offset, itemIndex) => {
      const marker = ordered ? `${start + itemIndex}.` : "-";
      const continuationIndentation = `${indentation}${" ".repeat(
        marker.length + 1,
      )}`;
      const first = item.firstChild;
      result += `${indentation}${marker} ${
        first?.type.name === "paragraph"
          ? inlineMarkdown(first, resolveInternalLinkTitle)
          : ""
      }\n`;
      for (let index = 1; index < item.childCount; index += 1) {
        const child = item.child(index);
        if (
          child.type.name === "bulletList" ||
          child.type.name === "orderedList"
        ) {
          result += nodeMarkdown(
            child,
            continuationIndentation,
            resolveInternalLinkTitle,
          );
          continue;
        }
        const continuation = nodeMarkdown(child, "", resolveInternalLinkTitle);
        for (const line of continuation.replace(/\n$/u, "").split("\n")) {
          result += `${continuationIndentation}${line}\n`;
        }
      }
    });
    return result;
  }
  if (node.type.name === "listItem") {
    let result = "";
    node.forEach((child) => {
      result += nodeMarkdown(child, indentation, resolveInternalLinkTitle);
    });
    return result;
  }
  let result = "";
  node.forEach((child) => {
    result += nodeMarkdown(child, indentation, resolveInternalLinkTitle);
  });
  return result;
}

function attachmentMarkdownTarget(value: unknown): string {
  const source = typeof value === "string" ? value : "attachment:missing";
  return source.startsWith("attachment:") ? source : `attachment:${source}`;
}

function escapeAttachmentLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(/[[\]_*`#]/gu, "\\$&");
}

function protectParagraphBlockStart(value: string): string {
  const match = value.match(
    /^( {0,3})(#{1,6}[ \t]|[-+*][ \t]|>\s?|`{3}|~{3}|\d+[.)][ \t]|(?:[-_*][ \t]*){3,})/u,
  );
  if (!match) return value;
  const prefix = match[1] ?? "";
  const marker = value[prefix.length];
  return marker
    ? `${prefix}\\${marker}${value.slice(prefix.length + 1)}`
    : value;
}

function registerMarkdown(
  register: VimRegister,
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): string {
  if (register.kind === "text") {
    if (!register.slice) return register.text;
    const parts: string[] = [];
    register.slice.content.forEach((node) => {
      parts.push(
        node.isInline
          ? inlineMarkdown(node, resolveInternalLinkTitle)
          : nodeMarkdown(node, "", resolveInternalLinkTitle).replace(
              /\n$/u,
              "",
            ),
      );
    });
    return parts.join(
      register.slice.content.firstChild?.isInline ? "" : "\n\n",
    );
  }
  if (register.kind === "block-lines") {
    if (!register.slice) return register.text;
    let inline = "";
    register.slice.content.forEach((node) => {
      inline += inlineMarkdown(node, resolveInternalLinkTitle);
    });
    return register.blockNodeName === "paragraph"
      ? protectParagraphBlockStart(inline)
      : register.text;
  }
  const blocks: string[] = [];
  register.slice.content.forEach((node) => {
    const markdown = nodeMarkdown(node, "", resolveInternalLinkTitle);
    blocks.push(markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown);
  });
  return blocks.join("\n\n");
}

function payloadForRegister(register: VimRegister): MemokaClipboardPayload {
  if (register.kind === "text") {
    return {
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "text",
      text: register.text,
      slice: register.slice
        ? {
            content: register.slice.content.toJSON(),
            openStart: register.slice.openStart,
            openEnd: register.slice.openEnd,
          }
        : undefined,
    };
  }
  if (register.kind === "block-lines") {
    return {
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "block-lines",
      text: register.text,
      lineCount: register.lineCount,
      behaviorId: register.behaviorId,
      blockNodeName: register.blockNodeName,
      blockAttrs: register.blockAttrs,
      slice: register.slice
        ? {
            content: register.slice.content.toJSON(),
            openStart: register.slice.openStart,
            openEnd: register.slice.openEnd,
          }
        : undefined,
    };
  }
  if (register.kind === "section") {
    return {
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "section",
      text: register.text,
      transfer: register.transfer,
      sourceNoteId: register.sourceNoteId,
      sectionIds: [...register.sectionIds],
      slice: {
        content: register.slice.content.toJSON(),
        openStart: 0,
        openEnd: 0,
      },
    };
  }
  return {
    schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
    kind: "structure",
    text: register.text,
    structureKind: register.structureKind,
    nodeNames: register.nodeNames,
    slice: {
      content: register.slice.content.toJSON(),
      openStart: register.slice.openStart,
      openEnd: register.slice.openEnd,
    },
  };
}

export function encodeVimClipboard(
  register: VimRegister,
  schema: Schema,
  resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
): VimClipboardFormats {
  const markdown = registerMarkdown(register, resolveInternalLinkTitle);
  return {
    [MEMOKA_CLIPBOARD_MIME]: JSON.stringify(payloadForRegister(register)),
    "text/html": structureHtml(register, schema),
    [MARKDOWN_CLIPBOARD_MIME]: markdown,
    "text/plain":
      register.kind === "structure" || register.kind === "section"
        ? markdown
        : register.text,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeVimClipboard(
  raw: string,
  schema: Schema,
): VimRegister | null {
  try {
    const payload: unknown = JSON.parse(raw);
    if (
      !isObject(payload) ||
      (payload.schemaVersion !== 1 &&
        payload.schemaVersion !== 2 &&
        payload.schemaVersion !== 4 &&
        payload.schemaVersion !== 5 &&
        payload.schemaVersion !== MEMOKA_CLIPBOARD_SCHEMA_VERSION) ||
      typeof payload.kind !== "string" ||
      typeof payload.text !== "string"
    ) {
      return null;
    }
    if (payload.kind === "text") {
      let slice: Slice | undefined;
      if (
        payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION &&
        payload.slice !== undefined
      ) {
        const decoded = clipboardSlice(payload.slice, schema);
        if (!decoded || !sliceHasSafeExternalLinks(decoded)) return null;
        slice = decoded;
      }
      return { kind: "text", text: payload.text, slice };
    }
    if (
      payload.schemaVersion === 1 &&
      payload.kind === "code-lines" &&
      Number.isInteger(payload.lineCount) &&
      Number(payload.lineCount) > 0 &&
      typeof payload.codeBlockNodeName === "string" &&
      schema.nodes[payload.codeBlockNodeName] !== undefined &&
      defaultVimBlockSemantics.hasBehavior(
        payload.codeBlockNodeName,
        "code-block",
      ) &&
      isObject(payload.codeBlockAttrs)
    ) {
      return {
        kind: "block-lines",
        text: payload.text,
        lineCount: Number(payload.lineCount),
        behaviorId: "code-block",
        blockNodeName: payload.codeBlockNodeName,
        blockAttrs: payload.codeBlockAttrs,
      };
    }
    if (
      (payload.schemaVersion === 2 ||
        payload.schemaVersion === 4 ||
        payload.schemaVersion === 5 ||
        payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION) &&
      payload.kind === "block-lines" &&
      Number.isInteger(payload.lineCount) &&
      Number(payload.lineCount) > 0 &&
      typeof payload.behaviorId === "string" &&
      typeof payload.blockNodeName === "string" &&
      schema.nodes[payload.blockNodeName] !== undefined &&
      defaultVimBlockSemantics.hasBehavior(
        payload.blockNodeName,
        payload.behaviorId,
      ) &&
      isObject(payload.blockAttrs)
    ) {
      let slice: Slice | undefined;
      if (payload.slice !== undefined) {
        if (
          !isObject(payload.slice) ||
          !Number.isInteger(payload.slice.openStart) ||
          !Number.isInteger(payload.slice.openEnd) ||
          Number(payload.slice.openStart) !== 0 ||
          Number(payload.slice.openEnd) !== 0
        ) {
          return null;
        }
        slice = new Slice(
          Fragment.fromJSON(schema, payload.slice.content),
          Number(payload.slice.openStart),
          Number(payload.slice.openEnd),
        );
        if (!sliceHasSafeExternalLinks(slice)) return null;
        try {
          schema.nodes[payload.blockNodeName]?.createChecked(
            payload.blockAttrs,
            slice.content,
          );
        } catch {
          return null;
        }
      }
      return {
        kind: "block-lines",
        text: payload.text,
        lineCount: Number(payload.lineCount),
        behaviorId: payload.behaviorId,
        blockNodeName: payload.blockNodeName,
        blockAttrs: payload.blockAttrs,
        slice,
      };
    }
    if (
      (payload.schemaVersion === 5 ||
        payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION) &&
      payload.kind === "section" &&
      (payload.transfer === "copy" || payload.transfer === "cut") &&
      (payload.sourceNoteId === null ||
        typeof payload.sourceNoteId === "string") &&
      Array.isArray(payload.sectionIds) &&
      payload.sectionIds.length > 0 &&
      payload.sectionIds.every((id) => typeof id === "string") &&
      isObject(payload.slice) &&
      payload.slice.openStart === 0 &&
      payload.slice.openEnd === 0
    ) {
      const slice = new Slice(
        Fragment.fromJSON(schema, payload.slice.content),
        0,
        0,
      );
      if (
        slice.content.childCount !== 1 ||
        slice.content.firstChild?.type.name !== "section" ||
        !sliceHasSafeExternalLinks(slice)
      ) {
        return null;
      }
      return {
        kind: "section",
        text: payload.text,
        transfer: payload.transfer,
        sourceNoteId: payload.sourceNoteId,
        sectionIds: payload.sectionIds,
        slice,
      };
    }
    if (
      payload.kind === "structure" &&
      (payload.structureKind === "block" ||
        payload.structureKind === "list-item" ||
        ((payload.schemaVersion === 4 ||
          payload.schemaVersion === 5 ||
          payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION) &&
          payload.structureKind === "table-row")) &&
      Array.isArray(payload.nodeNames) &&
      payload.nodeNames.every((name) => typeof name === "string") &&
      isObject(payload.slice) &&
      Number.isInteger(payload.slice.openStart) &&
      Number.isInteger(payload.slice.openEnd)
    ) {
      const slice = new Slice(
        Fragment.fromJSON(schema, payload.slice.content),
        Number(payload.slice.openStart),
        Number(payload.slice.openEnd),
      );
      if (!sliceHasSafeExternalLinks(slice)) return null;
      if (payload.structureKind === "table-row") {
        let containsOnlyRows = slice.content.childCount > 0;
        slice.content.forEach((node) => {
          containsOnlyRows &&= node.type.name === "tableRow";
        });
        if (slice.openStart !== 0 || slice.openEnd !== 0 || !containsOnlyRows) {
          return null;
        }
      }
      return {
        kind: "structure",
        text: payload.text,
        structureKind: payload.structureKind,
        nodeNames: payload.nodeNames,
        slice,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function clipboardSlice(value: unknown, schema: Schema): Slice | null {
  if (
    !isObject(value) ||
    !Number.isInteger(value.openStart) ||
    !Number.isInteger(value.openEnd) ||
    Number(value.openStart) < 0 ||
    Number(value.openEnd) < 0
  ) {
    return null;
  }
  try {
    return new Slice(
      Fragment.fromJSON(schema, value.content),
      Number(value.openStart),
      Number(value.openEnd),
    );
  } catch {
    return null;
  }
}

function sliceHasSafeExternalLinks(slice: Slice): boolean {
  let safe = true;
  const inspect = (node: ProseMirrorNode): boolean => {
    for (const mark of node.marks) {
      if (
        mark.type.name === "link" &&
        !normalizeExternalLink(String(mark.attrs.href ?? "")).valid
      ) {
        safe = false;
        return false;
      }
    }
    return safe;
  };
  slice.content.forEach((node) => {
    if (!inspect(node)) return;
    node.descendants((child) => inspect(child));
  });
  return safe;
}

export function readInternalClipboard(
  data: Pick<DataTransfer, "getData" | "types">,
  schema: Schema,
): VimRegister | null {
  return Array.from(data.types).includes(MEMOKA_CLIPBOARD_MIME)
    ? decodeVimClipboard(data.getData(MEMOKA_CLIPBOARD_MIME), schema)
    : null;
}

export function readMarkdownClipboard(
  data: Pick<DataTransfer, "getData" | "types">,
  schema: Schema,
): VimRegister | null {
  const types = Array.from(data.types);
  if (!types.includes(MARKDOWN_CLIPBOARD_MIME) || types.includes("text/html")) {
    return null;
  }
  return registerFromMarkdown(data.getData(MARKDOWN_CLIPBOARD_MIME), schema);
}

export function registerFromMarkdown(
  markdown: string,
  schema: Schema,
): VimRegister | null {
  const parsed = parseMarkdownPaste(markdown, schema);
  return parsed
    ? {
        kind: "structure",
        text: parsed.text,
        structureKind: "block",
        nodeNames: parsed.nodeNames,
        slice: parsed.slice,
      }
    : null;
}

export class BrowserVimClipboard {
  supportsNativeBridge(): boolean {
    return (
      typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
    );
  }

  async readPreferred(): Promise<PreferredClipboardFormats | null> {
    if (!this.supportsNativeBridge()) return null;
    try {
      const value = await invoke<unknown>("clipboard_read_preferred");
      return validatePreferredClipboardFormats(value);
    } catch {
      return null;
    }
  }

  async readExplicit(
    format: ExplicitClipboardFormat,
  ): Promise<ExplicitClipboardContent | null> {
    if (this.supportsNativeBridge()) {
      try {
        const value = await invoke<unknown>("clipboard_read_explicit", {
          format,
        });
        const validated = validateExplicitClipboardContent(value);
        if (validated) return validated;
      } catch {
        // Fall through to the Web Clipboard API when the native bridge is not
        // implemented for this platform or cannot expose the requested MIME.
      }
    }

    const clipboard = navigator.clipboard;
    if (!clipboard) return null;
    const requestedMime =
      format === "markdown" ? MARKDOWN_CLIPBOARD_MIME : "text/html";
    if (typeof clipboard.read === "function") {
      try {
        const items = await clipboard.read();
        const availableTypes = Array.from(
          new Set(items.flatMap((item) => Array.from(item.types))),
        ).sort();
        for (const item of items) {
          if (!item.types.includes(requestedMime)) continue;
          const blob = await item.getType(requestedMime);
          return {
            availableTypes,
            sourceMime: requestedMime,
            content: await blob.text(),
          };
        }
      } catch {
        // readText remains a useful fallback in WebKit versions which reject
        // rich Clipboard reads.
      }
    }
    if (typeof clipboard.readText !== "function") return null;
    try {
      return {
        availableTypes: ["text/plain"],
        sourceMime: "text/plain",
        content: await clipboard.readText(),
      };
    } catch {
      return null;
    }
  }

  async write(
    register: VimRegister,
    schema: Schema,
    resolveInternalLinkTitle?: InternalLinkClipboardTitleResolver,
  ): Promise<VimClipboardWriteResult> {
    const formats = encodeVimClipboard(
      register,
      schema,
      resolveInternalLinkTitle,
    );
    if (this.supportsNativeBridge()) {
      try {
        await invoke("clipboard_write_rich", {
          formats: {
            internal: formats[MEMOKA_CLIPBOARD_MIME],
            html: formats["text/html"],
            markdown: formats[MARKDOWN_CLIPBOARD_MIME],
            plain: formats["text/plain"],
          },
        });
        return "rich";
      } catch {
        // A platform without the native bridge can still use the Web API.
      }
    }

    const clipboard = navigator.clipboard;
    if (!clipboard) return "unavailable";

    if (
      typeof globalThis.ClipboardItem === "function" &&
      typeof clipboard.write === "function"
    ) {
      try {
        const entries = Object.fromEntries(
          Object.entries(formats).map(([type, content]) => [
            type,
            new Blob([content], { type }),
          ]),
        );
        await clipboard.write([new ClipboardItem(entries)]);
        return "rich";
      } catch {
        // WebKit versions that reject custom MIME still get plain text below.
      }
    }

    if (typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(formats["text/plain"]);
        return "plain-text";
      } catch {
        return "unavailable";
      }
    }
    return "unavailable";
  }
}

function validatePreferredClipboardFormats(
  value: unknown,
): PreferredClipboardFormats | null {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !Array.isArray(value.availableTypes) ||
    !value.availableTypes.every((type) => typeof type === "string") ||
    (value.internal !== null && typeof value.internal !== "string") ||
    (value.markdown !== null && typeof value.markdown !== "string") ||
    (value.plain !== undefined &&
      value.plain !== null &&
      typeof value.plain !== "string") ||
    (value.filePaths !== undefined &&
      (!Array.isArray(value.filePaths) ||
        !value.filePaths.every((path) => typeof path === "string")))
  ) {
    return null;
  }
  return {
    availableTypes: value.availableTypes,
    internal: value.internal,
    markdown: value.markdown,
    plain: value.plain ?? null,
    filePaths: value.filePaths ?? [],
  };
}

function validateExplicitClipboardContent(
  value: unknown,
): ExplicitClipboardContent | null {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !Array.isArray(value.availableTypes) ||
    !value.availableTypes.every((type) => typeof type === "string") ||
    typeof value.sourceMime !== "string" ||
    typeof value.content !== "string"
  ) {
    return null;
  }
  return {
    availableTypes: value.availableTypes,
    sourceMime: value.sourceMime,
    content: value.content,
  };
}
