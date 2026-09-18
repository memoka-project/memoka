import { afterEach, describe, expect, it } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import {
  replicateSectionSnapshot,
  type ReplicatedNote,
} from "../app/src/core/replicated-note";
import { applyReplicatedSectionSnapshot } from "../app/src/core/replicated-note-edit";
import type { SectionSnapshot } from "../app/src/core/section-model";

const notes: ReplicatedNote[] = [];
afterEach(() => {
  for (const note of notes.splice(0)) note.destroy();
});
function fixture() {
  const sectionId = createUuidV7(),
    blockId = createUuidV7(),
    otherId = createUuidV7();
  const snapshot: SectionSnapshot = {
    sectionId: createUuidV7(),
    title: "Note",
    tags: [],
    body: [],
    children: [
      {
        sectionId,
        title: "Restore",
        tags: [],
        body: [
          {
            type: "paragraph",
            attrs: { blockId },
            content: [{ type: "text", text: "Body" }],
          },
        ],
        children: [],
      },
      {
        sectionId: otherId,
        title: "Remain deleted",
        tags: [],
        body: [],
        children: [],
      },
    ],
  };
  const note = replicateSectionSnapshot(snapshot, createUuidV7());
  notes.push(note);
  return { note, snapshot, sectionId, blockId, otherId };
}

describe("explicit replicated snapshot recovery", () => {
  it("does not restore protected identities without explicit permission", () => {
    const { note, snapshot, sectionId } = fixture();
    note.delete(sectionId);
    const before = note.snapshot();
    expect(() =>
      applyReplicatedSectionSnapshot(note, snapshot, "test"),
    ).toThrow("Protected identities require explicit recovery");
    expect(note.snapshot()).toEqual(before);
    expect(note.restorations.size).toBe(0);
  });

  it("cancels all observed deletes only for the identities requested by the snapshot", () => {
    const { note, snapshot, sectionId, blockId, otherId } = fixture();
    note.deleteMany([sectionId, otherId]);
    note.delete(sectionId);
    const desired = { ...snapshot, children: snapshot.children.slice(0, 1) };
    applyReplicatedSectionSnapshot(note, desired, "test", {
      recoverProtectedIdentities: true,
    });
    expect(note.sectionSnapshot()).toEqual(desired);
    expect(note.project().visible.has(blockId)).toBe(true);
    expect(note.project().visible.has(otherId)).toBe(false);
    expect(note.restorations.size).toBe(2);
    applyReplicatedSectionSnapshot(note, desired, "test", {
      recoverProtectedIdentities: true,
    });
    expect(note.restorations.size).toBe(2);
  });

  it("does not expose unrequested children when their deleted parent is restored", () => {
    const { note, snapshot, sectionId } = fixture();
    note.delete(sectionId);
    const hiddenChild = note.createEntity(
      "paragraph",
      sectionId,
      "body",
      "a1",
      {
        inline: [{ type: "text", text: "not in the managed source" }],
      },
    );
    expect(note.project().visible.has(hiddenChild)).toBe(false);
    applyReplicatedSectionSnapshot(note, snapshot, "test", {
      recoverProtectedIdentities: true,
    });
    expect(note.sectionSnapshot()).toEqual(snapshot);
    expect(note.project().visible.has(hiddenChild)).toBe(false);
  });
});
