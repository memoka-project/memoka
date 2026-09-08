import { describe, expect, it } from "vitest";
import {
  createVimRepeatDescriptor,
  VimRepeatStore,
} from "../app/src/vim/repeat";

describe("Memoka semantic dot-repeat descriptor", () => {
  it("stores Visual Char geometry immutably and waits for completed change input", () => {
    const candidate = {
      mode: "visual-char" as const,
      command: "selection.change" as const,
      operator: null,
      count: 1,
      countExplicit: false,
      visualChar: {
        lines: 2,
        columns: 4,
        toLineEnd: false,
        acrossCells: false,
      },
    };
    expect(createVimRepeatDescriptor(candidate)).toBeNull();
    const descriptor = createVimRepeatDescriptor({
      ...candidate,
      command: "replace.character",
      argument: "x",
    });
    expect(descriptor?.visualChar).toEqual(candidate.visualChar);
    if (!descriptor) throw new Error("descriptor was not created");
    const store = new VimRepeatStore();
    store.record(descriptor);
    candidate.visualChar.columns = 90;
    descriptor.visualChar!.lines = 50;
    store.read()!.visualChar!.toLineEnd = true;
    expect(store.read()?.visualChar).toEqual({
      lines: 2,
      columns: 4,
      toLineEnd: false,
      acrossCells: false,
    });
  });
  it("records immediate edits and delete Operators without transactions", () => {
    expect(
      createVimRepeatDescriptor({
        mode: "normal",
        command: "motion.word-forward",
        operator: "delete",
        count: 2,
        countExplicit: true,
      }),
    ).toEqual({
      command: "motion.word-forward",
      operator: "delete",
      count: 2,
      countExplicit: true,
    });
    expect(
      createVimRepeatDescriptor({
        mode: "normal",
        command: "replace.character",
        operator: null,
        count: 1,
        countExplicit: false,
        argument: "語",
      }),
    ).toMatchObject({ command: "replace.character", argument: "語" });
  });

  it("does not record navigation, yank, or an unfinished Insert change", () => {
    expect(
      createVimRepeatDescriptor({
        mode: "normal",
        command: "cursor.right",
        operator: null,
        count: 1,
        countExplicit: false,
      }),
    ).toBeNull();
    expect(
      createVimRepeatDescriptor({
        mode: "normal",
        command: "line.yank",
        operator: null,
        count: 1,
        countExplicit: false,
      }),
    ).toBeNull();
    expect(
      createVimRepeatDescriptor({
        mode: "insert",
        command: "line.change",
        operator: null,
        count: 1,
        countExplicit: false,
      }),
    ).toBeNull();
  });

  it("records Table Visual Block mutations with immutable dimensions", () => {
    const candidate = createVimRepeatDescriptor({
      mode: "visual-block",
      command: "selection.change",
      operator: null,
      count: 1,
      countExplicit: false,
      tableRectangle: { width: 3, height: 2 },
    });
    expect(candidate).toEqual({
      command: "selection.change",
      operator: null,
      count: 1,
      countExplicit: false,
      tableRectangle: { width: 3, height: 2 },
    });
    if (!candidate?.tableRectangle) {
      throw new Error("Table repeat descriptor was not created");
    }
    const store = new VimRepeatStore();
    store.record(candidate);
    candidate.tableRectangle.width = 9;
    expect(store.read()?.tableRectangle).toEqual({ width: 3, height: 2 });

    expect(
      createVimRepeatDescriptor({
        mode: "visual-block",
        command: "selection.yank",
        operator: null,
        count: 1,
        countExplicit: false,
        tableRectangle: { width: 1, height: 1 },
      }),
    ).toBeNull();
  });

  it("keeps a Window-local immutable descriptor snapshot", () => {
    const descriptor = createVimRepeatDescriptor({
      mode: "normal",
      command: "character.delete",
      operator: null,
      count: 1,
      countExplicit: false,
    });
    if (!descriptor) throw new Error("descriptor was not created");
    const store = new VimRepeatStore();
    store.record(descriptor);
    descriptor.count = 9;
    const snapshot = store.read();
    if (!snapshot) throw new Error("descriptor was not stored");
    snapshot.count = 7;

    expect(store.read()?.count).toBe(1);
  });
});
