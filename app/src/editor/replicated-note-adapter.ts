import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import * as Y from "yjs";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  updateYFragment,
} from "y-prosemirror";
import { assertUuidV7, createUuidV7 } from "../core/ids";
import {
  derivedReplicaId,
  ReplicatedNote,
  type ContentNode,
} from "../core/replicated-note";
import { siblingPositionsBetween } from "../core/sibling-position";
import {
  BODY_CHUNK_TARGET_BLOCKS,
  BODY_CHUNK_TARGET_BYTES,
} from "../core/section-model";
import {
  replicatedNotePluginKey,
  REPLICATED_PROJECTION,
  isReplicatedProjection,
  type ReplicatedCursor as Cursor,
} from "../core/replicated-editor-binding";
export { replicatedNotePluginKey } from "../core/replicated-editor-binding";

type BindingMetadata = Parameters<typeof updateYFragment>[3];
interface EntityView {
  readonly id: string;
  readonly node: ProseMirrorNode;
  readonly parentId: string;
  readonly region: string;
  readonly path: readonly number[];
}

/**
 * A ProseMirror projection over stable entities, with an independent inline
 * binding per textblock. There is no nested XML document binding and moving a
 * block never calls updateYFragment on its parent container.
 */
export class ReplicatedNoteAdapter {
  readonly plugin: Plugin;
  private view: EditorView | null = null;
  private writing = false;
  private rendering = false;
  private readonly inlineBindings = new Map<string, BindingMetadata>();
  private paths = new Map<string, EntityView>();
  private beforeSelection: {
    anchor: Cursor | null;
    head: Cursor | null;
  } | null = null;
  private endComposition: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly pendingTransactions: Transaction[] = [];
  private readonly childOffsets = new WeakMap<
    ProseMirrorNode,
    readonly number[]
  >();
  private destroyed = false;
  /** Diagnostics for meaningful incremental-work assertions. */
  readonly work = {
    inlineWrites: 0,
    structuralWrites: 0,
    fullRenders: 0,
    elementRenders: 0,
  };

  constructor(
    readonly note: ReplicatedNote,
    readonly schema: Schema,
    public sectionId = note.noteId,
  ) {
    this.plugin = new Plugin({
      key: replicatedNotePluginKey,
      state: {
        init: () => ({ adapter: this, undoManager: this.note.history }),
        apply: (transaction, value) => {
          if (
            transaction.docChanged &&
            !this.rendering &&
            !isReplicatedProjection(transaction)
          )
            this.pendingTransactions.push(transaction);
          return value;
        },
      },
      props: {
        handleDOMEvents: {
          compositionstart: () => {
            this.endComposition ??= this.note.beginComposition();
            return false;
          },
          compositionend: () => {
            // Let ProseMirror flush the committed DOM text before draining inbox changes.
            setTimeout(() => {
              const end = this.endComposition;
              this.endComposition = null;
              end?.();
            }, 0);
            return false;
          },
        },
        handleKeyDown: (_view, event) => {
          if (
            !(event.ctrlKey || event.metaKey) ||
            event.altKey ||
            event.key.toLowerCase() !== "z"
          )
            return false;
          return event.shiftKey ? this.note.redo() : this.note.undo();
        },
      },
      view: (view) => {
        this.view = view;
        this.note.doc.on("beforeAllTransactions", this.captureSelection);
        this.note.doc.on("afterAllTransactions", this.finishReceiving);
        this.unsubscribe = this.note.subscribe(this.receiveChanges);
        this.index(view.state.doc);
        return {
          update: () => {
            if (this.rendering) return;
            const pending = this.pendingTransactions.splice(0);
            // Identity/chunk plugins append repairs to the same PM dispatch.
            // Only its final, validated document may cross the CRDT boundary.
            if (pending.length)
              this.writeChanges(pending[0]!.before, view.state.doc);
          },
          destroy: () => this.destroy(),
        };
      },
    });
  }

  createState(plugins: readonly Plugin[] = []): EditorState {
    return EditorState.create({
      schema: this.schema,
      doc: this.renderDocument(),
      plugins: [this.plugin, ...plugins],
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.note.doc.off("beforeAllTransactions", this.captureSelection);
    this.note.doc.off("afterAllTransactions", this.finishReceiving);
    this.view = null;
    this.endComposition?.();
    this.endComposition = null;
    this.inlineBindings.clear();
    this.paths.clear();
  }

  renderDocument(): ProseMirrorNode {
    this.work.fullRenders++;
    this.sectionId = this.note.visibleSectionAncestor(this.sectionId);
    const section = this.renderSection(this.sectionId);
    return this.schema.topNodeType.createChecked(null, section.content);
  }

  setSectionId(id: string): boolean {
    assertUuidV7(id, "focusedSectionId");
    if (this.sectionId === id) return false;
    this.sectionId = id;
    if (this.view) this.receiveChanges(new Set(), true);
    return true;
  }

  private renderSection(id: string): ProseMirrorNode {
    const tree = this.note.project();
    const attrs = this.note.attributes(id).toJSON();
    const children = tree.children.get(id) ?? [];
    const blocks = children
      .filter((child) => tree.parents.get(child)!.region === "body")
      .map((child) => this.schema.nodeFromJSON(this.note.blockSnapshot(child)));
    const chunks: ProseMirrorNode[] = [];
    let pending: ProseMirrorNode[] = [],
      bytes = 0;
    const flush = () => {
      if (!pending.length) return;
      const chunkId = derivedReplicaId(
        id,
        `chunk:${String(pending[0]!.attrs.blockId)}`,
      );
      chunks.push(
        this.schema.nodes.bodyChunk!.createChecked({ chunkId }, pending),
      );
      pending = [];
      bytes = 0;
    };
    for (const block of blocks) {
      const size = new TextEncoder().encode(
        JSON.stringify(block.toJSON()),
      ).length;
      if (
        pending.length &&
        (pending.length >= BODY_CHUNK_TARGET_BLOCKS ||
          bytes + size > BODY_CHUNK_TARGET_BYTES)
      )
        flush();
      pending.push(block);
      bytes += size;
    }
    flush();
    return this.schema.nodes.section!.createChecked(null, [
      this.schema.nodes.sectionHeader!.createChecked(
        { ...attrs, sectionId: id, tags: JSON.stringify(attrs.tags ?? []) },
        this.note
          .inlineContent(id)
          .map((node) => this.schema.nodeFromJSON(node)),
      ),
      this.schema.nodes.sectionBody!.createChecked(null, chunks),
      this.schema.nodes.sectionChildren!.createChecked(
        null,
        children
          .filter((child) => this.note.type(child) === "section")
          .map((child) => this.renderSection(child)),
      ),
    ]);
  }

  private renderEntity(id: string, old: ProseMirrorNode): ProseMirrorNode {
    this.work.elementRenders++;
    if (old.type.name === "sectionHeader")
      return old.type.createChecked(
        {
          ...this.note.attributes(id).toJSON(),
          sectionId: id,
          tags: JSON.stringify(this.note.attributes(id).get("tags") ?? []),
        },
        this.note
          .inlineContent(id)
          .map((node) => this.schema.nodeFromJSON(node)),
      );
    return this.schema.nodeFromJSON(this.note.blockSnapshot(id));
  }

  private index(doc: ProseMirrorNode): void {
    this.paths = scanEntities(doc, this.sectionId);
  }

  private locate(
    id: string,
    doc: ProseMirrorNode,
  ): { node: ProseMirrorNode; position: number } | null {
    const entity = this.paths.get(id);
    if (!entity) return null;
    let parent = doc,
      position = -1;
    for (const index of entity.path) {
      if (index >= parent.childCount) return null;
      let offsets = this.childOffsets.get(parent);
      if (!offsets) {
        const next: number[] = [];
        let offset = 0;
        parent.forEach((node) => {
          next.push(offset);
          offset += node.nodeSize;
        });
        offsets = next;
        this.childOffsets.set(parent, offsets);
      }
      position += 1 + offsets[index]!;
      parent = parent.child(index);
    }
    return { node: parent, position };
  }

  private metadata(id: string, node: ProseMirrorNode): BindingMetadata {
    let metadata = this.inlineBindings.get(id);
    if (!metadata) {
      metadata = { mapping: new Map(), isOMark: new Map() };
      this.inlineBindings.set(id, metadata);
    }
    // Reading inline JSON never invokes y-prosemirror's repair-on-render behavior.
    // Only atoms need a node-size mapping for relative position conversion.
    let offset = 0;
    for (const child of this.note.inline(id).toArray()) {
      if (child instanceof Y.XmlText) {
        const nodes: ProseMirrorNode[] = [];
        node.content
          .cut(offset, offset + child.length)
          .forEach((item) => nodes.push(item));
        metadata.mapping.set(child, nodes);
        offset += child.length;
      } else if (child instanceof Y.XmlElement) {
        const inline = node.nodeAt(offset);
        if (inline) {
          metadata.mapping.set(child, inline);
          offset += inline.nodeSize;
        }
      }
    }
    return metadata;
  }

  cursor(position: number): Cursor | null {
    if (!this.view) return null;
    const resolved = this.view.state.doc.resolve(position);
    const node = resolved.parent;
    const id = identity(node);
    if (!id || !node.isTextblock || !this.note.entities.has(id)) return null;
    return {
      entityId: id,
      relative: absolutePositionToRelativePosition(
        resolved.parentOffset,
        this.note.inline(id),
        this.metadata(id, node).mapping,
      ),
    };
  }

  resolveCursor(cursor: Cursor | null, doc: ProseMirrorNode): number | null {
    if (!cursor || !this.note.project().visible.has(cursor.entityId))
      return null;
    const located = this.locate(cursor.entityId, doc);
    if (!located?.node.isTextblock) return null;
    const offset = relativePositionToAbsolutePosition(
      this.note.doc,
      this.note.inline(cursor.entityId),
      cursor.relative,
      this.metadata(cursor.entityId, located.node).mapping,
    );
    return offset === null
      ? null
      : located.position +
          1 +
          Math.min(Math.max(0, offset), located.node.content.size);
  }

  private readonly captureSelection = (): void => {
    if (!this.view || this.writing || this.rendering || this.beforeSelection)
      return;
    this.beforeSelection = {
      anchor: this.cursor(this.view.state.selection.anchor),
      head: this.cursor(this.view.state.selection.head),
    };
  };

  private readonly finishReceiving = (): void => {
    this.beforeSelection = null;
  };

  private readonly receiveChanges = (
    ids: ReadonlySet<string>,
    structural: boolean,
  ): void => {
    const view = this.view;
    if (!view || this.writing || this.rendering || this.destroyed) return;
    this.rendering = true;
    try {
      this.refresh(view, ids, structural);
    } finally {
      this.rendering = false;
      this.beforeSelection = null;
    }
  };

  private refresh(
    view: EditorView,
    ids: ReadonlySet<string>,
    structural: boolean,
  ): void {
    let transaction = view.state.tr;
    if (structural) {
      const next = this.renderDocument();
      if (transaction.doc.eq(next)) return;
      patchProjection(transaction, transaction.doc, next, -1);
      this.index(transaction.doc);
    } else {
      const updates = [...ids]
        .flatMap((id) => {
          const located = this.locate(id, transaction.doc);
          return located ? [{ id, ...located }] : [];
        })
        .sort((a, b) => b.position - a.position);
      for (const update of updates) {
        const next = this.renderEntity(update.id, update.node);
        if (!next.eq(update.node))
          transaction = transaction.replaceWith(
            update.position,
            update.position + update.node.nodeSize,
            next,
          );
      }
    }
    if (!transaction.docChanged) return;
    const saved = this.beforeSelection;
    if (saved) {
      const anchor = this.resolveCursor(saved.anchor, transaction.doc),
        head = this.resolveCursor(saved.head, transaction.doc);
      if (anchor !== null && head !== null)
        transaction = transaction.setSelection(
          TextSelection.create(transaction.doc, anchor, head),
        );
    }
    view.dispatch(
      transaction
        .setMeta(REPLICATED_PROJECTION, true)
        .setMeta("addToHistory", false),
    );
  }

  private writeChanges(previous: ProseMirrorNode, next: ProseMirrorNode): void {
    if (previous.eq(next)) return;
    this.writing = true;
    try {
      const from = previous.content.findDiffStart(next.content);
      const end = previous.content.findDiffEnd(next.content);
      if (from === null || !end) return;
      const before = previous.resolve(from),
        after = next.resolve(from);
      const id = identity(after.parent);
      if (
        id &&
        this.note.entities.has(id) &&
        before.parent.isTextblock &&
        after.parent.isTextblock &&
        identity(before.parent) === id &&
        before.parent.type === after.parent.type &&
        before.sameParent(previous.resolve(Math.max(from, end.a))) &&
        after.sameParent(next.resolve(Math.max(from, end.b)))
      ) {
        this.note.transact(() =>
          this.writeInline(id, before.parent, after.parent),
        );
      } else {
        this.work.structuralWrites++;
        this.writeStructure(previous, next);
        this.index(next);
      }
    } finally {
      this.writing = false;
    }
  }

  private writeInline(
    id: string,
    previous: ProseMirrorNode | undefined,
    node: ProseMirrorNode,
  ): void {
    const attrs = this.note.attributes(id);
    for (const key of new Set([
      ...Object.keys(previous?.attrs ?? {}),
      ...Object.keys(node.attrs),
    ])) {
      if (key === "blockId" || key === "sectionId") continue;
      if (
        JSON.stringify(previous?.attrs[key]) === JSON.stringify(node.attrs[key])
      )
        continue;
      if (node.attrs[key] === undefined || node.attrs[key] === null)
        attrs.delete(key);
      else
        attrs.set(
          key,
          node.type.name === "sectionHeader" &&
            key === "tags" &&
            typeof node.attrs[key] === "string"
            ? JSON.parse(node.attrs[key])
            : node.attrs[key],
        );
    }
    if (node.isTextblock && (!previous || !previous.content.eq(node.content))) {
      this.work.inlineWrites++;
      updateYFragment(
        this.note.doc,
        this.note.inline(id),
        node,
        this.metadata(id, previous ?? node),
      );
    }
  }

  private writeStructure(
    before: ProseMirrorNode,
    after: ProseMirrorNode,
  ): void {
    const previous = scanEntities(before, this.sectionId),
      next = scanEntities(after, this.sectionId);
    const tree = this.note.project();
    const groups = new Map<string, EntityView[]>();
    const tableColumns = new Map<string, string[]>();
    const cellColumns = new Map<string, string>();
    const removedColumns: string[] = [];
    for (const entry of next.values())
      if (entry.node.type.name === "table") {
        const rows: ProseMirrorNode[] = [];
        entry.node.forEach((row) => rows.push(row));
        const count = rows[0]?.childCount ?? 0;
        if (!count || rows.some((row) => row.childCount !== count))
          throw new Error("Table must have a rectangular row/column layout");
        const columns: string[] = [];
        const existingColumns = (tree.children.get(entry.id) ?? []).filter(
          (id) => this.note.type(id) === "tableColumn",
        );
        for (let column = 0; column < count; column++) {
          const known = new Set(
            rows.flatMap((row) => {
              const id = identity(row.child(column));
              const coordinate = id
                ? this.note.entities.get(id)?.columnId
                : undefined;
              const rowId = identity(row);
              const derived =
                rowId && id
                  ? existingColumns.find(
                      (columnId) =>
                        derivedReplicaId(rowId, `cell:${columnId}`) === id,
                    )
                  : undefined;
              return coordinate ? [coordinate] : derived ? [derived] : [];
            }),
          );
          if (known.size > 1)
            throw new Error("Table cells disagree about a stable column");
          const columnId = [...known][0] ?? createUuidV7();
          columns.push(columnId);
          for (const row of rows)
            cellColumns.set(identity(row.child(column))!, columnId);
        }
        if (new Set(columns).size !== columns.length)
          throw new Error("Duplicate Table column");
        if (
          columns.length !== existingColumns.length ||
          columns.some((id, index) => existingColumns[index] !== id)
        )
          tableColumns.set(entry.id, columns);
        for (const child of tree.children.get(entry.id) ?? [])
          if (
            this.note.type(child) === "tableColumn" &&
            !columns.includes(child)
          )
            removedColumns.push(child);
      }
    for (const entry of next.values()) {
      if (entry.id === this.sectionId) continue;
      const key = JSON.stringify([entry.parentId, entry.region]);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    const positions = new Map<string, string>();
    for (const group of groups.values()) {
      const unchanged = (tree.children.get(group[0]!.parentId) ?? []).filter(
        (id) => tree.parents.get(id)!.region === group[0]!.region,
      );
      if (
        unchanged.length === group.length &&
        group.every((entry, index) => unchanged[index] === entry.id)
      ) {
        for (const entry of group)
          positions.set(entry.id, tree.parents.get(entry.id)!.position);
        continue;
      }
      const stable = longestIncreasingEntries(
        group.filter((entry) => {
          const edge = tree.parents.get(entry.id);
          return (
            edge?.parentId === entry.parentId && edge.region === entry.region
          );
        }),
        (id) => tree.parents.get(id)!.position,
      );
      let lower: string | null = null,
        index = 0;
      while (index < group.length) {
        let end = index;
        while (end < group.length && !stable.has(group[end]!.id)) end++;
        const upper =
          end < group.length
            ? tree.parents.get(group[end]!.id)!.position
            : null;
        const generated = siblingPositionsBetween(
          lower,
          upper,
          end - index,
          this.note.replicaId + group[index]!.id,
        );
        for (let offset = index; offset < end; offset++)
          positions.set(group[offset]!.id, generated[offset - index]!);
        if (end < group.length) {
          positions.set(group[end]!.id, upper!);
          lower = upper;
        }
        index = end + 1;
      }
    }
    this.note.transact(() => {
      for (const entry of next.values()) {
        const prior = previous.get(entry.id);
        if (!this.note.entities.has(entry.id) && prior?.node.eq(entry.node))
          continue;
        if (!this.note.entities.has(entry.id))
          this.note.createEntity(
            entry.node.type.name === "sectionHeader"
              ? "section"
              : entry.node.type.name,
            entry.parentId,
            entry.region,
            positions.get(entry.id)!,
            {
              id: entry.id,
              ...(cellColumns.has(entry.id)
                ? { columnId: cellColumns.get(entry.id)! }
                : {}),
            },
          );
        const columns = tableColumns.get(entry.id);
        if (columns) {
          const columnPositions = siblingPositionsBetween(
            null,
            null,
            columns.length,
            entry.id,
          );
          for (const [index, column] of columns.entries()) {
            const position = columnPositions[index]!;
            if (!this.note.entities.has(column))
              this.note.createEntity(
                "tableColumn",
                entry.id,
                "columns",
                position,
                { id: column },
              );
            else if (tree.parents.get(column)?.position !== position)
              this.note.move(column, entry.id, "columns", position);
          }
        }
        if (prior?.node === entry.node) continue;
        if (prior && prior.node.type !== entry.node.type)
          this.note.attributes(entry.id).set("type", entry.node.type.name);
        this.writeInline(entry.id, prior?.node, entry.node);
      }
      const moves = [...next.values()].flatMap((entry) => {
        if (entry.id === this.sectionId) return [];
        const prior = tree.parents.get(entry.id),
          position = positions.get(entry.id)!;
        return prior &&
          (prior.parentId !== entry.parentId ||
            prior.region !== entry.region ||
            prior.position !== position)
          ? [
              {
                entityId: entry.id,
                parentId: entry.parentId,
                region: entry.region,
                position,
              },
            ]
          : [];
      });
      this.note.moveMany(moves);
      const visible = this.note.project().visible;
      const removed = [...previous.keys()].filter(
        (id) => !next.has(id) && visible.has(id),
      );
      removed.push(...removedColumns);
      if (removed.length) this.note.deleteMany(removed);
    });
  }
}

/** Replace complete structural nodes so an open Slice cannot split and duplicate an ID. */
function patchProjection(
  transaction: Transaction,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  position: number,
): void {
  if (before.eq(after)) return;
  const key = (node: ProseMirrorNode) =>
    identity(node) ??
    (node.type.name === "section"
      ? node.firstChild?.attrs.sectionId
      : node.type.name === "bodyChunk"
        ? node.attrs.chunkId
        : node.type.name);
  let sameChildren =
    before.sameMarkup(after) &&
    before.childCount === after.childCount &&
    !before.isTextblock;
  if (sameChildren)
    for (let index = 0; index < before.childCount; index++)
      if (key(before.child(index)) !== key(after.child(index)))
        sameChildren = false;
  if (!sameChildren) {
    if (position < 0)
      transaction.replaceWith(0, before.content.size, after.content);
    else transaction.replaceWith(position, position + before.nodeSize, after);
    return;
  }
  let offset = before.content.size;
  for (let index = before.childCount - 1; index >= 0; index--) {
    const child = before.child(index);
    offset -= child.nodeSize;
    patchProjection(
      transaction,
      child,
      after.child(index),
      position + 1 + offset,
    );
  }
}

function identity(node: ProseMirrorNode): string | null {
  const id =
    node.type.name === "sectionHeader"
      ? node.attrs.sectionId
      : node.attrs.blockId;
  return typeof id === "string" && id ? id : null;
}

function scanEntities(
  doc: ProseMirrorNode,
  rootId: string,
): Map<string, EntityView> {
  const result = new Map<string, EntityView>();
  const visit = (
    node: ProseMirrorNode,
    parentId: string,
    region: string,
    path: number[],
    depth: number,
  ): void => {
    if (depth > 128) throw new Error("Editor structure depth limit exceeded");
    if (node.type.name === "section") {
      const id = node.firstChild?.attrs.sectionId;
      if (typeof id !== "string") throw new Error("Section has no identity");
      node.forEach((child, _offset, index) =>
        visit(
          child,
          index === 0 ? parentId : id,
          index === 0 ? "sections" : "content",
          [...path, index],
          depth + 1,
        ),
      );
      return;
    }
    const id = identity(node);
    if (!id && "blockId" in node.attrs)
      throw new Error("Editor block has no stable identity");
    if (id) {
      assertUuidV7(id, "editor entityId");
      if (result.has(id))
        throw new Error(
          `Editor contains duplicate stable IDs at ${JSON.stringify(result.get(id)!.path)} and ${JSON.stringify(path)} (${node.type.name}); copies need fresh IDs`,
        );
      result.set(id, { id, node, parentId, region, path });
      if (node.isTextblock) return;
      parentId = id;
      region =
        node.type.name === "table"
          ? "rows"
          : node.type.name === "tableRow"
            ? "cells"
            : "content";
    } else if (node.type.name === "sectionBody") region = "body";
    else if (node.type.name === "sectionChildren") region = "sections";
    node.forEach((child, _offset, index) =>
      visit(child, parentId, region, [...path, index], depth + 1),
    );
  };
  visit(doc, rootId, "sections", [], 0);
  return result;
}

/** Retain the largest already ordered subset; moving one block writes one edge. */
function longestIncreasingEntries(
  entries: readonly EntityView[],
  position: (id: string) => string,
): Set<string> {
  const tails: number[] = [],
    predecessors = new Map<number, number>();
  for (const [index, entry] of entries.entries()) {
    let lower = 0,
      upper = tails.length;
    while (lower < upper) {
      const middle = (lower + upper) >> 1;
      if (position(entries[tails[middle]!]!.id) < position(entry.id))
        lower = middle + 1;
      else upper = middle;
    }
    if (lower) predecessors.set(index, tails[lower - 1]!);
    tails[lower] = index;
  }
  const result = new Set<string>();
  let cursor: number | undefined = tails.at(-1);
  while (cursor !== undefined) {
    result.add(entries[cursor]!.id);
    cursor = predecessors.get(cursor);
  }
  return result;
}

/** The same schema used by the shipping Editor can be supplied without mounting TipTap. */
export function replicatedInlineFragment(
  schema: Schema,
  nodes: readonly ContentNode[],
): Fragment {
  return Fragment.fromArray(nodes.map((node) => schema.nodeFromJSON(node)));
}
