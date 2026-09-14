import * as Y from "yjs";
import { assertUuidV7, createUuidV7 } from "./ids";
import {
  readMainNamespace,
  readNamespaceEntry,
  type NamespaceEntry,
} from "./namespace";
import {
  deriveReplicatedTree,
  validatePlacement,
  type Placement,
  type TreeProjection,
} from "./replicated-tree";

export const REPLICATED_WORKSPACE_SCHEMA_VERSION = 4;
const MAX_OPERATIONS = 1_000_000;
const PLACEMENT_FIELDS = [
  "parent_entry_id",
  "position",
  "deleted_at",
  "trash_operation_id",
];

interface TrashDeletion {
  readonly operationId: string;
  readonly replicaId: string;
  readonly counter: number;
  readonly entityIds: readonly string[];
  readonly at: string;
}
interface TrashRestoration {
  readonly operationId: string;
  readonly replicaId: string;
  readonly deletionId: string;
  readonly entityIds: readonly string[];
}
export interface NamespaceProjection {
  readonly entries: readonly NamespaceEntry[];
  readonly tree: TreeProjection;
  readonly activeDeletions: ReadonlyMap<string, readonly TrashDeletion[]>;
}

function map<T>(namespace: Y.Map<unknown>, key: string): Y.Map<T> {
  const value = namespace.get(key);
  if (!(value instanceof Y.Map)) throw new Error(`Namespace ${key} is missing`);
  if (value.size > MAX_OPERATIONS)
    throw new Error("Namespace operation limit exceeded");
  return value as Y.Map<T>;
}

function validateKeys(value: object, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid Namespace operation fields");
}

/** Entries own attributes for their lifetime. Histories own placement and Trash. */
export class ReplicatedNamespace {
  readonly namespaceId: string;
  readonly entries: Y.Map<Y.Map<unknown>>;
  readonly placements: Y.Map<Placement>;
  readonly deletions: Y.Map<TrashDeletion>;
  readonly restorations: Y.Map<TrashRestoration>;
  private projection?: NamespaceProjection;
  private counter = 0;

  constructor(
    readonly root: Y.Map<unknown>,
    readonly replicaId: string,
  ) {
    assertUuidV7(replicaId, "replicaId");
    if (root.get("schema_version") !== REPLICATED_WORKSPACE_SCHEMA_VERSION)
      throw new Error("Unsupported replicated Workspace schema");
    const namespace = root.get("main_namespace") as Y.Map<unknown>;
    ({ namespaceId: this.namespaceId, entries: this.entries } =
      readMainNamespace(root));
    this.placements = map(namespace, "placements");
    this.deletions = map(namespace, "deletions");
    this.restorations = map(namespace, "restorations");
    namespace.observeDeep(() => {
      this.projection = undefined;
    });
  }

  project(): NamespaceProjection {
    if (this.projection) return this.projection;
    if (this.entries.size > 1_000_000)
      throw new Error("Namespace traversal limit exceeded");
    for (const operations of [
      this.placements,
      this.deletions,
      this.restorations,
    ])
      if (operations.size > MAX_OPERATIONS)
        throw new Error("Namespace operation limit exceeded");
    const ids = new Set([this.namespaceId, ...this.entries.keys()]);
    if (ids.size !== this.entries.size + 1)
      throw new Error("Entry ID reuses Namespace ID");
    for (const id of ids) assertUuidV7(id, "entryId");
    for (const [id, edge] of this.placements) {
      validateKeys(edge, [
        "operationId",
        "replicaId",
        "counter",
        "entityId",
        "parentId",
        "region",
        "position",
      ]);
      validatePlacement(edge);
      if (edge.operationId !== id || edge.region !== "entries")
        throw new Error("Invalid Namespace placement");
      this.counter = Math.max(this.counter, edge.counter);
    }
    const tree = deriveReplicatedTree(
      this.namespaceId,
      ids,
      this.placements.values(),
    );
    const restored = new Map<string, Set<string>>();
    for (const [id, deletion] of this.deletions) {
      validateKeys(deletion, [
        "operationId",
        "replicaId",
        "counter",
        "entityIds",
        "at",
      ]);
      this.validateOperation(id, deletion, ids);
      if (
        !Number.isSafeInteger(deletion.counter) ||
        deletion.counter < 1 ||
        typeof deletion.at !== "string" ||
        !Number.isFinite(Date.parse(deletion.at))
      )
        throw new Error("Invalid Namespace deletion");
      this.counter = Math.max(this.counter, deletion.counter);
      restored.set(id, new Set());
    }
    for (const [id, restoration] of this.restorations) {
      validateKeys(restoration, [
        "operationId",
        "replicaId",
        "deletionId",
        "entityIds",
      ]);
      this.validateOperation(id, restoration, ids);
      const deletion = this.deletions.get(restoration.deletionId);
      if (!deletion)
        throw new Error("Namespace restoration has an unknown deletion");
      const observed = new Set(deletion.entityIds);
      for (const entityId of restoration.entityIds) {
        if (!observed.has(entityId))
          throw new Error(
            "Namespace restoration exceeds its observed deletion",
          );
        restored.get(restoration.deletionId)!.add(entityId);
      }
    }
    const activeDeletions = new Map<string, TrashDeletion[]>();
    for (const deletion of this.deletions.values()) {
      for (const id of deletion.entityIds) {
        if (restored.get(deletion.operationId)!.has(id)) continue;
        const active = activeDeletions.get(id) ?? [];
        active.push(deletion);
        activeDeletions.set(id, active);
      }
    }
    const effective = new Map<string, TrashDeletion>();
    const pending = [this.namespaceId];
    const entries: NamespaceEntry[] = [];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const id of tree.children.get(parent) ?? []) {
        let deleted: TrashDeletion | undefined;
        for (const stamp of activeDeletions.get(id) ?? [])
          if (!deleted || compareDeletion(deleted, stamp) < 0) deleted = stamp;
        deleted ??= effective.get(parent);
        if (deleted) effective.set(id, deleted);
        const value = this.entries.get(id)!;
        if (
          !(value instanceof Y.Map) ||
          PLACEMENT_FIELDS.some((key) => value.has(key))
        )
          throw new Error(
            "Replicated Entry must keep placement and Trash in histories",
          );
        const edge = tree.parents.get(id)!;
        entries.push(
          readNamespaceEntry(id, value, {
            parentEntryId: parent === this.namespaceId ? null : parent,
            position: edge.position,
            deletedAt: deleted?.at,
            trashOperationId: deleted?.operationId,
          }),
        );
        pending.push(id);
      }
    }
    entries.sort(
      (a, b) =>
        compareString(a.position, b.position) ||
        compareString(a.entryId, b.entryId),
    );
    return (this.projection = { entries, tree, activeDeletions });
  }

  /** Called within the Workspace owner's transaction, never by the network. */
  writeEntries(
    planned: readonly NamespaceEntry[],
    affectedIds: ReadonlySet<string>,
  ): void {
    const before = this.project();
    const current = new Map(
      before.entries.map((entry) => [entry.entryId, entry]),
    );
    const changed = planned.filter((entry) => affectedIds.has(entry.entryId));
    const moves = new Map<string, { parentId: string; position: string }>();
    const deletes = new Map<string, { at: string; ids: string[] }>();
    const restoreIds = new Set<string>();
    for (const entry of changed) {
      const old = current.get(entry.entryId);
      if (old && JSON.stringify(old.target) !== JSON.stringify(entry.target))
        throw new Error("Namespace resource identity is immutable");
      if (
        !old ||
        old.parentEntryId !== entry.parentEntryId ||
        old.position !== entry.position
      )
        moves.set(entry.entryId, {
          parentId: entry.parentEntryId ?? this.namespaceId,
          position: entry.position,
        });
      if (
        entry.deletedAt &&
        entry.trashOperationId &&
        (!old?.deletedAt || old.trashOperationId !== entry.trashOperationId)
      ) {
        const deletion = deletes.get(entry.trashOperationId) ?? {
          at: entry.deletedAt,
          ids: [],
        };
        deletion.ids.push(entry.entryId);
        deletes.set(entry.trashOperationId, deletion);
      } else if (old?.deletedAt && !entry.deletedAt) {
        // Restoring a Trash operation cancels only observed stamps. A different
        // concurrent deletion remains active, including on a hidden descendant.
        restoreIds.add(old.trashOperationId!);
      }
    }
    // Pin corrected ancestor edges only as part of an explicit move. Receiving
    // a cycle itself never writes correction operations back into the document.
    for (const move of [...moves.values()]) {
      let id = move.parentId;
      const seen = new Set<string>();
      while (id !== this.namespaceId && !seen.has(id)) {
        seen.add(id);
        const edge = before.tree.parents.get(id);
        if (!edge) break;
        if (before.tree.reverted.has(id) && !moves.has(id))
          moves.set(id, { parentId: edge.parentId, position: edge.position });
        id = moves.get(id)?.parentId ?? edge.parentId;
      }
    }
    const plannedEdges = [...this.placements.values()];
    for (const [id, move] of moves)
      plannedEdges.push({
        operationId: createUuidV7(),
        replicaId: this.replicaId,
        counter: this.nextCounter(),
        entityId: id,
        region: "entries",
        ...move,
      });
    const allIds = new Set([
      this.namespaceId,
      ...current.keys(),
      ...changed.map((entry) => entry.entryId),
    ]);
    const proposed = deriveReplicatedTree(
      this.namespaceId,
      allIds,
      plannedEdges,
    );
    for (const [id, move] of moves) {
      const edge = proposed.parents.get(id)!;
      if (edge.parentId !== move.parentId || edge.position !== move.position)
        throw new Error("Namespace move would create a cycle");
    }
    for (const id of deletes.keys()) {
      assertUuidV7(id, "trashOperationId");
      if (this.deletions.has(id))
        throw new Error("Namespace deletion identity is already used");
    }
    this.root.doc!.transact(() => {
      for (const entry of changed) {
        let value = this.entries.get(entry.entryId);
        if (!value) {
          value = new Y.Map<unknown>();
          this.entries.set(entry.entryId, value);
          value.set("target", entry.target);
          value.set("created_at", entry.createdAt);
        }
        if (!entry.target && value.get("name") !== entry.name)
          value.set("name", entry.name);
        if (value.get("updated_at") !== entry.updatedAt)
          value.set("updated_at", entry.updatedAt);
      }
      for (const edge of plannedEdges)
        if (!this.placements.has(edge.operationId))
          this.placements.set(edge.operationId, edge);
      for (const [operationId, deletion] of deletes)
        this.deletions.set(operationId, {
          operationId,
          replicaId: this.replicaId,
          counter: this.nextCounter(),
          entityIds: deletion.ids,
          at: deletion.at,
        });
      for (const deletionId of restoreIds) {
        const deletion = this.deletions.get(deletionId)!;
        const operationId = createUuidV7();
        this.restorations.set(operationId, {
          operationId,
          replicaId: this.replicaId,
          deletionId,
          entityIds: deletion.entityIds,
        });
      }
    });
    this.projection = undefined;
  }

  private nextCounter(): number {
    if (this.counter >= Number.MAX_SAFE_INTEGER)
      throw new Error("Namespace logical counter exhausted");
    return ++this.counter;
  }
  private validateOperation(
    id: string,
    value: Pick<TrashDeletion, "operationId" | "replicaId" | "entityIds">,
    ids: ReadonlySet<string>,
  ): void {
    assertUuidV7(id, "operationId");
    assertUuidV7(value.replicaId, "replicaId");
    if (
      value.operationId !== id ||
      !Array.isArray(value.entityIds) ||
      value.entityIds.length === 0 ||
      new Set(value.entityIds).size !== value.entityIds.length ||
      value.entityIds.some(
        (entityId) => entityId === this.namespaceId || !ids.has(entityId),
      )
    )
      throw new Error("Invalid Namespace deletion or restoration");
  }
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareDeletion(a: TrashDeletion, b: TrashDeletion): number {
  return (
    a.counter - b.counter ||
    compareString(a.replicaId, b.replicaId) ||
    compareString(a.operationId, b.operationId)
  );
}

const models = new WeakMap<Y.Map<unknown>, ReplicatedNamespace>();
export function replicatedNamespace(
  root: Y.Map<unknown>,
  replicaId?: string,
): ReplicatedNamespace | undefined {
  if (root.get("schema_version") !== REPLICATED_WORKSPACE_SCHEMA_VERSION)
    return undefined;
  let model = models.get(root);
  if (!model) {
    model = new ReplicatedNamespace(root, replicaId ?? createUuidV7());
    models.set(root, model);
  } else if (replicaId && replicaId !== model.replicaId)
    throw new Error("Workspace Replica identity is already bound");
  return model;
}

/** One-way conversion on an isolated candidate. Callers install only after validation. */
export function normalizeNamespace(
  root: Y.Map<unknown>,
  entries: readonly NamespaceEntry[],
  replicaId: string,
): void {
  const namespace = root.get("main_namespace") as Y.Map<unknown>;
  root.doc!.transact(() => {
    root.set("schema_version", REPLICATED_WORKSPACE_SCHEMA_VERSION);
    for (const key of ["placements", "deletions", "restorations"])
      namespace.set(key, new Y.Map());
    const model = replicatedNamespace(root, replicaId)!;
    // Existing Entry maps retain their Yjs identity and their resource target.
    let counter = 0;
    const deletes = new Map<string, { at: string; ids: string[] }>();
    for (const entry of entries) {
      const value = model.entries.get(entry.entryId)!;
      for (const key of PLACEMENT_FIELDS) value.delete(key);
      const operationId = createUuidV7();
      model.placements.set(operationId, {
        operationId,
        replicaId,
        counter: ++counter,
        entityId: entry.entryId,
        parentId: entry.parentEntryId ?? model.namespaceId,
        region: "entries",
        position: entry.position,
      });
      if (entry.trashOperationId) {
        const deletion = deletes.get(entry.trashOperationId) ?? {
          at: entry.deletedAt!,
          ids: [],
        };
        deletion.ids.push(entry.entryId);
        deletes.set(entry.trashOperationId, deletion);
      }
    }
    for (const [operationId, deletion] of deletes)
      model.deletions.set(operationId, {
        operationId,
        replicaId,
        counter: ++counter,
        entityIds: deletion.ids,
        at: deletion.at,
      });
    for (const value of (root.get("notes") as Y.Map<Y.Map<unknown>>).values()) {
      value.delete("deleted_at");
      value.delete("trash_operation_id");
    }
  });
}
