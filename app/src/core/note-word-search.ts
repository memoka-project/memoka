import { graphemes } from "../vim/graphemes";
import { segmentVimWordCharacters } from "../vim/word-semantics";
import type { NoteDocument } from "./documents";
import {
  deriveNoteSearchProjection,
  normalizeNoteSearchToken,
  type NoteSearchLocation,
  type NoteSearchMatch,
  type NoteSearchProjection,
  type NoteSearchUnit,
} from "./note-search";

interface WordToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly punctuation: boolean;
}

function wordTokens(text: string): WordToken[] {
  const characters = graphemes(text);
  const segments = segmentVimWordCharacters(characters, [], "unicode");
  const tokens: WordToken[] = [];
  let offset = 0;
  let index = 0;
  while (index < characters.length) {
    const segment = segments[index];
    const start = offset;
    let value = "";
    do {
      value += characters[index] ?? "";
      offset += characters[index]?.length ?? 0;
      index += 1;
    } while (
      index < characters.length &&
      segment !== null &&
      segments[index] === segment
    );
    if (segment !== null) {
      tokens.push({
        text: value,
        start,
        end: offset,
        punctuation: segment.endsWith(":punctuation"),
      });
    }
  }
  return tokens;
}

function sourceUnit(
  units: readonly NoteSearchUnit[],
  location: NoteSearchLocation,
): NoteSearchUnit | undefined {
  return units.find(
    (unit) =>
      unit.kind !== "atom" &&
      unit.sectionId === location.sectionId &&
      unit.blockId === location.blockId,
  );
}

/** Find the current keyword, the next keyword, then punctuation on this logical line. */
export function noteWordAtOrigin(
  units: readonly NoteSearchUnit[],
  location: NoteSearchLocation,
): string | null {
  const unit = sourceUnit(units, location);
  if (!unit) return null;
  const offset = Math.max(0, Math.min(location.offset, unit.text.length));
  const lineStart = unit.text.lastIndexOf("\n", offset - 1) + 1;
  const nextBreak = unit.text.indexOf("\n", offset);
  const lineEnd = nextBreak < 0 ? unit.text.length : nextBreak;
  const tokens = wordTokens(unit.text.slice(lineStart, lineEnd)).map(
    (token) => ({
      ...token,
      start: token.start + lineStart,
      end: token.end + lineStart,
    }),
  );
  const current = tokens.find(
    (token) => token.start <= offset && offset < token.end,
  );
  if (current && !current.punctuation) return current.text;
  const nextKeyword = tokens.find(
    (token) => !token.punctuation && token.start >= offset,
  );
  if (nextKeyword) return nextKeyword.text;
  if (current) return current.text;
  return (
    tokens.find((token) => token.punctuation && token.start >= offset)?.text ??
    null
  );
}

/** Whole-token, normalized search; atom alt text is deliberately excluded. */
export function deriveNoteWordSearchProjection(
  note: NoteDocument,
  query: string,
  scopeSectionId: string = note.noteId,
): NoteSearchProjection {
  const { units } = deriveNoteSearchProjection(note, "", scopeSectionId);
  const normalizedQuery = normalizeNoteSearchToken(query);
  const matches: NoteSearchMatch[] = [];
  if (normalizedQuery) {
    for (const unit of units) {
      if (unit.kind === "atom") continue;
      for (const token of wordTokens(unit.text)) {
        if (normalizeNoteSearchToken(token.text) !== normalizedQuery) continue;
        matches.push({
          sectionId: unit.sectionId,
          blockId: unit.blockId,
          offset: token.start,
          order: unit.order,
          query,
          text: unit.text,
          kind: unit.kind,
        });
      }
    }
  }
  return { query, units, matches };
}
