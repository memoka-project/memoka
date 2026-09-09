import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  mergeApplicationKeyConfig,
  type ApplicationKeyConfig,
  type PartialApplicationKeyConfig,
} from "../core/application-key-config";
import {
  DEFAULT_APPLICATION_THEME_ID,
  APPLICATION_THEME_IDS,
  normalizeApplicationThemeId,
  resolveCustomApplicationThemes,
  type CustomApplicationThemes,
  type ApplicationThemeId,
} from "../core/application-theme";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_INDENT_WIDTH_PX,
  DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  DEFAULT_APPLICATION_ZOOM_PERCENT,
  normalizeApplicationFontFamily,
  normalizeApplicationIndentWidthPx,
  normalizeApplicationLineNumberMinWidthPx,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
} from "../core/application-appearance";
import { validateVimKeyConfig } from "../vim/input";
import {
  DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
  DEFAULT_JAPANESE_WORD_SEGMENTATION,
  normalizeJapaneseLineBreakSegmentationMode,
  normalizeJapaneseWordSegmentationMode,
  type JapaneseLineBreakSegmentationMode,
  type JapaneseWordSegmentationMode,
} from "../core/japanese-segmentation";

interface ApplicationKeyConfigLoadWire {
  readonly configPath: string;
  readonly revision?: string | null;
  readonly config: PartialApplicationKeyConfig | null;
  readonly theme: string;
  readonly customThemes?: CustomApplicationThemes;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly noteMaxWidthPx: number;
  readonly lineNumberMinWidthPx: number;
  readonly indentWidthPx: number;
  readonly japaneseWordSegmentation: string;
  readonly japaneseLineBreakSegmentation: string;
  readonly warning: string | null;
}

export interface LoadedApplicationConfig {
  readonly valid?: boolean;
  readonly revision?: string | null;
  readonly config: ApplicationKeyConfig;
  readonly configPath: string | null;
  readonly theme: ApplicationThemeId;
  readonly customThemes?: CustomApplicationThemes;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly noteMaxWidthPx: number;
  readonly lineNumberMinWidthPx: number;
  readonly indentWidthPx: number;
  readonly japaneseWordSegmentation: JapaneseWordSegmentationMode;
  readonly japaneseLineBreakSegmentation: JapaneseLineBreakSegmentationMode;
  readonly warning: string | null;
}

export interface ApplicationConfigPort {
  /** Live appearance updates only; never recreate editors or change keymaps mid-input. */
  readonly subscribe?: (
    listener: (config: LoadedApplicationConfig) => void,
  ) => () => void;
  readonly saveTheme: (theme: ApplicationThemeId) => Promise<void>;
  readonly saveFontFamily: (fontFamily: string) => Promise<void>;
  readonly saveZoomPercent: (zoomPercent: number) => Promise<void>;
  readonly saveNoteMaxWidthPx: (noteMaxWidthPx: number) => Promise<void>;
  readonly saveLineNumberMinWidthPx: (
    lineNumberMinWidthPx: number,
  ) => Promise<void>;
  readonly saveIndentWidthPx: (indentWidthPx: number) => Promise<void>;
  readonly saveJapaneseWordSegmentation: (
    mode: JapaneseWordSegmentationMode,
  ) => Promise<void>;
  readonly saveJapaneseLineBreakSegmentation: (
    mode: JapaneseLineBreakSegmentationMode,
  ) => Promise<void>;
}

export function createDefaultApplicationConfigPort(): ApplicationConfigPort {
  const writes = { pending: 0, generation: 0 };
  const save = async (command: string, args: Record<string, unknown>) => {
    writes.pending += 1;
    writes.generation += 1;
    try {
      await invoke(command, args);
    } finally {
      writes.pending -= 1;
    }
  };
  return {
    subscribe: (listener) => subscribeApplicationConfig(listener, writes),
    saveTheme: async (theme) => {
      if (!isTauriRuntime()) return;
      await save("application_theme_save", { theme });
    },
    saveFontFamily: async (fontFamily) => {
      if (!isTauriRuntime()) return;
      await save("application_font_family_save", { fontFamily });
    },
    saveZoomPercent: async (zoomPercent) => {
      if (!isTauriRuntime()) return;
      await save("application_zoom_percent_save", { zoomPercent });
    },
    saveNoteMaxWidthPx: async (noteMaxWidthPx) => {
      if (!isTauriRuntime()) return;
      await save("application_note_max_width_px_save", { noteMaxWidthPx });
    },
    saveLineNumberMinWidthPx: async (lineNumberMinWidthPx) => {
      if (!isTauriRuntime()) return;
      await save("application_line_number_min_width_px_save", {
        lineNumberMinWidthPx,
      });
    },
    saveIndentWidthPx: async (indentWidthPx) => {
      if (!isTauriRuntime()) return;
      await save("application_indent_width_px_save", { indentWidthPx });
    },
    saveJapaneseWordSegmentation: async (mode) => {
      if (!isTauriRuntime()) return;
      await save("application_japanese_word_segmentation_save", { mode });
    },
    saveJapaneseLineBreakSegmentation: async (mode) => {
      if (!isTauriRuntime()) return;
      await save("application_japanese_line_break_segmentation_save", {
        mode,
      });
    },
  };
}

export async function loadApplicationConfig(): Promise<LoadedApplicationConfig> {
  if (!isTauriRuntime()) {
    return {
      valid: true,
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      lineNumberMinWidthPx: DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
      indentWidthPx: DEFAULT_APPLICATION_INDENT_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      warning: null,
    };
  }
  let loaded: ApplicationKeyConfigLoadWire;
  try {
    loaded = await invoke<ApplicationKeyConfigLoadWire>(
      "application_key_config_load",
    );
  } catch (cause) {
    const warning = `config.toml: 設定の読込に失敗しました: ${errorMessage(cause)}; 既定設定を使用します`;
    console.warn(warning);
    return {
      valid: false,
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      lineNumberMinWidthPx: DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
      indentWidthPx: DEFAULT_APPLICATION_INDENT_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      warning,
    };
  }
  if (loaded.warning && !loaded.config) {
    console.warn(loaded.warning);
    return {
      valid: false,
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      lineNumberMinWidthPx: DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
      indentWidthPx: DEFAULT_APPLICATION_INDENT_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      warning: loaded.warning,
    };
  }
  if (loaded.warning) console.warn(loaded.warning);
  try {
    const config = loaded.config
      ? mergeApplicationKeyConfig(loaded.config)
      : DEFAULT_APPLICATION_KEY_CONFIG;
    validateVimKeyConfig(config);
    const customThemes = loaded.customThemes ?? {};
    const custom = resolveCustomApplicationThemes(customThemes);
    const theme = custom.some((theme) => theme.id === loaded.theme)
      ? loaded.theme
      : APPLICATION_THEME_IDS.includes(
            loaded.theme as (typeof APPLICATION_THEME_IDS)[number],
          )
        ? normalizeApplicationThemeId(loaded.theme)
        : null;
    if (!theme) throw new Error(`未対応のカラーテーマです: ${loaded.theme}`);
    const fontFamily = normalizeApplicationFontFamily(loaded.fontFamily);
    if (!fontFamily) {
      throw new Error(`不正なfont-familyです: ${loaded.fontFamily}`);
    }
    const zoomPercent = normalizeApplicationZoomPercent(loaded.zoomPercent);
    if (zoomPercent === null) {
      throw new Error(`不正なZoom倍率です: ${loaded.zoomPercent}%`);
    }
    const noteMaxWidthPx = normalizeApplicationNoteMaxWidthPx(
      loaded.noteMaxWidthPx,
    );
    if (noteMaxWidthPx === null) {
      throw new Error(`不正なノート最大幅です: ${loaded.noteMaxWidthPx}px`);
    }
    const lineNumberMinWidthPx = normalizeApplicationLineNumberMinWidthPx(
      loaded.lineNumberMinWidthPx,
    );
    if (lineNumberMinWidthPx === null) {
      throw new Error(
        `不正な行番号表示の最小幅です: ${loaded.lineNumberMinWidthPx}px`,
      );
    }
    const indentWidthPx = normalizeApplicationIndentWidthPx(
      loaded.indentWidthPx,
    );
    if (indentWidthPx === null) {
      throw new Error(`不正なインデント幅です: ${loaded.indentWidthPx}px`);
    }
    const japaneseWordSegmentation = normalizeJapaneseWordSegmentationMode(
      loaded.japaneseWordSegmentation,
    );
    if (!japaneseWordSegmentation) {
      throw new Error(
        `不正な日本語word分割です: ${loaded.japaneseWordSegmentation}`,
      );
    }
    const japaneseLineBreakSegmentation =
      normalizeJapaneseLineBreakSegmentationMode(
        loaded.japaneseLineBreakSegmentation,
      );
    if (!japaneseLineBreakSegmentation) {
      throw new Error(
        `不正な日本語表示分割です: ${loaded.japaneseLineBreakSegmentation}`,
      );
    }
    return {
      valid: true,
      config,
      configPath: loaded.configPath,
      theme,
      revision: loaded.revision,
      customThemes,
      fontFamily,
      zoomPercent,
      noteMaxWidthPx,
      lineNumberMinWidthPx,
      indentWidthPx,
      japaneseWordSegmentation,
      japaneseLineBreakSegmentation,
      warning: loaded.warning,
    };
  } catch (cause) {
    const warning = `${loaded.configPath}: ${errorMessage(cause)}; 既定設定を使用します`;
    console.warn(warning);
    return {
      valid: false,
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      lineNumberMinWidthPx: DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
      indentWidthPx: DEFAULT_APPLICATION_INDENT_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      warning,
    };
  }
}

/** Hash the small config once a second; parse and update React only on change. */
function subscribeApplicationConfig(
  listener: (config: LoadedApplicationConfig) => void,
  writes: { pending: number; generation: number },
): () => void {
  if (!isTauriRuntime()) return () => {};
  let stopped = false;
  let running = false;
  let revision: string | undefined;
  let lastError: string | undefined;
  const poll = async () => {
    if (running || stopped || writes.pending > 0) return;
    const generation = writes.generation;
    running = true;
    try {
      const current = await invoke<string>("application_config_revision");
      if (stopped || current === revision) return;
      const loaded = await loadApplicationConfig();
      if (stopped || writes.pending > 0 || writes.generation !== generation)
        return;
      // On invalid TOML retain the live settings rather than apply startup defaults.
      revision = loaded.revision ?? current;
      listener(loaded);
      lastError = undefined;
    } catch (cause) {
      const message = errorMessage(cause);
      if (!stopped && lastError !== message) {
        lastError = message;
        window.dispatchEvent(
          new CustomEvent("memoka-editor-error", {
            detail: { message: `設定の再読込に失敗しました: ${message}` },
          }),
        );
      }
    } finally {
      running = false;
    }
  };
  const onFocus = () => void poll();
  const timer = window.setInterval(onFocus, 1000);
  window.addEventListener("focus", onFocus);
  void poll();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
  };
}

/** @deprecated Prefer loadApplicationConfig when consuming application settings. */
export const loadApplicationKeyConfig = loadApplicationConfig;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
