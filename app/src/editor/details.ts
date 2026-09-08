import { Extension, Node, mergeAttributes } from "@tiptap/core";
import {
  DOMParser,
  Fragment,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { SectionFoldAction } from "./section-folding";

export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsBody",
  defining: true,
  isolating: true,
  addAttributes() {
    // Authored/imported initial state. Interactive folds are Window-local.
    return {
      open: {
        default: true,
        parseHTML: (element) => element.hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "" } : {}),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "details",
        getContent: (node, schema) => {
          const element = node as HTMLElement;
          const summary = Array.from(element.children).find(
            (child) => child.tagName === "SUMMARY",
          );
          const parser = DOMParser.fromSchema(schema);
          const wrapper = element.ownerDocument.createElement("div");
          for (const child of Array.from(element.childNodes)) {
            if (child !== summary) wrapper.appendChild(child.cloneNode(true));
          }
          const serializedBody = wrapper.querySelector(
            ":scope > [data-details-body]",
          );
          const body = parser.parse(serializedBody ?? wrapper, {
            topNode: schema.nodes.detailsBody!.create(),
          });
          const header = summary
            ? parser.parse(summary, {
                topNode: schema.nodes.detailsSummary!.create(),
              })
            : schema.nodes.detailsSummary!.create();
          return Fragment.fromArray([header, body]);
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "details",
      mergeAttributes(HTMLAttributes, { class: "memoka-details" }),
      0,
    ];
  },
  addNodeView() {
    return ({ node, view }) => {
      // Native <details> changes open and DOM selection outside ProseMirror.
      // Edit in a stable container; Clipboard HTML still uses native details.
      const dom = view.dom.ownerDocument.createElement("div");
      dom.className = "memoka-details";
      if (node.attrs.blockId) dom.dataset.blockId = node.attrs.blockId;
      return { dom, contentDOM: dom };
    };
  },
});

export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: ({ HTMLAttributes }) => [
    "summary",
    mergeAttributes(HTMLAttributes, {
      class: "memoka-details-summary",
    }),
    0,
  ],
});

export const DetailsBody = Node.create({
  name: "detailsBody",
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "div[data-details-body]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, {
      class: "memoka-details-body",
      "data-details-body": "true",
    }),
    0,
  ],
});

interface DetailsEntry {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly summaryFrom: number;
  readonly summaryTo: number;
  readonly hiddenFrom: number;
  readonly hiddenTo: number;
  readonly initialOpen: boolean;
}

// Reuse unchanged subtrees, including large inactive BodyChunks, while typing.
const entryCache = new WeakMap<ProseMirrorNode, readonly DetailsEntry[]>();
function entriesIn(node: ProseMirrorNode): readonly DetailsEntry[] {
  const cached = entryCache.get(node);
  if (cached) return cached;
  const entries: DetailsEntry[] = [];
  node.forEach((child, position) => {
    if (child.type.name === "details") {
      const summaryTo = position + 1 + child.firstChild!.nodeSize;
      entries.push({
        id: String(child.attrs.blockId ?? ""),
        from: position,
        to: position + child.nodeSize,
        summaryFrom: position + 1,
        summaryTo,
        hiddenFrom: summaryTo,
        hiddenTo: position + child.nodeSize - 1,
        initialOpen: child.attrs.open === true,
      });
    }
    if (child.isTextblock || child.isLeaf) return;
    for (const entry of entriesIn(child)) {
      const delta = position + 1;
      entries.push({
        ...entry,
        from: entry.from + delta,
        to: entry.to + delta,
        summaryFrom: entry.summaryFrom + delta,
        summaryTo: entry.summaryTo + delta,
        hiddenFrom: entry.hiddenFrom + delta,
        hiddenTo: entry.hiddenTo + delta,
      });
    }
  });
  entryCache.set(node, entries);
  return entries;
}

interface FoldState {
  readonly overrides: ReadonlyMap<string, boolean>;
  readonly entries: readonly DetailsEntry[];
  readonly hidden: readonly DetailsEntry[];
  readonly signature: string;
  readonly decorations: DecorationSet;
}
const foldKey = new PluginKey<FoldState>("memokaDetailsFolding");
function isOpen(
  entry: DetailsEntry,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  return overrides.get(entry.id) ?? entry.initialOpen;
}
function foldState(
  doc: ProseMirrorNode,
  overrides: ReadonlyMap<string, boolean>,
): FoldState {
  const entries = entriesIn(doc);
  const decorations: Decoration[] = [];
  const hidden = entries.filter((entry) => !isOpen(entry, overrides));
  for (const entry of entries) {
    const open = isOpen(entry, overrides);
    decorations.push(
      Decoration.node(entry.from, entry.to, {
        "data-details-expanded": String(open),
      }),
    );
    if (entry.summaryTo === entry.summaryFrom + 2) {
      decorations.push(
        Decoration.node(entry.summaryFrom, entry.summaryTo, {
          "data-empty": "true",
        }),
      );
    }
    decorations.push(
      Decoration.widget(
        entry.summaryFrom + 1,
        (view) => {
          const button = view.dom.ownerDocument.createElement("button");
          button.type = "button";
          button.className = "memoka-details-toggle";
          button.contentEditable = "false";
          button.tabIndex = -1;
          button.textContent = open ? "▾" : "▸";
          button.setAttribute("aria-expanded", String(open));
          button.setAttribute(
            "aria-label",
            open ? "詳細を折り畳む" : "詳細を展開する",
          );
          button.addEventListener("mousedown", (event) =>
            event.preventDefault(),
          );
          button.addEventListener("click", (event) => {
            event.preventDefault();
            runDetailsFoldCommand(view, "toggle", entry.id);
          });
          return button;
        },
        {
          side: -1,
          key: `details:${entry.id}:${open}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
  }
  return {
    overrides,
    entries,
    hidden,
    signature: hidden.map((entry) => entry.id).join("\u0000"),
    decorations: DecorationSet.create(doc, decorations),
  };
}

export const DetailsFolding = Extension.create({
  name: "detailsFolding",
  priority: 1140,
  addOptions: () => ({ expandAll: false }),
  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: foldKey,
        state: {
          init: (_, state) =>
            foldState(
              state.doc,
              new Map(
                this.options.expandAll
                  ? entriesIn(state.doc).map(
                      (entry) => [entry.id, true] as const,
                    )
                  : [],
              ),
            ),
          apply: (tr, previous) => {
            const overrides = tr.getMeta(foldKey) as
              ReadonlyMap<string, boolean> | undefined;
            if (!tr.docChanged && !overrides) return previous;
            const next = new Map(overrides ?? previous.overrides);
            if (this.options.expandAll) {
              for (const entry of entriesIn(tr.doc))
                if (!next.has(entry.id)) next.set(entry.id, true);
            }
            return foldState(tr.doc, next);
          },
        },
        props: { decorations: (state) => foldKey.getState(state)?.decorations },
        appendTransaction: (_transactions, _old, state) => {
          // Search, Undo and explicit navigation may address hidden content.
          // Reveal it without moving the caret or changing document history.
          return revealDetailsTransaction(state, state.selection.head);
        },
      }),
    ];
  },
});

function revealDetailsTransaction(
  state: EditorState,
  position: number,
): Transaction | null {
  const folds = foldKey.getState(state);
  if (!folds) return null;
  const ancestors = folds.hidden.filter(
    (entry) => position >= entry.hiddenFrom && position < entry.hiddenTo,
  );
  if (!ancestors.length) return null;
  const overrides = new Map(folds.overrides);
  for (const entry of ancestors) overrides.set(entry.id, true);
  return state.tr.setMeta(foldKey, overrides).setMeta("addToHistory", false);
}

export function revealDetailsFoldsAtPosition(
  view: EditorView,
  position: number,
): boolean {
  const transaction = revealDetailsTransaction(view.state, position);
  if (!transaction) return false;
  view.dispatch(transaction);
  return true;
}

export function detailsFoldHiddenEntries(
  state: EditorState,
): readonly DetailsEntry[] {
  return foldKey.getState(state)?.hidden ?? [];
}
export function detailsFoldStateSignature(state: EditorState): string {
  return foldKey.getState(state)?.signature ?? "";
}

export function runDetailsFoldCommand(
  view: EditorView,
  action: SectionFoldAction,
  blockId?: string,
): { changed: boolean; detail: string } | null {
  const folds = foldKey.getState(view.state);
  const entry = blockId
    ? folds?.entries.find((entry) => entry.id === blockId)
    : folds?.entries
        .filter(
          (entry) =>
            view.state.selection.from >= entry.from &&
            view.state.selection.to < entry.to,
        )
        .at(-1);
  if (!folds || !entry) return null;
  const open = action.startsWith("open")
    ? true
    : action.startsWith("close")
      ? false
      : !isOpen(entry, folds.overrides);
  const targets = action.endsWith("recursive")
    ? folds.entries.filter(
        (child) => child.from >= entry.from && child.to <= entry.to,
      )
    : [entry];
  const overrides = new Map(folds.overrides);
  let changed = false;
  for (const target of targets) {
    if (isOpen(target, overrides) !== open) changed = true;
    overrides.set(target.id, open);
  }
  const tr = view.state.tr
    .setMeta(foldKey, overrides)
    .setMeta("addToHistory", false);
  if (blockId || (!open && view.state.selection.head >= entry.hiddenFrom)) {
    tr.setSelection(TextSelection.create(tr.doc, entry.summaryFrom + 1));
    tr.scrollIntoView();
  }
  view.dispatch(tr);
  view.focus();
  return { changed, detail: `details:fold-${action}` };
}

/** Enter in an editable summary opens its body and moves to the first block. */
export function enterDetailsBody(
  view: Pick<EditorView, "state" | "dispatch" | "focus">,
): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.name !== "detailsSummary") return false;
  const afterSummary = $from.after();
  const tr = view.state.tr.setSelection(
    TextSelection.near(view.state.doc.resolve(afterSummary + 1)),
  );
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
