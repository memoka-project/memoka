import { describe, expect, it } from "vitest";
import {
  fineJapanesePhraseBoundaries,
  MAX_BUDOUX_TEXT_LENGTH,
  japanesePhraseBoundaries,
  normalizedJoinSeparator,
  segmentVimWORDCharacters,
  segmentVimWordCharacters,
} from "../app/src/vim/word-semantics";
import {
  normalizeJapaneseLineBreakSegmentationMode,
  normalizeJapaneseWordSegmentationMode,
  type JapaneseWordSegmentationMode,
} from "../app/src/core/japanese-segmentation";

function segments(
  value: string,
  hardBoundaryBefore: readonly boolean[] = [],
  mode?: JapaneseWordSegmentationMode,
) {
  return segmentVimWordCharacters(Array.from(value), hardBoundaryBefore, mode);
}

function starts(values: readonly (string | null)[]): number[] {
  return values.flatMap((value, index) =>
    value !== null && value !== values[index - 1] ? [index] : [],
  );
}

function WORDSegments(
  value: string,
  hardBoundaryBefore: readonly boolean[] = [],
) {
  return segmentVimWORDCharacters(Array.from(value), hardBoundaryBefore);
}

describe("Japanese text semantics", () => {
  it("uses BudouX phrases including punctuation", () => {
    expect(japanesePhraseBoundaries("日本語の文章を快適に編集する")).toEqual([
      4, 7, 10,
    ]);
    expect(starts(segments("日本語の文章を快適に編集する"))).toEqual([
      0, 4, 7, 10,
    ]);
    expect(new Set(segments("天気です。")).size).toBe(1);
  });

  it("can independently choose fine, BudouX, or legacy Unicode units", () => {
    const value =
      "Table内のNormal Ctrl-vはCell矩形を選ぶTable限定Visual Blockとする。";
    expect(japanesePhraseBoundaries(value)).toEqual([7, 21, 28, 50]);
    expect(fineJapanesePhraseBoundaries(value)).toEqual([7, 21, 28, 35, 50]);
    expect(starts(segments(value, [], "fine"))).toEqual([
      0, 7, 14, 21, 28, 35, 44, 50,
    ]);
    expect(starts(segments(value, [], "budoux"))).toEqual([
      0, 7, 14, 21, 28, 44, 50,
    ]);
    expect(starts(segments("日本語の文章", [], "unicode"))).toEqual([0, 3, 4]);
  });

  it("keeps fine subdivisions within kinsoku-safe grapheme boundaries", () => {
    const beforeClosing = `${"あ".repeat(11)}、${"い".repeat(11)}`;
    const afterOpening = `${"あ".repeat(11)}「${"い".repeat(11)}`;
    expect(fineJapanesePhraseBoundaries(beforeClosing)).not.toContain(11);
    expect(fineJapanesePhraseBoundaries(afterOpening)).not.toContain(12);
  });

  it("normalizes only the supported operation and display modes", () => {
    expect(normalizeJapaneseWordSegmentationMode(" FINE ")).toBe("fine");
    expect(normalizeJapaneseWordSegmentationMode("native")).toBeNull();
    expect(normalizeJapaneseLineBreakSegmentationMode("BUDOUX")).toBe("budoux");
    expect(normalizeJapaneseLineBreakSegmentationMode("unicode")).toBeNull();
  });

  it("keeps whitespace and structural boundaries as hard boundaries", () => {
    const spaced = segments("GitHub Actionsで実行する");
    expect(starts(spaced)).toEqual([0, 7, 15]);
    expect(spaced[6]).toBeNull();

    const divided = segments("日本語文章", [false, false, false, true]);
    expect(divided[2]).not.toBe(divided[3]);
  });

  it("treats each non-whitespace run as one Vim WORD", () => {
    expect(starts(WORDSegments("日本語,alpha beta"))).toEqual([0, 10]);
    expect(new Set(WORDSegments("日本語,alpha")).size).toBe(1);

    const divided = WORDSegments(
      "日本語,alpha beta",
      Array.from("日本語,alpha beta").map((_, index) => index === 4),
    );
    expect(starts(divided)).toEqual([0, 4, 10]);
  });

  it("retains Unicode-class words for non-Japanese and oversized text", () => {
    expect(starts(segments("alpha-beta_gamma"))).toEqual([0, 6]);
    const oversized = `${"日".repeat(MAX_BUDOUX_TEXT_LENGTH)}ひらがな`;
    expect(japanesePhraseBoundaries(oversized)).toBeNull();
    expect(starts(segments(oversized))).toEqual([0, MAX_BUDOUX_TEXT_LENGTH]);
  });

  it("chooses normalized J spacing from the joining text edges", () => {
    expect(normalizedJoinSeparator("日本語", "文章")).toBe("");
    expect(normalizedJoinSeparator("日本語", "API")).toBe("");
    expect(normalizedJoinSeparator("API", "について")).toBe("");
    expect(normalizedJoinSeparator("文章。", "Next")).toBe("");
    expect(normalizedJoinSeparator("alpha", "beta")).toBe(" ");
    expect(normalizedJoinSeparator("", "日本語")).toBe("");
  });
});
