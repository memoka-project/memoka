import { openUrl } from "@tauri-apps/plugin-opener";

export interface ExternalLinkPort {
  open(href: string): Promise<void>;
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function createDefaultExternalLinkPort(): ExternalLinkPort {
  if (isTauriRuntime()) {
    return { open: (href) => openUrl(href) };
  }
  return {
    open: async (href) => {
      const opened = window.open(href, "_blank", "noopener,noreferrer");
      if (!opened) throw new Error("browser-blocked");
      opened.opener = null;
    },
  };
}
