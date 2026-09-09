import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPLICATION_THEMES,
  APPLICATION_THEME_IDS,
  DEFAULT_APPLICATION_THEME_ID,
  applicationTheme,
  filterApplicationThemes,
  markupHeadingLevelForSectionDepth,
  nextMarkupHeadingLevel,
  normalizeApplicationThemeId,
  setCustomApplicationThemes,
  type CustomApplicationThemes,
} from "../app/src/core/application-theme";
import {
  APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE,
  APPLICATION_THEME_DATA_ATTRIBUTE,
  applicationThemeCssProperties,
  applyApplicationTheme,
} from "../app/src/platform/application-theme";

describe("Memoka application themes", () => {
  afterEach(() => setCustomApplicationThemes({}));

  it("derives named custom palettes and exposes them in the picker and every semantic token", () => {
    setCustomApplicationThemes({
      "my-dark": {
        base: "nightfox",
        name: "私の夜",
        palette: { bg1: "#101020", red: "#ef7777", blue: "#99bbff" },
      },
    });
    const custom = applicationTheme("my-dark");
    expect(custom.appearance).toBe("dark");
    expect(custom.tokens.canvas).toBe("#101020");
    expect(custom.tokens.markupHeading1).toBe("#ef7777");
    expect(custom.tokens.modeNormal).toBe("#99bbff");
    expect(custom.palette.green).toBe(
      applicationTheme("nightfox").palette.green,
    );
    expect(filterApplicationThemes("私の").map((theme) => theme.id)).toEqual([
      "my-dark",
    ]);
    const element = document.createElement("div");
    applyApplicationTheme(element, "my-dark");
    expect(element.style.getPropertyValue("--memoka-color-mode-normal")).toBe(
      "#99bbff",
    );
    setCustomApplicationThemes({
      "my-dark": { base: "dayfox", palette: { blue: "#224488" } },
    });
    applyApplicationTheme(element, "my-dark");
    expect(element.style.colorScheme).toBe("light");
    expect(element.style.getPropertyValue("--memoka-color-mode-normal")).toBe(
      "#224488",
    );
    setCustomApplicationThemes({});
    expect(normalizeApplicationThemeId("my-dark")).toBeNull();
  });

  it("rejects a bad custom theme batch without replacing the active registry", () => {
    setCustomApplicationThemes({ kept: { base: "nightfox" } });
    for (const bad of [
      { nightfox: { base: "dayfox" } },
      { bad: { base: "kept" } },
      { bad: { base: "dayfox", palette: { red: "url(https://example.com)" } } },
      { bad: { base: "dayfox", palette: { typo: "#abcdef" } } },
      { bad: { base: "dayfox", stylesheet: "evil" } },
    ]) {
      expect(() =>
        setCustomApplicationThemes(bad as unknown as CustomApplicationThemes),
      ).toThrow();
      expect(applicationTheme("kept").id).toBe("kept");
    }
  });
  it("ships every Nightfox variant with stable adopted palette values", () => {
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
      carbonfox: ["#171414", "#cac5c4", "#4589ff"],
    });
    expect(applicationTheme("carbonfox").palette).toMatchObject({
      red: "#da1e28",
      yellow: "#b28600",
      orange: "#eb6200",
      green: "#24a148",
      cyan: "#009d9a",
      blue: "#4589ff",
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
        modeNormal: theme.palette.blue,
        modeInsert: theme.palette.green,
        modeVisual: theme.palette.magenta,
      });
    }
  });

  it("uses the six absolute Note depths without an H7 color cycle", () => {
    expect(
      Array.from({ length: 6 }, (_, depth) =>
        markupHeadingLevelForSectionDepth(depth),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(nextMarkupHeadingLevel(6)).toBe(6);
    expect(() => markupHeadingLevelForSectionDepth(6)).toThrow("0 to 5");
    expect(() => markupHeadingLevelForSectionDepth(-1)).toThrow(
      "Section depth must be an integer from 0 to 5",
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
    expect(css).toContain("var(--memoka-color-mode-normal)");
    expect(css).toContain("var(--memoka-color-mode-insert)");
    expect(css).toContain("var(--memoka-color-mode-visual)");
    expect(css).toMatch(/\.memoka-details-summary\s*\{[^}]*font: inherit;/u);
    expect(css).not.toMatch(
      /\.memoka-details-summary\[data-empty="true"\]::after/u,
    );
    expect(css).toMatch(
      /mark\[data-memoka-highlight="true"\][\s\S]*?var\(--memoka-color-search-match-surface\)/u,
    );
    expect(css).toMatch(
      /blockquote\[data-memoka-alert-type\][\s\S]*?var\(--memoka-color-info\)/u,
    );
    expect(css).toMatch(
      /\.memoka-visual-char-selected\s*\{[\s\S]*?background: var\(--memoka-color-selection\)/u,
    );
    expect(css).toMatch(
      /data-vim-mode="visual-char"[\s\S]*?::selection[\s\S]*?background-color: transparent/u,
    );
    expect(css).toMatch(
      /\.memoka-editor :is\(ul, ol\) > li::before\s*\{[\s\S]*?var\(--memoka-color-markup-raw\)/u,
    );
    expect(css).toMatch(
      /:root\[data-memoka-theme-appearance="light"\][\s\S]*?-webkit-font-smoothing: antialiased;/u,
    );
  });
});
