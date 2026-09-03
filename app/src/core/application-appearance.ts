export const DEFAULT_APPLICATION_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const DEFAULT_APPLICATION_ZOOM_PERCENT = 100;
export const MIN_APPLICATION_ZOOM_PERCENT = 50;
export const MAX_APPLICATION_ZOOM_PERCENT = 200;
export const APPLICATION_ZOOM_STEP_PERCENT = 10;
export const DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX = 1000;
export const DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX = 0;
export const MIN_APPLICATION_NOTE_MAX_WIDTH_PX = 320;
export const MAX_APPLICATION_NOTE_MAX_WIDTH_PX = 4096;

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
