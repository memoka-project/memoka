import { createMappablePosition } from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import * as Y from "yjs";
import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import type { NoteDocument } from "./documents";
import { findSectionById, sectionId } from "./section-model";

const CONTEXT_LENGTH = 12;

export interface StableEditorPosition {
  noteId: string;
  sectionId?: string;
  blockId: string;
  offset: number;
  before: string;
  after: string;
  relative: Uint8Array;
}

export interface ResolvedStableEditorPosition {
  noteId: string;
  blockId: string;
  position: number;
  source: "relative" | "block-fallback" | "context-fallback" | "document-start";
}

interface BlockPosition {
  blockId: string;
  offset: number;
}

interface BlockCandidate {
  blockId: string;
  node: ProseMirrorNode;
  position: number;
}

function boundSection(
  state: EditorState,
  note: NoteDocument,
  requestedSectionId?: string,
) {
  const header = state.doc.firstChild;
  const renderedSectionId =
    header?.type.name === "sectionHeader" &&
    typeof header.attrs.sectionId === "string"
      ? header.attrs.sectionId
      : requestedSectionId || sectionId(note.rootSection);
  const section = findSectionById(note.rootSection, renderedSectionId);
  if (!section)
    throw new Error(`Unknown focused Section: ${renderedSectionId}`);
  return section;
}

function prosemirrorMapping(
  state: EditorState,
  note: NoteDocument,
  requestedSectionId?: string,
) {
  const fragment = boundSection(state, note, requestedSectionId);
  const initialized = initProseMirrorDoc(fragment, state.schema);
  if (!initialized.doc.eq(state.doc)) {
    throw new Error("Editor is not bound to the requested NoteDoc");
  }
  return { mapping: initialized.mapping, fragment };
}

function clampedPosition(state: EditorState, position: number): number {
  return Math.max(0, Math.min(position, state.doc.content.size));
}

function surroundingText(
  state: EditorState,
  position: number,
): Pick<StableEditorPosition, "before" | "after"> {
  const cursor = clampedPosition(state, position);
  return {
    before: state.doc.textBetween(
      Math.max(0, cursor - CONTEXT_LENGTH),
      cursor,
      "",
      "\uFFFC",
    ),
    after: state.doc.textBetween(
      cursor,
      Math.min(state.doc.content.size, cursor + CONTEXT_LENGTH),
      "",
      "\uFFFC",
    ),
  };
}

function blockAt(state: EditorState, position: number): BlockPosition {
  const cursor = clampedPosition(state, position);
  const direct = state.doc.nodeAt(cursor);
  if (typeof direct?.attrs.blockId === "string") {
    return { blockId: direct.attrs.blockId, offset: 0 };
  }
  const resolved = state.doc.resolve(cursor);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (typeof node.attrs.blockId === "string") {
      return {
        blockId: node.attrs.blockId,
        offset: Math.max(0, cursor - resolved.start(depth)),
      };
    }
  }
  return { blockId: "", offset: cursor };
}

function blockCandidates(state: EditorState): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];
  state.doc.descendants((node, position) => {
    if (typeof node.attrs.blockId === "string") {
      candidates.push({ blockId: node.attrs.blockId, node, position });
    }
  });
  return candidates;
}

function contextOffset(
  text: string,
  saved: StableEditorPosition,
): number | null {
  if (saved.before) {
    const index = text.indexOf(saved.before);
    if (index >= 0) return index + saved.before.length;
  }
  if (saved.after) {
    const index = text.indexOf(saved.after);
    if (index >= 0) return index;
  }
  if (!saved.before && !saved.after) {
    return Math.max(0, Math.min(saved.offset, text.length));
  }
  return null;
}

export function contentOffsetAtTextOffset(
  node: ProseMirrorNode,
  target: number,
): number {
  let consumed = 0;
  let result: number | null = null;
  let lastOffset = 0;
  node.descendants((child, position) => {
    if (result !== null) return false;
    if (child.isText) {
      const length = child.text?.length ?? 0;
      lastOffset = position + length;
      if (target <= consumed + length) {
        result = position + Math.max(0, target - consumed);
      }
      consumed += length;
      return false;
    }
    if (child.isLeaf) {
      lastOffset = position + 1;
      if (target <= consumed) result = position;
      consumed += 1;
    }
    return true;
  });
  return Math.max(
    0,
    Math.min(result ?? lastOffset, Math.max(0, node.content.size)),
  );
}

function fallbackFromCandidate(
  candidate: BlockCandidate,
  saved: StableEditorPosition,
  source: ResolvedStableEditorPosition["source"],
): ResolvedStableEditorPosition | null {
  const text = candidate.node.textBetween(
    0,
    candidate.node.content.size,
    "",
    "\uFFFC",
  );
  const offset = contextOffset(text, saved);
  if (offset === null) return null;
  return {
    noteId: saved.noteId,
    blockId: candidate.blockId,
    position:
      candidate.position +
      1 +
      contentOffsetAtTextOffset(candidate.node, offset),
    source,
  };
}

function contextMatches(
  state: EditorState,
  position: number,
  saved: StableEditorPosition,
): boolean {
  if (!saved.before && !saved.after) return true;
  const current = surroundingText(state, position);
  return (
    (Boolean(saved.before) && current.before.endsWith(saved.before)) ||
    (Boolean(saved.after) && current.after.startsWith(saved.after))
  );
}

export function saveStableEditorPosition(
  note: NoteDocument,
  view: Pick<EditorView, "state">,
  position = view.state.selection.head,
): StableEditorPosition {
  const cursor = clampedPosition(view.state, position);
  // Capturing an origin is on the hot path for every n/N repeat. The active
  // Section ID is enough to prove that this Editor belongs to the NoteDoc;
  // rebuilding the entire ProseMirror document is only required later when a
  // persisted Relative Position is resolved after arbitrary edits.
  const fragment = boundSection(view.state, note);
  const relative = createMappablePosition(cursor, view.state)
    .yRelativePosition as Y.RelativePosition | null;
  if (!relative) throw new Error("Editor did not provide a Relative Position");
  const block = blockAt(view.state, cursor);
  return {
    noteId: note.noteId,
    sectionId: sectionId(fragment),
    blockId: block.blockId,
    offset: block.offset,
    ...surroundingText(view.state, cursor),
    relative: Y.encodeRelativePosition(relative),
  };
}

export function resolveStableEditorPosition(
  note: NoteDocument,
  view: Pick<EditorView, "state">,
  saved: StableEditorPosition,
): ResolvedStableEditorPosition {
  if (saved.noteId !== note.noteId) {
    throw new Error(`Position belongs to ${saved.noteId}, not ${note.noteId}`);
  }
  const { mapping, fragment } = prosemirrorMapping(
    view.state,
    note,
    saved.sectionId,
  );
  try {
    const relative = Y.decodeRelativePosition(saved.relative);
    const position = relativePositionToAbsolutePosition(
      note.doc,
      fragment,
      relative,
      mapping,
    );
    if (
      position !== null &&
      position >= 0 &&
      position <= view.state.doc.content.size &&
      contextMatches(view.state, position, saved)
    ) {
      const block = blockAt(view.state, position);
      return {
        noteId: note.noteId,
        blockId: block.blockId || saved.blockId,
        position,
        source: "relative",
      };
    }
  } catch {
    // Malformed or stale relative positions continue through deterministic
    // block/context fallbacks instead of crashing navigation.
  }

  const candidates = blockCandidates(view.state);
  const original = candidates.find(({ blockId }) => blockId === saved.blockId);
  if (original) {
    const resolved = fallbackFromCandidate(original, saved, "block-fallback");
    if (resolved) return resolved;
  }
  for (const candidate of candidates) {
    if (candidate === original) continue;
    const resolved = fallbackFromCandidate(
      candidate,
      saved,
      "context-fallback",
    );
    if (resolved) return resolved;
  }

  const position = Selection.atStart(view.state.doc).from;
  return {
    noteId: note.noteId,
    blockId: blockAt(view.state, position).blockId,
    position,
    source: "document-start",
  };
}
