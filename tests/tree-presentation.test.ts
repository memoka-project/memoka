import { describe, expect, it } from "vitest";
import { treeGuides } from "../app/src/core/tree-guides";
import type { VisibleNoteTreeEntry } from "../app/src/core/note-tree";

describe("Tree guide ranges", () => {
  it("ends each guide at its subtree boundary, including nested and collapsed branches", () => {
    const entries = [
      ["parent", 0, true, true],
      ["nested", 1, true, true],
      ["leaf", 2, false, true],
      ["closed", 1, true, false],
      ["root", 0, false, true],
    ].map(([id, depth, hasChildren, expanded]) => ({
      note: { noteId: id },
      depth,
      hasChildren,
      expanded,
    })) as VisibleNoteTreeEntry[];
    expect(
      treeGuides(entries.map((entry) => ({ ...entry, id: entry.note.noteId }))),
    ).toEqual([
      { id: "parent", depth: 0, start: 1, end: 4 },
      { id: "nested", depth: 1, start: 2, end: 3 },
    ]);
    expect(treeGuides([])).toEqual([]);
  });
});
