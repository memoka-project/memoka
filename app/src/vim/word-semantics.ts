import { Parser, jaModel } from "budoux";
import {
  getJapaneseSegmentationConfiguration,
  type JapaneseWordSegmentationMode,
} from "../core/japanese-segmentation";

export type VimWordClass = "han" | "hiragana" | "katakana" | "alphanumeric";

export type VimWordSegment = string;

/**
 * Keep synchronous Vim motions bounded on pathological single-line blocks.
 * ProseMirror and BudouX both express positions as UTF-16 offsets.
 */
export const MAX_BUDOUX_TEXT_LENGTH = 8_192;
export const FINE_JAPANESE_SEGMENT_MAX_GRAPHEMES = 10;

const japaneseParser = new Parser(jaModel);
const JAPANESE_SCRIPT =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
const WHITESPACE = /^\s+$/u;
const LATIN_OR_NUMBER = /^[\p{Script=Latin}\p{N}_-]$/u;
const CLOSING_KINSOKU =
  /^[、。，．・：；？！…‥ー〜～」』）］｝〉》】〕〗〙〛ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]$/u;
const OPENING_KINSOKU = /^[「『（［｛〈《【〔〖〘〚]$/u;
const japaneseGraphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

type FineBoundaryClass = "japanese" | "latin" | "other";

function fineBoundaryClass(value: string): FineBoundaryClass {
  if (JAPANESE_SCRIPT.test(value)) return "japanese";
  if (LATIN_OR_NUMBER.test(value)) return "latin";
  return "other";
}

function graphemeOffsets(value: string): readonly number[] {
  const offsets = [0];
  if (japaneseGraphemeSegmenter) {
    for (const segment of japaneseGraphemeSegmenter.segment(value)) {
      const end = segment.index + segment.segment.length;
      if (end > offsets[offsets.length - 1]!) offsets.push(end);
    }
    return offsets;
  }
  let offset = 0;
  for (const character of Array.from(value)) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

function isSafeFineBoundary(value: string, offset: number): boolean {
  const left = Array.from(value.slice(0, offset)).at(-1) ?? "";
  const right = Array.from(value.slice(offset))[0] ?? "";
  return !OPENING_KINSOKU.test(left) && !CLOSING_KINSOKU.test(right);
}

function isNaturalFineBoundary(value: string, offset: number): boolean {
  const left = Array.from(value.slice(0, offset)).at(-1) ?? "";
  const right = Array.from(value.slice(offset))[0] ?? "";
  if (!left || !right || /\s/u.test(left) || /\s/u.test(right)) return true;
  const leftClass = fineBoundaryClass(left);
  const rightClass = fineBoundaryClass(right);
  return (
    leftClass !== rightClass && leftClass !== "other" && rightClass !== "other"
  );
}

function addFineBoundariesForRun(
  value: string,
  runStart: number,
  runEnd: number,
  breaks: Set<number>,
): void {
  const run = value.slice(runStart, runEnd);
  const offsets = graphemeOffsets(run);
  const graphemeCount = offsets.length - 1;
  if (graphemeCount <= FINE_JAPANESE_SEGMENT_MAX_GRAPHEMES) return;

  const chunkCount = Math.ceil(
    graphemeCount / FINE_JAPANESE_SEGMENT_MAX_GRAPHEMES,
  );
  let cursor = 0;
  for (let chunk = 1; chunk < chunkCount; chunk += 1) {
    const remainingChunks = chunkCount - chunk + 1;
    const remainingGraphemes = graphemeCount - cursor;
    const target = cursor + Math.round(remainingGraphemes / remainingChunks);
    const minimum = Math.max(
      cursor + 1,
      graphemeCount -
        (remainingChunks - 1) * FINE_JAPANESE_SEGMENT_MAX_GRAPHEMES,
    );
    const maximum = Math.min(
      cursor + FINE_JAPANESE_SEGMENT_MAX_GRAPHEMES,
      graphemeCount - (remainingChunks - 1),
    );
    const candidates: number[] = [];
    for (let index = minimum; index <= maximum; index += 1) {
      const offset = offsets[index] ?? 0;
      if (
        isSafeFineBoundary(run, offset) &&
        isNaturalFineBoundary(run, offset)
      ) {
        candidates.push(index);
      }
    }
    let selected = candidates.sort(
      (left, right) =>
        Math.abs(left - target) - Math.abs(right - target) || left - right,
    )[0];
    if (selected === undefined) {
      const safeFallbacks: number[] = [];
      for (let index = minimum; index <= maximum; index += 1) {
        if (isSafeFineBoundary(run, offsets[index] ?? 0)) {
          safeFallbacks.push(index);
        }
      }
      selected =
        safeFallbacks.sort(
          (left, right) =>
            Math.abs(left - target) - Math.abs(right - target) || left - right,
        )[0] ?? Math.min(maximum, Math.max(minimum, target));
    }
    breaks.add(runStart + (offsets[selected] ?? 0));
    cursor = selected;
  }
}

type RawVimWordClass = VimWordClass | "kana-shared" | "inherited" | null;

function rawVimWordClass(value: string): RawVimWordClass {
  if (/\p{Script=Han}/u.test(value)) return "han";
  if (/\p{Script=Hiragana}/u.test(value)) return "hiragana";
  if (/\p{Script=Katakana}/u.test(value)) return "katakana";
  if (
    /\p{Script_Extensions=Hiragana}/u.test(value) &&
    /\p{Script_Extensions=Katakana}/u.test(value)
  ) {
    return "kana-shared";
  }
  if (/[\p{L}\p{N}_]/u.test(value)) return "alphanumeric";
  if (/\p{M}/u.test(value)) return "inherited";
  return null;
}

function isResolvedWordClass(value: RawVimWordClass): value is VimWordClass {
  return (
    value === "han" ||
    value === "hiragana" ||
    value === "katakana" ||
    value === "alphanumeric"
  );
}

function adjacentWordClass(
  classes: readonly RawVimWordClass[],
  index: number,
  direction: -1 | 1,
): VimWordClass | null {
  let cursor = index + direction;
  while (classes[cursor] === "kana-shared" || classes[cursor] === "inherited") {
    cursor += direction;
  }
  const candidate = classes[cursor] ?? null;
  return isResolvedWordClass(candidate) ? candidate : null;
}

export function classifyVimWordCharacters(
  characters: readonly string[],
): Array<VimWordClass | null> {
  const raw = characters.map(rawVimWordClass);
  return raw.map((value, index) => {
    if (isResolvedWordClass(value) || value === null) return value;
    const previous = adjacentWordClass(raw, index, -1);
    const next = adjacentWordClass(raw, index, 1);
    if (value === "kana-shared") {
      if (previous === "hiragana" || previous === "katakana") return previous;
      if (next === "hiragana" || next === "katakana") return next;
      return "katakana";
    }
    return previous ?? next;
  });
}

export function containsJapaneseText(value: string): boolean {
  return JAPANESE_SCRIPT.test(value);
}

/**
 * Returns BudouX phrase boundaries as UTF-16 offsets. Oversized text is
 * deliberately rejected so callers can use their cheap/native fallback.
 */
export function japanesePhraseBoundaries(
  value: string,
): readonly number[] | null {
  if (!value || !containsJapaneseText(value)) return [];
  if (value.length > MAX_BUDOUX_TEXT_LENGTH) return null;
  return japaneseParser.parseBoundaries(value);
}

/** BudouX boundaries plus balanced, kinsoku-safe subdivisions of long runs. */
export function fineJapanesePhraseBoundaries(
  value: string,
): readonly number[] | null {
  if (!containsJapaneseText(value)) return [];
  const budouxBoundaries = japanesePhraseBoundaries(value);
  if (budouxBoundaries === null) return null;
  const breaks = new Set(budouxBoundaries);
  const phraseBoundaries = [0, ...budouxBoundaries, value.length];
  for (
    let phraseIndex = 0;
    phraseIndex < phraseBoundaries.length - 1;
    phraseIndex += 1
  ) {
    const phraseStart = phraseBoundaries[phraseIndex] ?? 0;
    const phraseEnd = phraseBoundaries[phraseIndex + 1] ?? value.length;
    let runStart = phraseStart;
    for (let offset = phraseStart; offset <= phraseEnd; offset += 1) {
      const atEnd = offset === phraseEnd;
      const whitespace = !atEnd && /\s/u.test(value[offset] ?? "");
      if (!atEnd && !whitespace) continue;
      if (runStart < offset) {
        addFineBoundariesForRun(value, runStart, offset, breaks);
      }
      runStart = offset + 1;
    }
  }
  return [...breaks].sort((left, right) => left - right);
}

function fallbackSegments(
  characters: readonly string[],
  group: number,
): Array<VimWordSegment | null> {
  const classes = classifyVimWordCharacters(characters);
  let run = -1;
  let previous: VimWordClass | null | undefined;
  return classes.map((wordClass) => {
    if (wordClass === null) {
      previous = null;
      return null;
    }
    if (wordClass !== previous) run += 1;
    previous = wordClass;
    return `unicode:${group}:${run}:${wordClass}`;
  });
}

/**
 * Classifies cursor characters into the shared Memoka word units.
 *
 * Whitespace and caller-provided structural boundaries always split units.
 * A non-whitespace run containing Japanese uses the configured fine, BudouX,
 * or legacy Unicode units. Non-Japanese and oversized runs retain the Unicode
 * script-class fallback.
 */
export function segmentVimWordCharacters(
  characters: readonly string[],
  hardBoundaryBefore: readonly boolean[] = [],
  mode: JapaneseWordSegmentationMode = getJapaneseSegmentationConfiguration()
    .wordSegmentation,
): Array<VimWordSegment | null> {
  const result: Array<VimWordSegment | null> = Array.from(
    { length: characters.length },
    () => null,
  );
  let index = 0;
  let group = 0;
  while (index < characters.length) {
    if (WHITESPACE.test(characters[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (
      index < characters.length &&
      !hardBoundaryBefore[index] &&
      !WHITESPACE.test(characters[index] ?? "")
    ) {
      index += 1;
    }
    const runCharacters = characters.slice(start, index);
    const text = runCharacters.join("");
    const hasJapaneseText = containsJapaneseText(text);
    const boundaries =
      mode === "unicode" || !hasJapaneseText
        ? null
        : mode === "fine"
          ? fineJapanesePhraseBoundaries(text)
          : japanesePhraseBoundaries(text);
    if (mode === "unicode" || boundaries === null || !hasJapaneseText) {
      const fallback = fallbackSegments(runCharacters, group);
      fallback.forEach((segment, offset) => {
        result[start + offset] = segment;
      });
      group += 1;
      continue;
    }

    let phrase = 0;
    let textOffset = 0;
    let boundaryIndex = 0;
    for (let offset = 0; offset < runCharacters.length; offset += 1) {
      while (
        boundaryIndex < boundaries.length &&
        textOffset >= (boundaries[boundaryIndex] ?? Number.POSITIVE_INFINITY)
      ) {
        phrase += 1;
        boundaryIndex += 1;
      }
      result[start + offset] = `${mode}:${group}:${phrase}`;
      textOffset += (runCharacters[offset] ?? "").length;
    }
    group += 1;
  }
  return result;
}

/**
 * Classifies cursor characters into Vim WORD units.
 *
 * Unlike the configurable lowercase word semantics, a WORD is simply one
 * consecutive run of non-whitespace characters. Caller-provided structural
 * boundaries still split runs so separate Cells and inline structures do not
 * accidentally become one WORD merely because their document positions are
 * adjacent in the flattened cursor model.
 */
export function segmentVimWORDCharacters(
  characters: readonly string[],
  hardBoundaryBefore: readonly boolean[] = [],
): Array<VimWordSegment | null> {
  const result: Array<VimWordSegment | null> = Array.from(
    { length: characters.length },
    () => null,
  );
  let group = -1;
  let insideWord = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (!character || WHITESPACE.test(character)) {
      insideWord = false;
      continue;
    }
    if (!insideWord || hardBoundaryBefore[index]) group += 1;
    result[index] = `WORD:${group}`;
    insideWord = true;
  }
  return result;
}

const JAPANESE_TYPOGRAPHIC_EDGE =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}、。，．・：；？！…‥〜～「」『』（）［］｛｝〈〉《》【】〔〕〖〗〘〙〚〛]/u;

export function isJapaneseTypographicEdge(value: string): boolean {
  return JAPANESE_TYPOGRAPHIC_EDGE.test(value);
}

/** Separator used by normalized J; gJ deliberately bypasses this helper. */
export function normalizedJoinSeparator(left: string, right: string): string {
  if (!left || !right) return "";
  const leftEdge = Array.from(left).at(-1) ?? "";
  const rightEdge = Array.from(right)[0] ?? "";
  return isJapaneseTypographicEdge(leftEdge) ||
    isJapaneseTypographicEdge(rightEdge)
    ? ""
    : " ";
}
