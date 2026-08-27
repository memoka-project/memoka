import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/src/App";

describe("application focus surfaces", () => {
  it("shows background work and input latency only on the development debug line", async () => {
    const view = render(<App showDebugLine />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const debug = screen.getByLabelText("開発デバッグ情報");
    expect(debug.querySelector('[data-background-task="fts"]')).not.toBeNull();
    expect(
      debug.querySelector('[data-background-task="mirror"]'),
    ).not.toBeNull();
    expect(debug.querySelector("[data-input-latency-p95-ms]")).not.toBeNull();
    expect(debug.textContent).toContain("input -");
    view.unmount();
  });

  it("shows one focused surface and keeps Window statuslines user-facing", async () => {
    const view = render(<App showDebugLine={false} />);
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const value = view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!value) throw new Error("Editor did not mount");
      return value;
    });
    const editorWindow = editor.closest<HTMLElement>(".editor-window");
    if (!editorWindow) throw new Error("Editor Window did not mount");

    expect(view.container.querySelector(".topbar")).toBeNull();
    expect(view.container.querySelector(".persistence-state")).toBeNull();
    expect(view.container.querySelector(".debug-line")).toBeNull();
    expect(editorWindow.classList.contains("focus-surface--focused")).toBe(
      true,
    );
    expect(
      editorWindow.querySelector(".window-statusline")?.textContent,
    ).toContain("INSERT");
    expect(
      editorWindow.querySelector(".window-statusline")?.textContent,
    ).toContain("新しいノート");
    expect(
      editorWindow.querySelector(".window-statusline")?.textContent,
    ).not.toContain("window-1");

    tree.focus();
    await waitFor(() =>
      expect(
        tree
          .closest(".workspace-sidebar")
          ?.classList.contains("focus-surface--focused"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(editorWindow.classList.contains("focus-surface--focused")).toBe(
        false,
      ),
    );
    expect(editorWindow.querySelector(".window-statusline")?.textContent).toBe(
      "新しいノート",
    );

    fireEvent.keyDown(tree, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const command = await screen.findByRole("textbox", {
      name: "Memoka Command",
    });
    expect(
      command
        .closest(".application-commandline")
        ?.classList.contains("focus-surface--focused"),
    ).toBe(true);
    expect(
      tree
        .closest(".workspace-sidebar")
        ?.classList.contains("focus-surface--focused"),
    ).toBe(false);
    fireEvent.keyDown(command, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(tree));

    const statusline =
      editorWindow.querySelector<HTMLElement>(".window-statusline");
    if (!statusline) throw new Error("Window statusline did not mount");
    fireEvent.mouseDown(statusline);
    await waitFor(() => expect(document.activeElement).toBe(editor));
    await waitFor(() =>
      expect(editorWindow.classList.contains("focus-surface--focused")).toBe(
        true,
      ),
    );

    fireEvent(globalThis.window, new Event("blur"));
    expect(
      view.container
        .querySelector(".app-shell")
        ?.classList.contains("app-shell--inactive"),
    ).toBe(true);
    expect(editorWindow.classList.contains("focus-surface--focused")).toBe(
      true,
    );
    fireEvent(globalThis.window, new Event("focus"));
    await waitFor(() =>
      expect(
        view.container
          .querySelector(".app-shell")
          ?.classList.contains("app-shell--inactive"),
      ).toBe(false),
    );
    view.unmount();
  });

  it("focuses a blank empty Window and recovers a lost DOM focus", async () => {
    const view = render(<App showDebugLine={false} />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const value = view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!value) throw new Error("Editor did not mount");
      return value;
    });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "tabnew" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const emptyWindow = await waitFor(() => {
      const value = view.container.querySelector<HTMLElement>(
        ".empty-editor-window",
      );
      if (!value) throw new Error("Empty Window did not mount");
      return value;
    });
    expect(screen.queryByRole("tree", { name: "ノートツリー" })).toBeNull();
    const blankBody = emptyWindow.querySelector<HTMLElement>(
      ".empty-editor-window__body",
    );
    if (!blankBody) throw new Error("Empty Window body did not mount");
    expect(blankBody.textContent).toBe("");
    fireEvent.mouseDown(blankBody);
    expect(document.activeElement).toBe(emptyWindow);
    expect(emptyWindow.querySelector(".window-statusline")?.textContent).toBe(
      "[No Buffer]",
    );
    expect(emptyWindow.querySelector(".window-mode")).toBeNull();

    emptyWindow.blur();
    fireEvent.blur(emptyWindow, { relatedTarget: null });
    await waitFor(() => expect(document.activeElement).toBe(emptyWindow));

    fireEvent.keyDown(emptyWindow, { key: ",", code: "Comma" });
    fireEvent.keyDown(emptyWindow, { key: "o", code: "KeyO" });
    const emptyOutline = await screen.findByLabelText("Outline");
    expect(emptyOutline.textContent).toBe("OUTLINE");
    await waitFor(() => expect(document.activeElement).toBe(emptyOutline));
    expect(
      screen.queryByText("このWindowにはBufferが開かれていません。"),
    ).toBeNull();
    view.unmount();
  });

  it("focuses a clicked blank editor surface and clears the previous Window caret", async () => {
    const view = render(<App showDebugLine={false} />);
    await screen.findByRole("tree", { name: "ノートツリー" });
    const initialEditor = await waitFor(() => {
      const value = view.container.querySelector<HTMLElement>(
        '.editor-window[data-window-id="window-1"] .memoka-editor',
      );
      if (!value) throw new Error("Initial Editor did not mount");
      return value;
    });

    initialEditor.focus();
    fireEvent.keyDown(initialEditor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(initialEditor, {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
    });
    fireEvent.keyDown(initialEditor, { key: "v", code: "KeyV" });
    const editors = await waitFor(() => {
      const values = [
        ...view.container.querySelectorAll<HTMLElement>(
          ".editor-window .memoka-editor",
        ),
      ];
      if (values.length !== 2) throw new Error("Vertical split did not mount");
      return values;
    });
    const [firstEditor, secondEditor] = editors;

    fireEvent.mouseDown(firstEditor, {
      button: 0,
      clientX: 200,
      clientY: 600,
    });
    fireEvent.keyDown(firstEditor, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(
        firstEditor
          .closest(".editor-window")
          ?.classList.contains("focus-surface--focused"),
      ).toBe(true),
    );
    await waitFor(() => expect(document.activeElement).toBe(firstEditor));
    await waitFor(() =>
      expect(
        [
          ...document.body.querySelectorAll<HTMLElement>(".memoka-vim-caret"),
        ].filter((candidate) => candidate.style.display === "block").length,
      ).toBe(1),
    );
    // The contenteditable itself is the event target when the user clicks its
    // blank area below or beside the rendered document.
    fireEvent.mouseDown(secondEditor, {
      button: 0,
      clientX: 400,
      clientY: 600,
    });

    expect(document.activeElement).toBe(secondEditor);

    // WebKitGTK can restore the previously focused contenteditable after the
    // capture-phase focus but before the asynchronous Core focus transaction
    // reaches React. The focused surface must project its owner back to DOM
    // focus instead of leaving keyboard input in the previous Window.
    firstEditor.focus();
    await waitFor(() =>
      expect(
        secondEditor
          .closest(".editor-window")
          ?.classList.contains("focus-surface--focused"),
      ).toBe(true),
    );
    await waitFor(() => expect(document.activeElement).toBe(secondEditor));

    // A delayed WebKitGTK focus restoration can also arrive after Core has
    // committed the target Window and React has moved the highlight. Treating
    // this bare focus event as a new user intent would leave the highlight on
    // the target while keyboard input returns to the previous Window.
    firstEditor.focus();
    expect(document.activeElement).toBe(firstEditor);
    await waitFor(() => expect(document.activeElement).toBe(secondEditor));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "i",
      code: "KeyI",
    });
    expect(
      firstEditor.closest<HTMLElement>(".editor-window")?.dataset.vimMode,
    ).toBe("normal");
    expect(
      secondEditor.closest<HTMLElement>(".editor-window")?.dataset.vimMode,
    ).toBe("insert");
    await waitFor(() =>
      expect(
        [
          ...document.body.querySelectorAll<HTMLElement>(".memoka-vim-caret"),
        ].filter((candidate) => candidate.style.display === "block").length,
      ).toBe(1),
    );
    view.unmount();
  });
});
