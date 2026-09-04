import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_INDENT_WIDTH_PX,
  DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  clampApplicationZoomPercent,
  filterApplicationFontPresets,
  normalizeApplicationFontFamily,
  normalizeApplicationIndentWidthPx,
  normalizeApplicationLineNumberMinWidthPx,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
  shouldHideApplicationLineNumbers,
} from "../app/src/core/application-appearance";
import {
  APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE,
  applyApplicationIndentWidth,
} from "../app/src/platform/application-appearance";

describe("Memoka application appearance", () => {
  it("normalizes safe font-family values and filters presets", () => {
    expect(
      normalizeApplicationFontFamily("  Noto Sans CJK JP, sans-serif  "),
    ).toBe("Noto Sans CJK JP, sans-serif");
    expect(normalizeApplicationFontFamily("sans-serif; color: red")).toBeNull();
    expect(normalizeApplicationFontFamily(" ")).toBeNull();
    expect(filterApplicationFontPresets("Georgia").map(({ id }) => id)).toEqual(
      ["system-serif"],
    );
    expect(filterApplicationFontPresets("")[0]?.family).toBe(
      DEFAULT_APPLICATION_FONT_FAMILY,
    );
  });

  it("accepts only supported 10 percent zoom steps and clamps shortcuts", () => {
    expect(normalizeApplicationZoomPercent(50)).toBe(50);
    expect(normalizeApplicationZoomPercent(120)).toBe(120);
    expect(normalizeApplicationZoomPercent(125)).toBeNull();
    expect(normalizeApplicationZoomPercent(210)).toBeNull();
    expect(clampApplicationZoomPercent(205)).toBe(200);
    expect(clampApplicationZoomPercent(46)).toBe(50);
  });

  it("accepts the default note width, its supported range, and zero as unlimited", () => {
    expect(normalizeApplicationNoteMaxWidthPx(0)).toBe(0);
    expect(
      normalizeApplicationNoteMaxWidthPx(DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX),
    ).toBe(1000);
    expect(normalizeApplicationNoteMaxWidthPx(320)).toBe(320);
    expect(normalizeApplicationNoteMaxWidthPx(4096)).toBe(4096);
    expect(normalizeApplicationNoteMaxWidthPx(319)).toBeNull();
    expect(normalizeApplicationNoteMaxWidthPx(4097)).toBeNull();
    expect(normalizeApplicationNoteMaxWidthPx(1000.5)).toBeNull();
  });

  it("normalizes responsive line-number and shared indentation widths", () => {
    expect(
      normalizeApplicationLineNumberMinWidthPx(
        DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
      ),
    ).toBe(480);
    expect(normalizeApplicationLineNumberMinWidthPx(0)).toBe(0);
    expect(normalizeApplicationLineNumberMinWidthPx(239)).toBeNull();
    expect(
      normalizeApplicationIndentWidthPx(DEFAULT_APPLICATION_INDENT_WIDTH_PX),
    ).toBe(24);
    expect(normalizeApplicationIndentWidthPx(15)).toBeNull();
    expect(normalizeApplicationIndentWidthPx(65)).toBeNull();

    expect(shouldHideApplicationLineNumbers(479, 480)).toBe(true);
    expect(shouldHideApplicationLineNumbers(480, 480)).toBe(false);
    expect(shouldHideApplicationLineNumbers(320, 0)).toBe(false);
    expect(shouldHideApplicationLineNumbers(0, 480)).toBe(false);
  });

  it("scales the List alignment correction from 0.5em at 32px", () => {
    const target = document.createElement("div");
    for (const [indentWidthPx, expectedShift] of [
      [16, "0.25em"],
      [32, "0.5em"],
      [64, "1em"],
    ] as const) {
      applyApplicationIndentWidth(target, indentWidthPx);
      expect(
        target.style.getPropertyValue(
          APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE,
        ),
      ).toBe(expectedShift);
    }
  });

  it("caps and centers the complete editor canvas without changing block overflow", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.editor-root\s*\{[^}]*width: 100%;[^}]*min-width: 0;[^}]*max-width: var\(--memoka-note-max-width\);[^}]*margin-inline: auto;/su,
    );
    expect(css).toMatch(/body\s*\{[^}]*min-width: 0;/su);
    expect(css).not.toContain("min-width: 800px");
    expect(css).toMatch(
      /\.memoka-editor \.tableWrapper\s*\{[^}]*overflow-x: auto;/su,
    );
    expect(css).toMatch(/\.memoka-editor pre\s*\{[^}]*overflow-x: auto;/su);
    expect(css).toMatch(
      /\.memoka-editor :is\(ul, ol\)\s*\{[^}]*margin-inline-start: calc\(-1 \* var\(--memoka-list-inline-shift\)\);[^}]*padding-inline-start:\s*calc\(\s*var\(--memoka-indent-guide-offset\) \+ var\(--memoka-list-marker-text-offset\)\s*\)/su,
    );
    expect(css).toContain("--memoka-list-inline-shift: 0.375em");
    expect(css).toMatch(
      /\.memoka-editor :is\(ul, ol\) > li::before\s*\{[^}]*inset-inline-start: calc\(-1 \* var\(--memoka-list-marker-text-offset\)\)/su,
    );
    expect(css).toMatch(
      /\.memoka-editor :is\(ul, ol\) :is\(ul, ol\)\s*\{[^}]*margin-inline-start:\s*calc\(\s*var\(--memoka-indent-width\) - var\(--memoka-indent-guide-offset\) -\s*var\(--memoka-list-marker-text-offset\)/su,
    );
    expect(css).toMatch(
      /\.memoka-editor ol > li::before\s*\{[^}]*content: counter\(list-item\) "\.";[^}]*inset-inline-start: calc\(-1 \* var\(--memoka-ordered-list-text-gap\)\);[^}]*width: max-content;[^}]*text-align: end;[^}]*transform: translateX\(-100%\);/su,
    );
    expect(css).toMatch(
      /ul\[data-memoka-bullet-marker="2"\] > li::before\s*\{[^}]*background: transparent;/su,
    );
    expect(css).toMatch(
      /ul\[data-memoka-bullet-marker="3"\] > li::before\s*\{[^}]*border-radius: 0;/su,
    );
    expect(css).toMatch(
      /ul\[data-memoka-bullet-marker="6"\] > li::before\s*\{[^}]*background: transparent;[^}]*rotate\(45deg\)/su,
    );
    expect(css).toContain("margin-left: var(--memoka-indent-guide-offset)");
    expect(css).toMatch(
      /\.memoka-editor\s*\{[^}]*padding:[^;}]*var\(--memoka-line-number-gutter-width\)[^;}]*\+ var\(--memoka-indent-width\)[^;}]*-\s*var\(--memoka-indent-guide-offset\)/su,
    );
    expect(css).toMatch(
      /\.memoka-logical-line-gutter\s*\{[^}]*width: var\(--memoka-line-number-gutter-width\)/su,
    );
    expect(css).toMatch(
      /\[data-line-numbers-hidden="true"\] \.memoka-logical-line-gutter\s*\{[^}]*display: none;/su,
    );
    expect(css).toMatch(
      /\.memoka-vim-caret--replace\s*\{[^}]*var\(--memoka-color-danger\)/su,
    );
    expect(css).toMatch(
      /\.editor-window\[data-vim-mode="replace"\] \.window-mode\s*\{[^}]*background: var\(--memoka-color-danger\)/su,
    );
  });
});
