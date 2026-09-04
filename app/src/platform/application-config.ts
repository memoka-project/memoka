import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  mergeApplicationKeyConfig,
  type ApplicationKeyConfig,
  type PartialApplicationKeyConfig,
} from "../core/application-key-config";
import {
  DEFAULT_APPLICATION_THEME_ID,
  normalizeApplicationThemeId,
  type ApplicationThemeId,
} from "../core/application-theme";
import {
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  DEFAULT_APPLICATION_ZOOM_PERCENT,
  normalizeApplicationFontFamily,
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
  readonly config: PartialApplicationKeyConfig | null;
  readonly theme: string;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly noteMaxWidthPx: number;
  readonly japaneseWordSegmentation: string;
  readonly japaneseLineBreakSegmentation: string;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export interface LoadedApplicationConfig {
  readonly config: ApplicationKeyConfig;
  readonly configPath: string | null;
  readonly theme: ApplicationThemeId;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly noteMaxWidthPx: number;
  readonly japaneseWordSegmentation: JapaneseWordSegmentationMode;
  readonly japaneseLineBreakSegmentation: JapaneseLineBreakSegmentationMode;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export interface ApplicationConfigPort {
  readonly saveTheme: (theme: ApplicationThemeId) => Promise<void>;
  readonly saveFontFamily: (fontFamily: string) => Promise<void>;
  readonly saveZoomPercent: (zoomPercent: number) => Promise<void>;
  readonly saveNoteMaxWidthPx: (noteMaxWidthPx: number) => Promise<void>;
  readonly saveJapaneseWordSegmentation: (
    mode: JapaneseWordSegmentationMode,
  ) => Promise<void>;
  readonly saveJapaneseLineBreakSegmentation: (
    mode: JapaneseLineBreakSegmentationMode,
  ) => Promise<void>;
}

export function createDefaultApplicationConfigPort(): ApplicationConfigPort {
  return {
    saveTheme: async (theme) => {
      if (!isTauriRuntime()) return;
      await invoke("application_theme_save", { theme });
    },
    saveFontFamily: async (fontFamily) => {
      if (!isTauriRuntime()) return;
      await invoke("application_font_family_save", { fontFamily });
    },
    saveZoomPercent: async (zoomPercent) => {
      if (!isTauriRuntime()) return;
      await invoke("application_zoom_percent_save", { zoomPercent });
    },
    saveNoteMaxWidthPx: async (noteMaxWidthPx) => {
      if (!isTauriRuntime()) return;
      await invoke("application_note_max_width_px_save", { noteMaxWidthPx });
    },
    saveJapaneseWordSegmentation: async (mode) => {
      if (!isTauriRuntime()) return;
      await invoke("application_japanese_word_segmentation_save", { mode });
    },
    saveJapaneseLineBreakSegmentation: async (mode) => {
      if (!isTauriRuntime()) return;
      await invoke("application_japanese_line_break_segmentation_save", {
        mode,
      });
    },
  };
}

export async function loadApplicationConfig(): Promise<LoadedApplicationConfig> {
  if (!isTauriRuntime()) {
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      waitForMirrorOnExit: true,
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
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      waitForMirrorOnExit: true,
      warning,
    };
  }
  if (loaded.warning && !loaded.config) {
    console.warn(loaded.warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      waitForMirrorOnExit: true,
      warning: loaded.warning,
    };
  }
  if (loaded.warning) console.warn(loaded.warning);
  try {
    const config = loaded.config
      ? mergeApplicationKeyConfig(loaded.config)
      : DEFAULT_APPLICATION_KEY_CONFIG;
    validateVimKeyConfig(config);
    const theme = normalizeApplicationThemeId(loaded.theme);
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
      config,
      configPath: loaded.configPath,
      theme,
      fontFamily,
      zoomPercent,
      noteMaxWidthPx,
      japaneseWordSegmentation,
      japaneseLineBreakSegmentation,
      waitForMirrorOnExit: loaded.waitForMirrorOnExit,
      warning: loaded.warning,
    };
  } catch (cause) {
    const warning = `${loaded.configPath}: ${errorMessage(cause)}; 既定設定を使用します`;
    console.warn(warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      noteMaxWidthPx: DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
      japaneseWordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
      japaneseLineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
      waitForMirrorOnExit: true,
      warning,
    };
  }
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
