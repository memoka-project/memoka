import type { StableEditorPosition } from "../core/stable-position";
import type { VimMode } from "./input";

export type VimVisualMode = Extract<
  VimMode,
  "visual-char" | "visual-line" | "visual-block"
>;

export interface VimVisualSelectionSnapshot {
  readonly noteId: string;
  readonly mode: VimVisualMode;
  readonly anchor: StableEditorPosition;
  readonly head: StableEditorPosition;
}

function clonePosition(position: StableEditorPosition): StableEditorPosition {
  return { ...position, relative: position.relative.slice() };
}

function cloneSnapshot(
  snapshot: VimVisualSelectionSnapshot,
): VimVisualSelectionSnapshot {
  return {
    ...snapshot,
    anchor: clonePosition(snapshot.anchor),
    head: clonePosition(snapshot.head),
  };
}

/** Runtime-only Visual history for one application Window, partitioned by Note. */
export class VimVisualSelectionStore {
  private readonly byNote = new Map<string, VimVisualSelectionSnapshot>();

  read(noteId: string): VimVisualSelectionSnapshot | null {
    const snapshot = this.byNote.get(noteId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  write(snapshot: VimVisualSelectionSnapshot): void {
    if (
      snapshot.anchor.noteId !== snapshot.noteId ||
      snapshot.head.noteId !== snapshot.noteId
    ) {
      throw new Error(
        "Visual selection endpoints must belong to the same Note",
      );
    }
    this.byNote.set(snapshot.noteId, cloneSnapshot(snapshot));
  }

  clear(noteId?: string): void {
    if (noteId === undefined) this.byNote.clear();
    else this.byNote.delete(noteId);
  }
}
