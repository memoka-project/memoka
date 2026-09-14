import { Extension } from "@tiptap/core";
import type { ReplicatedNote } from "../core/replicated-note";
import { ReplicatedNoteAdapter } from "./replicated-note-adapter";

/** The regular product extension set selects this binding for NoteDoc 7. */
export function replicatedNoteExtension(
  note: ReplicatedNote,
  sectionId: string,
) {
  return Extension.create<unknown, { adapter: ReplicatedNoteAdapter | null }>({
    name: "memokaReplication",
    addStorage() {
      return { adapter: null };
    },
    onBeforeCreate() {
      const adapter = new ReplicatedNoteAdapter(
        note,
        this.editor.schema,
        sectionId,
      );
      this.storage.adapter = adapter;
      this.editor.options.content = adapter.renderDocument().toJSON();
    },
    addProseMirrorPlugins() {
      return this.storage.adapter ? [this.storage.adapter.plugin] : [];
    },
    addCommands() {
      return {
        undo:
          () =>
          ({ dispatch, tr }) => {
            tr.setMeta("preventDispatch", true);
            return dispatch ? note.undo() : note.history.undoStack.length > 0;
          },
        redo:
          () =>
          ({ dispatch, tr }) => {
            tr.setMeta("preventDispatch", true);
            return dispatch ? note.redo() : note.history.redoStack.length > 0;
          },
      };
    },
    onDestroy() {
      this.storage.adapter?.destroy();
    },
  });
}
