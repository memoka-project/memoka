import { invoke } from "@tauri-apps/api/core";

export interface ImeDeactivationResult {
  supported: boolean;
  inactive: boolean;
  detail: string;
}

let normalModeGuardGeneration = Date.now() * 1_000;
let normalModeGuardHandleId = 0;
let normalModeGuardInitialized = false;
let publishedNormalModeGuardActive = false;
const activeNormalModeGuardHandles = new Set<number>();

export interface NormalModeImeGuardHandle {
  setActive(active: boolean): void;
  destroy(): void;
}

/**
 * Tell the native WebView host whether the focused editing surface is in
 * Normal mode. Linux uses this to turn Fcitx off before WebKit consumes the
 * first command key. The generation makes rapid Window focus changes
 * last-write-wins even when their IPC calls finish out of order.
 */
function publishNormalModeImeGuard(active: boolean, force = false): void {
  if (!force && publishedNormalModeGuardActive === active) return;
  publishedNormalModeGuardActive = active;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return;
  }
  normalModeGuardGeneration = Math.max(
    normalModeGuardGeneration + 1,
    Date.now() * 1_000,
  );
  void invoke("set_normal_mode_ime_guard", {
    active,
    generation: normalModeGuardGeneration,
  }).catch(() => {
    // This guard is an enhancement around the existing explicit IME-off
    // request. Unsupported platforms must not break ordinary editor input.
  });
}

/**
 * Create one editor-owned guard handle. The native state is the union of all
 * handles so mounting or rebuilding an inactive split Window cannot disable
 * the guard belonging to the focused Window.
 */
export function createNormalModeImeGuard(): NormalModeImeGuardHandle {
  normalModeGuardHandleId += 1;
  const id = normalModeGuardHandleId;
  let active = false;
  let destroyed = false;
  if (!normalModeGuardInitialized) {
    normalModeGuardInitialized = true;
    publishNormalModeImeGuard(false, true);
  }
  return {
    setActive(nextActive) {
      if (destroyed || active === nextActive) return;
      active = nextActive;
      if (active) activeNormalModeGuardHandles.add(id);
      else activeNormalModeGuardHandles.delete(id);
      publishNormalModeImeGuard(activeNormalModeGuardHandles.size > 0);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      activeNormalModeGuardHandles.delete(id);
      publishNormalModeImeGuard(activeNormalModeGuardHandles.size > 0);
    },
  };
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
