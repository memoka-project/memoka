import { invoke } from "@tauri-apps/api/core";
import {
  DOMParser as ProseMirrorDOMParser,
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
import { sanitizeExternalHtml } from "../editor/html-paste";
import { normalizeExternalLink } from "../core/external-links";
import { createUuidV7 } from "../core/ids";
import { defaultVimBlockSemantics } from "./block-semantics";
import type { VimRegister } from "./editor-commands";

export const MEMOKA_CLIPBOARD_MIME =
  "application/x-memoka-structured-blocks+json";
export const MARKDOWN_CLIPBOARD_MIME = "text/markdown";
export const TSV_CLIPBOARD_MIME = "text/tab-separated-values";
export const MEMOKA_CLIPBOARD_SCHEMA_VERSION = 7;

interface TextClipboardPayload {
  schemaVersion: 7;
  kind: "text";
  text: string;
  slice?: {
    content: unknown;
    openStart: number;
    openEnd: number;
  };
}

interface BlockLinesClipboardPayload {
  schemaVersion: 7;
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
  schemaVersion: 7;
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
  schemaVersion: 7;
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

interface TableCellsClipboardPayload {
  schemaVersion: 7;
  kind: "table-cells";
  text: string;
  width: number;
  height: number;
  includesHeader: boolean;
  alignments: Array<"left" | "center" | "right" | null>;
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
  | SectionClipboardPayload
  | TableCellsClipboardPayload;

export interface VimClipboardFormats {
  [MEMOKA_CLIPBOARD_MIME]: string;
  "text/html": string;
  [MARKDOWN_CLIPBOARD_MIME]: string;
  "text/plain": string;
  [TSV_CLIPBOARD_MIME]?: string;
}

export type VimClipboardWriteResult = "rich" | "plain-text" | "unavailable";

export interface PreferredClipboardFormats {
  availableTypes: string[];
  internal: string | null;
  markdown: string | null;
  html?: string | null;
  tsv?: string | null;
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
  if (
    register.kind === "table-cells" ||
    (register.kind === "structure" && register.structureKind === "table-row")
  ) {
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
  if (register.kind === "table-cells") {
    const rows: ProseMirrorNode[] = [];
    register.slice.content.forEach((row) => rows.push(row));
    return tableMarkdown(rows, resolveInternalLinkTitle);
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
  if (register.kind === "table-cells") {
    return {
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "table-cells",
      text: register.text,
      width: register.width,
      height: register.height,
      includesHeader: register.includesHeader,
      alignments: [...register.alignments],
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
  const tableRows: ProseMirrorNode[] = [];
  if (register.kind === "table-cells") {
    register.slice.content.forEach((row) => tableRows.push(row));
  }
  const tsv =
    register.kind === "table-cells" ? tableRowsTsv(tableRows) : undefined;
  return {
    [MEMOKA_CLIPBOARD_MIME]: JSON.stringify(payloadForRegister(register)),
    "text/html": structureHtml(register, schema),
    [MARKDOWN_CLIPBOARD_MIME]: markdown,
    "text/plain":
      register.kind === "structure" ||
      register.kind === "section" ||
      register.kind === "table-cells"
        ? markdown
        : register.text,
    ...(tsv === undefined ? {} : { [TSV_CLIPBOARD_MIME]: tsv }),
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
        payload.schemaVersion !== 6 &&
        payload.schemaVersion !== MEMOKA_CLIPBOARD_SCHEMA_VERSION) ||
      typeof payload.kind !== "string" ||
      typeof payload.text !== "string"
    ) {
      return null;
    }
    if (payload.kind === "text") {
      let slice: Slice | undefined;
      if (
        (payload.schemaVersion === 6 ||
          payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION) &&
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
        payload.schemaVersion === 6 ||
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
        payload.schemaVersion === 6 ||
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
      payload.schemaVersion === MEMOKA_CLIPBOARD_SCHEMA_VERSION &&
      payload.kind === "table-cells" &&
      Number.isInteger(payload.width) &&
      Number(payload.width) > 0 &&
      Number.isInteger(payload.height) &&
      Number(payload.height) > 0 &&
      typeof payload.includesHeader === "boolean" &&
      Array.isArray(payload.alignments) &&
      payload.alignments.length === Number(payload.width) &&
      payload.alignments.every(
        (align) =>
          align === null ||
          align === "left" ||
          align === "center" ||
          align === "right",
      )
    ) {
      const slice = clipboardSlice(payload.slice, schema);
      if (
        !slice ||
        slice.openStart !== 0 ||
        slice.openEnd !== 0 ||
        slice.content.childCount !== Number(payload.height) ||
        !sliceHasSafeExternalLinks(slice)
      ) {
        return null;
      }
      let rowsValid = true;
      const rows: ProseMirrorNode[] = [];
      slice.content.forEach((row) => {
        rowsValid &&=
          row.type.name === "tableRow" &&
          row.childCount === Number(payload.width);
        rows.push(row);
      });
      const validated = rowsValid ? tableCellsRegisterFromRows(rows) : null;
      if (
        !validated ||
        validated.width !== Number(payload.width) ||
        validated.height !== Number(payload.height) ||
        validated.includesHeader !== payload.includesHeader
      ) {
        return null;
      }
      return {
        kind: "table-cells",
        text: payload.text,
        width: Number(payload.width),
        height: Number(payload.height),
        includesHeader: payload.includesHeader,
        alignments: validated.alignments,
        slice,
      };
    }
    if (
      payload.kind === "structure" &&
      (payload.structureKind === "block" ||
        payload.structureKind === "list-item" ||
        ((payload.schemaVersion === 4 ||
          payload.schemaVersion === 5 ||
          payload.schemaVersion === 6 ||
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

function tableCellsRegisterFromRows(
  rows: readonly ProseMirrorNode[],
): Extract<VimRegister, { kind: "table-cells" }> | null {
  if (rows.length === 0) return null;
  let width = -1;
  let valid = true;
  rows.forEach((row) => {
    if (row.type.name !== "tableRow" || row.childCount === 0) {
      valid = false;
      return;
    }
    if (width < 0) width = row.childCount;
    if (row.childCount !== width) valid = false;
    row.forEach((cell) => {
      if (
        (cell.type.name !== "tableCell" && cell.type.name !== "tableHeader") ||
        cell.attrs.colspan !== 1 ||
        cell.attrs.rowspan !== 1
      ) {
        valid = false;
      }
    });
  });
  if (!valid || width <= 0) return null;
  const includesHeader = rows[0]!.content.content.every(
    (cell) => cell.type.name === "tableHeader",
  );
  const alignments = Array.from<"left" | "center" | "right" | null>({
    length: width,
  }).fill(null);
  for (const row of rows) {
    row.forEach((cell, _offset, column) => {
      const align = cell.attrs.align;
      if (
        alignments[column] === null &&
        (align === "left" || align === "center" || align === "right")
      ) {
        alignments[column] = align;
      }
    });
  }
  const slice = new Slice(Fragment.fromArray([...rows]), 0, 0);
  if (!sliceHasSafeExternalLinks(slice)) return null;
  return {
    kind: "table-cells",
    text: tableRowsTsv(rows),
    width,
    height: rows.length,
    includesHeader,
    alignments,
    slice,
  };
}

export function registerFromMarkdownTable(
  markdown: string,
  schema: Schema,
): Extract<VimRegister, { kind: "table-cells" }> | null {
  const parsed = parseMarkdownPaste(markdown, schema);
  const table =
    parsed?.slice.content.childCount === 1 &&
    parsed.slice.content.firstChild?.type.name === "table"
      ? parsed.slice.content.firstChild
      : null;
  if (!table) return null;
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  return tableCellsRegisterFromRows(rows);
}

export function registerFromHtmlTable(
  html: string,
  schema: Schema,
): Extract<VimRegister, { kind: "table-cells" }> | null {
  if (typeof document === "undefined") return null;
  const sanitized = sanitizeExternalHtml(html);
  if (!sanitized) return null;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = sanitized;
  const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(wrapper);
  const table =
    parsed.childCount === 1 && parsed.firstChild?.type.name === "table"
      ? parsed.firstChild
      : null;
  if (!table) return null;
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  return tableCellsRegisterFromRows(rows);
}

export function registerFromTabSeparatedValues(
  source: string,
  schema: Schema,
): Extract<VimRegister, { kind: "table-cells" }> | null {
  const values = parseTabSeparatedValues(source);
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const paragraphType = schema.nodes.paragraph;
  if (!values || !rowType || !cellType || !paragraphType) return null;
  const width = Math.max(...values.map((row) => row.length));
  if (width <= 0) return null;
  const rows = values.map((row) => {
    const cells = Array.from({ length: width }, (_, column) => {
      const value = row[column] ?? "";
      const paragraphs = value
        .split("\n")
        .map((line) =>
          paragraphType.create(
            { blockId: createUuidV7() },
            line.length > 0 ? schema.text(line) : null,
          ),
        );
      return cellType.create(
        {
          blockId: createUuidV7(),
          colspan: 1,
          rowspan: 1,
          colwidth: null,
          align: null,
        },
        Fragment.fromArray(paragraphs),
      );
    });
    return rowType.create(
      { blockId: createUuidV7() },
      Fragment.fromArray(cells),
    );
  });
  return tableCellsRegisterFromRows(rows);
}

export function registerFromTabularClipboard(
  formats: Pick<
    PreferredClipboardFormats,
    "html" | "tsv" | "markdown" | "plain"
  >,
  schema: Schema,
): Extract<VimRegister, { kind: "table-cells" }> | null {
  return (
    (formats.html ? registerFromHtmlTable(formats.html, schema) : null) ??
    (formats.tsv
      ? registerFromTabSeparatedValues(formats.tsv, schema)
      : null) ??
    (formats.markdown
      ? registerFromMarkdownTable(formats.markdown, schema)
      : null) ??
    (formats.plain ? registerFromMarkdownTable(formats.plain, schema) : null)
  );
}

function tableRowsTsv(rows: readonly ProseMirrorNode[]): string {
  return rows
    .map((row) => {
      const cells: string[] = [];
      row.forEach((cell) =>
        cells.push(
          escapeTsvCell(cell.textBetween(0, cell.content.size, "\n", "\n")),
        ),
      );
      return cells.join("\t");
    })
    .join("\n");
}

function escapeTsvCell(value: string): string {
  return /[\t\r\n"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function parseTabSeparatedValues(source: string): string[][] | null {
  if (source.length === 0) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === "\t") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) return null;
  if (row.length > 0 || value.length > 0 || !source.endsWith("\n")) {
    row.push(value.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
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
            tsv: formats[TSV_CLIPBOARD_MIME] ?? null,
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
    (value.html !== undefined &&
      value.html !== null &&
      typeof value.html !== "string") ||
    (value.tsv !== undefined &&
      value.tsv !== null &&
      typeof value.tsv !== "string") ||
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
    html: value.html ?? null,
    tsv: value.tsv ?? null,
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
