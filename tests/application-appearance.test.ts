import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  clampApplicationZoomPercent,
  filterApplicationFontPresets,
  normalizeApplicationFontFamily,
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
});
