import {
  CodeBlockLowlight,
  type CodeBlockLowlightOptions,
} from "@tiptap/extension-code-block-lowlight";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { all, createLowlight } from "lowlight";
import { codeLanguageLabel } from "../core/code-blocks";
import type { SectionFoldAction } from "./section-folding";

export const CODE_FOLD_MIN_LINES = 11;
export const CODE_FOLD_VISIBLE_LINES = 5;
export const CODE_HIGHLIGHT_MAX_UTF8_BYTES = 64 * 1024;

const utf8Encoder = new TextEncoder();
const fullLowlight = createLowlight(all);

function exceedsHighlightLimit(value: string): boolean {
  return (
    value.length > CODE_HIGHLIGHT_MAX_UTF8_BYTES ||
    utf8Encoder.encode(value).byteLength > CODE_HIGHLIGHT_MAX_UTF8_BYTES
  );
}

function plainHighlight(
  value: string,
): ReturnType<typeof fullLowlight.highlight> {
  return {
    type: "root",
    children: [{ type: "text", value }],
    data: { language: "plaintext", relevance: 0 },
  };
}

/** Explicit languages only; unknown and oversized input remains plain text. */
const memokaLowlight = {
  ...fullLowlight,
  highlight(language: string, value: string) {
    return exceedsHighlightLimit(value)
      ? plainHighlight(value)
      : fullLowlight.highlight(language, value);
  },
  highlightAuto(value: string) {
    return plainHighlight(value);
  },
};

export type CodeCopyResult = "copied" | "missing" | "unavailable";

interface MemokaCodeBlockOptions extends CodeBlockLowlightOptions {
  onCopyCode?: (blockId: string) => CodeCopyResult | Promise<CodeCopyResult>;
}

export const MemokaCodeBlock = CodeBlockLowlight.extend<MemokaCodeBlockOptions>(
  {
    addOptions() {
      return {
        ...this.parent?.(),
        lowlight: memokaLowlight,
        languageClassPrefix: "language-",
        exitOnTripleEnter: true,
        exitOnArrowDown: true,
        exitOnArrowUp: true,
        defaultLanguage: null,
        enableTabIndentation: false,
        tabSize: 4,
        HTMLAttributes: {},
        onCopyCode: undefined,
      };
    },
    addNodeView() {
      return ({ node, view }) => {
        let currentNode = node;
        const dom = view.dom.ownerDocument.createElement("div");
        dom.className = "memoka-code-block";
        const toolbar = view.dom.ownerDocument.createElement("div");
        toolbar.className = "memoka-code-block__toolbar";
        toolbar.contentEditable = "false";
        const language = view.dom.ownerDocument.createElement("span");
        language.className = "memoka-code-block__language";
        const fold = view.dom.ownerDocument.createElement("button");
        fold.type = "button";
        fold.className = "memoka-code-block__button memoka-code-block__fold";
        fold.contentEditable = "false";
        fold.tabIndex = -1;
        const copy = view.dom.ownerDocument.createElement("button");
        copy.type = "button";
        copy.className = "memoka-code-block__button memoka-code-block__copy";
        copy.contentEditable = "false";
        copy.tabIndex = -1;
        copy.dataset.label = "Copy";
        copy.setAttribute("aria-label", "コードをコピー");
        const pre = view.dom.ownerDocument.createElement("pre");
        const contentDOM = view.dom.ownerDocument.createElement("code");
        pre.append(contentDOM);
        toolbar.append(language, fold);
        if (this.options.onCopyCode) toolbar.append(copy);
        dom.append(toolbar, pre);

        const blockId = (): string => String(currentNode.attrs.blockId ?? "");
        const render = (): void => {
          const entry = codeFoldEntry(view.state, blockId());
          const expanded = !entry || codeFoldEntryIsOpen(view.state, entry);
          language.dataset.label = codeLanguageLabel(
            currentNode.attrs.language,
          );
          dom.dataset.codeFoldable = String(Boolean(entry));
          dom.dataset.codeExpanded = String(expanded);
          dom.dataset.codeLineCount = String(entry?.lineCount ?? 1);
          fold.hidden = !entry;
          if (entry) {
            const hiddenLines = entry.lineCount - CODE_FOLD_VISIBLE_LINES;
            fold.dataset.label = expanded ? "Fold" : `+${hiddenLines} lines`;
            fold.setAttribute("aria-expanded", String(expanded));
            fold.setAttribute(
              "aria-label",
              expanded ? "コードを折り畳む" : "コードを展開する",
            );
          }
        };
        const preserveEditorSelection = (event: Event): void => {
          event.preventDefault();
        };
        const toggleFold = (event: Event): void => {
          event.preventDefault();
          runCodeBlockFoldCommand(view, "toggle", blockId());
        };
        const copyCode = (event: Event): void => {
          event.preventDefault();
          if (!this.options.onCopyCode || copy.disabled) return;
          copy.disabled = true;
          void Promise.resolve(this.options.onCopyCode(blockId())).finally(
            () => {
              copy.disabled = false;
            },
          );
        };
        fold.addEventListener("mousedown", preserveEditorSelection);
        fold.addEventListener("click", toggleFold);
        copy.addEventListener("mousedown", preserveEditorSelection);
        copy.addEventListener("click", copyCode);
        render();

        return {
          dom,
          contentDOM,
          update(updatedNode) {
            if (updatedNode.type !== currentNode.type) return false;
            currentNode = updatedNode;
            render();
            return true;
          },
          stopEvent: (event) => toolbar.contains(event.target as Node),
          ignoreMutation: (mutation) =>
            !contentDOM.contains(mutation.target as Node),
          destroy() {
            fold.removeEventListener("mousedown", preserveEditorSelection);
            fold.removeEventListener("click", toggleFold);
            copy.removeEventListener("mousedown", preserveEditorSelection);
            copy.removeEventListener("click", copyCode);
          },
        };
      };
    },
  },
);

export interface CodeFoldEntry {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly hiddenFrom: number;
  readonly hiddenTo: number;
  readonly lineCount: number;
}

interface CodeFoldState {
  readonly overrides: ReadonlyMap<string, boolean>;
  readonly entries: readonly CodeFoldEntry[];
  readonly hidden: readonly CodeFoldEntry[];
  readonly signature: string;
  readonly decorations: DecorationSet;
}

const codeFoldKey = new PluginKey<CodeFoldState>("memokaCodeBlockFolding");
const foldEntryCache = new WeakMap<ProseMirrorNode, readonly CodeFoldEntry[]>();

function codeLineGeometry(text: string): {
  lineCount: number;
  hiddenOffset: number;
} {
  let lineCount = 1;
  let hiddenOffset = text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lineCount += 1;
    if (lineCount === CODE_FOLD_VISIBLE_LINES + 1) hiddenOffset = index + 1;
  }
  return { lineCount, hiddenOffset };
}

function foldEntriesIn(node: ProseMirrorNode): readonly CodeFoldEntry[] {
  const cached = foldEntryCache.get(node);
  if (cached) return cached;
  const entries: CodeFoldEntry[] = [];
  node.forEach((child, offset) => {
    if (child.type.name === "codeBlock") {
      const id = String(child.attrs.blockId ?? "");
      const geometry = codeLineGeometry(child.textContent);
      if (id && geometry.lineCount >= CODE_FOLD_MIN_LINES) {
        entries.push({
          id,
          from: offset,
          to: offset + child.nodeSize,
          hiddenFrom: offset + 1 + geometry.hiddenOffset,
          hiddenTo: offset + child.nodeSize - 1,
          lineCount: geometry.lineCount,
        });
      }
    }
    if (child.isTextblock || child.isLeaf) return;
    for (const entry of foldEntriesIn(child)) {
      const delta = offset + 1;
      entries.push({
        ...entry,
        from: entry.from + delta,
        to: entry.to + delta,
        hiddenFrom: entry.hiddenFrom + delta,
        hiddenTo: entry.hiddenTo + delta,
      });
    }
  });
  foldEntryCache.set(node, entries);
  return entries;
}

function codeFoldEntryIsOpen(
  state: EditorState,
  entry: CodeFoldEntry,
): boolean {
  return codeFoldKey.getState(state)?.overrides.get(entry.id) ?? true;
}

function codeFoldEntry(
  state: EditorState,
  blockId: string,
): CodeFoldEntry | null {
  return (
    codeFoldKey
      .getState(state)
      ?.entries.find((entry) => entry.id === blockId) ?? null
  );
}

function buildFoldState(
  doc: ProseMirrorNode,
  overrides: ReadonlyMap<string, boolean>,
): CodeFoldState {
  const entries = foldEntriesIn(doc);
  const hidden = entries.filter((entry) => overrides.get(entry.id) === false);
  const decorations = entries.map((entry) => {
    const expanded = !hidden.includes(entry);
    return Decoration.node(entry.from, entry.to, {
      "data-code-foldable": "true",
      "data-code-expanded": String(expanded),
      "data-code-line-count": String(entry.lineCount),
    });
  });
  return {
    overrides,
    entries,
    hidden,
    signature: hidden.map((entry) => entry.id).join("\u0000"),
    decorations: DecorationSet.create(doc, decorations),
  };
}

function revealCodeFoldTransaction(
  state: EditorState,
  position: number,
): Transaction | null {
  const folds = codeFoldKey.getState(state);
  const entry = folds?.hidden.find(
    (candidate) =>
      position >= candidate.hiddenFrom && position <= candidate.hiddenTo,
  );
  if (!folds || !entry) return null;
  const overrides = new Map(folds.overrides).set(entry.id, true);
  return state.tr
    .setMeta(codeFoldKey, overrides)
    .setMeta("addToHistory", false);
}

export const CodeBlockFolding = Extension.create({
  name: "memokaCodeBlockFolding",
  addProseMirrorPlugins() {
    return [
      new Plugin<CodeFoldState>({
        key: codeFoldKey,
        state: {
          init: (_, state) => buildFoldState(state.doc, new Map()),
          apply: (transaction, previous) => {
            const override = transaction.getMeta(codeFoldKey) as
              ReadonlyMap<string, boolean> | undefined;
            if (!transaction.docChanged && !override) return previous;
            return buildFoldState(
              transaction.doc,
              new Map(override ?? previous.overrides),
            );
          },
        },
        props: {
          decorations: (state) =>
            codeFoldKey.getState(state)?.decorations ?? null,
        },
        appendTransaction: (_transactions, _oldState, state) =>
          revealCodeFoldTransaction(state, state.selection.head),
      }),
    ];
  },
});

export function codeFoldHiddenEntries(
  state: EditorState,
): readonly CodeFoldEntry[] {
  return codeFoldKey.getState(state)?.hidden ?? [];
}

export function codeFoldStateSignature(state: EditorState): string {
  return codeFoldKey.getState(state)?.signature ?? "";
}

export function revealCodeFoldAtPosition(
  view: EditorView,
  position: number,
): boolean {
  const transaction = revealCodeFoldTransaction(view.state, position);
  if (!transaction) return false;
  view.dispatch(transaction);
  return true;
}

export function runCodeBlockFoldCommand(
  view: EditorView,
  action: SectionFoldAction,
  blockId?: string,
): { changed: boolean; detail: string } | null {
  const folds = codeFoldKey.getState(view.state);
  const entry = blockId
    ? folds?.entries.find((candidate) => candidate.id === blockId)
    : folds?.entries.find(
        (candidate) =>
          view.state.selection.from >= candidate.from &&
          view.state.selection.to <= candidate.to,
      );
  if (!folds || !entry) return null;
  const currentOpen = codeFoldEntryIsOpen(view.state, entry);
  const open = action.startsWith("open")
    ? true
    : action.startsWith("close")
      ? false
      : !currentOpen;
  const overrides = new Map(folds.overrides).set(entry.id, open);
  const transaction = view.state.tr
    .setMeta(codeFoldKey, overrides)
    .setMeta("addToHistory", false);
  if (!open && view.state.selection.head >= entry.hiddenFrom) {
    transaction.setSelection(
      TextSelection.create(transaction.doc, entry.hiddenFrom - 1),
    );
    transaction.scrollIntoView();
  }
  view.dispatch(transaction);
  view.focus();
  return {
    changed: currentOpen !== open,
    detail: `code:fold-${action}`,
  };
}
