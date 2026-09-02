import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_THEMES,
  APPLICATION_THEME_IDS,
  DEFAULT_APPLICATION_THEME_ID,
  applicationTheme,
  filterApplicationThemes,
  markupHeadingLevelForSectionDepth,
  nextMarkupHeadingLevel,
  normalizeApplicationThemeId,
} from "../app/src/core/application-theme";
import {
  APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE,
  APPLICATION_THEME_DATA_ATTRIBUTE,
  applicationThemeCssProperties,
  applyApplicationTheme,
} from "../app/src/platform/application-theme";

describe("Memoka application themes", () => {
  it("ships every official Nightfox variant with stable source palette values", () => {
    expect(APPLICATION_THEME_IDS).toEqual([
      "nightfox",
      "dayfox",
      "dawnfox",
      "duskfox",
      "nordfox",
      "terafox",
      "carbonfox",
    ]);
    expect(DEFAULT_APPLICATION_THEME_ID).toBe("nightfox");
    expect(
      Object.fromEntries(
        APPLICATION_THEMES.map(({ id, palette }) => [
          id,
          [palette.bg1, palette.fg1, palette.blue],
        ]),
      ),
    ).toEqual({
      nightfox: ["#192330", "#cdcecf", "#719cd6"],
      dayfox: ["#f6f2ee", "#3d2b5a", "#2848a9"],
      dawnfox: ["#faf4ed", "#575279", "#286983"],
      duskfox: ["#232136", "#e0def4", "#569fba"],
      nordfox: ["#2e3440", "#cdcecf", "#81a1c1"],
      terafox: ["#152528", "#e6eaea", "#5a93aa"],
      carbonfox: ["#161616", "#f2f4f8", "#78a9ff"],
    });
  });

  it("normalizes names and filters the picker with AND semantics", () => {
    expect(normalizeApplicationThemeId(" DUSKFOX ")).toBe("duskfox");
    expect(normalizeApplicationThemeId("legacy")).toBeNull();
    expect(filterApplicationThemes("light day").map(({ id }) => id)).toEqual([
      "dayfox",
    ]);
    expect(filterApplicationThemes("暗色 nord").map(({ id }) => id)).toEqual([
      "nordfox",
    ]);
  });

  it("derives Neovim-style markup colors from every Nightfox palette", () => {
    for (const theme of APPLICATION_THEMES) {
      expect(theme.tokens).toMatchObject({
        markupStrong: theme.palette.red,
        markupItalic: theme.palette.yellow,
        markupStrikethrough: theme.palette.comment,
        markupRaw: theme.palette.cyan,
        markupLinkUrl: theme.palette.orange,
        markupLinkReference: theme.palette.magenta,
        markupHeading1: theme.palette.red,
        markupHeading2: theme.palette.orange,
        markupHeading3: theme.palette.yellow,
        markupHeading4: theme.palette.green,
        markupHeading5: theme.palette.cyan,
        markupHeading6: theme.palette.blue,
      });
    }
  });

  it("cycles Section depths through the six Markdown heading colors", () => {
    expect(
      Array.from({ length: 14 }, (_, depth) =>
        markupHeadingLevelForSectionDepth(depth),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2]);
    expect(nextMarkupHeadingLevel(6)).toBe(1);
    expect(() => markupHeadingLevelForSectionDepth(-1)).toThrow(
      "Section depth must be a non-negative integer",
    );
  });

  it("projects every semantic token onto the application root", () => {
    const target = document.createElement("div");
    applyApplicationTheme(target, "dayfox");
    expect(target.getAttribute(APPLICATION_THEME_DATA_ATTRIBUTE)).toBe(
      "dayfox",
    );
    expect(
      target.getAttribute(APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE),
    ).toBe("light");
    expect(target.style.colorScheme).toBe("light");
    const properties = applicationThemeCssProperties("dayfox");
    expect(Object.keys(properties)).toHaveLength(
      Object.keys(applicationTheme("dayfox").tokens).length,
    );
    for (const [name, value] of Object.entries(properties)) {
      expect(target.style.getPropertyValue(name)).toBe(value);
    }

    applyApplicationTheme(target, "nightfox");
    expect(
      target.getAttribute(APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE),
    ).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("keeps component CSS on semantic tokens instead of literal colors", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\s*\(/iu);
    expect(css).toContain("var(--memoka-color-focus)");
    expect(css).toContain("var(--memoka-color-selection)");
    expect(css).toContain("var(--memoka-color-danger-surface)");
    expect(css).toContain("var(--memoka-color-markup-strong)");
    expect(css).toContain("var(--memoka-color-markup-link-reference)");
    expect(css).toContain("var(--memoka-color-markup-heading-6)");
    expect(css).toMatch(
      /:root\[data-memoka-theme-appearance="light"\][\s\S]*?-webkit-font-smoothing: antialiased;/u,
    );
  });
});
