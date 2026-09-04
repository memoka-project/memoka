import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSearchPalette } from "../app/src/components/WorkspaceSearchPalette";
import { readNotePlainText } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryWorkspaceSearchIndexPort } from "../app/src/core/workspace-search-index";
import { saveStableEditorPosition } from "../app/src/core/stable-position";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_796_200_000_000 + seed, (target) => {
      target.fill((seed * 43) & 0xff);
      return target;
    });
  };
}

describe("Memoka Workspace search palette", () => {
  it("debounces rapid query input and never submits intermediate text", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "debounce target",
    });
    const search = vi.spyOn(runtime, "searchWorkspace");
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    fireEvent.change(input, { target: { value: "d" } });
    fireEvent.change(input, { target: { value: "de" } });
    fireEvent.change(input, { target: { value: "debounce" } });
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith("debounce", "title", 20, "workspace"),
    );
    expect(search.mock.calls.map(([query]) => query)).not.toContain("d");
    expect(search.mock.calls.map(([query]) => query)).not.toContain("de");
    view.unmount();
    runtime.destroy();
  });

  it("discards a search response that resolves after a newer query", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "response target",
    });
    const base = await runtime.searchWorkspace("", "title");
    const baseResult = base.results[0]!;
    let resolveFirst!: (value: typeof base) => void;
    let resolveSecond!: (value: typeof base) => void;
    const first = new Promise<typeof base>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<typeof base>((resolve) => {
      resolveSecond = resolve;
    });
    const search = vi
      .spyOn(runtime, "searchWorkspace")
      .mockImplementation((query) => {
        if (query === "first") return first;
        if (query === "second") return second;
        return Promise.resolve(base);
      });
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    fireEvent.change(input, { target: { value: "first" } });
    await waitFor(() =>
      expect(search.mock.calls.some(([query]) => query === "first")).toBe(true),
    );
    fireEvent.change(input, { target: { value: "second" } });
    await waitFor(() =>
      expect(search.mock.calls.some(([query]) => query === "second")).toBe(
        true,
      ),
    );
    resolveSecond({
      ...base,
      results: [{ ...baseResult, resultId: "second", title: "second result" }],
    });
    await screen.findByRole("option", { name: /second result/u });
    resolveFirst({
      ...base,
      results: [{ ...baseResult, resultId: "first", title: "first result" }],
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(screen.queryByRole("option", { name: /first result/u })).toBeNull();
    expect(screen.getByRole("option", { name: /second result/u })).toBeTruthy();
    view.unmount();
    runtime.destroy();
  });

  it("keeps derived-index fallback details out of the normal search UI", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "fallback target",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    index.failQuery = new Error("injected FTS failure");
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: /fallback target/u });
    expect(screen.queryByText(/FTSを利用できないためCRDT検索/u)).toBeNull();
    expect(screen.queryByText("TITLE SEARCH")).toBeNull();
    expect(
      document.querySelector(".workspace-search-preview-heading"),
    ).toBeNull();
    expect(
      document.querySelector(".workspace-search-input-row")?.textContent,
    ).toContain("1 results");
    expect(
      document
        .querySelector(".workspace-search-overlay")
        ?.getAttribute("data-search-diagnostic"),
    ).toBe("injected FTS failure");

    view.unmount();
    runtime.destroy();
  });

  it("uses a transient NoteDoc preview without adding unopened notes to Buffers", async () => {
    const persistence = new MemoryPersistencePort();
    const idFactory = deterministicIds();
    const first = await CoreRuntime.open(persistence, {
      idFactory,
      initialTitle: "source",
    });
    const sourceNoteId = first.noteId;
    const target = await first.createNoteAtEnd("window-1", "preview target");
    await first.executeCommand({
      name: "note.replace_text",
      operationId: "op-transient-preview",
      source: "ui",
      payload: { noteId: target.noteId, text: "preview body" },
    });
    await first.openNote("window-1", sourceNoteId);
    await first.flush();
    first.destroy();

    const runtime = await CoreRuntime.open(persistence, { idFactory });
    expect(runtime.snapshot().loadedNoteIds).toEqual([sourceNoteId]);
    const preview = await runtime.loadNotePreview(target.noteId);
    expect(readNotePlainText(preview.document)).toBe("preview body");
    expect(runtime.snapshot().loadedNoteIds).toEqual([sourceNoteId]);
    preview.release();
    runtime.destroy();
  });

  it("keeps a loaded NoteDoc UndoManager alive after its read-only preview closes", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "previewed live note",
    });
    const editorRoot = document.createElement("div");
    document.body.append(editorRoot);
    const source = runtime.editorForTesting("window-1", editorRoot, {
      directBodyOnly: false,
    });
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector(".workspace-search-preview-document"),
      ).not.toBeNull(),
    );
    view.unmount();

    let paragraphPosition = -1;
    source.editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") {
        paragraphPosition = position + 1;
        return false;
      }
      return paragraphPosition < 0;
    });
    runtime.noteDocument.undoManager.clear();
    source.editor.commands.setTextSelection(paragraphPosition);
    source.editor.commands.insertContent("undo remains available");
    expect(source.editor.commands.undo()).toBe(true);
    expect(source.editor.state.doc.textContent).not.toContain(
      "undo remains available",
    );

    source.adapter.destroy();
    runtime.destroy();
    editorRoot.remove();
  });

  it("filters incrementally and opens a result without stealing IME Enter", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-04T00:00:00.000Z",
      initialTitle: "source",
    });
    await addSecondWindow(runtime);
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-1", "日本語 target");
    await runtime.openNote("window-1", sourceNoteId);

    const root = document.createElement("div");
    document.body.append(root);
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    source.editor.commands.setTextSelection(1);
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const onClose = vi.fn();
    const applyDestination = vi.fn(() => "jump:search:changed");
    const restoreFocus = vi.fn();
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin,
          applyDestination,
          restoreFocus,
        }}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    await screen.findByRole("option", { name: /日本語 target/u });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "日本語" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(runtime.windows.get("window-1")?.noteId).toBe(sourceNoteId);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(runtime.windows.get("window-1")?.noteId).toBe(target.noteId);
    expect(runtime.windows.get("window-2")?.noteId).toBe(sourceNoteId);
    expect(applyDestination).not.toHaveBeenCalled();

    view.unmount();
    source.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("closes with Escape and restores focus to the source Editor", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
    });
    const root = document.createElement("div");
    document.body.append(root);
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin,
          applyDestination: () => null,
          restoreFocus,
        }}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));

    view.unmount();
    source.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("starts on the best bottom result, moves visually, and closes with Ctrl-c", async () => {
    let now = "2026-08-04T00:00:00.000Z";
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => now,
      initialTitle: "oldest",
    });
    now = "2026-08-04T00:01:00.000Z";
    await runtime.createNoteAtEnd("window-1", "middle");
    now = "2026-08-04T00:02:00.000Z";
    await runtime.createNoteAtEnd("window-1", "newest");
    const root = document.createElement("div");
    document.body.append(root);
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin,
          applyDestination: () => null,
          restoreFocus,
        }}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    await waitFor(() =>
      expect(
        screen.getAllByRole("option").at(-1)?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
    let options = screen.getAllByRole("option");
    expect(options.at(-1)?.getAttribute("aria-selected")).toBe("true");
    expect(options.at(-1)?.textContent).toContain("newest");

    const scrollIntoView = vi.fn();
    Object.defineProperty(options.at(-2)!, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    options = screen.getAllByRole("option");
    expect(options.at(-2)?.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    fireEvent.mouseEnter(options[0]);
    expect(options.at(-2)?.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(options[0]);
    fireEvent.click(options[0]);
    options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));

    view.unmount();
    source.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("shows body logical-line context and highlights the selected preview match", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-04T00:00:00.000Z",
      initialTitle: "preview note",
    });
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-preview-search",
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "日本語の文章を before highlighted needle after 快適に編集する",
      },
    });
    const root = document.createElement("div");
    document.body.append(root);
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "body",
          target: "workspace",
          origin,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    await screen.findByText("0 results");
    expect(
      screen.queryByText("本文を検索する文字を入力してください"),
    ).toBeNull();
    expect(
      screen.queryByText("プレビューするノートを選択してください"),
    ).toBeNull();
    fireEvent.change(input, { target: { value: "needle" } });
    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("L1");
    expect(
      option.querySelector(".workspace-search-note-title")?.nextElementSibling
        ?.textContent,
    ).toBe("L1");
    expect(option.querySelector(".workspace-search-match")?.textContent).toBe(
      "needle",
    );
    await waitFor(() =>
      expect(
        document.querySelector(".workspace-search-preview-match")?.textContent,
      ).toBe("needle"),
    );
    await waitFor(() =>
      expect(
        document.querySelector(
          ".workspace-search-preview-document .memoka-budoux-textblock wbr[data-memoka-budoux-break]",
        ),
      ).not.toBeNull(),
    );

    view.unmount();
    source.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("reuses one structured preview Editor between matches in the same Note", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "preview reuse",
    });
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-preview-reuse",
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "first needle\nsecond needle",
      },
    });
    const loadPreview = vi.spyOn(runtime, "loadNotePreview");
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "body",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await waitFor(() =>
      expect(
        document.querySelector(".workspace-search-preview-document"),
      ).not.toBeNull(),
    );
    expect(loadPreview).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(
        document.querySelector(".workspace-search-preview-match"),
      ).not.toBeNull(),
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
    expect(loadPreview).toHaveBeenCalledTimes(1);
    view.unmount();
    runtime.destroy();
  });

  it("keeps the red Trash palette open while r restores the selected result", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "trashed target",
    });
    const noteId = runtime.noteId;
    await runtime.moveNoteToTrash(noteId);
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "trash",
          origin: null,
          applyDestination: vi.fn(() => null),
          restoreFocus,
        }}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ワークスペースを検索",
    });
    await screen.findByRole("option", { name: /trashed target/u });
    const palette = screen.getByLabelText("ゴミ箱検索");
    expect(palette.getAttribute("data-search-target")).toBe("trash");

    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(restoreFocus).not.toHaveBeenCalled();
    expect(
      runtime.snapshot().notes.find((note) => note.noteId === noteId)
        ?.deletedAt,
    ).toBeDefined();
    expect(document.activeElement).toBe(input);

    expect(fireEvent.keyDown(input, { key: "r", code: "KeyR" })).toBe(false);
    await waitFor(() =>
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === noteId)
          ?.deletedAt,
      ).toBeUndefined(),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: /trashed target/u }),
      ).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(restoreFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));

    view.unmount();
    runtime.destroy();
  });

  it("renders title results as note title plus a smaller hierarchy line", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "workspace root note",
    });
    await runtime.createNoteAfter(
      "window-1",
      runtime.noteId,
      "nested search note",
    );
    const view = render(
      <WorkspaceSearchPalette
        runtime={runtime}
        session={{
          windowId: "window-1",
          scope: "title",
          target: "workspace",
          origin: null,
          applyDestination: () => null,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const rootResult = screen
      .getByText("workspace root note", {
        selector: ".workspace-search-note-title",
      })
      .closest('[role="option"]');
    const nestedResult = screen
      .getByText("nested search note", {
        selector: ".workspace-search-note-title",
      })
      .closest('[role="option"]');
    expect(rootResult).not.toBeNull();
    expect(nestedResult).not.toBeNull();
    if (!rootResult || !nestedResult) {
      throw new Error("title search result rows were not rendered");
    }
    expect(
      rootResult.querySelector(".workspace-search-note-title")?.textContent,
    ).toBe("workspace root note");
    expect(
      rootResult.querySelector(".workspace-search-title-hierarchy")
        ?.textContent,
    ).toBe("/");
    expect(
      nestedResult.querySelector(".workspace-search-title-hierarchy")
        ?.textContent,
    ).toBe("/");

    view.unmount();
    runtime.destroy();
  });
});
