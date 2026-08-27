import {
  noteDisplayTitle,
  validateNoteMetadataTree,
  type NoteMetadata,
} from "./documents";
import {
  compareSiblingPositions,
  isCanonicalSiblingPosition,
  siblingPositionBetween,
  siblingPositionsBetween,
} from "./sibling-position";

export interface VisibleNoteTreeEntry {
  readonly note: NoteMetadata;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

export type NoteMovePlacement =
  | { readonly kind: "first" }
  | { readonly kind: "last" }
  | { readonly kind: "after"; readonly noteId: string };

export interface NoteMoveRequest {
  readonly targetParentId: string | null;
  readonly placement: NoteMovePlacement;
}

export type TreeMoveDirection = "up" | "down" | "outdent" | "indent";

export interface SiblingPositionUpdate {
  readonly noteId: string;
  readonly notePosition: string;
}

export interface PlannedSiblingInsertion {
  readonly notePosition: string;
  readonly reindexedSiblings: readonly SiblingPositionUpdate[];
}

export interface PlannedNoteMove extends PlannedSiblingInsertion {
  readonly targetParentId: string | null;
  readonly placement: NoteMovePlacement;
  readonly changed: boolean;
}

export interface NoteTrashPlan {
  readonly noteIds: readonly string[];
  readonly fallbackNoteId: string | null;
}

export interface TrashNoteTreeEntry {
  readonly note: NoteMetadata;
  readonly descendantCount: number;
}

export function liveNotes(notes: readonly NoteMetadata[]): NoteMetadata[] {
  return notes.filter(({ deletedAt }) => !deletedAt).sort(compareNoteMetadata);
}

export function deriveVisibleNoteTree(
  notes: readonly NoteMetadata[],
  collapsedNoteIds: ReadonlySet<string> = new Set(),
): VisibleNoteTreeEntry[] {
  validateNoteMetadataTree(notes);
  const live = notes.filter(({ deletedAt }) => !deletedAt);
  const children = groupChildren(live);
  const roots = children.get(null) ?? [];
  const output: VisibleNoteTreeEntry[] = [];
  const pending: Array<{ note: NoteMetadata; depth: number }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    pending.push({ note: roots[index]!, depth: 0 });
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    const noteChildren = children.get(current.note.noteId) ?? [];
    const expanded = !collapsedNoteIds.has(current.note.noteId);
    output.push({
      note: current.note,
      depth: current.depth,
      hasChildren: noteChildren.length > 0,
      expanded,
    });
    if (!expanded) continue;
    for (let index = noteChildren.length - 1; index >= 0; index -= 1) {
      pending.push({ note: noteChildren[index]!, depth: current.depth + 1 });
    }
  }
  return output;
}

export function planNewNotePosition(
  notes: readonly NoteMetadata[],
  parentNoteId: string | null,
  afterNoteId: string | null,
  noteId: string,
  seed: string,
): PlannedSiblingInsertion {
  validateNoteMetadataTree(notes);
  if (parentNoteId !== null) {
    const parent = notes.find(
      (note) => note.noteId === parentNoteId && !note.deletedAt,
    );
    if (!parent) throw new Error(`Unknown live parent: ${parentNoteId}`);
  }
  const siblings = liveSiblings(notes, parentNoteId);
  let insertionIndex: number;
  if (afterNoteId === null) {
    insertionIndex = siblings.length;
  } else {
    const afterIndex = siblings.findIndex(
      (candidate) => candidate.noteId === afterNoteId,
    );
    if (afterIndex < 0) {
      throw new Error(
        `Note ${afterNoteId} is not a child of ${parentNoteId ?? "top level"}`,
      );
    }
    insertionIndex = afterIndex + 1;
  }
  return planSiblingInsertion(siblings, insertionIndex, noteId, seed);
}

export function planNoteMove(
  notes: readonly NoteMetadata[],
  noteId: string,
  request: NoteMoveRequest,
  seed: string,
): PlannedNoteMove {
  validateNoteMetadataTree(notes);
  const live = notes.filter(({ deletedAt }) => !deletedAt);
  const byId = new Map(live.map((note) => [note.noteId, note]));
  const moving = byId.get(noteId);
  if (!moving) throw new Error(`Unknown live note: ${noteId}`);
  if (request.targetParentId !== null && !byId.has(request.targetParentId)) {
    throw new Error(`Unknown live parent: ${request.targetParentId}`);
  }
  if (collectDescendantIds(live, noteId).has(request.targetParentId ?? "")) {
    throw new Error("A note cannot be moved below itself or its descendant");
  }

  const originalSiblings = liveSiblings(live, moving.parentNoteId);
  const originalIndex = originalSiblings.findIndex(
    (candidate) => candidate.noteId === noteId,
  );
  const targetSiblings = liveSiblings(live, request.targetParentId).filter(
    (candidate) => candidate.noteId !== noteId,
  );
  let insertionIndex: number;
  if (request.placement.kind === "first") {
    insertionIndex = 0;
  } else if (request.placement.kind === "last") {
    insertionIndex = targetSiblings.length;
  } else {
    const afterNoteId = request.placement.noteId;
    const afterIndex = targetSiblings.findIndex(
      (candidate) => candidate.noteId === afterNoteId,
    );
    if (afterIndex < 0) {
      throw new Error(`Note ${afterNoteId} is not a target sibling`);
    }
    insertionIndex = afterIndex + 1;
  }

  if (
    moving.parentNoteId === request.targetParentId &&
    originalIndex === insertionIndex
  ) {
    return {
      ...request,
      notePosition: moving.notePosition,
      reindexedSiblings: [],
      changed: false,
    };
  }
  return {
    ...request,
    ...planSiblingInsertion(targetSiblings, insertionIndex, noteId, seed),
    changed: true,
  };
}

export function treeMoveRequestForDirection(
  notes: readonly NoteMetadata[],
  noteId: string,
  direction: TreeMoveDirection,
): NoteMoveRequest | null {
  const live = notes.filter(({ deletedAt }) => !deletedAt);
  const byId = new Map(live.map((note) => [note.noteId, note]));
  const moving = byId.get(noteId);
  if (!moving) return null;
  const siblings = liveSiblings(live, moving.parentNoteId);
  const index = siblings.findIndex((candidate) => candidate.noteId === noteId);
  if (direction === "up") {
    if (index <= 0) return null;
    return {
      targetParentId: moving.parentNoteId,
      placement:
        index === 1
          ? { kind: "first" }
          : { kind: "after", noteId: siblings[index - 2]!.noteId },
    };
  }
  if (direction === "down") {
    const next = siblings[index + 1];
    return next
      ? {
          targetParentId: moving.parentNoteId,
          placement: { kind: "after", noteId: next.noteId },
        }
      : null;
  }
  if (direction === "outdent") {
    if (moving.parentNoteId === null) return null;
    const parent = byId.get(moving.parentNoteId);
    return parent
      ? {
          targetParentId: parent.parentNoteId,
          placement: { kind: "after", noteId: parent.noteId },
        }
      : null;
  }
  const previous = siblings[index - 1];
  return previous
    ? { targetParentId: previous.noteId, placement: { kind: "last" } }
    : null;
}

export function planNoteTrash(
  notes: readonly NoteMetadata[],
  noteId: string,
): NoteTrashPlan {
  const entries = deriveVisibleNoteTree(notes);
  const selectedIndex = entries.findIndex(
    (entry) => entry.note.noteId === noteId,
  );
  if (selectedIndex < 0) throw new Error(`Unknown live note: ${noteId}`);
  const noteIds = collectDescendantIds(
    notes.filter(({ deletedAt }) => !deletedAt),
    noteId,
  );
  let fallbackNoteId: string | null = null;
  for (let index = selectedIndex + 1; index < entries.length; index += 1) {
    const candidate = entries[index]!.note.noteId;
    if (!noteIds.has(candidate)) {
      fallbackNoteId = candidate;
      break;
    }
  }
  if (!fallbackNoteId) {
    for (let index = selectedIndex - 1; index >= 0; index -= 1) {
      const candidate = entries[index]!.note.noteId;
      if (!noteIds.has(candidate)) {
        fallbackNoteId = candidate;
        break;
      }
    }
  }
  return { noteIds: [...noteIds], fallbackNoteId };
}

export function planTrashRestore(
  notes: readonly NoteMetadata[],
  noteId: string,
): string[] {
  validateNoteMetadataTree(notes);
  const root = notes.find((note) => note.noteId === noteId);
  if (!root?.deletedAt) throw new Error(`Note is not in Trash: ${noteId}`);
  const restored = root.trashOperationId
    ? notes.filter(
        (note) =>
          note.deletedAt && note.trashOperationId === root.trashOperationId,
      )
    : [root];
  const restoredIds = new Set(restored.map((note) => note.noteId));
  for (const note of restored) {
    if (note.parentNoteId === null || restoredIds.has(note.parentNoteId)) {
      continue;
    }
    const parent = notes.find(
      (candidate) => candidate.noteId === note.parentNoteId,
    );
    if (!parent || parent.deletedAt) {
      throw new Error("Restore the deleted ancestor first");
    }
  }
  return restored.map((note) => note.noteId);
}

export function deriveTrashNoteTreeEntries(
  notes: readonly NoteMetadata[],
): TrashNoteTreeEntry[] {
  validateNoteMetadataTree(notes);
  const byId = new Map(notes.map((note) => [note.noteId, note]));
  return notes
    .filter((note) => {
      if (!note.deletedAt) return false;
      if (note.parentNoteId === null) return true;
      return !sameTrashOperation(note, byId.get(note.parentNoteId));
    })
    .map((note) => ({
      note,
      descendantCount: [...collectDescendantIds(notes, note.noteId)].filter(
        (candidateId) =>
          candidateId !== note.noteId &&
          sameTrashOperation(note, byId.get(candidateId)),
      ).length,
    }))
    .sort(
      (left, right) =>
        (right.note.deletedAt ?? "").localeCompare(left.note.deletedAt ?? "") ||
        compareNoteMetadata(left.note, right.note),
    );
}

function sameTrashOperation(
  root: NoteMetadata,
  candidate: NoteMetadata | undefined,
): boolean {
  return Boolean(
    root.trashOperationId &&
    candidate?.deletedAt &&
    candidate.trashOperationId === root.trashOperationId,
  );
}

export function collectDescendantIds(
  notes: readonly NoteMetadata[],
  noteId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const note of notes) {
    if (note.parentNoteId === null) continue;
    const values = children.get(note.parentNoteId) ?? [];
    values.push(note.noteId);
    children.set(note.parentNoteId, values);
  }
  const output = new Set<string>();
  const pending = [noteId];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (output.has(candidate)) continue;
    output.add(candidate);
    pending.push(...(children.get(candidate) ?? []));
  }
  return output;
}

export function noteAncestorPath(
  notes: readonly NoteMetadata[],
  noteId: string,
): string {
  const byId = new Map(notes.map((note) => [note.noteId, note]));
  const components: string[] = [];
  let cursor = byId.get(noteId);
  const visited = new Set<string>();
  while (cursor?.parentNoteId) {
    if (visited.has(cursor.parentNoteId)) {
      throw new Error(`Note tree contains a cycle at ${cursor.parentNoteId}`);
    }
    visited.add(cursor.parentNoteId);
    const parent = byId.get(cursor.parentNoteId);
    if (!parent) throw new Error(`Note ${cursor.noteId} has an unknown parent`);
    components.push(noteDisplayTitle(parent.title));
    cursor = parent;
  }
  return components.length === 0 ? "/" : `/${components.reverse().join("/")}`;
}

export function compareNoteMetadata(
  left: Pick<NoteMetadata, "notePosition" | "noteId">,
  right: Pick<NoteMetadata, "notePosition" | "noteId">,
): number {
  return (
    compareSiblingPositions(left.notePosition, right.notePosition) ||
    compareIdentifiers(left.noteId, right.noteId)
  );
}

function groupChildren(
  notes: readonly NoteMetadata[],
): Map<string | null, NoteMetadata[]> {
  const children = new Map<string | null, NoteMetadata[]>();
  for (const note of notes) {
    const siblings = children.get(note.parentNoteId) ?? [];
    siblings.push(note);
    children.set(note.parentNoteId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareNoteMetadata);
  return children;
}

function liveSiblings(
  notes: readonly NoteMetadata[],
  parentNoteId: string | null,
): NoteMetadata[] {
  return notes
    .filter((note) => !note.deletedAt && note.parentNoteId === parentNoteId)
    .sort(compareNoteMetadata);
}

function planSiblingInsertion(
  siblings: readonly NoteMetadata[],
  insertionIndex: number,
  noteId: string,
  seed: string,
): PlannedSiblingInsertion {
  if (insertionIndex < 0 || insertionIndex > siblings.length) {
    throw new Error(
      "Sibling insertion index is outside the target sibling set",
    );
  }
  if (siblings.some((sibling) => sibling.noteId === noteId)) {
    throw new Error(`Duplicate sibling insertion: ${noteId}`);
  }
  const lower = siblings[insertionIndex - 1]?.notePosition ?? null;
  const upper = siblings[insertionIndex]?.notePosition ?? null;
  if (
    (lower !== null && !isCanonicalSiblingPosition(lower)) ||
    (upper !== null && !isCanonicalSiblingPosition(upper))
  ) {
    throw new Error("Cannot insert beside a non-canonical note position");
  }
  if (lower === null || upper === null || lower !== upper) {
    return {
      notePosition: siblingPositionBetween(lower, upper, seed),
      reindexedSiblings: [],
    };
  }

  let collisionStart = insertionIndex - 1;
  while (
    collisionStart > 0 &&
    siblings[collisionStart - 1]!.notePosition === lower
  ) {
    collisionStart -= 1;
  }
  let collisionEnd = insertionIndex;
  while (
    collisionEnd < siblings.length &&
    siblings[collisionEnd]!.notePosition === lower
  ) {
    collisionEnd += 1;
  }
  const range = siblings.slice(collisionStart, collisionEnd);
  const insertionOffset = insertionIndex - collisionStart;
  const outerLower = siblings[collisionStart - 1]?.notePosition ?? null;
  const outerUpper = siblings[collisionEnd]?.notePosition ?? null;
  const positions = siblingPositionsBetween(
    outerLower,
    outerUpper,
    range.length + 1,
    seed,
  );
  return {
    notePosition: positions[insertionOffset]!,
    reindexedSiblings: range.map((sibling, index) => ({
      noteId: sibling.noteId,
      notePosition: positions[index < insertionOffset ? index : index + 1]!,
    })),
  };
}

function compareIdentifiers(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
