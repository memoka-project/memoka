import type { EditorView } from "@tiptap/pm/view";
import type { VimCaretGeometry } from "./caret-geometry";
import { defaultVimBlockSemantics } from "./block-semantics";

/** Reveal text context without moving the selection or measuring other blocks. */
export function revealNormalLogicalLine(
  view: Pick<EditorView, "state" | "coordsAtPos">,
  scroll: HTMLElement,
  cursor: number,
): boolean {
  const viewport = scroll.getBoundingClientRect();
  if (viewport.height <= 10) return false;
  const resolved = view.state.doc.resolve(cursor);
  if (!resolved.parent.isTextblock || resolved.depth === 0) return false;
  const lines = defaultVimBlockSemantics.logicalLineAnchorsForNode(
    view,
    resolved.parent,
    resolved.before(),
  );
  const line = lines?.find(({ from, to }) => cursor >= from && cursor <= to);
  if (!line || line.kind === "block-atom") return false;
  try {
    const first = view.coordsAtPos(line.from, 1);
    const last = view.coordsAtPos(line.to, -1);
    const caret = view.coordsAtPos(cursor, 1);
    const available = viewport.height - 10;
    const fits = last.bottom - first.top <= available;
    const top = fits ? first.top : caret.top;
    let bottom = last.bottom;
    if (!fits && last.top > caret.top) {
      // Locate the next display row in logarithmic probes, including actual
      // line-height spacing rather than assuming two glyph heights suffice.
      let low = cursor + 1;
      let high = line.to;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (view.coordsAtPos(middle, 1).top > caret.top) high = middle;
        else low = middle + 1;
      }
      bottom = view.coordsAtPos(low, 1).bottom;
    }
    // At the beginning of an oversized line, show as much continuation as fits.
    const delta =
      !fits && caret.top === first.top
        ? top - viewport.top - 5
        : top < viewport.top + 5
          ? top - viewport.top - 5
          : bottom > viewport.bottom - 5
            ? Math.min(bottom - viewport.bottom + 5, top - viewport.top - 5)
            : 0;
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (delta)
      scroll.scrollTop = Math.max(
        0,
        Math.min(maximum, Math.round(scroll.scrollTop + delta)),
      );
    return true;
  } catch {
    return false;
  }
}

/** A selection correction owns the viewport, not a request to reveal a caret. */
export const VIM_VIEWPORT_CARET_META = "memoka-vim-viewport-caret";

export function caretFitsViewport(
  caret: VimCaretGeometry,
  viewport: DOMRect,
): boolean {
  return (
    caret.height > 0 &&
    caret.top >= viewport.top &&
    caret.top + caret.height <= viewport.bottom
  );
}

/** Probe inward from the clipped edge. Hit testing alone is insufficient:
 * margins can resolve to offscreen content, and Normal/Visual normalize hits
 * onto another character (notably at wrapped line ends). Validate the actual
 * caret geometry BEFORE dispatching, so rejected hits never activate chunks or
 * produce intermediate selections/scroll anchoring. Work is viewport-bounded,
 * with no traversal/measurement of the whole note. */
export function findViewportCaretPosition(
  view: Pick<EditorView, "dom" | "posAtCoords" | "state">,
  viewport: DOMRect,
  caret: VimCaretGeometry,
  resolve: (position: number) => number | null,
  measure: (position: number) => VimCaretGeometry | null,
): number | null {
  const editorRect = view.dom.getBoundingClientRect();
  const left = Math.max(viewport.left + 1, editorRect.left + 1);
  const right = Math.min(viewport.right - 1, editorRect.right - 1);
  if (right < left || viewport.height <= 2) return null;
  const probes = [
    Math.max(left, Math.min(right, caret.left + caret.width / 2)),
    left,
    (left + right) / 2,
  ];
  const above = caret.top < viewport.top;
  const step = Math.max(
    4,
    Math.min(12, caret.height / 2),
    viewport.height / 96,
  );
  const visited = new Set<number>();
  let visibleAtom: number | null = null;
  for (let inset = 1; inset < viewport.height; inset += step) {
    const top = above ? viewport.top + inset : viewport.bottom - inset;
    for (const x of probes) {
      try {
        const hit = view.posAtCoords({ left: x, top });
        const position = hit ? resolve(hit.pos) : null;
        if (position === null || visited.has(position)) continue;
        visited.add(position);
        const candidate = measure(position);
        if (candidate && caretFitsViewport(candidate, viewport))
          return position;
        // When the viewport is filled by an oversized image, selecting its
        // visible frame is preferable to leaving the old caret offscreen.
        const node = view.state.doc.nodeAt(position);
        if (
          visibleAtom === null &&
          candidate &&
          node?.isAtom &&
          node.isBlock &&
          candidate.height > viewport.height &&
          candidate.top < viewport.bottom &&
          candidate.top + candidate.height > viewport.top
        )
          visibleAtom = position;
      } catch {
        // A NodeView can be temporarily unmeasurable while chunks are replaced.
        // The chunk-layout notification will retry after rendering settles.
      }
    }
  }
  return visibleAtom;
}
