import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { EditorSplitLayout } from "../app/src/components/EditorSplitLayout";
import { WorkspacePaneLayout } from "../app/src/components/WorkspacePaneLayout";
import {
  createApplicationWindowState,
  type SplitNode,
} from "../app/src/core/application-state";
import { CoreRuntime } from "../app/src/core/runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

function dimensions(element: HTMLElement, width: number, height: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, height),
  );
}

function pointer(
  element: Element | Window,
  type: string,
  x: number,
  y: number,
  pointerId = 1,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
}

async function windowKey(key: string, count = "", heldControl = false) {
  const element = document.activeElement!;
  await act(async () => {
    for (const digit of count) fireEvent.keyDown(element, { key: digit });
    fireEvent.keyDown(element, { key: "w", code: "KeyW", ctrlKey: true });
  });
  await act(async () => {
    fireEvent.keyDown(element, {
      key,
      code: /^[a-z]$/iu.test(key) ? `Key${key.toUpperCase()}` : "",
      shiftKey: /^[A-Z+<>]$/u.test(key),
      ctrlKey: heldControl,
    });
  });
}

function focusedWindowId(): string | undefined {
  return document.activeElement?.closest<HTMLElement>(".editor-window")?.dataset
    .windowId;
}

describe("Window controls", () => {
  it("executes ordering, MRU, counted sizes and relocation from the Note editor", async () => {
    const resize = vi.spyOn(CoreRuntime.prototype, "editEditorLayout");
    const attach = vi.spyOn(CoreRuntime.prototype, "attachEditor");
    const view = render(<App />);
    await screen.findByRole("tree");
    const editor = await waitFor(() => {
      const result =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!result) throw new Error("Editor not mounted");
      return result;
    });
    await act(async () => {
      editor.focus();
      fireEvent.keyDown(editor, { key: "Escape" });
    });
    await windowKey("v");
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(2),
    );
    const secondId = await waitFor(() => {
      const id = focusedWindowId();
      if (!id || id === "window-1")
        throw new Error("Second window not focused");
      return id;
    });
    await windowKey("t");
    await waitFor(() => expect(focusedWindowId()).toBe("window-1"));
    await windowKey("p", "", true);
    await waitFor(() => expect(focusedWindowId()).toBe(secondId));
    await windowKey("w", "", true);
    await waitFor(() => expect(focusedWindowId()).toBe("window-1"));
    await windowKey("W", "", true);
    await waitFor(() => expect(focusedWindowId()).toBe(secondId));
    await windowKey("s");
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(3),
    );
    const lastId = focusedWindowId();
    expect(lastId).not.toBe(secondId);
    await windowKey("t");
    await waitFor(() => expect(focusedWindowId()).toBe("window-1"));
    await windowKey("b");
    await waitFor(() => expect(focusedWindowId()).toBe(lastId));
    dimensions(
      view.container.querySelector<HTMLElement>(".workspace")!,
      1000,
      600,
    );
    await windowKey("+", "3");
    await waitFor(() =>
      expect(resize).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "resize",
          direction: "horizontal",
          deltaPx: expect.closeTo(84.15),
        }),
      ),
    );
    await windowKey("-", "2");
    expect(resize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ deltaPx: expect.closeTo(-56.1) }),
    );
    await windowKey("<", "4");
    expect(resize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ direction: "vertical", deltaPx: -34 }),
    );
    await windowKey(">", "4");
    expect(resize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ deltaPx: 34 }),
    );
    await windowKey("=");
    expect(resize).toHaveBeenLastCalledWith(expect.any(String), {
      kind: "equalize",
    });
    const activeAdapter = () => {
      const result = [...attach.mock.results]
        .reverse()
        .find(
          (result) =>
            result.type === "return" &&
            !result.value.editor.isDestroyed &&
            result.value.editor.view.dom
              .closest(".editor-window")
              ?.getAttribute("data-window-id") === lastId,
        );
      if (!result || result.type !== "return")
        throw new Error("Active adapter not found");
      return result.value;
    };
    for (const key of ["H", "L", "K", "J"]) {
      // Selection projection is deferred to rAF; rearranging must not lose
      // a caret move made before that frame has published the local view.
      const before = activeAdapter();
      await act(async () => {
        before.editor.commands.setTextSelection(5);
      });
      const expectedHead = before.editor.state.selection.head;
      await windowKey(key);
      await waitFor(() => {
        expect(focusedWindowId()).toBe(lastId);
        const root =
          view.container.querySelector(".workspace")!.firstElementChild!;
        const edge = ["H", "K"].includes(key)
          ? root.firstElementChild
          : root.children[1];
        expect((edge as HTMLElement).dataset.windowId).toBe(lastId);
      });
      expect(activeAdapter().editor.state.selection.head).toBe(expectedHead);
    }
    expect(view.container.querySelectorAll(".editor-window")).toHaveLength(3);
  });

  it("keeps case-sensitive Window keys and counts working in an Empty Buffer", async () => {
    const resize = vi.spyOn(CoreRuntime.prototype, "editEditorLayout");
    const view = render(<App />);
    await screen.findByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: "新しいTabPage" }));
    await waitFor(() =>
      expect(
        document.activeElement?.classList.contains("empty-editor-window"),
      ).toBe(true),
    );
    await windowKey("v");
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".empty-editor-window"),
      ).toHaveLength(2),
    );
    const ids = [
      ...view.container.querySelectorAll<HTMLElement>(".empty-editor-window"),
    ].map((element) => element.dataset.windowId);
    await windowKey("w", "", true);
    await waitFor(() => expect(focusedWindowId()).toBe(ids[0]));
    await windowKey("W");
    await waitFor(() => expect(focusedWindowId()).toBe(ids[1]));
    dimensions(
      view.container.querySelector<HTMLElement>(".workspace")!,
      1000,
      600,
    );
    await windowKey("<", "12");
    expect(resize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "resize", deltaPx: -102 }),
    );
    await windowKey("H");
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(
          ".workspace .empty-editor-window",
        )?.dataset.windowId,
      ).toBe(ids[1]),
    );
    expect(focusedWindowId()).toBe(ids[1]);
  });

  it("runs Window navigation and resizing from an Image Buffer", async () => {
    const opening = vi.spyOn(CoreRuntime, "open");
    const resize = vi.spyOn(CoreRuntime.prototype, "editEditorLayout");
    const view = render(<App />);
    await screen.findByRole("tree");
    const runtime = await opening.mock.results[0]!.value;
    await act(async () => {
      await runtime.openImage(
        "window-1",
        "01900000-0000-7000-8000-000000000099",
      );
    });
    await waitFor(() =>
      expect(
        document.activeElement?.closest("[data-buffer-state='image']"),
      ).toBeTruthy(),
    );
    await windowKey("v");
    await waitFor(() =>
      expect(view.container.querySelectorAll(".editor-window")).toHaveLength(2),
    );
    const lastId = focusedWindowId();
    await windowKey("w", "", true);
    await waitFor(() => expect(focusedWindowId()).toBe("window-1"));
    await windowKey("W");
    await waitFor(() => expect(focusedWindowId()).toBe(lastId));
    dimensions(
      view.container.querySelector<HTMLElement>(".workspace")!,
      1000,
      600,
    );
    await windowKey(">", "2");
    expect(resize).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ direction: "vertical", deltaPx: 17 }),
    );
    await windowKey("H");
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(".workspace .editor-window")
          ?.dataset.windowId,
      ).toBe(lastId),
    );
    expect(focusedWindowId()).toBe(lastId);
  });

  it.each(["vertical", "horizontal"] as const)(
    "previews a %s drag without persisting or remounting editors, and commits once",
    async (direction) => {
      const resize = vi.fn(async () => undefined);
      const onError = vi.fn();
      const root: SplitNode = {
        type: "split",
        id: "split",
        direction,
        ratio: 0.5,
        first: { type: "leaf", windowId: "a" },
        second: { type: "leaf", windowId: "b" },
      };
      const renderWindow = vi.fn((id: string) => (
        <input key={id} aria-label={id} />
      ));
      const view = render(
        <EditorSplitLayout
          node={root}
          renderWindow={renderWindow}
          onResize={resize}
          onError={onError}
        />,
      );
      const split = view.container.firstElementChild as HTMLElement;
      dimensions(split, 1000, 600);
      const input = screen.getByLabelText("a");
      input.focus();
      const handle = screen.getByRole("separator");
      const vertical = direction === "vertical";
      pointer(handle, "pointerdown", 500, 300);
      pointer(
        window,
        "pointermove",
        vertical ? 700 : 500,
        vertical ? 300 : 420,
      );
      expect(resize).not.toHaveBeenCalled();
      expect(renderWindow).toHaveBeenCalledTimes(2);
      expect(
        split.style[vertical ? "gridTemplateColumns" : "gridTemplateRows"],
      ).toContain("0.7fr");
      expect(document.activeElement).toBe(input);
      pointer(window, "pointerup", vertical ? 700 : 500, vertical ? 300 : 420);
      await waitFor(() =>
        expect(resize).toHaveBeenCalledExactlyOnceWith("split", 0.7),
      );
      expect(document.documentElement.classList.contains("pane-resizing")).toBe(
        false,
      );
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("cancels a drag on Escape or unmount and restores the previous layout", () => {
    const resize = vi.fn(async () => undefined);
    const root: SplitNode = {
      type: "split",
      id: "s",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", windowId: "a" },
      second: { type: "leaf", windowId: "b" },
    };
    const view = render(
      <EditorSplitLayout
        node={root}
        renderWindow={(id) => <div key={id}>{id}</div>}
        onResize={resize}
        onError={vi.fn()}
      />,
    );
    const split = view.container.firstElementChild as HTMLElement;
    dimensions(split, 1000, 600);
    const handle = screen.getByRole("separator");
    const before = split.style.gridTemplateColumns;
    pointer(handle, "pointerdown", 500, 0);
    pointer(window, "pointermove", 700, 0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(split.style.gridTemplateColumns).toBe(before);
    pointer(window, "pointerup", 700, 0);
    expect(resize).not.toHaveBeenCalled();
    pointer(handle, "pointerdown", 500, 0);
    pointer(window, "pointermove", 750, 0);
    view.unmount();
    expect(document.documentElement.classList.contains("pane-resizing")).toBe(
      false,
    );
    expect(resize).not.toHaveBeenCalled();
  });

  it("resizes either sidebar without moving focus, then rolls back failed saves", async () => {
    const resize = vi.fn(async () => undefined);
    const onError = vi.fn();
    const tab = createApplicationWindowState({
      applicationWindowId: "app",
      tabId: "tab",
      windowId: "w",
    }).tabs[0];
    const view = render(
      <WorkspacePaneLayout
        left={tab.leftSidebar}
        right={{ ...tab.rightSidebar, visible: true }}
        onResize={resize}
        onError={onError}
      >
        <button>Focus</button>
      </WorkspacePaneLayout>,
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    dimensions(workspace, 1000, 600);
    const focus = screen.getByRole("button");
    focus.focus();
    const left = screen.getByRole("separator", { name: "Treeの横幅を調整" });
    pointer(left, "pointerdown", 248, 0);
    pointer(window, "pointermove", 308, 0);
    expect(resize).not.toHaveBeenCalled();
    expect(workspace.style.getPropertyValue("--workspace-left-width")).toBe(
      "308px",
    );
    pointer(window, "pointerup", 308, 0);
    await waitFor(() => expect(resize).toHaveBeenLastCalledWith("left", 308));
    expect(document.activeElement).toBe(focus);
    resize.mockRejectedValueOnce(new Error("save failed"));
    const right = screen.getByRole("separator", {
      name: "Outlineの横幅を調整",
    });
    pointer(right, "pointerdown", 752, 0);
    pointer(window, "pointermove", 702, 0);
    pointer(window, "pointerup", 702, 0);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(resize).toHaveBeenLastCalledWith("right", 298);
    expect(workspace.style.getPropertyValue("--workspace-right-width")).toBe(
      "248px",
    );
    expect(document.activeElement).toBe(focus);
  });
});
