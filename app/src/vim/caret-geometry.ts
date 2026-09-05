import type { EditorView } from "@tiptap/pm/view";
import { NodeSelection } from "@tiptap/pm/state";
import { defaultVimBlockSemantics } from "./block-semantics";

export interface VimCaretGeometry {
  cursor: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VimCharacterCellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VimNextCharacterRect {
  advance: number;
  top: number;
  height: number;
}

type VimCaretView = Pick<EditorView, "state" | "coordsAtPos" | "domAtPos"> &
  Partial<Pick<EditorView, "nodeDOM">>;

interface VimCharacterRangeMeasurement {
  characterLength: number;
  rect: VimCharacterCellRect;
}

const INTERNAL_NOTE_LINK_NODE_NAMES = new Set([
  "internalSectionLink",
  "internal_note_link",
]);
const SELF_HIGHLIGHTED_BLOCK_NODE_NAMES = new Set(["attachment", "image"]);

function usesSelectedNodeFrameAsCaret(
  view: VimCaretView,
  position: number,
): boolean {
  const selection = view.state.selection;
  return (
    selection instanceof NodeSelection &&
    selection.from === position &&
    SELF_HIGHLIGHTED_BLOCK_NODE_NAMES.has(selection.node.type.name)
  );
}

function measureSelectedHorizontalRule(
  view: VimCaretView,
  position: number,
): VimCharacterCellRect | null {
  const selection = view.state.selection;
  if (
    !(selection instanceof NodeSelection) ||
    selection.from !== position ||
    selection.node.type.name !== "horizontalRule" ||
    typeof view.nodeDOM !== "function"
  ) {
    return null;
  }
  try {
    const dom = view.nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  } catch {
    return null;
  }
}

function measureInternalSectionLink(
  view: VimCaretView,
  position: number,
): VimCharacterCellRect | null {
  if (typeof view.nodeDOM !== "function") return null;
  const node = view.state.doc.resolve(position).nodeAfter;
  if (!node || !INTERNAL_NOTE_LINK_NODE_NAMES.has(node.type.name)) return null;

  try {
    const dom = view.nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  } catch {
    return null;
  }
}

export function isUsableVimBlockCaretWidth(
  value: number | null,
  lineHeight: number,
): value is number {
  const maximum = Math.max(8, lineHeight * 1.5);
  return (
    value !== null && Number.isFinite(value) && value >= 2 && value <= maximum
  );
}

export function resolveVimBlockCaretWidth(
  rangeWidth: number,
  lineHeight: number,
  nextCharacterAdvance: number | null,
): number {
  const minimum = 8;
  if (isUsableVimBlockCaretWidth(nextCharacterAdvance, lineHeight)) {
    return Math.max(minimum, nextCharacterAdvance);
  }
  if (isUsableVimBlockCaretWidth(rangeWidth, lineHeight)) {
    return Math.max(minimum, rangeWidth);
  }
  return Math.max(minimum, lineHeight * 0.55);
}

export function resolveVimCharacterCellRect(
  range: VimCharacterCellRect,
  nextCharacter: VimNextCharacterRect | null,
  useNextCharacterRow: boolean,
): VimCharacterCellRect {
  const measuredCharacter =
    nextCharacter !== null &&
    isUsableVimBlockCaretWidth(nextCharacter.advance, range.height)
      ? nextCharacter
      : null;
  const measuredRow =
    useNextCharacterRow &&
    measuredCharacter !== null &&
    measuredCharacter.height > 0
      ? measuredCharacter
      : null;

  return {
    left: range.left,
    top: measuredRow?.top ?? range.top,
    width: resolveVimBlockCaretWidth(
      range.width,
      range.height,
      nextCharacter?.advance ?? null,
    ),
    height: measuredRow
      ? Math.max(2, measuredRow.height)
      : Math.max(2, range.height),
  };
}

export function resolveVimCharacterRangeRect(
  bounding: VimCharacterCellRect,
  fragments: readonly VimCharacterCellRect[],
): VimCharacterCellRect {
  let visibleFragment: VimCharacterCellRect | null = null;
  for (const fragment of fragments) {
    if (
      Number.isFinite(fragment.left) &&
      Number.isFinite(fragment.top) &&
      Number.isFinite(fragment.width) &&
      Number.isFinite(fragment.height) &&
      fragment.width > 0 &&
      fragment.height > 0
    ) {
      visibleFragment = fragment;
    }
  }
  return visibleFragment ?? bounding;
}

function usesSplitTextLineGeometry(
  view: VimCaretView,
  position: number,
): boolean {
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  const $position = view.state.doc.resolve(bounded);
  for (let depth = $position.depth; depth >= 0; depth -= 1) {
    const node = $position.node(depth);
    if (!node.isTextblock) continue;
    return (
      defaultVimBlockSemantics.behaviorForNodeName(node.type.name)
        ?.logicalLines === "split-text-lines"
    );
  }
  return false;
}

function measureVimCharacterRange(
  view: VimCaretView,
  position: number,
): VimCharacterRangeMeasurement | null {
  try {
    const { node, offset } = view.domAtPos(position, 1);
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.nodeValue ?? "";
    if (offset >= text.length || text[offset] === "\n") return null;
    const characterLength =
      /[\uD800-\uDBFF]/u.test(text[offset]) &&
      /[\uDC00-\uDFFF]/u.test(text[offset + 1] ?? "")
        ? 2
        : 1;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + characterLength);
    const bounding = range.getBoundingClientRect();
    let fragments: VimCharacterCellRect[] = [];
    try {
      if (typeof range.getClientRects === "function") {
        fragments = Array.from(range.getClientRects(), (rect) => ({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }));
      }
    } catch {
      // A detached DOM can still provide a usable bounding rectangle.
    }
    // WebKitGTK exposes a wrapped first character as a zero-width rectangle
    // on the previous row plus its visible rectangle on the next row. The
    // union spans both rows, so prefer the final visible fragment.
    const rect = resolveVimCharacterRangeRect(
      {
        left: bounding.left,
        top: bounding.top,
        width: bounding.width,
        height: bounding.height,
      },
      fragments,
    );
    if (rect.height <= 0) return null;

    return {
      characterLength,
      rect,
    };
  } catch {
    return null;
  }
}

export function measureVimCharacterRangeCell(
  view: VimCaretView,
  position: number,
): VimCharacterCellRect | null {
  return measureVimCharacterRange(view, position)?.rect ?? null;
}

export function measureVimCharacterCell(
  view: VimCaretView,
  position: number,
): VimCharacterCellRect | null {
  const measurement = measureVimCharacterRange(view, position);
  if (!measurement) return null;
  const { characterLength, rect } = measurement;

  try {
    let nextCharacter: VimNextCharacterRect | null = null;
    try {
      const next = view.coordsAtPos(position + characterLength, 1);
      nextCharacter = {
        advance: next.left - rect.left,
        top: next.top,
        height: next.bottom - next.top,
      };
    } catch {
      // A stale or detached DOM falls back to the bounded Range.
    }

    // WebKitGTK can report a multiline Range for a character after a literal
    // newline in Code/Source Blocks. Only those semantics use the next
    // position's row; regular blocks keep the character Range row so a stale
    // coordsAtPos after j/k -> V cannot move the caret into the next block.
    return resolveVimCharacterCellRect(
      {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      nextCharacter,
      usesSplitTextLineGeometry(view, position),
    );
  } catch {
    return null;
  }
}

export function measureVimInsertCaretGeometry(
  view: VimCaretView,
  cursor: number,
): VimCaretGeometry | null {
  const position = Math.max(0, Math.min(cursor, view.state.doc.content.size));
  const currentCharacter = measureVimCharacterCell(view, position);
  if (currentCharacter) {
    return {
      cursor: position,
      left: currentCharacter.left,
      top: currentCharacter.top,
      width: 2,
      height: Math.max(2, currentCharacter.height),
    };
  }
  const previousCharacter =
    position > 0 ? measureVimCharacterCell(view, position - 1) : null;
  if (previousCharacter) {
    return {
      cursor: position,
      left: previousCharacter.left + previousCharacter.width,
      top: previousCharacter.top,
      width: 2,
      height: Math.max(2, previousCharacter.height),
    };
  }
  try {
    const rect = view.coordsAtPos(position, 1);
    return {
      cursor: position,
      left: rect.left,
      top: rect.top,
      width: 2,
      height: Math.max(2, rect.bottom - rect.top),
    };
  } catch {
    return null;
  }
}

export function measureVimBlockCaretGeometry(
  view: VimCaretView,
  cursor: number,
): VimCaretGeometry | null {
  const position = Math.max(0, Math.min(cursor, view.state.doc.content.size));
  // Image and Attachment NodeViews paint their own full-node selection frame.
  // coordsAtPos() reports their boundary as a zero-height rectangle in
  // WebKitGTK, which otherwise leaves a short text-caret line at the top-left.
  if (usesSelectedNodeFrameAsCaret(view, position)) return null;
  const selectedHorizontalRule = measureSelectedHorizontalRule(view, position);
  if (selectedHorizontalRule) {
    return { cursor: position, ...selectedHorizontalRule };
  }
  const internalSectionLink = measureInternalSectionLink(view, position);
  if (internalSectionLink) {
    return {
      cursor: position,
      left: internalSectionLink.left,
      top: internalSectionLink.top,
      width: internalSectionLink.width,
      height: internalSectionLink.height,
    };
  }
  const character = measureVimCharacterCell(view, position);
  if (character) {
    return {
      cursor: position,
      left: character.left,
      top: character.top,
      width: Math.max(8, character.width),
      height: Math.max(2, character.height),
    };
  }
  try {
    const rect = view.coordsAtPos(position, 1);
    const height = Math.max(2, rect.bottom - rect.top);
    let width = Math.max(8, height * 0.55);
    if (position < view.state.doc.content.size) {
      const next = view.coordsAtPos(position + 1, 1);
      const sameLine = Math.abs(next.top - rect.top) < Math.max(2, height / 2);
      const characterWidth = next.left - rect.left;
      if (sameLine && isUsableVimBlockCaretWidth(characterWidth, height)) {
        width = characterWidth;
      }
    }
    return {
      cursor: position,
      left: rect.left,
      top: rect.top,
      width,
      height,
    };
  } catch {
    return null;
  }
}
