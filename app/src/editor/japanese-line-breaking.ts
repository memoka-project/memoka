import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  getJapaneseSegmentationConfiguration,
  subscribeJapaneseSegmentationConfiguration,
  type JapaneseLineBreakSegmentationMode,
} from "../core/japanese-segmentation";
import {
  containsJapaneseText,
  fineJapanesePhraseBoundaries,
  japanesePhraseBoundaries,
  MAX_BUDOUX_TEXT_LENGTH,
} from "../vim/word-semantics";

const JAPANESE_LINE_BREAK_CLASS = "memoka-budoux-textblock";
const JAPANESE_LINE_BREAK_ATTRIBUTE = "data-memoka-budoux-break";
const VIEWPORT_MARGIN_PX = 160;

interface JapaneseLineBreakingState {
  readonly decorations: DecorationSet;
  readonly signature: string;
}

type JapaneseLineBreakingMeta = JapaneseLineBreakingState;

export interface JapaneseLineBreakPlan {
  readonly breakOffsets: readonly number[];
}

const japaneseLineBreakingKey = new PluginKey<JapaneseLineBreakingState>(
  "memokaJapaneseLineBreaking",
);
const lineBreakPlanCache = new WeakMap<
  ProseMirrorNode,
  Map<JapaneseLineBreakSegmentationMode, JapaneseLineBreakPlan | null>
>();

function isRenderedProseTextblock(node: ProseMirrorNode): boolean {
  return node.type.name === "paragraph" || node.type.name === "sectionHeader";
}

function hasCodeMark(node: ProseMirrorNode): boolean {
  return node.marks.some((mark) => mark.type.name === "code");
}

/**
 * Computes model-relative WBR positions for one rendered prose textblock.
 * Inline code, hard breaks, and inline atoms form barriers and are never
 * rewritten. The returned offsets are relative to the textblock's content.
 */
export function japaneseLineBreakPlan(
  node: ProseMirrorNode,
  mode: JapaneseLineBreakSegmentationMode = getJapaneseSegmentationConfiguration()
    .lineBreakSegmentation,
): JapaneseLineBreakPlan | null {
  const cached = lineBreakPlanCache.get(node);
  if (cached?.has(mode)) {
    return cached.get(mode) ?? null;
  }
  if (
    mode === "native" ||
    !isRenderedProseTextblock(node) ||
    node.type.spec.code ||
    node.textContent.length > MAX_BUDOUX_TEXT_LENGTH
  ) {
    const cache = cached ?? new Map();
    cache.set(mode, null);
    lineBreakPlanCache.set(node, cache);
    return null;
  }

  const breaks = new Set<number>();
  let hasJapaneseProse = false;
  let runStart = 0;
  let runText = "";

  const flush = (endOffset: number): void => {
    if (!runText) {
      runStart = endOffset;
      return;
    }
    if (containsJapaneseText(runText)) {
      hasJapaneseProse = true;
      const boundaries =
        (mode === "fine"
          ? fineJapanesePhraseBoundaries(runText)
          : japanesePhraseBoundaries(runText)) ?? [];
      for (const boundary of boundaries) {
        if (boundary <= 0 || boundary >= runText.length) continue;
        const before = runText.slice(boundary - 1, boundary);
        const after = runText.slice(boundary, boundary + 1);
        if (/\s/u.test(before) || /\s/u.test(after)) continue;
        breaks.add(runStart + boundary);
      }
    }
    runText = "";
    runStart = endOffset;
  };

  node.forEach((child, offset) => {
    if (child.isText && !hasCodeMark(child)) {
      if (!runText) runStart = offset;
      runText += child.text ?? "";
      return;
    }
    flush(offset);
    runStart = offset + child.nodeSize;
  });
  flush(node.content.size);

  const result = hasJapaneseProse
    ? { breakOffsets: [...breaks].sort((left, right) => left - right) }
    : null;
  const cache = cached ?? new Map();
  cache.set(mode, result);
  lineBreakPlanCache.set(node, cache);
  return result;
}

function decorationsForTextblock(
  node: ProseMirrorNode,
  nodePosition: number,
  mode: JapaneseLineBreakSegmentationMode,
): { decorations: Decoration[]; signature: string } | null {
  const plan = japaneseLineBreakPlan(node, mode);
  if (!plan) return null;
  const decorations: Decoration[] = [
    Decoration.node(
      nodePosition,
      nodePosition + node.nodeSize,
      { class: JAPANESE_LINE_BREAK_CLASS },
      { memokaBudouxTextblock: true },
    ),
  ];
  for (const offset of plan.breakOffsets) {
    const position = nodePosition + 1 + offset;
    decorations.push(
      Decoration.widget(
        position,
        (view) => {
          const element = view.dom.ownerDocument.createElement("wbr");
          element.setAttribute(JAPANESE_LINE_BREAK_ATTRIBUTE, "true");
          element.setAttribute("aria-hidden", "true");
          return element;
        },
        {
          key: `memoka-budoux:${position}`,
          side: -1,
          ignoreSelection: true,
        },
      ),
    );
  }
  return {
    decorations,
    signature: `${mode}:${nodePosition}:${node.nodeSize}:${plan.breakOffsets.join(",")}`,
  };
}

function textblockPositionAtDOM(
  view: EditorView,
  element: HTMLElement,
): number | null {
  let position: number;
  try {
    position = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  const resolved = view.state.doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (isRenderedProseTextblock(resolved.node(depth))) {
      return resolved.before(depth);
    }
  }
  if (resolved.nodeAfter && isRenderedProseTextblock(resolved.nodeAfter)) {
    return position;
  }
  if (resolved.nodeBefore && isRenderedProseTextblock(resolved.nodeBefore)) {
    return position - resolved.nodeBefore.nodeSize;
  }
  return null;
}

function intersectsViewport(
  element: HTMLElement,
  viewport: HTMLElement,
): boolean {
  const viewportRect = viewport.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  // jsdom and hidden test containers have no layout. Treat them as visible so
  // the extension remains deterministic in model/DOM integration tests.
  if (viewportRect.width <= 0 && viewportRect.height <= 0) return true;
  return (
    elementRect.bottom >= viewportRect.top - VIEWPORT_MARGIN_PX &&
    elementRect.top <= viewportRect.bottom + VIEWPORT_MARGIN_PX &&
    elementRect.right >= viewportRect.left &&
    elementRect.left <= viewportRect.right
  );
}

class JapaneseLineBreakingView {
  readonly #view: EditorView;
  readonly #viewport: HTMLElement;
  readonly #resizeObserver: ResizeObserver | null;
  readonly #mutationObserver: MutationObserver | null;
  readonly #unsubscribeConfiguration: () => void;
  #frame: number | null = null;
  #composing = false;
  #destroyed = false;

  constructor(view: EditorView) {
    this.#view = view;
    this.#viewport =
      view.dom.closest<HTMLElement>(
        ".editor-scroll, .workspace-search-preview-root",
      ) ?? view.dom;
    this.#viewport.addEventListener("scroll", this.#schedule, {
      passive: true,
    });
    view.dom.addEventListener("compositionstart", this.#compositionStart, true);
    view.dom.addEventListener("compositionend", this.#compositionEnd, true);
    this.#resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(this.#schedule)
        : null;
    this.#resizeObserver?.observe(this.#viewport);
    if (this.#viewport !== view.dom) this.#resizeObserver?.observe(view.dom);
    this.#mutationObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver(this.#schedule)
        : null;
    this.#mutationObserver?.observe(view.dom, {
      childList: true,
      subtree: true,
    });
    this.#unsubscribeConfiguration = subscribeJapaneseSegmentationConfiguration(
      this.#schedule,
    );
    this.#schedule();
  }

  update(view: EditorView, previousState: EditorState): void {
    if (view.state.doc !== previousState.doc) this.#schedule();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#viewport.removeEventListener("scroll", this.#schedule);
    this.#view.dom.removeEventListener(
      "compositionstart",
      this.#compositionStart,
      true,
    );
    this.#view.dom.removeEventListener(
      "compositionend",
      this.#compositionEnd,
      true,
    );
    this.#resizeObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    this.#unsubscribeConfiguration();
  }

  readonly #compositionStart = (): void => {
    this.#composing = true;
  };

  readonly #compositionEnd = (): void => {
    this.#composing = false;
    this.#schedule();
  };

  readonly #schedule = (): void => {
    if (
      this.#destroyed ||
      this.#composing ||
      this.#frame !== null ||
      this.#view.isDestroyed
    ) {
      return;
    }
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#refresh();
    });
  };

  #refresh(): void {
    if (this.#destroyed || this.#composing || this.#view.isDestroyed) return;
    const mode = getJapaneseSegmentationConfiguration().lineBreakSegmentation;
    const positions = new Set<number>();
    for (const element of this.#view.dom.querySelectorAll<HTMLElement>(
      "p, header[data-section-header]",
    )) {
      if (!intersectsViewport(element, this.#viewport)) continue;
      const position = textblockPositionAtDOM(this.#view, element);
      if (position !== null) positions.add(position);
    }

    const decorations: Decoration[] = [];
    const signatures: string[] = [];
    for (const position of [...positions].sort((left, right) => left - right)) {
      const node = this.#view.state.doc.nodeAt(position);
      if (!node) continue;
      const result = decorationsForTextblock(node, position, mode);
      if (!result) continue;
      decorations.push(...result.decorations);
      signatures.push(result.signature);
    }
    const signature = `${mode}|${signatures.join("|")}`;
    const current = japaneseLineBreakingKey.getState(this.#view.state);
    if (current?.signature === signature) return;
    const meta: JapaneseLineBreakingMeta = {
      decorations: DecorationSet.create(this.#view.state.doc, decorations),
      signature,
    };
    this.#view.dispatch(
      this.#view.state.tr
        .setMeta(japaneseLineBreakingKey, meta)
        .setMeta("addToHistory", false),
    );
  }
}

/** Configurable, display-only Japanese wrapping for mounted prose blocks. */
export const JapaneseLineBreaking = Extension.create({
  name: "memokaJapaneseLineBreaking",
  addProseMirrorPlugins() {
    return [
      new Plugin<JapaneseLineBreakingState>({
        key: japaneseLineBreakingKey,
        state: {
          init: () => ({
            decorations: DecorationSet.empty,
            signature: "",
          }),
          apply: (transaction, current) => {
            const meta = transaction.getMeta(
              japaneseLineBreakingKey,
            ) as JapaneseLineBreakingMeta | null;
            if (meta) return meta;
            if (!transaction.docChanged) return current;
            return {
              decorations: current.decorations.map(
                transaction.mapping,
                transaction.doc,
              ),
              signature: current.signature,
            };
          },
        },
        props: {
          decorations: (state) =>
            japaneseLineBreakingKey.getState(state)?.decorations ?? null,
        },
        view: (view) => new JapaneseLineBreakingView(view),
      }),
    ];
  },
});
