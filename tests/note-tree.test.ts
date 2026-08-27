import { describe, expect, it } from "vitest";
import {
  deriveTrashNoteTreeEntries,
  deriveVisibleNoteTree,
  noteAncestorPath,
  planNewNotePosition,
  planNoteMove,
  planNoteTrash,
  planTrashRestore,
  treeMoveRequestForDirection,
} from "../app/src/core/note-tree";
import type { NoteMetadata } from "../app/src/core/documents";

const ROOT_A = "01900000-0000-7000-8000-000000000101";
const CHILD_A = "01900000-0000-7000-8000-000000000102";
const GRANDCHILD_A = "01900000-0000-7000-8000-000000000103";
const CHILD_B = "01900000-0000-7000-8000-000000000104";
const ROOT_B = "01900000-0000-7000-8000-000000000105";
const CREATED = "01900000-0000-7000-8000-000000000106";

function note(
  noteId: string,
  title: string,
  notePosition: string,
  parentNoteId: string | null = null,
  deleted?: { at: string; operationId: string },
): NoteMetadata {
  return {
    noteId,
    parentNoteId,
    title,
    notePosition,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: deleted?.at ?? "2026-08-19T00:00:00.000Z",
    deletedAt: deleted?.at,
    trashOperationId: deleted?.operationId,
  };
}

function hierarchy(): NoteMetadata[] {
  return [
    note(ROOT_A, "Root A", "a0"),
    note(CHILD_A, "Child A", "a0", ROOT_A),
    note(GRANDCHILD_A, "Grandchild", "a0", CHILD_A),
    note(CHILD_B, "Child B", "a1", ROOT_A),
    note(ROOT_B, "Root B", "a1"),
  ];
}

describe("Note Tree projection and structural plans", () => {
  it("projects a 10,000-level hierarchy without recursive traversal", () => {
    const notes = Array.from({ length: 10_000 }, (_, index) => {
      const noteId = `01900000-0000-7000-8000-${index
        .toString(16)
        .padStart(12, "0")}`;
      const parentNoteId =
        index === 0
          ? null
          : `01900000-0000-7000-8000-${(index - 1)
              .toString(16)
              .padStart(12, "0")}`;
      return note(noteId, `Note ${index}`, "a0", parentNoteId);
    });

    const entries = deriveVisibleNoteTree(notes);
    expect(entries).toHaveLength(10_000);
    expect(entries.at(-1)).toMatchObject({ depth: 9_999 });
  });

  it("projects an iterative ordered tree and hides collapsed descendants", () => {
    expect(
      deriveVisibleNoteTree(hierarchy()).map(({ note, depth }) => [
        note.noteId,
        depth,
      ]),
    ).toEqual([
      [ROOT_A, 0],
      [CHILD_A, 1],
      [GRANDCHILD_A, 2],
      [CHILD_B, 1],
      [ROOT_B, 0],
    ]);
    expect(
      deriveVisibleNoteTree(hierarchy(), new Set([CHILD_A])).map(
        ({ note }) => note.noteId,
      ),
    ).toEqual([ROOT_A, CHILD_A, CHILD_B, ROOT_B]);
  });

  it("derives Vim-style sibling moves without crossing unrelated branches", () => {
    expect(treeMoveRequestForDirection(hierarchy(), CHILD_B, "up")).toEqual({
      targetParentId: ROOT_A,
      placement: { kind: "first" },
    });
    expect(treeMoveRequestForDirection(hierarchy(), CHILD_B, "indent")).toEqual(
      {
        targetParentId: CHILD_A,
        placement: { kind: "last" },
      },
    );
    expect(
      treeMoveRequestForDirection(hierarchy(), GRANDCHILD_A, "outdent"),
    ).toEqual({
      targetParentId: ROOT_A,
      placement: { kind: "after", noteId: CHILD_A },
    });
    expect(treeMoveRequestForDirection(hierarchy(), ROOT_A, "up")).toBeNull();
  });

  it("plans hierarchy changes and rejects moving a Note below its descendant", () => {
    const plan = planNoteMove(
      hierarchy(),
      CHILD_B,
      { targetParentId: CHILD_A, placement: { kind: "last" } },
      "move-seed",
    );
    expect(plan).toMatchObject({ targetParentId: CHILD_A, changed: true });
    expect(() =>
      planNoteMove(
        hierarchy(),
        ROOT_A,
        { targetParentId: GRANDCHILD_A, placement: { kind: "last" } },
        "cycle-seed",
      ),
    ).toThrow("descendant");
  });

  it("inserts at the end of a parent and locally repairs position collisions", () => {
    const collision = [
      note(ROOT_A, "Root A", "a0"),
      note(ROOT_B, "Root B", "a0"),
    ];
    const plan = planNewNotePosition(
      collision,
      null,
      ROOT_A,
      CREATED,
      "insert-seed",
    );
    expect(plan.notePosition).not.toBe("a0");
    expect(plan.reindexedSiblings.map(({ noteId }) => noteId).sort()).toEqual(
      [ROOT_A, ROOT_B].sort(),
    );
  });

  it("trashes and restores one subtree as one operation", () => {
    const plan = planNoteTrash(hierarchy(), ROOT_A);
    expect(new Set(plan.noteIds)).toEqual(
      new Set([ROOT_A, CHILD_A, GRANDCHILD_A, CHILD_B]),
    );
    expect(plan.fallbackNoteId).toBe(ROOT_B);

    const deleted = hierarchy().map((candidate) =>
      plan.noteIds.includes(candidate.noteId)
        ? {
            ...candidate,
            deletedAt: "2026-08-19T01:00:00.000Z",
            trashOperationId: "trash-operation",
          }
        : candidate,
    );
    expect(deriveTrashNoteTreeEntries(deleted)).toMatchObject([
      { note: { noteId: ROOT_A }, descendantCount: 3 },
    ]);
    expect(new Set(planTrashRestore(deleted, ROOT_A))).toEqual(
      new Set(plan.noteIds),
    );
  });

  it("keeps an independently trashed descendant out of a later ancestor operation", () => {
    const oldTrash = {
      at: "2026-08-19T01:00:00.000Z",
      operationId: "old-trash",
    };
    const notes = hierarchy().map((candidate) =>
      candidate.noteId === CHILD_A || candidate.noteId === GRANDCHILD_A
        ? note(
            candidate.noteId,
            candidate.title,
            candidate.notePosition,
            candidate.parentNoteId,
            oldTrash,
          )
        : candidate,
    );
    const plan = planNoteTrash(notes, ROOT_A);
    expect(new Set(plan.noteIds)).toEqual(new Set([ROOT_A, CHILD_B]));

    const newTrash = {
      at: "2026-08-19T02:00:00.000Z",
      operationId: "new-trash",
    };
    const deleted = notes.map((candidate) =>
      plan.noteIds.includes(candidate.noteId)
        ? note(
            candidate.noteId,
            candidate.title,
            candidate.notePosition,
            candidate.parentNoteId,
            newTrash,
          )
        : candidate,
    );
    expect(deriveTrashNoteTreeEntries(deleted)).toMatchObject([
      { note: { noteId: ROOT_A }, descendantCount: 1 },
      { note: { noteId: CHILD_A }, descendantCount: 1 },
    ]);
    expect(new Set(planTrashRestore(deleted, ROOT_A))).toEqual(
      new Set([ROOT_A, CHILD_B]),
    );
  });

  it("derives ancestor paths using the blank-title projection", () => {
    const notes = hierarchy().map((candidate) =>
      candidate.noteId === CHILD_A ? { ...candidate, title: "" } : candidate,
    );
    expect(noteAncestorPath(notes, GRANDCHILD_A)).toBe("/Root A/新しいノート");
    expect(noteAncestorPath(notes, ROOT_A)).toBe("/");
  });
});
