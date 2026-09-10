import * as Y from "yjs";
import {
  ReplicatedNote,
  replicateSectionSnapshot,
} from "../app/src/core/replicated-note";
import { createUuidV7 } from "../app/src/core/ids";
import legacy from "../tests/fixtures/reader-contract.json";

const fixtures: unknown[] = [];
function capture(name: string, note: ReplicatedNote) {
  const projection = note.project();
  fixtures.push({
    name,
    noteId: note.noteId,
    snapshot: [...note.snapshot()],
    projection: {
      root: note.sectionSnapshot(),
      recovery: projection.recovery,
      depthCorrections: projection.depthCorrections,
    },
  });
}
const source = replicateSectionSnapshot(legacy.expected, createUuidV7());
capture("legacy-content-and-identities", source);
const a = ReplicatedNote.load(source.noteId, createUuidV7(), source.snapshot());
const b = ReplicatedNote.load(source.noteId, createUuidV7(), source.snapshot());
const x = a.createEntity("section", a.noteId, "sections", "a0", {
  inline: [{ type: "text", text: "A" }],
});
const y = a.createEntity("section", a.noteId, "sections", "a1", {
  inline: [{ type: "text", text: "B" }],
});
b.applyUpdate(a.snapshot());
a.move(x, y, "sections", "a0");
b.move(y, x, "sections", "a0");
a.applyUpdate(b.snapshot());
capture("cycle-and-offline-moves", a);
const block = [...a.entities.values()].find(
  (entity) => entity.type === "paragraph",
)!.id;
const del = a.delete(block);
b.applyUpdate(a.snapshot());
b.transact(() =>
  (b.inline(block).get(0) as Y.XmlText).insert(0, "protected edit"),
);
const other = b.delete(block);
a.restore(del.operationId);
a.applyUpdate(b.snapshot());
capture("observed-restore-and-concurrent-delete", a);
a.restore(other.operationId);
let parent = a.noteId;
for (let index = 0; index < 4; index++)
  parent = a.createEntity("section", parent, "sections", "a0");
const moving = a.createEntity("section", a.noteId, "sections", "a2");
b.applyUpdate(a.snapshot());
a.move(moving, parent, "sections", "a0");
b.createEntity("section", moving, "sections", "a0");
a.applyUpdate(b.snapshot());
capture("H6-projection-correction", a);
const table = [...a.entities.values()].find(
  (entity) => entity.type === "table",
)!.id;
b.applyUpdate(a.snapshot());
a.createEntity("tableRow", table, "rows", "Zz");
b.createEntity("tableColumn", table, "columns", "Zz");
a.applyUpdate(b.snapshot());
capture("stable-table-intersection", a);
const column = [...a.entities.values()].find(
  (entity) => entity.type === "tableColumn",
)!.id;
a.delete(column);
capture("deleted-column-preserves-cell-data", a);
const linked = source.createEntity("paragraph", source.noteId, "body", "a0", {
  inline: [
    {
      type: "internalSectionLink",
      attrs: { targetSectionId: source.noteId },
      content: [
        { type: "text", text: "保存されるリンク名", marks: [{ type: "bold" }] },
      ],
    },
  ],
});
capture("labelled-internal-link", source);
source.delete(linked);
capture("protected-labelled-internal-link", source);
source.destroy();
a.destroy();
b.destroy();
process.stdout.write(JSON.stringify(fixtures));
