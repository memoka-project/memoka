import type { EditorView } from "@tiptap/pm/view";
import { defaultVimBlockSemantics } from "./block-semantics";
import { graphemes } from "./graphemes";
import { noteFuzzyWords, type NoteFuzzyWord } from "../core/note-fuzzy-search";

/** Collect only mounted, visible logical lines from the active Editor pane. */
export function visibleNoteFuzzyWords(view: EditorView): NoteFuzzyWord[] {
  const scroll = view.dom.closest<HTMLElement>(".editor-scroll");
  const viewport = scroll?.getBoundingClientRect();
  let from = 0;
  let to = view.state.doc.content.size;
  if (viewport && viewport.height > 0) {
    try {
      from =
        view.posAtCoords({
          left: viewport.left + 1,
          top: viewport.top + 1,
        })?.pos ?? from;
      to =
        view.posAtCoords({
          left: viewport.right - 1,
          top: viewport.bottom - 1,
        })?.pos ?? to;
    } catch {
      // The overlay's geometry check still clips candidates during remounts.
    }
  }
  const words: NoteFuzzyWord[] = [];
  for (const line of defaultVimBlockSemantics.logicalLines({
    state: view.state,
  })) {
    if (line.kind === "block-atom" || line.to < from || line.from > to)
      continue;
    const positions = line.cursorPositions;
    const lineEnd = line.blockNodeName === "tableRow" ? line.blockTo : line.to;
    const characters = positions.map((position, index) => {
      const next = Math.min(positions[index + 1] ?? lineEnd, lineEnd);
      if (next <= position) return "";
      return (
        graphemes(
          view.state.doc.textBetween(position, next, "", "\uFFFC"),
        )[0] ?? ""
      );
    });
    const hardBoundaryBefore = positions.map(
      (position, index) =>
        index > 0 &&
        position !==
          (positions[index - 1] ?? 0) + (characters[index - 1] ?? "").length,
    );
    words.push(...noteFuzzyWords(characters, positions, hardBoundaryBefore));
  }
  return words;
}
