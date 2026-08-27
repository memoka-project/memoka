import * as Y from "yjs";
import { noteDisplayTitle, type NoteDocument } from "./documents";
import {
  deriveSectionCatalog,
  sectionBodyBlocks,
  type SectionCatalogEntry,
} from "./section-model";
import { yXmlTextVisibleText } from "./yxml-text";

export type WorkspaceSearchScope = "title" | "body";
export type WorkspaceSearchTarget = "workspace" | "buffers" | "trash";
export type WorkspaceSearchBlockKind = "body";
export type WorkspaceSearchResultKind = "title" | WorkspaceSearchBlockKind;

export interface WorkspaceSearchSection {
  readonly sectionId: string;
  /** Parent inside the NoteDoc. Root Sections use null. */
  readonly parentSectionId?: string | null;
  readonly title: string;
  readonly parentPath: string;
  readonly order: number;
}

export interface WorkspaceSearchBlock {
  readonly blockId: string;
  readonly kind: WorkspaceSearchBlockKind;
  readonly sectionId: string;
  readonly text: string;
  readonly logicalLineNumber: number;
  /** One-based logical line ordinal inside the owning Section body. */
  readonly sectionLineNumber: number;
  readonly lineIndex: number;
  readonly sourceOffset: number;
}

export interface WorkspaceSearchDocument {
  readonly noteId: string;
  /** Note Tree parent. The Root Section is attached to this Note's Root. */
  readonly parentNoteId?: string | null;
  readonly title: string;
  readonly parentPath: string;
  readonly updatedAt: string;
  readonly sections?: readonly WorkspaceSearchSection[];
  readonly blocks: readonly WorkspaceSearchBlock[];
  readonly sourceRevision?: number;
}

export interface WorkspaceSearchCatalog {
  readonly documents: readonly WorkspaceSearchDocument[];
  readonly failures: readonly {
    noteId: string;
    title: string;
    message: string;
  }[];
}

export interface WorkspaceSearchResult {
  readonly resultId: string;
  readonly noteId: string;
  readonly sectionId: string;
  readonly title: string;
  readonly parentPath: string;
  readonly updatedAt: string;
  readonly kind: WorkspaceSearchResultKind;
  readonly preview: string;
  readonly lineText: string;
  readonly blockId: string | null;
  readonly logicalLineNumber: number | null;
  readonly sectionLineNumber: number | null;
  readonly lineIndex: number;
  /** Text offset in the target block, used by Editor navigation. */
  readonly matchOffset: number;
  /** Text offset in lineText, used by search result and preview highlights. */
  readonly lineMatchOffset: number;
  readonly query: string;
}

export interface WorkspaceSearchResponse {
  readonly scope: WorkspaceSearchScope;
  readonly results: readonly WorkspaceSearchResult[];
  readonly failures: WorkspaceSearchCatalog["failures"];
  readonly backend:
    "sqlite-fts" | "sqlite-fts+crdt" | "crdt-fallback" | "metadata";
  readonly elapsedMs: number;
  /** Diagnostic detail for development surfaces. Never rendered as a normal result warning. */
  readonly warning: string | null;
}

interface RankedSearchResult {
  blockIndex: number;
  result: WorkspaceSearchResult;
}

const LIST_NAMES = new Set([
  "bulletList",
  "bullet_list",
  "orderedList",
  "ordered_list",
]);
const CODE_NAMES = new Set([
  "codeBlock",
  "code_block",
  "sourceBlock",
  "source_block",
]);

interface WorkspaceSearchLineSeed {
  readonly element: Y.XmlElement;
  readonly text: string;
  readonly section: SectionCatalogEntry;
  readonly lineIndex: number;
  readonly sourceOffset: number;
}

interface WorkspaceSearchProjectionSeed {
  readonly noteId: string;
  readonly parentNoteId: string | null;
  readonly noteTitle: string;
  readonly parentPath: string;
  readonly updatedAt: string;
  readonly catalog: readonly SectionCatalogEntry[];
  readonly sections: readonly WorkspaceSearchSection[];
}

function workspaceSearchProjectionSeed(
  note: NoteDocument,
  title: string | undefined,
  parentPath: string,
  updatedAt: string,
  parentNoteId: string | null,
): WorkspaceSearchProjectionSeed {
  const catalog = deriveSectionCatalog(note.noteId, note.rootSection);
  const noteTitle = noteDisplayTitle(title ?? catalog[0]?.title ?? "");
  return {
    noteId: note.noteId,
    parentNoteId,
    noteTitle,
    parentPath,
    updatedAt,
    catalog,
    sections: catalog.map((entry) => ({
      sectionId: entry.sectionId,
      parentSectionId: entry.parentSectionId,
      title: entry.depth === 0 ? noteTitle : entry.displayTitle,
      parentPath: combinedSectionParentPath(entry, noteTitle, parentPath),
      order: entry.order,
    })),
  };
}

function* workspaceSearchLines(
  seed: WorkspaceSearchProjectionSeed,
): Generator<WorkspaceSearchLineSeed> {
  for (const section of seed.catalog) {
    const pending = [...sectionBodyBlocks(section.element)].reverse();
    while (pending.length > 0) {
      const element = pending.pop()!;
      if (
        element.nodeName === "paragraph" ||
        CODE_NAMES.has(element.nodeName)
      ) {
        const text = xmlTextContent(element);
        let sourceOffset = 0;
        for (const [lineIndex, line] of text.split("\n").entries()) {
          yield { element, text: line, section, lineIndex, sourceOffset };
          sourceOffset += line.length + 1;
        }
        continue;
      }
      if (element.nodeName === "image") {
        yield {
          element,
          text: stringAttribute(element, "alt"),
          section,
          lineIndex: 0,
          sourceOffset: 0,
        };
        continue;
      }
      if (element.nodeName === "attachment") {
        yield {
          element,
          text: stringAttribute(element, "label"),
          section,
          lineIndex: 0,
          sourceOffset: 0,
        };
        continue;
      }
      if (element.nodeName === "listItem" || element.nodeName === "list_item") {
        const children = childElements(element);
        yield {
          element,
          text: children
            .filter((child) => !LIST_NAMES.has(child.nodeName))
            .map((child) => xmlTextContent(child))
            .join(" ")
            .replace(/\s+/gu, " ")
            .trim(),
          section,
          lineIndex: 0,
          sourceOffset: 0,
        };
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index]!;
          if (LIST_NAMES.has(child.nodeName)) pending.push(child);
        }
        continue;
      }
      if (element.nodeName === "tableRow" || element.nodeName === "table_row") {
        yield {
          element,
          text: childElements(element)
            .map((cell) => xmlTextContent(cell).replace(/\s+/gu, " ").trim())
            .join(" | "),
          section,
          lineIndex: 0,
          sourceOffset: 0,
        };
        continue;
      }
      const children = childElements(element);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]!);
      }
    }
  }
}

function appendWorkspaceSearchLine(
  blocks: WorkspaceSearchBlock[],
  sectionLineCounts: Map<string, number>,
  line: WorkspaceSearchLineSeed,
): void {
  const blockId = stringAttribute(line.element, "blockId");
  if (!blockId) return;
  const sectionLineNumber =
    (sectionLineCounts.get(line.section.sectionId) ?? 0) + 1;
  sectionLineCounts.set(line.section.sectionId, sectionLineNumber);
  blocks.push({
    blockId,
    kind: "body",
    sectionId: line.section.sectionId,
    text: line.text,
    logicalLineNumber: blocks.length + 1,
    sectionLineNumber,
    lineIndex: line.lineIndex,
    sourceOffset: line.sourceOffset,
  });
}

function workspaceSearchDocumentFromSeed(
  seed: WorkspaceSearchProjectionSeed,
  blocks: readonly WorkspaceSearchBlock[],
): WorkspaceSearchDocument {
  return {
    noteId: seed.noteId,
    parentNoteId: seed.parentNoteId,
    title: seed.sections[0]!.title,
    parentPath: seed.parentPath,
    updatedAt: seed.updatedAt,
    sections: seed.sections,
    blocks,
  };
}

async function yieldWorkspaceSearchProjection(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

export function deriveWorkspaceSearchDocument(
  note: NoteDocument,
  title?: string,
  parentPath = "/",
  updatedAt = "",
  parentNoteId: string | null = null,
): WorkspaceSearchDocument {
  const seed = workspaceSearchProjectionSeed(
    note,
    title,
    parentPath,
    updatedAt,
    parentNoteId,
  );
  const blocks: WorkspaceSearchBlock[] = [];
  const sectionLineCounts = new Map<string, number>();
  for (const line of workspaceSearchLines(seed)) {
    appendWorkspaceSearchLine(blocks, sectionLineCounts, line);
  }
  return workspaceSearchDocumentFromSeed(seed, blocks);
}

/**
 * Derives the disposable FTS projection in cooperative slices. Typing only
 * queues this work after the debounce, and each 256 logical lines yields back
 * to WebKit so a resumed edit cannot be starved by a very large NoteDoc.
 */
export async function deriveWorkspaceSearchDocumentAsync(
  note: NoteDocument,
  title?: string,
  parentPath = "/",
  updatedAt = "",
  parentNoteId: string | null = null,
): Promise<WorkspaceSearchDocument> {
  const seed = workspaceSearchProjectionSeed(
    note,
    title,
    parentPath,
    updatedAt,
    parentNoteId,
  );
  const blocks: WorkspaceSearchBlock[] = [];
  const sectionLineCounts = new Map<string, number>();
  let processed = 0;
  for (const line of workspaceSearchLines(seed)) {
    appendWorkspaceSearchLine(blocks, sectionLineCounts, line);
    processed += 1;
    if (processed % 256 === 0) await yieldWorkspaceSearchProjection();
  }
  return workspaceSearchDocumentFromSeed(seed, blocks);
}

export function filterWorkspaceSearchCatalog(
  catalog: WorkspaceSearchCatalog,
  query: string,
  scope: WorkspaceSearchScope = "title",
  limit = 20,
): WorkspaceSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Workspace search result limit must be positive");
  }
  const trimmedQuery = query.trim();
  const normalizedTerms = workspaceSearchTerms(trimmedQuery);
  if (scope === "body" && normalizedTerms.length === 0) return [];
  const ranked: RankedSearchResult[] = [];

  catalog.documents.forEach((document) => {
    if (scope === "title") {
      for (const section of documentSections(document)) {
        const normalizedTitle = normalizeWorkspaceSearchText(section.title);
        const normalizedParentPath = normalizeWorkspaceSearchText(
          section.parentPath,
        );
        if (
          normalizedTerms.every(
            (term) =>
              normalizedTitle.includes(term) ||
              normalizedParentPath.includes(term),
          )
        ) {
          const titleOffset = firstNormalizedMatchOffset(
            section.title,
            normalizedTerms,
          );
          ranked.push({
            blockIndex: section.order,
            result: titleResult(
              document,
              section,
              trimmedQuery,
              titleOffset ?? 0,
            ),
          });
        }
      }
      return;
    }

    document.blocks.forEach((block, blockIndex) => {
      const lineMatchOffset = firstNormalizedMatchOffset(
        block.text,
        normalizedTerms,
        true,
      );
      if (lineMatchOffset === null) return;
      ranked.push({
        blockIndex,
        result: bodyResult(document, block, trimmedQuery, lineMatchOffset),
      });
    });
  });

  return ranked
    .sort((left, right) => {
      const byUpdated = right.result.updatedAt.localeCompare(
        left.result.updatedAt,
      );
      if (byUpdated !== 0) return byUpdated;
      return (
        left.result.noteId.localeCompare(right.result.noteId) ||
        left.blockIndex - right.blockIndex
      );
    })
    .slice(0, limit)
    .map(({ result }) => result);
}

export function workspaceSearchResultFromIndexedEntry(
  entry: {
    resultId: string;
    noteId: string;
    sectionId?: string;
    title: string;
    parentPath: string;
    updatedAt: string;
    kind: WorkspaceSearchResultKind;
    text: string;
    blockId: string | null;
    logicalLineNumber: number | null;
    sectionLineNumber?: number | null;
    lineIndex: number;
    sourceOffset: number;
  },
  query: string,
  scope: WorkspaceSearchScope,
): WorkspaceSearchResult | null {
  const trimmedQuery = query.trim();
  const normalizedTerms = workspaceSearchTerms(trimmedQuery);
  if (scope === "title") {
    if (entry.kind !== "title") return null;
    const normalizedTitle = normalizeWorkspaceSearchText(entry.title);
    const normalizedParentPath = normalizeWorkspaceSearchText(entry.parentPath);
    if (
      !normalizedTerms.every(
        (term) =>
          normalizedTitle.includes(term) || normalizedParentPath.includes(term),
      )
    ) {
      return null;
    }
    const titleOffset = firstNormalizedMatchOffset(
      entry.title,
      normalizedTerms,
    );
    return {
      resultId: entry.resultId,
      noteId: entry.noteId,
      sectionId: entry.sectionId ?? entry.noteId,
      title: entry.title,
      parentPath: entry.parentPath,
      updatedAt: entry.updatedAt,
      kind: "title",
      preview: entry.parentPath || "ワークスペース直下",
      lineText: entry.title,
      blockId: null,
      logicalLineNumber: null,
      sectionLineNumber: null,
      lineIndex: 0,
      matchOffset: Math.max(0, titleOffset ?? 0),
      lineMatchOffset: Math.max(0, titleOffset ?? 0),
      query: trimmedQuery,
    };
  }

  if (entry.kind === "title" || normalizedTerms.length === 0) return null;
  const lineMatchOffset = firstNormalizedMatchOffset(
    entry.text,
    normalizedTerms,
    true,
  );
  if (lineMatchOffset === null) return null;
  return {
    resultId: entry.resultId,
    noteId: entry.noteId,
    sectionId: entry.sectionId ?? entry.noteId,
    title: entry.title,
    parentPath: entry.parentPath,
    updatedAt: entry.updatedAt,
    kind: entry.kind,
    preview: searchPreview(entry.text, lineMatchOffset),
    lineText: entry.text,
    blockId: entry.blockId,
    logicalLineNumber: entry.logicalLineNumber,
    sectionLineNumber: entry.sectionLineNumber ?? null,
    lineIndex: entry.lineIndex,
    matchOffset: entry.sourceOffset + lineMatchOffset,
    lineMatchOffset,
    query: trimmedQuery,
  };
}

export function workspaceSearchMatchRanges(
  value: string,
  query: string,
): Array<{ from: number; to: number }> {
  const normalizedValue = normalizeWorkspaceSearchText(value);
  const normalizedTerms = workspaceSearchTerms(query);
  if (normalizedTerms.length === 0) return [];
  const boundaries = normalizedBoundaries(value);
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of normalizedTerms) {
    let cursor = 0;
    while (cursor <= normalizedValue.length - term.length) {
      const found = normalizedValue.indexOf(term, cursor);
      if (found < 0) break;
      ranges.push({
        from: sourceOffsetAtNormalizedBoundary(boundaries, found, "start"),
        to: sourceOffsetAtNormalizedBoundary(
          boundaries,
          found + term.length,
          "end",
        ),
      });
      cursor = found + Math.max(1, term.length);
    }
  }
  return mergeSearchRanges(ranges);
}

export function formatWorkspaceSearchAge(
  updatedAt: string,
  nowMs = Date.now(),
): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return "?";
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function titleResult(
  document: WorkspaceSearchDocument,
  section: WorkspaceSearchSection,
  query: string,
  matchOffset: number,
): WorkspaceSearchResult {
  return {
    resultId: `${document.noteId}:section:${section.sectionId}:title`,
    noteId: document.noteId,
    sectionId: section.sectionId,
    title: section.title,
    parentPath: section.parentPath,
    updatedAt: document.updatedAt,
    kind: "title",
    preview: section.parentPath || "/",
    lineText: section.title,
    blockId: null,
    logicalLineNumber: null,
    sectionLineNumber: null,
    lineIndex: 0,
    matchOffset,
    lineMatchOffset: matchOffset,
    query,
  };
}

function bodyResult(
  document: WorkspaceSearchDocument,
  block: WorkspaceSearchBlock,
  query: string,
  lineMatchOffset: number,
): WorkspaceSearchResult {
  const section = documentSections(document).find(
    ({ sectionId }) => sectionId === block.sectionId,
  );
  return {
    // Search row identity is a disposable projection coordinate. It must not
    // inherit a legacy duplicate blockId and make an otherwise valid rebuild
    // fail its SQLite uniqueness constraint.
    resultId: `${document.noteId}:${block.kind}:line:${block.logicalLineNumber}`,
    noteId: document.noteId,
    sectionId: block.sectionId,
    title: section?.title ?? document.title,
    parentPath: section?.parentPath ?? document.parentPath,
    updatedAt: document.updatedAt,
    kind: block.kind,
    preview: searchPreview(block.text, lineMatchOffset),
    lineText: block.text,
    blockId: block.blockId,
    logicalLineNumber: block.logicalLineNumber,
    sectionLineNumber: block.sectionLineNumber,
    lineIndex: block.lineIndex,
    matchOffset: block.sourceOffset + lineMatchOffset,
    lineMatchOffset,
    query,
  };
}

function childElements(element: Y.XmlElement): Y.XmlElement[] {
  return element
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
}

function sectionParentPath(section: SectionCatalogEntry): string {
  if (section.depth === 0) return "/";
  const parts = section.breadcrumb.split(" / ");
  parts.pop();
  return parts.join(" / ") || "/";
}

function combinedSectionParentPath(
  section: SectionCatalogEntry,
  noteTitle: string,
  noteParentPath: string,
): string {
  return combineWorkspacePaths(
    noteParentPath,
    localSectionParentPath(section, noteTitle),
  );
}

function localSectionParentPath(
  section: SectionCatalogEntry,
  noteTitle: string,
): string {
  if (section.depth === 0) return "/";
  const local = sectionParentPath(section)
    .split(" / ")
    .filter((part) => part !== "/" && part.length > 0);
  if (local.length > 0) local[0] = noteTitle;
  return `/${local.join("/")}`;
}

export function combineWorkspacePaths(
  noteParentPath: string,
  localPath: string,
): string {
  const prefix =
    noteParentPath === "/" ? "" : noteParentPath.replace(/\/$/u, "");
  const suffix =
    localPath === "/" ? "" : `/${localPath.replace(/^\/+|\/+$/gu, "")}`;
  return `${prefix}${suffix}` || "/";
}

function documentSections(
  document: WorkspaceSearchDocument,
): readonly WorkspaceSearchSection[] {
  return (
    document.sections ?? [
      {
        sectionId: document.noteId,
        parentSectionId: null,
        title: document.title,
        parentPath: document.parentPath,
        order: 0,
      },
    ]
  );
}

function xmlTextContent(element: Y.XmlElement): string {
  let result = "";
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      result += yXmlTextVisibleText(child);
    } else if (child instanceof Y.XmlElement) {
      result += child.nodeName === "hardBreak" ? "\n" : xmlTextContent(child);
    }
  }
  return result;
}

function stringAttribute(element: Y.XmlElement, name: string): string {
  const value = element.getAttribute(name);
  return typeof value === "string" ? value : String(value ?? "");
}

export function normalizeWorkspaceSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function workspaceSearchTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeWorkspaceSearchText(query.trim()).split(/\s+/u).filter(Boolean),
    ),
  ];
}

export function workspaceSearchJapaneseGrams(value: string): string {
  const grams = new Set<string>();
  const normalized = normalizeWorkspaceSearchText(value);
  for (const match of normalized.matchAll(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  )) {
    const characters = Array.from(match[0]);
    characters.forEach((character, index) => {
      grams.add(character);
      if (index + 1 < characters.length) {
        grams.add(`${character}${characters[index + 1]}`);
      }
    });
  }
  return [...grams].sort().join(" ");
}

function normalizedMatchOffset(
  value: string,
  normalizedQuery: string,
): number | null {
  if (!normalizedQuery) return 0;
  const normalizedOffset =
    normalizeWorkspaceSearchText(value).indexOf(normalizedQuery);
  if (normalizedOffset < 0) return null;
  return sourceOffsetAtNormalizedBoundary(
    normalizedBoundaries(value),
    normalizedOffset,
    "start",
  );
}

function firstNormalizedMatchOffset(
  value: string,
  normalizedTerms: readonly string[],
  requireAll = false,
): number | null {
  if (normalizedTerms.length === 0) return 0;
  const offsets = normalizedTerms.map((term) =>
    normalizedMatchOffset(value, term),
  );
  if (requireAll && offsets.some((offset) => offset === null)) return null;
  const matches = offsets.filter((offset): offset is number => offset !== null);
  return matches.length > 0 ? Math.min(...matches) : null;
}

function mergeSearchRanges(
  ranges: readonly { from: number; to: number }[],
): Array<{ from: number; to: number }> {
  const sorted = [...ranges].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function normalizedBoundaries(value: string): Array<{
  source: number;
  normalized: number;
}> {
  const boundaries = [{ source: 0, normalized: 0 }];
  let source = 0;
  for (const character of Array.from(value)) {
    source += character.length;
    boundaries.push({
      source,
      normalized: normalizeWorkspaceSearchText(value.slice(0, source)).length,
    });
  }
  return boundaries;
}

function sourceOffsetAtNormalizedBoundary(
  boundaries: readonly { source: number; normalized: number }[],
  normalizedOffset: number,
  side: "start" | "end",
): number {
  if (side === "end") {
    return (
      boundaries.find(({ normalized }) => normalized >= normalizedOffset)
        ?.source ??
      boundaries.at(-1)?.source ??
      0
    );
  }
  let source = 0;
  for (const boundary of boundaries) {
    if (boundary.normalized > normalizedOffset) break;
    source = boundary.source;
  }
  return source;
}

function searchPreview(text: string, matchOffset: number): string {
  const start = Math.max(0, matchOffset - 36);
  const end = Math.min(text.length, matchOffset + 84);
  const content = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${content}${end < text.length ? "…" : ""}`;
}
