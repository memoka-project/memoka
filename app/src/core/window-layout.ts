import type { SplitDirection, SplitNode } from "./application-state";

export const SPLIT_GAP_PX = 1;
export const MIN_WINDOW_WIDTH_PX = 96;
export const MIN_WINDOW_HEIGHT_PX = 64;
export const MIN_SIDEBAR_WIDTH_PX = 120;

export interface LayoutExtent {
  width: number;
  height: number;
}

export type WindowLayoutEdit =
  | { kind: "ratio"; splitId: string; ratio: number }
  | {
      kind: "resize";
      windowId: string;
      direction: SplitDirection;
      deltaPx: number;
      extent: LayoutExtent;
    }
  | { kind: "equalize" }
  | {
      kind: "move";
      windowId: string;
      edge: "left" | "right" | "up" | "down";
      splitId: string;
    };

function axisUnits(node: SplitNode, axis: SplitDirection): number {
  if (node.type === "leaf") return 1;
  const first = axisUnits(node.first, axis);
  const second = axisUnits(node.second, axis);
  return node.direction === axis ? first + second : Math.max(first, second);
}

export function equalizeWindowLayout(node: SplitNode): SplitNode {
  if (node.type === "leaf") return node;
  const first = equalizeWindowLayout(node.first);
  const second = equalizeWindowLayout(node.second);
  const firstUnits = axisUnits(first, node.direction);
  const ratio = firstUnits / (firstUnits + axisUnits(second, node.direction));
  return ratio === node.ratio && first === node.first && second === node.second
    ? node
    : { ...node, ratio, first, second };
}

export function updateSplitRatio(
  node: SplitNode,
  id: string,
  ratio: number,
): SplitNode {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error("Split ratio must be between 0 and 1");
  }
  if (node.type === "leaf") return node;
  if (node.id === id) return node.ratio === ratio ? node : { ...node, ratio };
  const first = updateSplitRatio(node.first, id, ratio);
  const second = updateSplitRatio(node.second, id, ratio);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function clampSplitRatio(
  node: Extract<SplitNode, { type: "split" }>,
  ratio: number,
  spanPx: number,
): number {
  const available = Math.max(1, spanPx - SPLIT_GAP_PX);
  const minLeaf =
    node.direction === "vertical" ? MIN_WINDOW_WIDTH_PX : MIN_WINDOW_HEIGHT_PX;
  const firstUnits = axisUnits(node.first, node.direction);
  const secondUnits = axisUnits(node.second, node.direction);
  const firstMin = firstUnits * minLeaf + (firstUnits - 1) * SPLIT_GAP_PX;
  const secondMin = secondUnits * minLeaf + (secondUnits - 1) * SPLIT_GAP_PX;
  const scale = Math.min(1, available / (firstMin + secondMin));
  return Math.max(
    (firstMin * scale) / available,
    Math.min(1 - (secondMin * scale) / available, ratio),
  );
}

/** Resize the nearest split boundary on this axis, leaving orthogonal splits intact. */
export function resizeWindowLayout(
  root: SplitNode,
  windowId: string,
  axis: SplitDirection,
  deltaPx: number,
  extent: LayoutExtent,
): SplitNode {
  if (
    ![deltaPx, extent.width, extent.height].every(Number.isFinite) ||
    extent.width <= 0 ||
    extent.height <= 0
  ) {
    throw new Error(
      "Window resize requires finite dimensions and a positive extent",
    );
  }
  const visit = (
    node: SplitNode,
    size: LayoutExtent,
  ): { contains: boolean; boundary: boolean; node: SplitNode } => {
    if (node.type === "leaf")
      return { contains: node.windowId === windowId, boundary: false, node };
    const span = node.direction === "vertical" ? size.width : size.height;
    const available = Math.max(1, span - SPLIT_GAP_PX);
    const firstSize = {
      ...size,
      [node.direction === "vertical" ? "width" : "height"]:
        available * node.ratio,
    };
    const secondSize = {
      ...size,
      [node.direction === "vertical" ? "width" : "height"]:
        available * (1 - node.ratio),
    };
    const first = visit(node.first, firstSize);
    const second = visit(node.second, secondSize);
    const contains = first.contains || second.contains;
    const boundary = first.boundary || second.boundary;
    if (contains && !boundary && node.direction === axis) {
      const ratio = clampSplitRatio(
        node,
        node.ratio + (first.contains ? deltaPx : -deltaPx) / available,
        span,
      );
      return {
        contains,
        boundary: true,
        node: ratio === node.ratio ? node : { ...node, ratio },
      };
    }
    return {
      contains,
      boundary,
      node:
        first.node === node.first && second.node === node.second
          ? node
          : { ...node, first: first.node, second: second.node },
    };
  };
  const result = visit(root, extent);
  if (!result.contains) throw new Error(`Unknown window: ${windowId}`);
  return result.node;
}
