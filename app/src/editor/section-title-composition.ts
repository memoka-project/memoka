import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { SECTION_HEADER_NODE } from "../core/section-model";

const POST_COMPOSITION_ENTER_WINDOW_MS = 500;
const COMPOSITION_SENTINEL = "\u200b";

interface RuntimeNavigator {
  readonly platform: string;
  readonly userAgent: string;
}

interface CompositionSentinel {
  readonly header: HTMLElement;
  readonly node: Text;
}

/**
 * Whether the current browser is WebKitGTK rather than Safari or Chromium.
 *
 * prosemirror-view has the post-composition Enter guard that we need, but its
 * browser check identifies Safari through navigator.vendor. WebKitGTK uses the
 * same relevant WebKit event sequence while exposing Linux as its platform, so
 * ProseMirror's Safari-only guard is not enabled there.
 */
export function isWebKitGtkRuntime(
  runtime: RuntimeNavigator = window.navigator,
): boolean {
  return (
    /Linux/i.test(runtime.platform) &&
    /AppleWebKit\//i.test(runtime.userAgent) &&
    !/(?:Chrome|Chromium|CriOS|Edg|OPR)\//i.test(runtime.userAgent)
  );
}

/**
 * Keep WebKitGTK's Section-title composition inside the title.
 *
 * WebKit confirms Japanese composition by deleting its provisional text and
 * inserting the committed text. When that provisional text is all the title
 * contains, WebKit can remove the now-empty DOM wrapper during the deletion.
 * The committed text is then inserted into the adjacent Section Body. This is
 * the same WebKit behavior documented in ProseMirror issue #934.
 *
 * A transient zero-width text node keeps the wrapper alive during only that
 * native deletion. It is removed by the matching input event and never enters
 * ProseMirror state or Yjs. WebKitGTK also misses ProseMirror's Safari-only
 * post-composition Enter guard, so the same extension supplies that one-shot
 * guard before Memoka can interpret the confirmation as a Section split.
 */
export const SectionTitleCompositionGuard = Extension.create({
  name: "memokaSectionTitleCompositionGuard",
  priority: 2_100,
  addProseMirrorPlugins() {
    let titleComposition = false;
    let suppressNextEnter = false;
    let compositionEndedAt = Number.NEGATIVE_INFINITY;
    let sentinel: CompositionSentinel | null = null;

    const removeSentinel = (): void => {
      const current = sentinel;
      sentinel = null;
      if (!current) return;
      if (current.node.parentNode) {
        current.node.remove();
        return;
      }
      // WebKit may merge adjacent text nodes during the native deletion. The
      // original Text object is then detached while its marker survives in a
      // sibling, so remove that marker before MutationObserver can parse it.
      const walker = current.header.ownerDocument.createTreeWalker(
        current.header,
        NodeFilter.SHOW_TEXT,
      );
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const value = text.nodeValue ?? "";
        const index = value.indexOf(COMPOSITION_SENTINEL);
        if (index < 0 || text.nodeType !== Node.TEXT_NODE) continue;
        (text as Text).deleteData(index, COMPOSITION_SENTINEL.length);
        break;
      }
    };

    const reset = (): void => {
      removeSentinel();
      titleComposition = false;
      suppressNextEnter = false;
      compositionEndedAt = Number.NEGATIVE_INFINITY;
    };

    return [
      new Plugin({
        key: new PluginKey("memokaSectionTitleCompositionGuard"),
        props: {
          handleDOMEvents: {
            compositionstart: (view) => {
              removeSentinel();
              suppressNextEnter = false;
              titleComposition = selectionIsInSectionHeader(view.state);
              return false;
            },
            compositionend: () => {
              removeSentinel();
              if (titleComposition && isWebKitGtkRuntime()) {
                suppressNextEnter = true;
                compositionEndedAt = Date.now();
              } else {
                suppressNextEnter = false;
                compositionEndedAt = Number.NEGATIVE_INFINITY;
              }
              titleComposition = false;
              return false;
            },
            beforeinput: (_view, event) => {
              const input = event as InputEvent;
              if (
                !titleComposition ||
                !isWebKitGtkRuntime() ||
                input.inputType !== "deleteCompositionText"
              ) {
                return false;
              }

              removeSentinel();
              const target = fullyDeletedCompositionText(input);
              if (!target) return false;
              const parent = target.parentNode;
              if (!parent) return false;

              const header = target.parentElement?.closest<HTMLElement>(
                "header[data-section-header]",
              );
              if (!header) return false;
              const node =
                target.ownerDocument.createTextNode(COMPOSITION_SENTINEL);
              parent.insertBefore(node, target);
              sentinel = { header, node };
              return false;
            },
            input: (_view, event) => {
              if ((event as InputEvent).inputType === "deleteCompositionText") {
                removeSentinel();
              }
              return false;
            },
            keydown: (_view, event) => {
              const keyboard = event as KeyboardEvent;
              if (
                titleComposition &&
                isWebKitGtkRuntime() &&
                isPlainEnter(keyboard)
              ) {
                // WebKit may report isComposing=false on the keydown that
                // confirms an otherwise still-active composition. Keep the
                // event available to the IME, but do not let ProseMirror's
                // Section Enter handlers see it.
                return true;
              }
              if (!suppressNextEnter) return false;

              const elapsed = Date.now() - compositionEndedAt;
              if (elapsed < 0 || elapsed >= POST_COMPOSITION_ENTER_WINDOW_MS) {
                suppressNextEnter = false;
                return false;
              }

              if (isModifierKey(keyboard)) return false;

              // The guard belongs to exactly one post-composition key event.
              // If another real key arrived first, a later Enter is unrelated.
              suppressNextEnter = false;
              if (!isPlainEnter(keyboard)) return false;

              // handleDOMEvents runs before ProseMirror's built-in keydown
              // handler, so it must cancel the native event itself.
              keyboard.preventDefault();
              return true;
            },
            blur: () => {
              reset();
              return false;
            },
          },
        },
        view: () => ({ destroy: reset }),
      }),
    ];
  },
});

function selectionIsInSectionHeader(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return (
    $from.parent === $to.parent &&
    $from.parent.type.name === SECTION_HEADER_NODE
  );
}

function fullyDeletedCompositionText(input: InputEvent): Text | null {
  const range = inputTargetRange(input) ?? currentDOMRange();
  if (
    !range ||
    range.startContainer !== range.endContainer ||
    range.startContainer.nodeType !== Node.TEXT_NODE
  ) {
    return null;
  }
  const text = range.startContainer as Text;
  if (
    text.length === 0 ||
    range.startOffset !== 0 ||
    range.endOffset !== text.length
  ) {
    return null;
  }
  const header = text.parentElement?.closest<HTMLElement>(
    "header[data-section-header]",
  );
  if (!header) return null;
  return text;
}

interface DOMRangeLike {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
}

function inputTargetRange(input: InputEvent): DOMRangeLike | null {
  try {
    return input.getTargetRanges?.()[0] ?? null;
  } catch {
    return null;
  }
}

function currentDOMRange(): Range | null {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
}

function isPlainEnter(event: KeyboardEvent): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Enter" || event.code === "Enter" || event.keyCode === 13)
  );
}

function isModifierKey(event: KeyboardEvent): boolean {
  return (
    event.key === "Alt" ||
    event.key === "AltGraph" ||
    event.key === "Control" ||
    event.key === "Meta" ||
    event.key === "Shift"
  );
}
