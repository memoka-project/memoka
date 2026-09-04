import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { liftListItem, sinkListItem } from "@tiptap/pm/schema-list";
import { addRowAfter, goToNextCell, TableMap } from "@tiptap/pm/tables";
import { canJoin } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import {
  defaultVimBlockSemantics,
  type VimLogicalLine,
  type VimStructuralUnit,
} from "./block-semantics";
import {
  measureVimCharacterCell,
  measureVimCharacterRangeCell,
  type VimCharacterCellRect,
} from "./caret-geometry";
import type { VimCommand, VimMode, VimOperator } from "./input";
import {
  normalizedJoinSeparator,
  segmentVimWordCharacters,
  type VimWordSegment,
} from "./word-semantics";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
} from "../core/application-key-config";
import { createUuidV7 } from "../core/ids";
import { BODY_CHUNK_NODE } from "../core/section-model";
import {
  moveNormalTableCell,
  moveNormalTableRow,
  pasteTableCellsIntoTable,
  tableFromCellsRegister,
  type VimTableCellsRegister,
} from "./table-editing";

export type VimEditorView = Pick<
  EditorView,
  | "state"
  | "dispatch"
  | "focus"
  | "coordsAtPos"
  | "posAtCoords"
  | "domAtPos"
  | "dom"
>;

export type VimRegister =
  | {
      kind: "text";
      text: string;
      /** Rich characterwise content; absent for legacy/plain registers. */
      slice?: Slice;
    }
  | {
      kind: "block-lines";
      text: string;
      lineCount: number;
      behaviorId: string;
      blockNodeName: string;
      blockAttrs: Record<string, unknown>;
      slice?: Slice;
    }
  | {
      kind: "structure";
      text: string;
      structureKind: "block" | "list-item" | "table-row";
      nodeNames: string[];
      slice: Slice;
    }
  | {
      kind: "section";
      text: string;
      /** Yank copies with fresh IDs; delete/put moves while IDs remain free. */
      transfer: "copy" | "cut";
      sourceNoteId: string | null;
      sectionIds: string[];
      slice: Slice;
    }
  | VimTableCellsRegister;

export interface VimVisualLineState {
  anchorUnit: number;
  headUnit: number;
  cursor: number;
}

export interface SectionDepthShiftSelection {
  readonly boundarySectionId: string;
  readonly sectionIds: readonly string[];
  readonly caretSectionId: string;
  readonly caretOffset: number;
  readonly caretPosition: number;
}

export interface SectionParagraphConversionSelection {
  readonly boundarySectionId: string;
  readonly sourceSectionId: string;
  readonly paragraphBlockId: string;
  readonly paragraphBodyIndex: number;
  readonly title: string;
  readonly caretOffset: number;
  readonly paragraphOffset: number;
  readonly caretPosition: number;
}

export interface EditorVimResult {
  handled: boolean;
  detail: string;
  preventDefault?: boolean;
  register?: VimRegister;
  consumeRegister?: boolean;
  nextMode?: VimMode;
  visualLine?: VimVisualLineState;
}

const blockSemantics = defaultVimBlockSemantics;

function normalizedCount(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
}

function behaviorDetailPrefix(behaviorId: string): string {
  return behaviorId.replace(/-block$/u, "") || "block";
}

function indentSplitTextLines(
  view: VimEditorView,
  outdent: boolean,
  behaviorId: string,
): boolean {
  const { $from, $to } = view.state.selection;
  if (
    $from.parent !== $to.parent ||
    !blockSemantics.hasBehavior($from.parent.type.name, behaviorId)
  ) {
    return false;
  }

  const blockStart = $from.start();
  const text = $from.parent.textContent;
  const selectionStart = $from.parentOffset;
  const selectionEnd = $to.parentOffset;
  const firstLineStart = text.lastIndexOf("\n", selectionStart - 1) + 1;
  const selectedThrough =
    selectionEnd > selectionStart && text[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const lastLineStart = text.lastIndexOf("\n", selectedThrough - 1) + 1;
  const lineStarts: number[] = [];
  let lineStart = firstLineStart;
  while (lineStart <= lastLineStart) {
    lineStarts.push(lineStart);
    const nextNewline = text.indexOf("\n", lineStart);
    if (nextNewline < 0 || nextNewline >= lastLineStart) break;
    lineStart = nextNewline + 1;
  }

  const transaction = view.state.tr;
  let changed = false;
  for (const offset of [...lineStarts].reverse()) {
    const position = blockStart + offset;
    if (!outdent) {
      transaction.insertText("  ", position);
      changed = true;
      continue;
    }
    const line = text.slice(offset);
    const indentation = line.startsWith("\t")
      ? 1
      : (line.match(/^ {1,2}/)?.[0].length ?? 0);
    if (indentation > 0) {
      transaction.delete(position, position + indentation);
      changed = true;
    }
  }
  if (!changed) return false;
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return true;
}

export function runEditorTab(
  view: VimEditorView,
  outdent: boolean,
): EditorVimResult {
  const tableRow = blockSemantics.nearestAncestorType(view, "table-row");
  if (tableRow) {
    let handled = goToNextCell(outdent ? -1 : 1)(view.state, view.dispatch);
    let detail = outdent ? "table:previous-cell" : "table:next-cell";
    if (!handled && !outdent && addRowAfter(view.state, view.dispatch)) {
      handled = goToNextCell(1)(view.state, view.dispatch);
      detail = "table:add-row";
    }
    view.focus();
    return { handled, detail };
  }

  const listItem = blockSemantics.nearestAncestorType(view, "list-item");
  if (listItem) {
    const handled = (outdent ? liftListItem : sinkListItem)(listItem)(
      view.state,
      view.dispatch,
    );
    view.focus();
    return {
      handled,
      detail: outdent ? "list:outdent" : "list:indent",
    };
  }

  const behavior = blockSemantics.behaviorForNodeName(
    view.state.selection.$from.parent.type.name,
  );
  if (behavior?.logicalLines === "split-text-lines") {
    const prefix = behaviorDetailPrefix(behavior.id);
    return {
      handled: indentSplitTextLines(view, outdent, behavior.id),
      detail: outdent ? `${prefix}:outdent` : `${prefix}:indent`,
    };
  }

  view.focus();
  return {
    handled: false,
    detail: "tab:focus-kept",
  };
}

interface InsertExitBlock {
  depth: number;
  detailPrefix: "blockquote" | "code" | "list" | "table";
}

function insertExitBlock(view: VimEditorView): InsertExitBlock | null {
  const { $from, $to } = view.state.selection;
  let blockquote: InsertExitBlock | null = null;
  let code: InsertExitBlock | null = null;
  let outermostList: InsertExitBlock | null = null;
  let table: InsertExitBlock | null = null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if ($to.depth < depth || $to.node(depth) !== node) continue;
    if (blockSemantics.hasBehavior(node.type.name, "code-block") && !code) {
      code = { depth, detailPrefix: "code" };
    }
    if (node.type.name === "blockquote") {
      // Like a nested List, Ctrl+Enter leaves the complete outer quote.
      blockquote = { depth, detailPrefix: "blockquote" };
    }
    if (node.type.name === "table") {
      table = { depth, detailPrefix: "table" };
    }
    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      // Keep walking towards the document root. A nested ListItem exits the
      // complete outer list, never just its innermost nested list.
      outermostList = { depth, detailPrefix: "list" };
    }
  }
  return blockquote ?? code ?? outermostList ?? table;
}

export function runEditorExitBlock(view: VimEditorView): EditorVimResult {
  const target = insertExitBlock(view);
  if (!target) {
    return {
      handled: false,
      detail: "block:exit",
    };
  }

  const { $from } = view.state.selection;
  const parentDepth = target.depth - 1;
  const parent = $from.node(parentDepth);
  const indexAfterBlock = $from.indexAfter(parentDepth);
  const afterBlock = $from.after(target.depth);

  const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
  if (
    !paragraph ||
    !parent.canReplaceWith(
      indexAfterBlock,
      indexAfterBlock,
      paragraph.type,
      paragraph.marks,
    )
  ) {
    return {
      handled: false,
      detail: `${target.detailPrefix}:exit`,
    };
  }

  const transaction = view.state.tr.insert(afterBlock, paragraph);
  transaction.setSelection(
    TextSelection.near(transaction.doc.resolve(afterBlock + 1), 1),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: `${target.detailPrefix}:exit-created-paragraph`,
  };
}

export function runEditorInsertEnter(
  view: VimEditorView,
  shiftKey: boolean,
): EditorVimResult {
  const { $from, $to } = view.state.selection;
  if (shiftKey || $from.parent !== $to.parent) {
    return {
      handled: false,
      detail: shiftKey ? "insert:hard-break" : "insert:enter",
    };
  }

  const behavior = blockSemantics.behaviorForNodeName($from.parent.type.name);
  if (behavior?.insertEnter === "newline-with-indent") {
    const lineBeforeCursor = $from.parent.textContent
      .slice(0, $from.parentOffset)
      .split("\n")
      .at(-1);
    const indentation = lineBeforeCursor?.match(/^[\t ]*/)?.[0] ?? "";
    const inserted = `\n${indentation}`;
    const transaction = view.state.tr.insertText(
      inserted,
      view.state.selection.from,
      view.state.selection.to,
    );
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(
          view.state.selection.from + inserted.length,
          transaction.doc.content.size,
        ),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `${behaviorDetailPrefix(behavior.id)}:newline-with-indent`,
    };
  }

  return {
    handled: false,
    detail: "insert:enter",
  };
}

function insertLogicalLineStartOffset(
  parent: ProseMirrorNode,
  caretOffset: number,
): number {
  let lineStart = 0;
  parent.forEach((child, childOffset) => {
    if (childOffset >= caretOffset) return;
    if (
      (child.type.name === "hardBreak" || child.type.name === "hard_break") &&
      childOffset + child.nodeSize <= caretOffset
    ) {
      lineStart = childOffset + child.nodeSize;
      return;
    }
    if (!child.isText || !child.text) return;
    const through = Math.max(
      0,
      Math.min(child.text.length, caretOffset - childOffset),
    );
    const newline = child.text.lastIndexOf("\n", through - 1);
    if (newline >= 0) lineStart = childOffset + newline + 1;
  });
  return lineStart;
}

function insertDeletionStoredMarks(
  view: VimEditorView,
): readonly import("@tiptap/pm/model").Mark[] | null {
  if (!(view.state.selection instanceof TextSelection)) return null;
  return view.state.storedMarks ?? view.state.selection.$from.marks();
}

function deleteInsertRange(
  view: VimEditorView,
  from: number,
  to: number,
  detail: string,
): EditorVimResult {
  if (from >= to) return { handled: false, detail };
  const marks = insertDeletionStoredMarks(view);
  try {
    const transaction = view.state.tr.delete(from, to);
    transaction.setSelection(TextSelection.create(transaction.doc, from));
    if (marks) transaction.setStoredMarks([...marks]);
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return { handled: true, detail };
  } catch {
    return { handled: false, detail };
  }
}

/** Deletes from the current explicit logical-line start to the Insert caret. */
export function runEditorInsertDeleteLinePrefix(
  view: VimEditorView,
): EditorVimResult {
  const selection = view.state.selection;
  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    !selection.$from.parent.isTextblock
  ) {
    return { handled: false, detail: "insert:delete-line-prefix" };
  }
  const lineStartOffset = insertLogicalLineStartOffset(
    selection.$from.parent,
    selection.$from.parentOffset,
  );
  return deleteInsertRange(
    view,
    selection.$from.start() + lineStartOffset,
    selection.from,
    "insert:delete-line-prefix",
  );
}

/** Runs the same structural boundary rules as Backspace, then deletes one unit. */
export function runEditorInsertBackspace(view: VimEditorView): EditorVimResult {
  const boundary = runEditorInsertBoundaryDelete(view, "backward");
  if (boundary.handled || boundary.preventDefault) return boundary;
  const selection = view.state.selection;
  const detail = "insert:backspace";
  if (!(selection instanceof TextSelection)) {
    return { handled: false, detail };
  }
  if (!selection.empty) {
    return deleteInsertRange(view, selection.from, selection.to, detail);
  }
  const before = selection.$from.nodeBefore;
  if (!before) return { handled: false, detail };
  if (before.isText && before.text) {
    const character = Array.from(before.text).at(-1);
    return character
      ? deleteInsertRange(
          view,
          selection.from - character.length,
          selection.from,
          detail,
        )
      : { handled: false, detail };
  }
  if (before.isInline && (before.isAtom || before.isLeaf)) {
    return deleteInsertRange(
      view,
      selection.from - before.nodeSize,
      selection.from,
      detail,
    );
  }
  return { handled: false, detail };
}

interface InsertBackwardUnit {
  readonly from: number;
  readonly to: number;
  readonly character: string;
  readonly kind: "text" | "atom";
  wordClass: VimWordSegment | null;
}

function insertBackwardUnits(
  parent: ProseMirrorNode,
  parentStart: number,
  lineStartOffset: number,
  caretOffset: number,
): InsertBackwardUnit[] {
  const units: InsertBackwardUnit[] = [];
  parent.forEach((child, childOffset) => {
    const childEnd = childOffset + child.nodeSize;
    if (childEnd <= lineStartOffset || childOffset >= caretOffset) return;
    if (child.isText && child.text) {
      const fromOffset = Math.max(lineStartOffset, childOffset);
      const toOffset = Math.min(caretOffset, childEnd);
      const slice = child.text.slice(
        fromOffset - childOffset,
        toOffset - childOffset,
      );
      let position = parentStart + fromOffset;
      for (const character of Array.from(slice)) {
        units.push({
          from: position,
          to: position + character.length,
          character,
          kind: "text",
          wordClass: null,
        });
        position += character.length;
      }
      return;
    }
    if (
      child.isInline &&
      (child.isAtom || child.isLeaf) &&
      childOffset >= lineStartOffset &&
      childEnd <= caretOffset
    ) {
      units.push({
        from: parentStart + childOffset,
        to: parentStart + childEnd,
        character: " ",
        kind: "atom",
        wordClass: null,
      });
    }
  });
  const classes = segmentVimWordCharacters(
    units.map((unit) => (unit.kind === "atom" ? " " : unit.character)),
  );
  units.forEach((unit, index) => {
    unit.wordClass = unit.kind === "text" ? (classes[index] ?? null) : null;
  });
  return units;
}

function isInsertWhitespace(unit: InsertBackwardUnit): boolean {
  return unit.kind === "text" && /\s/u.test(unit.character);
}

/** Implements Vim-style Insert CTRL-W without crossing an editable line. */
export function runEditorInsertDeleteWordBackward(
  view: VimEditorView,
): EditorVimResult {
  const selection = view.state.selection;
  const detail = "insert:delete-word-backward";
  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    !selection.$from.parent.isTextblock
  ) {
    return { handled: false, detail };
  }
  const parent = selection.$from.parent;
  const caretOffset = selection.$from.parentOffset;
  const lineStartOffset = insertLogicalLineStartOffset(parent, caretOffset);
  const units = insertBackwardUnits(
    parent,
    selection.$from.start(),
    lineStartOffset,
    caretOffset,
  );
  if (units.length === 0) return { handled: false, detail };

  let index = units.length - 1;
  while (index >= 0 && isInsertWhitespace(units[index]!)) index -= 1;
  if (index < 0) {
    return deleteInsertRange(view, units[0]!.from, selection.from, detail);
  }

  const target = units[index]!;
  let startIndex = index;
  if (target.kind === "atom") {
    startIndex = index;
  } else if (target.wordClass !== null) {
    while (
      startIndex > 0 &&
      units[startIndex - 1]!.kind === "text" &&
      units[startIndex - 1]!.wordClass === target.wordClass &&
      units[startIndex - 1]!.to === units[startIndex]!.from
    ) {
      startIndex -= 1;
    }
  } else {
    while (
      startIndex > 0 &&
      units[startIndex - 1]!.kind === "text" &&
      units[startIndex - 1]!.wordClass === null &&
      !isInsertWhitespace(units[startIndex - 1]!) &&
      units[startIndex - 1]!.to === units[startIndex]!.from
    ) {
      startIndex -= 1;
    }
  }
  return deleteInsertRange(
    view,
    units[startIndex]!.from,
    selection.from,
    detail,
  );
}

function textBlockBoundaryInNode(
  node: ProseMirrorNode,
  nodePosition: number,
  direction: "before" | "after",
): number | null {
  if (node.isTextblock) {
    return nodePosition + 1 + (direction === "before" ? node.content.size : 0);
  }
  let boundary: number | null = null;
  node.descendants((child, offset) => {
    if (direction === "after" && boundary !== null) return false;
    if (!child.isTextblock) return true;
    const childPosition = nodePosition + 1 + offset;
    const candidate =
      childPosition + 1 + (direction === "before" ? child.content.size : 0);
    boundary = candidate;
    return false;
  });
  return boundary;
}

/**
 * A selectable block atom has no Insert position of its own. `i`/`I` enter at
 * the previous editable block's end and `a`/`A` at the next editable block's
 * start. At a document edge (or beside another non-editable atom), create the
 * missing Paragraph next to the atom.
 */
export function runEditorEnterInsertFromHorizontalRule(
  view: VimEditorView,
  direction: "before" | "after",
): EditorVimResult {
  const selection = view.state.selection;
  if (
    !(selection instanceof NodeSelection) ||
    !["horizontalRule", "image", "attachment"].includes(
      selection.node.type.name,
    )
  ) {
    return {
      handled: false,
      detail: `horizontal-rule:insert-${direction}`,
    };
  }

  const sibling =
    direction === "before"
      ? selection.$from.nodeBefore
      : view.state.doc.resolve(selection.to).nodeAfter;
  const siblingPosition = sibling
    ? direction === "before"
      ? selection.from - sibling.nodeSize
      : selection.to
    : null;
  const existingTarget =
    sibling && siblingPosition !== null
      ? textBlockBoundaryInNode(sibling, siblingPosition, direction)
      : null;
  if (existingTarget !== null) {
    const transaction = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, existingTarget),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `horizontal-rule:insert-${direction}`,
      nextMode: "insert",
    };
  }

  const insertionPosition =
    direction === "before" ? selection.from : selection.to;
  const $insertion = view.state.doc.resolve(insertionPosition);
  const insertionIndex = $insertion.index();
  const paragraph = view.state.schema.nodes.paragraph?.createAndFill({
    blockId: createUuidV7(),
  });
  if (
    !paragraph ||
    !$insertion.parent.canReplaceWith(
      insertionIndex,
      insertionIndex,
      paragraph.type,
      paragraph.marks,
    )
  ) {
    return {
      handled: false,
      detail: `horizontal-rule:insert-${direction}`,
    };
  }

  const transaction = view.state.tr.insert(insertionPosition, paragraph);
  transaction.setSelection(
    TextSelection.create(transaction.doc, insertionPosition + 1),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: `horizontal-rule:insert-${direction}-created-paragraph`,
    nextMode: "insert",
  };
}

export function runEditorInsertBoundaryDelete(
  view: VimEditorView,
  direction: "backward" | "forward",
): EditorVimResult {
  const selection = view.state.selection;
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    const transaction = view.state.tr.deleteSelection();
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(selection.from, transaction.doc.content.size),
        ),
        direction === "backward" ? -1 : 1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `block-atom:delete-${direction}`,
    };
  }

  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    selection.$from.parent !== selection.$to.parent
  ) {
    return {
      handled: false,
      detail: `insert:delete-${direction}`,
    };
  }

  const { $from } = selection;
  const atBoundary =
    direction === "backward"
      ? $from.parentOffset === 0
      : $from.parentOffset === $from.parent.content.size;
  if (!atBoundary) {
    return {
      handled: false,
      detail: `insert:delete-${direction}`,
    };
  }

  const boundary = directSiblingBoundary(view, direction);
  if (!boundary) {
    return {
      handled: false,
      detail: `insert:delete-${direction}`,
    };
  }
  const currentUnwrap = unwrapBoundaryNode(
    view,
    boundary,
    boundary.current,
    boundary.currentPosition,
    boundary.currentIndex,
    direction,
    false,
  );
  if (currentUnwrap) return currentUnwrap;
  if (boundary.neighbor) {
    const adjacentUnwrap = unwrapBoundaryNode(
      view,
      boundary,
      boundary.neighbor,
      boundary.neighborPosition,
      boundary.neighborIndex,
      direction,
      true,
    );
    if (adjacentUnwrap) return adjacentUnwrap;
    const joined = joinCompatibleBoundary(view, boundary, direction);
    if (joined) return joined;
  }

  return {
    handled: false,
    detail: `insert:delete-${direction}`,
  };
}

interface DirectSiblingBoundary {
  parent: ProseMirrorNode;
  current: ProseMirrorNode;
  currentIndex: number;
  currentPosition: number;
  neighbor: ProseMirrorNode | null;
  neighborIndex: number;
  neighborPosition: number;
  selectionPosition: number;
}

function directSiblingBoundary(
  view: VimEditorView,
  direction: "backward" | "forward",
): DirectSiblingBoundary | null {
  const { $from } = view.state.selection;
  if ($from.depth < 1) return null;
  const blockDepth = $from.depth;
  const parentDepth = blockDepth - 1;
  const parent = $from.node(parentDepth);
  const current = $from.node(blockDepth);
  const currentIndex = $from.index(parentDepth);
  if (parent.maybeChild(currentIndex) !== current) return null;
  const neighborIndex =
    direction === "backward" ? currentIndex - 1 : currentIndex + 1;
  const neighbor = parent.maybeChild(neighborIndex) ?? null;
  const currentPosition = $from.before(blockDepth);
  const neighborPosition = neighbor
    ? direction === "backward"
      ? currentPosition - neighbor.nodeSize
      : currentPosition + current.nodeSize
    : currentPosition;
  return {
    parent,
    current,
    currentIndex,
    currentPosition,
    neighbor,
    neighborIndex,
    neighborPosition,
    selectionPosition: view.state.selection.from,
  };
}

function unwrapBoundaryNode(
  view: VimEditorView,
  boundary: DirectSiblingBoundary,
  node: ProseMirrorNode,
  position: number,
  index: number,
  direction: "backward" | "forward",
  adjacent: boolean,
): EditorVimResult | null {
  const behavior = blockSemantics.behaviorForNodeName(node.type.name);
  const unwrap = behavior?.unwrapToParagraphAtBoundary;
  if (!unwrap || (unwrap === "when-empty" && node.content.size > 0)) {
    return null;
  }
  const paragraph = view.state.schema.nodes.paragraph;
  if (
    !paragraph ||
    !boundary.parent.canReplaceWith(index, index + 1, paragraph)
  ) {
    return null;
  }

  const blockId = node.attrs.blockId;
  const transaction = view.state.tr.setNodeMarkup(
    position,
    paragraph,
    typeof blockId === "string" && blockId ? { blockId } : undefined,
  );
  transaction.setSelection(
    TextSelection.create(
      transaction.doc,
      Math.min(boundary.selectionPosition, transaction.doc.content.size),
    ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: `structure:unwrap-${adjacent ? "adjacent-" : ""}${direction}`,
  };
}

function joinCompatibleBoundary(
  view: VimEditorView,
  boundary: DirectSiblingBoundary,
  direction: "backward" | "forward",
): EditorVimResult | null {
  const neighbor = boundary.neighbor;
  if (!neighbor) return null;
  const currentJoin = blockSemantics.behaviorForNodeName(
    boundary.current.type.name,
  )?.boundaryJoin;
  const neighborJoin = blockSemantics.behaviorForNodeName(
    neighbor.type.name,
  )?.boundaryJoin;
  if (!currentJoin && !neighborJoin) return null;
  const detailPrefix =
    (currentJoin ?? neighborJoin) === "source-lines" ? "source" : "code";
  const joinAttribute =
    currentJoin === "source-lines" ? "sourceFormat" : "language";
  if (
    !currentJoin ||
    currentJoin !== neighborJoin ||
    boundary.current.attrs[joinAttribute] !== neighbor.attrs[joinAttribute]
  ) {
    return {
      handled: false,
      preventDefault: true,
      detail: `${detailPrefix}:incompatible-boundary-${direction}`,
    };
  }

  const left = direction === "backward" ? neighbor : boundary.current;
  const right = direction === "backward" ? boundary.current : neighbor;
  const leftPosition =
    direction === "backward"
      ? boundary.neighborPosition
      : boundary.currentPosition;
  const rightPosition =
    direction === "backward"
      ? boundary.currentPosition
      : boundary.neighborPosition;
  const joinedText = `${left.textContent}\n${right.textContent}`;
  const joined = left.type.create(
    { ...left.attrs },
    view.state.schema.text(joinedText),
  );
  const transaction = view.state.tr.replaceWith(
    leftPosition,
    rightPosition + right.nodeSize,
    joined,
  );
  const cursorOffset =
    left.textContent.length + (direction === "backward" ? 1 : 0);
  transaction.setSelection(
    TextSelection.create(transaction.doc, leftPosition + 1 + cursorOffset),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: `${detailPrefix}:join-blocks-${direction}`,
  };
}

function scrollWhenLayoutIsAvailable(transaction: Transaction): Transaction {
  return typeof Range.prototype.getClientRects === "function"
    ? transaction.scrollIntoView()
    : transaction;
}

function selectionCursor(view: Pick<VimEditorView, "state">): number {
  return view.state.selection instanceof NodeSelection
    ? view.state.selection.from
    : view.state.selection.head;
}

export function clampVimBlockCursor(
  view: Pick<VimEditorView, "state">,
  position: number,
): number {
  const lines = blockSemantics.logicalLines(view);
  return clampCursorInLines(lines, position);
}

export function vimBlockCursorBeforeInsertCaret(
  view: Pick<VimEditorView, "state">,
): number {
  const insertionCursor =
    view.state.selection instanceof NodeSelection
      ? view.state.selection.from
      : view.state.selection.head;
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) return Math.max(0, insertionCursor - 1);
  const line = lines[blockSemantics.currentLineIndex(lines, insertionCursor)];
  const first = line.cursorPositions[0] ?? line.from;
  if (insertionCursor <= line.from) return first;
  const $insertion = view.state.doc.resolve(insertionCursor);
  if ($insertion.parent.isTextblock && $insertion.parent.content.size === 0) {
    return insertionCursor;
  }

  let previous = first;
  for (const candidate of line.cursorPositions) {
    if (candidate >= insertionCursor) break;
    previous = candidate;
  }
  return previous;
}

function clampCursorInLines(lines: VimLogicalLine[], position: number): number {
  if (lines.length === 0) return position;
  const line = lines[blockSemantics.currentLineIndex(lines, position)];
  return blockSemantics.nearestCursorPosition(line, position);
}

function exclusiveCursorEnd(
  view: Pick<VimEditorView, "state">,
  lines: VimLogicalLine[],
  position: number,
): number {
  if (lines.length === 0) return position;
  const line = lines[blockSemantics.currentLineIndex(lines, position)];
  const cursor = blockSemantics.nearestCursorPosition(line, position);
  const index = line.cursorPositions.indexOf(cursor);
  const next = index >= 0 ? line.cursorPositions[index + 1] : undefined;
  if (next !== undefined) return next;

  // A TableRow's logical `to` is its final descendant cursor rather than the
  // textblock's insertion boundary. Resolve the inline node at the cursor so
  // Visual Char can still include the final character of the rightmost Cell.
  const adjacent = view.state.doc.resolve(cursor).nodeAfter;
  if (
    adjacent?.isText ||
    (adjacent?.isInline && (adjacent.isAtom || adjacent.isLeaf))
  ) {
    return exclusiveCharacterPosition(view, cursor);
  }
  return line.to;
}

function cursorEndingAt(lines: VimLogicalLine[], boundary: number): number {
  if (lines.length === 0) return Math.max(0, boundary - 1);
  const probe = Math.max(0, boundary - 1);
  const line = lines[blockSemantics.currentLineIndex(lines, probe)];
  const boundaryIndex = line.cursorPositions.indexOf(boundary);
  if (boundaryIndex > 0) return line.cursorPositions[boundaryIndex - 1];
  if (boundary === line.to) {
    return line.cursorPositions[line.cursorPositions.length - 1] ?? line.from;
  }
  return clampCursorInLines(lines, probe);
}

function visualCharEndpoints(
  view: Pick<VimEditorView, "state">,
  lines: VimLogicalLine[],
): {
  anchor: number;
  cursor: number;
} {
  const selection = view.state.selection;
  if (!(selection instanceof TextSelection) || selection.empty) {
    const cursor = clampCursorInLines(lines, selection.from);
    return { anchor: cursor, cursor };
  }
  if (selection.head > selection.anchor) {
    return {
      anchor: clampCursorInLines(lines, selection.anchor),
      cursor: cursorEndingAt(lines, selection.head),
    };
  }
  return {
    anchor: cursorEndingAt(lines, selection.anchor),
    cursor: clampCursorInLines(lines, selection.head),
  };
}

function visualCharSelection(
  view: VimEditorView,
  lines: VimLogicalLine[],
  anchor: number,
  cursor: number,
): TextSelection {
  return cursor >= anchor
    ? TextSelection.create(
        view.state.doc,
        anchor,
        exclusiveCursorEnd(view, lines, cursor),
      )
    : TextSelection.create(
        view.state.doc,
        exclusiveCursorEnd(view, lines, anchor),
        cursor,
      );
}

export function beginVisualChar(
  view: VimEditorView,
  position: number = selectionCursor(view),
  focus = true,
): void {
  const lines = blockSemantics.logicalLines(view);
  const cursor = clampCursorInLines(lines, position);
  view.dispatch(
    scrollWhenLayoutIsAvailable(
      view.state.tr.setSelection(
        visualCharSelection(view, lines, cursor, cursor),
      ),
    ),
  );
  if (focus) view.focus();
}

export function restoreVisualCharSelection(
  view: VimEditorView,
  anchor: number,
  head: number,
): boolean {
  if (
    anchor === head ||
    anchor < 0 ||
    head < 0 ||
    anchor > view.state.doc.content.size ||
    head > view.state.doc.content.size
  ) {
    return false;
  }
  try {
    const selection = TextSelection.between(
      view.state.doc.resolve(anchor),
      view.state.doc.resolve(head),
      head >= anchor ? 1 : -1,
    );
    if (selection.empty) return false;
    view.dispatch(
      scrollWhenLayoutIsAvailable(view.state.tr.setSelection(selection)),
    );
    view.focus();
    return true;
  } catch {
    return false;
  }
}

export function visualCharCursor(view: Pick<VimEditorView, "state">): number {
  const lines = blockSemantics.logicalLines(view);
  return visualCharEndpoints(view, lines).cursor;
}

function visualLineRange(
  units: VimStructuralUnit[],
  visualLine: VimVisualLineState,
) {
  return blockSemantics.visualLineRange(
    units,
    visualLine.anchorUnit,
    visualLine.headUnit,
  );
}

function containsNestedListItem(node: ProseMirrorNode): boolean {
  let nested = false;
  node.descendants((child) => {
    if (blockSemantics.hasBehavior(child.type.name, "list-item")) {
      nested = true;
      return false;
    }
    return !nested;
  });
  return nested;
}

export interface VimVisualLineNodeRange {
  from: number;
  to: number;
  kind: Exclude<VimStructuralUnit["kind"], "code-line" | "hard-break-line">;
  nodeName: string;
}

export interface VimVisualLineTextRange {
  from: number;
  to: number;
  blockPosition: number;
  kind: Extract<VimStructuralUnit["kind"], "code-line" | "hard-break-line">;
  nodeName: string;
}

export function visualLineNodeRanges(
  view: Pick<VimEditorView, "state">,
  visualLine: VimVisualLineState,
): VimVisualLineNodeRange[] {
  const units = blockSemantics.visualLineUnits(view);
  const firstIndex = Math.min(visualLine.anchorUnit, visualLine.headUnit);
  const lastIndex = Math.max(visualLine.anchorUnit, visualLine.headUnit);
  const selectedUnits = units.slice(firstIndex, lastIndex + 1);
  if (selectedUnits.length === 0) return [];

  const ranges: VimVisualLineNodeRange[] = [];
  for (const unit of selectedUnits) {
    const { from, to, kind, nodeName } = unit;
    if (kind === "code-line" || kind === "hard-break-line") continue;
    const node = view.state.doc.nodeAt(from);
    if (!node || node.type.name !== nodeName || from + node.nodeSize !== to) {
      return [];
    }

    // A parent ListItem's structural range includes its nested list. V still
    // operates on ListItem structure, but its selection decoration represents
    // logical rows. Decorating the outer <li> would paint every descendant row
    // even when the Visual-Line head has not moved into those descendants.
    if (kind === "list-item") {
      if (containsNestedListItem(node)) {
        const logicalRow = view.state.doc.nodeAt(unit.blockPosition);
        if (!logicalRow || !logicalRow.isTextblock) return [];
        ranges.push({
          from: unit.blockPosition,
          to: unit.blockPosition + logicalRow.nodeSize,
          kind,
          nodeName: logicalRow.type.name,
        });
        continue;
      }
    }
    ranges.push({ from, to, kind, nodeName });
  }
  return ranges;
}

export function visualLineTextRanges(
  view: Pick<VimEditorView, "state">,
  visualLine: VimVisualLineState,
): VimVisualLineTextRange[] {
  const units = blockSemantics.visualLineUnits(view);
  const firstIndex = Math.min(visualLine.anchorUnit, visualLine.headUnit);
  const lastIndex = Math.max(visualLine.anchorUnit, visualLine.headUnit);
  return units
    .slice(firstIndex, lastIndex + 1)
    .filter(
      (
        unit,
      ): unit is VimStructuralUnit & {
        kind: "code-line" | "hard-break-line";
      } => unit.kind === "code-line" || unit.kind === "hard-break-line",
    )
    .map(({ textFrom, textTo, blockPosition, kind, nodeName }) => ({
      from: textFrom,
      to: textTo,
      blockPosition,
      kind,
      nodeName,
    }));
}

function applyVisualLineSelection(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  scrollIntoView = true,
  focus = true,
): boolean {
  const units = blockSemantics.visualLineUnits(view);
  if (units.length === 0) return false;
  const { first, last } = visualLineRange(units, visualLine);
  const nodeRanges = visualLineNodeRanges(view, visualLine);
  const textRanges = visualLineTextRanges(view, visualLine);
  let selection: Selection;

  if (nodeRanges.length > 0 || textRanges.length > 0) {
    selection = Selection.near(
      view.state.doc.resolve(
        Math.max(0, Math.min(visualLine.cursor, view.state.doc.content.size)),
      ),
      1,
    );
  } else {
    let selectionFrom = first.textFrom;
    let selectionTo = last.textTo;
    if (selectionFrom === selectionTo) {
      if (selectionTo < first.to) selectionTo += 1;
      else if (selectionFrom > first.from) selectionFrom -= 1;
    }
    selection = TextSelection.create(
      view.state.doc,
      Math.min(selectionFrom, selectionTo),
      Math.max(selectionFrom, selectionTo),
    );
  }

  const transaction = view.state.tr.setSelection(selection);
  view.dispatch(
    scrollIntoView ? scrollWhenLayoutIsAvailable(transaction) : transaction,
  );
  if (focus) view.focus();
  return true;
}

function visualLineStateAtCursor(
  units: VimStructuralUnit[],
  cursor: number,
): VimVisualLineState | null {
  if (units.length === 0) return null;
  const unitIndex = blockSemantics.currentStructuralUnitIndex(units, cursor);
  const unit = units[unitIndex];
  const normalizedCursor = unit.cursorPositions.reduce((nearest, candidate) =>
    Math.abs(candidate - cursor) < Math.abs(nearest - cursor)
      ? candidate
      : nearest,
  );
  return {
    anchorUnit: unitIndex,
    headUnit: unitIndex,
    cursor: normalizedCursor,
  };
}

export function beginVisualLine(
  view: VimEditorView,
): VimVisualLineState | null {
  const visualLine = visualLineStateAtCursor(
    blockSemantics.visualLineUnits(view),
    selectionCursor(view),
  );
  if (!visualLine) return null;
  applyVisualLineSelection(view, visualLine);
  return visualLine;
}

export function visualLineSelectionEndpoints(
  view: Pick<VimEditorView, "state">,
  visualLine: VimVisualLineState,
): { anchor: number; head: number } | null {
  const units = blockSemantics.visualLineUnits(view);
  const anchor = units[visualLine.anchorUnit];
  const head = units[visualLine.headUnit];
  if (!anchor || !head) return null;
  return { anchor: anchor.cursorFrom, head: visualLine.cursor };
}

export function restoreVisualLineSelection(
  view: VimEditorView,
  anchorPosition: number,
  headPosition: number,
): VimVisualLineState | null {
  const units = blockSemantics.visualLineUnits(view);
  if (units.length === 0) return null;
  const anchorUnit = blockSemantics.currentStructuralUnitIndex(
    units,
    anchorPosition,
  );
  const headUnit = blockSemantics.currentStructuralUnitIndex(
    units,
    headPosition,
  );
  const head = units[headUnit];
  if (!units[anchorUnit] || !head) return null;
  const cursor = head.cursorPositions.reduce(
    (nearest, candidate) =>
      Math.abs(candidate - headPosition) < Math.abs(nearest - headPosition)
        ? candidate
        : nearest,
    head.cursorFrom,
  );
  const visualLine = { anchorUnit, headUnit, cursor };
  return applyVisualLineSelection(view, visualLine) ? visualLine : null;
}

function moveVisualLineCursor(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  direction: -1 | 1,
  count = 1,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  const unit = units[visualLine.headUnit];
  if (!unit) {
    return {
      handled: false,
      detail: "structure-cursor:stale",
      visualLine,
    };
  }
  const currentIndex = Math.max(
    0,
    unit.cursorPositions.indexOf(visualLine.cursor),
  );
  const cursor =
    unit.cursorPositions[
      Math.max(
        0,
        Math.min(
          currentIndex + direction * normalizedCount(count),
          unit.cursorPositions.length - 1,
        ),
      )
    ] ?? visualLine.cursor;
  return {
    handled: cursor !== visualLine.cursor,
    detail: direction < 0 ? "structure-cursor:left" : "structure-cursor:right",
    visualLine: { ...visualLine, cursor },
  };
}

function moveVisualLineSelection(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  direction: -1 | 1,
  count = 1,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  const current = units[visualLine.headUnit];
  const headUnit = Math.max(
    0,
    Math.min(
      visualLine.headUnit + direction * normalizedCount(count),
      units.length - 1,
    ),
  );
  const target = units[headUnit];
  if (!current || !target || headUnit === visualLine.headUnit) {
    return {
      handled: false,
      detail: direction < 0 ? "structure:logical-up" : "structure:logical-down",
      visualLine,
    };
  }
  const column = Math.max(
    0,
    current.cursorPositions.indexOf(visualLine.cursor),
  );
  const next = {
    ...visualLine,
    headUnit,
    cursor:
      target.cursorPositions[
        Math.min(column, target.cursorPositions.length - 1)
      ] ?? target.cursorFrom,
  };
  applyVisualLineSelection(view, next);
  return {
    handled: true,
    detail: direction < 0 ? "structure:logical-up" : "structure:logical-down",
    visualLine: next,
  };
}

function moveVisualLineToDocumentUnit(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  edge: "start" | "end",
  count: number,
  countExplicit: boolean,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  if (units.length === 0) {
    return {
      handled: false,
      detail: `structure:document-${edge}`,
      visualLine,
    };
  }
  const headUnit =
    edge === "end" && !countExplicit
      ? units.length - 1
      : Math.min(normalizedCount(count) - 1, units.length - 1);
  const target = units[headUnit];
  if (!target || headUnit === visualLine.headUnit) {
    return {
      handled: false,
      detail: `structure:document-${edge}`,
      visualLine,
    };
  }
  const next = {
    ...visualLine,
    headUnit,
    cursor: target.cursorPositions[0] ?? target.cursorFrom,
  };
  applyVisualLineSelection(view, next);
  return {
    handled: true,
    detail: `structure:document-${edge}`,
    visualLine: next,
  };
}

function moveVisualLineViewport(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  direction: -1 | 1,
  kind: "page" | "half-page",
  count = 1,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  const lines = blockSemantics.logicalLines(view);
  const detail = `structure:${kind}-${direction < 0 ? "up" : "down"}`;
  if (units.length === 0 || lines.length === 0) {
    return { handled: false, detail, visualLine };
  }
  if (!viewportScrollRoot(view)?.clientHeight) {
    const result = moveVisualLineSelection(
      view,
      visualLine,
      direction,
      fallbackViewportRows(kind) * normalizedCount(count),
    );
    return { ...result, detail };
  }

  let next = visualLine;
  let handled = false;
  for (let repeat = 0; repeat < normalizedCount(count); repeat += 1) {
    const step = viewportStep(view, lines, next.cursor, direction, kind);
    if (!step) {
      const fallback = moveVisualLineSelection(
        view,
        next,
        direction,
        fallbackViewportRows(kind) * (normalizedCount(count) - repeat),
      );
      return { ...fallback, handled: handled || fallback.handled, detail };
    }
    const exactCursorUnit = units.findIndex(({ cursorPositions }) =>
      cursorPositions.includes(step.destination),
    );
    const headUnit =
      exactCursorUnit >= 0
        ? exactCursorUnit
        : blockSemantics.currentStructuralUnitIndex(units, step.destination);
    const target = units[headUnit];
    if (!target) break;
    const cursor = target.cursorPositions.reduce(
      (nearest, candidate) =>
        Math.abs(candidate - step.destination) <
        Math.abs(nearest - step.destination)
          ? candidate
          : nearest,
      target.cursorFrom,
    );
    const changed = headUnit !== next.headUnit || cursor !== next.cursor;
    if (changed) {
      next = { ...next, headUnit, cursor };
      handled = true;
    }
    if (step.scrolled) handled = true;
    if (!step.scrolled && !changed) break;
  }
  if (
    next.headUnit !== visualLine.headUnit ||
    next.cursor !== visualLine.cursor
  ) {
    applyVisualLineSelection(view, next, false);
  }
  return { handled, detail, visualLine: next };
}

function registerForUnits(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  units: VimStructuralUnit[],
  logicalListItemSelection = false,
): VimRegister | null {
  if (units.length === 0) return null;
  const selectedUnits = units.slice(
    Math.min(visualLine.anchorUnit, visualLine.headUnit),
    Math.max(visualLine.anchorUnit, visualLine.headUnit) + 1,
  );
  const defaultRange = visualLineRange(units, visualLine);
  let { from, to } = defaultRange;
  if (
    logicalListItemSelection &&
    selectedUnits.some(({ kind }) => kind === "list-item")
  ) {
    // ListItem units overlap: an ancestor unit's `to` encloses every nested
    // descendant. Build the register from document-order endpoints instead,
    // and clip the last ancestor to its direct logical row when its children
    // have not been reached by the Visual head/count.
    const firstUnit = selectedUnits[0];
    const lastUnit = selectedUnits.at(-1);
    if (!firstUnit || !lastUnit) return null;
    from = firstUnit.from;
    to = lastUnit.to;
    if (lastUnit.kind === "list-item") {
      const listItem = view.state.doc.nodeAt(lastUnit.from);
      if (listItem && containsNestedListItem(listItem)) {
        const logicalRow = view.state.doc.nodeAt(lastUnit.blockPosition);
        if (!logicalRow || !logicalRow.isTextblock) return null;
        to = lastUnit.blockPosition + logicalRow.nodeSize;
      }
    }
  }
  const lineBehaviorId = blockLineBehaviorId(selectedUnits);
  if (lineBehaviorId) {
    const firstUnit = selectedUnits[0];
    const lastUnit = selectedUnits.at(-1);
    const block = firstUnit
      ? view.state.doc.nodeAt(firstUnit.blockPosition)
      : null;
    if (!block) return null;
    const text = selectedUnits
      .map(({ textFrom, textTo }) =>
        view.state.doc.textBetween(textFrom, textTo, "", "\uFFFC"),
      )
      .join("\n");
    const preservesInlineContent =
      firstUnit?.kind === "hard-break-line" &&
      selectedUnits.every(
        ({ kind, blockPosition }) =>
          kind === "hard-break-line" &&
          blockPosition === firstUnit.blockPosition,
      );
    return {
      kind: "block-lines",
      text,
      lineCount: selectedUnits.length,
      behaviorId: lineBehaviorId,
      blockNodeName: block.type.name,
      blockAttrs: { ...block.attrs },
      slice:
        preservesInlineContent && lastUnit
          ? view.state.doc.slice(firstUnit.textFrom, lastUnit.textTo)
          : undefined,
    };
  }
  return {
    kind: "structure",
    text: view.state.doc.textBetween(from, to, "\n", "\uFFFC"),
    structureKind: selectedUnits.every(({ kind }) => kind === "table-row")
      ? "table-row"
      : selectedUnits.some(({ kind }) => kind === "list-item")
        ? "list-item"
        : "block",
    nodeNames: [...new Set(selectedUnits.map(({ nodeName }) => nodeName))],
    slice: view.state.doc.slice(from, to),
  };
}

function structureRegister(
  view: VimEditorView,
  visualLine: VimVisualLineState,
): VimRegister | null {
  return registerForUnits(
    view,
    visualLine,
    blockSemantics.structuralUnits(view),
  );
}

function visualLineRegister(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  includeSectionSubtree = false,
): VimRegister | null {
  if (includeSectionSubtree) {
    const section = sectionRegisterForVisualTitle(view, visualLine);
    if (section) return section;
  }
  return registerForUnits(
    view,
    visualLine,
    blockSemantics.visualLineUnits(view),
    true,
  );
}

interface SectionTitleTarget {
  readonly root: boolean;
  readonly sectionId: string;
  readonly from: number;
  readonly to: number;
  readonly node: ProseMirrorNode;
}

function sectionTitleTarget(
  view: VimEditorView,
  visualLine: VimVisualLineState,
): SectionTitleTarget | null {
  if (visualLine.anchorUnit !== visualLine.headUnit) return null;
  const unit = blockSemantics.visualLineUnits(view)[visualLine.anchorUnit];
  if (!unit || unit.nodeName !== "sectionHeader") return null;
  const header = view.state.doc.nodeAt(unit.blockPosition);
  if (!header || header.type.name !== "sectionHeader") return null;
  const sectionId = String(header.attrs.sectionId ?? "");
  if (!sectionId) return null;
  if (unit.blockPosition === 0) {
    const sectionType = view.state.schema.nodes.section;
    if (!sectionType || view.state.doc.childCount !== 3) return null;
    try {
      const node = sectionType.create(null, [
        view.state.doc.child(0),
        view.state.doc.child(1),
        view.state.doc.child(2),
      ]);
      return {
        root: true,
        sectionId,
        from: 0,
        to: view.state.doc.content.size,
        node,
      };
    } catch {
      return null;
    }
  }
  let result: SectionTitleTarget | null = null;
  view.state.doc.descendants((node, position) => {
    if (result || node.type.name !== "section") return !result;
    if (position + 1 !== unit.blockPosition) return true;
    result = {
      root: false,
      sectionId,
      from: position,
      to: position + node.nodeSize,
      node,
    };
    return false;
  });
  return result;
}

function sectionHeaderAtUnit(
  view: Pick<VimEditorView, "state">,
  unit: VimStructuralUnit | undefined,
): { sectionId: string; position: number; node: ProseMirrorNode } | null {
  if (!unit || unit.nodeName !== "sectionHeader") return null;
  const node = view.state.doc.nodeAt(unit.blockPosition);
  if (!node || node.type.name !== "sectionHeader") return null;
  const sectionId = String(node.attrs.sectionId ?? "");
  return sectionId ? { sectionId, position: unit.blockPosition, node } : null;
}

function focusedSectionId(view: Pick<VimEditorView, "dom">): string | null {
  const value = view.dom.dataset.sectionId;
  return value && value.length > 0 ? value : null;
}

function plainSectionTitleFromParagraph(
  paragraph: ProseMirrorNode,
  through = paragraph.content.size,
  resolveInternalLinkTitle?: (targetSectionId: string) => string | null,
): string {
  const bounded = Math.max(0, Math.min(through, paragraph.content.size));
  const content = paragraph.content.cut(0, bounded);
  let result = "";
  content.descendants((node) => {
    if (node.isText) {
      result += node.text ?? "";
      return false;
    }
    if (node.type.name === "hardBreak" || node.type.name === "hard_break") {
      result += " ";
      return false;
    }
    if (node.type.name === "internalSectionLink") {
      const targetSectionId = String(node.attrs.targetSectionId ?? "");
      result +=
        (targetSectionId
          ? resolveInternalLinkTitle?.(targetSectionId)
          : null) ?? node.textContent;
      return false;
    }
    if (node.isInline && (node.isAtom || node.isLeaf)) {
      result += node.textContent;
      return false;
    }
    return true;
  });
  return result;
}

/** Resolves an Insert caret in a direct Section-body Paragraph. */
export function sectionParagraphConversionSelection(
  view: VimEditorView,
  resolveInternalLinkTitle?: (targetSectionId: string) => string | null,
): SectionParagraphConversionSelection | null {
  const selection = view.state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  const chunkDepth = $from.depth - 1;
  const bodyDepth = $from.depth - 2;
  const sectionDepth = $from.depth - 3;
  if (
    $from.parent.type.name !== "paragraph" ||
    $from.depth < 3 ||
    $from.node(chunkDepth).type.name !== BODY_CHUNK_NODE ||
    $from.node(bodyDepth).type.name !== "sectionBody" ||
    $from.node(sectionDepth).type.name !== "section"
  ) {
    return null;
  }
  const boundarySectionId = focusedSectionId(view);
  const sourceHeader = $from.node(sectionDepth).firstChild;
  const sourceSectionId = String(sourceHeader?.attrs.sectionId ?? "");
  const paragraphBlockId = String($from.parent.attrs.blockId ?? "");
  if (!boundarySectionId || !sourceSectionId || !paragraphBlockId) return null;
  const body = $from.node(bodyDepth);
  const chunkIndex = $from.index(bodyDepth);
  let paragraphBodyIndex = $from.index(chunkDepth);
  for (let index = 0; index < chunkIndex; index += 1) {
    const chunk = body.child(index);
    if (chunk.type.name !== BODY_CHUNK_NODE) return null;
    paragraphBodyIndex += chunk.childCount;
  }
  return {
    boundarySectionId,
    sourceSectionId,
    paragraphBlockId,
    paragraphBodyIndex,
    title: plainSectionTitleFromParagraph(
      $from.parent,
      $from.parent.content.size,
      resolveInternalLinkTitle,
    ),
    caretOffset: plainSectionTitleFromParagraph(
      $from.parent,
      $from.parentOffset,
      resolveInternalLinkTitle,
    ).length,
    paragraphOffset: $from.parentOffset,
    caretPosition: selection.from,
  };
}

/** Resolves Vim depth commands to Section Header IDs inside this mounted view. */
export function sectionDepthShiftSelection(
  view: VimEditorView,
  mode: VimMode,
  count: number,
  visualLine: VimVisualLineState | null,
): SectionDepthShiftSelection | null {
  const boundarySectionId = focusedSectionId(view);
  if (!boundarySectionId) return null;
  const units = blockSemantics.visualLineUnits(view);
  if (units.length === 0) return null;

  let targetUnits: VimStructuralUnit[];
  let caretUnit: VimStructuralUnit | undefined;
  if (mode === "visual-line" && visualLine) {
    const first = Math.min(visualLine.anchorUnit, visualLine.headUnit);
    const last = Math.max(visualLine.anchorUnit, visualLine.headUnit);
    targetUnits = units
      .slice(first, last + 1)
      .filter(({ nodeName }) => nodeName === "sectionHeader");
    caretUnit =
      units[visualLine.anchorUnit]?.nodeName === "sectionHeader"
        ? units[visualLine.anchorUnit]
        : targetUnits[0];
  } else {
    const cursor = selectionCursor(view);
    const currentIndex = blockSemantics.currentStructuralUnitIndex(
      units,
      cursor,
    );
    const current = sectionHeaderAtUnit(view, units[currentIndex]);
    if (!current) return null;
    targetUnits = units
      .slice(currentIndex)
      .filter(({ nodeName }) => nodeName === "sectionHeader")
      .slice(0, normalizedCount(count));
    caretUnit = units[currentIndex];
  }

  const targets = targetUnits
    .map((unit) => sectionHeaderAtUnit(view, unit))
    .filter(
      (
        value,
      ): value is {
        sectionId: string;
        position: number;
        node: ProseMirrorNode;
      } => value !== null && value.sectionId !== boundarySectionId,
    );
  const originalCaret = sectionHeaderAtUnit(view, caretUnit);
  const caret =
    targets.find(({ sectionId }) => sectionId === originalCaret?.sectionId) ??
    targets[0];
  if (targets.length === 0 || !caret) return null;
  const currentCursor = selectionCursor(view);
  let caretPosition = currentCursor;
  if (mode === "visual-line" && visualLine && caretUnit) {
    const headUnit = units[visualLine.headUnit];
    const column = Math.max(
      0,
      headUnit?.cursorPositions.indexOf(visualLine.cursor) ?? 0,
    );
    caretPosition =
      caretUnit.cursorPositions[
        Math.min(column, caretUnit.cursorPositions.length - 1)
      ] ?? caretUnit.cursorFrom;
  }
  return {
    boundarySectionId,
    sectionIds: [...new Set(targets.map(({ sectionId }) => sectionId))],
    caretSectionId: caret.sectionId,
    caretOffset: Math.max(
      0,
      Math.min(caretPosition - (caret.position + 1), caret.node.content.size),
    ),
    caretPosition,
  };
}

export function sectionHeaderPosition(
  view: Pick<VimEditorView, "state">,
  targetSectionId: string,
  offset = 0,
): number | null {
  let result: number | null = null;
  view.state.doc.descendants((node, position) => {
    if (
      result === null &&
      node.type.name === "sectionHeader" &&
      node.attrs.sectionId === targetSectionId
    ) {
      result = position + 1 + Math.max(0, Math.min(offset, node.content.size));
      return false;
    }
    return result === null;
  });
  return result;
}

function sectionRegisterForVisualTitle(
  view: VimEditorView,
  visualLine: VimVisualLineState,
): Extract<VimRegister, { kind: "section" }> | null {
  const target = sectionTitleTarget(view, visualLine);
  if (!target) return null;
  const sectionIds: string[] = [];
  target.node.descendants((node) => {
    if (node.type.name === "sectionHeader") {
      const id = String(node.attrs.sectionId ?? "");
      if (id) sectionIds.push(id);
    }
    return true;
  });
  return {
    kind: "section",
    text: target.node.textBetween(0, target.node.content.size, "\n", "\uFFFC"),
    transfer: "copy",
    sourceNoteId: view.dom.dataset.noteId ?? null,
    sectionIds,
    slice: new Slice(Fragment.from(target.node), 0, 0),
  };
}

function blockLineBehaviorId(
  units: readonly VimStructuralUnit[],
): string | null {
  const firstKind = units[0]?.kind;
  if (
    units.length === 0 ||
    (firstKind !== "code-line" && firstKind !== "hard-break-line") ||
    !units.every(({ kind }) => kind === firstKind)
  ) {
    return null;
  }
  const behaviorIds = units.map(
    ({ nodeName }) => blockSemantics.behaviorForNodeName(nodeName)?.id ?? null,
  );
  const first = behaviorIds[0];
  return first && behaviorIds.every((behaviorId) => behaviorId === first)
    ? first
    : null;
}

function pasteStructure(
  view: VimEditorView,
  register: Extract<VimRegister, { kind: "structure" }>,
  from: number,
  to: number,
): boolean {
  try {
    const slice = structureSliceForRange(view, register, from, to);
    if (!slice) return false;
    const transaction = view.state.tr.replace(from, to, slice);
    const cursor = Math.min(from + slice.size, transaction.doc.content.size);
    transaction.setSelection(
      Selection.near(transaction.doc.resolve(cursor), -1),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function freshBlockId(): string {
  return createUuidV7();
}

function copyNodeWithFreshBlockIds(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node;
  const attributes = { ...node.attrs };
  if (typeof node.attrs.blockId === "string" && node.attrs.blockId) {
    attributes.blockId = freshBlockId();
  }
  const children: ProseMirrorNode[] = [];
  node.content.forEach((child) => {
    children.push(copyNodeWithFreshBlockIds(child));
  });
  return node.type.create(
    attributes,
    children.length > 0 ? Fragment.fromArray(children) : null,
    node.marks,
  );
}

function copyStructureWithFreshBlockIds(slice: Slice): Slice {
  const nodes: ProseMirrorNode[] = [];
  slice.content.forEach((node) => {
    nodes.push(copyNodeWithFreshBlockIds(node));
  });
  return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd);
}

function sectionIdsInDocument(document: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  document.descendants((node) => {
    if (node.type.name === "sectionHeader") {
      const id = String(node.attrs.sectionId ?? "");
      if (id) ids.add(id);
    }
    return true;
  });
  return ids;
}

function copiedSectionNode(
  node: ProseMirrorNode,
  idMap: ReadonlyMap<string, string>,
  preserveBlockIds: boolean,
): ProseMirrorNode {
  if (node.isText) return node;
  const attributes = { ...node.attrs };
  if (!preserveBlockIds && typeof attributes.blockId === "string") {
    attributes.blockId = freshBlockId();
  }
  if (node.type.name === "sectionHeader") {
    const current = String(attributes.sectionId ?? "");
    attributes.sectionId = idMap.get(current) ?? current;
  } else if (node.type.name === "internalSectionLink") {
    const target = String(attributes.targetSectionId ?? "");
    attributes.targetSectionId = idMap.get(target) ?? target;
  }
  const children: ProseMirrorNode[] = [];
  node.content.forEach((child) => {
    children.push(copiedSectionNode(child, idMap, preserveBlockIds));
  });
  return node.type.create(
    attributes,
    children.length > 0 ? Fragment.fromArray(children) : null,
    node.marks,
  );
}

function sectionSliceForPut(
  view: VimEditorView,
  register: Extract<VimRegister, { kind: "section" }>,
): { slice: Slice; reidentified: boolean } | null {
  if (
    register.slice.openStart !== 0 ||
    register.slice.openEnd !== 0 ||
    register.slice.content.childCount !== 1 ||
    register.slice.content.firstChild?.type.name !== "section"
  ) {
    return null;
  }
  const occupied = sectionIdsInDocument(view.state.doc);
  const hasCollision = register.sectionIds.some((id) => occupied.has(id));
  const reidentified = register.transfer === "copy" || hasCollision;
  const idMap = new Map<string, string>();
  for (const id of register.sectionIds) {
    idMap.set(id, reidentified ? createUuidV7() : id);
  }
  const source = register.slice.content.firstChild;
  if (!source) return null;
  const copied = copiedSectionNode(source, idMap, !reidentified);
  return {
    slice: new Slice(Fragment.from(copied), 0, 0),
    reidentified,
  };
}

function nearestSectionDepth(view: VimEditorView, position: number): number {
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  const $position = view.state.doc.resolve(bounded);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if ($position.node(depth).type.name === "section") return depth;
  }
  return 0;
}

function sectionPutPosition(
  view: VimEditorView,
  direction: PutDirection,
): number | null {
  const cursor = selectionCursor(view);
  const $cursor = view.state.doc.resolve(
    Math.max(0, Math.min(cursor, view.state.doc.content.size)),
  );
  const depth = nearestSectionDepth(view, cursor);
  if (depth > 0) {
    return direction === "after" ? $cursor.after(depth) : $cursor.before(depth);
  }
  if (view.state.doc.childCount !== 3) return null;
  const children = view.state.doc.child(2);
  if (children.type.name !== "sectionChildren") return null;
  const childrenPosition =
    view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize;
  return direction === "after"
    ? childrenPosition + 1 + children.content.size
    : childrenPosition + 1;
}

function putSection(
  view: VimEditorView,
  register: Extract<VimRegister, { kind: "section" }>,
  direction: PutDirection,
): boolean {
  const position = sectionPutPosition(view, direction);
  const copied = sectionSliceForPut(view, register);
  if (position === null || !copied) return false;
  try {
    const transaction = view.state.tr.replace(position, position, copied.slice);
    transaction.setMeta("memoka.section.reidentified", copied.reidentified);
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(position + 2, transaction.doc.content.size),
        ),
        1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function rangeAcceptsTableRows(
  view: VimEditorView,
  from: number,
  to: number,
): boolean {
  const maximum = view.state.doc.content.size;
  const $from = view.state.doc.resolve(Math.max(0, Math.min(from, maximum)));
  const $to = view.state.doc.resolve(Math.max(0, Math.min(to, maximum)));
  return $from.parent === $to.parent && $from.parent.type.name === "table";
}

function structureSliceForRange(
  view: VimEditorView,
  register: Extract<VimRegister, { kind: "structure" }>,
  from: number,
  to: number,
): Slice | null {
  const slice = copyStructureWithFreshBlockIds(register.slice);
  if (
    register.structureKind !== "table-row" ||
    rangeAcceptsTableRows(view, from, to)
  ) {
    return slice;
  }

  const tableType = view.state.schema.nodes.table;
  if (
    !tableType ||
    slice.openStart !== 0 ||
    slice.openEnd !== 0 ||
    slice.content.childCount === 0
  ) {
    return null;
  }
  let containsOnlyRows = true;
  slice.content.forEach((node) => {
    containsOnlyRows &&= node.type.name === "tableRow";
  });
  if (!containsOnlyRows) return null;

  try {
    const table = tableType.createChecked(
      { blockId: freshBlockId() },
      slice.content,
    );
    return new Slice(Fragment.fromArray([table]), 0, 0);
  } catch {
    return null;
  }
}

type BlockLinesRegister = Extract<VimRegister, { kind: "block-lines" }>;

function blockLineDetailPrefix(register: BlockLinesRegister): string {
  return behaviorDetailPrefix(register.behaviorId);
}

function hardBreakLineContent(
  view: Pick<VimEditorView, "state">,
  register: BlockLinesRegister,
): Fragment | null {
  if (
    blockSemantics.behaviorForNodeName(register.blockNodeName)?.logicalLines !==
    "split-hard-break-lines"
  ) {
    return null;
  }
  if (register.slice) return register.slice.content;
  const hardBreak =
    view.state.schema.nodes.hardBreak ?? view.state.schema.nodes.hard_break;
  if (!hardBreak) return null;
  const nodes: ProseMirrorNode[] = [];
  register.text.split("\n").forEach((part, index) => {
    if (index > 0) nodes.push(hardBreak.create());
    if (part) nodes.push(view.state.schema.text(part));
  });
  return Fragment.fromArray(nodes);
}

function selectionAcceptsBlockLines(
  view: VimEditorView,
  register: BlockLinesRegister,
): boolean {
  const { $from, $to } = view.state.selection;
  return (
    $from.parent === $to.parent &&
    blockSemantics.hasBehavior($from.parent.type.name, register.behaviorId)
  );
}

function pasteBlockLines(
  view: VimEditorView,
  register: BlockLinesRegister,
  from: number,
  to: number,
): boolean {
  try {
    const hardBreakContent = hardBreakLineContent(view, register);
    const transaction =
      register.slice || hardBreakContent
        ? view.state.tr.replaceWith(
            from,
            to,
            register.slice?.content ?? hardBreakContent ?? Fragment.empty,
          )
        : view.state.tr.insertText(register.text, from, to);
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(from, transaction.doc.content.size),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function pasteLineBlock(
  view: VimEditorView,
  register: BlockLinesRegister,
  from: number,
  to: number,
): boolean {
  const blockType = blockSemantics.nodeType(
    view.state.schema,
    register.behaviorId,
    register.blockNodeName,
  );
  if (!blockType) return false;
  try {
    const hardBreakContent = hardBreakLineContent(view, register);
    const content =
      register.slice || hardBreakContent
        ? (register.slice?.content ?? hardBreakContent ?? Fragment.empty)
        : register.text
          ? view.state.schema.text(register.text)
          : null;
    const source = blockType.create(register.blockAttrs, content);
    const block = copyNodeWithFreshBlockIds(source);
    const transaction = view.state.tr.replaceWith(from, to, block);
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(from + 1, transaction.doc.content.size),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function sectionBodyStartAfterHeader(
  view: VimEditorView,
  target: VimStructuralUnit,
): number | null {
  if (target.nodeName !== "sectionHeader") return null;
  const header = view.state.doc.nodeAt(target.blockPosition);
  if (!header || header.type.name !== "sectionHeader") return null;
  const bodyPosition = target.blockPosition + header.nodeSize;
  const body = view.state.doc.nodeAt(bodyPosition);
  if (body?.type.name !== "sectionBody") return null;
  return body.firstChild?.type.name === BODY_CHUNK_NODE
    ? bodyPosition + 2
    : bodyPosition + 1;
}

type VisualLineCommandHandler = (
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
  count: number,
  countExplicit: boolean,
) => EditorVimResult;

function yankVisualLine(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  const yanked = visualLineRegister(view, visualLine, true);
  const firstSelectedUnit =
    units[Math.min(visualLine.anchorUnit, visualLine.headUnit)];
  const afterYank = firstSelectedUnit
    ? { ...visualLine, cursor: firstSelectedUnit.cursorFrom }
    : visualLine;
  return {
    handled: yanked !== null,
    detail: "structure:yank",
    register: yanked ?? register ?? undefined,
    nextMode: "normal",
    // Like Vim's linewise Visual yank, return the caret to the first selected
    // logical row. Besides matching the visible operation, this keeps an
    // immediate p/P anchored at the outermost selected ListItem rather than
    // accidentally using a nested Visual head as the insertion depth.
    visualLine: afterYank,
  };
}

function unitDeletionRange(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  units: VimStructuralUnit[],
  preserveHardBreakLine = false,
): { from: number; to: number } | null {
  if (units.length === 0) return null;
  const range = visualLineRange(units, visualLine);
  const selectedUnits = units.slice(
    Math.min(visualLine.anchorUnit, visualLine.headUnit),
    Math.max(visualLine.anchorUnit, visualLine.headUnit) + 1,
  );
  let { from, to } = range;

  const firstUnit = selectedUnits[0];
  const lastUnit = selectedUnits.at(-1);
  const lineKind = firstUnit?.kind;
  if (
    firstUnit &&
    lastUnit &&
    (lineKind === "code-line" || lineKind === "hard-break-line") &&
    selectedUnits.every(
      ({ kind, blockPosition }) =>
        kind === lineKind && blockPosition === firstUnit.blockPosition,
    ) &&
    !(lineKind === "hard-break-line" && preserveHardBreakLine)
  ) {
    if (to < lastUnit.blockTo) to += 1;
    else if (from > firstUnit.blockFrom) from -= 1;
  }

  return { from, to };
}

function visualLineDeletionRange(
  view: VimEditorView,
  visualLine: VimVisualLineState,
): { from: number; to: number } | null {
  return unitDeletionRange(
    view,
    visualLine,
    blockSemantics.structuralUnits(view),
  );
}

function deleteLineUnits(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
  nextMode: "normal" | "insert",
  units: VimStructuralUnit[],
  yanked: VimRegister | null,
  expandDeletionToValidStructure = false,
): EditorVimResult {
  const firstUnit =
    units[Math.min(visualLine.anchorUnit, visualLine.headUnit)] ?? null;
  const preserveHardBreakLine =
    nextMode === "insert" && firstUnit?.kind === "hard-break-line";
  const range = unitDeletionRange(
    view,
    visualLine,
    units,
    preserveHardBreakLine,
  );
  const replacement =
    nextMode === "insert" && firstUnit && firstUnit.kind !== "hard-break-line"
      ? emptyStructureReplacement(view, firstUnit)
      : null;
  const emptyHardBreakChange =
    preserveHardBreakLine && range?.from === range?.to;
  if (!range || (range.from >= range.to && !emptyHardBreakChange)) {
    return {
      handled: false,
      detail: nextMode === "insert" ? "structure:change" : "structure:delete",
      register: register ?? undefined,
      nextMode: "normal",
    };
  }

  try {
    const transaction = replacement
      ? view.state.tr.replaceWith(range.from, range.to, replacement)
      : expandDeletionToValidStructure
        ? view.state.tr.deleteRange(range.from, range.to)
        : view.state.tr.delete(range.from, range.to);
    const cursor = Math.min(
      replacement ? range.from + 1 : range.from,
      transaction.doc.content.size,
    );
    transaction.setSelection(
      Selection.near(transaction.doc.resolve(cursor), 1),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: nextMode === "insert" ? "structure:change" : "structure:delete",
      register: yanked ?? register ?? undefined,
      nextMode,
    };
  } catch {
    return {
      handled: false,
      detail: nextMode === "insert" ? "structure:change" : "structure:delete",
      register: register ?? undefined,
      nextMode: "normal",
    };
  }
}

function deleteStructuralLine(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
  nextMode: "normal" | "insert",
): EditorVimResult {
  const units = blockSemantics.structuralUnits(view);
  return deleteLineUnits(
    view,
    visualLine,
    register,
    nextMode,
    units,
    registerForUnits(view, visualLine, units),
  );
}

function deleteVisualLine(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
  nextMode: "normal" | "insert",
  expandDeletionToValidStructure = false,
  includeSectionSubtree = false,
): EditorVimResult {
  if (includeSectionSubtree) {
    const target = sectionTitleTarget(view, visualLine);
    const yanked = sectionRegisterForVisualTitle(view, visualLine);
    if (target && yanked) {
      const transaction = view.state.tr;
      if (target.root) {
        const headerType = view.state.schema.nodes.sectionHeader;
        const bodyType = view.state.schema.nodes.sectionBody;
        const childrenType = view.state.schema.nodes.sectionChildren;
        if (!headerType || !bodyType || !childrenType) {
          return { handled: false, detail: "section:delete-root" };
        }
        transaction.replaceWith(
          0,
          transaction.doc.content.size,
          Fragment.fromArray([
            headerType.create(view.state.doc.child(0).attrs),
            bodyType.create(),
            childrenType.create(),
          ]),
        );
      } else {
        transaction.delete(target.from, target.to);
      }
      const cursor = target.root
        ? 0
        : Math.min(target.from, transaction.doc.content.size);
      transaction.setSelection(
        Selection.near(transaction.doc.resolve(cursor), -1),
      );
      view.dispatch(scrollWhenLayoutIsAvailable(transaction));
      view.focus();
      return {
        handled: true,
        detail: target.root ? "section:clear-root" : "section:delete-subtree",
        register: { ...yanked, transfer: "cut" },
        nextMode,
      };
    }
  }
  const units = blockSemantics.visualLineUnits(view);
  return deleteLineUnits(
    view,
    visualLine,
    register,
    nextMode,
    units,
    registerForUnits(view, visualLine, units),
    expandDeletionToValidStructure,
  );
}

function pasteVisualLine(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
): EditorVimResult {
  const units = blockSemantics.visualLineUnits(view);
  if (units.length === 0) {
    return {
      handled: false,
      detail: "structure:paste",
      nextMode: "normal",
      visualLine,
    };
  }

  const { from, to } = visualLineRange(units, visualLine);
  const selectedUnits = units.slice(
    Math.min(visualLine.anchorUnit, visualLine.headUnit),
    Math.max(visualLine.anchorUnit, visualLine.headUnit) + 1,
  );
  if (
    register?.kind === "block-lines" &&
    blockLineBehaviorId(selectedUnits) === register.behaviorId
  ) {
    return {
      handled: pasteBlockLines(view, register, from, to),
      detail: `${blockLineDetailPrefix(register)}-lines:paste`,
      nextMode: "normal",
      visualLine,
    };
  }
  if (register?.kind !== "structure") {
    return {
      handled: false,
      detail: "structure:paste",
      nextMode: "normal",
      visualLine,
    };
  }
  return {
    handled: pasteStructure(view, register, from, to),
    detail: "structure:paste",
    nextMode: "normal",
    visualLine,
  };
}

const visualLineCommandHandlers: Partial<
  Record<VimCommand, VisualLineCommandHandler>
> = {
  "cursor.left": (view, visualLine, _register, count) =>
    moveVisualLineCursor(view, visualLine, -1, count),
  "cursor.right": (view, visualLine, _register, count) =>
    moveVisualLineCursor(view, visualLine, 1, count),
  "cursor.logical-up": (view, visualLine, _register, count) =>
    moveVisualLineSelection(view, visualLine, -1, count),
  "cursor.display-up": (view, visualLine, _register, count) =>
    moveVisualLineSelection(view, visualLine, -1, count),
  "cursor.logical-down": (view, visualLine, _register, count) =>
    moveVisualLineSelection(view, visualLine, 1, count),
  "cursor.display-down": (view, visualLine, _register, count) =>
    moveVisualLineSelection(view, visualLine, 1, count),
  "cursor.document-start": (view, visualLine, _register, count) =>
    moveVisualLineToDocumentUnit(view, visualLine, "start", count, true),
  "cursor.document-end": (view, visualLine, _register, count, countExplicit) =>
    moveVisualLineToDocumentUnit(view, visualLine, "end", count, countExplicit),
  "cursor.page-up": (view, visualLine, _register, count) =>
    moveVisualLineViewport(view, visualLine, -1, "page", count),
  "cursor.page-down": (view, visualLine, _register, count) =>
    moveVisualLineViewport(view, visualLine, 1, "page", count),
  "cursor.half-page-up": (view, visualLine, _register, count) =>
    moveVisualLineViewport(view, visualLine, -1, "half-page", count),
  "cursor.half-page-down": (view, visualLine, _register, count) =>
    moveVisualLineViewport(view, visualLine, 1, "half-page", count),
  "selection.yank": yankVisualLine,
  "selection.delete": (view, visualLine, register) =>
    deleteVisualLine(view, visualLine, register, "normal", false, true),
  "selection.change": (view, visualLine, register) =>
    deleteVisualLine(view, visualLine, register, "insert"),
  "selection.paste": pasteVisualLine,
};

export function runVisualLineCommand(
  view: VimEditorView,
  command: VimCommand,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
  count = 1,
  countExplicit = false,
): EditorVimResult {
  const handler = visualLineCommandHandlers[command];
  return handler
    ? handler(view, visualLine, register, normalizedCount(count), countExplicit)
    : {
        handled: false,
        detail: `structure:unhandled:${command}`,
        visualLine,
      };
}

export function vimRegisterLabel(register: VimRegister | null): string {
  if (!register) return "(empty)";
  const text = register.text.replaceAll(/\s+/g, " ").trim() || "(empty)";
  if (register.kind === "text") return `text: ${text}`;
  if (register.kind === "block-lines") {
    const label =
      register.behaviorId === "code-block"
        ? "CodeLine"
        : register.behaviorId === "source-block"
          ? "SourceLine"
          : register.behaviorId === "paragraph"
            ? "ParagraphLine"
            : register.behaviorId === "section-title"
              ? "SectionTitle"
              : "BlockLine";
    return `${label}×${register.lineCount}: ${text}`;
  }
  if (register.kind === "section") {
    return `Section×${register.sectionIds.length}: ${text}`;
  }
  if (register.kind === "table-cells") {
    return `Table ${register.height}×${register.width}: ${text}`;
  }
  const kind =
    register.structureKind === "list-item"
      ? "ListItem"
      : register.structureKind === "table-row"
        ? "TableRow"
        : "block";
  return `${kind}: ${text}`;
}

function dispatchSelection(
  view: VimEditorView,
  position: number,
  mode: VimMode,
  semanticLines?: VimLogicalLine[],
  scrollIntoView = true,
  focus = true,
): void {
  const maximum = view.state.doc.content.size;
  const bounded = Math.max(0, Math.min(position, maximum));
  const lines =
    semanticLines ??
    (mode === "normal" || mode === "visual-char"
      ? blockSemantics.logicalLines(view)
      : []);
  const next =
    mode === "normal" || mode === "visual-char"
      ? clampCursorInLines(lines, bounded)
      : bounded;
  const line =
    mode === "normal"
      ? lines[blockSemantics.currentLineIndex(lines, next)]
      : null;
  const selection =
    mode === "normal" && line?.kind === "block-atom"
      ? NodeSelection.create(view.state.doc, line.blockPosition)
      : mode === "visual-char"
        ? visualCharSelection(
            view,
            lines,
            visualCharEndpoints(view, lines).anchor,
            next,
          )
        : TextSelection.create(view.state.doc, next);
  const transaction = view.state.tr.setSelection(selection);
  view.dispatch(
    scrollIntoView ? scrollWhenLayoutIsAvailable(transaction) : transaction,
  );
  if (focus) view.focus();
}

/**
 * Moves only the Vim selection/caret projection after a user-driven viewport
 * scroll. Unlike an ordinary motion this preserves the current mode and never
 * asks ProseMirror to scroll the previous caret back into view.
 */
export function moveVimSelectionToViewportPosition(
  view: VimEditorView,
  mode: VimMode,
  position: number,
  visualLine: VimVisualLineState | null,
): EditorVimResult {
  const maximum = view.state.doc.content.size;
  const bounded = Math.max(0, Math.min(position, maximum));
  const detail = "viewport:scroll-caret";
  if (mode === "visual-line") {
    if (!visualLine) return { handled: false, detail };
    const units = blockSemantics.visualLineUnits(view);
    if (units.length === 0) {
      return { handled: false, detail, visualLine };
    }
    const headUnit = blockSemantics.currentStructuralUnitIndex(units, bounded);
    const target = units[headUnit];
    if (!target) return { handled: false, detail, visualLine };
    const cursor = target.cursorPositions.reduce(
      (nearest, candidate) =>
        Math.abs(candidate - bounded) < Math.abs(nearest - bounded)
          ? candidate
          : nearest,
      target.cursorPositions[0] ?? target.cursorFrom,
    );
    if (headUnit === visualLine.headUnit && cursor === visualLine.cursor) {
      return { handled: false, detail, visualLine };
    }
    const next = { ...visualLine, headUnit, cursor };
    applyVisualLineSelection(view, next, false, false);
    return { handled: true, detail, visualLine: next };
  }

  const lines =
    mode === "normal" || mode === "visual-char"
      ? blockSemantics.logicalLines(view)
      : [];
  const next =
    mode === "normal" || mode === "visual-char"
      ? clampCursorInLines(lines, bounded)
      : bounded;
  const current =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  if (next === current) return { handled: false, detail };
  dispatchSelection(view, next, mode, lines, false, false);
  return { handled: true, detail };
}

function moveLogical(
  view: VimEditorView,
  direction: -1 | 1,
  mode: VimMode,
  semanticLines?: VimLogicalLine[],
  count = 1,
): boolean {
  if (mode === "normal") {
    const moved = moveNormalTableRow(view, direction, count);
    // Preserve the current Cell column while the target row remains inside
    // the Table. At the first/last row, continue through the shared logical
    // line model so k/j can leave the Table instead of becoming a boundary.
    if (moved === true) return true;
  }
  const lines = semanticLines ?? blockSemantics.logicalLines(view);
  if (lines.length === 0) return false;
  const head =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  const index = blockSemantics.currentLineIndex(lines, head);
  const targetIndex = Math.max(
    0,
    Math.min(index + direction * normalizedCount(count), lines.length - 1),
  );
  const target = lines[targetIndex];
  if (targetIndex === index) return false;
  if (!target) return false;
  if (mode === "normal" || mode === "visual-char") {
    const current = lines[index];
    const normalizedHead = blockSemantics.nearestCursorPosition(current, head);
    const column = Math.max(0, current.cursorPositions.indexOf(normalizedHead));
    const next =
      target.cursorPositions[
        Math.min(column, target.cursorPositions.length - 1)
      ] ?? target.from;
    dispatchSelection(view, next, mode, lines);
  } else {
    const column = Math.max(0, head - lines[index].from);
    const targetWidth = target.to - target.from;
    dispatchSelection(
      view,
      target.from + Math.min(column, targetWidth),
      mode,
      lines,
    );
  }
  return true;
}

function moveCharacter(
  view: VimEditorView,
  direction: -1 | 1,
  mode: VimMode,
  count = 1,
  whichwrap = true,
): boolean {
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) return false;
  const head =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  let lineIndex = blockSemantics.currentLineIndex(lines, head);
  let line = lines[lineIndex];
  if (!line) return false;
  let next: number;
  if (mode === "normal" || mode === "visual-char") {
    next = blockSemantics.nearestCursorPosition(line, head);
    let currentIndex = Math.max(0, line.cursorPositions.indexOf(next));
    let remaining = normalizedCount(count);
    while (remaining > 0) {
      const lineEndIndex = line.cursorPositions.length - 1;
      const distanceToBoundary =
        direction > 0 ? lineEndIndex - currentIndex : currentIndex;
      if (remaining <= distanceToBoundary) {
        currentIndex += direction * remaining;
        next = line.cursorPositions[currentIndex] ?? next;
        break;
      }
      if (distanceToBoundary > 0) {
        currentIndex = direction > 0 ? lineEndIndex : 0;
        next = line.cursorPositions[currentIndex] ?? next;
        remaining -= distanceToBoundary;
      }
      if (!whichwrap) break;
      const adjacentLine = lines[lineIndex + direction];
      if (!adjacentLine) break;
      lineIndex += direction;
      line = adjacentLine;
      currentIndex = direction > 0 ? 0 : line.cursorPositions.length - 1;
      next = line.cursorPositions[currentIndex] ?? line.from;
      remaining -= 1;
    }
  } else {
    const normalizedHead = Math.max(line.from, Math.min(head, line.to));
    next = normalizedHead;
    for (let index = 0; index < normalizedCount(count); index += 1) {
      const $next = view.state.doc.resolve(next);
      const adjacent = direction > 0 ? $next.nodeAfter : $next.nodeBefore;
      const distance =
        adjacent?.isInline && (adjacent.isAtom || adjacent.isLeaf)
          ? adjacent.nodeSize
          : 1;
      const candidate = Math.max(
        line.from,
        Math.min(next + direction * distance, line.to),
      );
      if (candidate === next) break;
      next =
        direction > 0 ? positionOutsideInlineEnd(view, candidate) : candidate;
    }
  }
  if (next === head) return false;
  dispatchSelection(view, next, mode, lines);
  return true;
}

function positionOutsideInlineEnd(
  view: VimEditorView,
  position: number,
): number {
  const maximum = view.state.doc.content.size;
  let current = Math.max(0, Math.min(position, maximum));
  while (current < maximum) {
    const $current = view.state.doc.resolve(current);
    let outside = current;
    for (let depth = $current.depth; depth > 0; depth -= 1) {
      const node = $current.node(depth);
      if (node.isInline && current === $current.end(depth)) {
        outside = $current.after(depth);
        break;
      }
    }
    if (outside === current) break;
    current = outside;
  }
  return current;
}

function currentLogicalLine(
  view: VimEditorView,
  cursor: number = selectionCursor(view),
  semanticLines: VimLogicalLine[] = blockSemantics.logicalLines(view),
) {
  if (semanticLines.length === 0) return null;
  return (
    semanticLines[blockSemantics.currentLineIndex(semanticLines, cursor)] ??
    null
  );
}

function characterAt(
  view: VimEditorView,
  positions: number[],
  index: number,
  lineTo: number,
): string {
  const from = positions[index];
  if (from === undefined) return "";
  const to = positions[index + 1] ?? lineTo;
  return (
    Array.from(
      view.state.doc.textBetween(from, Math.max(from + 1, to), "", "\uFFFC"),
    )[0] ?? ""
  );
}

function wordClasses(
  view: VimEditorView,
  positions: number[],
  lineTo: number,
): Array<string | null> {
  const characters = positions.map((_, index) =>
    characterAt(view, positions, index, lineTo),
  );
  const hardBoundaryBefore = positions.map(
    (position, index) =>
      index > 0 && position !== (positions[index - 1] ?? 0) + 1,
  );
  const segments = segmentVimWordCharacters(characters, hardBoundaryBefore);
  return segments.map((segment, index) => {
    const position = positions[index];
    if (position === undefined) return null;
    const nodeAfter = view.state.doc.resolve(position).nodeAfter;
    if (
      nodeAfter &&
      !nodeAfter.isText &&
      nodeAfter.isInline &&
      (nodeAfter.isAtom || nodeAfter.isLeaf)
    ) {
      return `inline-atom:${position}`;
    }
    if (segment !== null) return segment;
    const cell = tableCellAtPosition(view, positions[index]);
    // A structurally empty Cell still occupies one Vim word-motion stop. Its
    // fallback cursor has no character to classify, so give it a synthetic
    // class instead of treating it as skippable whitespace.
    return cell?.node.textContent.length === 0
      ? `empty-table-cell:${cell.from}`
      : null;
  });
}

function motionDestination(
  view: VimEditorView,
  command: VimCommand | "motion.table-cell-end",
  cursorPosition: number = selectionCursor(view),
  semanticLines: VimLogicalLine[] = blockSemantics.logicalLines(view),
): number | null {
  const line = currentLogicalLine(view, cursorPosition, semanticLines);
  if (!line) return null;
  const positions = line.cursorPositions;
  const cursor = blockSemantics.nearestCursorPosition(line, cursorPosition);
  const currentIndex = Math.max(0, positions.indexOf(cursor));
  const lastIndex = Math.max(0, positions.length - 1);
  const classes = wordClasses(view, positions, line.to);

  if (command === "motion.line-start") return positions[0] ?? line.from;
  if (command === "motion.line-end") {
    return positions[lastIndex] ?? line.from;
  }
  if (command === "motion.table-cell-end") {
    const cell = tableCellAtPosition(view, cursorPosition);
    const cellPositions = cell
      ? positions.filter(
          (position) => position >= cell.from && position < cell.to,
        )
      : [];
    return cellPositions.at(-1) ?? cursor;
  }
  if (command === "cursor.left") {
    return positions[Math.max(0, currentIndex - 1)] ?? cursor;
  }
  if (command === "cursor.right") {
    return positions[Math.min(lastIndex, currentIndex + 1)] ?? cursor;
  }

  if (command === "motion.word-backward") {
    let index = currentIndex - 1;
    while (index >= 0 && classes[index] === null) {
      index -= 1;
    }
    const targetClass = classes[index] ?? null;
    while (index > 0 && classes[index - 1] === targetClass) {
      index -= 1;
    }
    return positions[Math.max(0, index)] ?? cursor;
  }

  if (command === "motion.word-forward") {
    let index = currentIndex;
    const currentClass = classes[index] ?? null;
    if (currentClass !== null) {
      while (index < positions.length && classes[index] === currentClass) {
        index += 1;
      }
    } else {
      index += 1;
    }
    while (index < positions.length && classes[index] === null) {
      index += 1;
    }
    return positions[Math.min(lastIndex, index)] ?? cursor;
  }

  if (command === "motion.word-end") {
    let index = currentIndex;
    const currentClass = classes[index] ?? null;
    if (currentClass !== null) {
      while (index < lastIndex && classes[index + 1] === currentClass) {
        index += 1;
      }
      if (index > currentIndex) return positions[index] ?? cursor;
      if (index < lastIndex) index += 1;
    }
    while (index < lastIndex && classes[index] === null) {
      index += 1;
    }
    const targetClass = classes[index] ?? null;
    while (index < lastIndex && classes[index + 1] === targetClass) {
      index += 1;
    }
    return positions[index] ?? cursor;
  }

  return null;
}

function moveMotion(
  view: VimEditorView,
  command: VimCommand,
  mode: VimMode,
  count = 1,
): boolean {
  const lines = blockSemantics.logicalLines(view);
  const cursor =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  if (command === "motion.line-end" && normalizedCount(count) > 1) {
    const currentIndex = blockSemantics.currentLineIndex(lines, cursor);
    const target =
      lines[
        Math.min(currentIndex + normalizedCount(count) - 1, lines.length - 1)
      ];
    const destination =
      target?.cursorPositions.at(-1) ?? target?.from ?? cursor;
    if (destination === cursor) return false;
    dispatchSelection(view, destination, mode, lines);
    return true;
  }
  let destination = cursor;
  for (let index = 0; index < normalizedCount(count); index += 1) {
    const next = motionDestination(view, command, destination, lines);
    if (next === null || next === destination) break;
    destination = next;
  }
  if (destination === null || destination === cursor) {
    return false;
  }
  dispatchSelection(view, destination, mode, lines);
  return true;
}

function exclusiveCharacterPosition(
  view: Pick<VimEditorView, "state">,
  position: number,
): number {
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  const nodeAfter = view.state.doc.resolve(bounded).nodeAfter;
  if (nodeAfter?.isText) {
    return Math.min(
      bounded + (Array.from(nodeAfter.text ?? "")[0]?.length ?? 1),
      view.state.doc.content.size,
    );
  }
  if (nodeAfter?.isInline && (nodeAfter.isAtom || nodeAfter.isLeaf)) {
    return Math.min(bounded + nodeAfter.nodeSize, view.state.doc.content.size);
  }
  return Math.min(bounded + 1, view.state.doc.content.size);
}

function exclusivePositionAfter(
  view: Pick<VimEditorView, "state">,
  positions: number[],
  position: number,
  line: Pick<VimLogicalLine, "from" | "to">,
): number {
  if (line.from === line.to) return line.to;
  const index = positions.indexOf(position);
  const naturalEnd = exclusiveCharacterPosition(view, position);
  const next = index >= 0 ? positions[index + 1] : undefined;
  return next !== undefined && next <= naturalEnd ? next : naturalEnd;
}

function logicalLineExclusiveEnd(
  view: Pick<VimEditorView, "state">,
  line: VimLogicalLine,
): number {
  const last = line.cursorPositions.at(-1);
  return last === undefined
    ? line.to
    : exclusivePositionAfter(view, line.cursorPositions, last, line);
}

interface VimOperatorRange {
  from: number;
  to: number;
  cursor: number;
  structureRegister: VimRegister | null;
  changeReplacement: ProseMirrorNode | null;
}

interface VimMutationRange {
  from: number;
  to: number;
}

interface TableCellContext {
  node: ProseMirrorNode;
  from: number;
  to: number;
}

function tableCellAtPosition(
  view: Pick<VimEditorView, "state">,
  position: number = selectionCursor(view),
): TableCellContext | null {
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  const $position = view.state.doc.resolve(bounded);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      return {
        node,
        from: $position.start(depth),
        to: $position.end(depth),
      };
    }
  }
  return null;
}

function textblockContentRanges(
  node: ProseMirrorNode,
  contentStart: number,
  from: number,
  to: number,
): VimMutationRange[] {
  const ranges: VimMutationRange[] = [];
  node.descendants((descendant, offset) => {
    if (!descendant.isTextblock) return true;
    const descendantFrom = contentStart + offset + 1;
    const descendantTo = descendantFrom + descendant.content.size;
    const rangeFrom = Math.max(from, descendantFrom);
    const rangeTo = Math.min(to, descendantTo);
    if (rangeFrom < rangeTo) {
      ranges.push({ from: rangeFrom, to: rangeTo });
    }
    return false;
  });
  return ranges;
}

function tableRowContentRanges(
  view: VimEditorView,
  line: VimLogicalLine,
  from: number,
  to: number,
): VimMutationRange[] | null {
  if (!blockSemantics.hasBehavior(line.blockNodeName, "table-row")) {
    return null;
  }
  const row = view.state.doc.nodeAt(line.blockPosition);
  if (!row || !blockSemantics.hasBehavior(row.type.name, "table-row")) {
    return null;
  }

  return textblockContentRanges(row, line.blockPosition + 1, from, to);
}

function wordTextObjectRange(
  view: VimEditorView,
  motion: "text-object.inner-word" | "text-object.around-word",
  count = 1,
): VimOperatorRange | null {
  const line = currentLogicalLine(view);
  if (!line || line.cursorPositions.length === 0) return null;

  const positions = line.cursorPositions;
  const cursor = blockSemantics.nearestCursorPosition(
    line,
    selectionCursor(view),
  );
  let currentIndex = Math.max(0, positions.indexOf(cursor));
  const classes = wordClasses(view, positions, line.to);

  if (classes[currentIndex] === null) {
    let nextIndex = currentIndex;
    while (nextIndex < positions.length && classes[nextIndex] === null) {
      nextIndex += 1;
    }
    if (nextIndex < positions.length) {
      currentIndex = nextIndex;
    } else {
      let previousIndex = currentIndex;
      while (previousIndex >= 0 && classes[previousIndex] === null) {
        previousIndex -= 1;
      }
      if (previousIndex < 0) return null;
      currentIndex = previousIndex;
    }
  }

  const selectedClass = classes[currentIndex];
  if (selectedClass === null) return null;
  let startIndex = currentIndex;
  while (startIndex > 0 && classes[startIndex - 1] === selectedClass) {
    startIndex -= 1;
  }
  let endIndex = currentIndex;
  while (
    endIndex + 1 < positions.length &&
    classes[endIndex + 1] === selectedClass
  ) {
    endIndex += 1;
  }

  for (
    let repetition = 1;
    repetition < normalizedCount(count);
    repetition += 1
  ) {
    let nextIndex = endIndex + 1;
    let expected = exclusivePositionAfter(
      view,
      positions,
      positions[endIndex],
      line,
    );
    let crossesStructure = false;
    while (nextIndex < positions.length && classes[nextIndex] === null) {
      if (positions[nextIndex] !== expected) {
        crossesStructure = true;
        break;
      }
      expected = exclusiveCharacterPosition(view, positions[nextIndex]);
      nextIndex += 1;
    }
    if (
      crossesStructure ||
      nextIndex >= positions.length ||
      positions[nextIndex] !== expected
    ) {
      break;
    }
    const nextClass = classes[nextIndex];
    if (nextClass === null) break;
    endIndex = nextIndex;
    while (
      endIndex + 1 < positions.length &&
      classes[endIndex + 1] === nextClass
    ) {
      endIndex += 1;
    }
  }

  let fromIndex = startIndex;
  let to = exclusivePositionAfter(view, positions, positions[endIndex], line);
  if (motion === "text-object.around-word") {
    let trailingIndex = endIndex + 1;
    while (
      trailingIndex < positions.length &&
      classes[trailingIndex] === null
    ) {
      trailingIndex += 1;
    }
    if (trailingIndex > endIndex + 1) {
      to =
        trailingIndex < positions.length ? positions[trailingIndex] : line.to;
    } else {
      while (fromIndex > 0 && classes[fromIndex - 1] === null) {
        fromIndex -= 1;
      }
    }
  }

  const from = positions[fromIndex] ?? line.from;
  return from < to
    ? {
        from,
        to,
        cursor,
        structureRegister: null,
        changeReplacement: null,
      }
    : null;
}

function changeWordRange(view: VimEditorView): VimOperatorRange | null {
  const line = currentLogicalLine(view);
  if (!line || line.from === line.to || line.cursorPositions.length === 0) {
    return null;
  }
  const positions = line.cursorPositions;
  const cursor = blockSemantics.nearestCursorPosition(
    line,
    selectionCursor(view),
  );
  const currentIndex = positions.indexOf(cursor);
  if (currentIndex < 0) return null;
  const classes = wordClasses(view, positions, line.to);
  const currentClass = classes[currentIndex] ?? null;
  if (currentClass === null) return null;

  let endIndex = currentIndex;
  while (
    endIndex + 1 < positions.length &&
    classes[endIndex + 1] === currentClass
  ) {
    endIndex += 1;
  }
  let nextWordIndex = endIndex + 1;
  while (nextWordIndex < positions.length && classes[nextWordIndex] === null) {
    nextWordIndex += 1;
  }
  if (nextWordIndex < positions.length) {
    let expectedPosition = exclusiveCharacterPosition(
      view,
      positions[endIndex],
    );
    let crossesStructuralBoundary = false;
    for (let index = endIndex + 1; index <= nextWordIndex; index += 1) {
      const position = positions[index];
      if (position !== expectedPosition) {
        crossesStructuralBoundary = true;
        break;
      }
      expectedPosition = exclusiveCharacterPosition(view, position);
    }
    // Within one text segment, preserve the established cw/dw-style range
    // through the whitespace before the next word. The special range below
    // is only needed at end-of-line or before another structural segment.
    if (!crossesStructuralBoundary) return null;
  }
  const to = exclusivePositionAfter(view, positions, positions[endIndex], line);
  return cursor < to
    ? {
        from: cursor,
        to,
        cursor,
        structureRegister: null,
        changeReplacement: null,
      }
    : null;
}

function emptyStructureReplacement(
  view: VimEditorView,
  unit: VimStructuralUnit,
): ProseMirrorNode | null {
  if (unit.kind === "code-line") return null;
  const source = view.state.doc.nodeAt(unit.from);
  const paragraph = view.state.schema.nodes.paragraph;
  if (!source || !paragraph) return null;

  if (unit.kind === "list-item") {
    const firstBlock = source.firstChild;
    const emptyBlock = firstBlock?.isTextblock
      ? firstBlock.type.create(firstBlock.attrs)
      : paragraph.create({ blockId: createUuidV7() });
    try {
      return source.type.create(source.attrs, emptyBlock);
    } catch {
      return null;
    }
  }

  if (unit.kind === "table-row") {
    const cells: ProseMirrorNode[] = [];
    source.forEach((cell) => {
      const firstBlock = cell.firstChild;
      const emptyBlock = firstBlock?.isTextblock
        ? firstBlock.type.create(firstBlock.attrs)
        : paragraph.create({ blockId: createUuidV7() });
      cells.push(cell.type.create(cell.attrs, emptyBlock));
    });
    try {
      return source.type.create(
        source.attrs,
        cells.length > 0 ? Fragment.fromArray(cells) : null,
      );
    } catch {
      return null;
    }
  }

  if (source.isTextblock) {
    try {
      return source.type.create(source.attrs);
    } catch {
      return null;
    }
  }

  const blockId = source.attrs.blockId;
  return paragraph.create(
    typeof blockId === "string" && blockId ? { blockId } : undefined,
  );
}

function paragraphTextObjectRange(
  view: VimEditorView,
  motion: "text-object.inner-paragraph" | "text-object.around-paragraph",
  count = 1,
): VimOperatorRange | null {
  const units = blockSemantics.structuralUnits(view);
  if (units.length === 0) return null;
  const unitIndex = blockSemantics.currentStructuralUnitIndex(
    units,
    selectionCursor(view),
  );
  const unit = units[unitIndex];
  if (!unit) return null;

  const around = motion === "text-object.around-paragraph";
  if (!around && normalizedCount(count) > 1) return null;
  if (unit.kind === "table-row" && normalizedCount(count) > 1) return null;
  if (around && normalizedCount(count) > 1) {
    const visualLine = {
      anchorUnit: unitIndex,
      headUnit: Math.min(
        unitIndex + normalizedCount(count) - 1,
        units.length - 1,
      ),
      cursor: unit.cursorFrom,
    };
    const range = visualLineDeletionRange(view, visualLine);
    const firstUnit = units[unitIndex];
    if (!range || !firstUnit) return null;
    return {
      ...range,
      cursor: unit.cursorFrom,
      structureRegister: structureRegister(view, visualLine),
      changeReplacement: emptyStructureReplacement(view, firstUnit),
    };
  }
  let from = around ? unit.from : unit.textFrom;
  let to = around ? unit.to : unit.textTo;
  let register: VimRegister | null = null;

  if (around) {
    register = structureRegister(view, {
      anchorUnit: unitIndex,
      headUnit: unitIndex,
      cursor: unit.cursorFrom,
    });
    if (unit.kind === "code-line") {
      const line = currentLogicalLine(view);
      if (line?.kind === "code-line") {
        ({ from, to } = blockSemantics.deletionRange(view, line));
      }
    }
  }

  return from < to
    ? {
        from,
        to,
        cursor: unit.cursorFrom,
        structureRegister: register,
        changeReplacement: around
          ? emptyStructureReplacement(view, unit)
          : null,
      }
    : null;
}

function textObjectRange(
  view: VimEditorView,
  motion: VimCommand,
  count = 1,
): VimOperatorRange | null {
  if (
    motion === "text-object.inner-word" ||
    motion === "text-object.around-word"
  ) {
    return wordTextObjectRange(view, motion, count);
  }
  if (
    motion === "text-object.inner-paragraph" ||
    motion === "text-object.around-paragraph"
  ) {
    return paragraphTextObjectRange(view, motion, count);
  }
  return null;
}

function structuralMotionRange(
  view: VimEditorView,
  motion: VimCommand,
  count = 1,
): VimOperatorRange | null {
  if (motion !== "cursor.logical-up" && motion !== "cursor.logical-down") {
    return null;
  }
  const units = blockSemantics.structuralUnits(view);
  if (units.length === 0) return null;
  const currentIndex = blockSemantics.currentStructuralUnitIndex(
    units,
    selectionCursor(view),
  );
  if (units[currentIndex]?.kind === "table-row") return null;
  const targetIndex = Math.max(
    0,
    Math.min(
      currentIndex +
        (motion === "cursor.logical-up" ? -1 : 1) * normalizedCount(count),
      units.length - 1,
    ),
  );
  if (targetIndex === currentIndex) return null;
  const visualLine = {
    anchorUnit: currentIndex,
    headUnit: targetIndex,
    cursor: units[currentIndex]?.cursorFrom ?? selectionCursor(view),
  };
  const range = visualLineDeletionRange(view, visualLine);
  const firstUnit = units[Math.min(currentIndex, targetIndex)];
  if (!range || !firstUnit) return null;
  return {
    ...range,
    cursor: visualLine.cursor,
    structureRegister: structureRegister(view, visualLine),
    changeReplacement: emptyStructureReplacement(view, firstUnit),
  };
}

export function runEditorVimOperator(
  view: VimEditorView,
  operator: VimOperator,
  motion: VimCommand | "motion.table-cell-end",
  count = 1,
): EditorVimResult {
  const repetitions = normalizedCount(count);
  if (
    repetitions > 1 &&
    (motion === "motion.line-end" || motion === "motion.table-cell-end")
  ) {
    return {
      handled: false,
      detail: `operator:${operator}:${motion}`,
    };
  }
  const explicitRange =
    motion === "motion.table-cell-end"
      ? null
      : ((operator === "change" &&
        motion === "motion.word-forward" &&
        repetitions === 1
          ? changeWordRange(view)
          : null) ??
        textObjectRange(view, motion, repetitions) ??
        structuralMotionRange(view, motion, repetitions));
  let line = explicitRange ? null : currentLogicalLine(view);
  const cell = explicitRange ? null : tableCellAtPosition(view);
  if (
    line &&
    cell &&
    motion !== "cursor.logical-up" &&
    motion !== "cursor.logical-down"
  ) {
    const cursorPositions = line.cursorPositions.filter(
      (position) => position >= cell.from && position < cell.to,
    );
    if (cursorPositions.length > 0) {
      line = {
        ...line,
        from: cursorPositions[0] ?? line.from,
        to: cell.to,
        cursorPositions,
      };
    }
  }
  let destination = explicitRange ? null : selectionCursor(view);
  if (!explicitRange) {
    for (let index = 0; index < repetitions; index += 1) {
      const next = motionDestination(
        view,
        motion,
        destination as number,
        line ? [line] : undefined,
      );
      if (next === null || next === destination) break;
      destination = next;
    }
  }
  if (!explicitRange && (!line || destination === null)) {
    return {
      handled: false,
      detail: `operator:${operator}:${motion}`,
    };
  }

  let cursor: number;
  let from: number;
  let to: number;
  let register = explicitRange?.structureRegister ?? null;
  if (explicitRange) {
    ({ cursor, from, to } = explicitRange);
  } else {
    const activeLine = line as NonNullable<typeof line>;
    const activeDestination = destination as number;
    cursor = blockSemantics.nearestCursorPosition(
      activeLine,
      selectionCursor(view),
    );
    from = Math.min(cursor, activeDestination);
    to = Math.max(cursor, activeDestination);
    if (motion === "cursor.right" && activeDestination === cursor) {
      to = exclusivePositionAfter(
        view,
        activeLine.cursorPositions,
        cursor,
        activeLine,
      );
    } else if (
      motion === "motion.word-end" ||
      motion === "motion.line-end" ||
      motion === "motion.table-cell-end" ||
      (operator === "change" &&
        motion === "motion.word-forward" &&
        activeDestination === activeLine.cursorPositions.at(-1))
    ) {
      to = exclusivePositionAfter(
        view,
        activeLine.cursorPositions,
        activeDestination,
        activeLine,
      );
    }
    from = Math.max(activeLine.from, from);
    to = Math.min(logicalLineExclusiveEnd(view, activeLine), to);
  }
  if (from >= to) {
    return {
      handled: false,
      detail: `operator:${operator}:${motion}`,
    };
  }

  const text = view.state.doc.textBetween(from, to, "\n", "\uFFFC");
  register ??= text ? textRegisterForRange(view, from, to, text) : null;
  if (operator === "yank") {
    dispatchSelection(view, cursor, "normal");
    return {
      handled: true,
      detail: `operator:yank:${motion}`,
      register: register ?? undefined,
    };
  }

  let transaction: Transaction;
  const contentRanges = line
    ? tableRowContentRanges(view, line, from, to)
    : null;
  if (contentRanges && contentRanges.length === 0) {
    return {
      handled: false,
      detail: `operator:${operator}:${motion}`,
    };
  }
  try {
    if (contentRanges) {
      transaction = view.state.tr;
      for (const range of [...contentRanges].reverse()) {
        transaction.delete(range.from, range.to);
      }
    } else {
      transaction =
        operator === "change" && explicitRange?.changeReplacement
          ? view.state.tr.replaceWith(from, to, explicitRange.changeReplacement)
          : view.state.tr.delete(from, to);
    }
  } catch {
    return {
      handled: false,
      detail: `operator:${operator}:${motion}`,
    };
  }
  const selectionPosition = Math.min(
    operator === "change" && explicitRange?.changeReplacement ? from + 1 : from,
    transaction.doc.content.size,
  );
  transaction.setSelection(
    contentRanges
      ? TextSelection.create(transaction.doc, selectionPosition)
      : Selection.near(
          transaction.doc.resolve(selectionPosition),
          operator === "change" ? 1 : -1,
        ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: `operator:${operator}:${motion}`,
    register: register ?? undefined,
    nextMode: operator === "change" ? "insert" : undefined,
  };
}

function deleteCurrentCharacter(
  view: VimEditorView,
  count = 1,
): EditorVimResult {
  const line = currentLogicalLine(view);
  if (!line || line.kind === "block-atom" || line.from === line.to) {
    return { handled: false, detail: "character:delete" };
  }
  const from = blockSemantics.nearestCursorPosition(
    line,
    selectionCursor(view),
  );
  if (!line.cursorPositions.includes(from)) {
    return { handled: false, detail: "character:delete" };
  }
  const startIndex = line.cursorPositions.indexOf(from);
  let to = from;
  for (
    let index = startIndex;
    index < line.cursorPositions.length &&
    index < startIndex + normalizedCount(count);
    index += 1
  ) {
    const position = line.cursorPositions[index];
    if (position === undefined || (index > startIndex && position !== to)) {
      break;
    }
    to = exclusivePositionAfter(view, line.cursorPositions, position, line);
  }
  if (from >= to) {
    return { handled: false, detail: "character:delete" };
  }
  const text = view.state.doc.textBetween(from, to, "", "\uFFFC");
  const deletedRegister = text
    ? textRegisterForRange(view, from, to, text)
    : undefined;

  try {
    const transaction = view.state.tr.delete(from, to);
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(Math.min(from, transaction.doc.content.size)),
        -1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: "character:delete",
      register: deletedRegister,
    };
  } catch {
    return { handled: false, detail: "character:delete" };
  }
}

function displayedCharacterRect(view: VimEditorView, position: number) {
  const character = measureVimCharacterCell(view, position);
  if (character) {
    return {
      bottom: character.top + character.height,
      left: character.left,
      right: character.left + character.width,
      top: character.top,
    };
  }
  return view.coordsAtPos(position, 1);
}

interface MeasuredDisplayPosition {
  position: number;
  rect: VimCharacterCellRect;
  centerX: number;
  centerY: number;
}

function sameDisplayedRow(
  left: MeasuredDisplayPosition,
  right: MeasuredDisplayPosition,
): boolean {
  return (
    Math.abs(left.centerY - right.centerY) <
    Math.max(2, Math.min(left.rect.height, right.rect.height) / 2)
  );
}

function measuredDisplayPosition(
  view: VimEditorView,
  position: number,
  cache: Map<number, MeasuredDisplayPosition | null>,
  useResolvedGeometry: boolean,
): MeasuredDisplayPosition | null {
  const cached = cache.get(position);
  if (cached !== undefined) return cached;
  const rect = useResolvedGeometry
    ? measureVimCharacterCell(view, position)
    : measureVimCharacterRangeCell(view, position);
  const measured = rect
    ? {
        position,
        rect,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      }
    : null;
  cache.set(position, measured);
  return measured;
}

interface DisplayedRowBoundary {
  sameIndex: number;
  differentIndex: number | null;
}

function displayedRowBoundary(
  view: VimEditorView,
  positions: number[],
  seedIndex: number,
  direction: -1 | 1,
  seed: MeasuredDisplayPosition,
  cache: Map<number, MeasuredDisplayPosition | null>,
  useResolvedGeometry: boolean,
): DisplayedRowBoundary | null {
  let sameIndex = seedIndex;
  let step = 1;

  while (true) {
    const unboundedProbe = seedIndex + direction * step;
    const probeIndex = Math.max(
      0,
      Math.min(positions.length - 1, unboundedProbe),
    );
    if (probeIndex === sameIndex) {
      return {
        sameIndex,
        differentIndex: null,
      };
    }
    const probePosition = positions[probeIndex];
    if (probePosition === undefined) return null;
    const probe = measuredDisplayPosition(
      view,
      probePosition,
      cache,
      useResolvedGeometry,
    );
    if (!probe) return null;

    if (sameDisplayedRow(seed, probe)) {
      sameIndex = probeIndex;
      if (probeIndex === 0 || probeIndex === positions.length - 1) {
        return {
          sameIndex,
          differentIndex: null,
        };
      }
      step = Math.min(positions.length, step * 2);
      continue;
    }

    if (direction * (probe.centerY - seed.centerY) <= 0) return null;
    let differentIndex = probeIndex;
    while (Math.abs(differentIndex - sameIndex) > 1) {
      const middleIndex = Math.floor((differentIndex + sameIndex) / 2);
      const middlePosition = positions[middleIndex];
      if (middlePosition === undefined) return null;
      const middle = measuredDisplayPosition(
        view,
        middlePosition,
        cache,
        useResolvedGeometry,
      );
      if (!middle) return null;
      if (sameDisplayedRow(seed, middle)) {
        sameIndex = middleIndex;
      } else {
        differentIndex = middleIndex;
      }
    }
    return {
      sameIndex,
      differentIndex,
    };
  }
}

function closestPositionOnDisplayedRow(
  view: VimEditorView,
  positions: number[],
  firstIndex: number,
  lastIndex: number,
  sourceX: number,
  cache: Map<number, MeasuredDisplayPosition | null>,
  useResolvedGeometry: boolean,
): number | null {
  const firstPosition = positions[firstIndex];
  const lastPosition = positions[lastIndex];
  if (firstPosition === undefined || lastPosition === undefined) return null;
  const first = measuredDisplayPosition(
    view,
    firstPosition,
    cache,
    useResolvedGeometry,
  );
  const last = measuredDisplayPosition(
    view,
    lastPosition,
    cache,
    useResolvedGeometry,
  );
  if (!first || !last) return null;

  let best =
    Math.abs(first.centerX - sourceX) <= Math.abs(last.centerX - sourceX)
      ? first
      : last;
  let lowerIndex = firstIndex;
  let upperIndex = lastIndex;
  const ascending = last.centerX >= first.centerX;
  while (upperIndex - lowerIndex > 1) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    const middlePosition = positions[middleIndex];
    if (middlePosition === undefined) return null;
    const middle = measuredDisplayPosition(
      view,
      middlePosition,
      cache,
      useResolvedGeometry,
    );
    if (!middle) return null;
    if (Math.abs(middle.centerX - sourceX) < Math.abs(best.centerX - sourceX)) {
      best = middle;
    }
    const beforeTarget = ascending
      ? middle.centerX < sourceX
      : middle.centerX > sourceX;
    if (beforeTarget) {
      lowerIndex = middleIndex;
    } else {
      upperIndex = middleIndex;
    }
  }
  return best.position;
}

function displayedRangeDestination(
  view: VimEditorView,
  lines: VimLogicalLine[],
  head: number,
  direction: -1 | 1,
): number | null {
  const lineIndex = blockSemantics.currentLineIndex(lines, head);
  const line = lines[lineIndex];
  if (!line) return null;
  const cursor = blockSemantics.nearestCursorPosition(line, head);
  const cursorIndex = line.cursorPositions.indexOf(cursor);
  if (cursorIndex < 0) return null;
  const cache = new Map<number, MeasuredDisplayPosition | null>();
  const useResolvedGeometry = line.kind === "code-line";
  const source = measuredDisplayPosition(
    view,
    cursor,
    cache,
    useResolvedGeometry,
  );
  if (!source) return null;

  const sourceBoundary = displayedRowBoundary(
    view,
    line.cursorPositions,
    cursorIndex,
    direction,
    source,
    cache,
    useResolvedGeometry,
  );
  if (!sourceBoundary) return null;

  let targetLine = line;
  let targetSeedIndex = sourceBoundary.differentIndex;
  let targetUsesResolvedGeometry = useResolvedGeometry;
  if (targetSeedIndex === null) {
    const adjacentLine = lines[lineIndex + direction];
    if (!adjacentLine) return null;
    targetLine = adjacentLine;
    targetSeedIndex =
      direction < 0 ? adjacentLine.cursorPositions.length - 1 : 0;
    targetUsesResolvedGeometry = adjacentLine.kind === "code-line";
  }
  const targetSeedPosition = targetLine.cursorPositions[targetSeedIndex];
  if (targetSeedPosition === undefined) return null;
  const targetSeed = measuredDisplayPosition(
    view,
    targetSeedPosition,
    cache,
    targetUsesResolvedGeometry,
  );
  if (!targetSeed) return null;

  const targetExtent = displayedRowBoundary(
    view,
    targetLine.cursorPositions,
    targetSeedIndex,
    direction,
    targetSeed,
    cache,
    targetUsesResolvedGeometry,
  );
  if (!targetExtent) return null;
  const firstIndex = direction < 0 ? targetExtent.sameIndex : targetSeedIndex;
  const lastIndex = direction < 0 ? targetSeedIndex : targetExtent.sameIndex;
  return closestPositionOnDisplayedRow(
    view,
    targetLine.cursorPositions,
    firstIndex,
    lastIndex,
    source.centerX,
    cache,
    targetUsesResolvedGeometry,
  );
}

function moveDisplayedOnce(
  view: VimEditorView,
  direction: -1 | 1,
  mode: VimMode,
): boolean {
  const lines = blockSemantics.logicalLines(view);
  const selectionHead =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  const head =
    mode === "normal" || mode === "visual-char"
      ? clampCursorInLines(lines, selectionHead)
      : selectionHead;
  const rangeDestination = displayedRangeDestination(
    view,
    lines,
    head,
    direction,
  );
  if (rangeDestination !== null && rangeDestination !== head) {
    dispatchSelection(view, rangeDestination, mode, lines);
    return true;
  }
  try {
    // A Normal cursor sits on the character beginning at `head`. Measuring
    // that character's visible Range avoids the two valid caret coordinates
    // exposed by a collapsed DOM position at a wrap boundary.
    const rect = displayedCharacterRect(view, head);
    const characterHeight = Math.max(16, rect.bottom - rect.top);
    const sourceCenter = (rect.top + rect.bottom) / 2;
    const horizontalProbe = (rect.left + rect.right) / 2;
    for (const distance of [1, 1.25, 1.5, 2]) {
      const target = view.posAtCoords({
        left: horizontalProbe,
        top: sourceCenter + direction * characterHeight * distance,
      });
      if (!target) continue;
      const position =
        mode === "normal" || mode === "visual-char"
          ? clampCursorInLines(lines, target.pos)
          : target.pos;
      if (position === head) continue;
      dispatchSelection(view, position, mode, lines);
      return true;
    }
  } catch {
    // Headless DOMs have no layout. Their deterministic fallback is logical j/k.
  }
  return moveLogical(view, direction, mode, lines);
}

function moveDisplayed(
  view: VimEditorView,
  direction: -1 | 1,
  mode: VimMode,
  count = 1,
): boolean {
  let handled = false;
  for (let index = 0; index < normalizedCount(count); index += 1) {
    if (!moveDisplayedOnce(view, direction, mode)) break;
    handled = true;
  }
  return handled;
}

function lineStartPosition(line: VimLogicalLine): number {
  return line.cursorPositions[0] ?? line.from;
}

function moveToDocumentLine(
  view: VimEditorView,
  mode: VimMode,
  edge: "start" | "end",
  count: number,
  countExplicit: boolean,
): boolean {
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) return false;
  const targetIndex =
    edge === "end" && !countExplicit
      ? lines.length - 1
      : Math.min(normalizedCount(count) - 1, lines.length - 1);
  const target = lines[targetIndex];
  if (!target) return false;
  const destination = lineStartPosition(target);
  const cursor =
    mode === "visual-char"
      ? visualCharEndpoints(view, lines).cursor
      : selectionCursor(view);
  if (destination === cursor) return false;
  dispatchSelection(view, destination, mode, lines);
  return true;
}

function viewportScrollRoot(view: VimEditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>(".editor-scroll");
}

function viewportRectFor(
  scrollRoot: HTMLElement,
): Pick<DOMRect, "top" | "bottom" | "height"> | null {
  const rect = scrollRoot.getBoundingClientRect();
  if (rect.height <= 0) return null;
  return rect;
}

function fallbackViewportRows(kind: "page" | "half-page"): number {
  return kind === "page" ? 10 : 5;
}

interface ViewportStep {
  destination: number;
  scrolled: boolean;
}

function viewportStep(
  view: VimEditorView,
  lines: VimLogicalLine[],
  head: number,
  direction: -1 | 1,
  kind: "page" | "half-page",
): ViewportStep | null {
  const scrollRoot = viewportScrollRoot(view);
  if (!scrollRoot || scrollRoot.clientHeight <= 0) return null;
  let source: ReturnType<typeof displayedCharacterRect>;
  try {
    source = displayedCharacterRect(view, head);
  } catch {
    return null;
  }
  const rowHeight = Math.max(1, source.bottom - source.top);
  const pageDistance =
    kind === "page"
      ? Math.max(rowHeight, scrollRoot.clientHeight - rowHeight * 2)
      : Math.max(rowHeight, Math.floor(scrollRoot.clientHeight / 2));
  const maximumScrollTop = Math.max(
    0,
    scrollRoot.scrollHeight - scrollRoot.clientHeight,
  );
  const beforeScrollTop = scrollRoot.scrollTop;
  scrollRoot.scrollTop = Math.max(
    0,
    Math.min(maximumScrollTop, beforeScrollTop + direction * pageDistance),
  );
  const actualDistance = scrollRoot.scrollTop - beforeScrollTop;
  const viewport = viewportRectFor(scrollRoot);
  const sourceCenterY = (source.top + source.bottom) / 2;
  const sourceCenterX = (source.left + source.right) / 2;
  const probeY = viewport
    ? actualDistance === 0
      ? direction > 0
        ? viewport.bottom - rowHeight / 2
        : viewport.top + rowHeight / 2
      : Math.max(viewport.top + 1, Math.min(viewport.bottom - 1, sourceCenterY))
    : sourceCenterY;
  let destination: number | null = null;
  try {
    const target = view.posAtCoords({ left: sourceCenterX, top: probeY });
    if (target) destination = clampCursorInLines(lines, target.pos);
  } catch {
    // The deterministic display-row fallback below handles missing layout APIs.
  }

  if (destination === null || destination === head) {
    const displayRows = Math.max(
      1,
      Math.round(Math.abs(actualDistance) / rowHeight),
    );
    let fallback = head;
    for (let index = 0; index < displayRows; index += 1) {
      const next = displayedRangeDestination(view, lines, fallback, direction);
      if (next === null || next === fallback) break;
      fallback = next;
    }
    destination = fallback;
  }

  if (destination === head && actualDistance === 0) {
    const boundary = direction < 0 ? lines[0] : lines.at(-1);
    destination = boundary ? lineStartPosition(boundary) : head;
  }
  return { destination, scrolled: actualDistance !== 0 };
}

function moveViewport(
  view: VimEditorView,
  direction: -1 | 1,
  kind: "page" | "half-page",
  mode: VimMode,
  count = 1,
): boolean {
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) return false;

  let handled = false;
  for (let repeat = 0; repeat < normalizedCount(count); repeat += 1) {
    const selectionHead =
      mode === "visual-char"
        ? visualCharEndpoints(view, lines).cursor
        : selectionCursor(view);
    const head = clampCursorInLines(lines, selectionHead);
    const step = viewportStep(view, lines, head, direction, kind);
    if (!step) {
      return (
        moveLogical(
          view,
          direction,
          mode,
          lines,
          fallbackViewportRows(kind) * (normalizedCount(count) - repeat),
        ) || handled
      );
    }
    if (step.destination !== head) {
      dispatchSelection(view, step.destination, mode, lines, false);
      handled = true;
    }
    if (step.scrolled) handled = true;
    if (!step.scrolled && step.destination === head) break;
  }
  return handled;
}

function selectedText(view: VimEditorView): string {
  const { from, to } = view.state.selection;
  return view.state.doc.textBetween(from, to, "\n", "\uFFFC");
}

function textRegisterForRange(
  view: VimEditorView,
  from: number,
  to: number,
  text = view.state.doc.textBetween(from, to, "\n", "\uFFFC"),
): Extract<VimRegister, { kind: "text" }> {
  return {
    kind: "text",
    text,
    slice: view.state.doc.slice(from, to),
  };
}

function deleteSelection(
  view: VimEditorView,
  nextMode: VimMode,
): EditorVimResult {
  const { from, to } = view.state.selection;
  if (from === to) {
    return {
      handled: false,
      detail: "selection:delete",
      nextMode,
    };
  }
  const text = selectedText(view);
  const deletedRegister = text
    ? textRegisterForRange(view, from, to, text)
    : undefined;
  const transaction = view.state.tr.delete(from, to);
  transaction.setSelection(
    Selection.near(
      transaction.doc.resolve(Math.min(from, transaction.doc.content.size)),
      -1,
    ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: nextMode === "insert" ? "selection:change" : "selection:delete",
    register: deletedRegister,
    nextMode,
  };
}

function countedStructuralLine(
  view: VimEditorView,
  count: number,
): VimVisualLineState | null {
  const units = blockSemantics.structuralUnits(view);
  const visualLine = visualLineStateAtCursor(units, selectionCursor(view));
  if (!visualLine) return null;
  if (
    normalizedCount(count) > 1 &&
    units[visualLine.anchorUnit]?.kind === "table-row"
  ) {
    return null;
  }
  return {
    ...visualLine,
    headUnit: Math.min(
      visualLine.anchorUnit + normalizedCount(count) - 1,
      units.length - 1,
    ),
  };
}

function countedLogicalLine(
  view: VimEditorView,
  count: number,
): VimVisualLineState | null {
  const units = blockSemantics.visualLineUnits(view);
  const visualLine = visualLineStateAtCursor(units, selectionCursor(view));
  if (!visualLine) return null;
  return {
    ...visualLine,
    headUnit: Math.min(
      visualLine.anchorUnit + normalizedCount(count) - 1,
      units.length - 1,
    ),
  };
}

function yankLine(view: VimEditorView, count = 1): VimRegister | null {
  const visualLine = countedLogicalLine(view, count);
  if (!visualLine) return null;
  const yanked = visualLineRegister(view, visualLine);
  dispatchSelection(view, visualLine.cursor, "normal");
  return yanked;
}

function pmSectionIsSemanticallyEmpty(section: ProseMirrorNode): boolean {
  if (section.type.name !== "section" || section.childCount !== 3) return false;
  const body = section.child(1);
  const children = section.child(2);
  if (children.childCount > 0) return false;
  let empty = true;
  body.forEach((block) => {
    if (block.type.name !== "paragraph" || block.textContent.length > 0) {
      empty = false;
    }
  });
  return empty;
}

function deleteSectionTitleLine(
  view: VimEditorView,
  visualLine: VimVisualLineState,
  register: VimRegister | null,
): EditorVimResult | null {
  const target = sectionTitleTarget(view, visualLine);
  if (!target) return null;
  const headerPosition = target.root ? 0 : target.from + 1;
  const header = view.state.doc.nodeAt(headerPosition);
  if (!header || header.type.name !== "sectionHeader") return null;
  const transaction = view.state.tr;
  if (header.content.size > 0) {
    const text = header.textContent;
    const titleRegister = text
      ? textRegisterForRange(
          view,
          headerPosition + 1,
          headerPosition + 1 + header.content.size,
          text,
        )
      : undefined;
    transaction.delete(
      headerPosition + 1,
      headerPosition + 1 + header.content.size,
    );
    transaction.setSelection(
      TextSelection.create(transaction.doc, headerPosition + 1),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: "section:title-clear",
      register: titleRegister ?? register ?? undefined,
    };
  }
  if (target.root || !pmSectionIsSemanticallyEmpty(target.node)) {
    view.focus();
    return {
      handled: true,
      detail: target.root
        ? "section:root-title-already-empty"
        : "section:title-empty-content-kept",
      register: register ?? undefined,
    };
  }
  const yanked = sectionRegisterForVisualTitle(view, visualLine);
  transaction.delete(target.from, target.to);
  transaction.setSelection(
    Selection.near(
      transaction.doc.resolve(
        Math.min(target.from, transaction.doc.content.size),
      ),
      -1,
    ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    detail: "section:delete-empty-child",
    register: yanked ? { ...yanked, transfer: "cut" } : (register ?? undefined),
  };
}

function deleteLine(
  view: VimEditorView,
  register: VimRegister | null,
  count = 1,
): EditorVimResult {
  const visualLine = countedLogicalLine(view, count);
  if (visualLine && normalizedCount(count) === 1) {
    const sectionResult = deleteSectionTitleLine(view, visualLine, register);
    if (sectionResult) return sectionResult;
  }
  return visualLine
    ? deleteVisualLine(view, visualLine, register, "normal", true)
    : {
        handled: false,
        detail: "structure:delete",
        register: register ?? undefined,
      };
}

function clearLineForChange(view: VimEditorView): boolean {
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) return false;
  const line =
    lines[blockSemantics.currentLineIndex(lines, selectionCursor(view))];
  if (!line) return false;

  const behavior = blockSemantics.behaviorForNodeName(line.blockNodeName);
  if (
    line.kind === "block-atom" ||
    behavior?.structuralAncestor === "table-row"
  ) {
    const units = blockSemantics.structuralUnits(view);
    const unit =
      units[
        blockSemantics.currentStructuralUnitIndex(units, selectionCursor(view))
      ];
    if (!unit) return false;
    const replacement = emptyStructureReplacement(view, unit);
    if (!replacement) return false;
    const transaction = view.state.tr.replaceWith(
      unit.from,
      unit.to,
      replacement,
    );
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(unit.from + 1, transaction.doc.content.size),
        ),
        1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  }

  const transaction = view.state.tr;
  if (line.from < line.to) transaction.delete(line.from, line.to);
  transaction.setSelection(
    TextSelection.create(
      transaction.doc,
      Math.min(line.from, transaction.doc.content.size),
    ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return true;
}

function changeCurrentTableCell(view: VimEditorView): EditorVimResult | null {
  const cell = tableCellAtPosition(view);
  if (!cell) return null;

  const paragraph = view.state.schema.nodes.paragraph;
  const firstBlock = cell.node.firstChild;
  const emptyBlock = firstBlock?.isTextblock
    ? firstBlock.type.create(firstBlock.attrs)
    : paragraph?.create({ blockId: createUuidV7() });
  if (!emptyBlock) {
    return { handled: false, detail: "table-cell:change" };
  }
  const text = view.state.doc.textBetween(cell.from, cell.to, "\n", "\uFFFC");
  const cellRegister = text
    ? textRegisterForRange(view, cell.from, cell.to, text)
    : undefined;

  try {
    const transaction = view.state.tr.replaceWith(
      cell.from,
      cell.to,
      emptyBlock,
    );
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(cell.from + 1, transaction.doc.content.size),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: "table-cell:change",
      register: cellRegister,
      nextMode: "insert",
    };
  } catch {
    return { handled: false, detail: "table-cell:change" };
  }
}

function pasteText(
  view: VimEditorView,
  text: string,
  replaceSelection: boolean,
): boolean {
  if (!text) return false;
  const selection = view.state.selection;
  const from = replaceSelection ? selection.from : selection.to;
  const to = replaceSelection ? selection.to : selection.to;
  const transaction = view.state.tr.insertText(text, from, to);
  const cursor = from + text.length;
  transaction.setSelection(
    TextSelection.create(
      transaction.doc,
      Math.min(cursor, transaction.doc.content.size),
    ),
  );
  view.dispatch(scrollWhenLayoutIsAvailable(transaction));
  view.focus();
  return true;
}

export function pasteVimRegisterAtSelection(
  view: VimEditorView,
  register: VimRegister,
): boolean {
  if (register.kind === "table-cells") {
    if (pasteTableCellsIntoTable(view, register, "before")) return true;
    const table = tableFromCellsRegister(view, register);
    if (!table) return false;
    try {
      const { from, to } = view.state.selection;
      const transaction = view.state.tr.replaceRangeWith(from, to, table);
      transaction.setSelection(
        Selection.near(
          transaction.doc.resolve(
            Math.min(from + table.nodeSize, transaction.doc.content.size),
          ),
          -1,
        ),
      );
      view.dispatch(scrollWhenLayoutIsAvailable(transaction));
      view.focus();
      return true;
    } catch {
      return false;
    }
  }
  if (register.kind === "text") {
    if (register.slice) {
      return pasteTextSlice(
        view,
        register,
        view.state.selection.from,
        view.state.selection.to,
        false,
      );
    }
    return pasteText(view, register.text, true);
  }
  if (register.kind === "section") {
    return putSection(view, register, "after");
  }
  const { from, to } = view.state.selection;
  if (
    register.kind === "block-lines" &&
    selectionAcceptsBlockLines(view, register)
  ) {
    return pasteBlockLines(view, register, from, to);
  }
  if (register.kind === "structure" && register.structureKind === "table-row") {
    const units = blockSemantics.structuralUnits(view);
    if (units.length === 0) return false;
    const target =
      units[
        blockSemantics.currentStructuralUnitIndex(units, selectionCursor(view))
      ];
    if (target?.kind === "table-row") {
      return pasteStructure(view, register, target.to, target.to);
    }
  }

  try {
    const transaction = view.state.tr;
    let insertedSize: number;
    if (register.kind === "block-lines") {
      const blockType = blockSemantics.nodeType(
        view.state.schema,
        register.behaviorId,
        register.blockNodeName,
      );
      if (!blockType) return false;
      const hardBreakContent = hardBreakLineContent(view, register);
      const content =
        register.slice || hardBreakContent
          ? (register.slice?.content ?? hardBreakContent ?? Fragment.empty)
          : register.text
            ? view.state.schema.text(register.text)
            : null;
      const source = blockType.create(register.blockAttrs, content);
      const block = copyNodeWithFreshBlockIds(source);
      transaction.replaceSelectionWith(block);
      insertedSize = block.nodeSize;
    } else {
      const slice = structureSliceForRange(view, register, from, to);
      if (!slice) return false;
      transaction.replaceRange(from, to, slice);
      insertedSize = slice.size;
    }
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(from + insertedSize, transaction.doc.content.size),
        ),
        1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

type PutDirection = "after" | "before";

function textPutPosition(
  view: VimEditorView,
  cursor: number,
  direction: PutDirection,
): number {
  const normalized = clampVimBlockCursor(view, cursor);
  if (direction === "before") return normalized;
  const $cursor = view.state.doc.resolve(normalized);
  const nodeAfter = $cursor.nodeAfter;
  if (nodeAfter?.isText) {
    const firstCharacter = Array.from(nodeAfter.text ?? "")[0];
    return normalized + (firstCharacter?.length ?? 0);
  }
  if (nodeAfter?.isInline && (nodeAfter.isAtom || nodeAfter.isLeaf)) {
    return normalized + nodeAfter.nodeSize;
  }
  return normalized;
}

function pastedTextCursor(from: number, text: string): number {
  const lastCharacter = Array.from(text).at(-1);
  return from + text.length - (lastCharacter?.length ?? 1);
}

function pasteNormalText(
  view: VimEditorView,
  text: string,
  position: number,
): boolean {
  if (!text) return false;
  try {
    const transaction = view.state.tr.insertText(text, position, position);
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(
          pastedTextCursor(position, text),
          transaction.doc.content.size,
        ),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function pasteTextSlice(
  view: VimEditorView,
  register: Extract<VimRegister, { kind: "text" }>,
  from: number,
  to: number,
  normalCursor: boolean,
): boolean {
  if (!register.slice || register.slice.size === 0) return false;
  try {
    const beforeSize = view.state.doc.content.size;
    const transaction = view.state.tr.replaceRange(from, to, register.slice);
    const insertedSize = Math.max(
      0,
      transaction.doc.content.size - beforeSize + (to - from),
    );
    const end = Math.min(from + insertedSize, transaction.doc.content.size);
    transaction.setSelection(
      normalCursor
        ? Selection.near(transaction.doc.resolve(Math.max(from, end - 1)), -1)
        : Selection.near(transaction.doc.resolve(end), -1),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return true;
  } catch {
    return false;
  }
}

function putOnce(
  view: VimEditorView,
  register: VimRegister | null,
  direction: PutDirection,
): boolean {
  if (!register) return false;
  const cursor = selectionCursor(view);
  if (register.kind === "table-cells") {
    if (pasteTableCellsIntoTable(view, register, direction)) return true;
    const table = tableFromCellsRegister(view, register);
    if (!table) return false;
    const units = blockSemantics.structuralUnits(view);
    if (units.length === 0) return false;
    const target =
      units[blockSemantics.currentStructuralUnitIndex(units, cursor)];
    if (!target) return false;
    const insertionPosition =
      sectionBodyStartAfterHeader(view, target) ??
      (direction === "after" ? target.to : target.from);
    try {
      const transaction = view.state.tr.insert(insertionPosition, table);
      const map = TableMap.get(table);
      const cellPosition = insertionPosition + 1 + map.positionAt(0, 0, table);
      transaction.setSelection(
        Selection.near(transaction.doc.resolve(cellPosition + 2), 1),
      );
      view.dispatch(scrollWhenLayoutIsAvailable(transaction));
      view.focus();
      return true;
    } catch {
      return false;
    }
  }
  if (register.kind === "section") {
    return putSection(view, register, direction);
  }
  if (register.kind === "text") {
    if (register.slice) {
      return pasteTextSlice(
        view,
        register,
        textPutPosition(view, cursor, direction),
        textPutPosition(view, cursor, direction),
        true,
      );
    }
    return pasteNormalText(
      view,
      register.text,
      textPutPosition(view, cursor, direction),
    );
  }
  if (register.kind === "block-lines") {
    const lines = blockSemantics.logicalLines(view);
    if (lines.length === 0) return false;
    const line = lines[blockSemantics.currentLineIndex(lines, cursor)];
    if (
      line.kind === "code-line" &&
      blockSemantics.hasBehavior(line.blockNodeName, register.behaviorId)
    ) {
      try {
        const after = direction === "after";
        const position = after ? line.to : line.from;
        const text = after ? `\n${register.text}` : `${register.text}\n`;
        const transaction = view.state.tr.insertText(text, position);
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            after ? position + 1 : position,
          ),
        );
        view.dispatch(scrollWhenLayoutIsAvailable(transaction));
        view.focus();
        return true;
      } catch {
        return false;
      }
    }
    if (
      line.kind === "text-block" &&
      blockSemantics.hasBehavior(line.blockNodeName, register.behaviorId) &&
      blockSemantics.behaviorForNodeName(line.blockNodeName)?.logicalLines ===
        "split-hard-break-lines"
    ) {
      const hardBreak =
        view.state.schema.nodes.hardBreak ?? view.state.schema.nodes.hard_break;
      const content = hardBreakLineContent(view, register);
      if (!hardBreak || !content) return false;
      try {
        const nodes: ProseMirrorNode[] = [];
        content.forEach((node) => nodes.push(node));
        const after = direction === "after";
        const position = after ? line.to : line.from;
        const insertion = Fragment.fromArray(
          after
            ? [hardBreak.create(), ...nodes]
            : [...nodes, hardBreak.create()],
        );
        const transaction = view.state.tr.insert(position, insertion);
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            Math.min(
              after ? position + 1 : position,
              transaction.doc.content.size,
            ),
          ),
        );
        view.dispatch(scrollWhenLayoutIsAvailable(transaction));
        view.focus();
        return true;
      } catch {
        return false;
      }
    }
    const units = blockSemantics.structuralUnits(view);
    if (units.length === 0) return false;
    const target =
      units[blockSemantics.currentStructuralUnitIndex(units, cursor)];
    const $cursor = view.state.doc.resolve(
      Math.max(0, Math.min(cursor, view.state.doc.content.size)),
    );
    const insertionPosition =
      sectionBodyStartAfterHeader(view, target) ??
      ($cursor.depth > 0
        ? direction === "after"
          ? $cursor.after(1)
          : $cursor.before(1)
        : direction === "after"
          ? target.to
          : target.from);
    return pasteLineBlock(view, register, insertionPosition, insertionPosition);
  }
  const units = blockSemantics.structuralUnits(view);
  if (units.length === 0) return false;
  const index = blockSemantics.currentStructuralUnitIndex(units, cursor);
  const target = units[index];
  if (target.kind === "code-line") {
    const lines = blockSemantics.logicalLines(view);
    const line = lines[blockSemantics.currentLineIndex(lines, cursor)];
    const block = view.state.doc.nodeAt(line.blockPosition);
    if (line.kind === "code-line" && block) {
      const blockBoundary =
        direction === "after"
          ? line.blockPosition + block.nodeSize
          : line.blockPosition;
      return pasteStructure(view, register, blockBoundary, blockBoundary);
    }
  }
  const insertionPosition =
    sectionBodyStartAfterHeader(view, target) ??
    (direction === "after" ? target.to : target.from);
  return pasteStructure(view, register, insertionPosition, insertionPosition);
}

function put(
  view: VimEditorView,
  register: VimRegister | null,
  direction: PutDirection,
  count = 1,
): boolean {
  if (!register) return false;
  const repetitions = normalizedCount(count);
  if (register.kind === "text") {
    if (register.slice) {
      let handled = false;
      for (let index = 0; index < repetitions; index += 1) {
        if (!putOnce(view, register, direction)) break;
        handled = true;
      }
      return handled;
    }
    return pasteNormalText(
      view,
      register.text.repeat(repetitions),
      textPutPosition(view, selectionCursor(view), direction),
    );
  }

  let handled = false;
  for (let index = 0; index < repetitions; index += 1) {
    if (!putOnce(view, register, direction)) break;
    handled = true;
  }
  return handled;
}

function enterInsertAtLineBoundary(
  view: VimEditorView,
  boundary: "start" | "end",
): EditorVimResult {
  const line = currentLogicalLine(view);
  if (!line) {
    return {
      handled: false,
      detail: `insert:line-${boundary}`,
    };
  }

  if (line.kind === "block-atom") {
    const horizontalRule = runEditorEnterInsertFromHorizontalRule(
      view,
      boundary === "start" ? "before" : "after",
    );
    if (horizontalRule.handled) return horizontalRule;
    view.focus();
    return {
      handled: true,
      detail: `insert:line-${boundary}`,
      nextMode: "insert",
    };
  }

  const lineStart =
    motionDestination(view, "motion.line-start", selectionCursor(view), [
      line,
    ]) ?? line.from;
  const lineEnd =
    motionDestination(view, "motion.line-end", selectionCursor(view), [line]) ??
    line.cursorPositions.at(-1) ??
    line.from;
  const linePositions = line.cursorPositions.filter(
    (position) => position >= lineStart && position <= lineEnd,
  );
  const position =
    boundary === "start"
      ? (linePositions.find((_, index) => {
          const character = characterAt(view, linePositions, index, lineEnd);
          return character !== " " && character !== "\t";
        }) ?? lineStart)
      : textPutPosition(view, lineEnd, "after");
  try {
    const transaction = view.state.tr.setSelection(
      TextSelection.create(
        view.state.doc,
        Math.max(0, Math.min(position, view.state.doc.content.size)),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `insert:line-${boundary}`,
      nextMode: "insert",
    };
  } catch {
    return {
      handled: false,
      detail: `insert:line-${boundary}`,
    };
  }
}

function openCodeLogicalLine(
  view: VimEditorView,
  line: VimLogicalLine,
  direction: "above" | "below",
): EditorVimResult {
  const lineText = view.state.doc.textBetween(line.from, line.to, "", "");
  const indentation = lineText.match(/^[\t ]*/)?.[0] ?? "";
  const position = direction === "below" ? line.to : line.from;
  const inserted =
    direction === "below" ? `\n${indentation}` : `${indentation}\n`;
  const cursor =
    direction === "below"
      ? position + inserted.length
      : position + indentation.length;
  try {
    const transaction = view.state.tr.insertText(inserted, position);
    transaction.setSelection(TextSelection.create(transaction.doc, cursor));
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `line:open-${direction}`,
      nextMode: "insert",
    };
  } catch {
    return {
      handled: false,
      detail: `line:open-${direction}`,
    };
  }
}

function emptyOpenLineNode(
  view: VimEditorView,
  unit: VimStructuralUnit,
): ProseMirrorNode | null {
  const empty = emptyStructureReplacement(view, unit);
  return empty ? copyNodeWithFreshBlockIds(empty) : null;
}

function openFromSectionTitle(
  view: VimEditorView,
  direction: "above" | "below",
): EditorVimResult | null {
  const units = blockSemantics.visualLineUnits(view);
  const visualLine = visualLineStateAtCursor(units, selectionCursor(view));
  if (!visualLine) return null;
  const target = sectionTitleTarget(view, visualLine);
  if (!target) return null;
  const paragraphType = view.state.schema.nodes.paragraph;
  if (!paragraphType) return { handled: false, detail: "section:open" };
  try {
    const transaction = view.state.tr;
    let cursor: number;
    if (direction === "above" && !target.root) {
      const sectionType = view.state.schema.nodes.section;
      const headerType = view.state.schema.nodes.sectionHeader;
      const bodyType = view.state.schema.nodes.sectionBody;
      const childrenType = view.state.schema.nodes.sectionChildren;
      if (!sectionType || !headerType || !bodyType || !childrenType) {
        return { handled: false, detail: "section:open-above" };
      }
      const sibling = sectionType.create(null, [
        headerType.create({
          sectionId: createUuidV7(),
          emoji: null,
          tags: "[]",
        }),
        bodyType.create(),
        childrenType.create(),
      ]);
      transaction.insert(target.from, sibling);
      cursor = target.from + 2;
    } else {
      const headerPosition = target.root ? 0 : target.from + 1;
      const header = transaction.doc.nodeAt(headerPosition);
      if (!header) return { handled: false, detail: "section:open-below" };
      const bodyPosition = headerPosition + header.nodeSize;
      const body = transaction.doc.nodeAt(bodyPosition);
      const chunkType = view.state.schema.nodes[BODY_CHUNK_NODE];
      if (!body || body.type.name !== "sectionBody" || !chunkType) {
        return { handled: false, detail: "section:open-below" };
      }
      const paragraph = paragraphType.create({ blockId: freshBlockId() });
      if (body.firstChild?.type.name === BODY_CHUNK_NODE) {
        const insertionPosition = bodyPosition + 2;
        transaction.insert(insertionPosition, paragraph);
        cursor = insertionPosition + 1;
      } else {
        const insertionPosition = bodyPosition + 1;
        transaction.insert(
          insertionPosition,
          chunkType.create({ chunkId: createUuidV7() }, paragraph),
        );
        cursor = insertionPosition + 2;
      }
    }
    transaction.setSelection(TextSelection.create(transaction.doc, cursor));
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `section:open-${direction}`,
      nextMode: "insert",
    };
  } catch {
    return { handled: false, detail: `section:open-${direction}` };
  }
}

function openLogicalLine(
  view: VimEditorView,
  direction: "above" | "below",
): EditorVimResult {
  const sectionResult = openFromSectionTitle(view, direction);
  if (sectionResult) return sectionResult;
  const line = currentLogicalLine(view);
  if (!line) {
    return {
      handled: false,
      detail: `line:open-${direction}`,
    };
  }
  if (line.kind === "code-line") {
    return openCodeLogicalLine(view, line, direction);
  }

  const units = blockSemantics.structuralUnits(view);
  const unit =
    units[
      blockSemantics.currentStructuralUnitIndex(units, selectionCursor(view))
    ];
  if (!unit) {
    return {
      handled: false,
      detail: `line:open-${direction}`,
    };
  }
  const inserted = emptyOpenLineNode(view, unit);
  if (!inserted) {
    return {
      handled: false,
      detail: `line:open-${direction}`,
    };
  }

  const position = direction === "below" ? unit.to : unit.from;
  try {
    const transaction = view.state.tr.insert(position, inserted);
    transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(position + 1, transaction.doc.content.size),
        ),
        1,
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: `line:open-${direction}`,
      nextMode: "insert",
    };
  } catch {
    return {
      handled: false,
      detail: `line:open-${direction}`,
    };
  }
}

function lineText(view: VimEditorView, line: VimLogicalLine): string {
  return view.state.doc.textBetween(line.from, line.to, "", "\uFFFC");
}

function joinTextEdges(
  view: VimEditorView,
  line: VimLogicalLine,
  next: VimLogicalLine,
): {
  from: number;
  leadingLength: number;
  separator: string;
} {
  const currentText = lineText(view, line);
  const nextText = lineText(view, next);
  const trailingLength = currentText.match(/[\t ]+$/u)?.[0].length ?? 0;
  const leadingLength = nextText.match(/^[\t ]+/u)?.[0].length ?? 0;
  const left = currentText.slice(0, currentText.length - trailingLength);
  const right = nextText.slice(leadingLength);
  return {
    from: line.to - trailingLength,
    leadingLength,
    separator: normalizedJoinSeparator(left, right),
  };
}

function sectionIdentityAtPosition(
  document: ProseMirrorNode,
  position: number,
): string | null {
  const bounded = Math.max(0, Math.min(position, document.content.size));
  const $position = document.resolve(bounded);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name === "section") {
      return String(node.firstChild?.attrs.sectionId ?? "") || null;
    }
  }
  return document.firstChild?.type.name === "sectionHeader"
    ? String(document.firstChild.attrs.sectionId ?? "") || null
    : null;
}

function joinLogicalLineOnce(
  view: VimEditorView,
  raw: boolean,
): EditorVimResult {
  const lines = blockSemantics.logicalLines(view);
  if (lines.length === 0) {
    return { handled: false, detail: raw ? "line:join-raw" : "line:join" };
  }
  const index = blockSemantics.currentLineIndex(lines, selectionCursor(view));
  const line = lines[index];
  const next = lines[index + 1];
  if (!line || !next || line.kind === "block-atom") {
    return { handled: false, detail: raw ? "line:join-raw" : "line:join" };
  }
  if (
    sectionIdentityAtPosition(view.state.doc, line.from) !==
    sectionIdentityAtPosition(view.state.doc, next.from)
  ) {
    return {
      handled: false,
      detail: raw ? "section:join-boundary-raw" : "section:join-boundary",
    };
  }

  try {
    let transaction: Transaction;
    let cursor: number;
    if (
      line.blockPosition === next.blockPosition &&
      ((line.kind === "code-line" && next.kind === "code-line") ||
        (line.kind === "text-block" && next.kind === "text-block"))
    ) {
      if (raw) {
        transaction = view.state.tr.delete(line.to, next.from);
        cursor = line.cursorPositions.at(-1) ?? line.from;
      } else {
        const edges = joinTextEdges(view, line, next);
        transaction = view.state.tr.delete(
          edges.from,
          next.from + edges.leadingLength,
        );
        if (edges.separator) {
          transaction.insertText(edges.separator, edges.from);
        }
        cursor = edges.from;
      }
    } else {
      const currentNode = view.state.doc.nodeAt(line.blockPosition);
      const nextNode = view.state.doc.nodeAt(next.blockPosition);
      const boundary = next.blockPosition;
      const units = blockSemantics.structuralUnits(view);
      const unitIndex = blockSemantics.currentStructuralUnitIndex(
        units,
        selectionCursor(view),
      );
      const unit = units[unitIndex];
      const nextUnit = units[unitIndex + 1];
      if (
        unit?.kind === "list-item" &&
        nextUnit?.kind === "list-item" &&
        unit.to === nextUnit.from &&
        currentNode?.isTextblock &&
        nextNode?.isTextblock
      ) {
        const $currentItem = view.state.doc.resolve(unit.from);
        const $nextItem = view.state.doc.resolve(nextUnit.from);
        const currentItem = view.state.doc.nodeAt(unit.from);
        const nextItem = view.state.doc.nodeAt(nextUnit.from);
        const paragraphBoundary = line.blockPosition + currentNode.nodeSize;
        if (
          $currentItem.parent !== $nextItem.parent ||
          $currentItem.index() + 1 !== $nextItem.index() ||
          currentItem?.childCount !== 1 ||
          !nextItem?.firstChild?.isTextblock ||
          !canJoin(view.state.doc, nextUnit.from)
        ) {
          return {
            handled: false,
            detail: raw ? "line:join-raw" : "line:join",
          };
        }
        transaction = view.state.tr.join(nextUnit.from);
        if (!canJoin(transaction.doc, paragraphBoundary)) {
          return {
            handled: false,
            detail: raw ? "line:join-raw" : "line:join",
          };
        }
        transaction.join(paragraphBoundary);
        if (raw) {
          cursor = line.cursorPositions.at(-1) ?? line.from;
        } else {
          const edges = joinTextEdges(view, line, next);
          transaction.delete(edges.from, line.to + edges.leadingLength);
          if (edges.separator) {
            transaction.insertText(edges.separator, edges.from);
          }
          cursor = edges.from;
        }
      } else {
        if (
          !currentNode?.isTextblock ||
          !nextNode?.isTextblock ||
          line.blockPosition + currentNode.nodeSize !== boundary ||
          !canJoin(view.state.doc, boundary)
        ) {
          return {
            handled: false,
            detail: raw ? "line:join-raw" : "line:join",
          };
        }
        transaction = view.state.tr.join(boundary);
        if (raw) {
          cursor = line.cursorPositions.at(-1) ?? line.from;
        } else {
          const edges = joinTextEdges(view, line, next);
          transaction.delete(edges.from, line.to + edges.leadingLength);
          if (edges.separator) {
            transaction.insertText(edges.separator, edges.from);
          }
          cursor = edges.from;
        }
      }
    }
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.max(0, Math.min(cursor, transaction.doc.content.size)),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return { handled: true, detail: raw ? "line:join-raw" : "line:join" };
  } catch {
    return { handled: false, detail: raw ? "line:join-raw" : "line:join" };
  }
}

function joinLogicalLine(
  view: VimEditorView,
  raw: boolean,
  count = 1,
): EditorVimResult {
  const joinCount = Math.max(1, normalizedCount(count) - 1);
  let handled = false;
  for (let index = 0; index < joinCount; index += 1) {
    const result = joinLogicalLineOnce(view, raw);
    if (!result.handled) break;
    handled = true;
  }
  return {
    handled,
    detail: raw ? "line:join-raw" : "line:join",
  };
}

function replaceTextAtCursor(
  view: VimEditorView,
  text: string,
  cursorPlacement: "last" | "after",
  requireExistingCharacter: boolean,
): EditorVimResult {
  if (!text) return { handled: false, detail: "replace:text" };
  const line = currentLogicalLine(view);
  if (!line || line.kind === "block-atom") {
    return { handled: false, detail: "replace:text" };
  }
  const from = selectionCursor(view);
  const startIndex = line.cursorPositions.indexOf(from);
  if (requireExistingCharacter && (line.from === line.to || startIndex < 0)) {
    return { handled: false, detail: "replace:character" };
  }

  let to = from;
  let consumed = 0;
  const replacementLength = Array.from(text).length;
  if (startIndex >= 0 && line.from !== line.to) {
    for (
      let index = startIndex;
      index < line.cursorPositions.length && consumed < replacementLength;
      index += 1
    ) {
      const position = line.cursorPositions[index];
      if (position === undefined || (index > startIndex && position !== to)) {
        break;
      }
      to = exclusiveCharacterPosition(view, position);
      consumed += 1;
    }
  }
  if (
    requireExistingCharacter &&
    (consumed === 0 || consumed < replacementLength)
  ) {
    return { handled: false, detail: "replace:character" };
  }

  try {
    const transaction = view.state.tr.insertText(text, from, to);
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        Math.min(
          cursorPlacement === "after"
            ? from + text.length
            : pastedTextCursor(from, text),
          transaction.doc.content.size,
        ),
      ),
    );
    view.dispatch(scrollWhenLayoutIsAvailable(transaction));
    view.focus();
    return {
      handled: true,
      detail: requireExistingCharacter ? "replace:character" : "replace:text",
    };
  } catch {
    return {
      handled: false,
      detail: requireExistingCharacter ? "replace:character" : "replace:text",
    };
  }
}

export function runEditorReplaceCharacter(
  view: VimEditorView,
  character: string,
  count = 1,
): EditorVimResult {
  return replaceTextAtCursor(
    view,
    character.repeat(normalizedCount(count)),
    "last",
    true,
  );
}

export function runEditorReplaceText(
  view: VimEditorView,
  text: string,
): EditorVimResult {
  return replaceTextAtCursor(view, text, "after", false);
}

type EditorVimCommandHandler = (
  view: VimEditorView,
  mode: VimMode,
  register: VimRegister | null,
  count: number,
  countExplicit: boolean,
  keyConfig: ApplicationKeyConfig,
) => EditorVimResult;

const editorVimCommandHandlers: Partial<
  Record<VimCommand, EditorVimCommandHandler>
> = {
  "table.next_cell": (view, _mode, _register, count) =>
    moveNormalTableCell(view, 1, count),
  "table.previous_cell": (view, _mode, _register, count) =>
    moveNormalTableCell(view, -1, count),
  "insert.line-start": (view) => enterInsertAtLineBoundary(view, "start"),
  "insert.line-end": (view) => enterInsertAtLineBoundary(view, "end"),
  "insert.delete-line-prefix": (view) => runEditorInsertDeleteLinePrefix(view),
  "insert.delete-word-backward": (view) =>
    runEditorInsertDeleteWordBackward(view),
  "line.open-below": (view) => openLogicalLine(view, "below"),
  "line.open-above": (view) => openLogicalLine(view, "above"),
  "line.join": (view, _mode, _register, count) =>
    joinLogicalLine(view, false, count),
  "line.join-raw": (view, _mode, _register, count) =>
    joinLogicalLine(view, true, count),
  "character.delete": (view, _mode, _register, count) =>
    deleteCurrentCharacter(view, count),
  "cursor.left": (view, mode, _register, count, _countExplicit, keyConfig) => ({
    handled: moveCharacter(view, -1, mode, count, keyConfig.whichwrap ?? true),
    detail: "cursor:left",
  }),
  "cursor.right": (
    view,
    mode,
    _register,
    count,
    _countExplicit,
    keyConfig,
  ) => ({
    handled: moveCharacter(view, 1, mode, count, keyConfig.whichwrap ?? true),
    detail: "cursor:right",
  }),
  "cursor.logical-up": (view, mode, _register, count) => ({
    handled: moveLogical(view, -1, mode, undefined, count),
    detail: "cursor:logical-up",
  }),
  "cursor.logical-down": (view, mode, _register, count) => ({
    handled: moveLogical(view, 1, mode, undefined, count),
    detail: "cursor:logical-down",
  }),
  "cursor.display-up": (view, mode, _register, count) => ({
    handled: moveDisplayed(view, -1, mode, count),
    detail: "cursor:display-up",
  }),
  "cursor.display-down": (view, mode, _register, count) => ({
    handled: moveDisplayed(view, 1, mode, count),
    detail: "cursor:display-down",
  }),
  "cursor.page-up": (view, mode, _register, count) => ({
    handled: moveViewport(view, -1, "page", mode, count),
    detail: "cursor:page-up",
  }),
  "cursor.page-down": (view, mode, _register, count) => ({
    handled: moveViewport(view, 1, "page", mode, count),
    detail: "cursor:page-down",
  }),
  "cursor.half-page-up": (view, mode, _register, count) => ({
    handled: moveViewport(view, -1, "half-page", mode, count),
    detail: "cursor:half-page-up",
  }),
  "cursor.half-page-down": (view, mode, _register, count) => ({
    handled: moveViewport(view, 1, "half-page", mode, count),
    detail: "cursor:half-page-down",
  }),
  "cursor.document-start": (view, mode, _register, count) => ({
    handled: moveToDocumentLine(view, mode, "start", count, true),
    detail: "cursor:document-start",
  }),
  "cursor.document-end": (view, mode, _register, count, countExplicit) => ({
    handled: moveToDocumentLine(view, mode, "end", count, countExplicit),
    detail: "cursor:document-end",
  }),
  "motion.line-start": (view, mode, _register, count) => ({
    handled: moveMotion(view, "motion.line-start", mode, count),
    detail: "motion:line-start",
  }),
  "motion.line-end": (view, mode, _register, count) => ({
    handled: moveMotion(view, "motion.line-end", mode, count),
    detail: "motion:line-end",
  }),
  "motion.word-forward": (view, mode, _register, count) => ({
    handled: moveMotion(view, "motion.word-forward", mode, count),
    detail: "motion:word-forward",
  }),
  "motion.word-backward": (view, mode, _register, count) => ({
    handled: moveMotion(view, "motion.word-backward", mode, count),
    detail: "motion:word-backward",
  }),
  "motion.word-end": (view, mode, _register, count) => ({
    handled: moveMotion(view, "motion.word-end", mode, count),
    detail: "motion:word-end",
  }),
  "line.delete": (view, _mode, register, count) => {
    const result = deleteLine(view, register, count);
    return {
      ...result,
      detail: "line:delete",
      register: result.handled
        ? (result.register ?? register ?? undefined)
        : undefined,
    };
  },
  "line.yank": (view, _mode, register, count) => {
    const yanked = yankLine(view, count);
    return {
      handled: yanked !== null,
      detail: "line:yank",
      register: yanked ?? register ?? undefined,
    };
  },
  "line.change": (view, _mode, register, count) => {
    const cellResult = changeCurrentTableCell(view);
    if (cellResult) {
      return {
        ...cellResult,
        detail: "line:change",
        register: cellResult.handled
          ? (cellResult.register ?? register ?? undefined)
          : undefined,
      };
    }
    if (normalizedCount(count) > 1) {
      const visualLine = countedStructuralLine(view, count);
      const result = visualLine
        ? deleteStructuralLine(view, visualLine, register, "insert")
        : {
            handled: false,
            detail: "structure:change",
          };
      return {
        ...result,
        detail: "line:change",
      };
    }
    const yanked = yankLine(view);
    const handled = clearLineForChange(view);
    return {
      handled,
      detail: "line:change",
      register: handled ? (yanked ?? register ?? undefined) : undefined,
      nextMode: handled ? "insert" : undefined,
    };
  },
  "line.delete-to-end": (view, _mode, register, count) => {
    const result = runEditorVimOperator(
      view,
      "delete",
      tableCellAtPosition(view) ? "motion.table-cell-end" : "motion.line-end",
      count,
    );
    return {
      ...result,
      detail: "line:delete-to-end",
      register: result.handled
        ? (result.register ?? register ?? undefined)
        : undefined,
    };
  },
  "line.change-to-end": (view, _mode, register, count) => {
    const cell = tableCellAtPosition(view);
    const result = runEditorVimOperator(
      view,
      "change",
      cell ? "motion.table-cell-end" : "motion.line-end",
      count,
    );
    const enteredEmptyCell =
      cell !== null && !result.handled && cell.node.textContent.length === 0;
    return {
      ...result,
      detail: "line:change-to-end",
      handled: result.handled || enteredEmptyCell,
      nextMode: result.nextMode ?? (enteredEmptyCell ? "insert" : undefined),
      register:
        result.handled || enteredEmptyCell
          ? (result.register ?? register ?? undefined)
          : undefined,
    };
  },
  "selection.yank": (view, _mode, register) => {
    const yanked = selectedText(view);
    return {
      handled: view.state.selection.from !== view.state.selection.to,
      detail: "selection:yank",
      register: yanked
        ? textRegisterForRange(
            view,
            view.state.selection.from,
            view.state.selection.to,
            yanked,
          )
        : (register ?? undefined),
      nextMode: "normal",
    };
  },
  "selection.delete": (view) => deleteSelection(view, "normal"),
  "selection.change": (view) => deleteSelection(view, "insert"),
  "selection.paste": (view, _mode, register, count) => {
    const repetitions = normalizedCount(count);
    const handled =
      register?.kind === "text" && register.slice && repetitions === 1
        ? pasteVimRegisterAtSelection(view, register)
        : pasteText(view, (register?.text ?? "").repeat(repetitions), true);
    return {
      handled,
      detail: "selection:paste",
      nextMode: "normal",
    };
  },
  "put.after": (view, _mode, register, count) => {
    const handled = put(view, register, "after", count);
    return {
      handled,
      detail: "put:after",
      consumeRegister:
        handled && register?.kind === "section" && register.transfer === "cut",
    };
  },
  "put.before": (view, _mode, register, count) => {
    const handled = put(view, register, "before", count);
    return {
      handled,
      detail: "put:before",
      consumeRegister:
        handled && register?.kind === "section" && register.transfer === "cut",
    };
  },
};

export function runEditorVimCommand(
  view: VimEditorView,
  command: VimCommand,
  mode: VimMode,
  register: VimRegister | null,
  count = 1,
  countExplicit = false,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
): EditorVimResult {
  const handler = editorVimCommandHandlers[command];
  return handler
    ? handler(
        view,
        mode,
        register,
        normalizedCount(count),
        countExplicit,
        keyConfig,
      )
    : { handled: false, detail: `unhandled:${command}` };
}
