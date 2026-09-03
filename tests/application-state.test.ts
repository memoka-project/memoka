import { describe, expect, it } from "vitest";
import {
  adjacentTabPageId,
  closeBuffer,
  closeTabPage,
  closeWindow,
  createApplicationWindowState,
  createNoteBuffer,
  createTabPage,
  focusWindow,
  focusWindowInDirection,
  keepOnlyWindow,
  listTabWindowIds,
  migrateApplicationWindowState,
  migrateLegacyWindowStates,
  openBufferInCurrentWindow,
  openBufferInWindow,
  removeNotesFromSidebarViews,
  reloadApplicationWindowState,
  serializeApplicationWindowState,
  splitWindow,
  switchTabPage,
  updateSidebar,
  updateWindowView,
  validateApplicationWindowState,
  windowInDirection,
  type ApplicationWindowState,
  type SplitDirection,
  type SplitNode,
} from "../app/src/core/application-state";
import { createWindowViewState } from "../app/src/core/window-state";

const NOTE_A = "01900000-0000-7000-8000-000000000001";
const NOTE_B = "01900000-0000-7000-8000-000000000002";

function initialState(): ApplicationWindowState {
  return createApplicationWindowState({
    applicationWindowId: "application-window-1",
    tabId: "tab-1",
    windowId: "window-1",
    buffer: createNoteBuffer(NOTE_A),
  });
}

function windowSpansOnAxis(
  node: SplitNode,
  direction: SplitDirection,
  start = 0,
  end = 1,
  spans = new Map<string, number>(),
): Map<string, number> {
  if (node.type === "leaf") {
    spans.set(node.windowId, end - start);
    return spans;
  }
  if (node.direction !== direction) {
    windowSpansOnAxis(node.first, direction, start, end, spans);
    windowSpansOnAxis(node.second, direction, start, end, spans);
    return spans;
  }
  const boundary = start + (end - start) * node.ratio;
  windowSpansOnAxis(node.first, direction, start, boundary, spans);
  windowSpansOnAxis(node.second, direction, boundary, end, spans);
  return spans;
}

describe("Memoka Application Window pure state", () => {
  it("creates one TabPage, Window and canonical Note buffer", () => {
    const state = initialState();

    expect(state).toMatchObject({
      schemaVersion: 6,
      applicationWindowId: "application-window-1",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          activeWindowId: "window-1",
          root: { type: "leaf", windowId: "window-1" },
          leftSidebar: {
            visible: true,
            widthPx: 248,
            utility: "tree",
            tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [] },
          },
          rightSidebar: {
            visible: false,
            widthPx: 248,
            utility: "outline",
            outline: { noteId: null, selectedSectionId: null },
          },
        },
      ],
      focusOwner: { area: "window", windowId: "window-1" },
    });
    expect(state.windows["window-1"]).toMatchObject({
      id: "window-1",
      bufferId: `note:${NOTE_A}`,
      view: { mode: "insert", selection: null, scrollTop: 0 },
    });
    expect(state.buffers[`note:${NOTE_A}`]).toEqual(createNoteBuffer(NOTE_A));
    expect(() => validateApplicationWindowState(state)).not.toThrow();
  });

  it("migrates schema 5 Notes state to tab-local Tree state", () => {
    const legacy = structuredClone(initialState()) as unknown as {
      schemaVersion: number;
      tabs: Array<{
        leftSidebar: {
          utility: string;
          tree?: unknown;
          notes?: { selectedNoteId: string | null };
        };
      }>;
    };
    legacy.schemaVersion = 5;
    legacy.tabs[0]!.leftSidebar.utility = "notes";
    legacy.tabs[0]!.leftSidebar.notes = { selectedNoteId: NOTE_A };
    delete legacy.tabs[0]!.leftSidebar.tree;

    const migrated = migrateApplicationWindowState(legacy);
    expect(migrated.changed).toBe(true);
    const state = migrated.state as ApplicationWindowState;
    expect(state.schemaVersion).toBe(6);
    expect(state.tabs[0]?.leftSidebar).toMatchObject({
      utility: "tree",
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [] },
    });
    expect(() => validateApplicationWindowState(state)).not.toThrow();
  });

  it("creates and splits a Window without attaching a Buffer", () => {
    let state = createApplicationWindowState({
      applicationWindowId: "application-window-1",
      tabId: "tab-1",
      windowId: "window-1",
    });
    expect(state.windows["window-1"].bufferId).toBeNull();
    expect(state.buffers).toEqual({});

    state = splitWindow(state, {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    expect(state.windows["window-2"].bufferId).toBeNull();

    state = createTabPage(state, {
      tabId: "tab-2",
      windowId: "window-3",
    });
    expect(state.windows["window-3"].bufferId).toBeNull();
    expect(
      reloadApplicationWindowState(serializeApplicationWindowState(state)),
    ).toEqual(state);
  });

  it("builds nested split trees while sharing Buffer identity and isolating view state", () => {
    const original = initialState();
    let state = splitWindow(original, {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "horizontal",
    });
    state = updateWindowView(state, "window-1", {
      mode: "insert",
      scrollTop: 100,
    });
    state = updateWindowView(state, "window-2", {
      mode: "normal",
      scrollTop: 900,
    });
    state = splitWindow(state, {
      targetWindowId: "window-2",
      newWindowId: "window-3",
      splitId: "split-2",
      direction: "vertical",
      placement: "before",
    });

    expect(original.windows).toHaveProperty("window-1");
    expect(original.windows).not.toHaveProperty("window-2");
    expect(state.tabs[0].root).toMatchObject({
      type: "split",
      id: "split-1",
      direction: "horizontal",
      first: { type: "leaf", windowId: "window-1" },
      second: {
        type: "split",
        id: "split-2",
        direction: "vertical",
        first: { type: "leaf", windowId: "window-3" },
        second: { type: "leaf", windowId: "window-2" },
      },
    });
    expect(listTabWindowIds(state)).toEqual([
      "window-1",
      "window-3",
      "window-2",
    ]);
    expect(state.windows["window-1"].bufferId).toBe(
      state.windows["window-2"].bufferId,
    );
    expect(state.windows["window-1"].view).toMatchObject({
      mode: "insert",
      scrollTop: 100,
    });
    expect(state.windows["window-2"].view).toMatchObject({
      mode: "normal",
      scrollTop: 900,
    });
    expect(state.windows["window-3"].view).toMatchObject({
      mode: "normal",
      scrollTop: 0,
    });
    expect(state.focusOwner).toEqual({
      area: "window",
      windowId: "window-3",
    });
  });

  it.each(["vertical", "horizontal"] as const)(
    "equalizes existing %s panes whenever another Window is split",
    (direction) => {
      let state = splitWindow(initialState(), {
        targetWindowId: "window-1",
        newWindowId: "window-2",
        splitId: "split-1",
        direction,
      });
      state = splitWindow(state, {
        targetWindowId: "window-2",
        newWindowId: "window-3",
        splitId: "split-2",
        direction,
      });

      let spans = windowSpansOnAxis(state.tabs[0]!.root, direction);
      for (const windowId of ["window-1", "window-2", "window-3"]) {
        expect(spans.get(windowId)).toBeCloseTo(1 / 3);
      }

      state = splitWindow(state, {
        targetWindowId: "window-1",
        newWindowId: "window-4",
        splitId: "split-3",
        direction,
        placement: "before",
      });

      expect(listTabWindowIds(state)).toEqual([
        "window-4",
        "window-1",
        "window-2",
        "window-3",
      ]);
      spans = windowSpansOnAxis(state.tabs[0]!.root, direction);
      for (const windowId of ["window-1", "window-2", "window-3", "window-4"]) {
        expect(spans.get(windowId)).toBeCloseTo(1 / 4);
      }
      expect(() => validateApplicationWindowState(state)).not.toThrow();
    },
  );

  it("does not equalize across an orthogonal split boundary", () => {
    let state = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    state = splitWindow(state, {
      targetWindowId: "window-1",
      newWindowId: "window-3",
      splitId: "split-2",
      direction: "horizontal",
    });
    const root = state.tabs[0]!.root;
    if (root.type !== "split") throw new Error("Expected split root");
    root.ratio = 0.4;

    state = splitWindow(state, {
      targetWindowId: "window-1",
      newWindowId: "window-4",
      splitId: "split-3",
      direction: "vertical",
    });

    const nextRoot = state.tabs[0]!.root;
    expect(nextRoot).toMatchObject({
      type: "split",
      id: "split-1",
      direction: "vertical",
      ratio: 0.4,
      first: {
        type: "split",
        id: "split-2",
        direction: "horizontal",
        first: {
          type: "split",
          id: "split-3",
          direction: "vertical",
          ratio: 0.5,
        },
      },
    });
    expect(() => validateApplicationWindowState(state)).not.toThrow();
  });

  it("finds directional neighbours from split geometry without consulting DOM order", () => {
    let state = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    state = splitWindow(state, {
      targetWindowId: "window-1",
      newWindowId: "window-3",
      splitId: "split-2",
      direction: "horizontal",
    });

    expect(windowInDirection(state, "window-1", "right")).toBe("window-2");
    expect(windowInDirection(state, "window-1", "down")).toBe("window-3");
    expect(windowInDirection(state, "window-1", "up")).toBeNull();
    expect(windowInDirection(state, "window-3", "up")).toBe("window-1");
    expect(windowInDirection(state, "window-3", "right")).toBe("window-2");
    expect(windowInDirection(state, "window-2", "left")).toBe("window-1");

    const focused = focusWindowInDirection(state, "window-3", "up");
    expect(focused.tabs[0].activeWindowId).toBe("window-1");
    expect(focused.focusOwner).toEqual({
      area: "window",
      windowId: "window-1",
    });
    expect(focusWindowInDirection(state, "window-1", "up")).toBe(state);
    expect(() =>
      windowInDirection(state, "window-1", "diagonal" as "left"),
    ).toThrow("focus direction");
  });

  it("replaces the active Window Buffer without implicitly creating a split", () => {
    const original = updateWindowView(initialState(), "window-1", {
      mode: "visual-line",
      selection: { anchor: 4, head: 12 },
      scrollTop: 320,
    });
    const state = openBufferInCurrentWindow(original, createNoteBuffer(NOTE_B));

    expect(listTabWindowIds(state)).toEqual(["window-1"]);
    expect(state.windows["window-1"]).toMatchObject({
      bufferId: `note:${NOTE_B}`,
      view: { mode: "normal", selection: null, scrollTop: 0 },
    });
    expect(state.buffers).toHaveProperty(`note:${NOTE_A}`);
    expect(state.buffers).toHaveProperty(`note:${NOTE_B}`);
    expect(original.windows["window-1"].bufferId).toBe(`note:${NOTE_A}`);
  });

  it("opens a Buffer in an explicit Window without stealing focus when requested", () => {
    const original = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    const state = openBufferInWindow(
      original,
      "window-1",
      createNoteBuffer(NOTE_B),
      { mode: "insert", activate: false },
    );

    expect(state.tabs[0].activeWindowId).toBe("window-2");
    expect(state.focusOwner).toEqual({
      area: "window",
      windowId: "window-2",
    });
    expect(state.windows["window-1"]).toMatchObject({
      bufferId: `note:${NOTE_B}`,
      view: { mode: "insert", selection: null, scrollTop: 0 },
    });
    expect(original.windows["window-1"].bufferId).toBe(`note:${NOTE_A}`);
  });

  it("creates, switches and closes TabPages without reusing Window identity", () => {
    let state = openBufferInCurrentWindow(
      initialState(),
      createNoteBuffer(NOTE_B),
    );
    state = createTabPage(state, {
      tabId: "tab-2",
      windowId: "window-2",
      bufferId: `note:${NOTE_A}`,
    });
    state = createTabPage(state, {
      tabId: "tab-3",
      windowId: "window-3",
    });
    expect(adjacentTabPageId(state, "next")).toBe("tab-1");
    expect(adjacentTabPageId(state, "previous")).toBe("tab-2");
    expect(adjacentTabPageId(state, "next", "tab-1")).toBe("tab-2");
    expect(adjacentTabPageId(state, "previous", "tab-1")).toBe("tab-3");
    state = closeTabPage(state, "tab-3");
    expect(state.activeTabId).toBe("tab-2");
    expect(state.focusOwner).toEqual({
      area: "window",
      windowId: "window-2",
    });

    state = switchTabPage(state, "tab-1");
    expect(adjacentTabPageId(state, "next")).toBe("tab-2");
    expect(state.activeTabId).toBe("tab-1");
    expect(state.focusOwner).toEqual({
      area: "window",
      windowId: "window-1",
    });
    state = focusWindow(state, "window-2");
    expect(state.activeTabId).toBe("tab-2");

    state = closeTabPage(state, "tab-2");
    expect(state.tabs.map(({ id }) => id)).toEqual(["tab-1"]);
    expect(state.windows).not.toHaveProperty("window-2");
    expect(state.buffers).toHaveProperty(`note:${NOTE_A}`);
    expect(() => closeTabPage(state, "tab-1")).toThrow("last tab page");
  });

  it("collapses a split and keeps the final application Window empty", () => {
    const one = initialState();
    const two = splitWindow(one, {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    const closed = closeWindow(two, "window-2");

    expect(closed.tabs[0].root).toEqual({
      type: "leaf",
      windowId: "window-1",
    });
    expect(closed.tabs[0].activeWindowId).toBe("window-1");
    expect(closed.focusOwner).toEqual({
      area: "window",
      windowId: "window-1",
    });
    expect(closed.windows).not.toHaveProperty("window-2");
    const emptied = closeWindow(closed, "window-1");
    expect(emptied.tabs).toHaveLength(1);
    expect(emptied.windows["window-1"]).toMatchObject({
      bufferId: null,
      view: { mode: "normal", selection: null, scrollTop: 0 },
    });
    expect(emptied.buffers).toHaveProperty(`note:${NOTE_A}`);

    const withSecondTab = createTabPage(emptied, {
      tabId: "tab-2",
      windowId: "window-3",
    });
    const closedSecondTab = closeWindow(withSecondTab, "window-3");
    expect(closedSecondTab.tabs.map(({ id }) => id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect(closedSecondTab.activeTabId).toBe("tab-2");
    expect(closedSecondTab.windows["window-3"]).toMatchObject({
      bufferId: null,
      view: { mode: "normal", selection: null, scrollTop: 0 },
    });
    expect(two.windows).toHaveProperty("window-2");
  });

  it("keeps only the selected Window in its TabPage without closing Buffers or other tabs", () => {
    let state = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    state = splitWindow(state, {
      targetWindowId: "window-2",
      newWindowId: "window-3",
      splitId: "split-2",
      direction: "horizontal",
    });
    state = createTabPage(state, {
      tabId: "tab-2",
      windowId: "window-4",
      bufferId: `note:${NOTE_A}`,
    });

    const only = keepOnlyWindow(state, "window-2");
    expect(only.activeTabId).toBe("tab-1");
    expect(only.tabs[0]).toMatchObject({
      id: "tab-1",
      root: { type: "leaf", windowId: "window-2" },
      activeWindowId: "window-2",
      leftSidebar: { visible: false },
      rightSidebar: { visible: false },
    });
    expect(only.windows).toHaveProperty("window-2");
    expect(only.windows).toHaveProperty("window-4");
    expect(only.windows).not.toHaveProperty("window-1");
    expect(only.windows).not.toHaveProperty("window-3");
    expect(only.buffers).toHaveProperty(`note:${NOTE_A}`);
    expect(only.focusOwner).toEqual({
      area: "window",
      windowId: "window-2",
    });
    expect(state.windows).toHaveProperty("window-1");
    expect(state.windows).toHaveProperty("window-3");
    expect(keepOnlyWindow(only, "window-2")).toBe(only);
    expect(() => keepOnlyWindow(only, "missing-window")).toThrow(
      "Unknown window",
    );
  });

  it("closes a Buffer by detaching every displaying Window", () => {
    let state = openBufferInCurrentWindow(
      initialState(),
      createNoteBuffer(NOTE_B),
    );
    state = openBufferInCurrentWindow(state, createNoteBuffer(NOTE_A));
    state = closeBuffer(state, `note:${NOTE_B}`);

    expect(state.buffers).not.toHaveProperty(`note:${NOTE_B}`);
    expect(state.buffers).toHaveProperty(`note:${NOTE_A}`);
    state = splitWindow(state, {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    state = updateWindowView(state, "window-1", {
      mode: "visual-line",
      selection: { anchor: 2, head: 8 },
      scrollTop: 240,
    });
    state = closeBuffer(state, `note:${NOTE_A}`);
    expect(state.buffers).not.toHaveProperty(`note:${NOTE_A}`);
    expect(state.windows["window-1"]).toMatchObject({
      bufferId: null,
      view: { mode: "normal", selection: null, scrollTop: 0 },
    });
    expect(state.windows["window-2"]).toMatchObject({
      bufferId: null,
      view: { mode: "normal", selection: null, scrollTop: 0 },
    });
  });

  it("updates persisted sidebar presentation and restores Window focus when hidden", () => {
    const original = initialState();
    const search = updateSidebar(original, {
      side: "left",
      visible: true,
      widthPx: 320,
      utility: "search",
      focus: true,
    });

    expect(search.tabs[0].leftSidebar).toEqual({
      visible: true,
      widthPx: 320,
      utility: "search",
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [] },
    });
    expect(search.focusOwner).toEqual({ area: "left-sidebar" });
    expect(original.tabs[0].leftSidebar).toEqual({
      visible: true,
      widthPx: 248,
      utility: "tree",
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [] },
    });

    const editorFocused = updateSidebar(search, {
      side: "left",
      visible: false,
    });
    expect(editorFocused.tabs[0].leftSidebar.visible).toBe(false);
    expect(editorFocused.focusOwner).toEqual({
      area: "window",
      windowId: "window-1",
    });

    const outline = updateSidebar(editorFocused, {
      side: "right",
      visible: true,
      widthPx: 360,
      focus: true,
    });
    expect(outline.tabs[0].rightSidebar).toEqual({
      visible: true,
      widthPx: 360,
      utility: "outline",
      outline: { noteId: null, selectedSectionId: null },
    });
    expect(outline.focusOwner).toEqual({ area: "right-sidebar" });
    expect(
      updateSidebar(outline, { side: "right", visible: false }).focusOwner,
    ).toEqual({ area: "window", windowId: "window-1" });
    expect(() =>
      updateSidebar(editorFocused, { side: "left", focus: true }),
    ).toThrow("hidden left sidebar");
  });

  it("keeps Tree and Outline display and selection state per TabPage", () => {
    let state = updateSidebar(initialState(), {
      side: "left",
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [NOTE_B] },
    });
    state = updateSidebar(state, {
      side: "right",
      visible: true,
      outline: { noteId: NOTE_A, selectedSectionId: NOTE_A },
    });
    state = createTabPage(state, {
      tabId: "tab-2",
      windowId: "window-2",
      bufferId: `note:${NOTE_A}`,
    });
    const createdTab = state.tabs.find(({ id }) => id === "tab-2");
    expect(createdTab?.leftSidebar).toMatchObject({
      visible: false,
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [NOTE_B] },
    });
    expect(createdTab?.rightSidebar).toMatchObject({
      visible: false,
      outline: { noteId: NOTE_A, selectedSectionId: NOTE_A },
    });
    state = updateSidebar(state, {
      side: "left",
      visible: false,
      tree: { selectedNoteId: NOTE_B, collapsedNoteIds: [] },
    });
    state = updateSidebar(state, {
      side: "right",
      visible: false,
      outline: { noteId: null, selectedSectionId: null },
    });

    const firstTab = switchTabPage(state, "tab-1").tabs[0];
    expect(firstTab.leftSidebar).toMatchObject({
      visible: true,
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [NOTE_B] },
    });
    expect(firstTab.rightSidebar).toMatchObject({
      visible: true,
      outline: { noteId: NOTE_A, selectedSectionId: NOTE_A },
    });
    const secondTab = state.tabs.find(({ id }) => id === "tab-2");
    expect(secondTab?.leftSidebar).toMatchObject({
      visible: false,
      tree: { selectedNoteId: NOTE_B, collapsedNoteIds: [] },
    });
    expect(secondTab?.rightSidebar).toMatchObject({
      visible: false,
      outline: { noteId: null, selectedSectionId: null },
    });
  });

  it("repairs every TabPage Sidebar view when a selected Note moves to Trash", () => {
    let state = openBufferInCurrentWindow(
      initialState(),
      createNoteBuffer(NOTE_B),
    );
    state = updateSidebar(state, {
      side: "left",
      tree: { selectedNoteId: NOTE_A, collapsedNoteIds: [NOTE_A] },
    });
    state = updateSidebar(state, {
      side: "right",
      outline: { noteId: NOTE_A, selectedSectionId: NOTE_A },
    });
    state = createTabPage(state, {
      tabId: "tab-2",
      windowId: "window-2",
      bufferId: `note:${NOTE_B}`,
    });

    const repaired = removeNotesFromSidebarViews(
      state,
      new Set([NOTE_A]),
      NOTE_B,
    );
    for (const tab of repaired.tabs) {
      expect(tab.leftSidebar.tree).toEqual({
        selectedNoteId: NOTE_B,
        collapsedNoteIds: [],
      });
      expect(tab.rightSidebar.outline).toEqual({
        noteId: NOTE_B,
        selectedSectionId: null,
      });
    }
    expect(state.tabs[0].leftSidebar.tree.selectedNoteId).toBe(NOTE_A);
  });

  it("migrates deterministic legacy Window records without merging NoteDocs", () => {
    const second = createWindowViewState("window-2", NOTE_B);
    second.mode = "visual-char";
    second.selection = { anchor: 7, head: 3 };
    second.scrollTop = 480;
    const first = createWindowViewState("window-1", NOTE_A);
    first.mode = "normal";
    first.selection = { anchor: 2, head: 2 };
    first.scrollTop = 120;

    const state = migrateLegacyWindowStates({
      applicationWindowId: "application-window-1",
      tabId: "tab-1",
      windows: [second, first],
    });

    expect(state.tabs[0]).toMatchObject({
      activeWindowId: "window-1",
      root: {
        type: "split",
        id: "legacy-split-1",
        direction: "vertical",
        first: { type: "leaf", windowId: "window-1" },
        second: { type: "leaf", windowId: "window-2" },
      },
    });
    expect(state.windows["window-1"]).toMatchObject({
      bufferId: `note:${NOTE_A}`,
      view: { mode: "normal", scrollTop: 120 },
    });
    expect(state.windows["window-2"]).toMatchObject({
      bufferId: `note:${NOTE_B}`,
      view: {
        mode: "visual-char",
        selection: { anchor: 7, head: 3 },
        scrollTop: 480,
      },
    });
    expect(Object.keys(state.buffers).sort()).toEqual(
      [`note:${NOTE_A}`, `note:${NOTE_B}`].sort(),
    );
    expect(first).toMatchObject({ noteId: NOTE_A, scrollTop: 120 });
    expect(second).toMatchObject({ noteId: NOTE_B, scrollTop: 480 });
  });

  it("round-trips valid local state and rejects broken references", () => {
    const state = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    const restored = reloadApplicationWindowState(
      serializeApplicationWindowState(state),
    );
    expect(restored).toEqual(state);
    const legacySidebar = structuredClone(state) as unknown as {
      schemaVersion: number;
      tabs: Array<{
        leftSidebar?: unknown;
        rightSidebar?: unknown;
      }>;
      leftSidebar?: {
        visible: boolean;
        widthPx: number;
        utility: string;
      };
      rightSidebar?: {
        visible: boolean;
        widthPx: number;
        utility: string;
      };
    };
    const tabSidebar = state.tabs[0];
    legacySidebar.schemaVersion = 1;
    legacySidebar.leftSidebar = {
      visible: tabSidebar.leftSidebar.visible,
      widthPx: tabSidebar.leftSidebar.widthPx,
      utility: "trash",
    };
    legacySidebar.rightSidebar = {
      visible: tabSidebar.rightSidebar.visible,
      widthPx: tabSidebar.rightSidebar.widthPx,
      utility: "outline",
    };
    delete legacySidebar.tabs[0].leftSidebar;
    delete legacySidebar.tabs[0].rightSidebar;
    expect(() =>
      reloadApplicationWindowState(JSON.stringify(legacySidebar)),
    ).toThrow("Unsupported Application Window state schema: 1");

    const missingBuffer = structuredClone(state);
    delete missingBuffer.buffers[`note:${NOTE_A}`];
    expect(() => validateApplicationWindowState(missingBuffer)).toThrow(
      "unknown buffer",
    );

    const badRatio = structuredClone(state);
    if (badRatio.tabs[0].root.type !== "split") {
      throw new Error("Expected split fixture");
    }
    badRatio.tabs[0].root.ratio = 1;
    expect(() => validateApplicationWindowState(badRatio)).toThrow(
      "Split ratio",
    );

    const staleActiveTab = structuredClone(state);
    staleActiveTab.activeTabId = "missing-tab";
    expect(() => validateApplicationWindowState(staleActiveTab)).toThrow(
      "active tab page",
    );

    const staleFocus = structuredClone(state);
    staleFocus.focusOwner = { area: "window", windowId: "window-1" };
    expect(() => validateApplicationWindowState(staleFocus)).toThrow(
      "not the active window",
    );
  });

  it("rejects duplicate identity and invalid legacy migration input", () => {
    const state = splitWindow(initialState(), {
      targetWindowId: "window-1",
      newWindowId: "window-2",
      splitId: "split-1",
      direction: "vertical",
    });
    expect(() =>
      splitWindow(state, {
        targetWindowId: "window-1",
        newWindowId: "window-2",
        splitId: "split-2",
        direction: "horizontal",
      }),
    ).toThrow("Window already exists");
    expect(() =>
      splitWindow(state, {
        targetWindowId: "window-1",
        newWindowId: "window-3",
        splitId: "split-1",
        direction: "horizontal",
      }),
    ).toThrow("Split already exists");
    expect(() =>
      migrateLegacyWindowStates({
        applicationWindowId: "application-window-1",
        tabId: "tab-1",
        windows: [],
      }),
    ).toThrow("at least one window");
    expect(() => createNoteBuffer("not-a-uuid")).toThrow("UUIDv7");
    expect(() =>
      splitWindow(state, {
        targetWindowId: "window-1",
        newWindowId: "window-3",
        splitId: "split-3",
        direction: "diagonal" as "vertical",
      }),
    ).toThrow("split direction");
  });
});
