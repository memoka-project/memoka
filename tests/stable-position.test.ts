import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  resolveStableEditorPosition,
  saveStableEditorPosition,
} from "../app/src/core/stable-position";

function textPosition(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.isText && node.text?.includes(text)) {
      result = position + (node.text?.indexOf(text) ?? 0);
    }
  });
  if (result < 0) throw new Error(`Text not found: ${text}`);
  return result;
}

describe("Memoka CRDT-stable editor position", () => {
  it("does not persist half of an emoji in its JSON caret context", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const text = "😀abcdefghijklmnop😀";
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: createUuidV7(),
      source: "internal",
      payload: { noteId: runtime.noteId, text },
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const start = textPosition(editor, text);
    expect(
      JSON.stringify(
        editor.state.doc.textBetween(start + 7, start + 19, "", "\uFFFC"),
      ),
    ).toContain("\\ud83d");

    for (let offset = 0; offset <= text.length; offset++) {
      const saved = saveStableEditorPosition(
        runtime.noteDocument,
        editor.view,
        start + offset,
      );
      expect(JSON.stringify(saved)).not.toMatch(
        /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u,
      );
    }

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("follows an insertion through a Yjs Relative Position", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: createUuidV7(),
      source: "internal",
      payload: { noteId: runtime.noteId, text: "alpha beta" },
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const cursor = textPosition(editor, "beta") + 2;
    const saved = saveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      cursor,
    );

    editor.commands.insertContentAt(textPosition(editor, "alpha"), "prefix ");
    const resolved = resolveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      saved,
    );

    expect(resolved.source).toBe("relative");
    expect(resolved.position).toBe(cursor + "prefix ".length);
    expect(
      editor.state.doc.textBetween(
        resolved.position - 2,
        resolved.position + 2,
        "",
      ),
    ).toBe("beta");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("falls back to block context when relative bytes are malformed", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: createUuidV7(),
      source: "internal",
      payload: { noteId: runtime.noteId, text: "fallback target" },
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const cursor = textPosition(editor, "target") + 3;
    const saved = saveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      cursor,
    );
    const resolved = resolveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      { ...saved, relative: new Uint8Array([255]) },
    );

    expect(resolved).toMatchObject({
      source: "block-fallback",
      blockId: saved.blockId,
      position: cursor,
    });

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps the nearest occurrence when fallback context repeats within a block", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const repeated = "abcdefghijklmnop";
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: createUuidV7(),
      source: "internal",
      payload: { noteId: runtime.noteId, text: repeated.repeat(4) },
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const cursor = textPosition(editor, repeated) + repeated.length * 3 + 5;
    const saved = saveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      cursor,
    );
    const resolved = resolveStableEditorPosition(
      runtime.noteDocument,
      editor.view,
      { ...saved, relative: new Uint8Array([255]) },
    );

    expect(resolved.source).toBe("block-fallback");
    expect(resolved.position).toBe(cursor);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("rejects resolving a position against another NoteDoc", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const saved = saveStableEditorPosition(runtime.noteDocument, editor.view);

    expect(() =>
      resolveStableEditorPosition(runtime.noteDocument, editor.view, {
        ...saved,
        noteId: createUuidV7(),
      }),
    ).toThrow(`Position belongs to`);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });
});
