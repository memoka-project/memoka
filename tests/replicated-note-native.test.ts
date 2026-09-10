import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import fixture from "./fixtures/replicated-note-native.json";
import { ReplicatedNote } from "../app/src/core/replicated-note";
import { createUuidV7 } from "../app/src/core/ids";

const notes: ReplicatedNote[] = [];
afterEach(() => {
  for (const note of notes.splice(0)) note.destroy();
});
function fresh() {
  const note = ReplicatedNote.load(
    fixture.noteId,
    createUuidV7(),
    new Uint8Array(fixture.snapshot),
  );
  notes.push(note);
  return note;
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, value]) =>
            !["attrs", "content", "marks"].includes(key) ||
            !(
              value &&
              typeof value === "object" &&
              Object.keys(value).length === 0
            ),
        )
        .map(([key, value]) => [key, normalized(value)]),
    );
  return value;
}
function projection(note: ReplicatedNote) {
  return normalized({
    root: note.sectionSnapshot(),
    recovery: note.project().recovery,
    depthCorrections: note.project().depthCorrections,
  });
}
describe("native edits merged by the product CRDT", () => {
  it("merges Rust movement and Unicode text in either order without replacing text identity", () => {
    for (const updates of [
      [fixture.moveUpdate, fixture.textUpdate],
      [fixture.textUpdate, fixture.moveUpdate, fixture.moveUpdate],
    ]) {
      const note = fresh(),
        inline = note.inline(fixture.editedBlockId).get(0);
      for (const update of updates) note.applyUpdate(new Uint8Array(update));
      expect(note.inline(fixture.editedBlockId).get(0)).toBe(inline);
      expect(projection(note)).toEqual(normalized(fixture.merged));
    }
  });
  it("retains a third replica's edit through native deletion and observed recovery", () => {
    const peer = fresh(),
      destination = fresh();
    peer.transact(() =>
      (peer.inline(fixture.editedBlockId).get(0) as Y.XmlText).insert(0, "JS "),
    );
    for (const update of [fixture.textUpdate, fixture.deleteUpdate])
      destination.applyUpdate(new Uint8Array(update));
    expect(projection(destination)).toEqual(normalized(fixture.deleted));
    destination.applyUpdate(peer.snapshot());
    expect(destination.project().visible.has(fixture.editedBlockId)).toBe(
      false,
    );
    const pending = destination.activeDeletions(fixture.deletedSectionId);
    expect(pending).toHaveLength(1);
    destination.restore(pending[0]!);
    const text = destination
      .inlineContent(fixture.editedBlockId)
      .map((node) => node.text ?? "")
      .join("");
    expect(text).toContain("JS ");
    expect(text).toContain("🙂 Rust ");
    expect(destination.project().visible.has(fixture.editedBlockId)).toBe(true);
  });
});
