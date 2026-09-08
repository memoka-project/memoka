import type { Slice, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  defaultVimBlockSemantics as semantics,
  type VimLogicalLine,
} from "./block-semantics";

/** Relative, document-independent geometry, not the motion/text object used to
 * make the selection. Columns count code points and indivisible inline atoms. */
export interface VimVisualCharShape {
  lines: number;
  columns: number;
  toLineEnd: boolean;
  acrossCells: boolean;
}

function cellBounds(doc: ProseMirrorNode, position: number) {
  const $position = doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if (["tableCell", "tableHeader"].includes($position.node(depth).type.name))
      return { from: $position.start(depth), to: $position.end(depth) };
  }
  return null;
}

function characterEnd(doc: ProseMirrorNode, position: number): number {
  const node = doc.resolve(position).nodeAfter;
  if (node?.isText)
    return position + ((node.text!.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
  if (node?.isInline) return position + node.nodeSize;
  return position;
}

function positionsFor(
  state: EditorState,
  line: VimLogicalLine,
  cell: ReturnType<typeof cellBounds> = null,
): number[] {
  const result: number[] = [];
  let next = -1;
  for (const position of line.cursorPositions) {
    if (
      position < next ||
      (cell && (position < cell.from || position >= cell.to))
    )
      continue;
    result.push(position);
    next = characterEnd(state.doc, position);
  }
  return result;
}

export function captureVisualCharShape(
  state: EditorState,
  toLineEnd = false,
): VimVisualCharShape | null {
  const { from, to } = state.selection;
  if (from === to) return null;
  const lines = semantics.logicalLines({ state });
  if (!lines.length) return null;
  const first = semantics.currentLineIndex(lines, from);
  const last = semantics.currentLineIndex(lines, Math.max(from, to - 1));
  const cell = cellBounds(state.doc, from);
  const acrossCells = cell !== null && to > cell.to;
  const positions = positionsFor(
    state,
    lines[last]!,
    acrossCells ? null : cell,
  );
  const selected = positions.filter(
    (position) => position < to && (first !== last || position >= from),
  );
  return {
    lines: last - first + 1,
    columns: selected.length,
    toLineEnd,
    acrossCells,
  };
}

export function visualCharRepeatRange(
  state: EditorState,
  shape: VimVisualCharShape,
): { from: number; to: number } | null {
  const lines = semantics.logicalLines({ state });
  if (!lines.length) return null;
  const cursor = state.selection.from;
  const first = semantics.currentLineIndex(lines, cursor);
  if (lines[first]!.kind === "block-atom") return null;
  const last = Math.min(lines.length - 1, first + shape.lines - 1);
  const cell =
    shape.lines === 1 && !shape.acrossCells
      ? cellBounds(state.doc, cursor)
      : null;
  const positions = positionsFor(state, lines[last]!, cell).filter(
    (position) => first !== last || position >= cursor,
  );
  const index = shape.toLineEnd
    ? positions.length - 1
    : Math.min(shape.columns, positions.length) - 1;
  const end = positions[Math.max(0, index)];
  if (end === undefined) return null;
  const to = characterEnd(state.doc, end);
  return to >= cursor ? { from: cursor, to } : null;
}

/** Retain a persistent document reference, not keystrokes or a full text copy.
 * Only at Insert exit do we read the resulting Slice. Reconstruction verifies
 * that edits stayed at the insertion site; unrelated/structural mutations must
 * never become an unsafe replay at another caret. */
export class VisualChangeCapture {
  constructor(
    readonly shape: VimVisualCharShape,
    private readonly initial: EditorState,
    private readonly position = initial.selection.from,
  ) {}

  finish(state: EditorState): Slice | null {
    const size = state.doc.content.size - this.initial.doc.content.size;
    if (size < 0 || this.position + size > state.doc.content.size) return null;
    try {
      const slice = state.doc.slice(this.position, this.position + size);
      let containsSection = false;
      slice.content.descendants((node) => {
        if (["section", "sectionHeader"].includes(node.type.name))
          containsSection = true;
      });
      if (containsSection) return null;
      const reproduced = this.initial.doc.replace(
        this.position,
        this.position,
        slice,
      );
      return reproduced.eq(state.doc) ? slice : null;
    } catch {
      return null;
    }
  }
}
