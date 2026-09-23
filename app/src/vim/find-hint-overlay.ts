import type { EditorView } from "@tiptap/pm/view";
import { measureVimCharacterRangeCell } from "./caret-geometry";
import type { VimFindHint } from "./find-character";

/** Temporary, Window-local labels painted outside the ProseMirror document. */
export class VimFindHintOverlay {
  private view: EditorView;
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly scrollRoot: HTMLElement | null;
  private hints: readonly VimFindHint[] = [];
  private typed = "";
  private frame: number | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.host = view.dom.parentElement ?? view.dom;
    this.host.classList.add("memoka-editor-host");
    this.root = view.dom.ownerDocument.createElement("div");
    this.root.className = "memoka-find-hint-overlay";
    this.root.setAttribute("aria-hidden", "true");
    this.host.append(this.root);
    this.scrollRoot = view.dom.closest<HTMLElement>(".editor-scroll");
  }

  update(view: EditorView, hints: readonly VimFindHint[], typed: string): void {
    this.view = view;
    this.hints = hints;
    this.typed = typed;
    this.render();
  }

  refreshLayout(): void {
    if (this.hints.length === 0 || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.root.remove();
    if (
      !this.host.querySelector(
        ".memoka-logical-line-gutter, .memoka-visual-line-overlay, .memoka-find-hint-overlay",
      )
    )
      this.host.classList.remove("memoka-editor-host");
  }

  private render(): void {
    if (
      this.view.isDestroyed ||
      !this.host.isConnected ||
      this.hints.length === 0
    ) {
      this.root.replaceChildren();
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const measuredViewport = this.scrollRoot?.getBoundingClientRect();
    const viewport =
      measuredViewport &&
      measuredViewport.width > 0 &&
      measuredViewport.height > 0
        ? measuredViewport
        : null;
    const labels: HTMLSpanElement[] = [];
    for (const hint of this.hints) {
      if (!hint.label.startsWith(this.typed)) continue;
      let coords: { left: number; top: number };
      try {
        coords =
          measureVimCharacterRangeCell(this.view, hint.position) ??
          this.view.coordsAtPos(hint.position, 1);
      } catch {
        continue;
      }
      if (
        viewport &&
        (coords.top < viewport.top ||
          coords.top >= viewport.bottom ||
          coords.left < viewport.left ||
          coords.left >= viewport.right)
      )
        continue;
      const label = this.root.ownerDocument.createElement("span");
      label.className = "memoka-find-hint";
      label.dataset.vimFindHint = hint.label;
      if (hint.label.length > 1 && this.typed.length > 0) {
        const typed = this.root.ownerDocument.createElement("span");
        typed.className = "memoka-find-hint-typed";
        typed.textContent = hint.label.slice(0, this.typed.length);
        label.append(typed, hint.label.slice(this.typed.length));
      } else {
        label.textContent = hint.label;
      }
      label.style.left = `${coords.left - hostRect.left}px`;
      label.style.top = `${coords.top - hostRect.top}px`;
      labels.push(label);
    }
    this.root.replaceChildren(...labels);
  }
}
