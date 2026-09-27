import { Fzf, extendedMatch } from "fzf";
import type { Migemo } from "jsmigemo";
import { graphemes } from "../vim/graphemes";
import { segmentVimWordCharacters } from "../vim/word-semantics";
import type { NoteDocument } from "./documents";
import {
  deriveNoteSearchProjection,
  type NoteSearchLocation,
  type NoteSearchMatch,
  type NoteSearchProjection,
} from "./note-search";

/** `positions` use the caller's coordinates: ProseMirror positions or unit offsets. */
export interface NoteFuzzyWord {
  readonly text: string;
  readonly characterOffsets: readonly number[];
  readonly positions: readonly number[];
}

export interface NoteFuzzyResult<T extends NoteFuzzyWord> {
  readonly word: T;
  readonly position: number;
  readonly score: number;
  readonly source: "fzf" | "migemo";
}

export function noteFuzzyWords(
  characters: readonly string[],
  positions: readonly number[],
  hardBoundaryBefore: readonly boolean[] = [],
): NoteFuzzyWord[] {
  const segments = segmentVimWordCharacters(characters, hardBoundaryBefore);
  const words: NoteFuzzyWord[] = [];
  for (let index = 0; index < segments.length;) {
    const segment = segments[index];
    if (segment === null) {
      index += 1;
      continue;
    }
    const start = index;
    let text = "";
    const characterOffsets: number[] = [];
    const wordPositions: number[] = [];
    while (index < segments.length && segments[index] === segment) {
      characterOffsets.push(text.length);
      text += characters[index] ?? "";
      wordPositions.push(positions[index] ?? 0);
      index += 1;
    }
    if (text && wordPositions.length && start < positions.length) {
      words.push({ text, characterOffsets, positions: wordPositions });
    }
  }
  return words;
}

export function noteFuzzyPositionAtOffset(
  word: NoteFuzzyWord,
  offset: number,
): number {
  let index = 0;
  while (
    index + 1 < word.characterOffsets.length &&
    word.characterOffsets[index + 1]! <= offset
  ) {
    index += 1;
  }
  return word.positions[index] ?? 0;
}

/** One result per word; fzf results precede Migemo-only results. */
export function matchNoteFuzzyWords<T extends NoteFuzzyWord>(
  words: readonly T[],
  query: string,
  migemoPattern: string,
): NoteFuzzyResult<T>[] {
  if (!query || query.length > 128 || words.length === 0) return [];
  const fzf = new Fzf<NoteFuzzyWord[]>([...words], {
    selector: (word) => word.text,
    match: extendedMatch,
  });
  const results: NoteFuzzyResult<T>[] = fzf.find(query).map((entry) => ({
    word: entry.item as T,
    position: noteFuzzyPositionAtOffset(entry.item, entry.start),
    score: entry.score,
    source: "fzf",
  }));
  const seen = new Set(results.map(({ word }) => word));
  if (migemoPattern) {
    // jsmigemo escapes hyphens as `\-`, which is valid without the Unicode
    // flag but is an invalid identity escape with it.
    const expression = new RegExp(migemoPattern, "i");
    for (const word of words) {
      if (seen.has(word)) continue;
      const match = expression.exec(word.text);
      if (!match?.[0]) continue;
      results.push({
        word,
        position: noteFuzzyPositionAtOffset(word, match.index),
        score: 0,
        source: "migemo",
      });
    }
  }
  return results;
}

export function deriveNoteFuzzySearchProjection(
  note: NoteDocument,
  query: string,
  migemoPattern: string,
  scopeSectionId: string = note.noteId,
): NoteSearchProjection {
  const { units } = deriveNoteSearchProjection(note, "", scopeSectionId);
  const words: Array<
    NoteFuzzyWord & {
      location: NoteSearchLocation;
      order: number;
      kind: NoteSearchMatch["kind"];
      unitText: string;
    }
  > = [];
  for (const unit of units) {
    if (unit.kind === "atom") continue;
    const characters = graphemes(unit.text);
    let offset = 0;
    const positions = characters.map((character) => {
      const current = offset;
      offset += character.length;
      return current;
    });
    for (const word of noteFuzzyWords(characters, positions)) {
      words.push({
        ...word,
        location: {
          sectionId: unit.sectionId,
          blockId: unit.blockId,
          offset: 0,
        },
        order: unit.order,
        kind: unit.kind,
        unitText: unit.text,
      });
    }
  }
  const matches: NoteSearchMatch[] = matchNoteFuzzyWords(
    words,
    query,
    migemoPattern,
  )
    .map(({ word, position }) => ({
      ...word.location,
      offset: position,
      order: word.order,
      kind: word.kind,
      text: word.unitText,
      query,
    }))
    .sort(
      (left, right) => left.order - right.order || left.offset - right.offset,
    );
  return { query, units, matches };
}

export function migemoPatternForQuery(migemo: Migemo, query: string): string {
  return query && query.length <= 128 ? migemo.query(query) : "";
}
