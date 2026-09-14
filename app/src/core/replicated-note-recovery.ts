import { createUuidV7 } from "./ids";
import { ReplicatedNote, type ProtectedContent } from "./replicated-note";
import { siblingPositionBetween } from "./sibling-position";

export const NOTE_RECOVERY_ORIGIN = "memoka:note-recovery";
interface RecoveryIdentity {
  readonly noteId: string;
  readonly replicaId: string;
  readonly entityId: string;
}
export type NoteRecoveryAction = RecoveryIdentity &
  (
    | {
        readonly kind: "restore-deletions";
        readonly deletionIds: readonly string[];
      }
    | {
        readonly kind: "restore-structure";
        readonly types: readonly {
          entityId: string;
          before: string;
          after: string;
        }[];
      }
    | { readonly kind: "copy-inline"; readonly createdId: string }
  );
export interface NoteRecoveryItem {
  readonly entityId: string;
  readonly type: string;
  readonly reason: ProtectedContent["reason"];
  readonly preview: string;
  readonly action: NoteRecoveryAction | null;
}
export interface NoteRecoveryPage {
  readonly items: readonly NoteRecoveryItem[];
  readonly total: number;
  readonly offset: number;
  readonly depthCorrections: number;
}

/** Read only. Group hidden descendants under their first protected ancestor. */
export function readNoteRecovery(
  note: ReplicatedNote,
  offset = 0,
  limit = 50,
): NoteRecoveryPage {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Invalid recovery page");
  const projection = note.project();
  const hidden = new Set(
    projection.recovery
      .filter((item) => !projection.visible.has(item.entityId))
      .map((item) => item.entityId),
  );
  const roots = projection.recovery.filter((item) => {
    let id = projection.parents.get(item.entityId)?.parentId;
    while (id && id !== note.noteId) {
      if (hidden.has(id)) return false;
      id = projection.parents.get(id)?.parentId;
    }
    return true;
  });
  return {
    total: roots.length,
    offset,
    depthCorrections: projection.depthCorrections.length,
    items: roots.slice(offset, offset + limit).map((item) => ({
      ...item,
      type: note.type(item.entityId),
      preview: note
        .inlineContent(item.entityId)
        .map(
          (node) =>
            node.text ??
            (node.type === "hardBreak"
              ? "\n"
              : String(node.attrs?.label ?? "")),
        )
        .join("")
        .slice(0, 1000),
      action: prepareRecovery(note, item),
    })),
  };
}

function prepareRecovery(
  note: ReplicatedNote,
  item: ProtectedContent,
): NoteRecoveryAction | null {
  const identity = {
    noteId: note.noteId,
    replicaId: note.replicaId,
    entityId: item.entityId,
  };
  const tree = note.project();
  const deletions = new Set<string>();
  const pending = [item.entityId],
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const deletion of note.activeDeletions(id)) deletions.add(deletion);
    const parent = tree.parents.get(id)?.parentId,
      column = note.require(id).columnId;
    if (parent) pending.push(parent);
    if (column) pending.push(column);
  }
  if (deletions.size)
    return {
      ...identity,
      kind: "restore-deletions",
      deletionIds: [...deletions].sort(),
    };
  if (tree.visible.has(item.entityId) && note.inline(item.entityId).length)
    return { ...identity, kind: "copy-inline", createdId: createUuidV7() };
  const types: { entityId: string; before: string; after: string }[] = [];
  const repaired = new Map<string, string>();
  let id = item.entityId;
  while (id !== note.noteId) {
    const edge = tree.parents.get(id)!;
    const type = repaired.get(id) ?? note.type(id);
    const parentType = note.type(edge.parentId);
    if (!note.allowedPlacement(type, parentType, edge.region)) {
      if (edge.parentId === note.noteId) return null;
      // Prefer the original parent kind. When a paragraph became a container
      // in a later edit, derive a compatible container from the retained child.
      const after = [
        note.require(edge.parentId).type,
        "blockquote",
        "bulletList",
        "orderedList",
        "details",
        "table",
        "tableRow",
        "tableCell",
        "detailsBody",
        "section",
      ].find((parent) => note.allowedPlacement(type, parent, edge.region));
      if (!after) return null;
      types.push({ entityId: edge.parentId, before: parentType, after });
      repaired.set(edge.parentId, after);
    }
    id = edge.parentId;
  }
  return types.length
    ? { ...identity, kind: "restore-structure", types }
    : null;
}

/** Validate a disposable candidate before touching the live shared elements. */
export function applyNoteRecovery(
  note: ReplicatedNote,
  action: NoteRecoveryAction,
  updatedAt: string,
): string | null {
  if (action.noteId !== note.noteId || action.replicaId !== note.replicaId)
    throw new Error("Recovery request belongs to another replica");
  const candidate = ReplicatedNote.load(
    note.noteId,
    note.replicaId,
    note.snapshot(),
  );
  try {
    perform(candidate, action, updatedAt);
    candidate.validate();
  } finally {
    candidate.destroy();
  }
  note.history.stopCapturing();
  const createdId = perform(note, action, updatedAt);
  note.history.stopCapturing();
  return createdId;
}
function perform(
  note: ReplicatedNote,
  action: NoteRecoveryAction,
  updatedAt: string,
): string | null {
  note.require(action.entityId);
  let createdId: string | null = null;
  if (action.kind === "restore-structure") {
    if (
      !action.types.length ||
      action.types.length > 128 ||
      new Set(action.types.map((type) => type.entityId)).size !==
        action.types.length
    )
      throw new Error("Invalid recovery types");
    for (const type of action.types)
      if (note.type(type.entityId) !== type.before)
        throw new Error(
          "内容の種類が変更されています。復旧対象を読み直してください",
        );
  }
  if (
    action.kind === "restore-deletions" &&
    (!action.deletionIds.length ||
      new Set(action.deletionIds).size !== action.deletionIds.length)
  )
    throw new Error("Invalid observed recovery deletions");
  note.transact(() => {
    if (action.kind === "restore-deletions") {
      for (const id of action.deletionIds) note.restore(id);
    } else if (action.kind === "restore-structure") {
      for (const type of action.types)
        note.attributes(type.entityId).set("type", type.after);
    } else {
      const inline = note.inlineContent(action.entityId);
      if (!inline.length) throw new Error("保護された本文が見つかりません");
      const tree = note.project();
      const siblings = (tree.children.get(note.noteId) ?? []).filter(
        (id) => tree.parents.get(id)!.region === "body",
      );
      const last = siblings.at(-1);
      const position = siblingPositionBetween(
        last ? tree.parents.get(last)!.position : null,
        null,
        action.createdId,
      );
      createdId = note.createEntity(
        "paragraph",
        note.noteId,
        "body",
        position,
        { id: action.createdId, inline },
      );
    }
    note.meta.set("updated_at", updatedAt);
  }, NOTE_RECOVERY_ORIGIN);
  return createdId;
}
