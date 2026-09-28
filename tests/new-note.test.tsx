import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { createReplicatedWorkspaceDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { treeVisibleNamespaceNodes } from "../app/src/core/namespace";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

describe(":new-note", () => {
  it("keeps the created Note out of Tree and preserves it across restart and normalization", async () => {
    const persistence = new MemoryPersistencePort();
    let runtime = await CoreRuntime.open(persistence);
    let noteId: string;
    try {
      const initial = runtime.snapshot().namespaceEntries;
      await runtime.openAllNotes("window-1");
      ({ noteId } = await runtime.createUnfiledNote("window-1"));
      const snapshot = runtime.snapshot();
      expect(snapshot.windows[0]).toMatchObject({ noteId, bufferKind: "note" });
      expect(
        snapshot.notes.find((note) => note.noteId === noteId),
      ).toMatchObject({
        treeHidden: true,
      });
      expect(snapshot.namespaceEntries).toHaveLength(initial.length + 1);
      expect(treeVisibleNamespaceNodes(snapshot.namespaceEntries)).toEqual(
        initial,
      );
      const childId = (await runtime.createChildNote("window-1", noteId))
        .noteId;
      const withChild = runtime.snapshot();
      expect(treeVisibleNamespaceNodes(withChild.namespaceEntries)).toEqual(
        initial,
      );
      expect(withChild.allNotesRows.some((row) => row.noteId === childId)).toBe(
        true,
      );
      expect(snapshot.allNotesRows.some((row) => row.noteId === noteId)).toBe(
        true,
      );
      expect(
        (await runtime.searchWorkspace("新しいノート", "title")).results.some(
          (result) => result.kind === "title" && result.noteId === noteId,
        ),
      ).toBe(true);
      const normalized = createReplicatedWorkspaceDocument(
        runtime.workspaceDocument,
        createUuidV7(),
      );
      expect(normalized.notes.get(noteId)?.get("tree_hidden")).toBe(true);
      normalized.doc.destroy();
      await runtime.flush();
    } finally {
      runtime.destroy();
    }
    runtime = await CoreRuntime.open(persistence);
    try {
      const snapshot = runtime.snapshot();
      expect(
        snapshot.notes.find((note) => note.noteId === noteId!),
      ).toMatchObject({
        treeHidden: true,
      });
      expect(
        treeVisibleNamespaceNodes(snapshot.namespaceEntries).some(
          (entry) => entry.targetNoteId === noteId,
        ),
      ).toBe(false);
      expect(snapshot.allNotesRows.some((row) => row.noteId === noteId)).toBe(
        true,
      );
    } finally {
      runtime.destroy();
    }
  });

  it("creates the Note in an empty Window while normal root creation stays visible", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const bufferId =
        runtime.snapshot().applicationWindow.windows["window-1"]!.bufferId;
      await runtime.closeBuffer(bufferId!);
      expect(runtime.snapshot().windows[0]?.noteId).toBeNull();
      const hiddenId = (await runtime.createUnfiledNote("window-1")).noteId;
      expect(runtime.snapshot().windows[0]?.noteId).toBe(hiddenId);
      const visibleId = (await runtime.createRootNote("window-1")).noteId;
      const snapshot = runtime.snapshot();
      expect(
        treeVisibleNamespaceNodes(snapshot.namespaceEntries).some(
          (entry) => entry.targetNoteId === hiddenId,
        ),
      ).toBe(false);
      expect(
        treeVisibleNamespaceNodes(snapshot.namespaceEntries).some(
          (entry) => entry.targetNoteId === visibleId,
        ),
      ).toBe(true);
    } finally {
      runtime.destroy();
    }
  });

  it("rolls back the Note and Window change when persistence fails", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const before = runtime.snapshot();
      await expect(
        runtime.executeCommand({
          name: "note.create_unfiled",
          operationId: createUuidV7(),
          source: "ui",
          payload: {
            noteId: createUuidV7(),
            createdAt: new Date().toISOString(),
            windowId: "window-1",
            fault: "before-sql-commit",
          },
        }),
      ).rejects.toThrow("before-sql-commit");
      const after = runtime.snapshot();
      expect(after.notes).toEqual(before.notes);
      expect(after.namespaceEntries).toEqual(before.namespaceEntries);
      expect(after.windows).toEqual(before.windows);
    } finally {
      runtime.destroy();
    }
  });

  it("opens a new editable Note from the command line", async () => {
    const create = vi.spyOn(CoreRuntime.prototype, "createUnfiledNote");
    const view = render(<App />);
    try {
      const editor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          ".editor-window .memoka-editor",
        );
        if (!element) throw new Error("Editor did not mount");
        return element;
      });
      const originalNoteId = editor.dataset.noteId;
      fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
      fireEvent.keyDown(editor, {
        key: ":",
        code: "Semicolon",
        shiftKey: true,
      });
      const command = screen.getByRole("textbox", {
        name: "Memoka Command",
      });
      fireEvent.change(command, { target: { value: "new-note" } });
      fireEvent.keyDown(command, { key: "Enter" });
      const newEditor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          ".editor-window .memoka-editor",
        );
        if (!element || element.dataset.noteId === originalNoteId)
          throw new Error("New Note did not open");
        return element;
      });
      await waitFor(() => expect(document.activeElement).toBe(newEditor));
      expect(newEditor.getAttribute("contenteditable")).toBe("true");
      const runtime = create.mock.contexts[0] as CoreRuntime;
      const noteId = newEditor.dataset.noteId;
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === noteId),
      ).toMatchObject({ treeHidden: true });
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const entryId = runtime
        .snapshot()
        .namespaceEntries.find(
          (entry) => entry.targetNoteId === noteId,
        )?.entryId;
      expect(entryId).toBeDefined();
      expect(tree.querySelector(`#tree-note-${entryId}`)).toBeNull();
      await runtime.openAllNotes("window-1");
      await waitFor(() =>
        expect(
          view.container.querySelector(".memoka-editor table")?.textContent,
        ).toContain("新しいノート"),
      );
    } finally {
      view.unmount();
      create.mockRestore();
    }
  });
});
