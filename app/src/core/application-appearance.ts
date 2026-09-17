export const DEFAULT_APPLICATION_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_NOTE_LATIN_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_NOTE_JAPANESE_FONT_FAMILY =
  '"Noto Sans CJK JP", "Yu Gothic", "Hiragino Sans", sans-serif';
export const DEFAULT_NOTE_MONOSPACE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const DEFAULT_NOTE_LINE_HEIGHT = 1.5;
export const DEFAULT_NOTE_BLOCK_GAP_EM = 0.8;
export const DEFAULT_NOTE_LIST_ITEM_GAP_EM = 0.1;
export const DEFAULT_NOTE_SECTION_TITLE_GAP_BEFORE_EM = 1;
export const DEFAULT_NOTE_SECTION_TITLE_GAP_AFTER_EM = 0.4;
export const DEFAULT_NOTE_SECTION_TITLE_SIZE_EM = 1.26;
export const MIN_NOTE_LINE_HEIGHT = 1;
export const MAX_NOTE_LINE_HEIGHT = 2.5;
export const MIN_NOTE_GAP_EM = 0;
export const MAX_NOTE_GAP_EM = 3;
export const MIN_NOTE_SECTION_TITLE_SIZE_EM = 0.8;
export const MAX_NOTE_SECTION_TITLE_SIZE_EM = 3;

export interface NoteAppearanceSettings {
  readonly japaneseFontFamily: string;
  readonly latinFontFamily: string;
  readonly monospaceFontFamily: string;
  readonly lineHeight: number;
  readonly blockGapEm: number;
  readonly listItemGapEm: number;
  readonly sectionTitleGapBeforeEm: number;
  readonly sectionTitleGapAfterEm: number;
  readonly sectionTitleSizeEm: number;
}

export const DEFAULT_NOTE_APPEARANCE: NoteAppearanceSettings = {
  japaneseFontFamily: DEFAULT_NOTE_JAPANESE_FONT_FAMILY,
  latinFontFamily: DEFAULT_NOTE_LATIN_FONT_FAMILY,
  monospaceFontFamily: DEFAULT_NOTE_MONOSPACE_FONT_FAMILY,
  lineHeight: DEFAULT_NOTE_LINE_HEIGHT,
  blockGapEm: DEFAULT_NOTE_BLOCK_GAP_EM,
  listItemGapEm: DEFAULT_NOTE_LIST_ITEM_GAP_EM,
  sectionTitleGapBeforeEm: DEFAULT_NOTE_SECTION_TITLE_GAP_BEFORE_EM,
  sectionTitleGapAfterEm: DEFAULT_NOTE_SECTION_TITLE_GAP_AFTER_EM,
  sectionTitleSizeEm: DEFAULT_NOTE_SECTION_TITLE_SIZE_EM,
};

export const DEFAULT_APPLICATION_ZOOM_PERCENT = 100;
export const MIN_APPLICATION_ZOOM_PERCENT = 50;
export const MAX_APPLICATION_ZOOM_PERCENT = 200;
export const APPLICATION_ZOOM_STEP_PERCENT = 10;
export const DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX = 1000;
export const DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX = 0;
export const MIN_APPLICATION_NOTE_MAX_WIDTH_PX = 320;
export const MAX_APPLICATION_NOTE_MAX_WIDTH_PX = 4096;
export const DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX = 480;
export const DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX = 0;
export const MIN_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX = 240;
export const MAX_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX = 4096;
export const DEFAULT_APPLICATION_INDENT_WIDTH_PX = 24;
export const MIN_APPLICATION_INDENT_WIDTH_PX = 16;
export const MAX_APPLICATION_INDENT_WIDTH_PX = 64;

export interface ApplicationFontDefinition {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly description: string;
}

export const APPLICATION_FONT_PRESETS: readonly ApplicationFontDefinition[] = [
  {
    id: "default",
    name: "Memoka Default",
    family: DEFAULT_APPLICATION_FONT_FAMILY,
    description: "Memoka標準のUI向けSans Serif stack",
  },
  {
    id: "system-sans",
    name: "System Sans",
    family: "system-ui, sans-serif",
    description: "OS標準のSans Serif",
  },
  {
    id: "system-serif",
    name: "System Serif",
    family: 'ui-serif, Georgia, "Times New Roman", serif',
    description: "OS標準のSerif",
  },
  {
    id: "system-monospace",
    name: "System Monospace",
    family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    description: "OS標準の等幅フォント",
  },
];

export function normalizeApplicationFontFamily(value: string): string | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        character === ";" ||
        character === "{" ||
        character === "}"
      );
    })
  ) {
    return null;
  }
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("font-family", normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeDecimalInRange(
  value: number,
  minimum: number,
  maximum: number,
): number | null {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return null;
  }
  const rounded = Math.round(value * 100) / 100;
  return Math.abs(value - rounded) < Number.EPSILON * 100 ? rounded : null;
}

export function normalizeNoteLineHeight(value: number): number | null {
  return normalizeDecimalInRange(
    value,
    MIN_NOTE_LINE_HEIGHT,
    MAX_NOTE_LINE_HEIGHT,
  );
}

export function normalizeNoteGapEm(value: number): number | null {
  return normalizeDecimalInRange(value, MIN_NOTE_GAP_EM, MAX_NOTE_GAP_EM);
}

export function normalizeNoteSectionTitleSizeEm(value: number): number | null {
  return normalizeDecimalInRange(
    value,
    MIN_NOTE_SECTION_TITLE_SIZE_EM,
    MAX_NOTE_SECTION_TITLE_SIZE_EM,
  );
}

export function normalizeNoteAppearance(
  value: NoteAppearanceSettings,
): NoteAppearanceSettings | null {
  const japaneseFontFamily = normalizeApplicationFontFamily(
    value.japaneseFontFamily,
  );
  const latinFontFamily = normalizeApplicationFontFamily(value.latinFontFamily);
  const monospaceFontFamily = normalizeApplicationFontFamily(
    value.monospaceFontFamily,
  );
  const lineHeight = normalizeNoteLineHeight(value.lineHeight);
  const blockGapEm = normalizeNoteGapEm(value.blockGapEm);
  const listItemGapEm = normalizeNoteGapEm(value.listItemGapEm);
  const sectionTitleGapBeforeEm = normalizeNoteGapEm(
    value.sectionTitleGapBeforeEm,
  );
  const sectionTitleGapAfterEm = normalizeNoteGapEm(
    value.sectionTitleGapAfterEm,
  );
  const sectionTitleSizeEm = normalizeNoteSectionTitleSizeEm(
    value.sectionTitleSizeEm,
  );
  if (
    !japaneseFontFamily ||
    !latinFontFamily ||
    !monospaceFontFamily ||
    lineHeight === null ||
    blockGapEm === null ||
    listItemGapEm === null ||
    sectionTitleGapBeforeEm === null ||
    sectionTitleGapAfterEm === null ||
    sectionTitleSizeEm === null
  ) {
    return null;
  }
  return {
    japaneseFontFamily,
    latinFontFamily,
    monospaceFontFamily,
    lineHeight,
    blockGapEm,
    listItemGapEm,
    sectionTitleGapBeforeEm,
    sectionTitleGapAfterEm,
    sectionTitleSizeEm,
  };
}

export function normalizeApplicationZoomPercent(value: number): number | null {
  return Number.isSafeInteger(value) &&
    value >= MIN_APPLICATION_ZOOM_PERCENT &&
    value <= MAX_APPLICATION_ZOOM_PERCENT &&
    value % APPLICATION_ZOOM_STEP_PERCENT === 0
    ? value
    : null;
}

export function normalizeApplicationNoteMaxWidthPx(
  value: number,
): number | null {
  return Number.isSafeInteger(value) &&
    (value === DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX ||
      (value >= MIN_APPLICATION_NOTE_MAX_WIDTH_PX &&
        value <= MAX_APPLICATION_NOTE_MAX_WIDTH_PX))
    ? value
    : null;
}

export function normalizeApplicationLineNumberMinWidthPx(
  value: number,
): number | null {
  return Number.isSafeInteger(value) &&
    (value === DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX ||
      (value >= MIN_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX &&
        value <= MAX_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX))
    ? value
    : null;
}

export function normalizeApplicationIndentWidthPx(
  value: number,
): number | null {
  return Number.isSafeInteger(value) &&
    value >= MIN_APPLICATION_INDENT_WIDTH_PX &&
    value <= MAX_APPLICATION_INDENT_WIDTH_PX
    ? value
    : null;
}

export function shouldHideApplicationLineNumbers(
  windowWidthPx: number,
  minimumWidthPx: number,
): boolean {
  return (
    Number.isFinite(windowWidthPx) &&
    windowWidthPx > 0 &&
    minimumWidthPx !== DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX &&
    windowWidthPx < minimumWidthPx
  );
}

export function clampApplicationZoomPercent(value: number): number {
  const clamped = Math.max(
    MIN_APPLICATION_ZOOM_PERCENT,
    Math.min(MAX_APPLICATION_ZOOM_PERCENT, value),
  );
  return (
    Math.round(clamped / APPLICATION_ZOOM_STEP_PERCENT) *
    APPLICATION_ZOOM_STEP_PERCENT
  );
}

export function filterApplicationFontPresets(
  query: string,
): readonly ApplicationFontDefinition[] {
  const terms = normalizeSearch(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return APPLICATION_FONT_PRESETS;
  return APPLICATION_FONT_PRESETS.filter((font) => {
    const searchable = normalizeSearch(
      `${font.id} ${font.name} ${font.family} ${font.description}`,
    );
    return terms.every((term) => searchable.includes(term));
  });
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}
