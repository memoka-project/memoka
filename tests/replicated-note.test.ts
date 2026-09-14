import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createUuidV7 } from "../app/src/core/ids";
import {
  ReplicatedNote,
  replicateSectionSnapshot,
} from "../app/src/core/replicated-note";
import { deriveReplicatedTree } from "../app/src/core/replicated-tree";
import contract from "./fixtures/replicated-note-contract.json";

const open: ReplicatedNote[] = [];
afterEach(() => {
  for (const note of open.splice(0)) note.destroy();
});
function track(note: ReplicatedNote): ReplicatedNote {
  open.push(note);
  return note;
}
function fresh(): ReplicatedNote {
  return track(ReplicatedNote.create(createUuidV7(), createUuidV7(), "Note"));
}
function fork(note: ReplicatedNote): ReplicatedNote {
  return track(
    ReplicatedNote.load(note.noteId, createUuidV7(), note.snapshot()),
  );
}
function text(note: ReplicatedNote, id: string): Y.XmlText {
  return note.inline(id).get(0) as Y.XmlText;
}
function section(
  note: ReplicatedNote,
  parent = note.noteId,
  title = "Section",
): string {
  return note.createEntity("section", parent, "sections", "a0", {
    inline: [{ type: "text", text: title }],
  });
}
function paragraph(
  note: ReplicatedNote,
  parent = note.noteId,
  content = "abc",
): string {
  return note.createEntity("paragraph", parent, "body", "a0", {
    inline: [{ type: "text", text: content }],
  });
}
function exchange(...notes: ReplicatedNote[]): void {
  const updates = notes.map((note) => note.snapshot());
  for (const [index, note] of notes.entries())
    for (const update of index % 2 ? [...updates].reverse() : updates) {
      note.applyUpdate(update);
      note.applyUpdate(update);
    }
  for (const note of notes) {
    note.validate();
    expect(note.sectionSnapshot()).toEqual(notes[0]!.sectionSnapshot());
    expect(note.project().recovery).toEqual(notes[0]!.project().recovery);
  }
}

describe("stable replicated Note model", () => {
  it("rejects excessive structure depth and unknown marks before changing the live document", () => {
    const a = fresh(),
      id = paragraph(a),
      malformed = fork(a),
      before = a.snapshot();
    malformed.transact(() =>
      text(malformed, id).format(0, 1, { unknownMark: {} }),
    );
    expect(() => a.applyUpdate(malformed.snapshot())).toThrow(/mark/);
    const badLink = fork(a);
    badLink.transact(() => {
      const link = new Y.XmlElement("internalSectionLink");
      link.setAttribute("targetSectionId", a.noteId);
      link.insert(0, [new Y.XmlElement("hardBreak")]);
      badLink.inline(id).insert(1, [link]);
    });
    expect(() => a.applyUpdate(badLink.snapshot())).toThrow(/text label/);
    const deep = fork(a);
    let parent = deep.noteId;
    for (let index = 0; index < 130; index++)
      parent = deep.createEntity(
        "blockquote",
        parent,
        index === 0 ? "body" : "content",
        "a0",
      );
    expect(() => a.applyUpdate(deep.snapshot())).toThrow(/depth/);
    expect(a.snapshot()).toEqual(before);
  });
  it.each(contract)("matches the shared Yjs/Yrs fixture: $name", (fixture) => {
    const note = track(
      ReplicatedNote.load(
        fixture.noteId,
        createUuidV7(),
        Uint8Array.from(fixture.snapshot),
      ),
    );
    expect({
      root: note.sectionSnapshot(),
      recovery: note.project().recovery,
      depthCorrections: note.project().depthCorrections,
    }).toEqual(fixture.projection);
  });

  it("converges for every three-replica delivery permutation, including duplicate delivery", () => {
    const source = fresh(),
      x = section(source),
      y = section(source),
      block = paragraph(source, x);
    const writers = [fork(source), fork(source), fork(source)];
    writers[0]!.move(x, y, "sections", "a0");
    writers[1]!.move(y, x, "sections", "a0");
    writers[2]!.delete(block);
    for (const [index, writer] of writers.entries())
      writer.transact(() => text(writer, block).insert(1, String(index)));
    const states = writers.map((writer) => writer.snapshot());
    let expected: unknown;
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const receiver = fork(source);
      for (const index of order) {
        receiver.applyUpdate(states[index]!);
        receiver.applyUpdate(states[index]!);
      }
      const result = {
        root: receiver.sectionSnapshot(),
        recovery: receiver.project().recovery,
        text: receiver.inlineContent(block),
        parents: [...receiver.project().parents].sort(),
      };
      expected ??= result;
      expect(result).toEqual(expected);
    }
  });

  it("protects inline text when a concurrent type change cannot display it", () => {
    const a = fresh(),
      id = paragraph(a),
      b = fork(a);
    a.transact(() => a.attributes(id).set("type", "horizontalRule"));
    b.transact(() => text(b, id).insert(3, " protected"));
    exchange(a, b);
    expect(a.project().recovery).toContainEqual({
      entityId: id,
      reason: "incompatible-type",
      deletionIds: [],
    });
    expect(text(a, id).toString()).toBe("abc protected");
    a.transact(() => a.attributes(id).set("type", "paragraph"));
    exchange(a, b);
    expect(a.project().recovery).toEqual([]);
  });

  it("undoes multi-element text edits with a scope bounded by the edited elements", () => {
    const a = fresh(),
      x = paragraph(a),
      y = paragraph(a);
    a.clearUndo();
    a.transact(() => {
      text(a, x).insert(0, "X");
      text(a, y).insert(0, "Y");
    });
    expect(a.undoManager.scope).toHaveLength(2);
    a.history.stopCapturing();
    a.transact(() => text(a, x).insert(0, "Z"));
    expect(a.undoManager.scope).toHaveLength(1);
    a.undo();
    expect(text(a, x).toString()).toBe("Xabc");
    a.undo();
    expect(text(a, x).toString()).toBe("abc");
    expect(text(a, y).toString()).toBe("abc");
    a.redo();
    expect(text(a, x).toString()).toBe("Xabc");
    expect(text(a, y).toString()).toBe("Yabc");
  });

  it("leaves updates with missing dependencies for the inbox to retry", () => {
    const a = fresh(),
      id = paragraph(a),
      b = fork(a);
    b.transact(() => text(b, id).insert(1, "first"));
    const boundary = Y.encodeStateVector(b.doc);
    b.transact(() => text(b, id).insert(2, "second"));
    const second = Y.encodeStateAsUpdate(b.doc, boundary),
      before = a.snapshot();
    expect(() => a.applyUpdate(second)).toThrow(/dependencies/);
    expect(a.snapshot()).toEqual(before);
    a.applyUpdate(b.snapshot());
    expect(text(a, id).toString()).toBe(text(b, id).toString());
  });
  it("retains the same shared content when a section moves during a remote edit", () => {
    const a = fresh();
    const moving = section(a);
    const target = section(a);
    const block = paragraph(a, moving);
    const b = fork(a),
      c = fork(a);
    const original = a.inline(block);
    a.move(moving, target, "sections", "a0");
    b.transact(() => text(b, block).insert(1, "B"));
    c.transact(() => text(c, block).insert(2, "C"));
    exchange(c, a, b);
    expect(a.inline(block)).toBe(original);
    expect(text(a, block).toString()).toBe("aBbCc");
    expect(a.project().parents.get(moving)?.parentId).toBe(target);
  });

  it("derives a cycle-free tree without writing corrective updates", () => {
    const a = fresh();
    const x = section(a),
      y = section(a);
    const b = fork(a),
      c = fork(a);
    a.move(x, y, "sections", "a0");
    b.move(y, x, "sections", "a0");
    exchange(a, b, c);
    const before = a.snapshot();
    const tree = a.project();
    expect(tree.reverted.size).toBe(1);
    for (const id of [x, y]) {
      const seen = new Set<string>();
      let current: string | undefined = id;
      while (current) {
        expect(seen.has(current)).toBe(false);
        seen.add(current);
        current = tree.parents.get(current)?.parentId;
      }
    }
    expect(a.snapshot()).toEqual(before);
  });

  it("stabilizes corrected ancestors only as part of a subsequent explicit move", () => {
    const a = fresh();
    const x = section(a),
      y = section(a),
      target = section(a);
    const b = fork(a);
    a.move(x, y, "sections", "a0");
    b.move(y, x, "sections", "a0");
    exchange(a, b);
    const corrected = [...a.project().reverted][0]!;
    const child = corrected === x ? y : x;
    a.move(child, target, "sections", "a0");
    expect(a.project().parents.get(corrected)?.parentId).toBe(a.noteId);
    exchange(a, b);
  });

  it("keeps concurrently edited deleted content and only cancels observed deletions", () => {
    const a = fresh();
    const id = paragraph(a);
    const b = fork(a),
      c = fork(a);
    const deletion = a.delete(id);
    b.transact(() => text(b, id).insert(3, " edited"));
    a.restore(deletion.operationId);
    const concurrentDeletion = c.delete(id);
    exchange(a, b, c);
    expect(a.project().visible.has(id)).toBe(false);
    expect(a.activeDeletions(id)).toEqual([concurrentDeletion.operationId]);
    expect(text(a, id).toString()).toBe("abc edited");
    a.restore(concurrentDeletion.operationId);
    exchange(a, b, c);
    expect(a.project().visible.has(id)).toBe(true);
  });

  it("protects a new child of a concurrently deleted parent and restores it", () => {
    const a = fresh();
    const parent = section(a);
    const b = fork(a);
    const deletion = a.delete(parent);
    const child = paragraph(b, parent, "offline child");
    exchange(a, b);
    expect(a.project().recovery).toContainEqual({
      entityId: child,
      reason: "deleted-parent",
      deletionIds: [],
    });
    a.restore(deletion.operationId);
    exchange(a, b);
    expect(a.sectionSnapshot().children[0]!.body[0]).toMatchObject({
      attrs: { blockId: child },
    });
  });

  it("corrects concurrent H6 overflow only in the projection", () => {
    const a = fresh();
    let parent = a.noteId;
    for (let depth = 1; depth <= 4; depth++)
      parent = section(a, parent, String(depth));
    const moving = section(a);
    const b = fork(a);
    a.move(moving, parent, "sections", "a0");
    const leaf = section(b, moving);
    exchange(a, b);
    expect(a.project().depthCorrections).toEqual([leaf]);
    expect(a.project().parents.get(leaf)?.parentId).toBe(parent);
    expect(
      [...a.placements.values()].filter((edge) => edge.entityId === leaf).at(-1)
        ?.parentId,
    ).toBe(moving);
  });

  it("copies with fresh identities and preserves marks and inline links", () => {
    const a = fresh(),
      parent = section(a);
    const id = a.createEntity("paragraph", parent, "body", "a0", {
      inline: [
        { type: "text", text: "plain" },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        {
          type: "internalSectionLink",
          attrs: { targetSectionId: parent },
          content: [
            { type: "text", text: "リンク先の名前", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    const copy = a.copy(parent, a.noteId, "sections", "a1");
    const copiedBlock = a.project().children.get(copy)![0]!;
    expect(copiedBlock).not.toBe(id);
    expect(a.inlineContent(copiedBlock)).toEqual(a.inlineContent(id));
    expect(a.inlineContent(id)[2]?.content).toEqual([
      {
        type: "text",
        text: "リンク先の名前",
        marks: [{ type: "bold", attrs: {} }],
      },
    ]);
    const reopened = fork(a);
    expect(reopened.inlineContent(copiedBlock)).toEqual(a.inlineContent(id));
    expect(
      a
        .inlineContent(id)
        .filter((node) => node.type === "text")
        .map((node) => node.text)
        .join(""),
    ).toBe("plainbold");
  });

  it("isolates local text undo from remote edits", () => {
    const a = fresh(),
      id = paragraph(a);
    a.undoManager.clear();
    const b = fork(a);
    a.transact(() => text(a, id).insert(1, "LOCAL"));
    b.transact(() => text(b, id).insert(2, "REMOTE"));
    exchange(a, b);
    a.undoManager.undo();
    expect(text(a, id).toString()).toBe("abREMOTEc");
    exchange(a, b);
  });

  it("undoes creation with a semantic delete and retains remote text for redo", () => {
    const a = fresh();
    a.clearUndo();
    const id = paragraph(a);
    const b = fork(a);
    b.transact(() => text(b, id).insert(3, " remote"));
    a.applyUpdate(b.snapshot());
    expect(a.undo()).toBe(true);
    expect(a.project().visible.has(id)).toBe(false);
    expect(text(a, id).toString()).toBe("abc remote");
    expect(a.redo()).toBe(true);
    expect(a.project().visible.has(id)).toBe(true);
    exchange(a, b);
  });

  it("undoes placement independently of concurrent text and preserves a parallel deletion", () => {
    const a = fresh(),
      moving = section(a),
      target = section(a),
      id = paragraph(a, moving);
    a.clearUndo();
    const b = fork(a);
    a.move(moving, target, "sections", "a0");
    b.transact(() => text(b, id).insert(3, " remote"));
    a.applyUpdate(b.snapshot());
    expect(a.undo()).toBe(true);
    expect(a.project().parents.get(moving)?.parentId).toBe(a.noteId);
    expect(text(a, id).toString()).toBe("abc remote");
    expect(a.redo()).toBe(true);
    expect(a.project().parents.get(moving)?.parentId).toBe(target);
    a.clearUndo();
    a.delete(id);
    b.delete(id);
    a.applyUpdate(b.snapshot());
    a.undo();
    expect(a.project().visible.has(id)).toBe(false);
  });

  it("defers remote application across overlapping IME sessions", () => {
    const a = fresh(),
      id = paragraph(a);
    const b = fork(a);
    const endFirst = a.beginComposition(),
      endSecond = a.beginComposition();
    b.transact(() => text(b, id).insert(1, "remote"));
    expect(a.applyUpdate(b.snapshot())).toBe("deferred");
    a.transact(() => text(a, id).insert(3, "日本語"));
    endFirst();
    expect(text(a, id).toString()).toBe("abc日本語");
    endSecond();
    endSecond();
    expect(text(a, id).toString()).toBe("aremotebc日本語");
    exchange(a, b);
  });

  it("exchanges delete-only updates even when the Yjs state vector matches", () => {
    const a = fresh(),
      id = paragraph(a);
    const b = fork(a);
    const before = Y.encodeStateVector(b.doc);
    // Exercise a transport delta without the product's accompanying timestamp.
    a.doc.transact(() => text(a, id).delete(0, 1));
    expect(Y.encodeStateVector(a.doc)).toEqual(before);
    b.applyUpdate(Y.encodeStateAsUpdate(a.doc, before));
    expect(text(b, id).toString()).toBe("bc");
  });

  it("retains offline changes across snapshot compaction and forwarding through another replica", () => {
    const a = fresh(),
      id = paragraph(a);
    const b = fork(a),
      offline = fork(a);
    a.transact(() => text(a, id).delete(0, 1));
    b.applyUpdate(a.snapshot());
    const restarted = track(
      ReplicatedNote.load(a.noteId, b.replicaId, b.snapshot()),
    );
    offline.transact(() => text(offline, id).insert(3, " offline"));
    offline.applyUpdate(restarted.snapshot());
    restarted.applyUpdate(offline.snapshot());
    a.applyUpdate(restarted.snapshot());
    expect(text(a, id).toString()).toBe("bc offline");
  });

  it("rejects corrupt data atomically instead of inventing identities", () => {
    const a = fresh();
    paragraph(a);
    const b = fork(a);
    const before = a.snapshot();
    b.entities.set("bad-id", { id: "bad-id", type: "paragraph" });
    expect(() => a.applyUpdate(b.snapshot())).toThrow();
    expect(a.snapshot()).toEqual(before);
    const future = fork(a);
    future.meta.set("schema_version", 999);
    expect(() => a.applyUpdate(future.snapshot())).toThrow(/schema/);
    expect(a.snapshot()).toEqual(before);
    expect(() => a.applyUpdate(new Uint8Array([255, 255]))).toThrow();
    expect(a.snapshot()).toEqual(before);
  });

  it("rejects unrooted history rather than creating a fallback root", () => {
    const root = createUuidV7(),
      a = createUuidV7(),
      b = createUuidV7(),
      replicaId = createUuidV7();
    expect(() =>
      deriveReplicatedTree(root, new Set([root, a, b]), [
        {
          operationId: createUuidV7(),
          replicaId,
          counter: 1,
          entityId: a,
          parentId: b,
          region: "sections",
          position: "a0",
        },
        {
          operationId: createUuidV7(),
          replicaId,
          counter: 1,
          entityId: b,
          parentId: a,
          region: "sections",
          position: "a0",
        },
      ]),
    ).toThrow(/rooted/);
  });

  it("migrates stable table rows/columns and preserves existing cell coordinates", () => {
    const noteId = createUuidV7(),
      table = createUuidV7(),
      row = createUuidV7(),
      cell = createUuidV7(),
      block = createUuidV7();
    const a = track(
      replicateSectionSnapshot(
        {
          sectionId: noteId,
          title: "Table",
          tags: [],
          children: [],
          body: [
            {
              type: "table",
              attrs: { blockId: table },
              content: [
                {
                  type: "tableRow",
                  attrs: { blockId: row },
                  content: [
                    {
                      type: "tableCell",
                      attrs: { blockId: cell },
                      content: [
                        {
                          type: "paragraph",
                          attrs: { blockId: block },
                          content: [{ type: "text", text: "original" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        createUuidV7(),
      ),
    );
    const b = fork(a),
      c = fork(a);
    const newRow = a.createEntity("tableRow", table, "rows", "Zz");
    const newColumn = b.createEntity("tableColumn", table, "columns", "Zz");
    c.transact(() => text(c, block).insert(8, " edited"));
    exchange(a, b, c);
    const rendered = a.blockSnapshot(table);
    expect(rendered.content?.[1]?.content?.[1]).toMatchObject({
      attrs: { blockId: cell },
      content: [{ content: [{ text: "original edited" }] }],
    });
    const intersection = a.ensureCell(newRow, newColumn);
    expect(b.ensureCell(newRow, newColumn)).toBe(intersection);
    exchange(a, b, c);
    expect(
      a.blockSnapshot(table).content?.[0]?.content?.[0]?.attrs?.blockId,
    ).toBe(intersection);
  });
});
