import { describe, expect, it } from "vitest";
import type { NoteMetadata } from "../app/src/core/documents";
import {
  createPortablePathProjection,
  portableComponent,
  PORTABLE_COMPONENT_MAX_BYTES,
} from "../app/src/core/portable-paths";
import type { SectionSnapshot } from "../app/src/core/section-model";

function metadata(
  noteId: string,
  title: string,
  parentNoteId: string | null = null,
  notePosition = "a0V",
  deletedAt?: string,
): NoteMetadata {
  return {
    noteId,
    title,
    parentNoteId,
    notePosition,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    deletedAt,
  };
}

function section(
  sectionId: string,
  title: string,
  children: readonly SectionSnapshot[] = [],
): SectionSnapshot {
  return { sectionId, title, tags: [], body: [], children };
}

describe("portable title path projection", () => {
  it("mirrors Note and Section trees with title sidecar directories", async () => {
    const projection = await createPortablePathProjection([
      {
        metadata: metadata("root", "Project"),
        rootSection: section("root", "Project", [
          section("intro", "Intro", [section("detail", "Detail")]),
        ]),
      },
      {
        metadata: metadata("child", "Child", "root"),
        rootSection: section("child", "Child"),
      },
    ]);

    expect(projection.notes).toMatchObject([
      {
        noteId: "root",
        markdownPath: "Project.md",
        recoveryPath: "memoka-recovery/Project.yjs",
        sections: [
          {
            sectionId: "intro",
            markdownPath: "Project.sections/Intro.md",
          },
          {
            sectionId: "detail",
            markdownPath: "Project.sections/Intro.sections/Detail.md",
          },
        ],
      },
      {
        noteId: "child",
        markdownPath: "Project.notes/Child.md",
      },
    ]);
  });

  it("escapes unsafe names and suffixes normalized/case-insensitive collisions", async () => {
    const titles = [
      "CON",
      "a/b",
      "same",
      "SAME",
      "e\u0301",
      "é",
      ".",
      "tail. ",
    ];
    const projection = await createPortablePathProjection(
      titles.map((title, index) => ({
        metadata: metadata(`note-${index}`, title, null, `a${index}`),
        rootSection: section(`note-${index}`, title),
      })),
    );
    expect(projection.notes.map(({ markdownPath }) => markdownPath)).toEqual([
      "%43ON.md",
      "a%2Fb.md",
      "same.md",
      "SAME (2).md",
      "é.md",
      "é (2).md",
      "%2E.md",
      "tail%2E%20.md",
    ]);
  });

  it("uses documented empty labels, Trash and bounded hash-derived components", async () => {
    const long = "長".repeat(200);
    const component = await portableComponent(long);
    expect(new TextEncoder().encode(component).length).toBeLessThanOrEqual(
      PORTABLE_COMPONENT_MAX_BYTES,
    );
    expect(component).toMatch(/~[0-9a-f]{12}$/u);

    const projection = await createPortablePathProjection([
      {
        metadata: metadata("trash", "", null, "a0", "2026-08-24T00:00:00.000Z"),
        rootSection: section("trash", "", [section("untitled", "")]),
      },
    ]);
    expect(projection.notes[0]).toMatchObject({
      markdownPath: "memoka-trash/新しいノート.md",
      sections: [
        {
          markdownPath: "memoka-trash/新しいノート.sections/無題.md",
        },
      ],
    });
  });

  it("keeps overflow paths unique without exposing IDs", async () => {
    const long = "親".repeat(400);
    const childTitle = "子".repeat(400);
    const projection = await createPortablePathProjection([
      {
        metadata: metadata("parent-a", long, null, "a0"),
        rootSection: section("parent-a", long),
      },
      {
        metadata: metadata("parent-b", long, null, "a1"),
        rootSection: section("parent-b", long),
      },
      {
        metadata: metadata("child-a", childTitle, "parent-a", "a0"),
        rootSection: section("child-a", childTitle),
      },
      {
        metadata: metadata("child-b", childTitle, "parent-b", "a0"),
        rootSection: section("child-b", childTitle),
      },
    ]);
    const paths = projection.notes.flatMap(({ markdownPath, recoveryPath }) => [
      markdownPath,
      recoveryPath,
    ]);
    expect(new Set(paths)).toHaveLength(paths.length);
    expect(paths.every((path) => !/parent-|child-/u.test(path))).toBe(true);
    expect(
      paths.every((path) => new TextEncoder().encode(path).length <= 2_048),
    ).toBe(true);
  });
});
