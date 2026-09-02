import {
  normalizeApplicationFontFamily,
  normalizeApplicationZoomPercent,
} from "../core/application-appearance";

export const APPLICATION_FONT_CSS_VARIABLE = "--memoka-font-family";

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
