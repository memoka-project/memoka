import {
  normalizeApplicationIndentWidthPx,
  DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationFontFamily,
  normalizeApplicationZoomPercent,
  normalizeNoteAppearance,
  type NoteAppearanceSettings,
} from "../core/application-appearance";

export const APPLICATION_FONT_CSS_VARIABLE = "--memoka-font-family";
export const APPLICATION_NOTE_MAX_WIDTH_CSS_VARIABLE =
  "--memoka-note-max-width";
export const APPLICATION_INDENT_WIDTH_CSS_VARIABLE = "--memoka-indent-width";
export const APPLICATION_INDENT_GUIDE_OFFSET_CSS_VARIABLE =
  "--memoka-indent-guide-offset";
export const APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE =
  "--memoka-list-inline-shift";
export const APPLICATION_INDENT_GUIDE_RATIO = 0.6;
export const NOTE_FONT_CSS_VARIABLE = "--memoka-note-font-family";
export const NOTE_MONOSPACE_FONT_CSS_VARIABLE = "--memoka-note-font-monospace";

export interface ApplicationZoomPort {
  readonly setZoomPercent: (zoomPercent: number) => Promise<void>;
}

export function applyApplicationFont(
  target: HTMLElement,
  fontFamily: string,
): void {
  const normalized = normalizeApplicationFontFamily(fontFamily);
  if (!normalized) throw new Error(`不正なfont-familyです: ${fontFamily}`);
  target.style.setProperty(APPLICATION_FONT_CSS_VARIABLE, normalized);
  target.style.fontFamily = normalized;
}

export function applyNoteAppearance(
  target: HTMLElement,
  appearance: NoteAppearanceSettings,
): void {
  const normalized = normalizeNoteAppearance(appearance);
  if (!normalized) throw new Error("不正なNote表示設定です");
  target.style.setProperty(
    NOTE_FONT_CSS_VARIABLE,
    `${normalized.latinFontFamily}, ${normalized.japaneseFontFamily}`,
  );
  target.style.setProperty(
    NOTE_MONOSPACE_FONT_CSS_VARIABLE,
    normalized.monospaceFontFamily,
  );
  target.style.setProperty(
    "--memoka-note-line-height",
    `${normalized.lineHeight}`,
  );
  target.style.setProperty(
    "--memoka-note-block-gap",
    `${normalized.blockGapEm}em`,
  );
  target.style.setProperty(
    "--memoka-list-item-gap",
    `${normalized.listItemGapEm}em`,
  );
  target.style.setProperty(
    "--memoka-section-title-gap-before",
    `${normalized.sectionTitleGapBeforeEm}em`,
  );
  target.style.setProperty(
    "--memoka-section-title-gap-after",
    `${normalized.sectionTitleGapAfterEm}em`,
  );
  target.style.setProperty(
    "--memoka-section-title-size",
    `${normalized.sectionTitleSizeEm}em`,
  );
  target.style.setProperty(
    "--memoka-table-cell-padding-block",
    `${Math.round(((8 * normalized.lineHeight) / 1.65) * 1000) / 1000}px`,
  );
}

export function applyApplicationNoteMaxWidth(
  target: HTMLElement,
  noteMaxWidthPx: number,
): void {
  const normalized = normalizeApplicationNoteMaxWidthPx(noteMaxWidthPx);
  if (normalized === null) {
    throw new Error(`不正なノート最大幅です: ${noteMaxWidthPx}px`);
  }
  target.style.setProperty(
    APPLICATION_NOTE_MAX_WIDTH_CSS_VARIABLE,
    normalized === DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX
      ? "none"
      : `${normalized}px`,
  );
}

export function applyApplicationIndentWidth(
  target: HTMLElement,
  indentWidthPx: number,
): void {
  const normalized = normalizeApplicationIndentWidthPx(indentWidthPx);
  if (normalized === null) {
    throw new Error(`不正なインデント幅です: ${indentWidthPx}px`);
  }
  target.style.setProperty(
    APPLICATION_INDENT_WIDTH_CSS_VARIABLE,
    `${normalized}px`,
  );
  target.style.setProperty(
    APPLICATION_INDENT_GUIDE_OFFSET_CSS_VARIABLE,
    `${Math.round(normalized * APPLICATION_INDENT_GUIDE_RATIO * 1000) / 1000}px`,
  );
  target.style.setProperty(
    APPLICATION_LIST_INLINE_SHIFT_CSS_VARIABLE,
    `${normalized / 64}em`,
  );
}

export function refreshApplicationLayout(): void {
  const refresh = (): void => {
    window.dispatchEvent(new Event("resize"));
  };
  window.requestAnimationFrame(refresh);
  void document.fonts?.ready.then(refresh).catch(() => undefined);
}

export function createDefaultApplicationZoomPort(): ApplicationZoomPort {
  return {
    setZoomPercent: async (zoomPercent) => {
      const normalized = normalizeApplicationZoomPercent(zoomPercent);
      if (normalized === null) {
        throw new Error(`不正なZoom倍率です: ${zoomPercent}%`);
      }
      if (!isTauriRuntime()) return;
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(normalized / 100);
    },
  };
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}
