import { describe, expect, it } from "vitest";
import {
  createVimRepeatDescriptor,
  VimRepeatStore,
} from "../app/src/vim/repeat";

describe("Memoka semantic dot-repeat descriptor", () => {
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
