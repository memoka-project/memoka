import { describe, expect, it } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryWorkspaceSearchIndexPort } from "../app/src/core/workspace-search-index";
import {
  validateNamespace,
  type NamespaceEntry,
} from "../app/src/core/namespace";

describe("Main Namespace", () => {
  it("rejects invalid placements, parents and independent Entry identities", () => {
    const noteId = "01a30000-0000-7000-8000-000000000001";
    const entryId = "01a30000-0000-7000-8000-000000000002";
    const groupId = "01a30000-0000-7000-8000-000000000003";
    const operationId = "01a30000-0000-7000-8000-000000000004";
    const at = "2026-09-06T00:00:00Z";
    const entry: NamespaceEntry = {
      entryId,
      target: { kind: "note", id: noteId },
      name: null,
      parentEntryId: null,
      position: "a0",
      createdAt: at,
      updatedAt: at,
    };
    const group: NamespaceEntry = {
      ...entry,
      entryId: groupId,
      target: null,
      name: "Group",
    };
    const notes = new Map([[noteId, {}]]);
    const valid = [entry, group];
    expect(() => validateNamespace(valid, notes)).not.toThrow();
    for (const invalid of [
      [{ ...entry, entryId: noteId }, group],
      [entry, { ...entry, entryId: groupId }],
      [{ ...entry, parentEntryId: entryId }, group],
      [{ ...entry, parentEntryId: operationId }, group],
      [
        { ...entry, parentEntryId: groupId },
        { ...group, parentEntryId: entryId },
      ],
      [
        { ...entry, parentEntryId: groupId },
        { ...group, deletedAt: at, trashOperationId: operationId },
      ],
      [entry, { ...group, deletedAt: at }],
      [entry, { ...group, name: "multi\nline" }],
      [entry, { ...group, position: "" }],
      [entry, { ...group, entryId: "not-an-id" }],
    ])
      expect(() => validateNamespace(invalid, notes)).toThrow();
    expect(() => validateNamespace([group], notes)).toThrow(
      "no Namespace entry",
    );
    expect(() => validateNamespace(valid, new Map())).toThrow(
      "target Note is missing",
    );
  });

  it("does not restore a descendant trashed by a separate operation", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const parent = await runtime.createNamespaceGroup(null, "Parent");
      const earlier = await runtime.createNamespaceGroup(
        parent.entryId,
        "Earlier Trash",
      );
      const note = await runtime.createNoteAtEntry(
        "window-1",
        parent.entryId,
        "child",
      );
      await runtime.trashNamespaceEntry(earlier.entryId);
      const oldTrash = runtime
        .snapshot()
        .namespaceEntries.find((entry) => entry.entryId === earlier.entryId);
      await runtime.trashNamespaceEntry(parent.entryId);
      await runtime.restoreNamespaceEntry(parent.entryId);
      expect(
        runtime
          .snapshot()
          .namespaceEntries.find((entry) => entry.entryId === earlier.entryId),
      ).toEqual(oldTrash);
      expect(
        runtime.snapshot().notes.find((entry) => entry.noteId === note.noteId)
          ?.deletedAt,
      ).toBeUndefined();
      expect(
        runtime
          .snapshot()
          .namespaceEntries.find((entry) => entry.entryId === parent.entryId)
          ?.deletedAt,
      ).toBeUndefined();
    } finally {
      runtime.destroy();
    }
  });
  it("finds and restores a group-only Trash operation without creating Notes", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const initialNotes = runtime.snapshot().notes.length;
      const parent = await runtime.createNamespaceGroup(null, "Parent group");
      const child = await runtime.createNamespaceGroup(
        parent.entryId,
        "Child group",
      );
      await runtime.trashNamespaceEntry(parent.entryId);
      const trash = await runtime.searchWorkspace(
        "parent child",
        "title",
        20,
        "trash",
      );
      expect(trash.results).toEqual([
        expect.objectContaining({
          kind: "group",
          namespaceEntryId: child.entryId,
          parentPath: "/Parent group",
        }),
      ]);
      await runtime.restoreNamespaceEntry(child.entryId);
      expect(
        (await runtime.searchWorkspace("group", "title", 20, "trash")).results,
      ).toEqual([]);
      expect(
        runtime
          .snapshot()
          .namespaceEntries.filter(
            (entry) => !entry.deletedAt && !entry.targetNoteId,
          ),
      ).toHaveLength(2);
      expect(runtime.snapshot().notes).toHaveLength(initialNotes);
    } finally {
      runtime.destroy();
    }
  });

  it("updates group search paths without rewriting Note bodies or timestamps", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      workspaceSearchIndex: index,
    });
    try {
      const parent = await runtime.createNamespaceGroup(null, "Before");
      const note = await runtime.createNoteAtEntry(
        "window-1",
        parent.entryId,
        "child",
      );
      await runtime.renameNote(note.noteId, "Child");
      await runtime.flush();
      const before = await persistence.loadDocument("note", note.noteId);
      const updatedAt = runtime
        .snapshot()
        .notes.find((item) => item.noteId === note.noteId)!.updatedAt;
      const counts = [index.rebuildCount, index.replaceCount];
      await runtime.renameNamespaceGroup(parent.entryId, "Renamed");
      expect(
        await runtime.searchWorkspace("renamed child", "title"),
      ).toMatchObject({
        backend: "sqlite-fts",
        results: [
          expect.objectContaining({
            noteId: note.noteId,
            parentPath: "/Renamed",
          }),
        ],
      });
      await runtime.flush();
      expect([index.rebuildCount, index.replaceCount]).toEqual(counts);
      expect(
        runtime.snapshot().notes.find((item) => item.noteId === note.noteId)!
          .updatedAt,
      ).toBe(updatedAt);
      expect(await persistence.loadDocument("note", note.noteId)).toEqual(
        before,
      );
    } finally {
      runtime.destroy();
    }
  });
});
