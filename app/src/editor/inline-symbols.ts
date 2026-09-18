import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { textblockIconTokens } from "../core/symbols";
import {
  SYMBOL_SPACE_CLASS,
  textblockSymbolSpacingOffsets,
} from "../core/symbol-spacing";
import { loadSymbolIcons, symbolIconMask } from "./symbol-icons";

const key = new PluginKey<{ decorations: DecorationSet; composing: boolean }>(
  "inline-symbols",
);

function decorations(doc: ProseMirrorNode): DecorationSet {
  const result: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    for (const offset of textblockSymbolSpacingOffsets(node)) {
      const position = pos + 1 + offset;
      result.push(
        Decoration.widget(
          position,
          (view) => {
            const element = view.dom.ownerDocument.createElement("span");
            element.className = SYMBOL_SPACE_CLASS;
            element.contentEditable = "false";
            element.setAttribute("aria-hidden", "true");
            return element;
          },
          { side: -2, key: `symbol-space:${position}`, ignoreSelection: true },
        ),
      );
    }
    for (const token of textblockIconTokens(node)) {
      const mask = symbolIconMask(token.name);
      if (!mask) continue;
      const from = pos + 1 + token.from;
      const to = pos + 1 + token.to;
      result.push(
        Decoration.inline(from, to, { class: "memoka-symbol-source" }),
      );
      result.push(
        Decoration.widget(
          from,
          (view) => {
            const element = view.dom.ownerDocument.createElement("span");
            element.className = "memoka-symbol-icon";
            element.style.setProperty("--symbol-mask", mask);
            element.setAttribute("role", "img");
            element.setAttribute("aria-label", token.name);
            element.setAttribute("data-symbol-from", String(from));
            element.setAttribute("data-symbol-to", String(to));
            element.contentEditable = "false";
            return element;
          },
          {
            // Native Insert at token.from must be before the visible widget,
            // not between the widget and display:none source (WebKit inserts
            // after the icon from that visually equivalent DOM boundary).
            side: 1,
            key: `symbol:${from}:${token.name}`,
            ignoreSelection: true,
            marks: node.nodeAt(token.from)?.marks,
          },
        ),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, result);
}

export function snapIconPosition(
  doc: ProseMirrorNode,
  position: number,
  direction: -1 | 1,
): number {
  const resolved = doc.resolve(position);
  const token = textblockIconTokens(resolved.parent).find(
    (range) =>
      range.from < resolved.parentOffset && range.to > resolved.parentOffset,
  );
  return token
    ? resolved.start() + (direction < 0 ? token.from : token.to)
    : position;
}

export const InlineSymbols = Extension.create({
  name: "inlineSymbols",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => ({
            decorations: decorations(state.doc),
            composing: false,
          }),
          apply: (tr, previous) => {
            const composing = tr.getMeta(key)?.composing ?? previous.composing;
            return {
              composing,
              decorations: composing
                ? previous.decorations.map(tr.mapping, tr.doc)
                : tr.docChanged || tr.getMeta(key)
                  ? decorations(tr.doc)
                  : previous.decorations,
            };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          handleKeyDown: (view, event) => {
            if (
              view.dom.dataset.vimMode !== "insert" ||
              view.composing ||
              event.isComposing ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              !["ArrowLeft", "ArrowRight"].includes(event.key)
            )
              return false;
            const { selection } = view.state;
            const resolved = view.state.doc.resolve(selection.head);
            const right = event.key === "ArrowRight";
            const token = textblockIconTokens(resolved.parent).find((range) =>
              right
                ? range.from === resolved.parentOffset
                : range.to === resolved.parentOffset,
            );
            if (!token) return false;
            const next = resolved.start() + (right ? token.to : token.from);
            view.dispatch(
              view.state.tr
                .setSelection(
                  TextSelection.create(
                    view.state.doc,
                    event.shiftKey ? selection.anchor : next,
                    next,
                  ),
                )
                .scrollIntoView(),
            );
            event.preventDefault();
            return true;
          },
          handleClick: (view, _pos, event) => {
            const icon = (event.target as Element)?.closest?.(
              "[data-symbol-from]",
            );
            if (!icon) return false;
            const pos = Number(icon.getAttribute("data-symbol-from"));
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, pos),
              ),
            );
            view.focus();
            return true;
          },
          handleDOMEvents: {
            compositionstart: (view) => {
              view.dispatch(view.state.tr.setMeta(key, { composing: true }));
              return false;
            },
            compositionend: (view) => {
              queueMicrotask(() => {
                if (!view.isDestroyed)
                  view.dispatch(
                    view.state.tr.setMeta(key, { composing: false }),
                  );
              });
              return false;
            },
          },
        },
        appendTransaction: (_transactions, oldState, state) => {
          if (
            key.getState(state)?.composing ||
            !(state.selection instanceof TextSelection)
          )
            return null;
          const { anchor, head, empty } = state.selection;
          const direction = head < oldState.selection.head ? -1 : 1;
          const nextAnchor = snapIconPosition(
            state.doc,
            anchor,
            empty ? direction : anchor < head ? -1 : 1,
          );
          const nextHead = snapIconPosition(
            state.doc,
            head,
            empty ? direction : head < anchor ? -1 : 1,
          );
          return nextAnchor === anchor && nextHead === head
            ? null
            : state.tr.setSelection(
                TextSelection.create(state.doc, nextAnchor, nextHead),
              );
        },
        view: (view) => {
          let alive = true;
          let requested = false;
          const ensureIcons = () => {
            if (requested) return;
            let found = false;
            view.state.doc.descendants((node) => {
              if (found) return false;
              if (textblockIconTokens(node).length) found = true;
              return !node.isTextblock;
            });
            if (!found) return;
            requested = true;
            void loadSymbolIcons()
              .then(() => {
                if (alive && !view.isDestroyed)
                  view.dispatch(
                    view.state.tr
                      .setMeta(key, { refresh: true })
                      .setMeta("addToHistory", false),
                  );
              })
              .catch(() => {
                requested = false;
              });
          };
          ensureIcons();
          return {
            update: ensureIcons,
            destroy: () => {
              alive = false;
            },
          };
        },
      }),
    ];
  },
});
