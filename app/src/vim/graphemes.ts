import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { textblockIconTokens } from "../core/symbols";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const startsByNode = new WeakMap<ProseMirrorNode, number[]>();

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/** UTF-16 offsets are retained for ProseMirror; only valid caret boundaries change. */
export function graphemeStarts(text: string): number[] {
  return Array.from(segmenter.segment(text), ({ index }) => index);
}

export function textblockGraphemeStarts(node: ProseMirrorNode): number[] {
  const cached = startsByNode.get(node);
  if (cached) return cached;
  let text = "";
  node.forEach((child) => {
    text += child.isText ? child.text! : "\n".repeat(child.nodeSize);
  });
  const tokens = textblockIconTokens(node);
  let tokenIndex = 0;
  const starts = graphemeStarts(text).filter((offset) => {
    while (tokens[tokenIndex] && tokens[tokenIndex]!.to <= offset)
      tokenIndex += 1;
    const token = tokens[tokenIndex];
    return !token || offset <= token.from;
  });
  startsByNode.set(node, starts);
  return starts;
}

function lowerBound(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function graphemeEnd(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(position);
  if (!resolved.parent.isTextblock) return position + 1;
  const offset = resolved.parentOffset;
  const starts = textblockGraphemeStarts(resolved.parent);
  const next = starts[lowerBound(starts, offset + 1)];
  return resolved.start() + (next ?? resolved.parent.content.size);
}

export function previousGraphemeStart(
  doc: ProseMirrorNode,
  position: number,
): number {
  const resolved = doc.resolve(position);
  const starts = textblockGraphemeStarts(resolved.parent);
  const previous = starts[lowerBound(starts, resolved.parentOffset) - 1];
  return resolved.start() + (previous ?? 0);
}
