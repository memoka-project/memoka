import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/src/App";
import { ALL_NOTES_DOCUMENT_ID, allNotesRows } from "../app/src/core/all-notes";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { WorkspaceTree } from "../app/src/components/WorkspaceTree";
import { vi } from "vitest";
import { addSecondWindow } from "./helpers/runtime";

describe("All Notes", () => {
  it("navigates from the fixed item to the first Note", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
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
      expect(tree.getAttribute("aria-activedescendant")).toBe(
        "tree-note-utility:all-notes",
      );
      const originalEntries = runtime.snapshot().namespaceEntries;
      for (const key of ["c", "a", "D", "K", "J"]) {
        fireEvent.keyDown(tree, { key });
      }
      expect(runtime.snapshot().namespaceEntries).toEqual(originalEntries);
      expect(tree.getAttribute("aria-activedescendant")).toBe(
        "tree-note-utility:all-notes",
      );
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      expect(tree.getAttribute("aria-activedescendant")).toBe(
        `tree-note-${runtime.snapshot().namespaceEntries[0]?.entryId}`,
      );
      view.unmount();
    } finally {
      runtime.destroy();
    }
  });
  it("derives live Note rows in updated order", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const initial = runtime.snapshot().notes.find((note) => !note.deletedAt)!;
      await runtime.createRootNote("window-1");
      const next = runtime
        .snapshot()
        .notes.find((note) => note.noteId !== initial.noteId)!;
      await runtime.renameNote(next.noteId, "Second");
      const rows = allNotesRows(runtime.snapshot().notes);
      expect(rows.map((row) => row.noteId)).toEqual([
        next.noteId,
        initial.noteId,
      ]);
      expect(rows[0]?.title).toBe("Second");
      await runtime.openAllNotes("window-1");
      const snapshot = runtime.snapshot();
      expect(snapshot.windows[0]?.bufferKind).toBe("all-notes");
      expect(snapshot.allNotesRows.map((row) => row.noteId)).toEqual([
        next.noteId,
        initial.noteId,
      ]);
    } finally {
      runtime.destroy();
    }
  });

  it("matches the special title in Leader-f and restores its Window after restart", async () => {
    const persistence = new MemoryPersistencePort();
    let runtime = await CoreRuntime.open(persistence);
    try {
      const noteId = runtime.snapshot().allNotesRows[0]!.noteId;
      expect(
        (await runtime.searchWorkspace("すべてのノート", "title")).results[0],
      ).toMatchObject({ kind: "all-notes", title: "すべてのノート" });
      expect(
        (await runtime.searchWorkspace("新しい", "title")).results.some(
          (result) => result.kind === "all-notes",
        ),
      ).toBe(false);
      expect(
        (await runtime.searchWorkspace("", "title")).results.some(
          (result) => result.kind === "all-notes",
        ),
      ).toBe(false);
      await runtime.openAllNotes("window-1", {
        noteId,
        column: "updatedAt",
        offset: 0,
      });
      await runtime.flush();
    } finally {
      runtime.destroy();
    }
    runtime = await CoreRuntime.open(persistence);
    try {
      expect(runtime.snapshot().windows[0]).toMatchObject({
        bufferKind: "all-notes",
        allNotesCaret: { column: "updatedAt" },
      });
    } finally {
      runtime.destroy();
    }
  });

  it("updates the Table after a rename while keeping the selected Note", async () => {
    let tick = 0;
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
    let adapter: ReturnType<CoreRuntime["attachEditor"]> | null = null;
    let noteAdapter: ReturnType<CoreRuntime["attachEditor"]> | null = null;
    try {
      const firstId = runtime.snapshot().allNotesRows[0]!.noteId;
      await runtime.createRootNote("window-1");
      const secondId = runtime
        .snapshot()
        .allNotesRows.find((row) => row.noteId !== firstId)!.noteId;
      await addSecondWindow(runtime);
      noteAdapter = runtime.attachEditor(
        "window-2",
        document.createElement("div"),
      );
      await runtime.openAllNotes("window-1");
      adapter = runtime.attachEditor("window-1", document.createElement("div"));
      runtime.restoreAllNotesCaret("window-1", adapter);
      const beforeMove = adapter.editor.state.selection.head;
      fireEvent.keyDown(adapter.editor.view.dom, { key: "j", code: "KeyJ" });
      expect(adapter.editor.state.selection.head).not.toBe(beforeMove);
      const originalText = adapter.editor.state.doc.textContent;
      expect(adapter.editor.commands.insertContent("forbidden")).toBe(true);
      expect(adapter.editor.state.doc.textContent).toBe(originalText);
      let linkPosition: number | null = null;
      adapter.editor.state.doc.descendants((node, position) => {
        if (
          node.type.name === "internalSectionLink" &&
          node.attrs.targetSectionId === firstId
        ) {
          linkPosition = position;
          return false;
        }
        return linkPosition === null;
      });
      expect(linkPosition).not.toBeNull();
      adapter.editor.commands.setTextSelection(linkPosition!);
      await runtime.renameNote(firstId, "Renamed first");
      runtime.snapshot();
      const selected = adapter.editor.state.doc.resolve(
        adapter.editor.state.selection.head,
      );
      let rowText = "";
      for (let depth = selected.depth; depth > 0; depth -= 1) {
        if (selected.node(depth).type.name === "tableRow") {
          rowText = selected.node(depth).textContent;
          break;
        }
      }
      expect(rowText).toContain("Renamed first");
      expect(runtime.snapshot().allNotesRows[0]?.noteId).toBe(firstId);
      let paragraphPosition = -1;
      noteAdapter.editor.state.doc.descendants((node, position) => {
        if (paragraphPosition < 0 && node.type.name === "paragraph") {
          paragraphPosition = position + 1;
        }
      });
      expect(paragraphPosition).toBeGreaterThan(0);
      noteAdapter.editor.commands.insertContentAt(
        paragraphPosition,
        "Updated body",
      );
      await runtime.flush();
      expect(runtime.snapshot().allNotesRows[0]?.noteId).toBe(secondId);
      const movedSelection = adapter.editor.state.doc.resolve(
        adapter.editor.state.selection.head,
      );
      expect(
        Array.from({ length: movedSelection.depth }, (_, index) =>
          movedSelection.node(index + 1),
        ).find((node) => node.type.name === "tableRow")?.textContent,
      ).toContain("Renamed first");
    } finally {
      adapter?.destroy();
      noteAdapter?.destroy();
      runtime.destroy();
    }
  });

  it("opens a read-only Table from the fixed Tree item", async () => {
    const attachEditor = vi.spyOn(CoreRuntime.prototype, "attachEditor");
    const view = render(<App />);
    const initialEditor = await waitFor(() => {
      const element =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!element) throw new Error("Initial editor did not mount");
      return element;
    });
    const initialNoteId = initialEditor.dataset.noteId!;
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const allNotes = tree.querySelector<HTMLElement>(
      "#tree-note-utility\\:all-notes",
    )!;
    expect(allNotes).not.toBeNull();
    expect(tree.querySelector('[role="treeitem"]')).toBe(allNotes);
    expect(allNotes.querySelector('[data-tree-icon="sheet"]')).not.toBeNull();
    fireEvent.click(allNotes);
    fireEvent.click(allNotes);
    const editor = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        `.memoka-editor[data-note-id="${ALL_NOTES_DOCUMENT_ID}"]`,
      );
      if (!element) throw new Error("All Notes editor did not mount");
      return element;
    });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const adapter = attachEditor.mock.results.at(-1)?.value as
      ReturnType<CoreRuntime["attachEditor"]> | undefined;
    if (!adapter) throw new Error("All Notes adapter did not attach");
    const beforeMove = adapter.editor.state.selection.head;
    fireEvent.keyDown(editor, { key: "k", code: "KeyK" });
    expect(adapter.editor.state.selection.head).not.toBe(beforeMove);
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.querySelector("table")?.textContent).toContain("ノート名");
    expect(editor.querySelector("table")?.textContent).toContain(
      "最終更新日時",
    );
    expect(editor.querySelector("table")?.textContent).toContain(
      "新しいノート",
    );
    expect(
      editor.querySelector("table tr:nth-child(2) td:last-child")?.textContent,
    ).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/u);
    expect(
      view.container.querySelector(".window-statusline")?.textContent,
    ).toContain("READ ONLY");
    fireEvent.keyDown(editor, { key: "/", code: "Slash" });
    const searchInput = await screen.findByRole("textbox", {
      name: "ノート内を検索",
    });
    fireEvent.change(searchInput, { target: { value: "新しいノート" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() =>
      expect(view.container.textContent).toContain("/新しいノート · 1/1"),
    );
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const before = editor.querySelector("table")?.textContent;
    fireEvent.keyDown(editor, { key: "i", code: "KeyI" });
    fireEvent.paste(editor, {
      clipboardData: {
        getData: () => "edited",
        files: [],
        items: [],
        types: ["text/plain"],
      },
    });
    expect(editor.querySelector("table")?.textContent).toBe(before);
    expect(editor.getAttribute("contenteditable")).toBe("false");
    const link = editor.querySelector<HTMLElement>(
      `[data-internal-section-id="${initialNoteId}"]`,
    )!;
    expect(link).not.toBeNull();
    fireEvent.mouseDown(link);
    fireEvent.click(link);
    fireEvent.keyDown(editor, { key: "g", code: "KeyG" });
    fireEvent.keyDown(editor, { key: "f", code: "KeyF" });
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(".memoka-editor")?.dataset
          .noteId,
      ).toBe(initialNoteId),
    );
    const noteEditor =
      view.container.querySelector<HTMLElement>(".memoka-editor")!;
    fireEvent.keyDown(noteEditor, { key: "o", code: "KeyO", ctrlKey: true });
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(".memoka-editor")?.dataset
          .noteId,
      ).toBe(ALL_NOTES_DOCUMENT_ID),
    );
    view.unmount();
  });

  it("opens the special Leader-f result", async () => {
    const view = render(<App />);
    const editor = await waitFor(() => {
      const mounted =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!mounted) throw new Error("Initial editor did not mount");
      return mounted;
    });
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, { key: " ", code: "Space" });
    fireEvent.keyDown(editor, { key: "f", code: "KeyF" });
    const search = await screen.findByRole("combobox", {
      name: "ワークスペースを検索",
    });
    fireEvent.change(search, { target: { value: "すべてのノート" } });
    await screen.findByRole("option", { name: /すべてのノート/ });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(".memoka-editor")?.dataset
          .noteId,
      ).toBe(ALL_NOTES_DOCUMENT_ID),
    );
    view.unmount();
  });
});
