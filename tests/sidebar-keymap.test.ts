import { describe, expect, it } from "vitest";
import {
  advanceSidebarInput,
  createSidebarInputState,
  sidebarKeymap,
  type SidebarKeyInput,
} from "../app/src/core/sidebar-keymap";
import {
  advanceTreeInput,
  createTreeInputState,
} from "../app/src/core/tree-keymap";

function key(
  value: string,
  modifiers: Partial<SidebarKeyInput> = {},
): SidebarKeyInput {
  return {
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe("Memoka Sidebar application keymap", () => {
  it("resolves Vim Ctrl-w Window commands independently of each utility keymap", () => {
    expect(sidebarKeymap.resolve("sidebar.normal", ":")).toBe(
      "application.command_line",
    );
    const windowPrefix = advanceSidebarInput(
      createSidebarInputState(),
      key("Unidentified", { code: "KeyW", ctrlKey: true }),
    );
    expect(windowPrefix).toMatchObject({
      state: { pending: "window" },
      action: { kind: "pending", prefix: "window" },
      consume: true,
    });
    for (const [direction, command] of [
      ["h", "window.focus-left"],
      ["j", "window.focus-down"],
      ["k", "window.focus-up"],
      ["l", "window.focus-right"],
    ] as const) {
      expect(
        sidebarKeymap.resolve("sidebar.normal", `Ctrl+w ${direction}`),
      ).toBe(command);
      expect(
        advanceSidebarInput(windowPrefix.state, key(direction)),
      ).toMatchObject({
        state: { pending: null },
        action: { kind: "execute", command },
        consume: true,
      });
    }

    expect(
      advanceSidebarInput(
        windowPrefix.state,
        key("Unidentified", { code: "KeyH", ctrlKey: true }),
      ),
    ).toMatchObject({
      action: { kind: "execute", command: "window.focus-left" },
    });

    expect(advanceSidebarInput(windowPrefix.state, key("c"))).toMatchObject({
      action: { kind: "execute", command: "sidebar.close" },
      consume: true,
    });
    expect(advanceSidebarInput(windowPrefix.state, key("o"))).toMatchObject({
      action: { kind: "unmapped" },
      consume: true,
    });
  });

  it("does not treat direct Ctrl-h/j/k/l as Window commands or utility keys", () => {
    expect(sidebarKeymap.resolve("sidebar.normal", "Ctrl+h")).toBeNull();
    expect(
      advanceSidebarInput(
        createSidebarInputState(),
        key("Unidentified", { code: "KeyL", ctrlKey: true }),
      ),
    ).toMatchObject({
      action: { kind: "unmapped" },
      consume: true,
    });
  });

  it("resolves leader search and tab movement as prefix sequences", () => {
    const leader = advanceSidebarInput(createSidebarInputState(), key(","));
    expect(leader).toMatchObject({
      state: { pending: "leader" },
      action: { kind: "pending", prefix: "leader" },
      consume: true,
    });
    expect(advanceSidebarInput(leader.state, key("f"))).toMatchObject({
      state: { pending: null },
      action: { kind: "execute", command: "workspace.search_title" },
    });
    const bodyLeader = advanceSidebarInput(createSidebarInputState(), key(","));
    expect(advanceSidebarInput(bodyLeader.state, key("g"))).toMatchObject({
      state: { pending: null },
      action: { kind: "execute", command: "workspace.search_body" },
    });
    for (const [keyValue, command] of [
      ["t", "utility.toggle-tree"],
      ["o", "utility.toggle-outline"],
      ["b", "workspace.search_buffers"],
      ["c", "application.command_picker"],
      ["s", "note.search"],
    ] as const) {
      const utilityLeader = advanceSidebarInput(
        createSidebarInputState(),
        key(","),
      );
      expect(
        advanceSidebarInput(utilityLeader.state, key(keyValue)),
      ).toMatchObject({
        action: { kind: "execute", command },
      });
    }
    const unavailableLeader = advanceSidebarInput(
      createSidebarInputState(),
      key(","),
    );
    expect(
      advanceSidebarInput(unavailableLeader.state, key("a")),
    ).toMatchObject({
      action: {
        kind: "leader-shortcut",
        resolution: { kind: "unavailable" },
      },
      consume: true,
    });
    const reservedLeader = advanceSidebarInput(
      createSidebarInputState(),
      key(","),
    );
    expect(advanceSidebarInput(reservedLeader.state, key("C"))).toMatchObject({
      action: {
        kind: "leader-shortcut",
        resolution: { kind: "reserved", shortcut: { id: "settings" } },
      },
      consume: true,
    });
    const unknownLeader = advanceSidebarInput(
      createSidebarInputState(),
      key(","),
    );
    expect(advanceSidebarInput(unknownLeader.state, key("x"))).toMatchObject({
      action: {
        kind: "leader-shortcut",
        resolution: { kind: "unmapped", key: "x" },
      },
      consume: true,
    });

    const g = advanceSidebarInput(createSidebarInputState(), key("g"));
    expect(g).toMatchObject({
      state: { pending: "g" },
      consume: false,
    });
    expect(advanceSidebarInput(g.state, key("t"))).toMatchObject({
      action: { kind: "execute", command: "tab.next" },
    });
    expect(advanceSidebarInput(g.state, key("T"))).toMatchObject({
      action: { kind: "execute", command: "tab.previous" },
    });
    expect(
      advanceSidebarInput(g.state, key("Unidentified", { code: "ShiftLeft" })),
    ).toMatchObject({
      state: g.state,
      action: { kind: "unmapped" },
      consume: false,
    });

    const tab = advanceSidebarInput(createSidebarInputState(), key("t"));
    expect(tab).toMatchObject({
      state: { pending: "tab" },
      action: { kind: "pending", prefix: "tab" },
    });
    for (const [keyValue, command] of [
      ["c", "tab.create"],
      ["n", "tab.next"],
      ["p", "tab.previous"],
      ["d", "tab.close"],
      ["1", "tab.select-1"],
      ["9", "tab.select-9"],
      ["0", "tab.select-0"],
    ] as const) {
      expect(advanceSidebarInput(tab.state, key(keyValue))).toMatchObject({
        action: { kind: "execute", command },
      });
    }
  });

  it("passes gg through to Tree while retaining gt/gT application commands", () => {
    const applicationG = advanceSidebarInput(
      createSidebarInputState(),
      key("g"),
    );
    const treeG = advanceTreeInput(createTreeInputState(), key("g"));
    expect(treeG).toMatchObject({
      kind: "pending",
      state: { pending: ["g"], count: "" },
      consume: true,
    });
    expect(advanceSidebarInput(applicationG.state, key("g"))).toMatchObject({
      state: { pending: null },
      action: { kind: "unmapped" },
      consume: false,
    });
    expect(advanceTreeInput(treeG.state, key("g"))).toMatchObject({
      kind: "execute",
      command: "cursor.document-start",
      count: 1,
      countExplicit: false,
    });
  });

  it("resolves Tree counts for motions and absolute gg/G destinations", () => {
    let state = createTreeInputState();
    for (const digit of ["3", "2"]) {
      const resolution = advanceTreeInput(state, key(digit));
      state = resolution.state;
      expect(resolution.kind).toBe("pending");
    }
    expect(advanceTreeInput(state, key("k"))).toMatchObject({
      kind: "execute",
      command: "cursor.logical-up",
      count: 32,
      countExplicit: true,
    });

    const count = advanceTreeInput(createTreeInputState(), key("3"));
    const countG = advanceTreeInput(count.state, key("g"));
    expect(advanceTreeInput(countG.state, key("g"))).toMatchObject({
      kind: "execute",
      command: "cursor.document-start",
      count: 3,
      countExplicit: true,
    });
    expect(advanceTreeInput(count.state, key("G"))).toMatchObject({
      kind: "execute",
      command: "cursor.document-end",
      count: 3,
      countExplicit: true,
    });
  });

  it("keeps a Tree count across the physical Shift keydown for uppercase commands", () => {
    const count = advanceTreeInput(createTreeInputState(), key("2"));
    const shift = advanceTreeInput(
      count.state,
      key("Shift", { code: "ShiftLeft" }),
    );
    expect(shift).toEqual({
      kind: "unmapped",
      state: count.state,
      consume: false,
    });
    expect(advanceTreeInput(shift.state, key("J"))).toMatchObject({
      kind: "execute",
      command: "note.move_down",
      count: 2,
      countExplicit: true,
    });
  });

  it("leaves Space unmapped and cancels a pending Leader without replay", () => {
    expect(
      advanceSidebarInput(createSidebarInputState(), key(" ")),
    ).toMatchObject({ action: { kind: "unmapped" }, consume: false });
    const leader = advanceSidebarInput(createSidebarInputState(), key(","));
    expect(advanceSidebarInput(leader.state, key("Escape"))).toMatchObject({
      action: { kind: "cancel" },
      consume: true,
    });
  });

  it("uses an injected physical Leader key with the semantic bindings", () => {
    const config = { leaderKey: ";" } as const;
    expect(
      advanceSidebarInput(createSidebarInputState(), key(","), config),
    ).toMatchObject({ action: { kind: "unmapped" }, consume: false });
    const leader = advanceSidebarInput(
      createSidebarInputState(),
      key(";"),
      config,
    );
    expect(advanceSidebarInput(leader.state, key("t"), config)).toMatchObject({
      action: { kind: "execute", command: "utility.toggle-tree" },
    });
    const spaceConfig = { leaderKey: " " } as const;
    const spaceLeader = advanceSidebarInput(
      createSidebarInputState(),
      key(" "),
      spaceConfig,
    );
    expect(
      advanceSidebarInput(spaceLeader.state, key("f"), spaceConfig),
    ).toMatchObject({
      action: { kind: "execute", command: "workspace.search_title" },
    });
    expect(
      advanceSidebarInput(createSidebarInputState(), key("g"), {
        leaderKey: "g",
      }),
    ).toMatchObject({
      action: { kind: "pending", prefix: "leader" },
    });
    expect(() =>
      advanceSidebarInput(createSidebarInputState(), key(","), {
        leaderKey: "",
      }),
    ).toThrow("Leader key must be exactly one character");
  });
});
