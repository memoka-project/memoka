import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_INDENT_WIDTH_PX,
  DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  DEFAULT_NOTE_APPEARANCE,
  clampApplicationZoomPercent,
  filterApplicationFontPresets,
  normalizeApplicationFontFamily,
  normalizeApplicationIndentWidthPx,
  normalizeApplicationLineNumberMinWidthPx,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
  normalizeNoteAppearance,
  normalizeNoteGapEm,
  normalizeNoteLineHeight,
  normalizeNoteSectionTitleSizeEm,
  shouldHideApplicationLineNumbers,
} from "../app/src/core/application-appearance";
import {
  APPLICATION_INDENT_GUIDE_OFFSET_CSS_VARIABLE,
  APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE,
  applyApplicationIndentWidth,
  applyNoteAppearance,
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

  it("validates and applies the complete Note appearance as CSS variables", () => {
    expect(DEFAULT_NOTE_APPEARANCE).toMatchObject({
      lineHeight: 1.5,
      listItemGapEm: 0.1,
      sectionTitleGapBeforeEm: 0.4,
      sectionTitleGapAfterEm: 0.4,
    });
    expect(normalizeNoteLineHeight(1)).toBe(1);
    expect(normalizeNoteLineHeight(2.5)).toBe(2.5);
    expect(normalizeNoteLineHeight(2.501)).toBeNull();
    expect(normalizeNoteGapEm(0)).toBe(0);
    expect(normalizeNoteGapEm(3)).toBe(3);
    expect(normalizeNoteGapEm(3.01)).toBeNull();
    expect(normalizeNoteSectionTitleSizeEm(0.8)).toBe(0.8);
    expect(normalizeNoteSectionTitleSizeEm(3.001)).toBeNull();
    expect(
      normalizeNoteAppearance({
        ...DEFAULT_NOTE_APPEARANCE,
        lineHeight: 1.555,
      }),
    ).toBeNull();

    const target = document.createElement("div");
    applyNoteAppearance(target, {
      ...DEFAULT_NOTE_APPEARANCE,
      japaneseFontFamily: '"Yu Gothic", sans-serif',
      latinFontFamily: "Inter, sans-serif",
      monospaceFontFamily: "monospace",
      lineHeight: 1.8,
      blockGapEm: 1.1,
      listItemGapEm: 0.25,
      sectionTitleGapBeforeEm: 0.6,
      sectionTitleGapAfterEm: 0.4,
      sectionTitleSizeEm: 1.4,
    });
    expect(target.style.getPropertyValue("--memoka-note-font-family")).toBe(
      'Inter, sans-serif, "Yu Gothic", sans-serif',
    );
    expect(target.style.getPropertyValue("--memoka-note-font-monospace")).toBe(
      "monospace",
    );
    expect(target.style.getPropertyValue("--memoka-note-line-height")).toBe(
      "1.8",
    );
    expect(target.style.getPropertyValue("--memoka-note-block-gap")).toBe(
      "1.1em",
    );
    expect(target.style.getPropertyValue("--memoka-list-item-gap")).toBe(
      "0.25em",
    );
    expect(
      target.style.getPropertyValue("--memoka-table-cell-padding-block"),
    ).toBe("8.727px");
  });

  it("places the guide at 60% and scales the List alignment correction", () => {
    const target = document.createElement("div");
    for (const [indentWidthPx, expectedGuide, expectedShift] of [
      [16, "9.6px", "0.25em"],
      [32, "19.2px", "0.5em"],
      [64, "38.4px", "1em"],
    ] as const) {
      applyApplicationIndentWidth(target, indentWidthPx);
      expect(
        target.style.getPropertyValue(
          APPLICATION_INDENT_GUIDE_OFFSET_CSS_VARIABLE,
        ),
      ).toBe(expectedGuide);
      expect(
        target.style.getPropertyValue(
          APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE,
        ),
      ).toBe(expectedShift);
    }
  });

  it("keeps spacing around rich blocks at both edges of a ListItem", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.memoka-editor :is\(li, \.memoka-task-content\) > :is\(p, ul, ol\):first-child\s*\{\s*margin-top: 0;/su,
    );
    expect(css).toMatch(
      /\.memoka-editor :is\(li, \.memoka-task-content\) > :is\(p, ul, ol\):last-child\s*\{\s*margin-bottom: 0;/su,
    );
    expect(css).not.toMatch(/\.memoka-editor li > :(first|last)-child\s*\{/su);

    // Only Paragraph/List edges should match the compact spacing rules,
    // including items whose first/only block is an image, table, or code.
    for (const parent of ["li", "div"]) {
      const item = document.createElement(parent);
      if (parent === "div") item.className = "memoka-task-content";
      for (const tag of ["p", "ul", "ol", "pre", "blockquote", "div", "hr"]) {
        const child = document.createElement(tag);
        item.replaceChildren(child);
        const compact = ["p", "ul", "ol"].includes(tag);
        expect(
          child.matches(
            ":is(li, .memoka-task-content) > :is(p, ul, ol):first-child",
          ),
        ).toBe(compact);
        expect(
          child.matches(
            ":is(li, .memoka-task-content) > :is(p, ul, ol):last-child",
          ),
        ).toBe(compact);
      }
    }
  });

  it("lets Details own outer padding and spaces only adjacent body blocks", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.memoka-details-body\[data-details-body\]\s+> \*\s*\{\s*margin-block: 0;/su,
    );
    expect(css).toMatch(
      /\.memoka-details-body\[data-details-body\]\s+> \*\s+\+ \*\s*\{\s*margin-block-start: var\(--memoka-note-block-gap\);/su,
    );
    expect(css).toMatch(
      /\.memoka-details-body\[data-details-body\]\s+> :is\([^}]+\)\s*\{\s*margin-inline-start: var\(--memoka-block-grid-offset\);\s*width: calc\(100% - var\(--memoka-block-grid-offset\)\);\s*max-width: calc\(100% - var\(--memoka-block-grid-offset\)\);/su,
    );
    expect(css).toContain(
      "padding-inline-start: calc(var(--memoka-indent-guide-offset) - 1px)",
    );
    expect(css).toContain(
      "padding-inline-end: calc(var(--memoka-indent-width) - 1px)",
    );
    expect(css).toMatch(
      /\.memoka-details:not\(\[data-details-expanded="false"\]\):has\([^{}]+:last-child\s*\)\s*\{[^}]*padding-block-end: max\(0px, calc\(var\(--memoka-note-block-gap\) - 1px\)\);/su,
    );
  });

  it("gives rich List blocks equal leading and trailing spacing", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\)\s+:is\(li, \.memoka-task-content\)\s+> :is\(\s*pre,[^}]*blockquote,[^}]*\.memoka-details,[^}]*\)\s*\{[^}]*margin-block: calc\(2 \* var\(--memoka-list-item-gap\)\);/su,
    );
    expect(css).toMatch(
      /> :where\(:not\(ul, ol, \.memoka-task-checkbox\)\)\s+\+ :where\(:not\(ul, ol, \.memoka-task-content\)\)\s*\{\s*margin-top: var\(--memoka-list-item-gap\);/su,
    );
    expect(css).toMatch(
      /li:has\([^{}]+\+ li:has\([^{}]+\{\s*margin-top: calc\(4 \* var\(--memoka-list-item-gap\)\);/su,
    );
  });

  it("uses one vertical gap for sibling and nested ListItems at every depth", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    expect(css).toContain("--memoka-list-item-gap: 0.1em");
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\)[^{]*:is\(ul, ol\)\s+:is\(ul, ol\)\s*\{[^}]*margin-block-start: var\(--memoka-list-item-gap\);/su,
    );
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\)[^{]*:is\(ul, ol\) > li \+ li\s*\{[^}]*margin-block-start: var\(--memoka-list-item-gap\);/su,
    );
    expect(css).not.toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\)[^{]*:is\(ul, ol\) > li \+ li\s*\{[^}]*margin-top:/su,
    );
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
      /:is\(\.memoka-editor, \.workspace-search-preview-document\) \.tableWrapper\s*\{[^}]*overflow-x: auto;/su,
    );
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\) pre\s*\{[^}]*overflow-x: auto;/su,
    );
    expect(css).toMatch(
      /\.memoka-code-block\s+code\s*\{[^}]*font-family: inherit;/su,
    );
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\) :is\(ul, ol\)\s*\{[^}]*margin-inline-start: calc\(-1 \* var\(--memoka-list-inline-shift\)\);[^}]*padding-inline-start:\s*calc\(\s*var\(--memoka-indent-guide-offset\) \+ var\(--memoka-list-marker-text-offset\)\s*\)/su,
    );
    expect(css).toContain("--memoka-list-inline-shift: 0.375em");
    expect(css).toMatch(
      /--memoka-block-grid-offset:\s*calc\(\s*var\(--memoka-indent-width\) - var\(--memoka-indent-guide-offset\)\s*\)/su,
    );
    expect(css).toMatch(
      /\.memoka-editor :is\(ul, ol\) > li::before\s*\{[^}]*inset-inline-start: calc\(-1 \* var\(--memoka-list-marker-text-offset\)\)/su,
    );
    expect(css).toMatch(
      /:is\(\.memoka-editor, \.workspace-search-preview-document\)[^{]*:is\(ul, ol\)\s+:is\(ul, ol\)\s*\{[^}]*margin-inline-start:\s*calc\(\s*var\(--memoka-indent-width\) - var\(--memoka-indent-guide-offset\) -\s*var\(--memoka-list-marker-text-offset\)/su,
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
    expect(css).toMatch(
      /\.memoka-editor ul > li::before\s*\{[^}]*inset-block-start: calc\(var\(--memoka-note-line-height\) \* 0\.5em - 0\.24em\);/su,
    );
    expect(css).toMatch(
      /margin-left:\s*calc\(\s*var\(--memoka-indent-width\) - var\(--memoka-indent-guide-offset\)\s*\)/su,
    );
    expect(css).toMatch(
      /\.memoka-editor\s*\{[^}]*padding:[^;}]*var\(--memoka-line-number-gutter-width\)[^;}]*\+\s*var\(--memoka-indent-guide-offset\)/su,
    );
    expect(css).toMatch(
      /\.tableWrapper\s*\{[^}]*margin:[^;}]*var\(--memoka-block-grid-offset\)/su,
    );
    expect(css).toMatch(
      /\.memoka-code-block\s*\{[^}]*margin:[^;}]*var\(--memoka-block-grid-offset\)/su,
    );
    expect(css).toMatch(
      /blockquote\[data-memoka-alert-type\]\s*\{[^}]*margin:[^;}]*var\(--memoka-block-grid-offset\)/su,
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
    expect(css).toMatch(/\.window-mode\s*\{[^}]*font-weight: 700;/su);
  });
});
