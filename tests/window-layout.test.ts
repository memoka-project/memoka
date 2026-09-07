import { describe, expect, it } from "vitest";
import {
  activeTab,
  closeWindow,
  createApplicationWindowState,
  createTabPage,
  editWindowLayout,
  focusWindow,
  keepOnlyWindow,
  listTabWindowIds,
  reloadApplicationWindowState,
  serializeApplicationWindowState,
  splitWindow,
  updateSidebar,
  windowInOrder,
  type ApplicationWindowState,
  type SplitNode,
} from "../app/src/core/application-state";
import {
  resizeWindowLayout,
  type LayoutExtent,
} from "../app/src/core/window-layout";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";

function layout(): ApplicationWindowState {
  let state = createApplicationWindowState({
    applicationWindowId: "app",
    tabId: "tab",
    windowId: "a",
  });
  state = splitWindow(state, {
    targetWindowId: "a",
    newWindowId: "b",
    splitId: "ab",
    direction: "vertical",
  });
  state = splitWindow(state, {
    targetWindowId: "b",
    newWindowId: "c",
    splitId: "bc",
    direction: "horizontal",
  });
  return state;
}

function extentOf(
  node: SplitNode,
  id: string,
  extent: LayoutExtent = { width: 1000, height: 600 },
): LayoutExtent | null {
  if (node.type === "leaf") return node.windowId === id ? extent : null;
  const field = node.direction === "vertical" ? "width" : "height";
  const available = extent[field] - 1;
  return (
    extentOf(node.first, id, { ...extent, [field]: available * node.ratio }) ??
    extentOf(node.second, id, {
      ...extent,
      [field]: available * (1 - node.ratio),
    })
  );
}

describe("Window ordering and layout", () => {
  it("cycles the split traversal order, not creation order or sidebar focus", () => {
    let state = layout();
    state = splitWindow(state, {
      targetWindowId: "a",
      newWindowId: "d",
      splitId: "ad",
      direction: "horizontal",
    });
    expect(listTabWindowIds(state)).toEqual(["a", "d", "b", "c"]);
    for (const [id, order, target] of [
      ["c", "first", "a"],
      ["a", "last", "c"],
      ["a", "next", "d"],
      ["c", "next", "a"],
      ["a", "previous", "c"],
    ] as const) {
      expect(windowInOrder(state, id, order)).toBe(target);
    }
    state = updateSidebar(state, { side: "left", focus: true });
    expect(windowInOrder(state, "c", "next")).toBe("a");
    const single = keepOnlyWindow(state, "c");
    for (const order of [
      "first",
      "last",
      "next",
      "previous",
      "recent",
    ] as const)
      expect(windowInOrder(single, "c", order)).toBe("c");
  });

  it("keeps previous focus tab-local, does not lose it on sidebar or same-window focus, and clears removed references", () => {
    let state = focusWindow(layout(), "a");
    expect(windowInOrder(state, "a", "recent")).toBe("c");
    state = focusWindow(state, "a");
    state = updateSidebar(state, { side: "right", visible: true, focus: true });
    expect(windowInOrder(state, "a", "recent")).toBe("c");
    state = focusWindow(state, "c");
    expect(windowInOrder(state, "c", "recent")).toBe("a");
    state = createTabPage(state, {
      tabId: "other",
      windowId: "other-window",
      bufferId: null,
    });
    expect(windowInOrder(state, "other-window", "recent")).toBe("other-window");
    state = focusWindow(state, "c");
    expect(windowInOrder(state, "c", "recent")).toBe("a");
    state = closeWindow(state, "a");
    expect(windowInOrder(state, "c", "recent")).toBe("c");
    expect(
      reloadApplicationWindowState(serializeApplicationWindowState(state)),
    ).toEqual(state);
  });

  it.each(["vertical", "horizontal"] as const)(
    "resizes the current Window on the %s axis with a pixel delta",
    (direction) => {
      const state = layout();
      const before = state.tabs[0].root;
      const after = resizeWindowLayout(before, "c", direction, 30, {
        width: 1000,
        height: 600,
      });
      const axis = direction === "vertical" ? "width" : "height";
      expect(
        extentOf(after, "c")![axis] - extentOf(before, "c")![axis],
      ).toBeCloseTo(30);
      const back = resizeWindowLayout(after, "c", direction, -30, {
        width: 1000,
        height: 600,
      });
      expect(extentOf(back, "c")![axis]).toBeCloseTo(
        extentOf(before, "c")![axis],
      );
      expect(state).toEqual(layout());
    },
  );

  it("clamps huge counts and mouse ratios while preserving usable neighbors", () => {
    const before = layout().tabs[0].root;
    const after = resizeWindowLayout(before, "c", "vertical", 999999, {
      width: 1000,
      height: 600,
    });
    expect(extentOf(after, "a")!.width).toBeCloseTo(96);
    const small = resizeWindowLayout(before, "c", "horizontal", -999999, {
      width: 1000,
      height: 600,
    });
    expect(extentOf(small, "c")!.height).toBeCloseTo(64);
    expect(() =>
      resizeWindowLayout(before, "c", "vertical", NaN, {
        width: 1000,
        height: 600,
      }),
    ).toThrow();
    const narrow = resizeWindowLayout(before, "c", "vertical", 20, {
      width: 80,
      height: 60,
    });
    expect(
      extentOf(narrow, "a", { width: 80, height: 60 })!.width,
    ).toBeGreaterThan(0);
    expect(
      resizeWindowLayout({ type: "leaf", windowId: "a" }, "a", "vertical", 20, {
        width: 800,
        height: 600,
      }),
    ).toEqual({ type: "leaf", windowId: "a" });
  });

  it.each(["left", "right", "up", "down"] as const)(
    "moves the active Window to the full %s edge without changing its buffer/view",
    (edge) => {
      const state = layout();
      const before = structuredClone(state);
      const result = editWindowLayout(state, "tab", {
        kind: "move",
        windowId: "c",
        edge,
        splitId: `edge-${edge}`,
      });
      const root = result.tabs[0].root;
      expect(root.type).toBe("split");
      if (root.type !== "split") throw new Error("Expected split");
      expect(root.direction).toBe(
        ["left", "right"].includes(edge) ? "vertical" : "horizontal",
      );
      expect(["left", "up"].includes(edge) ? root.first : root.second).toEqual({
        type: "leaf",
        windowId: "c",
      });
      expect(Object.keys(result.windows)).toEqual(Object.keys(state.windows));
      expect(result.windows).toEqual(state.windows);
      expect(result.focusOwner).toEqual(state.focusOwner);
      expect(listTabWindowIds(result).sort()).toEqual(["a", "b", "c"]);
      expect(state).toEqual(before);
    },
  );

  it("equalizes multi-pane groups, retains sidebars, and serializes ratios", () => {
    let state = layout();
    state = splitWindow(state, {
      targetWindowId: "c",
      newWindowId: "d",
      splitId: "cd",
      direction: "horizontal",
    });
    state = editWindowLayout(state, "tab", {
      kind: "ratio",
      splitId: "bc",
      ratio: 0.8,
    });
    expect(
      reloadApplicationWindowState(serializeApplicationWindowState(state)),
    ).toEqual(state);
    state = editWindowLayout(state, "tab", { kind: "equalize" });
    const root = state.tabs[0].root;
    expect(root.type === "split" && root.ratio).toBe(0.5);
    expect(
      root.type === "split" &&
        root.second.type === "split" &&
        root.second.ratio,
    ).toBeCloseTo(1 / 3);
    expect(editWindowLayout(state, "tab", { kind: "equalize" })).toBe(state);
    expect(state.tabs[0].leftSidebar.widthPx).toBe(248);
    expect(() =>
      editWindowLayout(state, "tab", {
        kind: "ratio",
        splitId: "missing",
        ratio: 0.5,
      }),
    ).toThrow();
    expect(() =>
      editWindowLayout(state, "tab", {
        kind: "ratio",
        splitId: "ab",
        ratio: 1,
      }),
    ).toThrow();
  });

  it("persists layout edits through the runtime without writing NoteDoc history", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence);
    const before = runtime.snapshot();
    const { windowId, splitId } = await runtime.splitEditorWindow(
      "window-1",
      "vertical",
    );
    const tabId = runtime.snapshot().applicationWindow.activeTabId;
    await runtime.editEditorLayout(tabId, {
      kind: "ratio",
      splitId,
      ratio: 0.63,
    });
    await runtime.focusEditorWindowInOrder(windowId, "first");
    expect(
      activeTab(runtime.snapshot().applicationWindow).previousWindowId,
    ).toBe(windowId);
    await runtime.updateSidebar({ side: "left", widthPx: 310 });
    expect(runtime.snapshot().noteRevision).toBe(before.noteRevision);
    expect(runtime.snapshot().workspaceRevision).toBe(before.workspaceRevision);
    const saved = runtime.snapshot().applicationWindow;
    runtime.destroy();
    const reopened = await CoreRuntime.open(persistence);
    expect(reopened.snapshot().applicationWindow).toEqual(saved);
    await reopened.focusEditorWindowInOrder("window-1", "recent");
    expect(
      activeTab(reopened.snapshot().applicationWindow).activeWindowId,
    ).toBe(windowId);
    reopened.destroy();
  });
});
