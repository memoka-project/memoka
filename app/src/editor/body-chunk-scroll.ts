import type { EditorView } from "@tiptap/pm/view";
import { BODY_CHUNK_NODE, SECTION_HEADER_NODE } from "../core/section-model";

export interface BodyChunkScrollAnchor {
  readonly position: number;
  readonly top: number;
  readonly scrollRoot: HTMLElement;
}

/** Capture a stable block boundary before virtualized DOM is replaced.
 * A character inside a chunk is not a stable DOM anchor: the static NodeView
 * has no contentDOM. Its outer boundary (or the Section header) survives at
 * the same document position even when that NodeView is recreated. */
export function captureBodyChunkScrollAnchor(
  view: EditorView,
  preferredPosition?: number,
): BodyChunkScrollAnchor | null {
  const scrollRoot = view.dom.closest<HTMLElement>(".editor-scroll");
  if (!scrollRoot || scrollRoot.clientHeight <= 0) return null;
  const viewport = scrollRoot.getBoundingClientRect();
  const capture = (cursor: number): BodyChunkScrollAnchor | null => {
    const $head = view.state.doc.resolve(cursor);
    for (let depth = $head.depth; depth > 0; depth--) {
      const name = $head.node(depth).type.name;
      if (name !== BODY_CHUNK_NODE && name !== SECTION_HEADER_NODE) continue;
      const position = $head.before(depth);
      const element = view.nodeDOM(position);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      if (
        rect.height <= 0 ||
        !Number.isFinite(rect.top) ||
        rect.bottom <= viewport.top ||
        rect.top >= viewport.bottom
      )
        return null;
      return { position, top: rect.top, scrollRoot };
    }
    return null;
  };
  // During wheel correction, use the destination that is already visible, not
  // the old offscreen selection whose chunks are about to become static.
  const anchor = capture(preferredPosition ?? view.state.selection.head);
  if (anchor) return anchor;
  // IntersectionObserver may render chunks before the selection correction.
  // Anchor visible content in that case too; never anchor an offscreen caret.
  const editorRect = view.dom.getBoundingClientRect();
  const left =
    (Math.max(viewport.left, editorRect.left) +
      Math.min(viewport.right, editorRect.right)) /
    2;
  for (const fraction of [0.1, 0.5, 0.9]) {
    try {
      const hit = view.posAtCoords({
        left,
        top: viewport.top + viewport.height * fraction,
      });
      if (hit) {
        const visible = capture(hit.pos);
        if (visible) return visible;
      }
    } catch {
      // Transient WebKit layout gaps must not abort a selection transaction.
    }
  }
  return null;
}

/** Compensate only for virtualization layout changes, not for the motion's
 * destination. ProseMirror can then reveal that destination by the minimum
 * necessary amount. Using the live rectangle also avoids applying browser
 * scroll anchoring a second time when the engine already compensated. */
export function restoreBodyChunkScrollAnchor(
  view: EditorView,
  anchor: BodyChunkScrollAnchor,
): void {
  const element = view.nodeDOM(anchor.position);
  if (!(element instanceof HTMLElement)) return;
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0 || !Number.isFinite(rect.top)) return;
  const delta = rect.top - anchor.top;
  // WebKit can quantize scrollTop to integer pixels. Round symmetrically so
  // repeated j/k does not accumulate truncation error in one direction.
  if (Math.abs(delta) > 0.5)
    anchor.scrollRoot.scrollTop = Math.round(
      anchor.scrollRoot.scrollTop + delta,
    );
}
