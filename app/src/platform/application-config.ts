import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  mergeApplicationKeyConfig,
  type ApplicationKeyConfig,
  type PartialApplicationKeyConfig,
} from "../core/application-key-config";
import { validateVimKeyConfig } from "../vim/input";

interface ApplicationKeyConfigLoadWire {
  readonly configPath: string;
  readonly config: PartialApplicationKeyConfig | null;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export interface LoadedApplicationKeyConfig {
  readonly config: ApplicationKeyConfig;
  readonly configPath: string | null;
  readonly waitForMirrorOnExit: boolean;
  readonly warning: string | null;
}

export async function loadApplicationKeyConfig(): Promise<LoadedApplicationKeyConfig> {
  if (!isTauriRuntime()) {
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
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
    const warning = `config.toml: 設定の読込に失敗しました: ${errorMessage(cause)}; 既定キー設定を使用します`;
    console.warn(warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: null,
      waitForMirrorOnExit: true,
      warning,
    };
  }
  if (loaded.warning) {
    console.warn(loaded.warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      waitForMirrorOnExit: true,
      warning: loaded.warning,
    };
  }
  try {
    const config = loaded.config
      ? mergeApplicationKeyConfig(loaded.config)
      : DEFAULT_APPLICATION_KEY_CONFIG;
    validateVimKeyConfig(config);
    return {
      config,
      configPath: loaded.configPath,
      waitForMirrorOnExit: loaded.waitForMirrorOnExit,
      warning: null,
    };
  } catch (cause) {
    const warning = `${loaded.configPath}: ${errorMessage(cause)}; 既定キー設定を使用します`;
    console.warn(warning);
    return {
      config: DEFAULT_APPLICATION_KEY_CONFIG,
      configPath: loaded.configPath,
      waitForMirrorOnExit: true,
      warning,
    };
  }
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
