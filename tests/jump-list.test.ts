import { describe, expect, it } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { WindowJumpList } from "../app/src/core/jump-list";
import type { StableEditorPosition } from "../app/src/core/stable-position";

function uuid(seed: number): string {
  return createUuidV7(1_799_000_000_000 + seed, (bytes) => {
    bytes.fill(seed);
    return bytes;
  });
}

function entry(
  noteId: string,
  blockId: string,
  offset: number,
): StableEditorPosition {
  return {
    noteId,
    blockId,
    offset,
    before: `before-${offset}`,
    after: `after-${offset}`,
    relative: new Uint8Array([offset + 1]),
  };
}

describe("Memoka Window-local Jump List", () => {
  it("moves backward and forward without sharing state between Windows", () => {
    const noteId = uuid(1);
    const a = entry(noteId, "a", 0);
    const b = entry(noteId, "b", 1);
    const c = entry(noteId, "c", 2);
    const first = new WindowJumpList("window-1");
    const second = new WindowJumpList("window-2");
    first.recordOrigin(a);
    first.recordOrigin(b);

    expect(first.back(c)).toEqual(b);
    expect(first.back(b)).toEqual(a);
    expect(first.forward(a)).toEqual(b);
    expect(first.forward(b)).toEqual(c);
    expect(second.back(c)).toBeNull();
  });

  it("truncates forward history after a new explicit jump", () => {
    const noteId = uuid(2);
    const a = entry(noteId, "a", 0);
    const b = entry(noteId, "b", 1);
    const c = entry(noteId, "c", 2);
    const d = entry(noteId, "d", 3);
    const jumps = new WindowJumpList("window-1");
    jumps.recordOrigin(a);
    jumps.recordOrigin(b);
    expect(jumps.back(c)).toEqual(b);

    jumps.recordOrigin(b);
    expect(jumps.snapshot().forward).toEqual([]);
    expect(jumps.back(d)).toEqual(b);
    expect(jumps.forward(b)).toEqual(d);
  });

  it("keeps distinct Focus boundaries at the same caret location", () => {
    const noteId = uuid(6);
    const childId = uuid(7);
    const rootView = { ...entry(noteId, "same", 3), sectionId: noteId };
    const childView = { ...entry(noteId, "same", 3), sectionId: childId };
    const jumps = new WindowJumpList("window-1");

    jumps.recordOrigin(rootView);
    jumps.recordOrigin(childView);
    expect(jumps.snapshot().back).toEqual([rootView, childView]);
    expect(jumps.back(rootView)).toEqual(childView);
  });

  it("skips unavailable notes, bounds history, and protects stored bytes", () => {
    const liveNote = uuid(3);
    const deletedNote = uuid(4);
    const a = entry(liveNote, "a", 0);
    const b = entry(liveNote, "b", 1);
    const deleted = entry(deletedNote, "deleted", 2);
    const current = entry(liveNote, "current", 3);
    const jumps = new WindowJumpList("window-1", 2);
    jumps.recordOrigin(a);
    jumps.recordOrigin(b);
    jumps.recordOrigin(deleted);
    deleted.relative[0] = 99;

    const snapshot = jumps.snapshot();
    expect(snapshot.back).toHaveLength(2);
    snapshot.back[0].relative[0] = 88;
    expect(jumps.snapshot().back[0].relative[0]).not.toBe(88);
    expect(jumps.back(current, ({ noteId }) => noteId === liveNote)).toEqual(b);
  });

  it("rejects malformed entries instead of corrupting history", () => {
    const jumps = new WindowJumpList("window-1");
    expect(() =>
      jumps.recordOrigin({
        ...entry(uuid(5), "bad", 0),
        relative: new Uint8Array(),
      }),
    ).toThrow("Jump relative position must not be empty");
  });
});
