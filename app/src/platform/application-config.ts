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
  DEFAULT_APPLICATION_ZOOM_PERCENT,
  normalizeApplicationFontFamily,
  normalizeApplicationZoomPercent,
} from "../core/application-appearance";
import { validateVimKeyConfig } from "../vim/input";

interface ApplicationKeyConfigLoadWire {
  readonly configPath: string;
  readonly config: PartialApplicationKeyConfig | null;
  readonly theme: string;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export interface LoadedApplicationConfig {
  readonly config: ApplicationKeyConfig;
  readonly configPath: string | null;
  readonly theme: ApplicationThemeId;
  readonly fontFamily: string;
  readonly zoomPercent: number;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export interface ApplicationConfigPort {
  readonly saveTheme: (theme: ApplicationThemeId) => Promise<void>;
  readonly saveFontFamily: (fontFamily: string) => Promise<void>;
  readonly saveZoomPercent: (zoomPercent: number) => Promise<void>;
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
      waitForMirrorOnExit: true,
      warning,
    };
  }
  if (loaded.warning) {
    console.warn(loaded.warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      theme: DEFAULT_APPLICATION_THEME_ID,
      fontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
      zoomPercent: DEFAULT_APPLICATION_ZOOM_PERCENT,
      waitForMirrorOnExit: true,
      warning: loaded.warning,
    };
  }
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
    return {
      config,
      configPath: loaded.configPath,
      theme,
      fontFamily,
      zoomPercent,
      waitForMirrorOnExit: loaded.waitForMirrorOnExit,
      warning: null,
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
