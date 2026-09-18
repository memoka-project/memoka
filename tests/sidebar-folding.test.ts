import { describe, expect, it } from "vitest";
import {
  foldSidebarSubtree,
  SIDEBAR_FOLD_BINDINGS,
  type SidebarFoldCommand,
} from "../app/src/core/sidebar-folding";
import {
  advanceTreeInput,
  createTreeInputState,
} from "../app/src/core/tree-keymap";

describe("Sidebar folding", () => {
  const entries = [
    { id: "root", depth: 0, foldable: true },
    { id: "child", depth: 1, foldable: true },
    { id: "leaf", depth: 2, foldable: true },
    { id: "sibling", depth: 0, foldable: true },
  ];
  it("shares all six fold sequences without breaking viewport prefixes", () => {
    for (const navigationOnly of [false, true]) {
      for (const [command, sequence] of Object.entries(SIDEBAR_FOLD_BINDINGS)) {
        let state = createTreeInputState();
        for (const key of sequence) {
          const result = advanceTreeInput(
            state,
            { key, ctrlKey: false, altKey: false, metaKey: false },
            undefined,
            navigationOnly,
          );
          state = result.state;
          if (key !== "z")
            expect(result).toMatchObject({ kind: "execute", command });
        }
      }
    }
  });
  it.each<[SidebarFoldCommand, string[], string[]]>([
    ["fold.close", [], ["root"]],
    ["fold.open", ["root", "child"], ["child"]],
    ["fold.toggle", [], ["root"]],
    ["fold.close-recursive", ["sibling"], ["child", "leaf", "root", "sibling"]],
    ["fold.open-recursive", ["root", "child", "leaf", "sibling"], ["sibling"]],
    ["fold.toggle-recursive", ["child"], ["child", "leaf", "root"]],
    ["fold.toggle-recursive", ["root", "child"], []],
  ])(
    "applies %s to the selected subtree including hidden descendants",
    (command, current, expected) => {
      expect(foldSidebarSubtree(entries, "root", current, command)).toEqual(
        expected,
      );
    },
  );
  it("does not add fold state for leaf Tree entries", () => {
    expect(
      foldSidebarSubtree(
        [{ id: "leaf", depth: 0, foldable: false }],
        "leaf",
        [],
        "fold.close",
      ),
    ).toEqual([]);
  });
});
