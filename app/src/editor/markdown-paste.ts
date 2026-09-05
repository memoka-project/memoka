import {
  Fragment,
  Slice,
  type Mark,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { createUuidV7, isUuidV7 } from "../core/ids";
import { BODY_CHUNK_TARGET_BLOCKS } from "../core/section-model";
import {
  isSafeExternalLink,
  normalizeExternalLink,
} from "../core/external-links";
import { inlineMarkdownText } from "../core/inline-markdown";
import {
  parseMarkdownAlertMarker,
  type MarkdownAlert,
} from "../core/markdown-alert";

export interface ParsedMarkdownPaste {
  slice: Slice;
  text: string;
  nodeNames: string[];
  sourceBlockCount: number;
}

/**
 * A complete external Markdown document mapped onto one Memoka NoteDoc.
 * The returned root keeps the caller-provided Note ID; every imported child
 * Section and block receives a fresh UUIDv7.
 */
export interface ParsedMarkdownNote {
  root: ProseMirrorNode;
  title: string;
  sectionCount: number;
  blockCount: number;
  sourceBlockCount: number;
}

type ListKind = "bullet" | "ordered";

interface ListDraft {
  kind: ListKind;
  start: number;
  items: ListItemDraft[];
}

interface ListItemDraft {
  paragraphLines: string[];
  children: ListDraft[];
}

interface ParsedListLine {
  indent: number;
  kind: ListKind;
  start: number;
  inline: string;
  contentIndent: number;
}

type TableAlignment = "left" | "center" | "right" | null;

interface ParsedTable {
  end: number;
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

interface ParsedBlockquote {
  end: number;
  lines: string[];
  alert: MarkdownAlert | null;
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BULLET_LINE = /^( *)([-+*])([ \t]+)(.+)$/u;
const ORDERED_LIST_LINE = /^( *)(\d{1,9})[.)]([ \t]+)(.+)$/u;
const HEADING_LINE = /^(#{1,6})[ \t]+(.+)$/u;
const IMAGE_LINE =
  /^!\[((?:\\.|[^\]\\\n])*)\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)$/u;
const HTML_IMAGE_LINE = /^ {0,3}<img\s+([^<>]+?)\s*\/?>(?:\s*)$/iu;
const ATTACHMENT_LINE =
  /^\[((?:\\.|[^\]\\\n])+)\]\(attachment:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)$/iu;
const TASK_LIST_LINE = /^ *[-+*][ \t]+\[[ xX]\][ \t]+/u;
const THEMATIC_BREAK = /^ {0,3}(([-_*])(?:[ \t]*\2){2,})[ \t]*$/u;
const TABLE_DELIMITER = /^ {0,3}\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|? *$/u;
const INLINE_PARSE_PREFIX = "memoka-inline-prefix:";
const HIGHLIGHT_OPEN = "\uE000";
const HIGHLIGHT_CLOSE = "\uE001";
const inlineMarkdownParser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownAstNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly alt?: string;
  readonly depth?: number;
  readonly children?: readonly MarkdownAstNode[];
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

interface MarkdownSectionDraft {
  readonly markdownDepth: number;
  readonly title: string;
  readonly body: Fragment;
  readonly children: MarkdownSectionDraft[];
}

export function parseMarkdownPaste(
  markdown: string,
  schema: Schema,
): ParsedMarkdownPaste | null {
  const normalized = normalizeMarkdown(markdown);
  if (!normalized.trim()) return null;
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const nodes: ProseMirrorNode[] = [];
  let sourceBlockCount = 0;
  let index = 0;

  const appendSource = (from: number, to: number): boolean => {
    const source = sourceBlock(schema, lines.slice(from, to).join("\n"));
    if (!source) return false;
    nodes.push(source);
    sourceBlockCount += 1;
    return true;
  };

  while (index < lines.length) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const frontmatterEnd = frontmatterBlockEnd(lines, index);
    if (frontmatterEnd !== null) {
      if (!appendSource(index, frontmatterEnd)) return null;
      index = frontmatterEnd;
      continue;
    }

    const fence = fencedBlockRange(lines, index);
    if (fence) {
      const code =
        fence.closed && fence.language !== null
          ? codeBlock(
              schema,
              lines.slice(index + 1, fence.end - 1).join("\n"),
              fence.language,
            )
          : null;
      if (code) nodes.push(code);
      else if (!appendSource(index, fence.end)) return null;
      index = fence.end;
      continue;
    }

    const blockquote = parsedBlockquoteRange(lines, index);
    if (blockquote) {
      const quoteMarkdown = blockquote.lines.join("\n");
      const parsed = quoteMarkdown.trim()
        ? parseMarkdownPaste(quoteMarkdown, schema)
        : null;
      const emptyAlertParagraph =
        blockquote.alert && !parsed
          ? schema.nodes.paragraph?.create({ blockId: createUuidV7() })
          : null;
      const content =
        parsed?.slice.content ??
        (emptyAlertParagraph ? Fragment.from(emptyAlertParagraph) : null);
      const node =
        content &&
        schema.nodes.blockquote?.createChecked(
          {
            blockId: createUuidV7(),
            alertType: blockquote.alert?.type ?? null,
            alertTitle: blockquote.alert?.title ?? null,
            alertFold: blockquote.alert?.fold ?? null,
          },
          content,
        );
      if (node) {
        nodes.push(node);
        sourceBlockCount += parsed?.sourceBlockCount ?? 0;
      } else if (!appendSource(index, blockquote.end)) {
        return null;
      }
      index = blockquote.end;
      continue;
    }

    if (THEMATIC_BREAK.test(lines[index] ?? "")) {
      const horizontalRule = schema.nodes.horizontalRule?.createChecked({
        blockId: createUuidV7(),
      });
      if (horizontalRule) nodes.push(horizontalRule);
      else if (!appendSource(index, index + 1)) return null;
      index += 1;
      continue;
    }

    if (parseListLine(lines[index] ?? "") !== null) {
      const end = nextListBlockEnd(lines, index);
      const list = listBlock(schema, lines.slice(index, end));
      if (list) nodes.push(list);
      else if (!appendSource(index, end)) return null;
      index = end;
      continue;
    }

    const table = parsedTableRange(lines, index);
    if (table) {
      const node = tableBlock(schema, table);
      if (node) nodes.push(node);
      else if (!appendSource(index, table.end)) return null;
      index = table.end;
      continue;
    }

    const htmlImage = parseHtmlImageLine(lines[index] ?? "");
    if (htmlImage) {
      const node = imageBlock(
        schema,
        htmlImage.alt,
        htmlImage.target,
        htmlImage.width,
      );
      if (node) nodes.push(node);
      else if (!appendSource(index, index + 1)) return null;
      index += 1;
      continue;
    }

    const unsupportedEnd = unsupportedBlockEnd(lines, index);
    if (unsupportedEnd !== null) {
      if (!appendSource(index, unsupportedEnd)) return null;
      index = unsupportedEnd;
      continue;
    }

    const image = lines[index]?.match(IMAGE_LINE);
    if (image) {
      const node = imageBlock(
        schema,
        unescapeAttachmentLabel(image[1] ?? ""),
        image[2] ?? "",
      );
      if (node) nodes.push(node);
      else if (!appendSource(index, index + 1)) return null;
      index += 1;
      continue;
    }

    const attachment = lines[index]?.match(ATTACHMENT_LINE);
    if (attachment) {
      const node = attachmentBlock(
        schema,
        unescapeAttachmentLabel(attachment[1] ?? "Attachment"),
        attachment[2] ?? "",
      );
      if (node) nodes.push(node);
      else if (!appendSource(index, index + 1)) return null;
      index += 1;
      continue;
    }

    const heading = lines[index]?.match(HEADING_LINE);
    if (heading) {
      // Section creation is an intentional keyboard action (`# ` at the
      // beginning of a direct-body paragraph). Pasted Markdown never changes
      // the Section tree implicitly, so a heading-looking line stays literal.
      const inline = parseInlineMarkdown(lines[index] ?? "", schema);
      const node =
        inline &&
        schema.nodes.paragraph?.create(
          { blockId: createUuidV7() },
          inline.length > 0 ? Fragment.fromArray(inline) : null,
        );
      if (node) nodes.push(node);
      else if (!appendSource(index, index + 1)) return null;
      index += 1;
      continue;
    }

    const end = nextBlockStart(lines, index + 1);
    const paragraphLines = lines.slice(index, end);
    const inline = paragraphInline(paragraphLines, schema);
    const paragraph =
      inline &&
      schema.nodes.paragraph?.create(
        { blockId: createUuidV7() },
        inline.length > 0 ? Fragment.fromArray(inline) : null,
      );
    if (paragraph) nodes.push(paragraph);
    else if (!appendSource(index, end)) return null;
    index = end;
  }

  if (nodes.length === 0) return null;
  const nodeNames = new Set<string>();
  for (const node of nodes) {
    nodeNames.add(node.type.name);
    node.descendants((child) => {
      if (!child.isText) nodeNames.add(child.type.name);
    });
  }
  return {
    slice: new Slice(Fragment.fromArray(nodes), 0, 0),
    text: normalized,
    nodeNames: [...nodeNames],
    sourceBlockCount,
  };
}

/**
 * Parse a complete Markdown note. Unlike ordinary block paste, this entry
 * point deliberately interprets ATX headings as Memoka Sections:
 *
 * - the first H1 becomes the Root Section title;
 * - later H1 headings become direct child Sections of the Root;
 * - H2-H6 headings become child Sections beneath the nearest ancestor;
 * - blocks between headings become that Section's direct body.
 *
 * Skipped heading levels are clamped to one structural level below the
 * deepest available ancestor. Additional H1 headings remain in the same
 * NoteDoc and therefore become Root children rather than implicit Note
 * boundaries.
 */
export function parseMarkdownNote(
  markdown: string,
  schema: Schema,
  rootSectionId: string,
): ParsedMarkdownNote | null {
  const sectionType = schema.nodes.section;
  const headerType = schema.nodes.sectionHeader;
  const bodyType = schema.nodes.sectionBody;
  const chunkType = schema.nodes.bodyChunk;
  const childrenType = schema.nodes.sectionChildren;
  if (!sectionType || !headerType || !bodyType || !chunkType || !childrenType) {
    return null;
  }
  if (!isUuidV7(rootSectionId)) return null;

  const normalized = normalizeMarkdown(markdown);
  if (!normalized.trim()) return null;
  const tree = inlineMarkdownParser.parse(normalized) as MarkdownAstNode;
  const topLevel = tree.children ?? [];
  const first = topLevel[0];
  const firstStart = first?.position?.start.offset;
  if (
    first?.type !== "heading" ||
    first.depth !== 1 ||
    typeof firstStart !== "number" ||
    !/^#[ \t]+/u.test(normalized.slice(firstStart))
  ) {
    return null;
  }
  const headings = topLevel.filter(
    (node) =>
      node.type === "heading" &&
      typeof node.depth === "number" &&
      node.depth >= 1 &&
      node.depth <= 6,
  );
  if (headings.length === 0 || headings[0] !== first) return null;

  let sourceBlockCount = 0;
  let blockCount = 0;
  const drafts: MarkdownSectionDraft[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading) return null;
    const headingEnd = heading.position?.end.offset;
    const nextHeadingStart = headings[index + 1]?.position?.start.offset;
    if (typeof headingEnd !== "number") return null;
    const segment = normalized.slice(
      headingEnd,
      typeof nextHeadingStart === "number"
        ? nextHeadingStart
        : normalized.length,
    );
    const parsedBody = segment.trim()
      ? parseMarkdownPaste(segment, schema)
      : null;
    if (segment.trim() && !parsedBody) return null;
    sourceBlockCount += parsedBody?.sourceBlockCount ?? 0;
    blockCount += parsedBody?.slice.content.childCount ?? 0;
    const title = markdownHeadingText(heading, schema, normalized);
    if (!title) return null;
    drafts.push({
      markdownDepth: heading.depth ?? 1,
      title,
      body: parsedBody?.slice.content ?? Fragment.empty,
      children: [],
    });
  }

  const rootDraft = drafts[0];
  if (!rootDraft || rootDraft.markdownDepth !== 1) return null;
  const stack: MarkdownSectionDraft[] = [rootDraft];
  for (const draft of drafts.slice(1)) {
    while (
      stack.length > 1 &&
      (stack.at(-1)?.markdownDepth ?? 1) >= draft.markdownDepth
    ) {
      stack.pop();
    }
    const parent = stack.at(-1) ?? rootDraft;
    parent.children.push(draft);
    stack.push(draft);
  }

  const createSection = (
    draft: MarkdownSectionDraft,
    sectionId: string,
  ): ProseMirrorNode => {
    const header = headerType.createChecked(
      { sectionId, emoji: null, tags: "[]" },
      schema.text(draft.title),
    );
    const chunks: ProseMirrorNode[] = [];
    let pending: ProseMirrorNode[] = [];
    draft.body.forEach((node) => {
      if (pending.length >= BODY_CHUNK_TARGET_BLOCKS) {
        chunks.push(
          chunkType.createChecked(
            { chunkId: createUuidV7() },
            Fragment.fromArray(pending),
          ),
        );
        pending = [];
      }
      pending.push(node);
    });
    if (pending.length > 0) {
      chunks.push(
        chunkType.createChecked(
          { chunkId: createUuidV7() },
          Fragment.fromArray(pending),
        ),
      );
    }
    const body = bodyType.createChecked(null, Fragment.fromArray(chunks));
    const children = childrenType.createChecked(
      null,
      Fragment.fromArray(
        draft.children.map((child) => createSection(child, createUuidV7())),
      ),
    );
    return sectionType.createChecked(
      null,
      Fragment.fromArray([header, body, children]),
    );
  };

  return {
    root: createSection(rootDraft, rootSectionId),
    title: rootDraft.title,
    sectionCount: drafts.length,
    blockCount,
    sourceBlockCount,
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function markdownHeadingText(
  node: MarkdownAstNode,
  schema: Schema,
  source: string,
): string {
  const children = node.children ?? [];
  const inlineStart = children[0]?.position?.start.offset;
  const inlineEnd = children.at(-1)?.position?.end.offset;
  if (typeof inlineStart === "number" && typeof inlineEnd === "number") {
    const inline = parseInlineMarkdown(
      source.slice(inlineStart, inlineEnd),
      schema,
    );
    if (inline) {
      return inline
        .map((child) => child.textContent)
        .join("")
        .replaceAll(/\s+/gu, " ")
        .trim();
    }
  }
  const collect = (current: MarkdownAstNode): string => {
    if (current.type === "text" || current.type === "inlineCode") {
      return current.value ?? "";
    }
    if (current.type === "image") return current.alt ?? "";
    if (current.type === "break") return " ";
    return (current.children ?? []).map(collect).join("");
  };
  return stripMarkdownHighlightSyntax(collect(node))
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function nextBlankLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index]?.trim() !== "") index += 1;
  return index;
}

function nextListBlockEnd(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index]?.trim() !== "") {
    const line = lines[index] ?? "";
    if (
      index > start &&
      parseListLine(line) === null &&
      !/^[ \t]+/u.test(line)
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

function nextBlockStart(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length) {
    if (lines[index]?.trim() === "" || isBlockStart(lines, index)) break;
    index += 1;
  }
  return index;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    fenceOpening(line) !== null ||
    HEADING_LINE.test(line) ||
    IMAGE_LINE.test(line) ||
    ATTACHMENT_LINE.test(line) ||
    HTML_IMAGE_LINE.test(line) ||
    parseListLine(line) !== null ||
    parsedTableRange(lines, index) !== null ||
    unsupportedBlockEnd(lines, index) !== null
  );
}

function frontmatterBlockEnd(lines: string[], index: number): number | null {
  if (index !== 0 || lines[index]?.trim() !== "---") return null;
  const closing = lines.findIndex(
    (candidate, candidateIndex) =>
      candidateIndex > index && candidate.trim() === "---",
  );
  return closing >= 0 ? closing + 1 : null;
}

function parsedBlockquoteRange(
  lines: string[],
  start: number,
): ParsedBlockquote | null {
  if (!/^ {0,3}>/u.test(lines[start] ?? "")) return null;
  const content: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const marker = line.match(/^ {0,3}>[ \t]?(.*)$/u);
    if (marker) {
      content.push(marker[1] ?? "");
      index += 1;
      continue;
    }
    // CommonMark permits a non-blank paragraph continuation to omit the
    // quote marker. A new block marker still terminates the quote.
    if (!line.trim() || isBlockStart(lines, index)) break;
    content.push(line);
    index += 1;
  }
  const alert = parseMarkdownAlertMarker(content[0] ?? "");
  return {
    end: index,
    lines: alert ? content.slice(1) : content,
    alert,
  };
}

function fenceOpening(
  line: string,
): { marker: string; language: string | null } | null {
  const match = line.match(/^ {0,3}((?:`{3,})|(?:~{3,}))(.*)$/u);
  if (!match) return null;
  const info = (match[2] ?? "").trim();
  return {
    marker: match[1] ?? "```",
    language: /^[A-Za-z0-9_+-]*$/u.test(info) ? info : null,
  };
}

function fencedBlockRange(
  lines: string[],
  start: number,
): {
  end: number;
  closed: boolean;
  language: string | null;
} | null {
  const opening = fenceOpening(lines[start] ?? "");
  if (!opening) return null;
  const markerCharacter = opening.marker[0] ?? "`";
  const minimumLength = opening.marker.length;
  let index = start + 1;
  while (index < lines.length) {
    const candidate = (lines[index] ?? "").trim();
    if (
      candidate.length >= minimumLength &&
      [...candidate].every((character) => character === markerCharacter)
    ) {
      return {
        end: index + 1,
        closed: true,
        language: opening.language,
      };
    }
    index += 1;
  }
  return {
    end: lines.length,
    closed: false,
    language: opening.language,
  };
}

function unsupportedBlockEnd(lines: string[], index: number): number | null {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  if (
    TASK_LIST_LINE.test(line) ||
    /^ {0,3}>/u.test(line) ||
    /^(?: {4}|\t)/u.test(line) ||
    /^ {0,3}</u.test(line) ||
    THEMATIC_BREAK.test(line) ||
    (/^[^\n|]*\|[^\n|]+/u.test(line) && TABLE_DELIMITER.test(next))
  ) {
    return nextBlankLine(lines, index);
  }
  if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(next) && line.trim()) {
    return Math.min(index + 2, lines.length);
  }
  return null;
}

function parsedTableRange(lines: string[], start: number): ParsedTable | null {
  const header = splitTableRow(lines[start] ?? "");
  const delimiter = splitTableRow(lines[start + 1] ?? "");
  if (!header || !delimiter || header.length !== delimiter.length) return null;
  const alignments = delimiter.map(tableAlignment);
  if (alignments.some((alignment) => alignment === undefined)) return null;

  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && lines[end]?.trim() !== "") {
    const row = splitTableRow(lines[end] ?? "");
    if (!row || row.length !== header.length) break;
    rows.push(row);
    end += 1;
  }
  return {
    end,
    header,
    alignments: alignments as TableAlignment[],
    rows,
  };
}

function tableAlignment(value: string): TableAlignment | undefined {
  const marker = value.replaceAll(/[ \t]/gu, "");
  const match = marker.match(/^(:)?(-{3,})(:)?$/u);
  if (!match) return undefined;
  if (match[1] && match[3]) return "center";
  if (match[3]) return "right";
  if (match[1]) return "left";
  return null;
}

function splitTableRow(line: string): string[] | null {
  const value = line.trim();
  if (!value.includes("|")) return null;
  const cells: string[] = [];
  let current = "";
  let separatorCount = 0;
  let codeFenceLength = 0;
  let index = 0;

  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === "\\" && index + 1 < value.length) {
      const escaped = value[index + 1] ?? "";
      current +=
        codeFenceLength > 0 && escaped === "|"
          ? escaped
          : `${character}${escaped}`;
      index += 2;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (value[index + runLength] === "`") runLength += 1;
      current += "`".repeat(runLength);
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      index += runLength;
      continue;
    }
    if (character === "|" && codeFenceLength === 0) {
      cells.push(current.trim());
      current = "";
      separatorCount += 1;
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  cells.push(current.trim());
  if (separatorCount === 0) return null;
  if (value.startsWith("|")) cells.shift();
  if (value.endsWith("|") && !value.endsWith("\\|")) cells.pop();
  return cells.length > 0 ? cells : null;
}

function tableBlock(
  schema: Schema,
  parsed: ParsedTable,
): ProseMirrorNode | null {
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.tableRow;
  if (!tableType || !rowType) return null;
  const rows: ProseMirrorNode[] = [];
  const header = tableRow(
    schema,
    parsed.header,
    parsed.alignments,
    "tableHeader",
  );
  if (!header) return null;
  rows.push(header);
  for (const cells of parsed.rows) {
    const row = tableRow(schema, cells, parsed.alignments, "tableCell");
    if (!row) return null;
    rows.push(row);
  }
  return tableType.create(
    { blockId: createUuidV7() },
    Fragment.fromArray(rows),
  );
}

function tableRow(
  schema: Schema,
  cells: string[],
  alignments: TableAlignment[],
  cellNodeName: "tableCell" | "tableHeader",
): ProseMirrorNode | null {
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes[cellNodeName];
  const paragraphType = schema.nodes.paragraph;
  if (!rowType || !cellType || !paragraphType) return null;
  const cellNodes: ProseMirrorNode[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const inline = parseTableCellInline(cells[index] ?? "", schema);
    if (!inline) return null;
    const paragraph = paragraphType.create(
      { blockId: createUuidV7() },
      inline.length > 0 ? Fragment.fromArray(inline) : null,
    );
    cellNodes.push(
      cellType.create(
        {
          blockId: createUuidV7(),
          align: alignments[index] ?? null,
        },
        paragraph,
      ),
    );
  }
  return rowType.create(
    { blockId: createUuidV7() },
    Fragment.fromArray(cellNodes),
  );
}

function parseTableCellInline(
  value: string,
  schema: Schema,
): ProseMirrorNode[] | null {
  const parts = value.split(/[ \t]*<br[ \t]*\/?>[ \t]*/giu);
  const result: ProseMirrorNode[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const inline = parseInlineMarkdown(parts[index] ?? "", schema);
    if (!inline) return null;
    result.push(...inline);
    if (index + 1 < parts.length) {
      const hardBreak = schema.nodes.hardBreak?.create();
      if (!hardBreak) return null;
      result.push(hardBreak);
    }
  }
  return result;
}

function paragraphInline(
  lines: string[],
  schema: Schema,
): ProseMirrorNode[] | null {
  const result: ProseMirrorNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const hardBreak = /(?: {2}|\\)$/u.test(raw);
    const content = hardBreak ? raw.replace(/(?: {2}|\\)$/u, "") : raw;
    const inline = parseInlineMarkdown(content, schema);
    if (!inline) return null;
    result.push(...inline);
    if (index + 1 < lines.length) {
      if (hardBreak) {
        const node = schema.nodes.hardBreak?.create();
        if (!node) return null;
        result.push(node);
      } else {
        result.push(schema.text(" "));
      }
    }
  }
  return result;
}

function parseInlineMarkdown(
  value: string,
  schema: Schema,
): ProseMirrorNode[] | null {
  const highlighted = markdownWithHighlightSentinels(value);
  const tree = inlineMarkdownParser.parse(
    `${INLINE_PARSE_PREFIX}${highlighted}`,
  ) as MarkdownAstNode;
  const paragraph = tree.children?.[0];
  if (
    tree.children?.length !== 1 ||
    paragraph?.type !== "paragraph" ||
    !paragraph.children
  ) {
    return null;
  }
  let prefixPending = true;
  let highlightActive = false;
  const highlight = schema.marks.highlight;
  if (highlighted !== value && !highlight) return null;
  const activeMarks = (marks: readonly Mark[]): readonly Mark[] =>
    highlightActive && highlight
      ? marks.some(({ type }) => type === highlight)
        ? marks
        : [...marks, highlight.create()]
      : marks;
  const translate = (
    node: MarkdownAstNode,
    marks: readonly Mark[],
  ): ProseMirrorNode[] | null => {
    if (node.type === "text") {
      let text = node.value ?? "";
      if (prefixPending) {
        if (!text.startsWith(INLINE_PARSE_PREFIX)) return null;
        text = text.slice(INLINE_PARSE_PREFIX.length);
        prefixPending = false;
      }
      const result: ProseMirrorNode[] = [];
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character !== HIGHLIGHT_OPEN && character !== HIGHLIGHT_CLOSE) {
          continue;
        }
        if (index > start) {
          const translated = inlineTextNodes(
            text.slice(start, index),
            schema,
            activeMarks(marks),
          );
          if (!translated) return null;
          result.push(...translated);
        }
        highlightActive = character === HIGHLIGHT_OPEN;
        start = index + 1;
      }
      if (start < text.length) {
        const translated = inlineTextNodes(
          text.slice(start),
          schema,
          activeMarks(marks),
        );
        if (!translated) return null;
        result.push(...translated);
      }
      return result;
    }
    if (node.type === "inlineCode") {
      const code = schema.marks.code;
      if (!code) return null;
      prefixPending = false;
      return node.value
        ? [schema.text(node.value, [...activeMarks(marks), code.create()])]
        : [];
    }
    if (node.type === "break") {
      const hardBreak = schema.nodes.hardBreak;
      return hardBreak ? [hardBreak.create()] : null;
    }
    const markName =
      node.type === "strong"
        ? "bold"
        : node.type === "emphasis"
          ? "italic"
          : node.type === "delete"
            ? "strike"
            : node.type === "link"
              ? "link"
              : null;
    if (!markName || !node.children) return null;
    const markType = schema.marks[markName];
    if (!markType) return null;
    let mark: Mark;
    if (markName === "link") {
      const normalized = normalizeExternalLink(node.url ?? "");
      if (!normalized.valid) return null;
      mark = markType.create({ href: normalized.href });
    } else {
      mark = markType.create();
    }
    const result: ProseMirrorNode[] = [];
    for (const child of node.children) {
      const translated = translate(child, [...marks, mark]);
      if (!translated) return null;
      result.push(...translated);
    }
    return result;
  };

  const result: ProseMirrorNode[] = [];
  for (const child of paragraph.children) {
    const translated = translate(child, []);
    if (!translated) return null;
    result.push(...translated);
  }
  return prefixPending || highlightActive ? null : result;
}

function markdownWithHighlightSentinels(value: string): string {
  const paired = pairedHighlightDelimiters(value);
  if (paired.size === 0) return value;
  let result = "";
  let index = 0;
  while (index < value.length) {
    const marker = paired.get(index);
    if (marker) {
      result += marker;
      index += 2;
      continue;
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}

function stripMarkdownHighlightSyntax(value: string): string {
  const paired = pairedHighlightDelimiters(value);
  if (paired.size === 0) return value;
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (paired.has(index)) {
      index += 2;
      continue;
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}

function pairedHighlightDelimiters(value: string): ReadonlyMap<number, string> {
  const candidates = highlightDelimiterOffsets(value);
  const paired = new Map<number, string>();
  let opening: number | null = null;
  for (const offset of candidates) {
    if (opening === null) {
      opening = offset;
      continue;
    }
    const content = value.slice(opening + 2, offset);
    if (content.length > 0 && /\S/u.test(content)) {
      paired.set(opening, HIGHLIGHT_OPEN);
      paired.set(offset, HIGHLIGHT_CLOSE);
      opening = null;
    } else {
      opening = offset;
    }
  }
  return paired;
}

/** Locate unescaped `==` pairs outside code spans and link destinations. */
function highlightDelimiterOffsets(value: string): number[] {
  const result: number[] = [];
  let codeFenceLength = 0;
  let linkDestinationDepth = 0;
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character === "\\") {
      index += Math.min(2, value.length - index);
      continue;
    }
    if (linkDestinationDepth > 0) {
      if (character === "(") linkDestinationDepth += 1;
      if (character === ")") linkDestinationDepth -= 1;
      index += 1;
      continue;
    }
    if (codeFenceLength > 0) {
      if (character === "`") {
        let runLength = 1;
        while (value[index + runLength] === "`") runLength += 1;
        if (runLength === codeFenceLength) codeFenceLength = 0;
        index += runLength;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (value[index + runLength] === "`") runLength += 1;
      codeFenceLength = runLength;
      index += runLength;
      continue;
    }
    if (character === "[" && value[index + 1] === "[") {
      const end = value.indexOf("]]", index + 2);
      if (end >= 0) {
        index = end + 2;
        continue;
      }
    }
    if (character === "]" && value[index + 1] === "(") {
      linkDestinationDepth = 1;
      index += 2;
      continue;
    }
    if (character === "<") {
      const end = value.indexOf(">", index + 1);
      const target = end >= 0 ? value.slice(index + 1, end) : "";
      if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[^ <>@]+@[^ <>@]+$)/u.test(target)) {
        index = end + 1;
        continue;
      }
    }
    if (character === "=" && value[index + 1] === "=") {
      result.push(index);
      index += 2;
      continue;
    }
    index += 1;
  }
  return result;
}

function inlineTextNodes(
  value: string,
  schema: Schema,
  marks: readonly Mark[],
): ProseMirrorNode[] | null {
  const nodes: ProseMirrorNode[] = [];
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("[[", index);
    if (start < 0) {
      if (index < value.length)
        nodes.push(schema.text(value.slice(index), marks));
      break;
    }
    if (start > index)
      nodes.push(schema.text(value.slice(index, start), marks));
    const end = value.indexOf("]]", start + 2);
    if (end < 0) return null;
    const raw = value.slice(start + 2, end);
    const separator = raw.indexOf("|");
    if (separator < 1 || separator === raw.length - 1) return null;
    const targetSectionId = raw.slice(0, separator);
    const display = raw.slice(separator + 1);
    if (
      !UUID_V7.test(targetSectionId) ||
      /[*_~`[\]<>]/u.test(display) ||
      marks.some(({ type }) => type.name === "link")
    ) {
      return null;
    }
    const linkType = schema.nodes.internalSectionLink;
    if (!linkType) return null;
    nodes.push(linkType.create({ targetSectionId }, schema.text(display)));
    index = end + 2;
  }
  return nodes;
}

function safeResourceTarget(target: string): boolean {
  return target.startsWith("attachment:") || isSafeExternalLink(target);
}

function unescapeAttachmentLabel(value: string): string {
  return value.replace(/\\([\\[\]_*`#])/gu, "$1");
}

function codeBlock(
  schema: Schema,
  text: string,
  language: string,
): ProseMirrorNode | null {
  const type = schema.nodes.codeBlock;
  if (!type) return null;
  return type.create(
    {
      blockId: createUuidV7(),
      language: language || null,
    },
    text ? schema.text(text) : null,
  );
}

function sourceBlock(schema: Schema, text: string): ProseMirrorNode | null {
  const type = schema.nodes.sourceBlock;
  if (!type) return null;
  return type.create(
    {
      blockId: createUuidV7(),
      sourceFormat: "markdown",
    },
    text ? schema.text(text) : null,
  );
}

function imageBlock(
  schema: Schema,
  alt: string,
  target: string,
  width: number | null = null,
): ProseMirrorNode | null {
  const type = schema.nodes.image;
  if (!type || !safeResourceTarget(target)) return null;
  return type.create({
    blockId: createUuidV7(),
    src: target,
    alt,
    attachmentId: target.startsWith("attachment:")
      ? target === "attachment:missing"
        ? target
        : target.slice("attachment:".length).toLocaleLowerCase()
      : null,
    alignment: "center",
    width,
  });
}

function parseHtmlImageLine(
  line: string,
): { target: string; alt: string; width: number } | null {
  const match = HTML_IMAGE_LINE.exec(line);
  if (!match) return null;
  const attributes = new Map<string, string>();
  const pattern = /([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
  let attribute: RegExpExecArray | null;
  while ((attribute = pattern.exec(match[1] ?? ""))) {
    attributes.set(
      attribute[1]!.toLocaleLowerCase(),
      decodeHtmlAttribute(attribute[2] ?? attribute[3] ?? ""),
    );
  }
  const target = attributes.get("src") ?? "";
  const widthMatch = /^(\d{1,3})%$/u.exec(attributes.get("width") ?? "");
  if (!safeResourceTarget(target) || !widthMatch) return null;
  const width = Number(widthMatch[1]);
  if (width < 10 || width >= 100) return null;
  return { target, alt: attributes.get("alt") ?? "", width };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll(/&quot;/giu, '"')
    .replaceAll(/&#39;|&apos;/giu, "'")
    .replaceAll(/&lt;/giu, "<")
    .replaceAll(/&gt;/giu, ">")
    .replaceAll(/&amp;/giu, "&");
}

function attachmentBlock(
  schema: Schema,
  label: string,
  attachmentId: string,
): ProseMirrorNode | null {
  const type = schema.nodes.attachment;
  if (!type || !UUID_V7.test(attachmentId)) return null;
  return type.create({
    blockId: createUuidV7(),
    attachmentId: attachmentId.toLocaleLowerCase(),
    label,
  });
}

function parseListLine(line: string): ParsedListLine | null {
  if (TASK_LIST_LINE.test(line)) return null;
  const bullet = line.match(BULLET_LINE);
  if (bullet) {
    const inline = bullet[4] ?? "";
    return {
      indent: bullet[1]?.length ?? 0,
      kind: "bullet",
      start: 1,
      inline,
      contentIndent: displayColumn(line.slice(0, line.length - inline.length)),
    };
  }
  const ordered = line.match(ORDERED_LIST_LINE);
  if (!ordered) return null;
  const start = Number(ordered[2]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const inline = ordered[4] ?? "";
  return {
    indent: ordered[1]?.length ?? 0,
    kind: "ordered",
    start,
    inline,
    contentIndent: displayColumn(line.slice(0, line.length - inline.length)),
  };
}

function displayColumn(value: string): number {
  let column = 0;
  for (const character of value) {
    column = character === "\t" ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

function stripContinuationIndent(line: string, columns: number): string | null {
  let column = 0;
  let index = 0;
  while (index < line.length && column < columns) {
    const character = line[index];
    if (character !== " " && character !== "\t") return null;
    const nextColumn =
      character === "\t" ? column + (4 - (column % 4)) : column + 1;
    index += 1;
    if (nextColumn > columns) {
      return `${" ".repeat(nextColumn - columns)}${line.slice(index)}`;
    }
    column = nextColumn;
  }
  return column === columns ? line.slice(index) : null;
}

function listBlock(schema: Schema, lines: string[]): ProseMirrorNode | null {
  const rootLine = parseListLine(lines[0] ?? "");
  if (!rootLine || rootLine.indent !== 0) return null;
  const root: ListDraft = {
    kind: rootLine.kind,
    start: rootLine.start,
    items: [],
  };
  const lists: ListDraft[] = [root];
  const items: ListItemDraft[] = [];
  const indents = [0];
  const contentIndents: number[] = [];

  for (const line of lines) {
    const parsed = parseListLine(line);
    if (!parsed) {
      let continuationDepth = -1;
      for (let depth = contentIndents.length - 1; depth >= 0; depth -= 1) {
        if (
          stripContinuationIndent(line, contentIndents[depth] ?? 0) !== null
        ) {
          continuationDepth = depth;
          break;
        }
      }
      const item = items[continuationDepth];
      const continuation =
        continuationDepth >= 0
          ? stripContinuationIndent(
              line,
              contentIndents[continuationDepth] ?? 0,
            )
          : null;
      if (!item || continuation === null) return null;
      item.paragraphLines.push(continuation);
      items.length = continuationDepth + 1;
      contentIndents.length = continuationDepth + 1;
      continue;
    }

    let depth = indents.lastIndexOf(parsed.indent);
    if (depth < 0) {
      const parentDepth = indents.length - 1;
      const indentIncrease = parsed.indent - (indents[parentDepth] ?? 0);
      const parentItem = items[parentDepth];
      if (
        parsed.indent <= (indents[parentDepth] ?? 0) ||
        indentIncrease < 2 ||
        indentIncrease > 12 ||
        !parentItem
      ) {
        return null;
      }
      depth = indents.length;
      const nested: ListDraft = {
        kind: parsed.kind,
        start: parsed.start,
        items: [],
      };
      parentItem.children.push(nested);
      indents.push(parsed.indent);
      lists.push(nested);
    } else {
      indents.length = depth + 1;
      lists.length = depth + 1;
      items.length = depth + 1;
      contentIndents.length = depth + 1;
    }

    const list = lists[depth];
    if (!list || list.kind !== parsed.kind) return null;
    const item: ListItemDraft = {
      paragraphLines: [parsed.inline],
      children: [],
    };
    list.items.push(item);
    items[depth] = item;
    contentIndents[depth] = parsed.contentIndent;
  }

  return createListNode(schema, root);
}

function createListNode(
  schema: Schema,
  draft: ListDraft,
): ProseMirrorNode | null {
  const listType =
    draft.kind === "ordered"
      ? schema.nodes.orderedList
      : schema.nodes.bulletList;
  const itemType = schema.nodes.listItem;
  const paragraphType = schema.nodes.paragraph;
  if (!listType || !itemType || !paragraphType) return null;
  const itemNodes: ProseMirrorNode[] = [];
  for (const item of draft.items) {
    const inline = paragraphInline(item.paragraphLines, schema);
    if (!inline) return null;
    const content: ProseMirrorNode[] = [
      paragraphType.create(
        { blockId: createUuidV7() },
        inline.length > 0 ? Fragment.fromArray(inline) : null,
      ),
    ];
    for (const child of item.children) {
      const nested = createListNode(schema, child);
      if (!nested) return null;
      content.push(nested);
    }
    itemNodes.push(
      itemType.create({ blockId: createUuidV7() }, Fragment.fromArray(content)),
    );
  }
  return listType.create(
    {
      blockId: createUuidV7(),
      ...(draft.kind === "ordered" ? { start: draft.start } : {}),
    },
    Fragment.fromArray(itemNodes),
  );
}

export function markdownTextWithMarks(
  text: string,
  marks: readonly Mark[],
): string {
  return inlineMarkdownText(
    text,
    marks.map((mark) => ({ name: mark.type.name, attrs: mark.attrs })),
  );
}
