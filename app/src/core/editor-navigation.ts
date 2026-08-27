import type { EditorState } from "@tiptap/pm/state";
import { Selection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import type { NoteDocument } from "./documents";
import {
  contentOffsetAtTextOffset,
  resolveStableEditorPosition,
  type ResolvedStableEditorPosition,
  type StableEditorPosition,
} from "./stable-position";

export interface InternalSectionLinkTarget {
  sectionId: string;
}

export type EditorNavigationIntent =
  | {
      kind: "follow-link";
      cursor: number;
      target: InternalSectionLinkTarget;
    }
  | {
      kind: "back" | "forward";
      cursor: number;
    };

export type EditorNavigationRequest =
  | {
      kind: "follow-link";
      current: StableEditorPosition;
      target: InternalSectionLinkTarget;
    }
  | {
      kind: "back" | "forward";
      current: StableEditorPosition;
    };

export type EditorNavigationDestination =
  | {
      kind: "section-start";
      noteId: string;
      sectionId: string;
    }
  | {
      kind: "document-start";
      noteId: string;
    }
  | {
      kind: "stable";
      noteId: string;
      saved: StableEditorPosition;
    }
  | {
      kind: "search-match";
      noteId: string;
      blockId: string;
      sectionId: string;
      sectionLineNumber: number;
      offset: number;
      query: string;
    }
  | {
      kind: "note-search-match";
      noteId: string;
      sectionId: string;
      /** `null` targets the Section Header. */
      blockId: string | null;
      offset: number;
      query: string;
    };

export interface EditorNavigationResult {
  handled: boolean;
  detail: string;
  destination?: EditorNavigationDestination;
}

export interface ResolvedEditorNavigationDestination {
  position: number;
  source:
    | ResolvedStableEditorPosition["source"]
    | "document-start"
    | "section-start"
    | "note-search-header"
    | "search-block"
    | "search-text-fallback"
    | "missing-search-fallback";
}

interface IndexedEditorNode {
  readonly node: ProseMirrorNode;
  readonly position: number;
}

interface EditorNavigationIndex {
  readonly blocks: ReadonlyMap<string, IndexedEditorNode | null>;
  readonly sectionHeaders: ReadonlyMap<string, IndexedEditorNode | null>;
}

const editorNavigationIndexes = new WeakMap<
  ProseMirrorNode,
  EditorNavigationIndex
>();

export function sectionIdAtEditorSelection(
  state: Pick<EditorState, "doc" | "selection">,
): string | null {
  const resolved = state.doc.resolve(state.selection.head);
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name !== "section" && node.type.name !== "doc") continue;
    const sectionId = node.firstChild?.attrs.sectionId;
    if (typeof sectionId === "string" && sectionId.length > 0) {
      return sectionId;
    }
  }
  return null;
}

function linkTargetFromNode(
  node: ProseMirrorNode | null | undefined,
): InternalSectionLinkTarget | null {
  if (node?.type.name !== "internalSectionLink") return null;
  const sectionId = node.attrs.targetSectionId;
  return typeof sectionId === "string" && sectionId.length > 0
    ? { sectionId }
    : null;
}

export function internalSectionLinkAtPosition(
  state: EditorState,
  position: number,
): InternalSectionLinkTarget | null {
  const cursor = Math.max(0, Math.min(position, state.doc.content.size));
  const resolved = state.doc.resolve(cursor);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const target = linkTargetFromNode(resolved.node(depth));
    if (target) return target;
  }

  let result: InternalSectionLinkTarget | null = null;
  state.doc.descendants((node, start) => {
    if (result || node.type.name !== "internalSectionLink") return !result;
    // Normal mode may clamp the square caret to the inline node boundary for
    // its first rendered character, so include `start` as part of the link.
    const contentStart = start;
    const contentEnd = start + node.nodeSize - 1;
    if (cursor >= contentStart && cursor < contentEnd) {
      result = linkTargetFromNode(node);
      return false;
    }
    return true;
  });
  return result;
}

function navigationIndex(document: ProseMirrorNode): EditorNavigationIndex {
  const cached = editorNavigationIndexes.get(document);
  if (cached) return cached;
  const blocks = new Map<string, IndexedEditorNode | null>();
  const sectionHeaders = new Map<string, IndexedEditorNode | null>();
  document.descendants((node, position) => {
    const blockId = node.attrs.blockId;
    if (typeof blockId === "string" && blockId.length > 0) {
      recordUniqueIndexedNode(blocks, blockId, { node, position });
    }
    if (node.type.name === "sectionHeader") {
      const sectionId = node.attrs.sectionId;
      if (typeof sectionId === "string" && sectionId.length > 0) {
        recordUniqueIndexedNode(sectionHeaders, sectionId, { node, position });
      }
    }
    return true;
  });
  const index = { blocks, sectionHeaders };
  editorNavigationIndexes.set(document, index);
  return index;
}

function recordUniqueIndexedNode(
  index: Map<string, IndexedEditorNode | null>,
  id: string,
  target: IndexedEditorNode,
): void {
  if (index.has(id)) index.set(id, null);
  else index.set(id, target);
}

function searchPositionInIndexedNode(
  target: IndexedEditorNode,
  offset: number,
  query: string,
): number {
  const { node, position } = target;
  if (node.isTextblock) {
    return position + 1 + contentOffsetAtTextOffset(node, offset);
  }
  if (node.isAtom || node.isLeaf) return position;
  let nestedPosition: number | null = null;
  node.descendants((child, childOffset) => {
    if (nestedPosition !== null || !child.isTextblock) {
      return nestedPosition === null;
    }
    const matchOffset = normalizedTextMatchOffset(searchableText(child), query);
    if (matchOffset === null) return true;
    nestedPosition =
      position +
      1 +
      childOffset +
      1 +
      contentOffsetAtTextOffset(child, matchOffset);
    return false;
  });
  return nestedPosition ?? position;
}

export function resolveEditorNavigationDestination(
  note: NoteDocument,
  view: Pick<EditorView, "state">,
  destination: EditorNavigationDestination,
): ResolvedEditorNavigationDestination {
  if (destination.noteId !== note.noteId) {
    throw new Error(
      `Navigation target belongs to ${destination.noteId}, not ${note.noteId}`,
    );
  }
  if (destination.kind === "stable") {
    const resolved = resolveStableEditorPosition(note, view, destination.saved);
    return { position: resolved.position, source: resolved.source };
  }
  if (destination.kind === "section-start") {
    const target = navigationIndex(view.state.doc).sectionHeaders.get(
      destination.sectionId,
    );
    const position = target ? target.position + 1 : null;
    return {
      position: position ?? Selection.atStart(view.state.doc).from,
      source: position === null ? "document-start" : "section-start",
    };
  }
  if (destination.kind === "note-search-match") {
    const index = navigationIndex(view.state.doc);
    const target =
      destination.blockId === null
        ? index.sectionHeaders.get(destination.sectionId)
        : index.blocks.get(destination.blockId);
    const targetPosition = target
      ? target.node.isTextblock
        ? target.position +
          1 +
          contentOffsetAtTextOffset(target.node, destination.offset)
        : target.position
      : null;
    if (targetPosition !== null) {
      return {
        position: targetPosition,
        source:
          destination.blockId === null ? "note-search-header" : "search-block",
      };
    }
    const fallback = firstTextMatchPosition(view.state.doc, destination.query);
    if (fallback !== null) {
      return { position: fallback, source: "search-text-fallback" };
    }
    return {
      position: Selection.atStart(view.state.doc).from,
      source: "missing-search-fallback",
    };
  }
  if (destination.kind === "search-match") {
    const target = navigationIndex(view.state.doc).blocks.get(
      destination.blockId,
    );
    const blockPosition = target
      ? searchPositionInIndexedNode(
          target,
          destination.offset,
          destination.query,
        )
      : null;
    if (blockPosition !== null) {
      return { position: blockPosition, source: "search-block" };
    }
    const sectionLinePosition = sectionLogicalLinePosition(
      view.state.doc,
      destination.sectionId,
      destination.sectionLineNumber,
      destination.query,
    );
    if (sectionLinePosition !== null) {
      return { position: sectionLinePosition, source: "search-text-fallback" };
    }
    const textFallback = firstTextMatchPosition(
      view.state.doc,
      destination.query,
    );
    if (textFallback !== null) {
      return { position: textFallback, source: "search-text-fallback" };
    }
    return {
      position: Selection.atStart(view.state.doc).from,
      source: "missing-search-fallback",
    };
  }
  return {
    position: Selection.atStart(view.state.doc).from,
    source: "document-start",
  };
}

function sectionLogicalLinePosition(
  document: ProseMirrorNode,
  sectionId: string,
  targetLine: number,
  query: string,
): number | null {
  if (targetLine < 1) return null;
  let section: { node: ProseMirrorNode; position: number } | null = null;
  document.descendants((node, position) => {
    if (section || node.type.name !== "section") return !section;
    if (node.firstChild?.attrs.sectionId === sectionId) {
      section = { node, position };
      return false;
    }
    return true;
  });
  const foundSection = section as {
    node: ProseMirrorNode;
    position: number;
  } | null;
  if (!foundSection) return null;
  const sectionNode = foundSection.node;
  const sectionPosition = foundSection.position;
  const body = sectionNode.childCount > 1 ? sectionNode.child(1) : null;
  if (!body) return null;
  let ordinal = 0;
  let result: number | null = null;

  const accept = (
    node: ProseMirrorNode,
    position: number,
    text: string,
    sourceOffset = 0,
  ): boolean => {
    ordinal += 1;
    if (ordinal !== targetLine) return false;
    const match = normalizedTextMatchOffset(text, query) ?? 0;
    if (node.isTextblock) {
      result =
        position + 1 + contentOffsetAtTextOffset(node, sourceOffset + match);
    } else {
      result = position;
    }
    return true;
  };

  const visit = (node: ProseMirrorNode, position: number): void => {
    if (result !== null) return;
    switch (node.type.name) {
      case "paragraph":
      case "codeBlock":
      case "sourceBlock": {
        const text = searchableText(node);
        let sourceOffset = 0;
        for (const line of text.split("\n")) {
          if (accept(node, position, line, sourceOffset)) return;
          sourceOffset += line.length + 1;
        }
        return;
      }
      case "image":
      case "attachment":
        accept(node, position, node.textContent);
        return;
      case "listItem": {
        const text = node.content.content
          .filter(
            (child) =>
              child.type.name !== "bulletList" &&
              child.type.name !== "orderedList",
          )
          .map((child) => child.textContent)
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        if (accept(node, position, text)) return;
        node.forEach((child, offset) => {
          if (
            child.type.name === "bulletList" ||
            child.type.name === "orderedList"
          ) {
            visit(child, position + 1 + offset);
          }
        });
        return;
      }
      case "tableRow":
        accept(
          node,
          position,
          node.content.content
            .map((cell) => cell.textContent.replace(/\s+/gu, " ").trim())
            .join(" | "),
        );
        return;
      case "section":
      case "sectionHeader":
      case "sectionChildren":
        return;
      default:
        node.forEach((child, offset) => visit(child, position + 1 + offset));
    }
  };
  body.forEach((child, offset) =>
    visit(
      child,
      sectionPosition + 1 + sectionNode.child(0).nodeSize + 1 + offset,
    ),
  );
  return result;
}

function firstTextMatchPosition(
  document: ProseMirrorNode,
  query: string,
): number | null {
  let result: number | null = null;
  document.descendants((node, nodePosition) => {
    if (result !== null || !node.isTextblock) return result === null;
    const offset = normalizedTextMatchOffset(searchableText(node), query);
    if (offset === null) return true;
    result = nodePosition + 1 + contentOffsetAtTextOffset(node, offset);
    return false;
  });
  return result;
}

function searchableText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, "", "\n");
}

function normalizedTextMatchOffset(
  value: string,
  query: string,
): number | null {
  const normalizedQuery = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const normalizedOffset = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .indexOf(normalizedQuery);
  if (normalizedOffset < 0) return null;
  let sourceOffset = 0;
  let previousOffset = 0;
  for (const character of Array.from(value)) {
    sourceOffset += character.length;
    if (
      value.slice(0, sourceOffset).normalize("NFKC").toLocaleLowerCase()
        .length > normalizedOffset
    ) {
      return previousOffset;
    }
    previousOffset = sourceOffset;
  }
  return Math.min(previousOffset, value.length);
}
