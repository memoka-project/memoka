import * as Y from "yjs";
import { assertUuidV7, createUuidV7 } from "./ids";
import { isCanonicalSiblingPosition } from "./sibling-position";
import type { NoteMetadata, WorkspaceDocument } from "./documents";
import {
  planNoteMove,
  planNoteTrash,
  planTrashRestore,
  planNewNotePosition,
  treeMoveRequestForDirection,
  type TreeMoveDirection,
  type NoteMoveRequest,
} from "./note-tree";

/** A placement is not a resource identity. Only Note targets are writable today. */
export interface ResourceRef {
  readonly kind: "note";
  readonly id: string;
}

export interface NamespaceEntry {
  readonly entryId: string;
  readonly parentEntryId: string | null;
  readonly position: string;
  readonly target: ResourceRef | null;
  readonly name: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
  readonly trashOperationId?: string;
}

export interface MainNamespace {
  readonly namespaceId: string;
  readonly entries: Y.Map<Y.Map<unknown>>;
}

export function createMainNamespace(
  namespaceId = createUuidV7(),
): Y.Map<unknown> {
  assertUuidV7(namespaceId, "namespaceId");
  const namespace = new Y.Map<unknown>();
  namespace.set("namespace_id", namespaceId);
  namespace.set("entries", new Y.Map<Y.Map<unknown>>());
  return namespace;
}

export function readMainNamespace(root: Y.Map<unknown>): MainNamespace {
  const namespace = root.get("main_namespace");
  if (!(namespace instanceof Y.Map))
    throw new Error("Main Namespace is missing");
  const namespaceId = namespace.get("namespace_id");
  if (typeof namespaceId !== "string")
    throw new Error("Namespace ID is missing");
  assertUuidV7(namespaceId, "namespaceId");
  const entries = namespace.get("entries");
  if (!(entries instanceof Y.Map))
    throw new Error("Namespace entries are missing");
  return { namespaceId, entries };
}

export function readNamespaceEntry(
  entryId: string,
  value: Y.Map<unknown>,
): NamespaceEntry {
  assertUuidV7(entryId, "entryId");
  const target = value.get("target");
  if (
    target != null &&
    (typeof target !== "object" ||
      !("kind" in target) ||
      target.kind !== "note" ||
      !("id" in target) ||
      typeof target.id !== "string")
  )
    throw new Error("Unsupported Namespace resource reference");
  if (target != null) assertUuidV7((target as ResourceRef).id, "target.id");
  const nullable = (key: string): string | undefined => {
    const item = value.get(key);
    if (item == null) return undefined;
    if (typeof item !== "string") throw new Error(`Invalid Namespace ${key}`);
    return item;
  };
  const position = nullable("position");
  if (!position || !isCanonicalSiblingPosition(position))
    throw new Error("Invalid Namespace position");
  const parentEntryId = nullable("parent_entry_id") ?? null;
  if (parentEntryId !== null) assertUuidV7(parentEntryId, "parentEntryId");
  const name = nullable("name") ?? null;
  if (target != null && name !== null)
    throw new Error("A resource Entry cannot have an alias");
  if (target == null && (name === null || /[\r\n]/u.test(name)))
    throw new Error("Group name must be a single line");
  const createdAt = nullable("created_at");
  const updatedAt = nullable("updated_at");
  if (createdAt === undefined || updatedAt === undefined)
    throw new Error("Namespace timestamps are missing");
  const deletedAt = nullable("deleted_at");
  const trashOperationId = nullable("trash_operation_id");
  if ((deletedAt === undefined) !== (trashOperationId === undefined))
    throw new Error("Namespace Trash metadata must be paired");
  if (trashOperationId !== undefined)
    assertUuidV7(trashOperationId, "trashOperationId");
  return {
    entryId,
    parentEntryId,
    position,
    target: (target as ResourceRef | null) ?? null,
    name,
    createdAt,
    updatedAt,
    deletedAt,
    trashOperationId,
  };
}

export function listNamespaceEntries(root: Y.Map<unknown>): NamespaceEntry[] {
  const { entries } = readMainNamespace(root);
  return [...entries]
    .map(([id, value]) => {
      if (!(value instanceof Y.Map)) throw new Error("Invalid Namespace entry");
      return readNamespaceEntry(id, value);
    })
    .sort((a, b) =>
      a.position < b.position
        ? -1
        : a.position > b.position
          ? 1
          : a.entryId < b.entryId
            ? -1
            : 1,
    );
}

export function namespaceEntryMap(entry: NamespaceEntry): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("parent_entry_id", entry.parentEntryId);
  value.set("position", entry.position);
  value.set("target", entry.target);
  if (!entry.target) value.set("name", entry.name ?? "");
  value.set("created_at", entry.createdAt);
  value.set("updated_at", entry.updatedAt);
  value.set("deleted_at", entry.deletedAt ?? null);
  value.set("trash_operation_id", entry.trashOperationId ?? null);
  return value;
}

export function namespaceNoteEntries(
  root: Y.Map<unknown>,
): Map<string, NamespaceEntry> {
  return new Map(
    listNamespaceEntries(root).flatMap((entry) =>
      entry.target ? [[entry.target.id, entry] as const] : [],
    ),
  );
}

export function validateNamespace(
  entries: readonly NamespaceEntry[],
  notes: ReadonlyMap<string, { deletedAt?: string; trashOperationId?: string }>,
): void {
  if (entries.length > 1_000_000)
    throw new Error("Namespace traversal limit exceeded");
  const byId = new Map<string, NamespaceEntry>();
  const placements = new Set<string>();
  for (const entry of entries) {
    assertUuidV7(entry.entryId, "entryId");
    if (entry.parentEntryId !== null)
      assertUuidV7(entry.parentEntryId, "parentEntryId");
    if (!isCanonicalSiblingPosition(entry.position))
      throw new Error("Invalid Namespace position");
    if (entry.target) {
      assertUuidV7(entry.target.id, "target.id");
      if (entry.target.kind !== "note" || entry.name !== null)
        throw new Error(
          "A Note Entry cannot have an alias or a different resource kind",
        );
    } else if (entry.name === null || /[\r\n]/u.test(entry.name)) {
      throw new Error("Group name must be a single line");
    }
    if (entry.trashOperationId !== undefined)
      assertUuidV7(entry.trashOperationId, "trashOperationId");
    if (notes.has(entry.entryId))
      throw new Error("Namespace Entry ID must not reuse a Note ID");
    if (
      (entry.deletedAt === undefined) !==
      (entry.trashOperationId === undefined)
    )
      throw new Error("Namespace Trash metadata must be paired");
    if (byId.has(entry.entryId))
      throw new Error("Duplicate Namespace entry ID");
    byId.set(entry.entryId, entry);
    if (!entry.target) continue;
    const note = notes.get(entry.target.id);
    if (!note) throw new Error("Namespace target Note is missing");
    if (placements.has(entry.target.id))
      throw new Error("A Note must have exactly one Namespace entry");
    placements.add(entry.target.id);
    if (
      (note.deletedAt ?? null) !== (entry.deletedAt ?? null) ||
      (note.trashOperationId ?? null) !== (entry.trashOperationId ?? null)
    ) {
      throw new Error("Namespace and Note Trash states disagree");
    }
  }
  for (const noteId of notes.keys()) {
    if (!placements.has(noteId)) throw new Error("Note has no Namespace entry");
  }
  const complete = new Set<string>();
  for (const entry of entries) {
    const parent =
      entry.parentEntryId === null ? null : byId.get(entry.parentEntryId);
    if (parent === undefined) throw new Error("Namespace parent is missing");
    if (!entry.deletedAt && parent?.deletedAt)
      throw new Error("Live Namespace entry has a deleted parent");
    if (complete.has(entry.entryId)) continue;
    const path = new Set<string>();
    let current: NamespaceEntry | undefined = entry;
    while (current && !complete.has(current.entryId)) {
      if (path.has(current.entryId))
        throw new Error("Namespace contains a cycle");
      path.add(current.entryId);
      current =
        current.parentEntryId === null
          ? undefined
          : byId.get(current.parentEntryId);
    }
    for (const id of path) complete.add(id);
  }
}

export function namespacePath(
  entries: readonly NamespaceEntry[],
  noteTitles: ReadonlyMap<string, string>,
  entryId: string,
): string[] {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const path: string[] = [];
  const visited = new Set<string>();
  let cursor = byId.get(entryId);
  while (cursor) {
    if (visited.has(cursor.entryId))
      throw new Error("Namespace contains a cycle");
    visited.add(cursor.entryId);
    path.push(
      cursor.target
        ? noteTitles.get(cursor.target.id) || "新しいノート"
        : cursor.name || "無題のグループ",
    );
    cursor =
      cursor.parentEntryId === null
        ? undefined
        : byId.get(cursor.parentEntryId);
  }
  return path.reverse();
}

/** Adapter for the existing, resource-independent hierarchy algorithms. */
export interface NamespaceTreeNode extends NoteMetadata {
  readonly entryId: string;
  readonly targetNoteId: string | null;
}

export function namespaceTreeNodes(
  workspace: WorkspaceDocument,
): NamespaceTreeNode[] {
  return listNamespaceEntries(workspace.root).map((entry) => ({
    noteId: entry.entryId,
    entryId: entry.entryId,
    targetNoteId: entry.target?.id ?? null,
    parentNoteId: entry.parentEntryId,
    notePosition: entry.position,
    title: entry.target
      ? String(workspace.notes.get(entry.target.id)?.get("title_cache") ?? "")
      : entry.name || "無題のグループ",
    createdAt: entry.createdAt,
    updatedAt: entry.target
      ? String(
          workspace.notes.get(entry.target.id)?.get("updated_at") ??
            entry.updatedAt,
        )
      : entry.updatedAt,
    deletedAt: entry.deletedAt,
    trashOperationId: entry.trashOperationId,
  }));
}

export type NamespaceEdit =
  | {
      kind: "create-group";
      entryId: string;
      parentEntryId: string | null;
      name: string;
      at: string;
    }
  | { kind: "rename-group"; entryId: string; name: string; at: string }
  | { kind: "move"; entryId: string; direction: TreeMoveDirection; at: string }
  | {
      kind: "move-to";
      entryId: string;
      targetParentId: string | null;
      placement: NoteMoveRequest["placement"];
      at: string;
    }
  | { kind: "trash" | "restore"; entryId: string; at: string };

export function planNamespaceEdit(
  workspace: WorkspaceDocument,
  request: NamespaceEdit,
  operationId: string,
): {
  entries: NamespaceEntry[];
  affectedEntryIds: string[];
  affectedNoteIds: string[];
  fallbackEntryId: string | null;
} {
  const entries = new Map(
    listNamespaceEntries(workspace.root).map((entry) => [
      entry.entryId,
      { ...entry },
    ]),
  );
  const nodes = namespaceTreeNodes(workspace);
  const entry = entries.get(request.entryId);
  let affectedEntryIds: string[] = [];
  let fallbackEntryId: string | null = null;
  if (request.kind === "create-group") {
    if (entry) throw new Error("Duplicate Namespace entry ID");
    if (/[\r\n]/u.test(request.name))
      throw new Error("グループ名には改行を含められません");
    const plan = planNewNotePosition(
      nodes,
      request.parentEntryId,
      null,
      request.entryId,
      operationId,
    );
    for (const update of plan.reindexedSiblings)
      entries.get(update.noteId)!.position = update.notePosition;
    entries.set(request.entryId, {
      entryId: request.entryId,
      parentEntryId: request.parentEntryId,
      position: plan.notePosition,
      target: null,
      name: request.name,
      createdAt: request.at,
      updatedAt: request.at,
    });
    affectedEntryIds = [
      request.entryId,
      ...plan.reindexedSiblings.map((update) => update.noteId),
    ];
  } else {
    if (!entry) throw new Error("Unknown Namespace entry");
    if (request.kind !== "restore" && entry.deletedAt)
      throw new Error("Namespace entry is in Trash");
    if (request.kind === "rename-group") {
      if (entry.target)
        throw new Error("ノート名はバッファ内のタイトルを編集してください");
      if (/[\r\n]/u.test(request.name))
        throw new Error("グループ名には改行を含められません");
      entry.name = request.name;
      entry.updatedAt = request.at;
      affectedEntryIds = [entry.entryId];
    } else if (request.kind === "move" || request.kind === "move-to") {
      const move =
        request.kind === "move-to"
          ? request
          : treeMoveRequestForDirection(
              nodes,
              entry.entryId,
              request.direction,
            );
      if (move) {
        const plan = planNoteMove(nodes, entry.entryId, move, operationId);
        if (plan.changed) {
          entry.parentEntryId = plan.targetParentId;
          entry.position = plan.notePosition;
          entry.updatedAt = request.at;
          for (const update of plan.reindexedSiblings)
            entries.get(update.noteId)!.position = update.notePosition;
          affectedEntryIds = [
            entry.entryId,
            ...plan.reindexedSiblings.map((update) => update.noteId),
          ];
        }
      }
    } else {
      if (request.kind === "trash") {
        const plan = planNoteTrash(nodes, entry.entryId);
        affectedEntryIds = [...plan.noteIds];
        fallbackEntryId = plan.fallbackNoteId;
      } else affectedEntryIds = [...planTrashRestore(nodes, entry.entryId)];
      for (const id of affectedEntryIds) {
        const item = entries.get(id)!;
        item.deletedAt = request.kind === "trash" ? request.at : undefined;
        item.trashOperationId =
          request.kind === "trash" ? operationId : undefined;
        item.updatedAt = request.at;
      }
    }
  }
  const affectedNoteIds = affectedEntryIds.flatMap((id) =>
    entries.get(id)?.target ? [entries.get(id)!.target!.id] : [],
  );
  const notes = new Map(
    [...workspace.notes].map(([id, value]) => [
      id,
      {
        deletedAt: (value.get("deleted_at") as string | undefined) ?? undefined,
        trashOperationId:
          (value.get("trash_operation_id") as string | undefined) ?? undefined,
      },
    ]),
  );
  if (request.kind === "trash" || request.kind === "restore")
    for (const id of affectedNoteIds)
      notes.set(id, {
        deletedAt: request.kind === "trash" ? request.at : undefined,
        trashOperationId: request.kind === "trash" ? operationId : undefined,
      });
  validateNamespace([...entries.values()], notes);
  return {
    entries: [...entries.values()],
    affectedEntryIds,
    affectedNoteIds,
    fallbackEntryId,
  };
}

export function applyNamespacePlan(
  workspace: WorkspaceDocument,
  plan: ReturnType<typeof planNamespaceEdit>,
  origin: unknown,
): void {
  const { entries } = readMainNamespace(workspace.root);
  const changed = new Set(plan.affectedEntryIds);
  workspace.doc.transact(() => {
    for (const entry of plan.entries) {
      if (!changed.has(entry.entryId)) continue;
      const value = entries.get(entry.entryId);
      if (!value) {
        entries.set(entry.entryId, namespaceEntryMap(entry));
        continue;
      }
      for (const [key, item] of Object.entries({
        parent_entry_id: entry.parentEntryId,
        position: entry.position,
        updated_at: entry.updatedAt,
        deleted_at: entry.deletedAt ?? null,
        trash_operation_id: entry.trashOperationId ?? null,
      })) {
        if (value.get(key) !== item) value.set(key, item);
      }
      if (!entry.target && value.get("name") !== entry.name)
        value.set("name", entry.name);
      if (entry.target) {
        const note = workspace.notes.get(entry.target.id)!;
        for (const [key, item] of Object.entries({
          deleted_at: entry.deletedAt ?? null,
          trash_operation_id: entry.trashOperationId ?? null,
        }))
          if (note.get(key) !== item) note.set(key, item);
      }
    }
  }, origin);
}
