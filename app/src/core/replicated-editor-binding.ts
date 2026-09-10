import { PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import type * as Y from "yjs";
import type { ReplicatedNote } from "./replicated-note";
import type { EditorHistory } from "./editor-history";

export const REPLICATED_PROJECTION = "memoka:replicated-render";

/** Appended maintenance transactions belong to the same received projection. */
export function isReplicatedProjection(transaction: Transaction): boolean {
  const root = transaction.getMeta("appendedTransaction") as
    Transaction | undefined;
  return Boolean(
    transaction.getMeta(REPLICATED_PROJECTION) ||
    root?.getMeta(REPLICATED_PROJECTION),
  );
}

export interface ReplicatedCursor {
  readonly entityId: string;
  readonly relative: Y.RelativePosition;
}

/** Navigation and Vim depend on this surface, independent of the mounted Editor. */
export const replicatedNotePluginKey = new PluginKey<{
  readonly adapter: {
    readonly note: ReplicatedNote;
    readonly sectionId: string;
    setSectionId(id: string): boolean;
    cursor(position: number): ReplicatedCursor | null;
    resolveCursor(cursor: ReplicatedCursor | null, doc: Node): number | null;
  };
  readonly undoManager: EditorHistory;
}>("memokaReplicatedNote");
