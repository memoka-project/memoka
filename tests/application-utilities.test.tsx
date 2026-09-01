import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { App } from "../app/src/App";
import {
  ApplicationCommandLine,
  type ApplicationCommandLineSession,
} from "../app/src/components/ApplicationCommandLine";
import {
  ApplicationNoteSearch,
  type ApplicationNoteSearchSession,
} from "../app/src/components/ApplicationNoteSearch";
import { WorkspaceOutline } from "../app/src/components/WorkspaceOutline";
import { createNoteDocument } from "../app/src/core/documents";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import { CoreRuntime } from "../app/src/core/runtime";
import type { NoteSearchOrigin } from "../app/src/core/note-search";
import { APPLICATION_THEME_DATA_ATTRIBUTE } from "../app/src/platform/application-theme";

function createNoteSearchOrigin(): NoteSearchOrigin {
  return {
    stable: {
      noteId: "01900000-0000-7000-8000-000000000100",
      sectionId: "01900000-0000-7000-8000-000000000100",
      blockId: "01900000-0000-7000-8000-000000000101",
      offset: 0,
      before: "",
      after: "",
      relative: new Uint8Array([1]),
    },
    location: {
      sectionId: "01900000-0000-7000-8000-000000000100",
      blockId: "01900000-0000-7000-8000-000000000101",
      offset: 0,
    },
  };
}

function createOutlineNote(
  noteId: string,
  sections: readonly {
    sectionId: string;
    title: string;
    parentSectionId?: string;
  }[],
) {
  const note = createNoteDocument(noteId, [], "Root");
  const byId = new Map([[noteId, note.rootSection]]);
  note.doc.transact(() => {
    for (const input of sections) {
      const section = createSectionXml(input.sectionId, input.title);
      insertChildSection(
        byId.get(input.parentSectionId ?? noteId) ?? note.rootSection,
        section,
      );
      byId.set(input.sectionId, section);
    }
  });
  return note;
}

function enterNormal(editor: HTMLElement): void {
  editor.focus();
  fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
}

function openCommandLine(editor: HTMLElement): HTMLInputElement {
  enterNormal(editor);
  fireEvent.keyDown(editor, {
    key: ":",
    code: "Semicolon",
    shiftKey: true,
  });
  return screen.getByRole("textbox", {
    name: "Memoka Command",
  }) as HTMLInputElement;
}

describe("Memoka Application utilities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("previews, cancels, and persists application color themes", async () => {
    const saveTheme = vi.fn(async () => {});
    const view = render(
      <App
        initialTheme="nightfox"
        applicationConfig={{ saveTheme }}
        showDebugLine={false}
      />,
    );
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted = view.container.querySelector<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });

    let command = openCommandLine(editor);
    fireEvent.change(command, { target: { value: "colorscheme" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const picker = await screen.findByRole("combobox", {
      name: "カラーテーマを検索",
    });
    fireEvent.keyDown(picker, { key: "ArrowUp" });
    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(APPLICATION_THEME_DATA_ATTRIBUTE),
      ).toBe("dayfox"),
    );
    fireEvent.keyDown(picker, { key: "Escape" });
    await waitFor(() =>
      expect(
        document.documentElement.getAttribute(APPLICATION_THEME_DATA_ATTRIBUTE),
      ).toBe("nightfox"),
    );
    expect(saveTheme).not.toHaveBeenCalled();

    command = openCommandLine(editor);
    fireEvent.change(command, { target: { value: "colo duskfox" } });
    fireEvent.keyDown(command, { key: "Enter" });
    await waitFor(() => expect(saveTheme).toHaveBeenCalledWith("duskfox"));
    expect(
      document.documentElement.getAttribute(APPLICATION_THEME_DATA_ATTRIBUTE),
    ).toBe("duskfox");
    view.unmount();
  });

  it("closes a focused Sidebar with Ctrl-w c and keeps only the current Window with Ctrl-w o", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const firstEditor = await waitFor(() => {
      const editor = view.container.querySelector<HTMLElement>(
        '.editor-window[data-window-id="window-1"] .memoka-editor',
      );
      if (!editor) throw new Error("Initial Editor did not mount");
      return editor;
    });

    tree.focus();
    fireEvent.keyDown(tree, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "o", code: "KeyO" });
    expect(document.activeElement).toBe(tree);
    expect(view.container.querySelectorAll(".editor-window")).toHaveLength(1);

    fireEvent.keyDown(tree, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "c", code: "KeyC" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(firstEditor));

    enterNormal(firstEditor);
    fireEvent.keyDown(firstEditor, { key: ",", code: "Comma" });
    fireEvent.keyDown(firstEditor, { key: "t", code: "KeyT" });
    tree = await screen.findByRole("tree", { name: "ノートツリー" });
    await waitFor(() => expect(document.activeElement).toBe(tree));
    fireEvent.keyDown(tree, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "l", code: "KeyL" });
    await waitFor(() => expect(document.activeElement).toBe(firstEditor));

    fireEvent.keyDown(firstEditor, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(firstEditor, { key: "v", code: "KeyV" });
    const secondEditor = await waitFor(() => {
      const editors = view.container.querySelectorAll<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (editors.length !== 2) throw new Error("Vertical split did not mount");
      return editors[1];
    });
    await waitFor(() => expect(document.activeElement).toBe(secondEditor));
    fireEvent.keyDown(secondEditor, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(secondEditor, { key: "s", code: "KeyS" });
    const onlyEditor = await waitFor(() => {
      const editors = view.container.querySelectorAll<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (editors.length !== 3) throw new Error("Nested split did not mount");
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !editors[2].isSameNode(active)) {
        throw new Error("Nested split Editor is not focused");
      }
      return editors[2];
    });
    const onlyWindowId =
      onlyEditor.closest<HTMLElement>(".editor-window")?.dataset.windowId;

    fireEvent.keyDown(onlyEditor, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(onlyEditor, { key: "o", code: "KeyO" });
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(1),
    );
    const remainingWindow =
      view.container.querySelector<HTMLElement>(".editor-window");
    expect(remainingWindow?.dataset.windowId).toBe(onlyWindowId);
    expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        remainingWindow?.querySelector(".memoka-editor"),
      ),
    );
    view.unmount();
  });

  it("renders typed Ctrl-w splits recursively and focuses or closes a Window", async () => {
    const view = render(<App />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    const firstEditor = await waitFor(() => {
      const editor = view.container.querySelector<HTMLElement>(
        '.editor-window[data-window-id="window-1"] .memoka-editor',
      );
      if (!editor) throw new Error("Initial Editor did not mount");
      return editor;
    });
    expect(view.container.querySelectorAll(".editor-window")).toHaveLength(1);

    enterNormal(firstEditor);
    fireEvent.keyDown(firstEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    expect(
      firstEditor.closest<HTMLElement>(".editor-window")?.dataset.vimAction,
    ).toBe("pending:window");
    fireEvent.keyDown(firstEditor, { key: "v", code: "KeyV" });

    const secondEditor = await waitFor(() => {
      const editors = view.container.querySelectorAll<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (editors.length !== 2) throw new Error("Vertical split did not mount");
      return editors[1];
    });
    expect(
      view.container.querySelector(
        '.editor-split[data-split-direction="vertical"]',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(secondEditor));
    const splitFirstEditor = view.container.querySelector<HTMLElement>(
      '.editor-window[data-window-id="window-1"] .memoka-editor',
    );
    if (!splitFirstEditor) throw new Error("First split Editor did not mount");

    fireEvent.keyDown(secondEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(secondEditor, { key: "h", code: "KeyH" });
    await waitFor(() => expect(document.activeElement).toBe(splitFirstEditor));

    fireEvent.keyDown(splitFirstEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(splitFirstEditor, { key: "l", code: "KeyL" });
    await waitFor(() => expect(document.activeElement).toBe(secondEditor));

    fireEvent.keyDown(secondEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(secondEditor, { key: "c", code: "KeyC" });
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(1),
    );
    const remainingEditor = await waitFor(() => {
      const editor = view.container.querySelector<HTMLElement>(
        '.editor-window[data-window-id="window-1"] .memoka-editor',
      );
      if (!editor) throw new Error("Remaining Editor did not mount");
      if (document.activeElement !== editor) {
        throw new Error("Remaining Editor is not focused");
      }
      return editor;
    });

    fireEvent.keyDown(remainingEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(remainingEditor, { key: "s", code: "KeyS" });
    await waitFor(() =>
      expect(
        view.container.querySelector(
          '.editor-split[data-split-direction="horizontal"]',
        ),
      ).toBeTruthy(),
    );
    await waitFor(() => {
      const editors = [
        ...view.container.querySelectorAll<HTMLElement>(
          ".editor-window .memoka-editor",
        ),
      ];
      if (editors.length !== 2) throw new Error("Horizontal split incomplete");
      if (!editors.includes(document.activeElement as HTMLElement)) {
        throw new Error("Horizontal split has no focused Editor");
      }
      return editors;
    });
    const firstTabWindowIds = [
      ...view.container.querySelectorAll<HTMLElement>(".editor-window"),
    ].map((window) => window.dataset.windowId);
    const tabCommand = openCommandLine(document.activeElement as HTMLElement);
    fireEvent.change(tabCommand, { target: { value: "tabnew" } });
    fireEvent.keyDown(tabCommand, { key: "Enter" });
    const newTabWindow = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        '.empty-editor-window[data-buffer-state="empty"]',
      );
      if (!empty) throw new Error("Empty TabPage did not activate");
      if (document.activeElement !== empty) {
        throw new Error("Empty TabPage Window is not focused");
      }
      return empty;
    });
    expect(view.container.querySelector(".memoka-editor")).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(firstTabWindowIds).not.toContain(newTabWindow.dataset.windowId);

    fireEvent.keyDown(newTabWindow, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(newTabWindow, { key: "c", code: "KeyC" });
    const retainedNewTabWindow = await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(2);
      const empty = view.container.querySelector<HTMLElement>(
        '.empty-editor-window[data-buffer-state="empty"]',
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("Closing the final Window did not retain its TabPage");
      }
      return empty;
    });

    fireEvent.keyDown(retainedNewTabWindow, { key: "g", code: "KeyG" });
    fireEvent.keyDown(retainedNewTabWindow, {
      key: "Unidentified",
      code: "ShiftLeft",
      shiftKey: true,
    });
    fireEvent.keyDown(retainedNewTabWindow, {
      key: "T",
      code: "KeyT",
      shiftKey: true,
    });
    const previousTabEditor = await waitFor(() => {
      const editors = [
        ...view.container.querySelectorAll<HTMLElement>(
          ".editor-window .memoka-editor",
        ),
      ];
      if (
        editors.length !== 2 ||
        !editors.includes(document.activeElement as HTMLElement)
      ) {
        throw new Error("gT did not focus the previous TabPage");
      }
      return document.activeElement as HTMLElement;
    });
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(previousTabEditor, { key: "t", code: "KeyT" });
    fireEvent.keyDown(previousTabEditor, { key: "n", code: "KeyN" });
    const returnedNewTabWindow = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("tn did not return to the new TabPage");
      }
      return empty;
    });
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(returnedNewTabWindow, { key: "t", code: "KeyT" });
    fireEvent.keyDown(returnedNewTabWindow, { key: "p", code: "KeyP" });
    const wrappedPreviousEditor = await waitFor(() => {
      const editors = [
        ...view.container.querySelectorAll<HTMLElement>(
          ".editor-window .memoka-editor",
        ),
      ];
      if (!editors.includes(document.activeElement as HTMLElement)) {
        throw new Error("tp did not wrap to the previous TabPage");
      }
      return document.activeElement as HTMLElement;
    });
    fireEvent.keyDown(wrappedPreviousEditor, { key: "g", code: "KeyG" });
    fireEvent.keyDown(wrappedPreviousEditor, { key: "t", code: "KeyT" });
    const emptyBeforeCreate = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("gt did not return to the empty TabPage");
      }
      return empty;
    });
    fireEvent.keyDown(emptyBeforeCreate, { key: "t", code: "KeyT" });
    fireEvent.keyDown(emptyBeforeCreate, { key: "c", code: "KeyC" });
    const createdByTc = await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(3);
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("tc did not focus the created TabPage");
      }
      return empty;
    });
    fireEvent.keyDown(createdByTc, { key: "t", code: "KeyT" });
    fireEvent.keyDown(createdByTc, { key: "d", code: "KeyD" });
    const returnedAfterTd = await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(2);
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("td did not focus the remaining TabPage");
      }
      return empty;
    });
    const closeTabCommand = openCommandLine(returnedAfterTd);
    fireEvent.change(closeTabCommand, { target: { value: "tabclose" } });
    fireEvent.keyDown(closeTabCommand, { key: "Enter" });
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(2),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "新しいTabPage" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("tab")[0]);
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(2),
    );
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getAllByRole("tab")[1]);
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(1),
    );
    const activeTabClose = view.container.querySelector<HTMLButtonElement>(
      ".application-tab--active .application-tab-close",
    );
    if (!activeTabClose) throw new Error("Active TabPage close did not mount");
    fireEvent.click(activeTabClose);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    view.unmount();
  });

  it("opens Buffer search and Outline from ':' while restoring focus", async () => {
    const navigateOutline = vi.spyOn(CoreRuntime.prototype, "navigateOutline");
    const navigateFocusedSection = vi.spyOn(
      CoreRuntime.prototype,
      "navigateFocusedSection",
    );
    const view = render(<App />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });

    const buffersCommand = openCommandLine(editor);
    expect(document.activeElement).toBe(buffersCommand);
    fireEvent.change(buffersCommand, { target: { value: "buffers" } });
    fireEvent.keyDown(buffersCommand, { key: "Enter", isComposing: true });
    expect(screen.getByRole("textbox", { name: "Memoka Command" })).toBe(
      buffersCommand,
    );
    fireEvent.keyDown(buffersCommand, { key: "Enter" });
    const bufferSearch = await screen.findByRole("combobox", {
      name: "ワークスペースを検索",
    });
    expect(
      bufferSearch
        .closest("[data-search-target]")
        ?.getAttribute("data-search-target"),
    ).toBe("buffers");
    await waitFor(() => expect(document.activeElement).toBe(bufferSearch));
    expect(
      bufferSearch
        .closest(".workspace-search-overlay")
        ?.querySelectorAll('[role="option"]'),
    ).toHaveLength(1);

    fireEvent.keyDown(bufferSearch, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    expect(tree).toBeTruthy();

    const outlineCommand = openCommandLine(editor);
    fireEvent.change(outlineCommand, { target: { value: ":outline" } });
    fireEvent.keyDown(outlineCommand, { key: "Enter" });
    const outline = await screen.findByRole("tree", {
      name: "Sectionアウトライン",
    });
    expect(document.activeElement).toBe(outline);
    expect(outline.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(outline.querySelector('[role="treeitem"]')?.textContent).toContain(
      "新しいノート",
    );

    fireEvent.keyDown(outline, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const outlineCommandLine = screen.getByRole("textbox", {
      name: "Memoka Command",
    });
    expect(document.activeElement).toBe(outlineCommandLine);
    fireEvent.keyDown(outlineCommandLine, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(outline));

    fireEvent.keyDown(outline, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(
      screen.queryByRole("tree", { name: "Sectionアウトライン" }),
    ).toBeNull();

    const helpCommand = openCommandLine(editor);
    fireEvent.change(helpCommand, { target: { value: "help" } });
    fireEvent.keyDown(helpCommand, { key: "Enter" });
    const helpEditor = await waitFor(() => {
      const mounted = view.container.querySelector<HTMLElement>(
        '.editor-window .memoka-editor[data-vim-mode="normal"]',
      );
      const title = view.container.querySelector(".window-title")?.textContent;
      if (
        !mounted ||
        title !== "Memoka help" ||
        document.activeElement !== mounted
      ) {
        throw new Error("Managed Help note did not open");
      }
      return mounted;
    });
    expect(helpEditor.querySelector(".memoka-body-chunk--static")).toBeTruthy();
    expect(helpEditor.textContent).toContain("基本移動");
    expect(helpEditor.textContent).toContain(":tree");
    expect(document.activeElement).toBe(helpEditor);

    fireEvent.keyDown(helpEditor, {
      key: "G",
      code: "KeyG",
      shiftKey: true,
    });
    await waitFor(() => {
      const breadcrumb =
        view.container.querySelector<HTMLElement>(".window-breadcrumb");
      if (!breadcrumb) throw new Error("Caret breadcrumb did not mount");
      expect(breadcrumb.textContent).toContain("Memoka help");
      expect(
        breadcrumb.querySelector<HTMLElement>('[aria-current="page"]')
          ?.textContent,
      ).toBe("このHelpについて");
    });
    const breadcrumb =
      view.container.querySelector<HTMLElement>(".window-breadcrumb");
    const rootBreadcrumb = breadcrumb?.querySelector<HTMLButtonElement>(
      ".window-breadcrumb__part:first-child button",
    );
    if (!rootBreadcrumb) throw new Error("Root breadcrumb did not mount");
    expect(rootBreadcrumb.textContent).toBe("Memoka help");
    navigateOutline.mockClear();
    navigateFocusedSection.mockClear();

    fireEvent.click(rootBreadcrumb);
    await waitFor(() => {
      expect(navigateOutline).toHaveBeenLastCalledWith(
        "window-1",
        expect.objectContaining({ noteId: helpEditor.dataset.noteId }),
        helpEditor.dataset.noteId,
        helpEditor.dataset.noteId,
      );
      expect(navigateFocusedSection).not.toHaveBeenCalled();
      expect(view.container.querySelector(".window-breadcrumb")).toBeNull();
      expect(view.container.querySelector(".window-title")?.textContent).toBe(
        "Memoka help",
      );
    });

    view.unmount();
  });

  it("routes application-wide commands while a Sidebar utility owns focus", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });
    await waitFor(() => expect(document.activeElement).toBe(editor), {
      timeout: 3_000,
    });

    tree.focus();
    fireEvent.keyDown(tree, { key: ":", code: "Semicolon", shiftKey: true });
    const commandLine = screen.getByRole("textbox", {
      name: "Memoka Command",
    });
    expect(document.activeElement).toBe(commandLine);
    fireEvent.keyDown(commandLine, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(tree), {
      timeout: 3_000,
    });

    fireEvent.keyDown(tree, { key: ",", code: "Comma" });
    fireEvent.keyDown(tree, { key: "f", code: "KeyF" });
    const search = await screen.findByRole("combobox", {
      name: "ワークスペースを検索",
    });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(tree), {
      timeout: 3_000,
    });

    const selectedTreeItem = tree.querySelector<HTMLElement>(
      '[role="treeitem"][aria-selected="true"]',
    );
    const selectionBefore = selectedTreeItem?.getAttribute("aria-selected");
    fireEvent.keyDown(tree, {
      key: "l",
      code: "KeyL",
      ctrlKey: true,
    });
    expect(document.activeElement).toBe(tree);
    expect(selectedTreeItem?.getAttribute("aria-selected")).toBe(
      selectionBefore,
    );

    // WebKitGTK can omit ctrlKey on the printable key event. The capture-phase
    // Control tracker still has to recognize the Ctrl-w prefix.
    fireEvent.keyDown(tree, { key: "Control", code: "ControlLeft" });
    fireEvent.keyDown(tree, { key: "w", code: "KeyW" });
    fireEvent.keyUp(tree, { key: "Control", code: "ControlLeft" });
    fireEvent.keyDown(tree, { key: "l", code: "KeyL" });
    await waitFor(() => expect(document.activeElement).toBe(editor));

    enterNormal(editor);
    fireEvent.keyDown(editor, {
      key: "h",
      code: "KeyH",
      ctrlKey: true,
    });
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(editor, { key: "h", code: "KeyH" });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    fireEvent.keyDown(tree, { key: ",", code: "Comma" });
    fireEvent.keyDown(tree, { key: "t", code: "KeyT" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(editor));

    enterNormal(editor);
    fireEvent.keyDown(editor, { key: ",", code: "Comma" });
    fireEvent.keyDown(editor, { key: "o", code: "KeyO" });
    fireEvent.keyDown(editor, { key: ",", code: "Comma" });
    fireEvent.keyDown(editor, { key: "o", code: "KeyO" });
    await screen.findByText("utility.outline · closed");
    expect(
      screen.queryByRole("tree", { name: "Sectionアウトライン" }),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(editor));

    enterNormal(editor);
    fireEvent.keyDown(editor, { key: ",", code: "Comma" });
    fireEvent.keyDown(editor, { key: "t", code: "KeyT" });
    tree = await screen.findByRole("tree", { name: "ノートツリー" });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    fireEvent.keyDown(tree, { key: ",", code: "Comma" });
    fireEvent.keyDown(tree, { key: "b", code: "KeyB" });
    const bufferSearch = await screen.findByRole("combobox", {
      name: "ワークスペースを検索",
    });
    expect(
      bufferSearch
        .closest("[data-search-target]")
        ?.getAttribute("data-search-target"),
    ).toBe("buffers");
    await waitFor(() => expect(document.activeElement).toBe(bufferSearch));
    fireEvent.keyDown(bufferSearch, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    fireEvent.keyDown(tree, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "l", code: "KeyL" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    enterNormal(editor);
    fireEvent.keyDown(editor, { key: ",", code: "Comma" });
    fireEvent.keyDown(editor, { key: "o", code: "KeyO" });
    const outline = await screen.findByRole("tree", {
      name: "Sectionアウトライン",
    });
    await waitFor(() => expect(document.activeElement).toBe(outline));

    fireEvent.keyDown(outline, { key: "Control", code: "ControlLeft" });
    fireEvent.keyDown(outline, {
      key: "Unidentified",
      code: "KeyW",
    });
    fireEvent.keyUp(outline, { key: "Control", code: "ControlLeft" });
    fireEvent.keyDown(outline, { key: "h", code: "KeyH" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    fireEvent.keyDown(editor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(editor, { key: "l", code: "KeyL" });
    await waitFor(() => expect(document.activeElement).toBe(outline));

    fireEvent.keyDown(outline, { key: ",", code: "Comma" });
    fireEvent.keyDown(outline, { key: "o", code: "KeyO" });
    await waitFor(() =>
      expect(
        screen.queryByRole("tree", { name: "Sectionアウトライン" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(editor));

    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, { key: ",", code: "Comma" });
    fireEvent.keyDown(editor, { key: "o", code: "KeyO" });
    const reopenedOutline = await screen.findByRole("tree", {
      name: "Sectionアウトライン",
    });
    await waitFor(() => expect(document.activeElement).toBe(reopenedOutline));

    fireEvent.keyDown(reopenedOutline, { key: ",", code: "Comma" });
    fireEvent.keyDown(reopenedOutline, { key: "t", code: "KeyT" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(reopenedOutline));
    fireEvent.keyDown(reopenedOutline, { key: ",", code: "Comma" });
    fireEvent.keyDown(reopenedOutline, { key: "t", code: "KeyT" });
    tree = await screen.findByRole("tree", { name: "ノートツリー" });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    fireEvent.click(screen.getByRole("button", { name: "新しいTabPage" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("tab")[0]);
    await waitFor(() =>
      expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    tree = screen.getByRole("tree", { name: "ノートツリー" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "g", code: "KeyG" });
    fireEvent.keyDown(tree, { key: "t", code: "KeyT" });
    await waitFor(() =>
      expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("Sidebar gt did not focus the next TabPage Window");
      }
    });
    view.unmount();
  });

  it("restores Tree visibility and selection independently for each TabPage", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const selectedTreeItem = (): HTMLElement | null =>
      screen
        .queryByRole("tree", { name: "ノートツリー" })
        ?.querySelector<HTMLElement>(
          '[role="treeitem"][aria-selected="true"]',
        ) ?? null;
    const initialNoteId = selectedTreeItem()?.id;
    tree.focus();
    fireEvent.keyDown(tree, { key: "A" });
    const createdNoteId = await waitFor(() => {
      const id = selectedTreeItem()?.id;
      if (!id || id === initialNoteId) {
        throw new Error("New root Note was not selected in the first TabPage");
      }
      return id;
    });

    fireEvent.click(screen.getByRole("button", { name: "新しいTabPage" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull();
    const newTabWindow = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty || document.activeElement !== empty) {
        throw new Error("New TabPage did not focus its empty Window");
      }
      return empty;
    });
    fireEvent.keyDown(newTabWindow, { key: ",", code: "Comma" });
    fireEvent.keyDown(newTabWindow, { key: "t", code: "KeyT" });
    tree = await screen.findByRole("tree", { name: "ノートツリー" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "g" });
    fireEvent.keyDown(tree, { key: "g" });
    await waitFor(() => expect(selectedTreeItem()?.id).toBe(initialNoteId));
    fireEvent.keyDown(tree, { key: "," });
    fireEvent.keyDown(tree, { key: "t" });
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("tab")[0]);
    tree = await screen.findByRole("tree", { name: "ノートツリー" });
    expect(selectedTreeItem()?.id).toBe(createdNoteId);

    fireEvent.click(screen.getAllByRole("tab")[1]);
    await waitFor(() =>
      expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull(),
    );
    const emptyWindow = view.container.querySelector<HTMLElement>(
      ".empty-editor-window",
    );
    if (!emptyWindow) throw new Error("Second TabPage is not empty");
    emptyWindow.focus();
    fireEvent.keyDown(emptyWindow, { key: "," });
    fireEvent.keyDown(emptyWindow, { key: "t" });
    await screen.findByRole("tree", { name: "ノートツリー" });
    expect(selectedTreeItem()?.id).toBe(initialNoteId);
    view.unmount();
  });

  it("closes the current Buffer into an empty Window and reopens from Tree", async () => {
    const view = render(<App />);
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });

    const command = openCommandLine(editor);
    fireEvent.change(command, { target: { value: "bd" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const emptyWindow = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty) throw new Error("Buffer close did not empty the Window");
      if (document.activeElement !== empty) {
        throw new Error("Empty Window did not receive focus");
      }
      return empty;
    });
    expect(view.container.querySelector(".memoka-editor")).toBeNull();
    expect(
      emptyWindow.querySelector(".empty-editor-window__body")?.textContent,
    ).toBe("");

    tree.focus();
    fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => {
      const reopened =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!reopened) throw new Error("Tree did not reopen the Note Buffer");
      expect(document.activeElement).toBe(reopened);
    });
    expect(view.container.querySelector(".empty-editor-window")).toBeNull();
    view.unmount();
  });

  it("keeps the final application Window as an empty Window on close", async () => {
    const view = render(<App />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });

    enterNormal(editor);
    fireEvent.keyDown(editor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(editor, { key: "c", code: "KeyC" });

    const emptyWindow = await waitFor(() => {
      const empty = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!empty) throw new Error("Final Window did not become empty");
      if (document.activeElement !== empty) {
        throw new Error("Empty Window did not receive focus");
      }
      return empty;
    });
    expect(
      emptyWindow.querySelector(".empty-editor-window__body")?.textContent,
    ).toBe("");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
  });

  it("keeps unknown commands open and restores Editor focus on cancel", async () => {
    const restoreFocus = vi.fn();
    const session: ApplicationCommandLineSession = { restoreFocus };
    const onExecute = vi.fn();
    const onClose = vi.fn();
    render(
      <ApplicationCommandLine
        session={session}
        onExecute={onExecute}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Memoka Command",
    });
    fireEvent.change(input, { target: { value: "write" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("未対応のCommand");
    expect(onExecute).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("opens the shared application input surface with / and restores Editor focus on cancel", async () => {
    const view = render(<App />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const mounted = view.container.querySelector<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (!mounted) throw new Error("Editor did not mount");
      return mounted;
    });
    enterNormal(editor);
    fireEvent.keyDown(editor, { key: "/", code: "Slash" });
    const input = await screen.findByRole("textbox", {
      name: "ノート内を検索",
    });
    expect(document.activeElement).toBe(input);
    expect(input.closest(".application-commandline")?.textContent).toContain(
      "/",
    );

    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    view.unmount();
  });

  it("does not submit note search with an IME composition Enter", async () => {
    const restoreFocus = vi.fn();
    const requestInputMethodDeactivation = vi.fn();
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const applyDestination = vi.fn(() => "search:note:forward:1/1");
    const origin = createNoteSearchOrigin();
    const session: ApplicationNoteSearchSession = {
      windowId: "window-1",
      origin,
      applyDestination,
      requestInputMethodDeactivation,
      restoreFocus,
    };
    const searchNote = vi.fn(async () => ({
      handled: true,
      detail: "search:note:forward:1/1",
      destination: {
        kind: "note-search-match" as const,
        noteId: origin.stable.noteId,
        sectionId: origin.location.sectionId,
        blockId: origin.location.blockId,
        offset: 0,
        query: "日本語",
      },
      query: "日本語",
      matchCount: 1,
      matchIndex: 0,
      wrapped: false,
    }));
    render(
      <ApplicationNoteSearch
        runtime={{ searchNote } as unknown as CoreRuntime}
        session={session}
        onClose={onClose}
        onMessage={onMessage}
      />,
    );
    const input = screen.getByRole("textbox", { name: "ノート内を検索" });
    fireEvent.change(input, { target: { value: "日本語" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(searchNote).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchNote).toHaveBeenCalledTimes(1));
    expect(searchNote).toHaveBeenCalledWith("window-1", origin, "日本語");
    expect(applyDestination).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("/日本語 · 1/1");
    expect(requestInputMethodDeactivation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Escape", { key: "Escape", code: "Escape" }],
    ["Ctrl-C", { key: "c", code: "KeyC", ctrlKey: true }],
  ])("requests IME OFF when note search closes with %s", async (_, key) => {
    const restoreFocus = vi.fn();
    const requestInputMethodDeactivation = vi.fn();
    const onClose = vi.fn();
    render(
      <ApplicationNoteSearch
        runtime={{ searchNote: vi.fn() } as unknown as CoreRuntime}
        session={{
          windowId: "window-1",
          origin: createNoteSearchOrigin(),
          applyDestination: vi.fn(() => null),
          requestInputMethodDeactivation,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "ノート内を検索" }),
      key,
    );
    expect(requestInputMethodDeactivation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("moves and jumps within the Outline declarative keymap", async () => {
    const note = createOutlineNote("01900000-0000-7000-8000-000000000020", [
      {
        sectionId: "01900000-0000-7000-8000-000000000022",
        title: "First",
      },
      {
        sectionId: "01900000-0000-7000-8000-000000000024",
        title: "Second",
        parentSectionId: "01900000-0000-7000-8000-000000000022",
      },
    ]);
    const onJump = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <WorkspaceOutline
        note={note}
        focusRequest={1}
        onJump={onJump}
        onClose={onClose}
        onFocus={() => undefined}
      />,
    );
    const outline = screen.getByRole("tree", {
      name: "Sectionアウトライン",
    });
    expect(document.activeElement).toBe(outline);
    const rows = outline.querySelectorAll<HTMLElement>('[role="treeitem"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Root");
    expect(rows[0]?.getAttribute("aria-level")).toBe("1");
    expect(rows[1]?.getAttribute("aria-level")).toBe("2");
    expect(rows[2]?.getAttribute("aria-level")).toBe("3");
    const revealSecond = vi.fn();
    Object.defineProperty(rows[1]!, "scrollIntoView", {
      configurable: true,
      value: revealSecond,
    });
    fireEvent.keyDown(outline, { key: "j" });
    await waitFor(() =>
      expect(revealSecond).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
      }),
    );
    fireEvent.keyDown(outline, { key: "Enter" });
    await waitFor(() =>
      expect(onJump).toHaveBeenCalledWith(
        "01900000-0000-7000-8000-000000000022",
      ),
    );
    fireEvent.click(screen.getByText("First").closest("[role=treeitem]")!);
    await waitFor(() =>
      expect(onJump).toHaveBeenLastCalledWith(
        "01900000-0000-7000-8000-000000000022",
      ),
    );
    fireEvent.keyDown(outline, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    note.doc.destroy();
  });

  it("renders only the Section subtree mounted by the active Buffer view", () => {
    const note = createOutlineNote("01900000-0000-7000-8000-000000000060", [
      {
        sectionId: "01900000-0000-7000-8000-000000000062",
        title: "Focused",
      },
      {
        sectionId: "01900000-0000-7000-8000-000000000064",
        title: "Visible child",
        parentSectionId: "01900000-0000-7000-8000-000000000062",
      },
      {
        sectionId: "01900000-0000-7000-8000-000000000066",
        title: "Hidden sibling",
      },
    ]);
    const sharedProps = {
      note,
      focusRequest: 0,
      onJump: async () => undefined,
      onClose: () => undefined,
      onFocus: () => undefined,
    };
    const view = render(
      <WorkspaceOutline
        {...sharedProps}
        scopeSectionId="01900000-0000-7000-8000-000000000062"
      />,
    );
    let rows = screen
      .getByRole("tree", { name: "Sectionアウトライン" })
      .querySelectorAll<HTMLElement>('[role="treeitem"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Focused");
    expect(rows[0]?.getAttribute("aria-level")).toBe("1");
    expect(rows[1]?.textContent).toContain("Visible child");
    expect(rows[1]?.getAttribute("aria-level")).toBe("2");
    expect(screen.queryByText("Root")).toBeNull();
    expect(screen.queryByText("Hidden sibling")).toBeNull();

    view.rerender(
      <WorkspaceOutline {...sharedProps} scopeSectionId={note.noteId} />,
    );
    rows = screen
      .getByRole("tree", { name: "Sectionアウトライン" })
      .querySelectorAll<HTMLElement>('[role="treeitem"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("Root");
    expect(screen.getByText("Hidden sibling")).toBeTruthy();

    view.unmount();
    note.doc.destroy();
  });

  it("follows the active Editor Section and reveals it inside the Outline", async () => {
    const note = createOutlineNote("01900000-0000-7000-8000-000000000050", [
      {
        sectionId: "01900000-0000-7000-8000-000000000052",
        title: "Caret Section",
      },
    ]);
    const sharedProps = {
      note,
      focusRequest: 0,
      onJump: async () => undefined,
      onClose: () => undefined,
      onFocus: () => undefined,
    };
    const view = render(
      <WorkspaceOutline
        {...sharedProps}
        viewState={{
          noteId: note.noteId,
          selectedSectionId: note.noteId,
        }}
      />,
    );
    const childRow = screen
      .getByText("Caret Section")
      .closest<HTMLElement>('[role="treeitem"]');
    if (!childRow) throw new Error("Outline child row was not rendered");
    const reveal = vi.fn();
    Object.defineProperty(childRow, "scrollIntoView", {
      configurable: true,
      value: reveal,
    });

    view.rerender(
      <WorkspaceOutline
        {...sharedProps}
        viewState={{
          noteId: note.noteId,
          selectedSectionId: "01900000-0000-7000-8000-000000000052",
        }}
      />,
    );

    await waitFor(() =>
      expect(childRow.getAttribute("aria-selected")).toBe("true"),
    );
    expect(reveal).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    view.unmount();
    note.doc.destroy();
  });

  it("keeps application focus shortcuts active while an Outline jump is busy", async () => {
    const note = createOutlineNote("01900000-0000-7000-8000-000000000040", [
      {
        sectionId: "01900000-0000-7000-8000-000000000042",
        title: "Pending jump",
      },
    ]);
    let finishJump: (() => void) | null = null;
    const onJump = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishJump = resolve;
        }),
    );
    const onApplicationKeyDown = vi.fn(
      (event: ReactKeyboardEvent<HTMLElement>) => event.ctrlKey,
    );
    render(
      <WorkspaceOutline
        note={note}
        focusRequest={1}
        onJump={onJump}
        onClose={() => undefined}
        onFocus={() => undefined}
        onApplicationKeyDown={onApplicationKeyDown}
      />,
    );
    const outline = screen.getByRole("tree", {
      name: "Sectionアウトライン",
    });

    fireEvent.keyDown(outline, { key: "Enter", code: "Enter" });
    expect(onJump).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(outline, {
      key: "Unidentified",
      code: "KeyW",
      ctrlKey: true,
    });
    expect(
      onApplicationKeyDown.mock.calls.some(
        ([event]) => event.ctrlKey && event.code === "KeyW",
      ),
    ).toBe(true);

    await act(async () => finishJump?.());
    note.doc.destroy();
  });

  it("updates the Outline NoteDoc without stealing Editor focus", async () => {
    const first = createOutlineNote("01900000-0000-7000-8000-000000000030", [
      {
        sectionId: "01900000-0000-7000-8000-000000000032",
        title: "First note Section",
      },
    ]);
    const second = createOutlineNote("01900000-0000-7000-8000-000000000033", [
      {
        sectionId: "01900000-0000-7000-8000-000000000035",
        title: "Second note Section",
      },
    ]);
    const editorFocusTarget = document.createElement("button");
    document.body.append(editorFocusTarget);
    const view = render(
      <WorkspaceOutline
        note={first}
        focusRequest={1}
        onJump={async () => undefined}
        onClose={() => undefined}
        onFocus={() => undefined}
      />,
    );
    const outline = screen.getByRole("tree", {
      name: "Sectionアウトライン",
    });
    expect(document.activeElement).toBe(outline);

    editorFocusTarget.focus();
    view.rerender(
      <WorkspaceOutline
        note={second}
        focusRequest={1}
        onJump={async () => undefined}
        onClose={() => undefined}
        onFocus={() => undefined}
      />,
    );
    await screen.findByText("Second note Section");
    expect(screen.queryByText("First note Section")).toBeNull();
    expect(document.activeElement).toBe(editorFocusTarget);
    expect(outline.getAttribute("aria-activedescendant")).toBe(
      "outline-section-01900000-0000-7000-8000-000000000033",
    );

    view.unmount();
    editorFocusTarget.remove();
    first.doc.destroy();
    second.doc.destroy();
  });
});
