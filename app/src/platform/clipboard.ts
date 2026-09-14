import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Copy plain text through the native bridge when available, otherwise the
 * Web Clipboard API. Returns false when neither backend accepts the write.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke("clipboard_write_text", { text });
      return true;
    } catch {
      // A platform without a text bridge can still try the Web API below.
    }
  }
  if (typeof navigator.clipboard?.writeText !== "function") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
