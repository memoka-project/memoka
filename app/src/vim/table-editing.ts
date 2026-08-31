import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  cellAround,
  type Rect,
} from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createUuidV7 } from "../core/ids";
import {
  isTableRepeatableAction,
  type TableActionId,
  type TableActionRepeat,
} from "../core/table-actions";
import { defaultVimBlockSemantics } from "./block-semantics";
import type {
  EditorVimResult,
  VimEditorView,
  VimRegister,
  VimVisualLineState,
} from "./editor-commands";
import type { VimCommand, VimMode } from "./input";

export type TableAlignment = "left" | "center" | "right" | null;

export interface VimTableCellsRegister {
  readonly kind: "table-cells";
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly includesHeader: boolean;
  readonly alignments: readonly TableAlignment[];
  readonly slice: Slice;
}

export interface TableActionSelection {
  readonly tableBlockId: string;
  readonly tablePosition: number;
  readonly rowFrom: number;
  readonly rowTo: number;
  readonly columnFrom: number;
  readonly columnTo: number;
  readonly activeRow: number;
  readonly activeColumn: number;
  readonly beforeCursor: number;
  readonly mode: Extract<VimMode, "normal" | "visual-line" | "visual-block">;
  /** Used only by dot replay; picker actions derive the amount from the range. */
  readonly additionCount?: number;
}

export interface TableActionResult {
  readonly changed: boolean;
  readonly reason: "changed" | "boundary" | "missing" | "unsupported";
  readonly position: number;
  readonly repeat?: TableActionRepeat;
}

interface TableContext {
  readonly table: ProseMirrorNode;
  readonly tablePosition: number;
  readonly tableStart: number;
  readonly map: TableMap;
  readonly row: number;
  readonly column: number;
  readonly cellPosition: number;
  readonly cell: ProseMirrorNode;
}

interface MutableTable {
  readonly attrs: Record<string, unknown>;
  readonly rowAttrs: Array<Record<string, unknown>>;
  readonly rows: ProseMirrorNode[][];
}

const blockSemantics = defaultVimBlockSemantics;

function normalizedCount(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
}

function tableContextFromCell(
  view: Pick<VimEditorView, "state">,
  cellPosition: number,
): TableContext | null {
  const maximum = view.state.doc.content.size;
  const bounded = Math.max(0, Math.min(cellPosition, maximum));
  const $cell = view.state.doc.resolve(bounded);
  const role = $cell.nodeAfter?.type.spec.tableRole;
  if (role !== "cell" && role !== "header_cell") return null;
  const table = $cell.node(-1);
  if (table.type.spec.tableRole !== "table") return null;
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rectangle = map.findCell($cell.pos - tableStart);
  const cell = table.nodeAt($cell.pos - tableStart);
  if (!cell) return null;
  return {
    table,
    tablePosition: tableStart - 1,
    tableStart,
    map,
    row: rectangle.top,
    column: rectangle.left,
    cellPosition: $cell.pos,
    cell,
  };
}

export function tableContextAtPosition(
  view: Pick<VimEditorView, "state">,
  position: number = view.state.selection.head,
): TableContext | null {
  if (view.state.selection instanceof CellSelection) {
    return tableContextFromCell(view, view.state.selection.$headCell.pos);
  }
  const maximum = view.state.doc.content.size;
  const bounded = Math.max(0, Math.min(position, maximum));
  const $cell = cellAround(view.state.doc.resolve(bounded));
  return $cell ? tableContextFromCell(view, $cell.pos) : null;
}

function tableContextNearPosition(
  view: Pick<VimEditorView, "state">,
  position: number,
): TableContext | null {
  const direct = tableContextFromCell(view, position);
  if (direct) return direct;
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  const $cell = cellAround(view.state.doc.resolve(bounded));
  return $cell ? tableContextFromCell(view, $cell.pos) : null;
}

function cellPositionAt(
  tablePosition: number,
  table: ProseMirrorNode,
  map: TableMap,
  row: number,
  column: number,
): number {
  return tablePosition + 1 + map.positionAt(row, column, table);
}

function cellCursorPositions(
  _view: Pick<VimEditorView, "state">,
  cellPosition: number,
  cell: ProseMirrorNode,
): number[] {
  const positions: number[] = [];
  let fallback = cellPosition + 1;
  cell.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    const blockFrom = cellPosition + 2 + offset;
    if (positions.length === 0) fallback = blockFrom;
    const blockPositions: number[] = [];
    node.descendants((child, childOffset) => {
      if (child.type.name === "hardBreak") return false;
      if (child.isText) {
        for (let index = 0; index < child.nodeSize; index += 1) {
          blockPositions.push(blockFrom + childOffset + index);
        }
        return false;
      }
      if (child.isInline && (child.isAtom || child.isLeaf)) {
        blockPositions.push(blockFrom + childOffset);
        return false;
      }
      return true;
    });
    positions.push(
      ...(blockPositions.length > 0 ? blockPositions : [blockFrom]),
    );
    return false;
  });
  return [...new Set(positions.length > 0 ? positions : [fallback])];
}

function nearestPositionByIndex(
  source: readonly number[],
  target: readonly number[],
  cursor: number,
): number {
  const nearest = source.reduce(
    (best, candidate) =>
      Math.abs(candidate - cursor) < Math.abs(best - cursor) ? candidate : best,
    source[0] ?? cursor,
  );
  const index = Math.max(0, source.indexOf(nearest));
  return target[Math.min(index, target.length - 1)] ?? target[0] ?? cursor;
}

function setTextCursor(view: VimEditorView, position: number): void {
  const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, bounded))
      .scrollIntoView(),
  );
  view.focus();
}

export function moveNormalTableCharacter(
  view: VimEditorView,
  direction: -1 | 1,
  count: number,
): boolean | null {
  const context = tableContextAtPosition(view);
  if (!context) return null;
  const positions = cellCursorPositions(
    view,
    context.cellPosition,
    context.cell,
  );
  const cursor = view.state.selection.head;
  const nearest = positions.reduce(
    (best, candidate) =>
      Math.abs(candidate - cursor) < Math.abs(best - cursor) ? candidate : best,
    positions[0] ?? cursor,
  );
  const currentIndex = Math.max(0, positions.indexOf(nearest));
  const nextIndex = Math.max(
    0,
    Math.min(
      currentIndex + direction * normalizedCount(count),
      positions.length - 1,
    ),
  );
  const next = positions[nextIndex] ?? cursor;
  if (next === cursor) return false;
  setTextCursor(view, next);
  return true;
}

export function moveNormalTableRow(
  view: VimEditorView,
  direction: -1 | 1,
  count: number,
): boolean | null {
  const context = tableContextAtPosition(view);
  if (!context) return null;
  const row = context.row + direction * normalizedCount(count);
  // Let the shared logical-line motion handle a request that crosses a Table
  // edge. Clamping here would consume the Count at the first/last Table row
  // and make the adjacent block unreachable with j/k.
  if (row < 0 || row >= context.map.height) return false;
  const targetCellPosition = cellPositionAt(
    context.tablePosition,
    context.table,
    context.map,
    row,
    context.column,
  );
  const targetCell = view.state.doc.nodeAt(targetCellPosition);
  if (!targetCell) return false;
  const sourcePositions = cellCursorPositions(
    view,
    context.cellPosition,
    context.cell,
  );
  const targetPositions = cellCursorPositions(
    view,
    targetCellPosition,
    targetCell,
  );
  const next = nearestPositionByIndex(
    sourcePositions,
    targetPositions,
    view.state.selection.head,
  );
  setTextCursor(view, next);
  return true;
}

export function moveNormalTableCell(
  view: VimEditorView,
  direction: -1 | 1,
  count = 1,
): EditorVimResult {
  const context = tableContextAtPosition(view);
  if (!context) {
    view.focus();
    return { handled: false, detail: "table:cell-navigation" };
  }
  const current = context.row * context.map.width + context.column;
  const target = Math.max(
    0,
    Math.min(
      current + direction * normalizedCount(count),
      context.map.width * context.map.height - 1,
    ),
  );
  if (target === current) {
    view.focus();
    return {
      handled: false,
      detail: direction > 0 ? "table:next-cell" : "table:previous-cell",
    };
  }
  const row = Math.floor(target / context.map.width);
  const column = target % context.map.width;
  const targetCellPosition = cellPositionAt(
    context.tablePosition,
    context.table,
    context.map,
    row,
    column,
  );
  const targetCell = view.state.doc.nodeAt(targetCellPosition);
  if (!targetCell) {
    return { handled: false, detail: "table:cell-navigation" };
  }
  setTextCursor(
    view,
    cellCursorPositions(view, targetCellPosition, targetCell)[0] ??
      targetCellPosition + 2,
  );
  return {
    handled: true,
    detail: direction > 0 ? "table:next-cell" : "table:previous-cell",
  };
}

export function beginVisualBlock(view: VimEditorView): boolean {
  const context = tableContextAtPosition(view);
  if (!context || !mutableTable(context.table, context.map)) return false;
  const selection = CellSelection.create(
    view.state.doc,
    context.cellPosition,
    context.cellPosition,
  );
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  return true;
}

export function restoreVisualBlockSelection(
  view: VimEditorView,
  anchor: number,
  head: number,
): boolean {
  try {
    const anchorContext = tableContextNearPosition(view, anchor);
    const headContext = tableContextNearPosition(view, head);
    if (
      !anchorContext ||
      !headContext ||
      anchorContext.tablePosition !== headContext.tablePosition ||
      !mutableTable(anchorContext.table, anchorContext.map)
    ) {
      return false;
    }
    const selection = CellSelection.create(view.state.doc, anchor, head);
    view.dispatch(view.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

export function moveVisualBlockHeadToPosition(
  view: VimEditorView,
  position: number,
): EditorVimResult {
  const selection = view.state.selection;
  if (!(selection instanceof CellSelection)) {
    return { handled: false, detail: "table:visual-block:viewport-missing" };
  }
  const anchorContext = tableContextFromCell(view, selection.$anchorCell.pos);
  const targetContext = tableContextNearPosition(view, position);
  if (
    !anchorContext ||
    !targetContext ||
    anchorContext.tablePosition !== targetContext.tablePosition ||
    !mutableTable(anchorContext.table, anchorContext.map) ||
    targetContext.cellPosition === selection.$headCell.pos
  ) {
    return { handled: false, detail: "table:visual-block:viewport-boundary" };
  }
  view.dispatch(
    view.state.tr.setSelection(
      CellSelection.create(
        view.state.doc,
        selection.$anchorCell.pos,
        targetContext.cellPosition,
      ),
    ),
  );
  return { handled: true, detail: "viewport:scroll-caret" };
}

export function visualBlockCursor(view: Pick<VimEditorView, "state">): number {
  const selection = view.state.selection;
  if (!(selection instanceof CellSelection)) return selection.head;
  const context = tableContextFromCell(view, selection.$headCell.pos);
  if (!context) return selection.head;
  return (
    cellCursorPositions(view, context.cellPosition, context.cell)[0] ??
    context.cellPosition + 2
  );
}

export function visualBlockDimensions(
  view: Pick<VimEditorView, "state">,
): { width: number; height: number } | null {
  const selected = visualBlockRect(view);
  return selected
    ? {
        width: selected.rect.right - selected.rect.left,
        height: selected.rect.bottom - selected.rect.top,
      }
    : null;
}

export function selectVisualBlockRectangle(
  view: VimEditorView,
  width: number,
  height: number,
): boolean {
  const context = tableContextAtPosition(view);
  if (
    !context ||
    !mutableTable(context.table, context.map) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }
  const row = Math.min(
    context.row + Math.max(1, Math.floor(height)) - 1,
    context.map.height - 1,
  );
  const column = Math.min(
    context.column + Math.max(1, Math.floor(width)) - 1,
    context.map.width - 1,
  );
  const head = cellPositionAt(
    context.tablePosition,
    context.table,
    context.map,
    row,
    column,
  );
  view.dispatch(
    view.state.tr
      .setSelection(
        CellSelection.create(view.state.doc, context.cellPosition, head),
      )
      .scrollIntoView(),
  );
  view.focus();
  return true;
}

export function createVisualBlockDecorations(
  state: VimEditorView["state"],
): DecorationSet | null {
  if (!(state.selection instanceof CellSelection)) return null;
  const position = state.selection.$headCell.pos;
  const cell = state.doc.nodeAt(position);
  if (!cell) return null;
  return DecorationSet.create(state.doc, [
    Decoration.node(position, position + cell.nodeSize, {
      class: "memoka-visual-block-head",
      "data-vim-visual-block-head": "true",
    }),
  ]);
}

function visualBlockRect(view: Pick<VimEditorView, "state">): {
  readonly context: TableContext;
  readonly rect: Rect;
} | null {
  const selection = view.state.selection;
  if (!(selection instanceof CellSelection)) return null;
  const context = tableContextFromCell(view, selection.$headCell.pos);
  if (!context) return null;
  return {
    context,
    rect: context.map.rectBetween(
      selection.$anchorCell.pos - context.tableStart,
      selection.$headCell.pos - context.tableStart,
    ),
  };
}

function moveVisualBlock(
  view: VimEditorView,
  axis: "row" | "column",
  direction: -1 | 1,
  count: number,
): EditorVimResult {
  const current = visualBlockRect(view);
  const selection = view.state.selection;
  if (!current || !(selection instanceof CellSelection)) {
    return { handled: false, detail: "table:visual-block:missing" };
  }
  const { context } = current;
  const headRect = context.map.findCell(
    selection.$headCell.pos - context.tableStart,
  );
  const row =
    axis === "row"
      ? Math.max(
          0,
          Math.min(
            headRect.top + direction * normalizedCount(count),
            context.map.height - 1,
          ),
        )
      : headRect.top;
  const column =
    axis === "column"
      ? Math.max(
          0,
          Math.min(
            headRect.left + direction * normalizedCount(count),
            context.map.width - 1,
          ),
        )
      : headRect.left;
  const nextPosition = cellPositionAt(
    context.tablePosition,
    context.table,
    context.map,
    row,
    column,
  );
  if (nextPosition === selection.$headCell.pos) {
    return { handled: false, detail: "table:visual-block:boundary" };
  }
  view.dispatch(
    view.state.tr
      .setSelection(
        CellSelection.create(
          view.state.doc,
          selection.$anchorCell.pos,
          nextPosition,
        ),
      )
      .scrollIntoView(),
  );
  view.focus();
  return { handled: true, detail: "table:visual-block:move" };
}

function moveVisualBlockToEdge(
  view: VimEditorView,
  edge: "column-start" | "column-end" | "row-start" | "row-end",
): EditorVimResult {
  const current = visualBlockRect(view);
  const selection = view.state.selection;
  if (!current || !(selection instanceof CellSelection)) {
    return { handled: false, detail: "table:visual-block:missing" };
  }
  const { context } = current;
  const headRect = context.map.findCell(
    selection.$headCell.pos - context.tableStart,
  );
  const row =
    edge === "row-start"
      ? 0
      : edge === "row-end"
        ? context.map.height - 1
        : headRect.top;
  const column =
    edge === "column-start"
      ? 0
      : edge === "column-end"
        ? context.map.width - 1
        : headRect.left;
  const nextPosition = cellPositionAt(
    context.tablePosition,
    context.table,
    context.map,
    row,
    column,
  );
  if (nextPosition === selection.$headCell.pos) {
    return { handled: false, detail: "table:visual-block:boundary" };
  }
  view.dispatch(
    view.state.tr
      .setSelection(
        CellSelection.create(
          view.state.doc,
          selection.$anchorCell.pos,
          nextPosition,
        ),
      )
      .scrollIntoView(),
  );
  view.focus();
  return { handled: true, detail: "table:visual-block:edge" };
}

function selectedCellNodes(view: Pick<VimEditorView, "state">): {
  readonly context: TableContext;
  readonly rect: Rect;
  readonly rows: ProseMirrorNode[][];
} | null {
  const selected = visualBlockRect(view);
  if (!selected) return null;
  const { context, rect } = selected;
  const rows: ProseMirrorNode[][] = [];
  for (let row = rect.top; row < rect.bottom; row += 1) {
    const cells: ProseMirrorNode[] = [];
    for (let column = rect.left; column < rect.right; column += 1) {
      const relative = context.map.map[row * context.map.width + column];
      const cell = context.table.nodeAt(relative);
      if (!cell || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) {
        return null;
      }
      cells.push(cell);
    }
    rows.push(cells);
  }
  return { context, rect, rows };
}

function alignmentForColumn(
  table: ProseMirrorNode,
  map: TableMap,
  column: number,
): TableAlignment {
  for (let row = 0; row < map.height; row += 1) {
    const cell = table.nodeAt(map.map[row * map.width + column]);
    const align = cell?.attrs.align;
    if (align === "left" || align === "center" || align === "right") {
      return align;
    }
  }
  return null;
}

export function captureVisualBlockRegister(
  view: VimEditorView,
): VimTableCellsRegister | null {
  const selected = selectedCellNodes(view);
  if (!selected) return null;
  const { context, rect, rows } = selected;
  const rowType = view.state.schema.nodes.tableRow;
  if (!rowType) return null;
  const rowNodes = rows.map((cells, index) =>
    rowType.create(
      {
        ...(context.table.child(rect.top + index)?.attrs ?? {}),
      },
      Fragment.fromArray(cells),
    ),
  );
  const includesHeader =
    rect.top === 0 &&
    rows[0]?.every((cell) => cell.type.name === "tableHeader") === true;
  return {
    kind: "table-cells",
    text: rows
      .map((cells) => cells.map((cell) => cell.textContent).join("\t"))
      .join("\n"),
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    includesHeader,
    alignments: Array.from({ length: rect.right - rect.left }, (_, index) =>
      alignmentForColumn(context.table, context.map, rect.left + index),
    ),
    slice: new Slice(Fragment.fromArray(rowNodes), 0, 0),
  };
}

function emptyParagraph(
  view: Pick<VimEditorView, "state">,
): ProseMirrorNode | null {
  return (
    view.state.schema.nodes.paragraph?.create({ blockId: createUuidV7() }) ??
    null
  );
}

function clearCellContent(
  view: VimEditorView,
  positions: readonly number[],
  cursorPosition: number,
): boolean {
  const paragraphType = view.state.schema.nodes.paragraph;
  if (!paragraphType) return false;
  const transaction = view.state.tr;
  for (const position of [...positions].sort((left, right) => right - left)) {
    const cell = transaction.doc.nodeAt(position);
    if (!cell) return false;
    transaction.replaceWith(
      position + 1,
      position + cell.nodeSize - 1,
      paragraphType.create({ blockId: createUuidV7() }),
    );
  }
  const mappedCursor = transaction.mapping.map(cursorPosition, 1);
  transaction.setSelection(
    TextSelection.create(
      transaction.doc,
      Math.max(0, Math.min(mappedCursor + 2, transaction.doc.content.size)),
    ),
  );
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return true;
}

function clearVisualBlock(
  view: VimEditorView,
  nextMode: "normal" | "insert",
): EditorVimResult {
  const selected = selectedCellNodes(view);
  if (!selected) {
    return { handled: false, detail: "table:visual-block:clear" };
  }
  const register = captureVisualBlockRegister(view) ?? undefined;
  const positions: number[] = [];
  for (let row = selected.rect.top; row < selected.rect.bottom; row += 1) {
    for (
      let column = selected.rect.left;
      column < selected.rect.right;
      column += 1
    ) {
      positions.push(
        selected.context.tableStart +
          selected.context.map.map[row * selected.context.map.width + column],
      );
    }
  }
  const topLeft = Math.min(...positions);
  return {
    handled: clearCellContent(view, [...new Set(positions)], topLeft),
    detail: "table:visual-block:clear",
    register,
    nextMode,
  };
}

function copyNodeWithFreshBlockIds(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node;
  const attrs = { ...node.attrs };
  if (typeof attrs.blockId === "string") attrs.blockId = createUuidV7();
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(copyNodeWithFreshBlockIds(child)));
  return node.type.create(
    attrs,
    children.length > 0 ? Fragment.fromArray(children) : null,
    node.marks,
  );
}

function registerRows(
  register: VimTableCellsRegister,
): ProseMirrorNode[][] | null {
  if (
    register.width <= 0 ||
    register.height <= 0 ||
    register.slice.openStart !== 0 ||
    register.slice.openEnd !== 0 ||
    register.slice.content.childCount !== register.height
  ) {
    return null;
  }
  const rows: ProseMirrorNode[][] = [];
  register.slice.content.forEach((row) => {
    if (row.type.name !== "tableRow" || row.childCount !== register.width) {
      return;
    }
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => {
      if (
        (cell.type.name !== "tableCell" && cell.type.name !== "tableHeader") ||
        cell.attrs.colspan !== 1 ||
        cell.attrs.rowspan !== 1
      ) {
        return;
      }
      cells.push(cell);
    });
    if (cells.length !== register.width) return;
    rows.push(cells);
  });
  return rows.length === register.height ? rows : null;
}

function mutableTable(
  table: ProseMirrorNode,
  map: TableMap,
): MutableTable | null {
  const rows: ProseMirrorNode[][] = [];
  const rowAttrs: Array<Record<string, unknown>> = [];
  for (let row = 0; row < map.height; row += 1) {
    const rowNode = table.child(row);
    if (!rowNode || rowNode.type.name !== "tableRow") return null;
    const cells: ProseMirrorNode[] = [];
    for (let column = 0; column < map.width; column += 1) {
      const relative = map.map[row * map.width + column];
      const cell = table.nodeAt(relative);
      if (
        !cell ||
        cell.attrs.colspan !== 1 ||
        cell.attrs.rowspan !== 1 ||
        cells.includes(cell)
      ) {
        return null;
      }
      cells.push(cell);
    }
    if (cells.length !== map.width) return null;
    rows.push(cells);
    rowAttrs.push({ ...rowNode.attrs });
  }
  return { attrs: { ...table.attrs }, rowAttrs, rows };
}

function blankCell(
  view: Pick<VimEditorView, "state">,
  header: boolean,
  align: TableAlignment = null,
): ProseMirrorNode | null {
  const type = view.state.schema.nodes[header ? "tableHeader" : "tableCell"];
  const paragraph = emptyParagraph(view);
  if (!type || !paragraph) return null;
  return type.create(
    {
      blockId: createUuidV7(),
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      align,
    },
    paragraph,
  );
}

function normalizedCell(
  view: Pick<VimEditorView, "state">,
  cell: ProseMirrorNode,
  header: boolean,
  content?: Fragment,
  preserveIdentity = true,
): ProseMirrorNode | null {
  const type = view.state.schema.nodes[header ? "tableHeader" : "tableCell"];
  if (!type) return null;
  const attrs = {
    ...cell.attrs,
    blockId: preserveIdentity ? cell.attrs.blockId : createUuidV7(),
    colspan: 1,
    rowspan: 1,
    colwidth: null,
  };
  return type.create(attrs, content ?? cell.content);
}

function buildTable(
  view: Pick<VimEditorView, "state">,
  mutable: MutableTable,
): ProseMirrorNode | null {
  const tableType = view.state.schema.nodes.table;
  const rowType = view.state.schema.nodes.tableRow;
  if (!tableType || !rowType || mutable.rows.length === 0) return null;
  const rows: ProseMirrorNode[] = [];
  for (let row = 0; row < mutable.rows.length; row += 1) {
    const cells: ProseMirrorNode[] = [];
    for (const cell of mutable.rows[row] ?? []) {
      const normalized = normalizedCell(view, cell, row === 0);
      if (!normalized) return null;
      cells.push(normalized);
    }
    rows.push(
      rowType.create(
        mutable.rowAttrs[row] ?? { blockId: createUuidV7() },
        Fragment.fromArray(cells),
      ),
    );
  }
  try {
    return tableType.createChecked(mutable.attrs, Fragment.fromArray(rows));
  } catch {
    return null;
  }
}

function lastCursorInCell(
  view: Pick<VimEditorView, "state">,
  document: ProseMirrorNode,
  cellPosition: number,
): number {
  const cell = document.nodeAt(cellPosition);
  if (!cell) return cellPosition;
  const positions = cellCursorPositions(view, cellPosition, cell);
  return positions.at(-1) ?? cellPosition + 2;
}

function replaceTable(
  view: VimEditorView,
  context: Pick<TableContext, "table" | "tablePosition">,
  table: ProseMirrorNode,
  row: number,
  column: number,
  cursorEdge: "first" | "last" = "first",
): number | null {
  const transaction = view.state.tr.replaceWith(
    context.tablePosition,
    context.tablePosition + context.table.nodeSize,
    table,
  );
  const map = TableMap.get(table);
  const boundedRow = Math.max(0, Math.min(row, map.height - 1));
  const boundedColumn = Math.max(0, Math.min(column, map.width - 1));
  const cellPosition =
    context.tablePosition +
    1 +
    map.positionAt(boundedRow, boundedColumn, table);
  const cell = transaction.doc.nodeAt(cellPosition);
  if (!cell) return null;
  const cursor =
    cursorEdge === "last"
      ? lastCursorInCell(view, transaction.doc, cellPosition)
      : (cellCursorPositions(view, cellPosition, cell)[0] ?? cellPosition + 2);
  transaction.setSelection(TextSelection.create(transaction.doc, cursor));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return cursor;
}

function blankSelectedCells(
  view: Pick<VimEditorView, "state">,
  mutable: MutableTable,
  rect: Rect,
): boolean {
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let column = rect.left; column < rect.right; column += 1) {
      const target = mutable.rows[row]?.[column];
      const paragraph = emptyParagraph(view);
      if (!target || !paragraph) return false;
      const cleared = normalizedCell(
        view,
        target,
        row === 0,
        Fragment.from(paragraph),
      );
      if (!cleared) return false;
      mutable.rows[row]![column] = cleared;
    }
  }
  return true;
}

export function pasteTableCellsIntoTable(
  view: VimEditorView,
  register: VimTableCellsRegister,
  _direction: "after" | "before",
  replaceVisualSelection = false,
): boolean {
  const context = tableContextAtPosition(view);
  const source = registerRows(register);
  if (!context || !source) return false;
  const mutable = mutableTable(context.table, context.map);
  if (!mutable) return false;
  const visual = replaceVisualSelection ? visualBlockRect(view) : null;
  const startRow = visual?.rect.top ?? context.row;
  const startColumn = visual?.rect.left ?? context.column;
  if (visual && !blankSelectedCells(view, mutable, visual.rect)) return false;

  const targetWidth = Math.max(context.map.width, startColumn + register.width);
  while ((mutable.rows[0]?.length ?? 0) < targetWidth) {
    const column = mutable.rows[0]?.length ?? 0;
    for (let row = 0; row < mutable.rows.length; row += 1) {
      const cell = blankCell(
        view,
        row === 0,
        register.alignments[column - startColumn] ?? null,
      );
      if (!cell) return false;
      mutable.rows[row]!.push(cell);
    }
  }
  const targetHeight = Math.max(
    mutable.rows.length,
    startRow + register.height,
  );
  while (mutable.rows.length < targetHeight) {
    const row: ProseMirrorNode[] = [];
    for (let column = 0; column < targetWidth; column += 1) {
      const cell = blankCell(
        view,
        false,
        column >= startColumn
          ? (register.alignments[column - startColumn] ?? null)
          : alignmentForColumn(
              context.table,
              context.map,
              Math.min(column, context.map.width - 1),
            ),
      );
      if (!cell) return false;
      row.push(cell);
    }
    mutable.rows.push(row);
    mutable.rowAttrs.push({ blockId: createUuidV7() });
  }

  for (let row = 0; row < register.height; row += 1) {
    for (let column = 0; column < register.width; column += 1) {
      const target = mutable.rows[startRow + row]?.[startColumn + column];
      const sourceCell = source[row]?.[column];
      if (!target || !sourceCell) return false;
      const children: ProseMirrorNode[] = [];
      sourceCell.forEach((child) =>
        children.push(copyNodeWithFreshBlockIds(child)),
      );
      const replaced = normalizedCell(
        view,
        target,
        startRow + row === 0,
        Fragment.fromArray(children),
      );
      if (!replaced) return false;
      mutable.rows[startRow + row]![startColumn + column] = replaced;
    }
  }

  const table = buildTable(view, mutable);
  if (!table) return false;
  return (
    replaceTable(
      view,
      context,
      table,
      startRow + register.height - 1,
      startColumn + register.width - 1,
      "last",
    ) !== null
  );
}

export function tableFromCellsRegister(
  view: Pick<VimEditorView, "state">,
  register: VimTableCellsRegister,
): ProseMirrorNode | null {
  const source = registerRows(register);
  const tableType = view.state.schema.nodes.table;
  const rowType = view.state.schema.nodes.tableRow;
  if (!source || !tableType || !rowType) return null;
  const rows: ProseMirrorNode[][] = [];
  const rowAttrs: Array<Record<string, unknown>> = [];
  if (!register.includesHeader) {
    const header: ProseMirrorNode[] = [];
    for (let column = 0; column < register.width; column += 1) {
      const cell = blankCell(view, true, register.alignments[column] ?? null);
      if (!cell) return null;
      header.push(cell);
    }
    rows.push(header);
    rowAttrs.push({ blockId: createUuidV7() });
  }
  for (const sourceRow of source) {
    const rowIndex = rows.length;
    const cells: ProseMirrorNode[] = [];
    for (let column = 0; column < sourceRow.length; column += 1) {
      const sourceCell = sourceRow[column];
      if (!sourceCell) return null;
      const children: ProseMirrorNode[] = [];
      sourceCell.forEach((child) =>
        children.push(copyNodeWithFreshBlockIds(child)),
      );
      const base = blankCell(
        view,
        rowIndex === 0,
        register.alignments[column] ?? null,
      );
      if (!base) return null;
      const cell = normalizedCell(
        view,
        base,
        rowIndex === 0,
        Fragment.fromArray(children),
      );
      if (!cell) return null;
      cells.push(cell);
    }
    rows.push(cells);
    rowAttrs.push({ blockId: createUuidV7() });
  }
  return buildTable(view, {
    attrs: { blockId: createUuidV7() },
    rowAttrs,
    rows,
  });
}

function pasteVisualBlock(
  view: VimEditorView,
  register: VimRegister | null,
): EditorVimResult {
  return {
    handled:
      register?.kind === "table-cells" &&
      pasteTableCellsIntoTable(view, register, "before", true),
    detail: "table:visual-block:paste",
    nextMode: "normal",
  };
}

export function runVisualBlockCommand(
  view: VimEditorView,
  command: VimCommand,
  register: VimRegister | null,
  count = 1,
): EditorVimResult {
  switch (command) {
    case "cursor.left":
      return moveVisualBlock(view, "column", -1, count);
    case "cursor.right":
      return moveVisualBlock(view, "column", 1, count);
    case "cursor.logical-up":
    case "cursor.display-up":
      return moveVisualBlock(view, "row", -1, count);
    case "cursor.logical-down":
    case "cursor.display-down":
      return moveVisualBlock(view, "row", 1, count);
    case "motion.line-start":
      return moveVisualBlockToEdge(view, "column-start");
    case "motion.line-end":
      return moveVisualBlockToEdge(view, "column-end");
    case "cursor.document-start":
      return moveVisualBlockToEdge(view, "row-start");
    case "cursor.document-end":
      return moveVisualBlockToEdge(view, "row-end");
    case "selection.yank": {
      const yanked = captureVisualBlockRegister(view);
      const selected = visualBlockRect(view);
      if (yanked && selected) {
        const topLeft = cellPositionAt(
          selected.context.tablePosition,
          selected.context.table,
          selected.context.map,
          selected.rect.top,
          selected.rect.left,
        );
        const cell = view.state.doc.nodeAt(topLeft);
        if (cell) {
          setTextCursor(
            view,
            cellCursorPositions(view, topLeft, cell)[0] ?? topLeft + 2,
          );
        }
      }
      return {
        handled: yanked !== null,
        detail: "table:visual-block:yank",
        register: yanked ?? register ?? undefined,
        nextMode: "normal",
      };
    }
    case "selection.delete":
      return clearVisualBlock(view, "normal");
    case "selection.change":
      return clearVisualBlock(view, "insert");
    case "selection.paste":
      return pasteVisualBlock(view, register);
    default:
      return {
        handled: false,
        detail: `table:visual-block:unhandled:${command}`,
      };
  }
}

export function captureTableActionSelection(
  view: VimEditorView,
  mode: VimMode,
  visualLine: VimVisualLineState | null,
): TableActionSelection | null {
  if (mode !== "normal" && mode !== "visual-line" && mode !== "visual-block") {
    return null;
  }
  const context = tableContextAtPosition(
    view,
    mode === "visual-line" && visualLine
      ? visualLine.cursor
      : view.state.selection.head,
  );
  if (!context) return null;
  let rowFrom = context.row;
  let rowTo = context.row;
  let columnFrom = context.column;
  let columnTo = context.column;

  if (mode === "visual-block") {
    const selected = visualBlockRect(view);
    if (!selected) return null;
    rowFrom = selected.rect.top;
    rowTo = selected.rect.bottom - 1;
    columnFrom = selected.rect.left;
    columnTo = selected.rect.right - 1;
  } else if (mode === "visual-line" && visualLine) {
    const units = blockSemantics.visualLineUnits(view);
    const first = Math.min(visualLine.anchorUnit, visualLine.headUnit);
    const last = Math.max(visualLine.anchorUnit, visualLine.headUnit);
    const selected = units.slice(first, last + 1);
    if (
      selected.length === 0 ||
      selected.some((unit) => unit.kind !== "table-row")
    ) {
      return null;
    }
    const rowIds = new Set(
      selected.map((unit) =>
        String(view.state.doc.nodeAt(unit.from)?.attrs.blockId ?? ""),
      ),
    );
    const indexes: number[] = [];
    context.table.forEach((row, _offset, index) => {
      if (rowIds.has(String(row.attrs.blockId ?? ""))) indexes.push(index);
    });
    if (indexes.length !== selected.length) return null;
    rowFrom = Math.min(...indexes);
    rowTo = Math.max(...indexes);
  }

  const tableBlockId = String(context.table.attrs.blockId ?? "");
  if (!tableBlockId) return null;
  return {
    tableBlockId,
    tablePosition: context.tablePosition,
    rowFrom,
    rowTo,
    columnFrom,
    columnTo,
    activeRow: context.row,
    activeColumn: context.column,
    beforeCursor:
      mode === "visual-block"
        ? visualBlockCursor(view)
        : mode === "visual-line" && visualLine
          ? visualLine.cursor
          : view.state.selection.head,
    mode,
  };
}

function findTableByBlockId(
  view: Pick<VimEditorView, "state">,
  blockId: string,
): { node: ProseMirrorNode; position: number; map: TableMap } | null {
  let result: {
    node: ProseMirrorNode;
    position: number;
    map: TableMap;
  } | null = null;
  view.state.doc.descendants((node, position) => {
    if (
      !result &&
      node.type.name === "table" &&
      String(node.attrs.blockId ?? "") === blockId
    ) {
      result = { node, position, map: TableMap.get(node) };
      return false;
    }
    return !result;
  });
  return result;
}

function moveArrayGroup<T>(
  values: T[],
  from: number,
  to: number,
  direction: -1 | 1,
): boolean {
  if (
    (direction < 0 && from === 0) ||
    (direction > 0 && to === values.length - 1)
  ) {
    return false;
  }
  const moved = values.splice(from, to - from + 1);
  values.splice(direction < 0 ? from - 1 : from + 1, 0, ...moved);
  return true;
}

function deleteTableAt(
  view: VimEditorView,
  position: number,
  table: ProseMirrorNode,
): number {
  const transaction = view.state.tr.delete(position, position + table.nodeSize);
  const cursor = Math.max(0, Math.min(position, transaction.doc.content.size));
  transaction.setSelection(Selection.near(transaction.doc.resolve(cursor), -1));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return transaction.selection.head;
}

export function runTableAction(
  view: VimEditorView,
  selection: TableActionSelection,
  action: TableActionId,
): TableActionResult {
  const found = findTableByBlockId(view, selection.tableBlockId);
  if (!found) {
    return {
      changed: false,
      reason: "missing",
      position: selection.beforeCursor,
    };
  }
  const mutable = mutableTable(found.node, found.map);
  if (!mutable) {
    return {
      changed: false,
      reason: "unsupported",
      position: selection.beforeCursor,
    };
  }
  const rowFrom = Math.max(
    0,
    Math.min(selection.rowFrom, mutable.rows.length - 1),
  );
  const rowTo = Math.max(
    rowFrom,
    Math.min(selection.rowTo, mutable.rows.length - 1),
  );
  const columnFrom = Math.max(
    0,
    Math.min(selection.columnFrom, (mutable.rows[0]?.length ?? 1) - 1),
  );
  const columnTo = Math.max(
    columnFrom,
    Math.min(selection.columnTo, (mutable.rows[0]?.length ?? 1) - 1),
  );
  let activeRow = Math.max(rowFrom, Math.min(selection.activeRow, rowTo));
  let activeColumn = Math.max(
    columnFrom,
    Math.min(selection.activeColumn, columnTo),
  );
  let changed = true;

  if (action === "table.delete") {
    return {
      changed: true,
      reason: "changed",
      position: deleteTableAt(view, found.position, found.node),
    };
  }

  if (action === "row.add_before" || action === "row.add_after") {
    const insertion = action === "row.add_before" ? rowFrom : rowTo + 1;
    const amount = normalizedCount(
      selection.additionCount ?? rowTo - rowFrom + 1,
    );
    const rows: ProseMirrorNode[][] = [];
    const rowAttrs: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < amount; offset += 1) {
      const cells: ProseMirrorNode[] = [];
      for (
        let column = 0;
        column < (mutable.rows[0]?.length ?? 0);
        column += 1
      ) {
        const cell = blankCell(
          view,
          insertion + offset === 0,
          alignmentForColumn(found.node, found.map, column),
        );
        if (!cell) {
          return {
            changed: false,
            reason: "unsupported",
            position: selection.beforeCursor,
          };
        }
        cells.push(cell);
      }
      rows.push(cells);
      rowAttrs.push({ blockId: createUuidV7() });
    }
    mutable.rows.splice(insertion, 0, ...rows);
    mutable.rowAttrs.splice(insertion, 0, ...rowAttrs);
    activeRow = insertion;
    activeColumn = columnFrom;
  } else if (action === "row.delete") {
    if (rowFrom === 0 && rowTo === mutable.rows.length - 1) {
      return {
        changed: true,
        reason: "changed",
        position: deleteTableAt(view, found.position, found.node),
      };
    }
    mutable.rows.splice(rowFrom, rowTo - rowFrom + 1);
    mutable.rowAttrs.splice(rowFrom, rowTo - rowFrom + 1);
    activeRow = Math.min(rowFrom, mutable.rows.length - 1);
    activeColumn = Math.min(activeColumn, (mutable.rows[0]?.length ?? 1) - 1);
  } else if (action === "row.move_up" || action === "row.move_down") {
    const direction = action === "row.move_up" ? -1 : 1;
    const movedRows = moveArrayGroup(mutable.rows, rowFrom, rowTo, direction);
    const movedAttrs = moveArrayGroup(
      mutable.rowAttrs,
      rowFrom,
      rowTo,
      direction,
    );
    changed = movedRows && movedAttrs;
    if (changed) activeRow += direction;
  } else if (action === "column.add_before" || action === "column.add_after") {
    const insertion =
      action === "column.add_before" ? columnFrom : columnTo + 1;
    const amount = normalizedCount(
      selection.additionCount ?? columnTo - columnFrom + 1,
    );
    for (let row = 0; row < mutable.rows.length; row += 1) {
      const cells: ProseMirrorNode[] = [];
      for (let offset = 0; offset < amount; offset += 1) {
        const cell = blankCell(view, row === 0);
        if (!cell) {
          return {
            changed: false,
            reason: "unsupported",
            position: selection.beforeCursor,
          };
        }
        cells.push(cell);
      }
      mutable.rows[row]!.splice(insertion, 0, ...cells);
    }
    activeColumn = insertion;
    activeRow = rowFrom;
  } else if (action === "column.delete") {
    const width = mutable.rows[0]?.length ?? 0;
    if (columnFrom === 0 && columnTo === width - 1) {
      return {
        changed: true,
        reason: "changed",
        position: deleteTableAt(view, found.position, found.node),
      };
    }
    for (const row of mutable.rows) {
      row.splice(columnFrom, columnTo - columnFrom + 1);
    }
    activeColumn = Math.min(columnFrom, (mutable.rows[0]?.length ?? 1) - 1);
    activeRow = Math.min(activeRow, mutable.rows.length - 1);
  } else if (action === "column.move_left" || action === "column.move_right") {
    const direction = action === "column.move_left" ? -1 : 1;
    changed = mutable.rows.every((row) =>
      moveArrayGroup(row, columnFrom, columnTo, direction),
    );
    if (changed) activeColumn += direction;
  } else {
    const align: TableAlignment =
      action === "column.align_left"
        ? "left"
        : action === "column.align_center"
          ? "center"
          : action === "column.align_right"
            ? "right"
            : null;
    for (let row = 0; row < mutable.rows.length; row += 1) {
      for (let column = columnFrom; column <= columnTo; column += 1) {
        const cell = mutable.rows[row]?.[column];
        if (!cell) continue;
        mutable.rows[row]![column] = cell.type.create(
          { ...cell.attrs, align },
          cell.content,
          cell.marks,
        );
      }
    }
  }

  if (!changed) {
    return {
      changed: false,
      reason: "boundary",
      position: selection.beforeCursor,
    };
  }
  const table = buildTable(view, mutable);
  if (!table) {
    return {
      changed: false,
      reason: "unsupported",
      position: selection.beforeCursor,
    };
  }
  const position = replaceTable(
    view,
    { table: found.node, tablePosition: found.position },
    table,
    activeRow,
    activeColumn,
  );
  return position === null
    ? {
        changed: false,
        reason: "unsupported",
        position: selection.beforeCursor,
      }
    : {
        changed: true,
        reason: "changed",
        position,
        repeat: isTableRepeatableAction(action)
          ? {
              action,
              amount:
                selection.additionCount ??
                (action.startsWith("row.")
                  ? rowTo - rowFrom + 1
                  : columnTo - columnFrom + 1),
            }
          : undefined,
      };
}

export function repeatTableAction(
  view: VimEditorView,
  repeat: TableActionRepeat,
  multiplier = 1,
): TableActionResult {
  const selection = captureTableActionSelection(view, "normal", null);
  if (!selection) {
    return {
      changed: false,
      reason: "missing",
      position: view.state.selection.head,
    };
  }
  return runTableAction(
    view,
    {
      ...selection,
      additionCount:
        normalizedCount(repeat.amount) * normalizedCount(multiplier),
    },
    repeat.action,
  );
}
