import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  filterInternalLinkCandidates,
  type InternalLinkCandidate,
} from "../core/internal-link-candidates";

const MAX_QUERY_LENGTH = 200;
const INTERNAL_LINK_PREFIX_LENGTH = 2;
const DEFAULT_RESULT_LIMIT = 8;

interface InternalLinkTrigger {
  from: number;
  to: number;
  query: string;
}

export interface InternalLinkCompletionAnchor {
  left: number;
  top: number;
}

export interface InternalLinkCompletionSnapshot {
  popupId: string;
  query: string;
  from: number;
  to: number;
  selectedIndex: number;
  candidates: InternalLinkCandidate[];
  anchor: InternalLinkCompletionAnchor;
}

export interface InternalLinkCompletionOptions {
  popupId: string;
  getCandidates: () => readonly InternalLinkCandidate[];
  onUpdate?: (snapshot: InternalLinkCompletionSnapshot | null) => void;
  resultLimit?: number;
}

export class InternalLinkCompletion {
  private value: InternalLinkCompletionSnapshot | null = null;
  private dismissedSignature: string | null = null;
  private view: EditorView | null = null;
  private readonly resultLimit: number;

  constructor(private readonly options: InternalLinkCompletionOptions) {
    this.resultLimit = options.resultLimit ?? DEFAULT_RESULT_LIMIT;
    if (!Number.isSafeInteger(this.resultLimit) || this.resultLimit < 1) {
      throw new Error("Internal Link result limit must be positive");
    }
  }

  get snapshot(): InternalLinkCompletionSnapshot | null {
    return this.value;
  }

  refresh(view: EditorView, active: boolean, composing: boolean): void {
    this.view = view;
    if (!active || composing || !view.hasFocus()) {
      this.close();
      return;
    }
    const trigger = internalLinkTrigger(view);
    if (!trigger) {
      this.dismissedSignature = null;
      this.close();
      return;
    }
    const signature = triggerSignature(trigger);
    if (signature === this.dismissedSignature) {
      this.close();
      return;
    }
    this.dismissedSignature = null;
    const candidates = filterInternalLinkCandidates(
      this.options.getCandidates(),
      trigger.query,
      this.resultLimit,
    );
    const selectedSectionId =
      this.value?.candidates[this.value.selectedIndex]?.sectionId;
    const preservedIndex = selectedSectionId
      ? candidates.findIndex(({ sectionId }) => sectionId === selectedSectionId)
      : -1;
    this.publish({
      popupId: this.options.popupId,
      ...trigger,
      selectedIndex: preservedIndex >= 0 ? preservedIndex : 0,
      candidates,
      anchor: completionAnchor(view, trigger.to),
    });
  }

  refreshLayout(): void {
    const view = this.view;
    const current = this.value;
    if (!view || !current || view.isDestroyed) return;
    this.publish({
      ...current,
      anchor: completionAnchor(view, current.to),
    });
  }

  handleKeyDown(
    view: EditorView,
    event: KeyboardEvent,
    active: boolean,
    composing: boolean,
  ): boolean {
    if (
      !active ||
      composing ||
      event.isComposing ||
      !this.value ||
      view !== this.view
    ) {
      return false;
    }
    if (
      event.key === "ArrowDown" ||
      (event.ctrlKey && event.key.toLowerCase() === "n")
    ) {
      this.moveSelection(1);
      return true;
    }
    if (
      event.key === "ArrowUp" ||
      (event.ctrlKey && event.key.toLowerCase() === "p")
    ) {
      this.moveSelection(-1);
      return true;
    }
    if (
      (event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey) ||
      (event.key === "Tab" && !event.shiftKey)
    ) {
      const candidate = this.value.candidates[this.value.selectedIndex];
      if (candidate) this.accept(view, candidate.sectionId);
      return true;
    }
    if (event.key === "Escape") {
      this.dismiss();
      return true;
    }
    return false;
  }

  accept(view: EditorView, sectionId: string): boolean {
    if (view.isDestroyed || view !== this.view) return false;
    const trigger = internalLinkTrigger(view);
    if (!trigger || !sameTrigger(this.value, trigger)) {
      this.close();
      return false;
    }
    const candidate = filterInternalLinkCandidates(
      this.options.getCandidates(),
      trigger.query,
      this.resultLimit,
    ).find((item) => item.sectionId === sectionId);
    const linkType = view.state.schema.nodes.internalSectionLink;
    if (!candidate || !linkType) {
      this.refresh(view, true, false);
      return false;
    }
    const link = linkType.create(
      { targetSectionId: candidate.sectionId },
      view.state.schema.text(candidate.title),
    );
    const transaction = view.state.tr.replaceWith(
      trigger.from,
      trigger.to,
      link,
    );
    const afterLink = trigger.from + link.nodeSize;
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(afterLink), 1),
    );
    transaction.setMeta("memokaCommand", "internal-link.insert");
    this.dismissedSignature = null;
    this.close();
    view.dispatch(transaction.scrollIntoView());
    view.focus();
    return true;
  }

  dismiss(): boolean {
    if (!this.value) return false;
    this.dismissedSignature = triggerSignature(this.value);
    this.close();
    return true;
  }

  close(): void {
    if (!this.value) return;
    this.value = null;
    this.updateAria(null);
    this.options.onUpdate?.(null);
  }

  destroy(): void {
    this.value = null;
    this.dismissedSignature = null;
    this.updateAria(null);
    this.view = null;
  }

  private moveSelection(delta: number): void {
    const current = this.value;
    if (!current || current.candidates.length === 0) return;
    const length = current.candidates.length;
    const selectedIndex = (current.selectedIndex + delta + length) % length;
    this.publish({ ...current, selectedIndex });
  }

  private publish(snapshot: InternalLinkCompletionSnapshot): void {
    this.value = snapshot;
    this.updateAria(snapshot);
    this.options.onUpdate?.(snapshot);
  }

  private updateAria(snapshot: InternalLinkCompletionSnapshot | null): void {
    const dom = this.view?.dom;
    if (!dom) return;
    dom.setAttribute("aria-expanded", snapshot ? "true" : "false");
    if (snapshot) {
      dom.setAttribute("aria-controls", snapshot.popupId);
      dom.setAttribute("aria-autocomplete", "list");
      const selected = snapshot.candidates[snapshot.selectedIndex];
      if (selected) {
        dom.setAttribute(
          "aria-activedescendant",
          completionOptionId(snapshot.popupId, selected.sectionId),
        );
      } else {
        dom.removeAttribute("aria-activedescendant");
      }
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-autocomplete");
      dom.removeAttribute("aria-activedescendant");
    }
  }
}

export function completionOptionId(popupId: string, sectionId: string): string {
  return `${popupId}-option-${sectionId}`;
}

function internalLinkTrigger(view: EditorView): InternalLinkTrigger | null {
  const selection = view.state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const cursor = selection.head;
  const resolved = view.state.doc.resolve(cursor);
  const parent = resolved.parent;
  if (
    !parent.isTextblock ||
    parent.type.spec.code ||
    parent.type.name === "sourceBlock" ||
    parent.type.name === "internalSectionLink"
  ) {
    return null;
  }
  // Completion only accepts `[[` plus MAX_QUERY_LENGTH characters. Reading
  // the whole textblock prefix here made every Insert transaction linear in
  // the paragraph length even when no trigger was present.
  const scanFrom = Math.max(
    0,
    resolved.parentOffset - (MAX_QUERY_LENGTH + INTERNAL_LINK_PREFIX_LENGTH),
  );
  const before = parent.textBetween(
    scanFrom,
    resolved.parentOffset,
    "\n",
    "\ufffc",
  );
  const match = before.match(
    new RegExp(`\\[\\[([^\\[\\]\\n\\ufffc]{0,${MAX_QUERY_LENGTH}})$`, "u"),
  );
  if (!match) return null;
  const token = match[0];
  return {
    from: cursor - token.length,
    to: cursor,
    query: match[1] ?? "",
  };
}

function sameTrigger(
  current: InternalLinkCompletionSnapshot | null,
  trigger: InternalLinkTrigger,
): boolean {
  return Boolean(
    current &&
    current.from === trigger.from &&
    current.to === trigger.to &&
    current.query === trigger.query,
  );
}

function triggerSignature(trigger: InternalLinkTrigger): string {
  return `${trigger.from}:${trigger.to}:${trigger.query}`;
}

function completionAnchor(
  view: EditorView,
  position: number,
): InternalLinkCompletionAnchor {
  let left = 8;
  let top = 8;
  let caretTop = 8;
  try {
    const rect = view.coordsAtPos(position);
    left = rect.left;
    top = rect.bottom + 6;
    caretTop = rect.top;
  } catch {
    const rect = view.dom.getBoundingClientRect();
    left = rect.left;
    top = rect.top;
    caretTop = rect.top;
  }
  const width = 360;
  const height = 286;
  const viewportWidth = Math.max(document.documentElement.clientWidth, 400);
  const viewportHeight = Math.max(document.documentElement.clientHeight, 320);
  return {
    left: Math.max(8, Math.min(left, viewportWidth - width - 8)),
    top:
      top + height <= viewportHeight
        ? Math.max(8, top)
        : Math.max(8, caretTop - height - 6),
  };
}
