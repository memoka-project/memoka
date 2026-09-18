import { describe, expect, it } from "vitest";
import { createSidebarJumpList } from "../app/src/core/jump-list";
import { navigateSidebar } from "../app/src/core/sidebar-navigation";
import {
  advanceTreeInput,
  createTreeInputState,
} from "../app/src/core/tree-keymap";
import {
  advanceSidebarInput,
  createSidebarInputState,
} from "../app/src/core/sidebar-keymap";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { activeTab } from "../app/src/core/application-state";

const items = Array.from({ length: 30 }, (_, i) => ({
  id: `row-${i}`,
  parentId: null,
  top: i * 28,
  bottom: (i + 1) * 28,
}));
function harness() {
  const history = createSidebarJumpList();
  let selectedId = "row-10";
  let scrollTop = 280;
  return {
    history,
    run(command: string, count = 1, countExplicit = false) {
      const result = navigateSidebar({
        command,
        count,
        countExplicit,
        items,
        selectedId,
        scrollTop,
        height: 280,
        scrollHeight: 840,
        history,
      });
      if (result) {
        selectedId = result.selectedId;
        scrollTop = result.scrollTop;
      }
      return result;
    },
  };
}

describe("shared Sidebar navigation", () => {
  it("scopes runtime histories to each TabPage and resets Outline on note change", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const firstTab = activeTab(runtime.snapshot().applicationWindow).id;
      const tree = runtime.sidebarJumpListFor(firstTab, "tree");
      const outline = runtime.sidebarJumpListFor(firstTab, "outline", "note-a");
      tree.recordOrigin("tree-entry");
      outline.recordOrigin("section-a");
      await runtime.updateSidebar({ side: "left", visible: false });
      await runtime.updateSidebar({ side: "left", visible: true });
      expect(runtime.sidebarJumpListFor(firstTab, "tree")).toBe(tree);
      expect(
        runtime.sidebarJumpListFor(firstTab, "outline", "note-a").snapshot()
          .back,
      ).toEqual(["section-a"]);
      expect(
        runtime.sidebarJumpListFor(firstTab, "outline", "note-b").snapshot()
          .back,
      ).toEqual([]);
      expect(tree.snapshot().back).toEqual(["tree-entry"]);
      await runtime.createEditorTab();
      const secondTab = activeTab(runtime.snapshot().applicationWindow).id;
      const second = runtime.sidebarJumpListFor(secondTab, "tree");
      expect(second.snapshot().back).toEqual([]);
      second.recordOrigin("other");
      await runtime.switchEditorTab(firstTab);
      expect(runtime.sidebarJumpListFor(firstTab, "tree")).toBe(tree);
      await runtime.closeEditorTab(secondTab);
      expect(runtime.sidebarJumpListFor(secondTab, "tree")).not.toBe(second);
    } finally {
      runtime.destroy();
    }
  });
  it.each([
    ["cursor.screen-top", 2, "row-11"],
    ["cursor.screen-middle", 3, "row-14"],
    ["cursor.screen-bottom", 2, "row-18"],
    ["cursor.document-start", 1, "row-0"],
    ["cursor.document-end", 1, "row-29"],
    ["cursor.logical-down", 3, "row-13"],
    ["cursor.page-down", 1, "row-18"],
    ["cursor.half-page-down", 1, "row-15"],
  ])("handles %s with counts", (command, count, target) => {
    expect(harness().run(command as string, count as number)?.selectedId).toBe(
      target,
    );
  });

  it("records only jumps, handles backward/forward and forks history", () => {
    const h = harness();
    h.run("cursor.logical-down", 2);
    h.run("viewport.center");
    expect(h.history.snapshot().back).toEqual([]);
    h.run("cursor.document-end");
    expect(h.history.snapshot().back).toEqual(["row-12"]);
    h.run("cursor.document-start");
    expect(h.run("navigation.jump-back", 2)?.selectedId).toBe("row-12");
    expect(h.run("navigation.jump-forward")?.selectedId).toBe("row-29");
    h.run("cursor.document-start", 4, true);
    expect(h.history.snapshot().forward).toEqual([]);
    h.run("cursor.document-start", 4, true);
    expect(h.history.snapshot().back).toEqual(["row-12", "row-29"]);
  });

  it("aligns rows and scrolls without returning to an offscreen selection", () => {
    const h = harness();
    expect(h.run("viewport.scroll-down")).toEqual({
      selectedId: "row-11",
      scrollTop: 308,
    });
    expect(h.run("viewport.scroll-up")).toEqual({
      selectedId: "row-11",
      scrollTop: 280,
    });
    expect(h.run("viewport.center")).toEqual({
      selectedId: "row-11",
      scrollTop: 182,
    });
    expect(h.run("viewport.bottom")).toEqual({
      selectedId: "row-11",
      scrollTop: 56,
    });
    expect(h.history.snapshot().back).toEqual([]);
    expect(h.run("viewport.top", 20, true)).toEqual({
      selectedId: "row-19",
      scrollTop: 532,
    });
    expect(h.history.snapshot().back).toEqual(["row-11"]);
  });

  it("skips deleted entries and resolves folded entries to a visible ancestor", () => {
    const history = createSidebarJumpList();
    history.recordOrigin("hidden");
    history.recordOrigin("deleted");
    const result = navigateSidebar({
      command: "navigation.jump-back",
      count: 1,
      countExplicit: false,
      items,
      selectedId: "row-10",
      scrollTop: 280,
      height: 280,
      scrollHeight: 840,
      history,
      resolveHistoryId: (id) => (id === "hidden" ? "row-2" : null),
    });
    expect(result?.selectedId).toBe("row-2");
    expect(history.snapshot().forward).toEqual(["row-10"]);
  });

  it("caps history and isolates each instance", () => {
    const a = createSidebarJumpList(),
      b = createSidebarJumpList();
    for (let i = 0; i < 110; i++) a.recordOrigin(`item-${i}`);
    expect(a.snapshot().back).toHaveLength(100);
    expect(b.snapshot().back).toEqual([]);
  });

  it.each(["b", "f", "d", "u", "e", "y", "o", "i"])(
    "passes Ctrl-%s through application routing",
    (key) => {
      const event = {
        key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
      };
      expect(
        advanceSidebarInput(createSidebarInputState(), event).consume,
      ).toBe(false);
      expect(advanceTreeInput(createTreeInputState(), event).kind).toBe(
        "execute",
      );
    },
  );

  it("uses << and >> for hierarchy, leaving H/M/L for navigation", () => {
    const key = (value: string) => ({
      key: value,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    for (const [sequence, command] of [
      ["<<", "note.move_outdent"],
      [">>", "note.move_indent"],
      ["H", "cursor.screen-top"],
      ["M", "cursor.screen-middle"],
      ["L", "cursor.screen-bottom"],
    ]) {
      let state = createTreeInputState();
      for (const value of sequence) {
        const result = advanceTreeInput(state, key(value));
        state = result.state;
        if (result.kind === "execute") expect(result.command).toBe(command);
      }
    }
    const pending = advanceTreeInput(createTreeInputState(), key("2"));
    expect(advanceTreeInput(pending.state, key("Escape"))).toMatchObject({
      kind: "unmapped",
      consume: true,
      state: createTreeInputState(),
    });
  });
});
