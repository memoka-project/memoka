import { Extension } from "@tiptap/core";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { isUuidV7 } from "../core/ids";
import {
  SECTION_BODY_NODE,
  SECTION_CHILDREN_NODE,
  SECTION_HEADER_NODE,
  SECTION_NODE,
} from "../core/section-model";

export type SectionFoldAction =
  | "open"
  | "open-recursive"
  | "close"
  | "close-recursive"
  | "toggle"
  | "toggle-recursive";

export interface SectionFoldEntry {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  readonly depth: number;
  readonly headerFrom: number;
  readonly headerTo: number;
  /** First position hidden when this Section is closed. */
  readonly hiddenFrom: number;
  /** Exclusive end of the hidden Section body and child container. */
  readonly hiddenTo: number;
  /** First position in this Section's content. */
  readonly sectionFrom: number;
  /** Last position in this Section's content. */
  readonly sectionTo: number;
}

export interface SectionFoldCommandResult {
  readonly handled: boolean;
  readonly changed: boolean;
  readonly targetSectionId: string | null;
  readonly collapsedSectionIds: readonly string[];
  readonly detail: string;
}

export interface SectionFoldRevealResult {
  readonly changed: boolean;
  readonly targetSectionId: string | null;
  readonly collapsedSectionIds: readonly string[];
}

interface SectionFoldPluginState {
  readonly collapsedSectionIds: readonly string[];
  readonly collapsedSignature: string;
  readonly activeEntries: readonly SectionFoldEntry[];
  readonly decorations: DecorationSet;
}

interface SectionFoldMeta {
  readonly collapsedSectionIds: readonly string[];
}

interface SectionFoldingOptions {
  readonly collapsedSectionIds: readonly string[];
}

const sectionFoldPluginKey = new PluginKey<SectionFoldPluginState>(
  "memokaSectionFolding",
);

function normalizedSectionIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isUuidV7))].sort();
}

function collapsedSignature(ids: readonly string[]): string {
  return ids.join("\u0000");
}

function sectionIdFromHeader(node: ProseMirrorNode): string | null {
  const sectionId = node.attrs.sectionId;
  return typeof sectionId === "string" && isUuidV7(sectionId)
    ? sectionId
    : null;
}

/**
 * Derives the Section geometry of the mounted Focused Section subtree.
 * The top ProseMirror node is itself the mounted Section and therefore has no
 * opening token in the document position space; nested Sections do.
 */
export function deriveEditorSectionFoldEntries(
  doc: ProseMirrorNode,
): SectionFoldEntry[] {
  if (doc.type.name !== SECTION_NODE) return [];
  const result: SectionFoldEntry[] = [];

  const visit = (
    section: ProseMirrorNode,
    contentFrom: number,
    parentSectionId: string | null,
    depth: number,
  ): void => {
    if (section.childCount !== 3) return;
    const header = section.child(0);
    const body = section.child(1);
    const children = section.child(2);
    if (
      header.type.name !== SECTION_HEADER_NODE ||
      body.type.name !== SECTION_BODY_NODE ||
      children.type.name !== SECTION_CHILDREN_NODE
    ) {
      return;
    }
    const sectionId = sectionIdFromHeader(header);
    if (!sectionId) return;
    const headerFrom = contentFrom;
    const headerTo = headerFrom + header.nodeSize;
    const bodyFrom = headerTo;
    const childrenFrom = bodyFrom + body.nodeSize;
    const sectionTo = contentFrom + section.content.size;
    result.push({
      sectionId,
      parentSectionId,
      depth,
      headerFrom,
      headerTo,
      hiddenFrom: bodyFrom,
      hiddenTo: sectionTo,
      sectionFrom: contentFrom,
      sectionTo,
    });

    children.forEach((child, offset) => {
      if (child.type.name !== SECTION_NODE) return;
      // sectionChildren's content starts one position after its opening token;
      // a nested Section's own content starts one further position in.
      const childNodeFrom = childrenFrom + 1 + offset;
      visit(child, childNodeFrom + 1, sectionId, depth + 1);
    });
  };

  visit(doc, 0, null, 0);
  return result;
}

function entryAtHeaderPosition(
  doc: ProseMirrorNode,
  headerFrom: number,
): SectionFoldEntry | null {
  if (headerFrom < 0 || headerFrom > doc.content.size) return null;
  const header = doc.nodeAt(headerFrom);
  if (!header || header.type.name !== SECTION_HEADER_NODE) return null;
  const sectionId = sectionIdFromHeader(header);
  if (!sectionId) return null;
  const resolved = doc.resolve(headerFrom);
  const section = resolved.parent;
  if (section.type.name !== SECTION_NODE || section.childCount !== 3) {
    return null;
  }
  const body = section.child(1);
  const children = section.child(2);
  if (
    body.type.name !== SECTION_BODY_NODE ||
    children.type.name !== SECTION_CHILDREN_NODE
  ) {
    return null;
  }
  let parentSectionId: string | null = null;
  let depth = 0;
  for (
    let ancestorDepth = resolved.depth - 1;
    ancestorDepth >= 0;
    ancestorDepth -= 1
  ) {
    const ancestor = resolved.node(ancestorDepth);
    if (ancestor.type.name !== SECTION_NODE) continue;
    // SectionChildren wrappers make ProseMirror depth grow by two per level;
    // fold depth counts only logical Section ancestors.
    depth += 1;
    parentSectionId ??= sectionIdFromHeader(ancestor.firstChild ?? ancestor);
  }
  const contentFrom = resolved.start(resolved.depth);
  return {
    sectionId,
    parentSectionId,
    depth,
    headerFrom,
    headerTo: headerFrom + header.nodeSize,
    hiddenFrom: headerFrom + header.nodeSize,
    hiddenTo: contentFrom + section.content.size,
    sectionFrom: contentFrom,
    sectionTo: contentFrom + section.content.size,
  };
}

function sectionFoldHeaderDecoration(entry: SectionFoldEntry): Decoration {
  return Decoration.node(entry.headerFrom, entry.headerTo, {
    "data-section-fold-state": "collapsed",
    "aria-expanded": "false",
  });
}

function transactionIntroducesCollapsedSection(
  transaction: Transaction,
  collapsedSectionIds: readonly string[],
  activeEntries: readonly SectionFoldEntry[],
): boolean {
  if (transaction.steps.length === 0 || collapsedSectionIds.length === 0) {
    return false;
  }
  const activeIds = new Set(activeEntries.map(({ sectionId }) => sectionId));
  const missingIds = new Set(
    collapsedSectionIds.filter((sectionId) => !activeIds.has(sectionId)),
  );
  if (missingIds.size === 0) return false;
  for (const step of transaction.steps) {
    const slice = (step as { slice?: unknown }).slice;
    if (!(slice instanceof Slice)) continue;
    let found = false;
    slice.content.descendants((node) => {
      if (
        node.type.name === SECTION_HEADER_NODE &&
        missingIds.has(String(node.attrs.sectionId ?? ""))
      ) {
        found = true;
        return false;
      }
      return !found;
    });
    if (found) return true;
  }
  return false;
}

function createSectionFoldPluginState(
  doc: ProseMirrorNode,
  requestedIds: readonly string[],
): SectionFoldPluginState {
  const collapsedSectionIds = normalizedSectionIds(requestedIds);
  const collapsed = new Set(collapsedSectionIds);
  const activeEntries = deriveEditorSectionFoldEntries(doc).filter((entry) =>
    collapsed.has(entry.sectionId),
  );
  return {
    collapsedSectionIds,
    collapsedSignature: collapsedSignature(collapsedSectionIds),
    activeEntries,
    decorations:
      activeEntries.length === 0
        ? DecorationSet.empty
        : DecorationSet.create(
            doc,
            activeEntries.map(sectionFoldHeaderDecoration),
          ),
  };
}

function mapSectionFoldPluginState(
  transaction: Transaction,
  previous: SectionFoldPluginState,
  state: EditorState,
): SectionFoldPluginState {
  if (
    transactionIntroducesCollapsedSection(
      transaction,
      previous.collapsedSectionIds,
      previous.activeEntries,
    )
  ) {
    return createSectionFoldPluginState(
      state.doc,
      previous.collapsedSectionIds,
    );
  }
  if (previous.activeEntries.length === 0) {
    return {
      ...previous,
      decorations: previous.decorations.map(transaction.mapping, state.doc),
    };
  }

  const mappedEntries: SectionFoldEntry[] = [];
  for (const entry of previous.activeEntries) {
    const mapped = transaction.mapping.mapResult(entry.headerFrom, 1);
    if (mapped.deleted) {
      return createSectionFoldPluginState(
        state.doc,
        previous.collapsedSectionIds,
      );
    }
    const next = entryAtHeaderPosition(state.doc, mapped.pos);
    if (!next || next.sectionId !== entry.sectionId) {
      return createSectionFoldPluginState(
        state.doc,
        previous.collapsedSectionIds,
      );
    }
    mappedEntries.push(next);
  }
  return {
    ...previous,
    activeEntries: mappedEntries,
    decorations: DecorationSet.create(
      state.doc,
      mappedEntries.map(sectionFoldHeaderDecoration),
    ),
  };
}

function outermostHiddenEntryAtPosition(
  state: SectionFoldPluginState | undefined,
  position: number,
): SectionFoldEntry | null {
  if (!state) return null;
  let result: SectionFoldEntry | null = null;
  for (const entry of state.activeEntries) {
    if (position < entry.hiddenFrom || position >= entry.hiddenTo) continue;
    if (!result || entry.depth < result.depth) result = entry;
  }
  return result;
}

function selectionFallbackPosition(
  doc: ProseMirrorNode,
  entry: SectionFoldEntry,
  requested: number,
): number {
  const first = entry.headerFrom + 1;
  const last = Math.max(first, entry.headerTo - 1);
  return Math.max(first, Math.min(requested, last, doc.content.size));
}

function scrollFoldCaretWhenLayoutIsAvailable(
  transaction: Transaction,
): Transaction {
  return typeof Range.prototype.getClientRects === "function"
    ? transaction.scrollIntoView()
    : transaction;
}

export const SectionFolding = Extension.create<SectionFoldingOptions>({
  name: "memokaSectionFolding",
  priority: 1_145,
  addOptions() {
    return { collapsedSectionIds: [] };
  },
  addProseMirrorPlugins() {
    const initialCollapsedSectionIds = this.options.collapsedSectionIds;
    return [
      new Plugin<SectionFoldPluginState>({
        key: sectionFoldPluginKey,
        view: (editorView) => {
          editorView.dom.dataset.sectionFolding = "true";
          return {
            destroy: () => {
              delete editorView.dom.dataset.sectionFolding;
            },
          };
        },
        state: {
          init: (_configuration, state) =>
            createSectionFoldPluginState(state.doc, initialCollapsedSectionIds),
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(sectionFoldPluginKey) as
              SectionFoldMeta | undefined;
            if (meta) {
              return createSectionFoldPluginState(
                newState.doc,
                meta.collapsedSectionIds,
              );
            }
            if (!transaction.docChanged) return previous;
            return mapSectionFoldPluginState(transaction, previous, newState);
          },
        },
        props: {
          decorations: (state) =>
            sectionFoldPluginKey.getState(state)?.decorations ?? null,
        },
        appendTransaction: (_transactions, _oldState, newState) => {
          const foldState = sectionFoldPluginKey.getState(newState);
          const hidden =
            outermostHiddenEntryAtPosition(
              foldState,
              newState.selection.head,
            ) ??
            outermostHiddenEntryAtPosition(
              foldState,
              newState.selection.anchor,
            );
          if (!hidden) return null;
          const position = selectionFallbackPosition(
            newState.doc,
            hidden,
            newState.selection.head,
          );
          return scrollFoldCaretWhenLayoutIsAvailable(
            newState.tr
              .setSelection(TextSelection.near(newState.doc.resolve(position)))
              .setMeta("addToHistory", false),
          );
        },
      }),
    ];
  },
});

export function sectionFoldCollapsedSectionIds(
  state: EditorState,
): readonly string[] {
  return sectionFoldPluginKey.getState(state)?.collapsedSectionIds ?? [];
}

export function sectionFoldStateSignature(state: EditorState): string {
  return sectionFoldPluginKey.getState(state)?.collapsedSignature ?? "";
}

export function sectionFoldHiddenEntries(
  state: EditorState,
): readonly SectionFoldEntry[] {
  return sectionFoldPluginKey.getState(state)?.activeEntries ?? [];
}

export function isPositionHiddenBySectionFold(
  state: EditorState,
  position: number,
): boolean {
  return Boolean(
    outermostHiddenEntryAtPosition(
      sectionFoldPluginKey.getState(state),
      position,
    ),
  );
}

export function setSectionFoldCollapsedSectionIds(
  view: EditorView,
  ids: readonly string[],
): boolean {
  const currentIds = sectionFoldCollapsedSectionIds(view.state);
  if (sameIds(currentIds, ids)) return false;
  const normalized = normalizedSectionIds(ids);
  if (
    collapsedSignature(normalized) === sectionFoldStateSignature(view.state)
  ) {
    return false;
  }
  view.dispatch(
    view.state.tr
      .setMeta(sectionFoldPluginKey, {
        collapsedSectionIds: normalized,
      } satisfies SectionFoldMeta)
      .setMeta("addToHistory", false),
  );
  return true;
}

function targetSectionEntry(
  entries: readonly SectionFoldEntry[],
  position: number,
): SectionFoldEntry | null {
  let target: SectionFoldEntry | null = null;
  for (const entry of entries) {
    if (position < entry.sectionFrom || position > entry.sectionTo) continue;
    if (!target || entry.depth > target.depth) target = entry;
  }
  return target;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((sectionId, index) => sectionId === right[index])
  );
}

export function runSectionFoldCommand(
  view: EditorView,
  action: SectionFoldAction,
): SectionFoldCommandResult {
  const entries = deriveEditorSectionFoldEntries(view.state.doc);
  const currentIds = sectionFoldCollapsedSectionIds(view.state);
  const target = targetSectionEntry(entries, view.state.selection.head);
  if (!target) {
    return {
      handled: false,
      changed: false,
      targetSectionId: null,
      collapsedSectionIds: currentIds,
      detail: `section:fold-${action}:unavailable`,
    };
  }
  const targetIndex = entries.indexOf(target);
  const subtreeIds: string[] = [];
  for (let index = targetIndex; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index > targetIndex && entry.depth <= target.depth) break;
    subtreeIds.push(entry.sectionId);
  }
  const next = new Set(currentIds);
  const targetCollapsed = next.has(target.sectionId);
  let closesTarget = false;
  if (action === "open") next.delete(target.sectionId);
  else if (action === "open-recursive") {
    for (const sectionId of subtreeIds) next.delete(sectionId);
  } else if (action === "close") {
    next.add(target.sectionId);
    closesTarget = true;
  } else if (action === "close-recursive") {
    for (const sectionId of subtreeIds) next.add(sectionId);
    closesTarget = true;
  } else if (action === "toggle") {
    if (targetCollapsed) next.delete(target.sectionId);
    else {
      next.add(target.sectionId);
      closesTarget = true;
    }
  } else if (targetCollapsed) {
    for (const sectionId of subtreeIds) next.delete(sectionId);
  } else {
    for (const sectionId of subtreeIds) next.add(sectionId);
    closesTarget = true;
  }

  const collapsedSectionIds = normalizedSectionIds([...next]);
  if (sameIds(currentIds, collapsedSectionIds)) {
    return {
      handled: false,
      changed: false,
      targetSectionId: target.sectionId,
      collapsedSectionIds: currentIds,
      detail: `section:fold-${action}:boundary`,
    };
  }
  let transaction = view.state.tr
    .setMeta(sectionFoldPluginKey, {
      collapsedSectionIds,
    } satisfies SectionFoldMeta)
    .setMeta("addToHistory", false);
  if (closesTarget) {
    const position = selectionFallbackPosition(
      transaction.doc,
      target,
      view.state.selection.head,
    );
    transaction = transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(position)),
    );
  }
  view.dispatch(scrollFoldCaretWhenLayoutIsAvailable(transaction));
  view.focus();
  return {
    handled: true,
    changed: true,
    targetSectionId: target.sectionId,
    collapsedSectionIds,
    detail: `section:fold-${action}`,
  };
}

export function revealSectionFoldsAtPosition(
  view: EditorView,
  position: number,
): SectionFoldRevealResult {
  const foldState = sectionFoldPluginKey.getState(view.state);
  const currentIds = foldState?.collapsedSectionIds ?? [];
  const entries = deriveEditorSectionFoldEntries(view.state.doc);
  const target = targetSectionEntry(entries, position);
  if (!foldState || !target) {
    return {
      changed: false,
      targetSectionId: target?.sectionId ?? null,
      collapsedSectionIds: currentIds,
    };
  }
  const hidingEntries = foldState.activeEntries.filter(
    (entry) => position >= entry.hiddenFrom && position < entry.hiddenTo,
  );
  if (hidingEntries.length === 0) {
    return {
      changed: false,
      targetSectionId: target.sectionId,
      collapsedSectionIds: currentIds,
    };
  }
  const next = new Set(currentIds);
  for (const entry of hidingEntries) next.delete(entry.sectionId);
  const collapsedSectionIds = normalizedSectionIds([...next]);
  setSectionFoldCollapsedSectionIds(view, collapsedSectionIds);
  return {
    changed: true,
    targetSectionId: target.sectionId,
    collapsedSectionIds,
  };
}
