import { describe, expect, it } from "vitest";
import {
  LEADER_SHORTCUT_CATALOG,
  leaderShortcutMessage,
  resolveLeaderShortcut,
} from "../app/src/core/leader-shortcuts";

describe("Leader shortcut catalog", () => {
  it("owns unique, case-sensitive category keys", () => {
    const keys = LEADER_SHORTCUT_CATALOG.map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(resolveLeaderShortcut("c", "editor")).toMatchObject({
      kind: "execute",
      command: "application.command_picker",
    });
    expect(resolveLeaderShortcut("C", "editor")).toMatchObject({
      kind: "reserved",
      shortcut: { id: "settings" },
    });
  });

  it("distinguishes unavailable, reserved, and unmapped input", () => {
    expect(resolveLeaderShortcut("a", "sidebar")).toMatchObject({
      kind: "unavailable",
      shortcut: { id: "context-actions" },
    });
    expect(resolveLeaderShortcut("s", "empty-window")).toMatchObject({
      kind: "unavailable",
      shortcut: { id: "note-search" },
    });
    const reserved = resolveLeaderShortcut("p", "empty-window");
    expect(reserved).toMatchObject({
      kind: "reserved",
      shortcut: { id: "paste" },
    });
    if (reserved.kind !== "reserved") throw new Error("expected reserved");
    expect(leaderShortcutMessage(reserved, ";")).toBe(
      ";p · Paste / Yank History · 予約済み（未実装）",
    );
    expect(resolveLeaderShortcut("x", "editor")).toEqual({
      kind: "unmapped",
      key: "x",
    });
  });
});
