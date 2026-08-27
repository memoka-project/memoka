import type { EditorView } from "@tiptap/pm/view";
import {
  visualLineTextRanges,
  type VimVisualLineState,
  type VimVisualLineTextRange,
} from "./editor-commands";

interface VisualRowRect {
  top: number;
  bottom: number;
  height: number;
}

const OVERLAY_OVERSCAN_PX = 80;

function asHTMLElement(node: Node | null): HTMLElement | null {
  return node?.nodeType === 1 ? (node as HTMLElement) : null;
}

function normalizedRow(rect: {
  top: number;
  bottom: number;
  height?: number;
}): VisualRowRect {
  const height = Math.max(1, rect.height ?? rect.bottom - rect.top);
  return { top: rect.top, bottom: rect.top + height, height };
}

function rowRectsForRange(
  view: EditorView,
  range: VimVisualLineTextRange,
): VisualRowRect[] {
  if (range.from < range.to) {
    try {
      const start = view.domAtPos(range.from, 1);
      const end = view.domAtPos(range.to, -1);
      const domRange = view.dom.ownerDocument.createRange();
      domRange.setStart(start.node, start.offset);
      domRange.setEnd(end.node, end.offset);
      const fragments = Array.from(domRange.getClientRects())
        .filter((rect) => rect.height > 0)
        .sort((left, right) => left.top - right.top || left.left - right.left);
      domRange.detach?.();
      const rows: VisualRowRect[] = [];
      for (const fragment of fragments) {
        const row = normalizedRow(fragment);
        const current = rows.at(-1);
        if (
          current &&
          Math.abs(
            (current.top + current.bottom) / 2 - (row.top + row.bottom) / 2,
          ) < Math.max(2, Math.min(current.height, row.height) / 2)
        ) {
          current.top = Math.min(current.top, row.top);
          current.bottom = Math.max(current.bottom, row.bottom);
          current.height = current.bottom - current.top;
        } else {
          rows.push(row);
        }
      }
      if (rows.length > 0) return rows;
    } catch {
      // Empty or temporarily detached lines use the caret-coordinate fallback.
    }
  }
  try {
    return [normalizedRow(view.coordsAtPos(range.from, 1))];
  } catch {
    return [];
  }
}

function intersectsViewport(
  rect: Pick<DOMRect, "top" | "bottom">,
  viewport: DOMRect | null,
): boolean {
  return (
    !viewport ||
    (rect.bottom >= viewport.top - OVERLAY_OVERSCAN_PX &&
      rect.top <= viewport.bottom + OVERLAY_OVERSCAN_PX)
  );
}

export class VimVisualLineOverlay {
  private view: EditorView;
  private visualLine: VimVisualLineState | null;
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly scrollRoot: HTMLElement | null;
  private readonly resizeObserver: ResizeObserver | null;
  private frame: number | null = null;

  constructor(view: EditorView, visualLine: VimVisualLineState | null) {
    this.view = view;
    this.visualLine = visualLine;
    this.host = view.dom.parentElement ?? view.dom;
    this.host.classList.add("memoka-editor-host");
    this.root = view.dom.ownerDocument.createElement("div");
    this.root.className = "memoka-visual-line-overlay";
    this.root.setAttribute("aria-hidden", "true");
    this.host.append(this.root);
    this.scrollRoot = view.dom.closest<HTMLElement>(".editor-scroll");
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(view.dom);
    } else {
      this.resizeObserver = null;
    }
    if (visualLine) this.schedule();
  }

  update(view: EditorView, visualLine: VimVisualLineState | null): void {
    this.view = view;
    this.visualLine = visualLine;
    if (!visualLine) {
      if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.root.replaceChildren();
      return;
    }
    this.schedule();
  }

  refreshLayout(): void {
    if (this.visualLine) this.schedule();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.root.remove();
    if (
      !this.host.querySelector(
        ".memoka-logical-line-gutter, .memoka-visual-line-overlay",
      )
    ) {
      this.host.classList.remove("memoka-editor-host");
    }
  }

  private schedule(): void {
    if (!this.visualLine) return;
    const rangePrototype =
      this.view.dom.ownerDocument.defaultView?.Range?.prototype;
    if (typeof rangePrototype?.getClientRects !== "function") {
      this.render();
      return;
    }
    // Paint the latest active Visual-line state in the earliest pending frame.
    // Normal and Insert transactions do not schedule this dormant overlay.
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  private render(): void {
    if (this.view.isDestroyed || !this.host.isConnected || !this.visualLine) {
      this.root.replaceChildren();
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const viewport = this.scrollRoot?.getBoundingClientRect() ?? null;
    const rows: HTMLDivElement[] = [];
    for (const range of visualLineTextRanges(
      { state: this.view.state },
      this.visualLine,
    )) {
      const block = asHTMLElement(this.view.nodeDOM(range.blockPosition));
      if (!block) continue;
      const blockRect = block.getBoundingClientRect();
      if (!intersectsViewport(blockRect, viewport)) continue;
      for (const rect of rowRectsForRange(this.view, range)) {
        if (!intersectsViewport(rect, viewport)) continue;
        const row = this.root.ownerDocument.createElement("div");
        row.className = "memoka-visual-line-overlay-row";
        row.dataset.vimVisualLine = range.kind;
        row.dataset.vimNodeName = range.nodeName;
        row.style.left = `${blockRect.left - hostRect.left}px`;
        row.style.top = `${rect.top - hostRect.top}px`;
        row.style.width = `${Math.max(1, blockRect.width)}px`;
        row.style.height = `${Math.max(1, rect.height)}px`;
        rows.push(row);
      }
    }
    this.root.replaceChildren(...rows);
  }
}
