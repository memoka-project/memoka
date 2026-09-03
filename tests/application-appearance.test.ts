import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  clampApplicationZoomPercent,
  filterApplicationFontPresets,
  normalizeApplicationFontFamily,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
} from "../app/src/core/application-appearance";

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

  it("caps and centers the complete editor canvas without changing block overflow", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.editor-root\s*\{[^}]*width: 100%;[^}]*min-width: 0;[^}]*max-width: var\(--memoka-note-max-width\);[^}]*margin-inline: auto;/su,
    );
    expect(css).toMatch(
      /\.memoka-editor \.tableWrapper\s*\{[^}]*overflow-x: auto;/su,
    );
    expect(css).toMatch(/\.memoka-editor pre\s*\{[^}]*overflow-x: auto;/su);
  });
});
