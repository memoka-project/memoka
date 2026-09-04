// Product block semantics shared by the Vim command layer.
import type {
  Node as ProseMirrorNode,
  NodeType,
  Schema,
} from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  sectionFoldHiddenEntries,
  sectionFoldStateSignature,
} from "../editor/section-folding";

export type VimLogicalLineKind = "block-atom" | "code-line" | "text-block";

export interface VimLogicalLine {
  from: number;
  to: number;
  blockFrom: number;
  blockTo: number;
  blockPosition: number;
  blockNodeName: string;
  kind: VimLogicalLineKind;
  cursorPositions: number[];
}

export type VimLogicalLineAnchor = Omit<VimLogicalLine, "cursorPositions">;

export type VimStructureKind = "block" | "list-item" | "table-row";

export type VimStructuralUnitKind =
  "code-line" | "hard-break-line" | VimStructureKind;

export interface VimStructuralUnit {
  from: number;
  to: number;
  cursorFrom: number;
  cursorTo: number;
  textFrom: number;
  textTo: number;
  blockFrom: number;
  blockTo: number;
  blockPosition: number;
  kind: VimStructuralUnitKind;
  nodeName: string;
  cursorPositions: number[];
}

export interface VimUnitRange {
  from: number;
  to: number;
  first: VimStructuralUnit;
  last: VimStructuralUnit;
}

export interface VimDocumentRange {
  from: number;
  to: number;
}

export interface VimBlockBehavior {
  id: string;
  nodeNames: readonly string[];
  logicalLines?: "split-text-lines" | "split-hard-break-lines";
  structuralAncestor?: VimStructureKind;
  insertEnter?: "newline-with-indent" | "split-to-paragraph";
  unwrapToParagraphAtBoundary?: "always" | "when-empty";
  boundaryJoin?: "code-lines" | "source-lines";
  deletionAncestor?: {
    collapseParentWhenOnlyChild: boolean;
  };
}

type VimSemanticsView = {
  state: EditorState;
};

export const DEFAULT_VIM_BLOCK_BEHAVIORS = [
  {
    id: "paragraph",
    nodeNames: ["paragraph"],
    logicalLines: "split-hard-break-lines",
  },
  {
    id: "code-block",
    nodeNames: ["codeBlock", "code_block"],
    logicalLines: "split-text-lines",
    insertEnter: "newline-with-indent",
    unwrapToParagraphAtBoundary: "when-empty",
    boundaryJoin: "code-lines",
  },
  {
    id: "section-title",
    nodeNames: ["sectionHeader"],
  },
  {
    id: "source-block",
    nodeNames: ["sourceBlock", "source_block"],
    logicalLines: "split-text-lines",
    insertEnter: "newline-with-indent",
    unwrapToParagraphAtBoundary: "when-empty",
    boundaryJoin: "source-lines",
  },
  {
    id: "list-item",
    nodeNames: ["listItem", "list_item"],
    structuralAncestor: "list-item",
    deletionAncestor: {
      collapseParentWhenOnlyChild: true,
    },
  },
  {
    id: "table-row",
    nodeNames: ["tableRow", "table_row"],
    structuralAncestor: "table-row",
    deletionAncestor: {
      collapseParentWhenOnlyChild: true,
    },
  },
] as const satisfies readonly VimBlockBehavior[];

function isHardBreakNode(node: ProseMirrorNode): boolean {
  return node.type.name === "hardBreak" || node.type.name === "hard_break";
}

function textblockContentCursorPositions(
  node: ProseMirrorNode,
  blockFrom: number,
  rangeFrom = Number.NEGATIVE_INFINITY,
  rangeTo = Number.POSITIVE_INFINITY,
): number[] {
  const positions: number[] = [];
  node.descendants((child, offset) => {
    if (isHardBreakNode(child)) return false;
    if (child.isText) {
      const childFrom = blockFrom + offset;
      const firstIndex = Math.max(0, rangeFrom - childFrom);
      const lastIndex = Math.min(child.nodeSize, rangeTo - childFrom);
      for (let index = firstIndex; index < lastIndex; index += 1) {
        positions.push(blockFrom + offset + index);
      }
      return false;
    }
    if (child.isInline && (child.isAtom || child.isLeaf)) {
      const position = blockFrom + offset;
      if (position >= rangeFrom && position < rangeTo) {
        positions.push(position);
      }
      return false;
    }
    return true;
  });
  return [...new Set(positions)];
}

function textblockCursorPositions(
  node: ProseMirrorNode,
  blockFrom: number,
): number[] {
  const positions = textblockContentCursorPositions(node, blockFrom);
  return positions.length > 0 ? positions : [blockFrom];
}

function hardBreakLineRanges(
  node: ProseMirrorNode,
  blockFrom: number,
): Array<{ from: number; to: number }> {
  const breakPositions: Array<{ from: number; to: number }> = [];
  node.descendants((child, offset) => {
    if (!isHardBreakNode(child)) return true;
    const from = blockFrom + offset;
    breakPositions.push({ from, to: from + child.nodeSize });
    return false;
  });

  const ranges: Array<{ from: number; to: number }> = [];
  let from = blockFrom;
  for (const hardBreak of breakPositions) {
    ranges.push({ from, to: hardBreak.from });
    from = hardBreak.to;
  }
  ranges.push({ from, to: blockFrom + node.content.size });
  return ranges;
}

function hardBreakLogicalLines(
  node: ProseMirrorNode,
  blockFrom: number,
): Array<{
  from: number;
  to: number;
  cursorEnd: number;
  cursorPositions: () => number[];
}> {
  return hardBreakLineRanges(node, blockFrom).map((range) => {
    return {
      ...range,
      cursorEnd: lastDescendantCursorPosition(
        node,
        blockFrom,
        range.from,
        range.to,
      ),
      cursorPositions: () => {
        const positions = textblockContentCursorPositions(
          node,
          blockFrom,
          range.from,
          range.to,
        );
        return positions.length > 0 ? positions : [range.from];
      },
    };
  });
}

function descendantCursorPositions(
  node: ProseMirrorNode,
  contentStart: number,
): number[] {
  const positions: number[] = [];
  node.descendants((child, offset) => {
    if (child.isText) {
      for (let index = 0; index < child.nodeSize; index += 1) {
        positions.push(contentStart + offset + index);
      }
      return false;
    }
    if (child.isInline && (child.isAtom || child.isLeaf)) {
      positions.push(contentStart + offset);
      return false;
    }
    if (child.isTextblock && child.content.size === 0) {
      positions.push(contentStart + offset + 1);
    }
    return true;
  });
  return positions.length > 0 ? [...new Set(positions)] : [contentStart];
}

function firstDescendantCursorPosition(
  node: ProseMirrorNode,
  contentStart: number,
): number {
  let first: number | null = null;
  node.descendants((child, offset) => {
    if (first !== null) return false;
    if (child.isText || (child.isInline && (child.isAtom || child.isLeaf))) {
      first = contentStart + offset;
      return false;
    }
    if (child.isTextblock && child.content.size === 0) {
      first = contentStart + offset + 1;
      return false;
    }
    return true;
  });
  return first ?? contentStart;
}

function lastDescendantCursorPosition(
  node: ProseMirrorNode,
  contentStart: number,
  rangeFrom = Number.NEGATIVE_INFINITY,
  rangeTo = Number.POSITIVE_INFINITY,
): number {
  let last: number | null = null;
  node.descendants((child, offset) => {
    if (isHardBreakNode(child)) return false;
    const childFrom = contentStart + offset;
    if (child.isText) {
      const from = Math.max(childFrom, rangeFrom);
      const to = Math.min(childFrom + child.nodeSize, rangeTo);
      if (from < to) last = to - 1;
      return false;
    }
    if (child.isInline && (child.isAtom || child.isLeaf)) {
      if (childFrom >= rangeFrom && childFrom < rangeTo) last = childFrom;
      return false;
    }
    if (
      child.isTextblock &&
      child.content.size === 0 &&
      childFrom + 1 >= rangeFrom &&
      childFrom + 1 < rangeTo
    ) {
      last = childFrom + 1;
    }
    return true;
  });
  return (
    last ?? (Number.isFinite(rangeFrom) ? Math.max(0, rangeFrom) : contentStart)
  );
}

const logicalLineCursorEnds = new WeakMap<VimLogicalLine, number>();

function logicalLineWithLazyCursorPositions(
  line: Omit<VimLogicalLine, "cursorPositions">,
  cursorEnd: number,
  createCursorPositions: () => number[],
): VimLogicalLine {
  let cached: number[] | null = null;
  const result: VimLogicalLine = {
    ...line,
    get cursorPositions() {
      cached ??= createCursorPositions();
      return cached;
    },
  };
  logicalLineCursorEnds.set(result, cursorEnd);
  return result;
}

interface StructuralCursorSource {
  lines: VimLogicalLine[];
  cached: number[] | null;
}

const structuralCursorSources = new WeakMap<
  VimStructuralUnit,
  StructuralCursorSource
>();

function structuralUnitWithLazyCursorPositions(
  unit: Omit<VimStructuralUnit, "cursorPositions">,
  line: VimLogicalLine,
): VimStructuralUnit {
  const source: StructuralCursorSource = { lines: [line], cached: null };
  const result: VimStructuralUnit = {
    ...unit,
    get cursorPositions() {
      if (source.cached) return source.cached;
      if (source.lines.length === 1) {
        source.cached = source.lines[0]!.cursorPositions;
      } else {
        source.cached = [
          ...new Set(
            source.lines.flatMap(({ cursorPositions }) => cursorPositions),
          ),
        ];
      }
      return source.cached;
    },
  };
  structuralCursorSources.set(result, source);
  return result;
}

function currentLogicalLineIndex(
  lines: readonly VimLogicalLineAnchor[],
  position: number,
): number {
  if (lines.length === 0) return 0;
  let low = 0;
  let high = lines.length;
  // Logical-line anchors are emitted in document order. Find the last line
  // whose content starts at or before the cursor without scanning a 100k-line
  // projection on every cursor move.
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.from <= position) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const candidate = lines[index]!;
  if (
    position <= candidate.to ||
    (position >= candidate.blockPosition && position < candidate.blockTo)
  ) {
    return index;
  }
  return Math.min(index + 1, lines.length - 1);
}

export class VimBlockSemanticsRegistry {
  readonly #behaviors: readonly VimBlockBehavior[];
  readonly #behaviorByNodeName: ReadonlyMap<string, VimBlockBehavior>;
  readonly #logicalLinesByDocument = new WeakMap<
    ProseMirrorNode,
    VimLogicalLine[]
  >();
  readonly #logicalLineAnchorsByDocument = new WeakMap<
    ProseMirrorNode,
    VimLogicalLineAnchor[]
  >();
  readonly #visibleLogicalLinesByDocument = new WeakMap<
    ProseMirrorNode,
    { signature: string; lines: VimLogicalLine[] }
  >();
  readonly #structuralUnitsByDocument = new WeakMap<
    ProseMirrorNode,
    { signature: string; units: VimStructuralUnit[] }
  >();
  readonly #visualLineUnitsByDocument = new WeakMap<
    ProseMirrorNode,
    { signature: string; units: VimStructuralUnit[] }
  >();

  constructor(
    behaviors: readonly VimBlockBehavior[] = DEFAULT_VIM_BLOCK_BEHAVIORS,
  ) {
    const behaviorByNodeName = new Map<string, VimBlockBehavior>();
    for (const behavior of behaviors) {
      for (const nodeName of behavior.nodeNames) {
        if (behaviorByNodeName.has(nodeName)) {
          throw new Error(`Duplicate Vim block behavior for ${nodeName}`);
        }
        behaviorByNodeName.set(nodeName, behavior);
      }
    }
    this.#behaviors = [...behaviors];
    this.#behaviorByNodeName = behaviorByNodeName;
  }

  behaviorForNodeName(nodeName: string): VimBlockBehavior | null {
    return this.#behaviorByNodeName.get(nodeName) ?? null;
  }

  hasBehavior(nodeName: string, behaviorId: string): boolean {
    return this.behaviorForNodeName(nodeName)?.id === behaviorId;
  }

  nearestAncestorType(
    view: VimSemanticsView,
    behaviorId: string,
  ): NodeType | null {
    const $position = view.state.selection.$from;
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const type = $position.node(depth).type;
      if (this.hasBehavior(type.name, behaviorId)) return type;
    }
    return null;
  }

  ancestorNodeAt(
    view: VimSemanticsView,
    position: number,
    behaviorId: string,
  ): ProseMirrorNode | null {
    const bounded = Math.max(
      0,
      Math.min(position, view.state.doc.content.size),
    );
    const $position = view.state.doc.resolve(bounded);
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const node = $position.node(depth);
      if (this.hasBehavior(node.type.name, behaviorId)) return node;
    }
    return null;
  }

  nodeType(
    schema: Schema,
    behaviorId: string,
    preferredNodeName?: string,
  ): NodeType | null {
    if (preferredNodeName && schema.nodes[preferredNodeName]) {
      return schema.nodes[preferredNodeName];
    }
    const behavior = this.#behaviors.find(({ id }) => id === behaviorId);
    if (!behavior) return null;
    for (const nodeName of behavior.nodeNames) {
      const type = schema.nodes[nodeName];
      if (type) return type;
    }
    return null;
  }

  #hasStructuralAncestorAt(view: VimSemanticsView, position: number): boolean {
    const bounded = Math.max(
      0,
      Math.min(position, view.state.doc.content.size),
    );
    const $position = view.state.doc.resolve(bounded);
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const behavior = this.behaviorForNodeName(
        $position.node(depth).type.name,
      );
      if (behavior?.structuralAncestor) return true;
    }
    return false;
  }

  #usesHardBreakLogicalLines(
    view: VimSemanticsView,
    nodeName: string,
    blockFrom: number,
  ): boolean {
    return (
      this.behaviorForNodeName(nodeName)?.logicalLines ===
        "split-hard-break-lines" &&
      !this.#hasStructuralAncestorAt(view, blockFrom)
    );
  }

  logicalLines(view: VimSemanticsView): VimLogicalLine[] {
    const allLines = this.#allLogicalLines(view);
    const signature = sectionFoldStateSignature(view.state);
    if (!signature) return allLines;
    const cached = this.#visibleLogicalLinesByDocument.get(view.state.doc);
    if (cached?.signature === signature) return cached.lines;
    const hidden = [...sectionFoldHiddenEntries(view.state)].sort(
      (left, right) =>
        left.hiddenFrom - right.hiddenFrom || right.hiddenTo - left.hiddenTo,
    );
    let hiddenIndex = 0;
    const lines = allLines.filter((line) => {
      while (
        hiddenIndex < hidden.length &&
        hidden[hiddenIndex]!.hiddenTo <= line.blockPosition
      ) {
        hiddenIndex += 1;
      }
      const entry = hidden[hiddenIndex];
      return !(
        entry &&
        line.blockPosition >= entry.hiddenFrom &&
        line.blockPosition < entry.hiddenTo
      );
    });
    this.#visibleLogicalLinesByDocument.set(view.state.doc, {
      signature,
      lines,
    });
    return lines;
  }

  #allLogicalLines(view: VimSemanticsView): VimLogicalLine[] {
    const cached = this.#logicalLinesByDocument.get(view.state.doc);
    if (cached) return cached;
    const lines: VimLogicalLine[] = [];
    view.state.doc.descendants((node, position) => {
      if (node.isBlock && (node.isAtom || node.isLeaf)) {
        lines.push(
          logicalLineWithLazyCursorPositions(
            {
              from: position,
              to: position,
              blockFrom: position,
              blockTo: position + node.nodeSize,
              blockPosition: position,
              blockNodeName: node.type.name,
              kind: "block-atom",
            },
            position,
            () => [position],
          ),
        );
        return false;
      }
      const behavior = this.behaviorForNodeName(node.type.name);
      if (behavior?.structuralAncestor === "table-row") {
        const from = firstDescendantCursorPosition(node, position + 1);
        const to = lastDescendantCursorPosition(node, position + 1);
        lines.push(
          logicalLineWithLazyCursorPositions(
            {
              from,
              to,
              blockFrom: position + 1,
              blockTo: position + node.nodeSize,
              blockPosition: position,
              blockNodeName: node.type.name,
              kind: "text-block",
            },
            to,
            () => descendantCursorPositions(node, position + 1),
          ),
        );
        return false;
      }
      if (!node.isTextblock) return true;

      const blockFrom = position + 1;
      const blockTo = blockFrom + node.content.size;
      if (behavior?.logicalLines === "split-text-lines") {
        const text = node.textContent;
        let offset = 0;
        for (const part of text.split("\n")) {
          const lineFrom = blockFrom + offset;
          const lineLength = part.length;
          lines.push(
            logicalLineWithLazyCursorPositions(
              {
                from: lineFrom,
                to: lineFrom + lineLength,
                blockFrom,
                blockTo,
                blockPosition: position,
                blockNodeName: node.type.name,
                kind: "code-line",
              },
              lineLength > 0 ? lineFrom + lineLength - 1 : lineFrom,
              () =>
                lineLength > 0
                  ? Array.from(
                      { length: lineLength },
                      (_, index) => lineFrom + index,
                    )
                  : [lineFrom],
            ),
          );
          offset += part.length + 1;
        }
      } else if (
        this.#usesHardBreakLogicalLines(view, node.type.name, blockFrom)
      ) {
        for (const line of hardBreakLogicalLines(node, blockFrom)) {
          lines.push(
            logicalLineWithLazyCursorPositions(
              {
                from: line.from,
                to: line.to,
                blockFrom,
                blockTo,
                blockPosition: position,
                blockNodeName: node.type.name,
                kind: "text-block",
              },
              line.cursorEnd,
              line.cursorPositions,
            ),
          );
        }
      } else {
        lines.push(
          logicalLineWithLazyCursorPositions(
            {
              from: blockFrom,
              to: blockTo,
              blockFrom,
              blockTo,
              blockPosition: position,
              blockNodeName: node.type.name,
              kind: "text-block",
            },
            lastDescendantCursorPosition(node, blockFrom),
            () => textblockCursorPositions(node, blockFrom),
          ),
        );
      }
      return false;
    });
    this.#logicalLinesByDocument.set(view.state.doc, lines);
    return lines;
  }

  logicalLineAnchors(view: VimSemanticsView): VimLogicalLineAnchor[] {
    const cached = this.#logicalLineAnchorsByDocument.get(view.state.doc);
    if (cached) return cached;
    const lines: VimLogicalLineAnchor[] = [];
    view.state.doc.descendants((node, position) => {
      const anchors = this.logicalLineAnchorsForNode(view, node, position);
      if (!anchors) return true;
      lines.push(...anchors);
      return false;
    });
    this.#logicalLineAnchorsByDocument.set(view.state.doc, lines);
    return lines;
  }

  /**
   * Returns null when descendants still need visiting, otherwise the complete
   * logical-line projection owned by this semantic block. The gutter uses the
   * same method to patch one edited block without traversing a large NoteDoc.
   */
  logicalLineAnchorsForNode(
    view: VimSemanticsView,
    node: ProseMirrorNode,
    position: number,
  ): VimLogicalLineAnchor[] | null {
    if (node.isBlock && (node.isAtom || node.isLeaf)) {
      return [
        {
          from: position,
          to: position,
          blockFrom: position,
          blockTo: position + node.nodeSize,
          blockPosition: position,
          blockNodeName: node.type.name,
          kind: "block-atom",
        },
      ];
    }
    const behavior = this.behaviorForNodeName(node.type.name);
    if (behavior?.structuralAncestor === "table-row") {
      const cursor = firstDescendantCursorPosition(node, position + 1);
      return [
        {
          from: cursor,
          to: position + node.nodeSize - 1,
          blockFrom: position + 1,
          blockTo: position + node.nodeSize,
          blockPosition: position,
          blockNodeName: node.type.name,
          kind: "text-block",
        },
      ];
    }
    if (!node.isTextblock) return null;

    const blockFrom = position + 1;
    const blockTo = blockFrom + node.content.size;
    if (behavior?.logicalLines === "split-text-lines") {
      const lines: VimLogicalLineAnchor[] = [];
      let offset = 0;
      for (const part of node.textContent.split("\n")) {
        lines.push({
          from: blockFrom + offset,
          to: blockFrom + offset + part.length,
          blockFrom,
          blockTo,
          blockPosition: position,
          blockNodeName: node.type.name,
          kind: "code-line",
        });
        offset += part.length + 1;
      }
      return lines;
    }
    if (this.#usesHardBreakLogicalLines(view, node.type.name, blockFrom)) {
      return hardBreakLineRanges(node, blockFrom).map((line) => ({
        ...line,
        blockFrom,
        blockTo,
        blockPosition: position,
        blockNodeName: node.type.name,
        kind: "text-block",
      }));
    }
    return [
      {
        from: blockFrom,
        to: blockTo,
        blockFrom,
        blockTo,
        blockPosition: position,
        blockNodeName: node.type.name,
        kind: "text-block",
      },
    ];
  }

  currentLineIndex(lines: VimLogicalLine[], position: number): number {
    return currentLogicalLineIndex(lines, position);
  }

  currentLineAnchorIndex(
    lines: readonly VimLogicalLineAnchor[],
    position: number,
  ): number {
    return currentLogicalLineIndex(lines, position);
  }

  nearestCursorPosition(line: VimLogicalLine, position: number): number {
    return line.cursorPositions.reduce((nearest, candidate) =>
      Math.abs(candidate - position) < Math.abs(nearest - position)
        ? candidate
        : nearest,
    );
  }

  lineCursorEnd(line: VimLogicalLine): number {
    return (
      logicalLineCursorEnds.get(line) ??
      line.cursorPositions[line.cursorPositions.length - 1] ??
      line.from
    );
  }

  structuralUnits(view: VimSemanticsView): VimStructuralUnit[] {
    return this.#units(view, false);
  }

  visualLineUnits(view: VimSemanticsView): VimStructuralUnit[] {
    return this.#units(view, true);
  }

  #units(
    view: VimSemanticsView,
    splitHardBreakLines: boolean,
  ): VimStructuralUnit[] {
    const cache = splitHardBreakLines
      ? this.#visualLineUnitsByDocument
      : this.#structuralUnitsByDocument;
    const signature = sectionFoldStateSignature(view.state);
    const cached = cache.get(view.state.doc);
    if (cached?.signature === signature) return cached.units;
    const units: VimStructuralUnit[] = [];
    const structuralByKey = new Map<string, VimStructuralUnit>();
    const logicalLines = this.logicalLines(view);
    const lineCountByBlock = new Map<number, number>();
    for (const line of logicalLines) {
      lineCountByBlock.set(
        line.blockPosition,
        (lineCountByBlock.get(line.blockPosition) ?? 0) + 1,
      );
    }

    for (const line of logicalLines) {
      if (line.kind === "code-line") {
        units.push(
          structuralUnitWithLazyCursorPositions(
            {
              from: line.from,
              to: line.to,
              cursorFrom: line.from,
              cursorTo: this.lineCursorEnd(line),
              textFrom: line.from,
              textTo: line.to,
              blockFrom: line.blockFrom,
              blockTo: line.blockTo,
              blockPosition: line.blockPosition,
              kind: "code-line",
              nodeName: line.blockNodeName,
            },
            line,
          ),
        );
        continue;
      }

      if (line.kind === "block-atom") {
        units.push(
          structuralUnitWithLazyCursorPositions(
            {
              from: line.blockPosition,
              to: line.blockTo,
              cursorFrom: line.blockPosition,
              cursorTo: line.blockPosition,
              textFrom: line.blockPosition,
              textTo: line.blockPosition,
              blockFrom: line.blockFrom,
              blockTo: line.blockTo,
              blockPosition: line.blockPosition,
              kind: "block",
              nodeName: line.blockNodeName,
            },
            line,
          ),
        );
        continue;
      }

      if (
        splitHardBreakLines &&
        this.#usesHardBreakLogicalLines(
          view,
          line.blockNodeName,
          line.blockFrom,
        ) &&
        (lineCountByBlock.get(line.blockPosition) ?? 0) > 1
      ) {
        units.push(
          structuralUnitWithLazyCursorPositions(
            {
              from: line.from,
              to: line.to,
              cursorFrom: line.from,
              cursorTo: this.lineCursorEnd(line),
              textFrom: line.from,
              textTo: line.to,
              blockFrom: line.blockFrom,
              blockTo: line.blockTo,
              blockPosition: line.blockPosition,
              kind: "hard-break-line",
              nodeName: line.blockNodeName,
            },
            line,
          ),
        );
        continue;
      }

      const $position = view.state.doc.resolve(line.from);
      let ancestorDepth: number | null = null;
      let structureKind: VimStructureKind = "block";
      for (let depth = $position.depth; depth > 0; depth -= 1) {
        const behavior = this.behaviorForNodeName(
          $position.node(depth).type.name,
        );
        if (behavior?.structuralAncestor) {
          ancestorDepth = depth;
          structureKind = behavior.structuralAncestor;
          break;
        }
      }

      const from =
        ancestorDepth === null
          ? line.blockPosition
          : $position.before(ancestorDepth);
      const to =
        ancestorDepth === null
          ? line.blockPosition +
            (view.state.doc.nodeAt(line.blockPosition)?.nodeSize ?? 0)
          : $position.after(ancestorDepth);
      const nodeName =
        ancestorDepth === null
          ? line.blockNodeName
          : $position.node(ancestorDepth).type.name;
      const key = `${from}:${to}`;
      const existing = structuralByKey.get(key);
      if (existing) {
        existing.cursorTo = this.lineCursorEnd(line);
        existing.textTo = line.to;
        const source = structuralCursorSources.get(existing);
        source?.lines.push(line);
        if (source) source.cached = null;
        continue;
      }
      const unit = structuralUnitWithLazyCursorPositions(
        {
          from,
          to,
          cursorFrom: line.from,
          cursorTo: this.lineCursorEnd(line),
          textFrom: line.from,
          textTo: line.to,
          blockFrom: line.blockFrom,
          blockTo: line.blockTo,
          blockPosition: line.blockPosition,
          kind: structureKind,
          nodeName,
        },
        line,
      );
      structuralByKey.set(key, unit);
      units.push(unit);
    }

    cache.set(view.state.doc, { signature, units });
    return units;
  }

  currentStructuralUnitIndex(
    units: VimStructuralUnit[],
    position: number,
  ): number {
    const exact = units.findIndex(
      ({ textFrom, textTo }) => position >= textFrom && position <= textTo,
    );
    if (exact >= 0) return exact;
    const next = units.findIndex(({ cursorFrom }) => cursorFrom > position);
    return next >= 0 ? next : Math.max(0, units.length - 1);
  }

  visualLineRange(
    units: VimStructuralUnit[],
    anchorUnit: number,
    headUnit: number,
  ): VimUnitRange {
    const start = Math.min(anchorUnit, headUnit);
    const end = Math.max(anchorUnit, headUnit);
    const selected = units.slice(start, end + 1);
    const first = selected[0];
    const last = selected[selected.length - 1];
    return {
      from: Math.min(...selected.map(({ from }) => from)),
      to: Math.max(...selected.map(({ to }) => to)),
      first,
      last,
    };
  }

  deletionRange(
    view: VimSemanticsView,
    line: VimLogicalLine,
  ): VimDocumentRange {
    if (line.kind === "code-line") {
      let from = line.from;
      let to = line.to;
      if (to < line.blockTo) to += 1;
      else if (from > line.blockFrom) from -= 1;
      return { from, to };
    }

    if (line.kind === "block-atom") {
      return { from: line.blockPosition, to: line.blockTo };
    }

    const $position = view.state.doc.resolve(line.from);
    let deletionDepth = $position.depth;
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const node = $position.node(depth);
      const behavior = this.behaviorForNodeName(node.type.name);
      if (behavior?.deletionAncestor) {
        const parentDepth = depth - 1;
        deletionDepth =
          behavior.deletionAncestor.collapseParentWhenOnlyChild &&
          parentDepth > 0 &&
          $position.node(parentDepth).childCount === 1
            ? parentDepth
            : depth;
        break;
      }
      if (node.isTextblock) deletionDepth = depth;
    }
    return {
      from: $position.before(deletionDepth),
      to: $position.after(deletionDepth),
    };
  }
}

export const defaultVimBlockSemantics = new VimBlockSemanticsRegistry();
