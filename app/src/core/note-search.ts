import type { EditorState } from "@tiptap/pm/state";
import * as Y from "yjs";
import type { NoteDocument } from "./documents";
import {
  deriveSectionCatalog,
  findSectionById,
  sectionBodyBlocks,
  type SectionCatalogEntry,
} from "./section-model";
import type { StableEditorPosition } from "./stable-position";
import { yXmlTextVisibleText } from "./yxml-text";

export type NoteSearchDirection = "forward" | "backward";

export interface NoteSearchLocation {
  readonly sectionId: string;
  /** `null` identifies the Section Header rather than a body block. */
  readonly blockId: string | null;
  /** UTF-16 text offset within the Header or body block. */
  readonly offset: number;
}

export interface NoteSearchOrigin {
  readonly stable: StableEditorPosition;
  readonly location: NoteSearchLocation;
}

export interface NoteSearchUnit extends NoteSearchLocation {
  readonly order: number;
  readonly text: string;
  readonly kind: "header" | "text" | "atom";
}

export interface NoteSearchMatch extends NoteSearchLocation {
  readonly order: number;
  readonly query: string;
  readonly text: string;
  readonly kind: NoteSearchUnit["kind"];
}

export interface NoteSearchProjection {
  readonly query: string;
  readonly units: readonly NoteSearchUnit[];
  readonly matches: readonly NoteSearchMatch[];
}

export interface NoteSearchNavigationStatus {
  readonly query: string | null;
  readonly matchCount: number;
  readonly matchIndex: number | null;
  readonly wrapped: boolean;
}

export interface SelectedNoteSearchMatch {
  readonly match: NoteSearchMatch;
  readonly index: number;
  readonly wrapped: boolean;
}

const SEARCHABLE_TEXT_BLOCKS = new Set([
  "paragraph",
  "codeBlock",
  "code_block",
  "sourceBlock",
  "source_block",
]);

const SEARCHABLE_ATOMS = new Set(["image"]);

interface NoteSearchProjectionIndex {
  readonly unitOrderByLocation: ReadonlyMap<string, number>;
}

const noteSearchProjectionIndexes = new WeakMap<
  NoteSearchProjection,
  NoteSearchProjectionIndex
>();

/**
 * Builds a disposable text-search projection from the NoteDoc SSOT. Headers
 * and direct bodies follow the same preorder as the requested Section
 * subtree; no content is persisted or copied back into the NoteDoc.
 */
export function deriveNoteSearchProjection(
  note: NoteDocument,
  query: string,
  scopeSectionId: string = note.noteId,
): NoteSearchProjection {
  const units: NoteSearchUnit[] = [];
  const scope = findSectionById(note.rootSection, scopeSectionId);
  if (!scope) return createNoteSearchProjection(query, units, []);
  for (const section of deriveSectionCatalog(note.noteId, scope)) {
    appendUnit(units, {
      sectionId: section.sectionId,
      blockId: null,
      offset: 0,
      text: section.title,
      kind: "header",
    });
    appendSectionBodyUnits(units, section);
  }

  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery.value) {
    return createNoteSearchProjection(query, units, []);
  }

  const matches: NoteSearchMatch[] = [];
  for (const unit of units) {
    const normalized = normalizeSearchText(unit.text);
    let searchFrom = 0;
    const seenOffsets = new Set<number>();
    while (searchFrom <= normalized.value.length) {
      const matchIndex = normalized.value.indexOf(
        normalizedQuery.value,
        searchFrom,
      );
      if (matchIndex < 0) break;
      const sourceOffset = normalized.sourceOffsets[matchIndex] ?? 0;
      if (!seenOffsets.has(sourceOffset)) {
        seenOffsets.add(sourceOffset);
        matches.push({
          sectionId: unit.sectionId,
          blockId: unit.blockId,
          offset: sourceOffset,
          order: unit.order,
          query,
          text: unit.text,
          kind: unit.kind,
        });
      }
      // Advancing one normalized UTF-16 unit also preserves overlapping
      // literal matches without risking an empty-pattern loop.
      searchFrom = matchIndex + 1;
    }
  }
  return createNoteSearchProjection(query, units, matches);
}

export function selectNoteSearchMatch(
  projection: NoteSearchProjection,
  location: NoteSearchLocation,
  direction: NoteSearchDirection,
  count = 1,
): SelectedNoteSearchMatch | null {
  const { matches } = projection;
  if (matches.length === 0) return null;
  const repetitions = Number.isSafeInteger(count) ? Math.max(1, count) : 1;
  const projectionIndex = noteSearchProjectionIndex(projection);
  const anchorOrder =
    projectionIndex.unitOrderByLocation.get(noteSearchLocationKey(location)) ??
    projectionIndex.unitOrderByLocation.get(
      noteSearchLocationKey({
        sectionId: location.sectionId,
        blockId: null,
      }),
    ) ??
    -1;
  const compare = (match: NoteSearchMatch): number =>
    match.order - anchorOrder || match.offset - location.offset;

  if (direction === "forward") {
    let index = firstMatchingIndex(matches, (match) => compare(match) > 0);
    let wrapped = index >= matches.length;
    if (index >= matches.length) index = 0;
    if (index + repetitions - 1 >= matches.length) wrapped = true;
    index = (index + repetitions - 1) % matches.length;
    return { match: matches[index]!, index, wrapped };
  }

  let index = firstMatchingIndex(matches, (match) => compare(match) >= 0) - 1;
  let wrapped = index < 0;
  if (index < 0) index = matches.length - 1;
  if (index - (repetitions - 1) < 0) wrapped = true;
  index = positiveModulo(index - (repetitions - 1), matches.length);
  return { match: matches[index]!, index, wrapped };
}

export function noteSearchLocationAtPosition(
  state: Pick<EditorState, "doc">,
  position: number,
): NoteSearchLocation {
  const cursor = Math.max(0, Math.min(position, state.doc.content.size));
  const resolved = state.doc.resolve(cursor);
  let sectionId = "";
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name === "sectionHeader") {
      return {
        sectionId: stringAttribute(node.attrs.sectionId),
        blockId: null,
        offset: Math.max(0, cursor - resolved.start(depth)),
      };
    }
    if (node.type.name === "section" || node.type.name === "doc") {
      const value = node.firstChild?.attrs.sectionId;
      if (typeof value === "string" && value) sectionId ||= value;
    }
  }

  const direct = state.doc.nodeAt(cursor);
  const directBlockId = searchableBlockId(direct?.type.name, direct?.attrs);
  if (directBlockId) {
    return { sectionId, blockId: directBlockId, offset: 0 };
  }
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    const blockId = searchableBlockId(node.type.name, node.attrs);
    if (!blockId) continue;
    return {
      sectionId,
      blockId,
      offset: Math.max(0, cursor - resolved.start(depth)),
    };
  }
  return { sectionId, blockId: null, offset: 0 };
}

function appendSectionBodyUnits(
  units: NoteSearchUnit[],
  section: SectionCatalogEntry,
): void {
  const pending = [...sectionBodyBlocks(section.element)].reverse();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!(value instanceof Y.XmlElement)) continue;
    if (SEARCHABLE_TEXT_BLOCKS.has(value.nodeName)) {
      const blockId = xmlStringAttribute(value, "blockId");
      if (blockId) {
        appendUnit(units, {
          sectionId: section.sectionId,
          blockId,
          offset: 0,
          text: searchableXmlText(value),
          kind: "text",
        });
      }
      continue;
    }
    if (SEARCHABLE_ATOMS.has(value.nodeName)) {
      const blockId = xmlStringAttribute(value, "blockId");
      if (blockId) {
        appendUnit(units, {
          sectionId: section.sectionId,
          blockId,
          offset: 0,
          text: xmlStringAttribute(value, "alt"),
          kind: "atom",
        });
      }
      continue;
    }
    const children = value.toArray();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child instanceof Y.XmlElement) pending.push(child);
    }
  }
}

function appendUnit(
  units: NoteSearchUnit[],
  input: Omit<NoteSearchUnit, "order">,
): void {
  units.push({ ...input, order: units.length });
}

function searchableXmlText(root: Y.XmlElement): string {
  const parts: string[] = [];
  const pending: Array<Y.XmlElement | Y.XmlText> = [root];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (value instanceof Y.XmlText) {
      parts.push(yXmlTextVisibleText(value));
      continue;
    }
    if (value !== root && value.nodeName === "hardBreak") {
      parts.push("\n");
      continue;
    }
    const children = value.toArray();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        pending.push(child);
      }
    }
  }
  return parts.join("");
}

function normalizeSearchText(value: string): {
  value: string;
  sourceOffsets: readonly number[];
} {
  let normalized = "";
  let sourceOffset = 0;
  const sourceOffsets: number[] = [];
  for (const character of Array.from(value)) {
    const fragment = character.normalize("NFKC").toLocaleLowerCase();
    normalized += fragment;
    for (let index = 0; index < fragment.length; index += 1) {
      sourceOffsets.push(sourceOffset);
    }
    sourceOffset += character.length;
  }
  return { value: normalized, sourceOffsets };
}

function searchableBlockId(
  nodeName: string | undefined,
  attrs: Readonly<Record<string, unknown>> | undefined,
): string {
  if (
    !nodeName ||
    (!SEARCHABLE_TEXT_BLOCKS.has(nodeName) && !SEARCHABLE_ATOMS.has(nodeName))
  ) {
    return "";
  }
  return stringAttribute(attrs?.blockId);
}

function xmlStringAttribute(element: Y.XmlElement, name: string): string {
  return stringAttribute(element.getAttribute(name));
}

function stringAttribute(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function createNoteSearchProjection(
  query: string,
  units: readonly NoteSearchUnit[],
  matches: readonly NoteSearchMatch[],
): NoteSearchProjection {
  const projection = { query, units, matches };
  noteSearchProjectionIndexes.set(projection, createProjectionIndex(units));
  return projection;
}

function noteSearchProjectionIndex(
  projection: NoteSearchProjection,
): NoteSearchProjectionIndex {
  let index = noteSearchProjectionIndexes.get(projection);
  if (!index) {
    index = createProjectionIndex(projection.units);
    noteSearchProjectionIndexes.set(projection, index);
  }
  return index;
}

function createProjectionIndex(
  units: readonly NoteSearchUnit[],
): NoteSearchProjectionIndex {
  return {
    unitOrderByLocation: new Map(
      units.map((unit) => [noteSearchLocationKey(unit), unit.order]),
    ),
  };
}

function noteSearchLocationKey(
  location: Pick<NoteSearchLocation, "sectionId" | "blockId">,
): string {
  return `${location.sectionId}:${location.blockId ?? "header"}`;
}

function firstMatchingIndex(
  matches: readonly NoteSearchMatch[],
  predicate: (match: NoteSearchMatch) => boolean,
): number {
  let lower = 0;
  let upper = matches.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (predicate(matches[middle]!)) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

export function noteSearchStatusMessage(
  status: NoteSearchNavigationStatus,
): string | null {
  if (
    !status.query ||
    status.matchCount < 1 ||
    status.matchIndex === null ||
    status.matchIndex < 0
  ) {
    return null;
  }
  return `/${status.query} · ${status.matchIndex + 1}/${status.matchCount}${status.wrapped ? " · wrapped" : ""}`;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
