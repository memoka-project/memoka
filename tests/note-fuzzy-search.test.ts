import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CompactDictionary, Migemo } from "jsmigemo";
import { createNoteDocument, type NoteBlock } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  deriveNoteFuzzySearchProjection,
  matchNoteFuzzyWords,
  migemoPatternForQuery,
  noteFuzzyWords,
} from "../app/src/core/note-fuzzy-search";

function migemo(): Migemo {
  const bytes = readFileSync(
    resolve(process.cwd(), "app/src/assets/migemo-compact-dict.bin"),
  );
  const value = new Migemo();
  value.setDict(
    new CompactDictionary(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return value;
}

function paragraph(blockId: string, text: string): NoteBlock {
  return { type: "paragraph", blockId, content: [{ type: "text", text }] };
}

describe("Note fuzzy and Migemo search", () => {
  it("matches a hyphenated romaji query to a prolonged-sound Japanese word", () => {
    const words = noteFuzzyWords(["ノ", "ー", "ト"], [5, 6, 7]);
    const pattern = migemoPatternForQuery(migemo(), "no-to");
    expect(pattern).toContain("ノート");
    expect(
      matchNoteFuzzyWords(words, "no-to", pattern).map(
        ({ position, source }) => ({ position, source }),
      ),
    ).toEqual([{ position: 5, source: "migemo" }]);
  });

  it("combines fzf subsequences with Japanese Migemo matches once per word", () => {
    const words = [
      ...noteFuzzyWords(
        ["k", "e", "n", "s", "a", "k", "u"],
        [0, 1, 2, 3, 4, 5, 6],
      ),
      ...noteFuzzyWords(["検", "索"], [10, 11]),
    ];
    const pattern = migemoPatternForQuery(migemo(), "kensaku");
    expect(
      matchNoteFuzzyWords(words, "kensaku", pattern).map(
        ({ position, source }) => ({ position, source }),
      ),
    ).toEqual([
      { position: 0, source: "fzf" },
      { position: 10, source: "migemo" },
    ]);
    expect(
      matchNoteFuzzyWords(
        words,
        "ksk",
        migemoPatternForQuery(migemo(), "ksk"),
      ).some(({ word }) => word.text === "kensaku"),
    ).toBe(true);
  });

  it("keeps UTF-16 positions and searches NoteDoc words in document order", () => {
    const noteId = createUuidV7();
    const firstId = createUuidV7();
    const secondId = createUuidV7();
    const note = createNoteDocument(
      noteId,
      [
        paragraph(firstId, "😀 検索する"),
        paragraph(secondId, "kensaku と検索"),
      ],
      "タイトル",
    );
    const projection = deriveNoteFuzzySearchProjection(
      note,
      "kensaku",
      migemoPatternForQuery(migemo(), "kensaku"),
    );
    expect(
      projection.matches.map(({ blockId, offset }) => ({ blockId, offset })),
    ).toEqual([
      { blockId: firstId, offset: 3 },
      { blockId: secondId, offset: 0 },
      { blockId: secondId, offset: 9 },
    ]);
    note.doc.destroy();
  });
});
