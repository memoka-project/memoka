import * as Y from "yjs";
import { digest } from "lib0/hash/sha256";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { assertUuidV7, createUuidV7 } from "./ids";
import type { EditorHistory, EditorHistoryItem } from "./editor-history";
import {
  deriveReplicatedTree,
  validatePlacement,
  type Placement,
  type TreeProjection,
} from "./replicated-tree";
import { siblingPositionsBetween } from "./sibling-position";
import {
  MAX_SECTION_DEPTH,
  validateSectionSnapshotDepth,
  type SectionSnapshot,
} from "./section-model";

/** Current persisted Note model; legacy schemas are retained for migration/readers. */
export const REPLICATED_NOTE_SCHEMA_VERSION = 7;
export const REPLICATED_REMOTE_ORIGIN = Symbol("memoka:replicated-remote");
export const REPLICATED_BOOTSTRAP_ORIGIN = Symbol(
  "memoka:replicated-bootstrap",
);
const MAX_UPDATE_BYTES = 16 * 1024 * 1024;
const MAX_ENTITIES = 200_000;
const MAX_OPERATIONS = 1_000_000;

export interface ContentNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly text?: string;
  readonly marks?: readonly {
    type: string;
    attrs?: Readonly<Record<string, unknown>>;
  }[];
  readonly content?: readonly ContentNode[];
}

export interface EntityDescriptor {
  readonly id: string;
  readonly type: string;
  /** A cell's coordinates are immutable; row/column insertion never shifts them. */
  readonly columnId?: string;
  /** Deterministic virtual cells may be materialized concurrently on two replicas. */
  readonly contentRoot?: true;
}

export interface Deletion {
  readonly operationId: string;
  readonly replicaId: string;
  readonly entityIds: readonly string[];
}

export interface Restoration {
  readonly operationId: string;
  readonly replicaId: string;
  readonly deletionId: string;
  readonly entityIds: readonly string[];
}

export interface ProtectedContent {
  readonly entityId: string;
  readonly reason: "deleted" | "deleted-parent" | "incompatible-type";
  readonly deletionIds: readonly string[];
}

export interface ReplicatedNoteProjection extends TreeProjection {
  readonly visible: ReadonlySet<string>;
  readonly recovery: readonly ProtectedContent[];
  readonly depthCorrections: readonly string[];
}

interface UndoFrame {
  readonly actions: (() => void)[];
  readonly text: boolean;
  readonly scope: (Y.Map<unknown> | Y.XmlFragment)[];
}

interface UndoGroup extends EditorHistoryItem {
  readonly frames: UndoFrame[];
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "blockquote",
  "details",
  "detailsSummary",
  "detailsBody",
  "horizontalRule",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "image",
  "attachment",
  "sourceBlock",
  "table",
  "tableRow",
  "tableColumn",
  "tableCell",
  "tableHeader",
]);
const TEXT_TYPES = new Set([
  "section",
  "paragraph",
  "detailsSummary",
  "codeBlock",
  "sourceBlock",
]);
const CONTAINER_TYPES = new Set([
  "blockquote",
  "detailsBody",
  "listItem",
  "tableCell",
  "tableHeader",
]);
const ATOM_TYPES = new Set(["horizontalRule", "image", "attachment"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inlineXml(
  nodes: readonly ContentNode[],
): (Y.XmlElement | Y.XmlText)[] {
  const result: (Y.XmlElement | Y.XmlText)[] = [];
  let delta: { insert: string; attributes: Record<string, unknown> }[] = [];
  const flush = () => {
    if (!delta.length) return;
    const text = new Y.XmlText();
    text.applyDelta(delta);
    result.push(text);
    delta = [];
  };
  for (const node of nodes) {
    validateInline(node);
    if (node.type === "text") {
      if (typeof node.text !== "string" || !node.text.length)
        throw new Error("Invalid inline text");
      const attrs = Object.fromEntries(
        (node.marks ?? []).map((mark) => [mark.type, mark.attrs ?? {}]),
      );
      delta.push({ insert: node.text, attributes: attrs });
    } else {
      if (node.type !== "hardBreak" && node.type !== "internalSectionLink")
        throw new Error("Invalid inline node");
      flush();
      const element = new Y.XmlElement(node.type);
      for (const [key, value] of Object.entries(node.attrs ?? {}))
        element.setAttribute(key, value as string);
      if (node.content?.length) element.insert(0, inlineXml(node.content));
      result.push(element);
    }
  }
  flush();
  return result;
}

/** Deterministic UUIDv7 for a *derived* view identity, never a security key. */
export function derivedReplicaId(namespaceId: string, label: string): string {
  assertUuidV7(namespaceId, "namespaceId");
  const bytes = digest(
    new TextEncoder().encode(JSON.stringify([namespaceId, label])),
  ).slice(0, 16);
  const timestamp = namespaceId.replaceAll("-", "").slice(0, 12);
  for (let index = 0; index < 6; index++)
    bytes[index] = parseInt(timestamp.slice(index * 2, index * 2 + 2), 16);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable entity storage. No content type is owned by a placement, another block,
 * or a BodyChunk. A fixed content registry keeps update encoding linear in a
 * large Note. Only deterministic virtual cells use named roots so concurrent
 * materialization cannot replace another replica's content map.
 */
export class ReplicatedNote {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly entities: Y.Map<EntityDescriptor>;
  readonly placements: Y.Map<Placement>;
  readonly deletions: Y.Map<Deletion>;
  readonly restorations: Y.Map<Restoration>;
  readonly content: Y.Map<Y.Map<unknown>>;
  readonly localOrigin = Symbol("memoka:replicated-local");
  readonly undoManager: Y.UndoManager;
  /** Product history groups semantic inverses and text undo into one Vim change. */
  readonly history: EditorHistory;
  clock: () => string = () => new Date().toISOString();
  private projectionCache: ReplicatedNoteProjection | null = null;
  private composing = 0;
  private pendingBytes = 0;
  private readonly pending: Uint8Array[] = [];
  private readonly listeners = new Set<
    (ids: ReadonlySet<string>, structural: boolean, origin: unknown) => void
  >();
  private readonly owners = new WeakMap<object, string>();
  private logicalCounter = 0;
  private readonly newEntities = new Set<string>();
  private transactionDepth = 0;
  private inverseActions: (() => void)[] | null = null;
  private creationUndoIds: Set<string> | null = null;
  private replaying = false;
  private readonly undoFrames: UndoFrame[] = [];
  private readonly redoFrames: UndoFrame[] = [];
  private readonly undoGroups: UndoGroup[] = [];
  private readonly redoGroups: UndoGroup[] = [];

  constructor(
    readonly noteId: string,
    readonly replicaId: string,
    doc = new Y.Doc({ guid: noteId, gc: false }),
  ) {
    assertUuidV7(noteId, "noteId");
    assertUuidV7(replicaId, "replicaId");
    this.doc = doc;
    this.meta = doc.getMap("meta");
    this.entities = doc.getMap("entities");
    this.placements = doc.getMap("placements");
    this.deletions = doc.getMap("deletions");
    this.restorations = doc.getMap("restorations");
    this.content = doc.getMap("content");
    // Product loading can hand us an already populated Y.Doc, so no observer
    // saw its initial placements. A new move must follow all observed history.
    for (const edge of this.placements.values())
      if (
        Number.isSafeInteger(edge?.counter) &&
        edge.counter > this.logicalCounter
      )
        this.logicalCounter = edge.counter;
    this.undoManager = new Y.UndoManager([], {
      doc,
      trackedOrigins: new Set([this.localOrigin]),
      captureTimeout: 500,
    });
    this.history = {
      doc,
      undoStack: this.undoGroups,
      redoStack: this.redoGroups,
      captureTimeout: 500,
      lastChange: 0,
      stopCapturing() {
        this.lastChange = 0;
      },
      clear: () => this.clearUndo(),
      destroy: () => this.clearUndo(),
    };
    doc.on("afterTransaction", this.observe);
  }

  static create(noteId: string, replicaId: string, title = ""): ReplicatedNote {
    const note = new ReplicatedNote(noteId, replicaId);
    note.doc.transact(() => {
      note.meta.set("note_id", noteId);
      note.meta.set("schema_version", REPLICATED_NOTE_SCHEMA_VERSION);
      note.meta.set("content_layout", "entity-map");
      note.entities.set(noteId, { id: noteId, type: "section" });
      note.initializeContent(noteId);
      if (title) note.inline(noteId).insert(0, [new Y.XmlText(title)]);
      note.attributes(noteId).set("tags", []);
    }, REPLICATED_BOOTSTRAP_ORIGIN);
    return note;
  }

  static load(
    noteId: string,
    replicaId: string,
    snapshot: Uint8Array,
    updates: readonly Uint8Array[] = [],
  ): ReplicatedNote {
    const note = new ReplicatedNote(noteId, replicaId);
    try {
      for (const update of [snapshot, ...updates])
        Y.applyUpdate(note.doc, update, REPLICATED_BOOTSTRAP_ORIGIN);
      note.validate();
      return note;
    } catch (error) {
      note.destroy();
      throw error;
    }
  }

  destroy(): void {
    this.undoManager.destroy();
    this.doc.destroy();
    this.listeners.clear();
    this.pending.length = 0;
  }
  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  attributes(id: string): Y.Map<unknown> {
    assertUuidV7(id, "entityId");
    const attrs = this.namedContent(id)
      ? this.doc.getMap(`attrs:${id}`)
      : this.content.get(id)?.get("attrs");
    if (!(attrs instanceof Y.Map))
      throw new Error("Missing stable entity attributes");
    this.owners.set(attrs, id);
    return attrs;
  }
  inline(id: string): Y.XmlFragment {
    assertUuidV7(id, "entityId");
    const inline = this.namedContent(id)
      ? this.doc.getXmlFragment(`inline:${id}`)
      : this.content.get(id)?.get("inline");
    if (!(inline instanceof Y.XmlFragment))
      throw new Error("Missing stable entity inline content");
    this.owners.set(inline, id);
    return inline;
  }
  private namedContent(id: string): boolean {
    return (
      this.meta.get("content_layout") !== "entity-map" ||
      this.entities.get(id)?.contentRoot === true
    );
  }
  private initializeContent(id: string): void {
    if (this.namedContent(id)) return;
    const entry = new Y.Map<unknown>();
    entry.set("attrs", new Y.Map());
    entry.set("inline", new Y.XmlFragment());
    this.content.set(id, entry);
  }
  private ownedRoot(
    type: Y.AbstractType<unknown>,
  ): { id: string; root: Y.AbstractType<unknown> } | null {
    let root: Y.AbstractType<unknown> | null = type;
    while (root) {
      const id = this.owners.get(root);
      if (id) return { id, root };
      root = root.parent;
    }
    return null;
  }
  type(id: string): string {
    return String(this.attributes(id).get("type") ?? this.require(id).type);
  }
  visibleSectionAncestor(id: string): string {
    assertUuidV7(id, "focusedSectionId");
    const tree = this.project();
    while (!tree.visible.has(id) || this.type(id) !== "section") {
      if (id === this.noteId) throw new Error("Invalid replicated root");
      id = tree.parents.get(id)?.parentId ?? this.noteId;
    }
    return id;
  }
  require(id: string): EntityDescriptor {
    const entity = this.entities.get(id);
    if (!entity) throw new Error(`Unknown replicated entity: ${id}`);
    return entity;
  }
  transact(action: () => void, origin: unknown = this.localOrigin): void {
    if (this.transactionDepth++) {
      try {
        action();
      } finally {
        this.transactionDepth--;
      }
      return;
    }
    const local =
      this.undoManager.trackedOrigins.has(origin) &&
      origin !== this.undoManager;
    const before = this.undoManager.undoStack.length;
    if (local) {
      this.undoManager.stopCapturing();
      this.inverseActions = [];
      this.creationUndoIds = new Set();
    }
    let scope: UndoFrame["scope"] = [];
    try {
      this.doc.transact((transaction) => {
        action();
        if (origin === this.localOrigin && transaction.changed.size)
          this.meta.set("updated_at", this.clock());
        if (local && this.creationUndoIds?.size) {
          const created = [...this.creationUndoIds];
          this.inverseActions?.push(() => this.recordDeletion(created));
        }
        if (local) {
          const roots = new Set<Y.Map<unknown> | Y.XmlFragment>();
          for (const type of transaction.changed.keys()) {
            const owner = this.ownedRoot(type as Y.AbstractType<unknown>);
            const root = owner?.root,
              id = owner?.id;
            if (
              id &&
              !this.newEntities.has(id) &&
              (root instanceof Y.Map || root instanceof Y.XmlFragment)
            )
              roots.add(root);
          }
          scope = [...roots];
          // Restrict capture to changed roots; a scope of all entities would scan
          // a huge Note on every keystroke. Each undo frame retains its own scope.
          this.undoManager.scope = scope;
        }
      }, origin);
    } finally {
      this.transactionDepth--;
      if (local && !this.replaying) {
        const text = this.undoManager.undoStack.length > before;
        if (text || this.inverseActions?.length) {
          const frame = {
            actions: this.inverseActions ?? [],
            text,
            scope,
          };
          this.undoFrames.push(frame);
          this.redoFrames.length = 0;
          const now = Date.now();
          let group = this.undoGroups.at(-1);
          if (
            !group ||
            now - this.history.lastChange >= this.history.captureTimeout
          ) {
            group = { frames: [], meta: new Map() };
            this.undoGroups.push(group);
          }
          group.frames.push(frame);
          this.history.lastChange = now;
          this.redoGroups.length = 0;
        }
        this.inverseActions = null;
      }
      if (local) this.undoManager.stopCapturing();
      this.creationUndoIds = null;
    }
  }

  /** Session-local undo stores inverse intent, never deletes stable shared entities. */
  undo(): boolean {
    return this.replayGroup(false);
  }
  redo(): boolean {
    return this.replayGroup(true);
  }
  clearUndo(): void {
    this.undoFrames.length = 0;
    this.redoFrames.length = 0;
    this.undoGroups.length = 0;
    this.redoGroups.length = 0;
    this.history.stopCapturing();
    this.undoManager.clear();
  }

  private replayGroup(redo: boolean): boolean {
    const source = redo ? this.redoGroups : this.undoGroups;
    const target = redo ? this.undoGroups : this.redoGroups;
    const group = source.pop();
    if (!group) return false;
    this.history.stopCapturing();
    const frames = redo ? this.redoFrames : this.undoFrames;
    const destination = redo ? this.undoFrames : this.redoFrames;
    const inverse: UndoGroup = { frames: [], meta: group.meta };
    for (let index = group.frames.length - 1; index >= 0; index--) {
      this.replayHistory(frames, destination, redo);
      inverse.frames.push(destination.at(-1)!);
    }
    target.push(inverse);
    return true;
  }

  private replayHistory(
    source: typeof this.undoFrames,
    target: typeof this.undoFrames,
    redo: boolean,
  ): boolean {
    const frame = source.pop();
    if (!frame) return false;
    this.replaying = true;
    try {
      this.transact(() => {
        for (const action of [...frame.actions].reverse()) action();
      });
      const inverse = this.inverseActions ?? [];
      if (frame.text) {
        this.undoManager.scope = frame.scope;
        if (redo) this.undoManager.redo();
        else this.undoManager.undo();
        this.doc.transact(
          () => this.meta.set("updated_at", this.clock()),
          this.localOrigin,
        );
      }
      target.push({ actions: inverse, text: frame.text, scope: frame.scope });
      return true;
    } finally {
      this.replaying = false;
      this.inverseActions = null;
    }
  }
  subscribe(
    listener: (
      ids: ReadonlySet<string>,
      structural: boolean,
      origin: unknown,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changesSectionCatalog(transaction: Y.Transaction): boolean {
    const section = (id: string) => this.entities.get(id)?.type === "section";
    for (const [type, keys] of transaction.changed) {
      if (Object.is(type, this.entities)) {
        if ([...keys].some((key) => key !== null && section(key))) return true;
      } else if (Object.is(type, this.placements)) {
        if (
          [...keys].some(
            (key) =>
              key !== null && section(this.placements.get(key)?.entityId ?? ""),
          )
        )
          return true;
      } else if (
        Object.is(type, this.deletions) ||
        Object.is(type, this.restorations)
      ) {
        const operations = Object.is(type, this.deletions)
          ? this.deletions
          : this.restorations;
        if (
          [...keys].some(
            (key) =>
              key !== null && operations.get(key)?.entityIds.some(section),
          )
        )
          return true;
      } else {
        const id = this.ownedRoot(type as Y.AbstractType<unknown>)?.id;
        if (id && section(id)) return true;
      }
    }
    return false;
  }

  /** The owner may save incoming bytes immediately; applying them waits for all composing views. */
  beginComposition(): () => void {
    this.composing++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (--this.composing !== 0) return;
      const updates = this.pending.splice(0);
      this.pendingBytes = 0;
      if (updates.length) this.applyUpdate(Y.mergeUpdates(updates));
    };
  }

  applyUpdate(update: Uint8Array): "applied" | "deferred" {
    if (
      update.length > MAX_UPDATE_BYTES ||
      this.pendingBytes + update.length > MAX_UPDATE_BYTES
    )
      throw new Error("Replicated update queue limit exceeded");
    // Reject corrupt IDs/schema without touching the live document. The persistent
    // inbox owns rejected bytes; this class intentionally does not silently repair.
    const candidate = ReplicatedNote.load(
      this.noteId,
      this.replicaId,
      this.snapshot(),
      [...this.pending, update],
    );
    candidate.destroy();
    if (this.composing) {
      this.pending.push(update.slice());
      this.pendingBytes += update.length;
      return "deferred";
    }
    Y.applyUpdate(this.doc, update, REPLICATED_REMOTE_ORIGIN);
    return "applied";
  }

  createEntity(
    type: string,
    parentId: string,
    region: string,
    position: string,
    options: {
      id?: string;
      attrs?: Readonly<Record<string, unknown>>;
      inline?: readonly ContentNode[];
      columnId?: string;
    } = {},
  ): string {
    const id = options.id ?? createUuidV7();
    assertUuidV7(id, "entityId");
    if (this.entities.has(id))
      throw new Error(`Duplicate replicated identity: ${id}`);
    if (!BLOCK_TYPES.has(type) && type !== "section")
      throw new Error(`Unknown entity type: ${type}`);
    this.require(parentId);
    const edge = this.newPlacement(id, parentId, region, position);
    if (!this.allowedPlacement(type, this.type(parentId), region))
      throw new Error("Invalid local parent/region");
    const children = options.inline ? inlineXml(options.inline) : [];
    const parentCell = this.entities.get(parentId)?.columnId;
    const contentRoot =
      options.id !== undefined &&
      ((options.columnId !== undefined &&
        id === derivedReplicaId(parentId, `cell:${options.columnId}`)) ||
        (type === "paragraph" &&
          parentCell !== undefined &&
          (id === derivedReplicaId(parentId, "empty-paragraph") ||
            id ===
              derivedReplicaId(
                this.project().parents.get(parentId)!.parentId,
                `paragraph:${parentCell}`,
              ))));
    this.transact(() => {
      this.newEntities.add(id);
      this.entities.set(id, {
        id,
        type,
        ...(options.columnId ? { columnId: options.columnId } : {}),
        ...(contentRoot ? { contentRoot: true as const } : {}),
      });
      this.initializeContent(id);
      for (const [key, value] of Object.entries(options.attrs ?? {}))
        this.attributes(id).set(key, value);
      if (children.length) this.inline(id).insert(0, children);
      this.placements.set(edge.operationId, edge);
      this.projectionCache = null;
      this.creationUndoIds?.add(id);
    });
    return id;
  }

  move(id: string, parentId: string, region: string, position: string): void {
    this.moveMany([{ entityId: id, parentId, region, position }]);
  }

  /** Validate the final hierarchy before applying a multi-node editor transaction. */
  moveMany(
    changes: readonly Pick<
      Placement,
      "entityId" | "parentId" | "region" | "position"
    >[],
    visibleBeforeTypeChange?: ReadonlySet<string>,
  ): void {
    if (!changes.length) return;
    if (
      new Set(changes.map((change) => change.entityId)).size !== changes.length
    )
      throw new Error("Duplicate move target");
    const before = this.project();
    const operations = changes.map((change) => {
      if (
        change.entityId === this.noteId ||
        (!before.visible.has(change.entityId) &&
          !visibleBeforeTypeChange?.has(change.entityId)) ||
        (!before.visible.has(change.parentId) &&
          !visibleBeforeTypeChange?.has(change.parentId))
      )
        throw new Error("Cannot move root or protected content");
      if (
        !this.allowedPlacement(
          this.type(change.entityId),
          this.type(change.parentId),
          change.region,
        )
      )
        throw new Error("Invalid local parent/region");
      return this.newPlacement(
        change.entityId,
        change.parentId,
        change.region,
        change.position,
      );
    });
    const moving = new Set(changes.map((change) => change.entityId));
    const stabilized = new Map<string, Placement>();
    // Only explicit moves pin corrected paths. Projection itself never writes.
    for (const change of changes)
      for (const start of [
        before.parents.get(change.entityId)?.parentId,
        change.parentId,
      ]) {
        let cursor = start;
        while (cursor && cursor !== this.noteId) {
          const prior = before.parents.get(cursor)!;
          if (
            !moving.has(cursor) &&
            before.reverted.has(cursor) &&
            !stabilized.has(cursor)
          )
            stabilized.set(
              cursor,
              this.newPlacement(
                cursor,
                prior.parentId,
                prior.region,
                prior.position,
              ),
            );
          cursor = prior.parentId;
        }
      }
    const final = deriveReplicatedTree(
      this.noteId,
      new Set(this.entities.keys()),
      [...this.placements.values(), ...stabilized.values(), ...operations],
    );
    for (const operation of operations)
      if (
        final.parents.get(operation.entityId)?.operationId !==
        operation.operationId
      )
        throw new Error("Move would create a cycle");
    const changed = new Set(
      changes
        .filter((change) => this.type(change.entityId) === "section")
        .map((change) => change.entityId),
    );
    const pending = [{ id: this.noteId, depth: 0, touched: false }];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.touched && item.depth > MAX_SECTION_DEPTH)
        throw new Error("Section depth exceeds H6");
      for (const child of final.children.get(item.id) ?? [])
        if (this.type(child) === "section")
          pending.push({
            id: child,
            depth: item.depth + 1,
            touched: item.touched || changed.has(child),
          });
    }
    this.transact(() => {
      for (const edge of stabilized.values())
        this.placements.set(edge.operationId, edge);
      for (const operation of operations) {
        this.placements.set(operation.operationId, operation);
        this.inverseActions?.push(() =>
          this.restorePlacement(before.parents.get(operation.entityId)!),
        );
      }
      this.projectionCache = null;
    });
  }

  delete(id: string): Deletion {
    return this.deleteMany([id]);
  }

  /** One observed delete for a whole Editor selection, with one tree traversal. */
  deleteMany(ids: readonly string[]): Deletion {
    for (const id of ids) {
      this.require(id);
      if (id === this.noteId)
        throw new Error("Delete the Note through Workspace Trash");
    }
    if (!ids.length) throw new Error("Deletion needs an entity");
    const projection = this.project();
    const entityIds = new Set<string>(),
      visited = new Set<string>(),
      roots = new Set(ids);
    const pending = [...ids];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      // A second explicit delete is still an independent, remove-wins operation.
      if (roots.has(current) || projection.visible.has(current))
        entityIds.add(current);
      for (const child of projection.children.get(current) ?? [])
        pending.push(child);
    }
    return this.recordDeletion([...entityIds]);
  }

  private recordDeletion(entityIds: readonly string[]): Deletion {
    const deletion = {
      operationId: createUuidV7(),
      replicaId: this.replicaId,
      entityIds: [...entityIds].sort(),
    };
    this.transact(() => {
      this.deletions.set(deletion.operationId, deletion);
      this.projectionCache = null;
      this.inverseActions?.push(() => this.restore(deletion.operationId));
    });
    return deletion;
  }

  restore(deletionId: string, entityIds?: readonly string[]): void {
    const deletion = this.deletions.get(deletionId);
    if (!deletion) throw new Error("Cannot restore an unobserved deletion");
    const ids = entityIds ?? deletion.entityIds;
    const observed = new Set(deletion.entityIds);
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !observed.has(id))
    )
      throw new Error("Invalid restoration selection");
    const operationId = createUuidV7();
    this.transact(() => {
      this.restorations.set(operationId, {
        operationId,
        replicaId: this.replicaId,
        deletionId,
        entityIds: [...ids].sort(),
      });
      this.projectionCache = null;
      this.inverseActions?.push(() => {
        const operationId = createUuidV7();
        this.deletions.set(operationId, {
          operationId,
          replicaId: this.replicaId,
          entityIds: [...ids],
        });
        this.projectionCache = null;
        this.inverseActions?.push(() => this.restore(operationId));
      });
    });
  }

  activeDeletions(id: string): string[] {
    const cancelled = new Set<string>();
    for (const restoration of this.restorations.values())
      if (restoration.entityIds.includes(id))
        cancelled.add(restoration.deletionId);
    return [...this.deletions.values()]
      .filter(
        (deletion) =>
          deletion.entityIds.includes(id) &&
          !cancelled.has(deletion.operationId),
      )
      .map((deletion) => deletion.operationId)
      .sort();
  }

  copy(id: string, parentId: string, region: string, position: string): string {
    const source = this.project();
    if (!source.visible.has(id))
      throw new Error("Cannot copy protected content");
    const ids = new Map<string, string>();
    const pending = [id];
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!;
      ids.set(current, createUuidV7());
      for (const child of source.children.get(current) ?? [])
        if (source.visible.has(child)) pending.push(child);
    }
    this.transact(() => {
      for (const current of pending) {
        const descriptor = this.require(current);
        const edge = source.parents.get(current);
        this.createEntity(
          this.type(current),
          current === id ? parentId : ids.get(edge!.parentId)!,
          current === id ? region : edge!.region,
          current === id ? position : edge!.position,
          {
            id: ids.get(current)!,
            attrs: this.attributes(current).toJSON(),
            inline: this.inlineContent(current),
            ...(descriptor.columnId
              ? {
                  columnId: ids.get(descriptor.columnId) ?? descriptor.columnId,
                }
              : {}),
          },
        );
      }
    });
    return ids.get(id)!;
  }

  inlineContent(id: string): ContentNode[] {
    return (
      (yXmlFragmentToProsemirrorJSON(this.inline(id)).content ?? []) as (
        ContentNode | ContentNode[]
      )[]
    ).flat();
  }

  project(): ReplicatedNoteProjection {
    if (this.projectionCache) return this.projectionCache;
    const tree = deriveReplicatedTree(
      this.noteId,
      new Set(this.entities.keys()),
      this.placements.values(),
    );
    const parents = new Map(tree.parents);
    const children = new Map<string, string[]>();
    const visible = new Set([this.noteId]);
    const recovery: ProtectedContent[] = [];
    const depthCorrections: string[] = [];
    const depths = new Map([[this.noteId, 0]]);
    const deleted = new Map<string, string[]>();
    const cancelled = new Map<string, Set<string>>();
    for (const restoration of this.restorations.values()) {
      const ids = cancelled.get(restoration.deletionId) ?? new Set<string>();
      for (const id of restoration.entityIds) ids.add(id);
      cancelled.set(restoration.deletionId, ids);
    }
    for (const deletion of this.deletions.values())
      for (const id of deletion.entityIds) {
        if (cancelled.get(deletion.operationId)?.has(id)) continue;
        const operations = deleted.get(id) ?? [];
        operations.push(deletion.operationId);
        deleted.set(id, operations);
      }
    const pending = [...(tree.children.get(this.noteId) ?? [])].reverse();
    while (pending.length) {
      const id = pending.pop()!;
      const edge = tree.parents.get(id)!;
      const type = this.type(id);
      const ownDeletes = deleted.get(id) ?? [];
      const parentVisible = visible.has(edge.parentId);
      const columnId = this.require(id).columnId;
      const coordinateVisible = !columnId || visible.has(columnId);
      const allowed = this.allowedPlacement(
        type,
        this.type(edge.parentId),
        edge.region,
      );
      if (
        ownDeletes.length ||
        !parentVisible ||
        !coordinateVisible ||
        !allowed
      ) {
        recovery.push({
          entityId: id,
          reason: ownDeletes.length
            ? "deleted"
            : !parentVisible || !coordinateVisible
              ? "deleted-parent"
              : "incompatible-type",
          deletionIds: ownDeletes.sort(),
        });
      } else {
        visible.add(id);
        let parent = edge.parentId;
        let depth = depths.get(parent) ?? 0;
        if (type === "section") {
          while (depth >= MAX_SECTION_DEPTH) {
            parent = parents.get(parent)!.parentId;
            depth = depths.get(parent)!;
          }
          if (parent !== edge.parentId) {
            parents.set(id, { ...edge, parentId: parent });
            depthCorrections.push(id);
          }
          depth++;
        }
        depths.set(id, depth);
        const siblings = children.get(parent) ?? [];
        siblings.push(id);
        children.set(parent, siblings);
        if (!TEXT_TYPES.has(type) && this.inline(id).length)
          recovery.push({
            entityId: id,
            reason: "incompatible-type",
            deletionIds: [],
          });
      }
      const descendants = tree.children.get(id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--)
        pending.push(descendants[index]!);
    }
    for (const siblings of children.values())
      siblings.sort((a, b) => {
        const left = parents.get(a)!,
          right = parents.get(b)!;
        return (
          compareStrings(left.region, right.region) ||
          compareStrings(left.position, right.position) ||
          compareStrings(a, b)
        );
      });
    this.projectionCache = {
      parents,
      children,
      visible,
      recovery: recovery.sort((a, b) => compareStrings(a.entityId, b.entityId)),
      reverted: tree.reverted,
      depthCorrections: depthCorrections.sort(),
    };
    return this.projectionCache;
  }

  sectionSnapshot(id = this.noteId): SectionSnapshot {
    if (this.type(id) !== "section") throw new Error("Expected a Section");
    const tree = this.project();
    const attrs = this.attributes(id);
    const children = tree.children.get(id) ?? [];
    return {
      sectionId: id,
      title: this.inlineContent(id)
        .map((node) => node.text ?? "")
        .join(""),
      ...(typeof attrs.get("emoji") === "string"
        ? { emoji: attrs.get("emoji") as string }
        : {}),
      tags: (attrs.get("tags") ?? []) as string[],
      body: children
        .filter((child) => tree.parents.get(child)!.region === "body")
        .map((child) => this.blockSnapshot(child)),
      children: children
        .filter((child) => this.type(child) === "section")
        .map((child) => this.sectionSnapshot(child)),
    };
  }

  blockSnapshot(id: string): ContentNode {
    const type = this.type(id);
    const attrs = { ...this.attributes(id).toJSON(), blockId: id };
    delete (attrs as Record<string, unknown>).type;
    const tree = this.project();
    const children = tree.children.get(id) ?? [];
    if (type === "table") {
      const columns = children.filter(
        (child) => this.type(child) === "tableColumn",
      );
      return {
        type,
        attrs,
        content: children
          .filter((child) => this.type(child) === "tableRow")
          .map((row) => {
            const cells = tree.children.get(row) ?? [];
            return {
              type: "tableRow",
              attrs: { ...this.attributes(row).toJSON(), blockId: row },
              content: columns.map((column) => {
                const matches = cells.filter(
                  (cell) => this.require(cell).columnId === column,
                );
                if (matches.length > 1)
                  throw new Error("Duplicate stable table cell");
                if (matches.length) return this.blockSnapshot(matches[0]!);
                return {
                  type: "tableCell",
                  attrs: { blockId: derivedReplicaId(row, `cell:${column}`) },
                  content: [
                    {
                      type: "paragraph",
                      attrs: {
                        blockId: derivedReplicaId(row, `paragraph:${column}`),
                      },
                    },
                  ],
                };
              }),
            };
          }),
      };
    }
    if (TEXT_TYPES.has(type))
      return { type, attrs, content: this.inlineContent(id) };
    if (ATOM_TYPES.has(type)) return { type, attrs };
    if ((type === "tableCell" || type === "tableHeader") && !children.length)
      return {
        type,
        attrs,
        content: [
          {
            type: "paragraph",
            attrs: { blockId: derivedReplicaId(id, "empty-paragraph") },
          },
        ],
      };
    return {
      type,
      attrs,
      content: children
        .filter((child) => this.type(child) !== "tableColumn")
        .map((child) => this.blockSnapshot(child)),
    };
  }

  /** A concurrent row and column insertion can leave an initially empty intersection. */
  ensureCell(rowId: string, columnId: string): string {
    const tree = this.project();
    const row = tree.parents.get(rowId),
      column = tree.parents.get(columnId);
    if (
      !row ||
      !column ||
      this.type(rowId) !== "tableRow" ||
      this.type(columnId) !== "tableColumn" ||
      row.parentId !== column.parentId
    )
      throw new Error("Invalid table coordinates");
    const existing = (tree.children.get(rowId) ?? []).find(
      (id) => this.require(id).columnId === columnId,
    );
    if (existing) return existing;
    const id = derivedReplicaId(rowId, `cell:${columnId}`);
    this.createEntity("tableCell", rowId, "cells", column.position, {
      id,
      columnId,
    });
    return id;
  }

  validate(): void {
    if (this.doc.store.pendingStructs || this.doc.store.pendingDs)
      throw new Error("Replicated update dependencies are missing");
    if (
      this.meta.get("note_id") !== this.noteId ||
      this.meta.get("schema_version") !== REPLICATED_NOTE_SCHEMA_VERSION
    )
      throw new Error("Unsupported replicated Note identity or schema");
    if (
      this.meta.has("content_layout") &&
      this.meta.get("content_layout") !== "entity-map"
    )
      throw new Error("Unsupported replicated content layout");
    if (
      this.entities.size > MAX_ENTITIES ||
      this.placements.size + this.deletions.size + this.restorations.size >
        MAX_OPERATIONS
    )
      throw new Error("Replicated Note size limit exceeded");
    for (const [id, entity] of this.entities) {
      assertUuidV7(id, "entityId");
      if (
        !record(entity) ||
        entity.id !== id ||
        (entity.type !== "section" && !BLOCK_TYPES.has(entity.type))
      )
        throw new Error("Invalid replicated entity");
      if (entity.contentRoot !== undefined && entity.contentRoot !== true)
        throw new Error("Invalid shared content addressing");
      if (!BLOCK_TYPES.has(this.type(id)) && this.type(id) !== "section")
        throw new Error("Unknown replicated entity type");
      if (entity.columnId) {
        assertUuidV7(entity.columnId, "columnId");
        if (this.require(entity.columnId).type !== "tableColumn")
          throw new Error("Cell has no column");
      }
      // Decode every inline value even when hidden, rather than discarding malformed data.
      const inline = this.inlineContent(id);
      for (const node of inline) validateInline(node);
      if (
        this.type(id) === "section" &&
        inline.some(
          (node) => node.type !== "text" || /[\r\n]/u.test(node.text ?? ""),
        )
      )
        throw new Error("Section title must be single-line text");
      const tags = this.attributes(id).get("tags");
      if (
        tags !== undefined &&
        (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
      )
        throw new Error("Invalid Section tags");
    }
    if (
      this.entities.get(this.noteId)?.type !== "section" ||
      this.type(this.noteId) !== "section"
    )
      throw new Error("Invalid replicated root");
    for (const [id, edge] of this.placements)
      if (!record(edge) || edge.operationId !== id)
        throw new Error("Invalid placement operation");
    for (const [id, deletion] of this.deletions)
      this.validateDeletion(id, deletion);
    for (const [id, restoration] of this.restorations) {
      this.validateDeletion(id, restoration);
      const deletion = this.deletions.get(restoration.deletionId);
      const observed = new Set(deletion?.entityIds);
      if (
        !deletion ||
        restoration.entityIds.some((entityId) => !observed.has(entityId))
      )
        throw new Error("Restoration references an unobserved deletion");
    }
    const projection = this.project();
    const cells = new Set<string>();
    const descendants = new Map<string, string[]>();
    for (const [id, edge] of projection.parents) {
      const children = descendants.get(edge.parentId) ?? [];
      children.push(id);
      descendants.set(edge.parentId, children);
    }
    const pending = [{ id: this.noteId, depth: 0 }];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.depth > 128)
        throw new Error("Replicated structure depth limit exceeded");
      for (const child of descendants.get(current.id) ?? [])
        pending.push({ id: child, depth: current.depth + 1 });
    }
    for (const [id, entity] of this.entities) {
      if (entity.type !== "tableCell" && entity.type !== "tableHeader")
        continue;
      if (!entity.columnId) throw new Error("Cell has no column identity");
      const row = projection.parents.get(id)?.parentId;
      const table = row ? projection.parents.get(row)?.parentId : undefined;
      if (!table || table !== projection.parents.get(entity.columnId)?.parentId)
        throw new Error("Cell coordinates belong to different tables");
      const coordinate = JSON.stringify([row, entity.columnId]);
      if (cells.has(coordinate)) throw new Error("Duplicate stable table cell");
      cells.add(coordinate);
    }
    for (const name of this.doc.share.keys()) {
      if (
        [
          "meta",
          "entities",
          "placements",
          "deletions",
          "restorations",
          "content",
        ].includes(name)
      )
        continue;
      const match = /^(?:attrs|inline):(.+)$/u.exec(name);
      if (
        !match ||
        !this.entities.has(match[1]!) ||
        !this.namedContent(match[1]!)
      )
        throw new Error("Unknown replicated shared type");
    }
    for (const [id, value] of this.content) {
      if (
        !this.entities.has(id) ||
        this.namedContent(id) ||
        !(value instanceof Y.Map) ||
        [...value.keys()].some((key) => key !== "attrs" && key !== "inline")
      )
        throw new Error("Invalid stable content registry entry");
    }
  }

  private validateDeletion(id: string, value: Deletion): void {
    assertUuidV7(id, "operationId");
    if (!record(value) || value.operationId !== id)
      throw new Error("Invalid deletion operation");
    assertUuidV7(value.replicaId, "replicaId");
    if (
      !Array.isArray(value.entityIds) ||
      !value.entityIds.length ||
      new Set(value.entityIds).size !== value.entityIds.length
    )
      throw new Error("Invalid deletion targets");
    for (const entityId of value.entityIds) {
      this.require(entityId);
      if (entityId === this.noteId)
        throw new Error("Cannot delete the replicated root");
    }
  }

  private newPlacement(
    entityId: string,
    parentId: string,
    region: string,
    position: string,
  ): Placement {
    const edge = {
      operationId: createUuidV7(),
      replicaId: this.replicaId,
      counter: this.logicalCounter + 1,
      entityId,
      parentId,
      region,
      position,
    };
    // Use the shared validator before any mutation, including counter overflow.
    validatePlacement(edge);
    this.logicalCounter = edge.counter;
    return edge;
  }

  private restorePlacement(previous: Placement): void {
    const current = this.project().parents.get(previous.entityId)!;
    const edge = this.newPlacement(
      previous.entityId,
      previous.parentId,
      previous.region,
      previous.position,
    );
    this.placements.set(edge.operationId, edge);
    this.projectionCache = null;
    this.inverseActions?.push(() => this.restorePlacement(current));
  }

  allowedPlacement(type: string, parent: string, region: string): boolean {
    if (type === "section")
      return parent === "section" && region === "sections";
    if (parent === "section")
      return (
        region === "body" &&
        ![
          "tableRow",
          "tableColumn",
          "tableCell",
          "tableHeader",
          "listItem",
          "detailsSummary",
          "detailsBody",
        ].includes(type)
      );
    if (parent === "table")
      return (
        (type === "tableRow" && region === "rows") ||
        (type === "tableColumn" && region === "columns")
      );
    if (parent === "tableRow")
      return (
        (type === "tableCell" || type === "tableHeader") && region === "cells"
      );
    if (parent === "bulletList" || parent === "orderedList")
      return type === "listItem" && region === "content";
    if (parent === "details")
      return (
        (type === "detailsSummary" || type === "detailsBody") &&
        region === "content"
      );
    return (
      CONTAINER_TYPES.has(parent) &&
      region === "content" &&
      ![
        "tableRow",
        "tableColumn",
        "tableCell",
        "tableHeader",
        "listItem",
        "detailsSummary",
        "detailsBody",
      ].includes(type)
    );
  }

  private readonly observe = (transaction: Y.Transaction): void => {
    const ids = new Set<string>();
    let structural = false;
    for (const [type, keys] of transaction.changed) {
      if (Object.is(type, this.placements))
        for (const key of keys) {
          const edge = key === null ? undefined : this.placements.get(key);
          if (edge)
            this.logicalCounter = Math.max(this.logicalCounter, edge.counter);
        }
      if (
        [
          this.entities,
          this.placements,
          this.deletions,
          this.restorations,
        ].some((value) => Object.is(type, value))
      ) {
        structural = true;
        continue;
      }
      const owner = this.ownedRoot(type as Y.AbstractType<unknown>);
      const id = owner?.id,
        root = owner?.root;
      if (id) {
        ids.add(id);
        if (root instanceof Y.Map && keys.has("type")) structural = true;
      }
    }
    if (structural) this.projectionCache = null;
    else if (
      [...ids].some(
        (id) => this.entities.has(id) && !TEXT_TYPES.has(this.type(id)),
      )
    )
      this.projectionCache = null;
    this.newEntities.clear();
    if (structural || ids.size)
      for (const listener of this.listeners)
        listener(ids, structural, transaction.origin);
  };
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
function validateInline(node: ContentNode): void {
  if (
    !record(node) ||
    (node.type !== "text" &&
      node.type !== "hardBreak" &&
      node.type !== "internalSectionLink")
  )
    throw new Error("Invalid replicated inline content");
  if (node.type === "text" && typeof node.text !== "string")
    throw new Error("Invalid replicated text");
  if (node.content?.length) {
    if (
      node.type !== "internalSectionLink" ||
      node.content.some((child) => child.type !== "text")
    )
      throw new Error("Only internal links can contain a text label");
    for (const child of node.content) validateInline(child);
  }
  if (
    node.marks &&
    (!Array.isArray(node.marks) ||
      node.marks.some(
        (mark) =>
          !["bold", "italic", "strike", "code", "link", "highlight"].includes(
            mark.type,
          ),
      ))
  )
    throw new Error("Unknown replicated inline mark");
  if (node.type === "internalSectionLink")
    requiredId(node.attrs?.targetSectionId, "targetSectionId");
}

/** One-way conversion on the source replica. Never independently migrate two copies and merge them. */
export function replicateSectionSnapshot(
  snapshot: SectionSnapshot,
  replicaId: string,
): ReplicatedNote {
  validateSectionSnapshotDepth(snapshot);
  const note = ReplicatedNote.create(
    snapshot.sectionId,
    replicaId,
    snapshot.title,
  );
  const insertBlocks = (
    nodes: readonly ContentNode[],
    parentId: string,
    region: string,
  ) => {
    const positions = siblingPositionsBetween(
      null,
      null,
      nodes.length,
      parentId,
    );
    for (const [index, node] of nodes.entries()) {
      const id = requiredId(node.attrs?.blockId, "blockId");
      const attrs = { ...node.attrs };
      delete attrs.blockId;
      note.createEntity(node.type, parentId, region, positions[index]!, {
        id,
        attrs,
        ...(TEXT_TYPES.has(node.type) ? { inline: node.content ?? [] } : {}),
      });
      if (node.type === "table") {
        const rows = node.content ?? [];
        const count = rows[0]?.content?.length ?? 0;
        if (
          rows.some(
            (row) => row.type !== "tableRow" || row.content?.length !== count,
          )
        )
          throw new Error("Cannot migrate a nonrectangular Table");
        const columnPositions = siblingPositionsBetween(null, null, count, id);
        const columns = columnPositions.map((position) =>
          note.createEntity("tableColumn", id, "columns", position),
        );
        const rowPositions = siblingPositionsBetween(
          null,
          null,
          rows.length,
          `${id}:rows`,
        );
        for (const [rowIndex, row] of rows.entries()) {
          const rowId = requiredId(row.attrs?.blockId, "rowId");
          note.createEntity("tableRow", id, "rows", rowPositions[rowIndex]!, {
            id: rowId,
            attrs: withoutIdentity(row.attrs),
          });
          for (const [columnIndex, cell] of (row.content ?? []).entries()) {
            const cellId = requiredId(cell.attrs?.blockId, "cellId");
            note.createEntity(
              cell.type,
              rowId,
              "cells",
              columnPositions[columnIndex]!,
              {
                id: cellId,
                columnId: columns[columnIndex]!,
                attrs: withoutIdentity(cell.attrs),
              },
            );
            insertBlocks(cell.content ?? [], cellId, "content");
          }
        }
      } else if (!TEXT_TYPES.has(node.type) && !ATOM_TYPES.has(node.type))
        insertBlocks(node.content ?? [], id, "content");
    }
  };
  const insertSection = (section: SectionSnapshot) => {
    const attrs = note.attributes(section.sectionId);
    attrs.set("tags", [...section.tags]);
    if (section.emoji !== undefined) attrs.set("emoji", section.emoji);
    insertBlocks(section.body as ContentNode[], section.sectionId, "body");
    const positions = siblingPositionsBetween(
      null,
      null,
      section.children.length,
      section.sectionId,
    );
    for (const [index, child] of section.children.entries()) {
      note.createEntity(
        "section",
        section.sectionId,
        "sections",
        positions[index]!,
        {
          id: child.sectionId,
          inline: child.title ? [{ type: "text", text: child.title }] : [],
        },
      );
      insertSection(child);
    }
  };
  try {
    note.transact(() => insertSection(snapshot), REPLICATED_BOOTSTRAP_ORIGIN);
    note.validate();
    note.clearUndo();
    return note;
  } catch (error) {
    note.destroy();
    throw error;
  }
}

function withoutIdentity(attrs: ContentNode["attrs"]): Record<string, unknown> {
  const result = { ...attrs };
  delete result.blockId;
  return result;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Missing ${field}`);
  assertUuidV7(value, field);
  return value;
}
