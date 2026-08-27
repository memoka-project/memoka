import type { EditorState } from "@tiptap/pm/state";
import {
  Decoration,
  DecorationSet,
  type DecorationSource,
} from "@tiptap/pm/view";
import {
  visualLineNodeRanges,
  visualLineTextRanges,
  type VimVisualLineState,
} from "./editor-commands";

export function createVisualLineDecorations(
  state: EditorState,
  visualLine: VimVisualLineState | null,
): DecorationSet | null {
  if (!visualLine) return null;
  const decorations: Decoration[] = visualLineNodeRanges(
    { state },
    visualLine,
  ).map(({ from, to, kind, nodeName }) =>
    Decoration.node(from, to, {
      class:
        kind === "table-row"
          ? "memoka-visual-line-selected memoka-table-row-selected"
          : "memoka-visual-line-selected",
      "data-vim-visual-line": kind,
      "data-vim-node-name": nodeName,
    }),
  );
  for (const { from, to, kind, nodeName } of visualLineTextRanges(
    { state },
    visualLine,
  )) {
    if (from >= to) continue;
    decorations.push(
      Decoration.inline(from, to, {
        class: "memoka-visual-line-text-selected",
        "data-vim-visual-line": kind,
        "data-vim-node-name": nodeName,
      }),
    );
  }
  return decorations.length > 0
    ? DecorationSet.create(state.doc, decorations)
    : null;
}

export function combineDecorations(
  state: EditorState,
  sources: readonly (DecorationSource | null | undefined)[],
): DecorationSource | null {
  const activeSources = sources.filter(
    (source): source is DecorationSource =>
      source !== null && source !== undefined,
  );
  if (activeSources.length === 0) return null;
  if (activeSources.length === 1) return activeSources[0];

  const decorations: Decoration[] = [];
  for (const source of activeSources) {
    source.forEachSet((set) => decorations.push(...set.find()));
  }
  return DecorationSet.create(state.doc, decorations);
}
