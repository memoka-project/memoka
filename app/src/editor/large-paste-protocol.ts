export const LARGE_PASTE_MIN_CODE_UNITS = 128 * 1024;
export const LARGE_PASTE_MIN_LOGICAL_LINES = 2_048;

export interface LargePasteWorkerRequest {
  readonly id: number;
  readonly text: string;
}

export type LargePasteWorkerResponse =
  | {
      readonly id: number;
      readonly kind: "progress";
      readonly processed: number;
      readonly total: number;
    }
  | {
      readonly id: number;
      readonly kind: "complete";
      readonly blocks: readonly string[];
    }
  | {
      readonly id: number;
      readonly kind: "error";
      readonly message: string;
    };

/** Matches ProseMirror's ordinary plain-text Clipboard paragraph split. */
export function splitPlainTextPasteBlocks(text: string): string[] {
  return text.split(/(?:\r\n?|\n)+/u);
}

export function isLargePlainTextPaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_MIN_CODE_UNITS) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    lines += 1;
    if (lines >= LARGE_PASTE_MIN_LOGICAL_LINES) return true;
  }
  return false;
}
