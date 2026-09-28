import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { WorkspaceTree } from "../app/src/components/WorkspaceTree";
import {
  ALL_NOTES_TREE_ENTRY_ID,
  activeTab,
} from "../app/src/core/application-state";
import { createReplicatedWorkspaceDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  activeNoteContextNodes,
  treeVisibleNamespaceNodes,
} from "../app/src/core/namespace";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

describe("Note Tree visibility", () => {
  it("keeps Tree context operations inside the active Note subtree", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const ancestorId = runtime.noteId;
      const activeId = (await runtime.createChildNote("window-1", ancestorId))
        .noteId;
      const childId = (await runtime.createChildNote("window-1", activeId))
        .noteId;
      const grandchildId = (await runtime.createChildNote("window-1", childId))
        .noteId;
      await runtime.openNote("window-1", activeId);
      const entryId = (noteId: string) =>
        runtime.snapshot().notes.find((note) => note.noteId === noteId)!
          .entryId!;
      const ancestorEntryId = entryId(ancestorId);
      const activeEntryId = entryId(activeId);
      const childEntryId = entryId(childId);
      const grandchildEntryId = entryId(grandchildId);
      const props = {
        runtime,
        targetWindowId: "window-1",
        focusRequest: 1,
        onOpenNote: vi.fn(async () => {}),
        onRequestEditorFocus: vi.fn(),
        onOpenTrash: vi.fn(),
        onClose: vi.fn(),
        onFocus: vi.fn(),
      };
      const create = vi.spyOn(runtime, "createNoteAtEntry");
      const move = vi.spyOn(runtime, "moveNamespaceEntry");
      const trash = vi.spyOn(runtime, "trashNamespaceEntry");
      await runtime.updateSidebar({
        side: "left",
        tree: { selectedEntryId: ALL_NOTES_TREE_ENTRY_ID },
      });
      const view = render(
        <WorkspaceTree {...props} snapshot={runtime.snapshot()} />,
      );
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const key = (value: string, code: string, shiftKey = false) =>
        fireEvent.keyDown(tree, { key: value, code, shiftKey });
      const outdent = () => {
        key("<", "Comma", true);
        key("<", "Comma", true);
      };
      const selectContext = async (selectedEntryId: string) => {
        await runtime.updateSidebar({
          side: "left",
          tree: { selectedEntryId, selectedRegion: "context" },
        });
        view.rerender(
          <WorkspaceTree {...props} snapshot={runtime.snapshot()} />,
        );
        expect(tree.getAttribute("aria-activedescendant")).toBe(
          `tree-context-${selectedEntryId}`,
        );
      };

      key("A", "KeyA", true);
      expect(create).not.toHaveBeenCalled();
      await selectContext(ancestorEntryId);
      key("a", "KeyA");
      key("c", "KeyC");
      key("A", "KeyA", true);
      key("D", "KeyD", true);
      expect(create).not.toHaveBeenCalled();
      expect(trash).not.toHaveBeenCalled();

      await selectContext(activeEntryId);
      key("a", "KeyA");
      outdent();
      expect(create).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();

      await selectContext(childEntryId);
      outdent();
      expect(move).not.toHaveBeenCalled();

      await selectContext(grandchildEntryId);
      key("2", "Digit2");
      outdent();
      await waitFor(() =>
        expect(
          runtime
            .snapshot()
            .namespaceEntries.find(
              (entry) => entry.entryId === grandchildEntryId,
            )?.parentNoteId,
        ).toBe(activeEntryId),
      );
      expect(move).toHaveBeenCalledTimes(1);
      expect(trash).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      runtime.destroy();
    }
  });

  it("omits separators when their following Tree section has no entries", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const noteId = runtime.noteId;
    const props = {
      runtime,
      targetWindowId: "window-1",
      focusRequest: 1,
      onOpenNote: vi.fn(async () => {}),
      onRequestEditorFocus: vi.fn(),
      onOpenTrash: vi.fn(),
      onClose: vi.fn(),
      onFocus: vi.fn(),
    };
    try {
      const view = render(
        <WorkspaceTree {...props} snapshot={runtime.snapshot()} />,
      );
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const separators = () => tree.querySelectorAll(".note-tree-separator");
      expect(separators()).toHaveLength(2);

      await runtime.setActiveNoteTreeVisibility(noteId, false);
      view.rerender(<WorkspaceTree {...props} snapshot={runtime.snapshot()} />);
      expect(separators()).toHaveLength(1);

      await runtime.openAllNotes("window-1");
      view.rerender(<WorkspaceTree {...props} snapshot={runtime.snapshot()} />);
      expect(separators()).toHaveLength(0);
      expect(
        tree.querySelector<HTMLElement>(".note-tree-spacer")?.style.height,
      ).toBe("30px");

      await runtime.setActiveNoteTreeVisibility(noteId, true);
      view.rerender(<WorkspaceTree {...props} snapshot={runtime.snapshot()} />);
      expect(separators()).toHaveLength(1);
      view.unmount();
    } finally {
      runtime.destroy();
    }
  });

  it("accepts :note-tree from the editor and reports status without a Note", async () => {
    const change = vi.spyOn(
      CoreRuntime.prototype,
      "setActiveNoteTreeVisibility",
    );
    const view = render(<App />);
    const execute = (editor: HTMLElement, value: string) => {
      fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
      fireEvent.keyDown(editor, {
        key: ":",
        code: "Semicolon",
        shiftKey: true,
      });
      const input = screen.getByRole("textbox", { name: "Memoka Command" });
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
    };
    try {
      const editor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          ".editor-window .memoka-editor",
        );
        if (!element) throw new Error("Editor did not mount");
        return element;
      });
      execute(editor, "note-tree hide");
      await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
      const runtime = change.mock.contexts[0] as CoreRuntime;
      const entryId = runtime
        .snapshot()
        .notes.find((note) => note.noteId === editor.dataset.noteId)!.entryId!;
      await waitFor(() =>
        expect(
          view.container.querySelector(`#tree-note-${entryId}`),
        ).toBeNull(),
      );
      expect(
        view.container.querySelector(`#tree-context-${entryId}`),
      ).not.toBeNull();
      execute(editor, "note-tree");
      await waitFor(() =>
        expect(
          view.container.querySelector(".application-commandline--idle")
            ?.textContent,
        ).toContain("Treeルートに非表示"),
      );
      execute(editor, "note-tree show");
      await waitFor(() =>
        expect(
          view.container.querySelector(`#tree-note-${entryId}`),
        ).not.toBeNull(),
      );
      await runtime.openAllNotes("window-1");
      const allNotesEditor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          ".editor-window .memoka-editor",
        );
        if (!element || element.dataset.noteId === editor.dataset.noteId)
          throw new Error("All Notes did not open");
        return element;
      });
      expect(
        view.container.querySelectorAll(".note-tree-separator"),
      ).toHaveLength(1);
      execute(allNotesEditor, "note-tree hide");
      await waitFor(() =>
        expect(
          view.container.querySelector(".application-commandline--idle")
            ?.textContent,
        ).toContain("ノートを開いてください"),
      );
    } finally {
      view.unmount();
      change.mockRestore();
    }
  });

  it("changes only the requested marker and preserves it across restart", async () => {
    const persistence = new MemoryPersistencePort();
    let runtime = await CoreRuntime.open(persistence);
    const parentId = runtime.noteId;
    let childId: string;
    try {
      childId = (await runtime.createChildNote("window-1", parentId)).noteId;
      const before = runtime.snapshot();
      const parentUpdatedAt = before.notes.find(
        (note) => note.noteId === parentId,
      )!.updatedAt;
      expect(
        await runtime.setActiveNoteTreeVisibility(parentId, false),
      ).toEqual({
        noteId: parentId,
        changed: true,
      });
      expect(
        await runtime.setActiveNoteTreeVisibility(parentId, false),
      ).toEqual({
        noteId: parentId,
        changed: false,
      });
      expect(
        treeVisibleNamespaceNodes(runtime.snapshot().namespaceEntries),
      ).toHaveLength(0);
      expect(
        new Set(
          activeNoteContextNodes(
            runtime.snapshot().namespaceEntries,
            childId,
          ).map((entry) => entry.targetNoteId),
        ),
      ).toEqual(new Set([parentId, childId]));
      await runtime.setActiveNoteTreeVisibility(childId, false);
      await runtime.setActiveNoteTreeVisibility(childId, true);
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === childId),
      ).not.toHaveProperty("treeHidden");
      const normalized = createReplicatedWorkspaceDocument(
        runtime.workspaceDocument,
        createUuidV7(),
      );
      expect(normalized.notes.get(parentId)?.get("tree_hidden")).toBe(true);
      normalized.doc.destroy();
      expect(
        treeVisibleNamespaceNodes(runtime.snapshot().namespaceEntries),
      ).toHaveLength(0);
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === parentId)
          ?.updatedAt,
      ).toBe(parentUpdatedAt);
      await runtime.flush();
    } finally {
      runtime.destroy();
    }
    runtime = await CoreRuntime.open(persistence);
    try {
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === parentId),
      ).toMatchObject({ treeHidden: true });
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === childId!),
      ).not.toHaveProperty("treeHidden");
      await runtime.setActiveNoteTreeVisibility(parentId, true);
      expect(
        new Set(
          treeVisibleNamespaceNodes(runtime.snapshot().namespaceEntries).map(
            (entry) => entry.targetNoteId,
          ),
        ),
      ).toEqual(new Set([parentId, childId!]));
    } finally {
      runtime.destroy();
    }
  });

  it("rolls back a failed visibility change", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const before = runtime.snapshot();
      await expect(
        runtime.executeCommand({
          name: "note.set_tree_visibility",
          operationId: createUuidV7(),
          source: "ui",
          payload: {
            noteId: runtime.noteId,
            visible: false,
            fault: "before-sql-commit",
          },
        }),
      ).rejects.toThrow("before-sql-commit");
      expect(runtime.snapshot().notes).toEqual(before.notes);
      expect(runtime.snapshot().namespaceEntries).toEqual(
        before.namespaceEntries,
      );
    } finally {
      runtime.destroy();
    }
  });

  it("shows both occurrences, skips separators, and keeps folds independent", async () => {
    const persistence = new MemoryPersistencePort();
    let runtime = await CoreRuntime.open(persistence);
    const parentId = runtime.noteId;
    let childId: string;
    try {
      childId = (await runtime.createChildNote("window-1", parentId)).noteId;
      const parentEntryId = runtime
        .snapshot()
        .notes.find((note) => note.noteId === parentId)!.entryId!;
      const childEntryId = runtime
        .snapshot()
        .notes.find((note) => note.noteId === childId)!.entryId!;
      const view = render(
        <WorkspaceTree
          runtime={runtime}
          snapshot={runtime.snapshot()}
          targetWindowId="window-1"
          focusRequest={1}
          onOpenNote={vi.fn(async () => {})}
          onRequestEditorFocus={vi.fn()}
          onOpenTrash={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />,
      );
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const separators = tree.querySelectorAll<HTMLElement>(
        ".note-tree-separator",
      );
      expect(separators).toHaveLength(2);
      expect(
        [...separators].map((separator) => separator.style.height),
      ).toEqual(["15px", "15px"]);
      expect(separators[0]!.style.top).toBe("30px");
      expect(separators[1]!.style.top).toBe("105px");
      expect(
        tree.querySelector(`#tree-context-${parentEntryId}`),
      ).not.toBeNull();
      expect(tree.querySelector(`#tree-note-${parentEntryId}`)).not.toBeNull();
      expect(
        tree.querySelector(`#tree-context-${childEntryId}`),
      ).not.toBeNull();
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      expect(tree.getAttribute("aria-activedescendant")).toBe(
        `tree-context-${parentEntryId}`,
      );
      const contextParent = tree.querySelector<HTMLElement>(
        `#tree-context-${parentEntryId}`,
      )!;
      fireEvent.click(contextParent.querySelector("button")!);
      expect(tree.querySelector(`#tree-context-${childEntryId}`)).toBeNull();
      expect(tree.querySelector(`#tree-note-${childEntryId}`)).not.toBeNull();
      expect(contextParent.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(tree.querySelector(`#tree-note-${parentEntryId}`)!);
      await waitFor(() =>
        expect(
          activeTab(runtime.snapshot().applicationWindow).leftSidebar.tree,
        ).toMatchObject({
          selectedEntryId: parentEntryId,
          selectedRegion: "root",
          contextCollapsedEntryIds: [parentEntryId],
          collapsedEntryIds: [],
        }),
      );
      fireEvent.click(contextParent);
      await waitFor(() =>
        expect(
          activeTab(runtime.snapshot().applicationWindow).leftSidebar.tree,
        ).toMatchObject({
          selectedEntryId: parentEntryId,
          selectedRegion: "context",
        }),
      );
      view.unmount();
      await runtime.flush();
    } finally {
      runtime.destroy();
    }
    runtime = await CoreRuntime.open(persistence);
    try {
      const treeState = activeTab(runtime.snapshot().applicationWindow)
        .leftSidebar.tree;
      expect(treeState.selectedRegion).toBe("context");
      expect(treeState.contextCollapsedEntryIds).toHaveLength(1);
    } finally {
      runtime.destroy();
    }
  });
});
