import type { EditorView } from "@tiptap/pm/view";

export type VimViewportAlignment = "center" | "top" | "bottom";
export const VIM_VIEWPORT_ALIGNMENT_META = "memoka-vim-viewport-alignment";

/** Align the current display row without moving its document position. The
 * adapter reuses this after deferred layout until a new user action takes over. */
export function alignVimViewport(
  view: Pick<EditorView, "coordsAtPos">,
  scroll: HTMLElement,
  cursor: number,
  alignment: VimViewportAlignment,
): boolean {
  const viewport = scroll.getBoundingClientRect();
  if (viewport.height <= 0) return false;
  try {
    const caret = view.coordsAtPos(cursor, 1);
    const margin = Math.min(5, viewport.height / 4);
    const height = Math.min(
      caret.bottom - caret.top,
      viewport.height - 2 * margin,
    );
    const target =
      alignment === "center"
        ? viewport.top + (viewport.height - height) / 2
        : alignment === "top"
          ? viewport.top + margin
          : viewport.bottom - margin - height;
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const destination = Math.max(
      0,
      Math.min(maximum, Math.round(scroll.scrollTop + caret.top - target)),
    );
    if (Math.abs(scroll.scrollTop - destination) > 0.5)
      scroll.scrollTop = destination;
    return true;
  } catch {
    // A transient NodeView replacement may not have measurable coordinates yet.
    return false;
  }
}
