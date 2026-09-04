import type { Editor, JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import {
  internalSectionLinkAtPosition,
  resolveEditorNavigationDestination,
} from "../app/src/core/editor-navigation";
import { blockToYXml } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import type { StableEditorPosition } from "../app/src/core/stable-position";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter++;
    return createUuidV7(1_796_000_000_000 + seed, (target) => {
      target.fill((seed * 37) & 0xff);
      return target;
    });
  };
}

function editorRoot(): HTMLDivElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function noteContent(
  noteId: string,
  title: string,
  body: JSONContent[],
): JSONContent {
  return {
    type: "section",
    content: [
      {
        type: "sectionHeader",
        attrs: { sectionId: noteId, tags: "[]" },
        content: title ? [{ type: "text", text: title }] : undefined,
      },
      {
        type: "sectionBody",
        content:
          body.length > 0
            ? [
                {
                  type: "bodyChunk",
                  attrs: { chunkId: createUuidV7() },
                  content: body,
                },
              ]
            : [],
      },
      { type: "sectionChildren" },
    ],
  };
}

function paragraph(text: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId: createUuidV7() },
    content: [{ type: "text", text }],
  };
}

function sectionHeaderStart(editor: Editor, sectionId: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (
      result < 0 &&
      node.type.name === "sectionHeader" &&
      node.attrs.sectionId === sectionId
    ) {
      result = position + 1;
      return false;
    }
    return result < 0;
  });
  if (result < 0)
    throw new Error(`Section Header was not mounted: ${sectionId}`);
  return result;
}

function firstParagraphStart(editor: Editor): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.type.name === "paragraph") result = position + 1;
    return result < 0;
  });
  if (result < 0) throw new Error("Missing Paragraph");
  return result;
}

function blockTextStart(editor: Editor, blockId: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.attrs.blockId === blockId) {
      result = position + 1;
      return false;
    }
    return result < 0;
  });
  if (result < 0) throw new Error(`Block was not mounted: ${blockId}`);
  return result;
}

function stablePosition(noteId: string, offset: number): StableEditorPosition {
  return {
    noteId,
    sectionId: noteId,
    blockId: `block-${offset}`,
    offset,
    before: `before-${offset}`,
    after: `after-${offset}`,
    relative: new Uint8Array([offset + 1]),
  };
}

async function settle(runtime: CoreRuntime): Promise<void> {
  await runtime.flush();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await runtime.flush();
}

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
}

describe("Memoka Section Link and Jump List navigation", () => {
  it("falls back to the Section-local logical line when a legacy block ID is ambiguous", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "search fallback",
    });
    const duplicateBlockId = createUuidV7();
    const root = editorRoot();
    const view = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    // Construct a plugin-free legacy view state so the editor's identity
    // maintenance does not normalize this intentionally damaged fixture.
    const legacyDoc = view.editor.schema.nodeFromJSON(
      noteContent(runtime.noteId, "search fallback", [
        {
          type: "paragraph",
          attrs: { blockId: duplicateBlockId },
          content: [{ type: "text", text: "first duplicate" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: duplicateBlockId },
          content: [{ type: "text", text: "second needle" }],
        },
      ]),
    );
    const legacyState = EditorState.create({
      schema: view.editor.schema,
      doc: legacyDoc,
    });
    const paragraphStarts: number[] = [];
    legacyState.doc.descendants((node, position) => {
      if (node.type.name === "paragraph") paragraphStarts.push(position + 1);
    });
    const resolved = resolveEditorNavigationDestination(
      runtime.noteDocument,
      { state: legacyState },
      {
        kind: "search-match",
        noteId: runtime.noteId,
        sectionId: runtime.noteId,
        sectionLineNumber: 2,
        blockId: duplicateBlockId,
        offset: 7,
        query: "needle",
      },
    );
    expect(resolved).toEqual({
      position: paragraphStarts[1]! + 7,
      source: "search-text-fallback",
    });
    view.adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("moves zf and zF one Focus level at a time while retaining a deep caret", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const firstId = createUuidV7();
    const secondId = createUuidV7();
    const deepestId = createUuidV7();
    const blockId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(
          firstId,
          "first",
          [],
          [
            createSectionXml(
              secondId,
              "second",
              [],
              [
                createSectionXml(deepestId, "deepest", [
                  blockToYXml({
                    type: "paragraph",
                    blockId,
                    content: [{ type: "text", text: "keep caret here" }],
                  }),
                ]),
              ],
            ),
          ],
        ),
      );
    });
    const rootElement = editorRoot();
    const rootView = runtime.editorForTesting("window-1", rootElement, {
      directBodyOnly: false,
    });
    const rootBlockStart = blockTextStart(rootView.editor, blockId);
    rootView.editor.commands.setTextSelection(rootBlockStart + 7);
    press(rootView.editor, "Escape", { code: "Escape" });
    const offsetBefore = rootView.editor.state.selection.from - rootBlockStart;

    press(rootView.editor, "z", { code: "KeyZ" });
    press(rootView.editor, "f", { code: "KeyF" });
    await settle(runtime);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(firstId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);

    rootView.adapter.destroy();
    rootElement.remove();
    const firstElement = editorRoot();
    const firstView = runtime.editorForTesting("window-1", firstElement, {
      directBodyOnly: false,
    });
    expect(firstView.editor.state.selection.from).toBe(
      blockTextStart(firstView.editor, blockId) + offsetBefore,
    );
    press(firstView.editor, "z", { code: "KeyZ" });
    press(firstView.editor, "f", { code: "KeyF" });
    await settle(runtime);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(secondId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(2);

    firstView.adapter.destroy();
    firstElement.remove();
    const secondElement = editorRoot();
    const secondView = runtime.editorForTesting("window-1", secondElement, {
      directBodyOnly: false,
    });
    expect(secondView.editor.state.selection.from).toBe(
      blockTextStart(secondView.editor, blockId) + offsetBefore,
    );

    press(secondView.editor, "z", { code: "KeyZ" });
    press(secondView.editor, "f", { code: "KeyF" });
    await settle(runtime);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(deepestId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(3);

    secondView.adapter.destroy();
    secondElement.remove();
    const deepestElement = editorRoot();
    const deepestView = runtime.editorForTesting("window-1", deepestElement, {
      directBodyOnly: false,
    });
    expect(deepestView.editor.state.selection.from).toBe(
      blockTextStart(deepestView.editor, blockId) + offsetBefore,
    );

    press(deepestView.editor, "z", { code: "KeyZ" });
    press(deepestView.editor, "F", { code: "KeyF", shiftKey: true });
    await settle(runtime);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(secondId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(4);
    expect(
      runtime
        .jumpListFor("window-1")
        .snapshot()
        .back.map(({ sectionId }) => sectionId),
    ).toEqual([note.noteId, firstId, secondId, deepestId]);

    deepestView.adapter.destroy();
    deepestElement.remove();
    const parentElement = editorRoot();
    const parentView = runtime.editorForTesting("window-1", parentElement, {
      directBodyOnly: false,
    });
    expect(parentView.editor.state.selection.from).toBe(
      blockTextStart(parentView.editor, blockId) + offsetBefore,
    );
    expect(
      runtime.applyPendingNavigation("window-1", parentView.adapter),
    ).toBeNull();

    parentView.adapter.destroy();
    parentElement.remove();
    runtime.destroy();
  });

  it("records explicit note opens and returns to the previous stable position", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "source",
    });
    await addSecondWindow(runtime);
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-1", "target");
    await runtime.openNote("window-1", sourceNoteId);
    const root = editorRoot();
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    source.editor.commands.setContent(
      noteContent(sourceNoteId, "source", [
        paragraph("source cursor position"),
      ]),
    );
    await settle(runtime);
    source.editor.commands.setTextSelection(
      firstParagraphStart(source.editor) + 5,
    );
    const origin = source.adapter.captureStablePosition();
    if (!origin) throw new Error("Stable origin was unavailable");

    expect(
      await runtime.navigateNoteOpen("window-1", origin, sourceNoteId),
    ).toEqual({ handled: true, detail: "jump:note-open:unchanged" });
    expect(
      await runtime.navigateNoteOpen("window-1", origin, target.noteId),
    ).toEqual({ handled: true, detail: "jump:note-open:changed" });
    expect(runtime.windows.get("window-1")?.noteId).toBe(target.noteId);
    expect(runtime.windows.get("window-2")?.noteId).toBe(sourceNoteId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);

    source.adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("moves an Outline jump to the Section title without changing Focus or undo history", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const childId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(note.rootSection, createSectionXml(childId, "child"));
    });
    const root = editorRoot();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const origin = adapter.captureStablePosition();
    if (!origin) throw new Error("Stable origin was unavailable");
    const undoBefore = note.undoManager.undoStack.length;

    const result = await runtime.navigateOutline(
      "window-1",
      origin,
      note.noteId,
      childId,
    );
    expect(result).toMatchObject({
      handled: true,
      detail: "jump:outline:changed",
      destination: {
        kind: "section-start",
        noteId: note.noteId,
        sectionId: childId,
      },
    });
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBeNull();
    expect(
      runtime.snapshot().applicationWindow.windows["window-1"]?.bufferId,
    ).toBe(`note:${note.noteId}`);
    expect(note.undoManager.undoStack).toHaveLength(undoBefore);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);
    expect(
      adapter.applyNavigationDestination(result.destination!, result.detail),
    ).toBe("jump:outline:changed");
    expect(editor.state.selection.from).toBe(
      sectionHeaderStart(editor, childId),
    );
    expect(runtime.applyPendingNavigation("window-1", adapter)).toBeNull();

    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("returns to the full Note view before an Outline jump outside the focused subtree", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const firstId = createUuidV7();
    const secondId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(note.rootSection, createSectionXml(firstId, "first"));
      insertChildSection(
        note.rootSection,
        createSectionXml(secondId, "second"),
      );
    });
    await runtime.focusSection("window-1", note.noteId, firstId);
    const focusedRoot = editorRoot();
    const focused = runtime.editorForTesting("window-1", focusedRoot, {
      directBodyOnly: false,
    });
    const origin = focused.adapter.captureStablePosition();
    if (!origin) throw new Error("Stable origin was unavailable");

    const result = await runtime.navigateOutline(
      "window-1",
      origin,
      note.noteId,
      secondId,
    );
    expect(result).toEqual({
      handled: true,
      detail: "jump:outline:changed",
    });
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBeNull();

    focused.adapter.destroy();
    focusedRoot.remove();
    const fullRoot = editorRoot();
    const full = runtime.editorForTesting("window-1", fullRoot, {
      directBodyOnly: false,
    });
    expect(full.editor.state.selection.from).toBe(
      sectionHeaderStart(full.editor, secondId),
    );
    expect(runtime.applyPendingNavigation("window-1", full.adapter)).toBeNull();

    full.adapter.destroy();
    fullRoot.remove();
    runtime.destroy();
  });

  it("treats an Internal Section Link as one atomic target and follows gf", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "source",
    });
    await addSecondWindow(runtime);
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-1", "target");
    await runtime.openNote("window-1", sourceNoteId);
    const root = editorRoot();
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    source.editor.commands.setContent(
      noteContent(sourceNoteId, "source", [
        {
          type: "paragraph",
          attrs: { blockId: createUuidV7() },
          content: [
            { type: "text", text: "Follow " },
            {
              type: "internalSectionLink",
              attrs: { targetSectionId: target.noteId },
              content: [{ type: "text", text: "target" }],
            },
          ],
        },
      ]),
    );
    await settle(runtime);
    let linkPosition = -1;
    source.editor.state.doc.descendants((node, position) => {
      if (node.type.name === "internalSectionLink") linkPosition = position;
    });
    expect(linkPosition).toBeGreaterThan(0);
    expect(
      internalSectionLinkAtPosition(source.editor.state, linkPosition + 2),
    ).toEqual({ sectionId: target.noteId });
    source.editor.commands.setTextSelection(linkPosition + 2);
    source.editor.commands.focus();
    press(source.editor, "Escape");
    press(source.editor, "g");
    press(source.editor, "f");
    await settle(runtime);

    expect(runtime.windows.get("window-1")?.noteId).toBe(target.noteId);
    expect(runtime.windows.get("window-2")?.noteId).toBe(sourceNoteId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);
    source.adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("restores Jump List history when a cross-note open fails", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "source",
    });
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-1", "target");
    const jumps = runtime.jumpListFor("window-1");
    jumps.recordOrigin(stablePosition(sourceNoteId, 1));
    const before = jumps.snapshot();
    const open = vi
      .spyOn(runtime, "focusSection")
      .mockRejectedValueOnce(new Error("injected open failure"));

    const result = await runtime.navigateEditor("window-1", {
      kind: "back",
      current: stablePosition(target.noteId, 2),
    });
    expect(result).toEqual({
      handled: false,
      detail: "jump:open:error:injected open failure",
    });
    expect(jumps.snapshot()).toEqual(before);
    open.mockRestore();
    runtime.destroy();
  });
});
