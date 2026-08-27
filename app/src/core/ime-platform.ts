import { invoke } from "@tauri-apps/api/core";

export interface ImeDeactivationResult {
  supported: boolean;
  inactive: boolean;
  detail: string;
}

export async function requestImeOff(): Promise<ImeDeactivationResult> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return {
      supported: false,
      inactive: false,
      detail: "browser-only",
    };
  }

  try {
    const result = decodeImeDeactivationResult(
      await invoke<unknown>("deactivate_input_method"),
    );
    return (
      result ?? {
        supported: true,
        inactive: false,
        detail: "invalid-platform-response",
      }
    );
  } catch (error) {
    return {
      supported: true,
      inactive: false,
      detail: `error:${String(error)}`,
    };
  }
}

export function decodeImeDeactivationResult(
  value: unknown,
): ImeDeactivationResult | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("supported" in value) ||
    typeof value.supported !== "boolean" ||
    !("inactive" in value) ||
    typeof value.inactive !== "boolean" ||
    !("detail" in value) ||
    typeof value.detail !== "string"
  ) {
    return null;
  }
  return {
    supported: value.supported,
    inactive: value.inactive,
    detail: value.detail,
  };
}
