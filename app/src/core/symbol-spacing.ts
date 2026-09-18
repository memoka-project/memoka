import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { iconTokens, textblockIconTokens, type IconToken } from "./symbols";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u20e3/u;
export const SYMBOL_SPACE_CLASS = "memoka-symbol-space";
interface SymbolAnalysis {
  readonly spacing: readonly number[];
  readonly symbols: readonly { from: number; to: number }[];
}

/** One gap per visible boundary; never inside a ZWJ/flag/keycap sequence. */
export function symbolSpacingOffsets(
  text: string,
  icons: readonly IconToken[] = iconTokens(text),
): readonly number[] {
  return analyzeSymbolText(text, icons).spacing;
}

function analyzeSymbolText(
  text: string,
  icons: readonly IconToken[],
): SymbolAnalysis {
  if (!icons.length && !emoji.test(text)) return { spacing: [], symbols: [] };
  const offsets: number[] = [];
  const symbols: { from: number; to: number }[] = [];
  let previous: { symbol: boolean; whitespace: boolean } | null = null;
  const append = (from: number, value: string, symbol: boolean) => {
    if (symbol) symbols.push({ from, to: from + value.length });
    const whitespace = /\s/u.test(value);
    if (
      previous &&
      !previous.whitespace &&
      !whitespace &&
      (previous.symbol || symbol)
    )
      offsets.push(from);
    previous = { symbol, whitespace };
  };
  const appendText = (from: number, to: number) => {
    for (const { segment, index } of segmenter.segment(text.slice(from, to))) {
      // VS15 explicitly requests text rather than emoji presentation.
      append(
        from + index,
        segment,
        emoji.test(segment) && !segment.includes("\ufe0e"),
      );
    }
  };
  let cursor = 0;
  for (const icon of icons) {
    appendText(cursor, icon.from);
    append(icon.from, text.slice(icon.from, icon.to), true);
    cursor = icon.to;
  }
  appendText(cursor, text.length);
  return { spacing: offsets, symbols };
}

const cache = new WeakMap<ProseMirrorNode, SymbolAnalysis>();
export function textblockSymbolSpacingOffsets(
  node: ProseMirrorNode,
): readonly number[] {
  return textblockSymbolAnalysis(node).spacing;
}

export function textblockSymbolRanges(
  node: ProseMirrorNode,
): SymbolAnalysis["symbols"] {
  return textblockSymbolAnalysis(node).symbols;
}

function textblockSymbolAnalysis(node: ProseMirrorNode): SymbolAnalysis {
  const cached = cache.get(node);
  if (cached) return cached;
  let text = "";
  if (node.isTextblock && !node.type.spec.code) {
    node.forEach((child) => {
      // Inline atoms occupy visible space; code padding and Hard Breaks are barriers.
      text +=
        child.isText && !child.marks.some((mark) => mark.type.name === "code")
          ? child.text!
          : child.isInline &&
              child.isAtom &&
              !child.isText &&
              child.type.name !== "hardBreak"
            ? "\ufffc".repeat(child.nodeSize)
            : "\n".repeat(child.nodeSize);
    });
  }
  const result = analyzeSymbolText(text, textblockIconTokens(node));
  cache.set(node, result);
  return result;
}
