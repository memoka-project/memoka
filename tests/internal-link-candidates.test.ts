import { describe, expect, it } from "vitest";
import {
  createNoteDocument,
  type NoteDocument,
  type NoteMetadata,
} from "../app/src/core/documents";
import {
  deriveInternalLinkCandidates,
  filterInternalLinkCandidates,
  type InternalLinkCandidate,
} from "../app/src/core/internal-link-candidates";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";

const noteId = "01900000-0000-7000-8000-000000000010";
const childId = "01900000-0000-7000-8000-000000000011";
const parentNoteId = "01900000-0000-7000-8000-000000000013";

function metadata(
  id: string,
  title: string,
  notePosition = "a",
  deletedAt?: string,
): NoteMetadata {
  return {
    noteId: id,
    parentNoteId: null,
    title,
    notePosition,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    deletedAt,
  };
}

describe("Internal Section Link candidates", () => {
  it("derives every live Section in document order with its breadcrumb", () => {
    const document = createNoteDocument(noteId, [], "プロジェクト");
    document.doc.transact(() => {
      insertChildSection(
        document.rootSection,
        createSectionXml(childId, "同名"),
      );
    });
    const documents = new Map<string, NoteDocument>([[noteId, document]]);
    const candidates = deriveInternalLinkCandidates(
      [
        metadata(noteId, "プロジェクト"),
        metadata(
          "01900000-0000-7000-8000-000000000012",
          "削除済み",
          "b",
          "2026-08-03T01:00:00.000Z",
        ),
      ],
      documents,
    );

    expect(candidates).toEqual([
      {
        noteId,
        sectionId: noteId,
        title: "プロジェクト",
        parentPath: "/",
        shortId: "00000010",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        noteId,
        sectionId: childId,
        title: "同名",
        parentPath: "プロジェクト",
        shortId: "00000011",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    document.doc.destroy();
  });

  it("matches normalized titles and breadcrumbs with stable ranking", () => {
    const candidates: InternalLinkCandidate[] = [
      {
        noteId: "a",
        sectionId: "sa",
        title: "日本語メモ",
        parentPath: "仕事",
        shortId: "a",
      },
      {
        noteId: "b",
        sectionId: "sb",
        title: "メモ・日本語",
        parentPath: "個人",
        shortId: "b",
      },
      {
        noteId: "c",
        sectionId: "sc",
        title: "議事録",
        parentPath: "日本語 / 会議",
        shortId: "c",
      },
    ];

    expect(
      filterInternalLinkCandidates(candidates, "日本語").map(
        ({ noteId: id }) => id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      filterInternalLinkCandidates(candidates, "ﾒﾓ").map(
        ({ noteId: id }) => id,
      ),
    ).toEqual(["b", "a"]);
    expect(filterInternalLinkCandidates(candidates, "", 2)).toEqual(
      candidates.slice(0, 2),
    );
  });

  it("prepends Note ancestors to Root and child Section paths", () => {
    const document = createNoteDocument(noteId, [], "Child Note");
    document.doc.transact(() => {
      insertChildSection(
        document.rootSection,
        createSectionXml(childId, "Child Section"),
      );
    });
    const childMetadata = {
      ...metadata(noteId, "Child Note"),
      parentNoteId,
    };

    const candidates = deriveInternalLinkCandidates(
      [metadata(parentNoteId, "Parent Note"), childMetadata],
      new Map([[noteId, document]]),
    );

    expect(candidates).toMatchObject([
      { title: "Child Note", parentPath: "Parent Note" },
      {
        title: "Child Section",
        parentPath: "Parent Note / Child Note",
      },
    ]);
    document.doc.destroy();
  });

  it("rejects a non-positive result limit", () => {
    expect(() => filterInternalLinkCandidates([], "", 0)).toThrow(
      "candidate limit must be positive",
    );
  });
});
