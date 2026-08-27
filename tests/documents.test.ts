import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addNoteMetadata,
  createNoteDocument,
  createWorkspaceDocument,
  encodeProductDocument,
  listNoteMetadata,
  loadNoteDocumentWithSectionIdentityRecovery,
  loadProductDocument,
  readNotePlainText,
  replaceFirstTextBlock,
} from "../app/src/core/documents";
import {
  childSections,
  createSectionXml,
  insertChildSection,
  sectionChildren,
  sectionBodyChunks,
  sectionBody,
  sectionBodyBlocks,
  sectionHeader,
  sectionId,
} from "../app/src/core/section-model";
import { isUuidV7 } from "../app/src/core/ids";

const WORKSPACE_ID = "01900000-0000-7000-8000-000000000001";
const NOTE_ID = "01900000-0000-7000-8000-000000000003";
const BLOCK_ID = "01900000-0000-7000-8000-000000000004";

function xmlElement(value: unknown, expectedNodeName: string): Y.XmlElement {
  if (!(value instanceof Y.XmlElement)) {
    throw new Error(`Expected ${expectedNodeName} Y.XmlElement`);
  }
  expect(value.nodeName).toBe(expectedNodeName);
  return value;
}

describe("Memoka CRDT document schema v3", () => {
  it("keeps WorkspaceMetadataDoc free of note body content", () => {
    const workspace = createWorkspaceDocument(WORKSPACE_ID);
    const note = createNoteDocument(
      NOTE_ID,
      [
        {
          type: "paragraph",
          blockId: BLOCK_ID,
          content: [{ type: "text", text: "CRDTだけが正本" }],
        },
      ],
      "設計メモ",
    );
    addNoteMetadata(workspace, {
      noteId: NOTE_ID,
      title: "設計メモ",
      notePosition: "a0",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(listNoteMetadata(workspace)).toMatchObject([
      { noteId: NOTE_ID, title: "設計メモ", notePosition: "a0" },
    ]);
    expect(workspace.root.toJSON()).not.toHaveProperty("body");
    expect(JSON.stringify(workspace.root.toJSON())).not.toContain(
      "CRDTだけが正本",
    );
    expect(readNotePlainText(note)).toBe("CRDTだけが正本");
  });

  it("loads a legacy Note without parent_note_id as a top-level Tree entry", () => {
    const workspace = createWorkspaceDocument(WORKSPACE_ID);
    addNoteMetadata(workspace, {
      noteId: NOTE_ID,
      title: "Legacy",
      notePosition: "a0",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });
    workspace.notes.get(NOTE_ID)!.delete("parent_note_id");

    const loaded = loadProductDocument(
      "workspace",
      WORKSPACE_ID,
      encodeProductDocument(workspace),
    );
    expect(loaded.kind).toBe("workspace");
    if (loaded.kind === "workspace") {
      expect(listNoteMetadata(loaded)[0]?.parentNoteId).toBeNull();
    }
    loaded.doc.destroy();
    workspace.doc.destroy();
  });

  it("rejects unknown parents and cycles in persisted Note metadata", () => {
    const secondId = "01900000-0000-7000-8000-000000000005";
    const workspace = createWorkspaceDocument(WORKSPACE_ID);
    for (const [noteId, position] of [
      [NOTE_ID, "a0"],
      [secondId, "a1"],
    ] as const) {
      addNoteMetadata(workspace, {
        noteId,
        title: noteId,
        notePosition: position,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      });
    }
    workspace.notes.get(NOTE_ID)!.set("parent_note_id", secondId);
    workspace.notes.get(secondId)!.set("parent_note_id", NOTE_ID);

    expect(() =>
      loadProductDocument(
        "workspace",
        WORKSPACE_ID,
        encodeProductDocument(workspace),
      ),
    ).toThrow("cycle");
    workspace.doc.destroy();
  });

  it("reconstructs NoteDoc solely from a Y.js snapshot and updates", () => {
    const note = createNoteDocument(NOTE_ID, [
      {
        type: "paragraph",
        blockId: BLOCK_ID,
        content: [{ type: "text", text: "before" }],
      },
    ]);
    const snapshot = encodeProductDocument(note);
    replaceFirstTextBlock(note, "after");
    const fullState = encodeProductDocument(note);

    const loadedSnapshot = loadProductDocument("note", NOTE_ID, snapshot);
    const loadedFull = loadProductDocument("note", NOTE_ID, fullState);
    expect(readNotePlainText(loadedSnapshot as typeof note)).toBe("before");
    expect(readNotePlainText(loadedFull as typeof note)).toBe("after");
  });

  it("migrates a v2 direct body into durable v3 chunks without changing block IDs", () => {
    const secondBlockId = "01900000-0000-7000-8000-000000000005";
    const legacy = createNoteDocument(NOTE_ID, [
      {
        type: "paragraph",
        blockId: BLOCK_ID,
        content: [{ type: "text", text: "first" }],
      },
      {
        type: "paragraph",
        blockId: secondBlockId,
        content: [{ type: "text", text: "second" }],
      },
    ]);
    legacy.doc.transact(() => {
      const body = sectionBody(legacy.rootSection);
      const directBlocks = sectionBodyBlocks(legacy.rootSection).map((block) =>
        block.clone(),
      );
      body.delete(0, body.length);
      body.insert(0, directBlocks);
      legacy.meta.set("schema_version", 2);
    });
    const v2Snapshot = encodeProductDocument(legacy);

    const migrated = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      v2Snapshot,
    );
    expect(migrated.document.schemaVersion).toBe(3);
    expect(migrated.repair?.migratedFromSchemaVersion).toBe(2);
    expect(sectionBodyChunks(migrated.document.rootSection)).toHaveLength(1);
    expect(
      sectionBodyBlocks(migrated.document.rootSection).map((block) =>
        block.getAttribute("blockId"),
      ),
    ).toEqual([BLOCK_ID, secondBlockId]);

    const durable = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      v2Snapshot,
      [migrated.repair!.update],
    );
    expect(durable.repair).toBeNull();
    expect(durable.document.schemaVersion).toBe(3);
    durable.document.doc.destroy();
    migrated.document.doc.destroy();
    legacy.doc.destroy();
  });

  it("repairs missing and every duplicated block identity in one idempotent maintenance update", () => {
    const thirdBlockId = "01900000-0000-7000-8000-000000000006";
    const note = createNoteDocument(NOTE_ID, [
      {
        type: "paragraph",
        blockId: BLOCK_ID,
        content: [{ type: "text", text: "first" }],
      },
      {
        type: "paragraph",
        blockId: BLOCK_ID,
        content: [{ type: "text", text: "second" }],
      },
      {
        type: "paragraph",
        blockId: thirdBlockId,
        content: [{ type: "text", text: "third" }],
      },
    ]);
    sectionBodyBlocks(note.rootSection)[2]!.setAttribute("blockId", "");
    const snapshot = encodeProductDocument(note);

    const recovered = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      snapshot,
    );
    const repairedIds = sectionBodyBlocks(recovered.document.rootSection).map(
      (block) => String(block.getAttribute("blockId")),
    );
    expect(repairedIds).toHaveLength(3);
    expect(new Set(repairedIds)).toHaveProperty("size", 3);
    expect(repairedIds.every(isUuidV7)).toBe(true);
    expect(repairedIds).not.toContain(BLOCK_ID);
    expect(recovered.repair?.repairedBlockIds).toEqual(repairedIds);
    expect(readNotePlainText(recovered.document)).toBe("first\nsecond\nthird");

    const durable = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      snapshot,
      [recovered.repair!.update],
    );
    expect(durable.repair).toBeNull();
    expect(
      sectionBodyBlocks(durable.document.rootSection).map((block) =>
        String(block.getAttribute("blockId")),
      ),
    ).toEqual(repairedIds);
    durable.document.doc.destroy();
    recovered.document.doc.destroy();
    note.doc.destroy();
  });

  it("fails closed for a non-empty invalid persisted block identity", () => {
    const note = createNoteDocument(NOTE_ID);
    sectionBodyBlocks(note.rootSection)[0]!.setAttribute(
      "blockId",
      "not-a-uuid",
    );
    expect(() =>
      loadNoteDocumentWithSectionIdentityRecovery(
        NOTE_ID,
        encodeProductDocument(note),
      ),
    ).toThrow("Persisted block identity is invalid");
    note.doc.destroy();
  });

  it("rejects a persisted NoteDoc stored under the wrong identity", () => {
    const note = createNoteDocument(NOTE_ID);
    expect(() =>
      loadProductDocument(
        "note",
        "01900000-0000-7000-8000-000000000099",
        encodeProductDocument(note),
      ),
    ).toThrow("does not match");
  });

  it("recovers only a missing Section ID from the same Yjs element's update history", () => {
    const childId = "01900000-0000-7000-8000-00000000000b";
    const note = createNoteDocument(NOTE_ID);
    const child = createSectionXml(childId, "Recovered child");
    note.doc.transact(() => insertChildSection(note.rootSection, child));
    const snapshot = encodeProductDocument(note);
    const beforeDamage = Y.encodeStateVector(note.doc);
    note.doc.transact(() => sectionHeader(child).setAttribute("sectionId", ""));
    const damagingUpdate = Y.encodeStateAsUpdate(note.doc, beforeDamage);

    expect(() =>
      loadProductDocument("note", NOTE_ID, snapshot, [damagingUpdate]),
    ).toThrow("sectionId must be a lowercase UUIDv7");
    const recovered = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      snapshot,
      [damagingUpdate],
    );
    expect(recovered.repair?.repairedSectionIds).toEqual([childId]);
    expect(sectionId(recovered.document.rootSection)).toBe(NOTE_ID);
    expect(sectionId(childSections(recovered.document.rootSection)[0]!)).toBe(
      childId,
    );

    const durable = loadProductDocument("note", NOTE_ID, snapshot, [
      damagingUpdate,
      recovered.repair!.update,
    ]);
    expect(durable.kind).toBe("note");
    if (durable.kind === "note") {
      expect(sectionId(childSections(durable.rootSection)[0]!)).toBe(childId);
    }
    durable.doc.destroy();
    recovered.document.doc.destroy();
    note.doc.destroy();
  });

  it("accepts a valid final tree when a structural replacement repurposes a Yjs element", () => {
    const originalId = "01900000-0000-7000-8000-00000000000e";
    const insertedId = "01900000-0000-7000-8000-00000000000f";
    const nestedId = "01900000-0000-7000-8000-000000000010";
    const note = createNoteDocument(NOTE_ID);
    const original = createSectionXml(originalId, "Original");
    note.doc.transact(() => insertChildSection(note.rootSection, original));
    const snapshot = encodeProductDocument(note);
    const beforeReplacement = Y.encodeStateVector(note.doc);

    // y-prosemirror may encode a full structural replacement by retaining an
    // integrated element for a newly inserted Section and recreating the old
    // logical Section with its original ID. The final ID set is valid even
    // though the retained Yjs object observed two valid IDs over time.
    note.doc.transact(() => {
      sectionHeader(original).setAttribute("sectionId", insertedId);
      sectionChildren(note.rootSection).insert(0, [
        createSectionXml(
          originalId,
          "Original",
          [],
          [createSectionXml(nestedId, "Nested")],
        ),
      ]);
    });
    const replacementUpdate = Y.encodeStateAsUpdate(
      note.doc,
      beforeReplacement,
    );

    const loaded = loadNoteDocumentWithSectionIdentityRecovery(
      NOTE_ID,
      snapshot,
      [replacementUpdate],
    );
    expect(loaded.repair).toBeNull();
    expect(loaded.document.schemaVersion).toBe(3);
    expect(
      childSections(loaded.document.rootSection).map((section) =>
        sectionId(section),
      ),
    ).toEqual([originalId, insertedId]);
    expect(
      sectionId(
        childSections(childSections(loaded.document.rootSection)[0]!)[0]!,
      ),
    ).toBe(nestedId);

    loaded.document.doc.destroy();
    note.doc.destroy();
  });

  it("rejects a missing Section ID when reused Yjs history is ambiguous", () => {
    const firstId = "01900000-0000-7000-8000-000000000011";
    const secondId = "01900000-0000-7000-8000-000000000012";
    const note = createNoteDocument(NOTE_ID);
    const child = createSectionXml(firstId, "Ambiguous");
    note.doc.transact(() => insertChildSection(note.rootSection, child));
    const snapshot = encodeProductDocument(note);
    let stateVector = Y.encodeStateVector(note.doc);
    note.doc.transact(() =>
      sectionHeader(child).setAttribute("sectionId", secondId),
    );
    const changedUpdate = Y.encodeStateAsUpdate(note.doc, stateVector);
    stateVector = Y.encodeStateVector(note.doc);
    note.doc.transact(() => sectionHeader(child).setAttribute("sectionId", ""));
    const missingUpdate = Y.encodeStateAsUpdate(note.doc, stateVector);

    expect(() =>
      loadNoteDocumentWithSectionIdentityRecovery(NOTE_ID, snapshot, [
        changedUpdate,
        missingUpdate,
      ]),
    ).toThrow("cannot be recovered from update history");
    note.doc.destroy();
  });

  it("does not invent a Section ID when no valid update history exists", () => {
    const note = createNoteDocument(NOTE_ID);
    sectionHeader(note.rootSection).setAttribute("sectionId", "");
    const damagedSnapshot = encodeProductDocument(note);
    expect(() =>
      loadNoteDocumentWithSectionIdentityRecovery(NOTE_ID, damagedSnapshot),
    ).toThrow("cannot be recovered from update history");
    note.doc.destroy();
  });

  it("rejects a non-empty invalid Section ID instead of recovering it", () => {
    const note = createNoteDocument(NOTE_ID);
    const snapshot = encodeProductDocument(note);
    const stateVector = Y.encodeStateVector(note.doc);
    sectionHeader(note.rootSection).setAttribute("sectionId", "not-a-uuid");
    const damagingUpdate = Y.encodeStateAsUpdate(note.doc, stateVector);
    expect(() =>
      loadNoteDocumentWithSectionIdentityRecovery(NOTE_ID, snapshot, [
        damagingUpdate,
      ]),
    ).toThrow("cannot be recovered from update history");
    note.doc.destroy();
  });

  it("rejects duplicate Section IDs instead of treating them as recoverable", () => {
    const firstId = "01900000-0000-7000-8000-00000000000c";
    const secondId = "01900000-0000-7000-8000-00000000000d";
    const note = createNoteDocument(NOTE_ID);
    const first = createSectionXml(firstId, "First");
    const second = createSectionXml(secondId, "Second");
    note.doc.transact(() => {
      insertChildSection(note.rootSection, first);
      insertChildSection(note.rootSection, second);
      sectionHeader(second).setAttribute("sectionId", firstId);
    });
    expect(() =>
      loadNoteDocumentWithSectionIdentityRecovery(
        NOTE_ID,
        encodeProductDocument(note),
      ),
    ).toThrow(`Duplicate Section ID: ${firstId}`);
    note.doc.destroy();
  });

  it("persists unsupported Markdown as a structured Source Block in NoteDoc", () => {
    const source = "- [ ] unsupported task";
    const note = createNoteDocument(NOTE_ID, [
      {
        type: "sourceBlock",
        blockId: BLOCK_ID,
        sourceFormat: "markdown",
        text: source,
      },
    ]);
    const loaded = loadProductDocument(
      "note",
      NOTE_ID,
      encodeProductDocument(note),
    ) as typeof note;
    const block = sectionBodyBlocks(loaded.rootSection)[0];

    if (!(block instanceof Y.XmlElement)) {
      throw new Error("Expected Source Block Y.XmlElement");
    }
    expect(block.nodeName).toBe("sourceBlock");
    expect(block.getAttribute("blockId")).toBe(BLOCK_ID);
    expect(block.getAttribute("sourceFormat")).toBe("markdown");
    expect(readNotePlainText(loaded)).toBe(source);
    loaded.doc.destroy();
    note.doc.destroy();
  });

  it("persists Table rows and cells inside the NoteDoc CRDT", () => {
    const note = createNoteDocument(NOTE_ID, [
      {
        type: "table",
        blockId: BLOCK_ID,
        children: [
          {
            type: "tableRow",
            blockId: "01900000-0000-7000-8000-000000000005",
            children: [
              {
                type: "tableHeader",
                blockId: "01900000-0000-7000-8000-000000000006",
                alignment: "left",
                children: [
                  {
                    type: "paragraph",
                    blockId: "01900000-0000-7000-8000-000000000007",
                    content: [{ type: "text", text: "見出し" }],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            blockId: "01900000-0000-7000-8000-000000000008",
            children: [
              {
                type: "tableCell",
                blockId: "01900000-0000-7000-8000-000000000009",
                alignment: "left",
                children: [
                  {
                    type: "paragraph",
                    blockId: "01900000-0000-7000-8000-00000000000a",
                    content: [{ type: "text", text: "本文" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const loaded = loadProductDocument(
      "note",
      NOTE_ID,
      encodeProductDocument(note),
    ) as typeof note;
    const table = sectionBodyBlocks(loaded.rootSection)[0];

    if (!(table instanceof Y.XmlElement)) {
      throw new Error("Expected Table Y.XmlElement");
    }
    expect(table.nodeName).toBe("table");
    expect(table.getAttribute("blockId")).toBe(BLOCK_ID);
    const headingRow = xmlElement(table.get(0), "tableRow");
    const headingCell = xmlElement(headingRow.get(0), "tableHeader");
    const heading = xmlElement(headingCell.get(0), "paragraph");
    const bodyRow = xmlElement(table.get(1), "tableRow");
    const bodyCell = xmlElement(bodyRow.get(0), "tableCell");
    const body = xmlElement(bodyCell.get(0), "paragraph");
    expect(headingCell.getAttribute("align")).toBe("left");
    expect(bodyCell.getAttribute("align")).toBe("left");
    expect(heading.toString()).toContain("見出し");
    expect(body.toString()).toContain("本文");
    expect(readNotePlainText(loaded)).toBe("見出し\n本文");
    loaded.doc.destroy();
    note.doc.destroy();
  });
});
