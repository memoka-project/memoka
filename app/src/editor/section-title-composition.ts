import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const POST_COMPOSITION_ENTER_WINDOW_MS = 500;
const COMPOSITION_SENTINEL = "\u200b";

interface RuntimeNavigator {
  readonly platform: string;
  readonly userAgent: string;
}

interface CompositionSentinel {
  readonly textblock: HTMLElement;
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
 * Bridge WebKitGTK composition behavior that ProseMirror only enables for
 * Safari, while keeping composition inside its original textblock.
 *
 * WebKit confirms Japanese composition by deleting its provisional text and
 * inserting the committed text. When that provisional text is all its
 * textblock contains, WebKit can remove the now-empty DOM wrapper during the
 * deletion.
 * The committed text may then be inserted into an adjacent Section Body or a
 * newly split ListItem. This is the same WebKit behavior documented in
 * ProseMirror issue #934.
 *
 * A transient zero-width text node keeps the wrapper alive during only that
 * native deletion. It is removed by the matching input event and never enters
 * ProseMirror state or Yjs.
 *
 * WebKitGTK also misses ProseMirror's Safari-only active/post-composition Enter
 * guard for every textblock. Without that guard an IME confirmation can be
 * interpreted as a ListItem split (and the following DOM reconciliation can
 * duplicate part of the committed text). That Enter guard is intentionally
 * document-wide. The transient sentinel is likewise used for any supported
 * textblock that would otherwise become empty during composition confirmation.
 */
export const WebKitGtkCompositionGuard = Extension.create({
  name: "memokaWebKitGtkCompositionGuard",
  priority: 2_100,
  addProseMirrorPlugins() {
    let webKitGtkComposition = false;
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
      const walker = current.textblock.ownerDocument.createTreeWalker(
        current.textblock,
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
      webKitGtkComposition = false;
      suppressNextEnter = false;
      compositionEndedAt = Number.NEGATIVE_INFINITY;
    };

    return [
      new Plugin({
        key: new PluginKey("memokaWebKitGtkCompositionGuard"),
        props: {
          handleDOMEvents: {
            compositionstart: () => {
              removeSentinel();
              suppressNextEnter = false;
              webKitGtkComposition = isWebKitGtkRuntime();
              return false;
            },
            compositionend: () => {
              removeSentinel();
              if (webKitGtkComposition) {
                suppressNextEnter = true;
                compositionEndedAt = Date.now();
              } else {
                suppressNextEnter = false;
                compositionEndedAt = Number.NEGATIVE_INFINITY;
              }
              webKitGtkComposition = false;
              return false;
            },
            beforeinput: (_view, event) => {
              const input = event as InputEvent;
              if (
                !webKitGtkComposition ||
                input.inputType !== "deleteCompositionText"
              ) {
                return false;
              }

              removeSentinel();
              const target = fullyDeletedCompositionTarget(input);
              if (!target) return false;
              const parent = target.text.parentNode;
              if (!parent) return false;

              const node =
                target.text.ownerDocument.createTextNode(COMPOSITION_SENTINEL);
              parent.insertBefore(node, target.text);
              sentinel = { textblock: target.textblock, node };
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
              if (webKitGtkComposition && isPlainEnter(keyboard)) {
                // WebKit may report isComposing=false on the keydown that
                // confirms an otherwise still-active composition. Match
                // ProseMirror's Safari behavior: keep the event available to
                // the IME, but do not let editor Enter handlers see it.
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

interface FullyDeletedCompositionTarget {
  readonly text: Text;
  readonly textblock: HTMLElement;
}

function fullyDeletedCompositionTarget(
  input: InputEvent,
): FullyDeletedCompositionTarget | null {
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
  const textblock = text.parentElement?.closest<HTMLElement>(
    "header[data-section-header], p, pre",
  );
  if (!textblock || textblock.textContent !== text.data) return null;
  return { text, textblock };
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
