import type * as Y from "yjs";

/** The history surface shared by Vim and both persisted Note formats. */
export interface EditorHistory {
  readonly doc: Y.Doc;
  readonly undoStack: readonly EditorHistoryItem[];
  readonly redoStack: readonly EditorHistoryItem[];
  captureTimeout: number;
  lastChange: number;
  stopCapturing(): void;
  clear(): void;
  destroy(): void;
}

export interface EditorHistoryItem {
  readonly meta: Map<unknown, unknown>;
}
