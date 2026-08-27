import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  blockToYXml,
  cloneProductDocument,
  createNoteDocument,
  replaceNoteSectionTree,
  type NoteDocument,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  applySectionHierarchySnapshot,
  childSections,
  cloneSectionSubtree,
  createSectionXml,
  deriveSectionCatalog,
  findChildSectionToward,
  findSectionById,
  insertChildSection,
  planSectionDepthShift,
  sectionBody,
  sectionBodyBlocks,
  sectionBodyChunks,
  sectionId,
  sectionSnapshot,
  updateSectionTitle,
  validateSectionTree,
  type SectionSnapshot,
} from "../app/src/core/section-model";

function deterministicIds(start = 0) {
  let counter = start;
  return () => {
    const seed = counter++;
    return createUuidV7(1_797_000_000_000 + seed, (bytes) => {
      bytes.fill((seed * 53) & 0xff);
      return bytes;
    });
  };
}

function paragraph(blockId: string, text: string) {
  return blockToYXml({
    type: "paragraph" as const,
    blockId,
    content: [{ type: "text" as const, text }],
  });
}

function paragraphSnapshot(blockId: string, text = ""): unknown {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function snapshotSection(
  sectionId: string,
  title: string,
  children: readonly SectionSnapshot[] = [],
): SectionSnapshot {
  return {
    sectionId,
    title,
    tags: [],
    body: [paragraphSnapshot(createUuidV7(), title)],
    children,
  };
}

function destroyNotes(...notes: NoteDocument[]): void {
  for (const note of notes) note.doc.destroy();
}

describe("Memoka recursive Section model", () => {
  it("starts a new body chunk before the 128 KiB target is exceeded", () => {
    const note = createNoteDocument(
      createUuidV7(),
      Array.from({ length: 3 }, () => ({
        type: "paragraph" as const,
        blockId: createUuidV7(),
        content: [{ type: "text" as const, text: "あ".repeat(24_000) }],
      })),
    );
    expect(
      sectionBodyChunks(note.rootSection).map((chunk) => chunk.length),
    ).toEqual([1, 1, 1]);
    note.doc.destroy();
  });

  it("finds only the immediate child step toward a deeper Section", () => {
    const ids = deterministicIds();
    const note = createNoteDocument(ids(), [], "Root");
    const firstId = ids();
    const secondId = ids();
    const siblingId = ids();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(
          firstId,
          "First",
          [],
          [createSectionXml(secondId, "Second")],
        ),
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(siblingId, "Sibling"),
      );
    });

    expect(
      sectionId(
        findChildSectionToward(note.rootSection, note.noteId, secondId)!,
      ),
    ).toBe(firstId);
    expect(
      sectionId(findChildSectionToward(note.rootSection, firstId, secondId)!),
    ).toBe(secondId);
    expect(
      findChildSectionToward(note.rootSection, secondId, secondId),
    ).toBeNull();
    expect(
      findChildSectionToward(note.rootSection, siblingId, secondId),
    ).toBeNull();
    note.doc.destroy();
  });

  it("shifts only selected Section headers while preserving preorder", () => {
    const ids = deterministicIds();
    const rootId = ids();
    const aId = ids();
    const bId = ids();
    const xId = ids();
    const cId = ids();
    const source = snapshotSection(rootId, "Root", [
      snapshotSection(aId, "A"),
      snapshotSection(bId, "B", [snapshotSection(xId, "X")]),
      snapshotSection(cId, "C"),
    ]);

    const demoted = planSectionDepthShift(source, [bId], "deeper");
    expect(demoted.changed).toBe(true);
    expect(demoted.affectedSectionIds).toEqual([bId]);
    expect(demoted.snapshot.children.map(({ sectionId }) => sectionId)).toEqual(
      [aId, cId],
    );
    expect(
      demoted.snapshot.children[0]?.children.map(({ sectionId }) => sectionId),
    ).toEqual([bId, xId]);
    expect(flattenIds(demoted.snapshot)).toEqual(flattenIds(source));

    const parentId = ids();
    const nestedSource = snapshotSection(rootId, "Root", [
      snapshotSection(parentId, "Parent", [
        snapshotSection(aId, "A"),
        snapshotSection(bId, "B", [snapshotSection(xId, "X")]),
        snapshotSection(cId, "C"),
      ]),
    ]);
    const promoted = planSectionDepthShift(nestedSource, [bId], "shallower");
    expect(promoted.affectedSectionIds).toEqual([bId, xId]);
    expect(
      promoted.snapshot.children.map(({ sectionId }) => sectionId),
    ).toEqual([parentId, bId]);
    expect(
      promoted.snapshot.children[1]?.children.map(({ sectionId }) => sectionId),
    ).toEqual([xId, cId]);
  });

  it("shifts a Visual range independently and corrects only invalid jumps", () => {
    const ids = deterministicIds();
    const rootId = ids();
    const pId = ids();
    const aId = ids();
    const xId = ids();
    const bId = ids();
    const yId = ids();
    const cId = ids();
    const source = snapshotSection(rootId, "Root", [
      snapshotSection(pId, "P"),
      snapshotSection(aId, "A", [snapshotSection(xId, "X")]),
      snapshotSection(bId, "B", [snapshotSection(yId, "Y")]),
      snapshotSection(cId, "C"),
    ]);

    const shifted = planSectionDepthShift(source, [aId, xId, bId], "deeper");
    expect(flattenIds(shifted.snapshot)).toEqual(flattenIds(source));
    expect(shifted.snapshot.children.map(({ sectionId }) => sectionId)).toEqual(
      [pId, cId],
    );
    expect(
      shifted.snapshot.children[0]?.children.map(({ sectionId }) => sectionId),
    ).toEqual([aId, bId, yId]);
    expect(
      shifted.snapshot.children[0]?.children[0]?.children.map(
        ({ sectionId }) => sectionId,
      ),
    ).toEqual([xId]);
  });

  it("keeps the Focused Section root fixed and rejects outside targets", () => {
    const ids = deterministicIds();
    const rootId = ids();
    const childId = ids();
    const source = snapshotSection(rootId, "Root", [
      snapshotSection(childId, "Child"),
    ]);
    expect(planSectionDepthShift(source, [rootId], "deeper").changed).toBe(
      false,
    );
    expect(planSectionDepthShift(source, [childId], "shallower").changed).toBe(
      false,
    );
    expect(() => planSectionDepthShift(source, [ids()], "deeper")).toThrow(
      "outside the Focused Section",
    );
  });

  it("reparents only the affected subtree and retains unrelated Yjs identities", () => {
    const ids = deterministicIds();
    const note = createNoteDocument(ids(), [], "Root");
    const aId = ids();
    const bId = ids();
    const xId = ids();
    const cId = ids();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(aId, "A", [paragraph(ids(), "A body")]),
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(
          bId,
          "B",
          [paragraph(ids(), "B body")],
          [createSectionXml(xId, "X", [paragraph(ids(), "X body")])],
        ),
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(cId, "C", [paragraph(ids(), "C body")]),
      );
      const bSection = findSectionById(note.rootSection, bId);
      const bParagraph = bSection ? sectionBodyBlocks(bSection)[0] : undefined;
      const bText =
        bParagraph instanceof Y.XmlElement
          ? bParagraph.toArray()[0]
          : undefined;
      if (!(bText instanceof Y.XmlText)) {
        throw new Error("Missing B paragraph text");
      }
      bText.format(0, bText.length, { bold: {} });
      bText.format(0, bText.length, { "code--AAAAAAAA": {} });
    });
    const before = new Map(
      deriveSectionCatalog(note.noteId, note.rootSection).map((entry) => [
        entry.sectionId,
        entry.element,
      ]),
    );
    const plan = planSectionDepthShift(
      sectionSnapshot(note.rootSection),
      [bId],
      "deeper",
    );
    const formattedMarks = (
      plan.snapshot.children[0]?.children[0]?.body[0] as {
        content?: Array<{ marks?: Array<{ type: string }> }>;
      }
    ).content?.[0]?.marks;
    expect(formattedMarks?.map(({ type }) => type).sort()).toEqual([
      "bold",
      "code",
    ]);
    note.doc.transact(() =>
      applySectionHierarchySnapshot(note.rootSection, plan.snapshot),
    );

    expect(findSectionById(note.rootSection, aId)).toBe(before.get(aId));
    expect(findSectionById(note.rootSection, cId)).toBe(before.get(cId));
    expect(findSectionById(note.rootSection, bId)).not.toBe(before.get(bId));
    expect(findSectionById(note.rootSection, xId)).not.toBe(before.get(xId));
    expect(sectionSnapshot(note.rootSection)).toEqual(plan.snapshot);
    note.doc.destroy();
  });
  it("persists one ordered body-before-children tree with stable properties", () => {
    const ids = deterministicIds();
    const note = createNoteDocument(ids(), [], "Root");
    const childId = ids();
    const grandchildId = ids();
    note.doc.transact(() => {
      const grandchild = createSectionXml(
        grandchildId,
        "Grandchild",
        [paragraph(ids(), "grandchild body")],
        [],
        { emoji: "🧠", tags: ["deep", "test"] },
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(
          childId,
          "Child",
          [paragraph(ids(), "child body")],
          [grandchild],
        ),
      );
    });

    expect(validateSectionTree(note.rootSection, note.noteId)).toEqual({
      sectionCount: 3,
      maximumDepth: 2,
    });
    expect(deriveSectionCatalog(note.noteId, note.rootSection)).toMatchObject([
      {
        sectionId: note.noteId,
        parentSectionId: null,
        depth: 0,
        title: "Root",
      },
      {
        sectionId: childId,
        parentSectionId: note.noteId,
        depth: 1,
        title: "Child",
      },
      {
        sectionId: grandchildId,
        parentSectionId: childId,
        depth: 2,
        title: "Grandchild",
        properties: { emoji: "🧠", tags: ["deep", "test"] },
      },
    ]);
    expect(
      note.rootSection
        .toArray()
        .map((value) =>
          value instanceof Y.XmlElement ? value.nodeName : "invalid",
        ),
    ).toEqual(["sectionHeader", "sectionBody", "sectionChildren"]);

    const reopened = cloneProductDocument(note);
    if (reopened.kind !== "note") throw new Error("Expected cloned NoteDoc");
    expect(sectionSnapshot(reopened.rootSection)).toEqual(
      sectionSnapshot(note.rootSection),
    );
    destroyNotes(note, reopened);
  });

  it("rejects duplicate IDs and invalid body placement at the Core boundary", () => {
    const ids = deterministicIds();
    const note = createNoteDocument(ids(), [], "Root");
    const childId = ids();
    note.doc.transact(() => {
      insertChildSection(note.rootSection, createSectionXml(childId, "First"));
    });
    expect(() =>
      note.doc.transact(() => {
        insertChildSection(
          note.rootSection,
          createSectionXml(childId, "Duplicate"),
        );
      }),
    ).toThrow(`Duplicate Section ID: ${childId}`);
    expect(childSections(note.rootSection)).toHaveLength(1);

    note.doc.transact(() => {
      sectionBody(note.rootSection).insert(0, [
        createSectionXml(ids(), "Wrong"),
      ]);
    });
    expect(() => validateSectionTree(note.rootSection, note.noteId)).toThrow(
      "body contains an invalid chunk",
    );
    note.doc.destroy();
  });

  it("copies a subtree with fresh IDs and rewrites links inside that subtree", () => {
    const ids = deterministicIds();
    const sourceId = ids();
    const linkedChildId = ids();
    const externalId = ids();
    const source = createSectionXml(
      sourceId,
      "Source",
      [
        blockToYXml({
          type: "paragraph",
          blockId: ids(),
          content: [
            {
              type: "internalSectionLink",
              text: "inside",
              targetSectionId: linkedChildId,
            },
            { type: "text", text: " / " },
            {
              type: "internalSectionLink",
              text: "outside",
              targetSectionId: externalId,
            },
          ],
        }),
      ],
      [createSectionXml(linkedChildId, "Linked child")],
    );
    const note = createNoteDocument(ids(), [], "Container");
    note.doc.transact(() => insertChildSection(note.rootSection, source));
    const copyIds = deterministicIds(100);
    const copied = cloneSectionSubtree(source, { idFactory: copyIds });
    const copiedSnapshot = copied.snapshot;
    const sourceSnapshot = sectionSnapshot(source);

    expect(copied.idMap.get(sourceId)).not.toBe(sourceId);
    expect(copied.idMap.get(linkedChildId)).not.toBe(linkedChildId);
    expect(copiedSnapshot.sectionId).toBe(copied.idMap.get(sourceId));
    expect(copiedSnapshot.children[0]?.sectionId).toBe(
      copied.idMap.get(linkedChildId),
    );
    const copiedBody = JSON.stringify(copiedSnapshot.body);
    expect(copiedBody).toContain(copied.idMap.get(linkedChildId)!);
    expect(copiedBody).toContain(externalId);
    expect(sectionSnapshot(source)).toEqual(sourceSnapshot);
    note.doc.destroy();
  });

  it("converges concurrent child inserts and title edits in either update order", () => {
    const ids = deterministicIds();
    const original = createNoteDocument(ids(), [], "Root");
    const initial = Y.encodeStateAsUpdate(original.doc);
    const left = cloneProductDocument(original);
    const right = cloneProductDocument(original);
    if (left.kind !== "note" || right.kind !== "note") {
      throw new Error("Expected NoteDocs");
    }
    const leftVector = Y.encodeStateVector(left.doc);
    const rightVector = Y.encodeStateVector(right.doc);
    left.doc.transact(() => {
      updateSectionTitle(left.rootSection, "Left title");
      insertChildSection(
        left.rootSection,
        createSectionXml(ids(), "Left child"),
      );
    });
    right.doc.transact(() => {
      updateSectionTitle(right.rootSection, "Right title");
      insertChildSection(
        right.rootSection,
        createSectionXml(ids(), "Right child"),
      );
    });
    const leftUpdate = Y.encodeStateAsUpdate(left.doc, leftVector);
    const rightUpdate = Y.encodeStateAsUpdate(right.doc, rightVector);

    const first = new Y.Doc({ guid: original.noteId });
    Y.applyUpdate(first, initial);
    Y.applyUpdate(first, leftUpdate);
    Y.applyUpdate(first, rightUpdate);
    const second = new Y.Doc({ guid: original.noteId });
    Y.applyUpdate(second, initial);
    Y.applyUpdate(second, rightUpdate);
    Y.applyUpdate(second, leftUpdate);
    expect(Y.encodeStateAsUpdate(first)).toEqual(Y.encodeStateAsUpdate(second));

    const firstRoot = first.getXmlFragment("body").get(0);
    const secondRoot = second.getXmlFragment("body").get(0);
    if (
      !(firstRoot instanceof Y.XmlElement) ||
      !(secondRoot instanceof Y.XmlElement)
    ) {
      throw new Error("Converged Root Section is missing");
    }
    expect(validateSectionTree(firstRoot, original.noteId).sectionCount).toBe(
      3,
    );
    expect(sectionSnapshot(firstRoot)).toEqual(sectionSnapshot(secondRoot));
    original.doc.destroy();
    left.doc.destroy();
    right.doc.destroy();
    first.destroy();
    second.destroy();
  });

  it("supports 1,000 wide and 1,000 deep Sections without recursive JS traversal", () => {
    const ids = deterministicIds();
    const wide = createNoteDocument(ids(), [], "Wide");
    const wideSnapshot: SectionSnapshot = {
      sectionId: wide.noteId,
      title: "Wide",
      tags: [],
      body: [paragraphSnapshot(ids(), "root")],
      children: Array.from({ length: 1_000 }, (_, index) =>
        snapshotSection(ids(), `Wide ${index}`),
      ),
    };
    replaceNoteSectionTree(wide, wideSnapshot, "");
    expect(validateSectionTree(wide.rootSection, wide.noteId)).toEqual({
      sectionCount: 1_001,
      maximumDepth: 1,
    });

    const deep = createNoteDocument(ids(), [], "Deep");
    let nested: SectionSnapshot = snapshotSection(ids(), "Depth 1000");
    for (let depth = 999; depth >= 1; depth -= 1) {
      nested = snapshotSection(ids(), `Depth ${depth}`, [nested]);
    }
    const deepSnapshot: SectionSnapshot = {
      sectionId: deep.noteId,
      title: "Deep",
      tags: [],
      body: [paragraphSnapshot(ids(), "root")],
      children: [nested],
    };
    replaceNoteSectionTree(deep, deepSnapshot, "");
    expect(validateSectionTree(deep.rootSection, deep.noteId)).toEqual({
      sectionCount: 1_001,
      maximumDepth: 1_000,
    });
    const deepest = deriveSectionCatalog(deep.noteId, deep.rootSection).at(-1);
    expect(deepest?.depth).toBe(1_000);
    expect(
      findSectionById(deep.rootSection, deepest!.sectionId),
    ).not.toBeNull();
    expect(sectionId(deep.rootSection)).toBe(deep.noteId);
    destroyNotes(wide, deep);
  });
});

function flattenIds(snapshot: SectionSnapshot): string[] {
  const result: string[] = [];
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    result.push(current.sectionId);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      pending.push(current.children[index]!);
    }
  }
  return result;
}
