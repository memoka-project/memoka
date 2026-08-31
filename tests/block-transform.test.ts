import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { sectionBodyBlocks } from "../app/src/core/section-model";
import type { TiptapEditorAdapter } from "../app/src/editor/tiptap-adapter";
import { addSecondWindow } from "./helpers/runtime";

function nodeByBlockId(editor: Editor, blockId: string): ProseMirrorNode {
  let result: ProseMirrorNode | null = null;
  editor.state.doc.descendants((node) => {
    if (node.attrs.blockId === blockId) {
      result = node;
      return false;
    }
    return result === null;
  });
  if (!result) throw new Error(`Block not found: ${blockId}`);
  return result;
}

function directBodyContent(blocks: JSONContent[]): JSONContent {
  return {
    type: "section",
    content: [
      {
        type: "sectionHeader",
        attrs: { sectionId: createUuidV7(), tags: "[]" },
      },
      {
        type: "sectionBody",
        content: [
          {
            type: "bodyChunk",
            attrs: { chunkId: createUuidV7() },
            content: blocks,
          },
        ],
      },
      { type: "sectionChildren" },
    ],
  };
}

async function editorHarness(
  options: {
    onBlockTypePicker?: (request: { blockId: string }) => void;
  } = {},
) {
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root, {
    directBodyOnly: false,
    onBlockTypePicker: options.onBlockTypePicker,
  });
  binding.editor.commands.focus();
  return {
    ...binding,
    runtime,
    destroy: () => {
      binding.adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  };
}

function transform(
  adapter: TiptapEditorAdapter,
  blockId: string,
  target: Parameters<TiptapEditorAdapter["transformBlock"]>[1],
  consumeSlash = false,
  tableDimensions?: Parameters<TiptapEditorAdapter["transformBlock"]>[3],
) {
  return adapter.transformBlock(blockId, target, consumeSlash, tableDimensions);
}

function press(editor: Editor, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

describe("Memoka block.transform", () => {
  it("preserves text, hard breaks, and the direct block identity across text types", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [
            { type: "text", text: "first" },
            { type: "hardBreak" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    );

    expect(transform(adapter, blockId, "codeBlock")).toMatchObject({
      changed: true,
      target: "codeBlock",
    });
    expect(nodeByBlockId(editor, blockId).type.name).toBe("codeBlock");
    expect(nodeByBlockId(editor, blockId).textContent).toBe("first\nsecond");
    expect(transform(adapter, blockId, "sourceBlock")).toMatchObject({
      changed: true,
    });
    expect(nodeByBlockId(editor, blockId).attrs.sourceFormat).toBe("markdown");
    expect(transform(adapter, blockId, "paragraph")).toMatchObject({
      changed: true,
    });
    expect(nodeByBlockId(editor, blockId).textContent).toBe("firstsecond");
    expect(
      nodeByBlockId(editor, blockId).content.content.some(
        (node) => node.type.name === "hardBreak",
      ),
    ).toBe(true);
    destroy();
  });

  it("rejects lossy Paragraph conversion when marks or Internal Links exist", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "marked" },
          ],
        },
      ]),
    );
    expect(transform(adapter, blockId, "codeBlock")).toEqual({
      changed: false,
      reason: "unsafe-inline-content",
    });
    expect(nodeByBlockId(editor, blockId).type.name).toBe("paragraph");
    destroy();
  });

  it("wraps text as one ListItem and swaps list kinds without changing nesting", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text: "item" }],
        },
      ]),
    );
    expect(transform(adapter, blockId, "bulletList")).toMatchObject({
      changed: true,
    });
    const bullet = nodeByBlockId(editor, blockId);
    expect(bullet.type.name).toBe("bulletList");
    expect(bullet.firstChild?.type.name).toBe("listItem");
    expect(bullet.firstChild?.attrs.blockId).toMatch(/-7/u);
    expect(bullet.textContent).toBe("item");

    expect(transform(adapter, blockId, "orderedList")).toMatchObject({
      changed: true,
    });
    const ordered = nodeByBlockId(editor, blockId);
    expect(ordered.type.name).toBe("orderedList");
    expect(ordered.attrs.start).toBe(1);
    expect(ordered.firstChild?.attrs.blockId).toBe(
      bullet.firstChild?.attrs.blockId,
    );
    destroy();
  });

  it("creates a 3x3 Table only from an empty direct Paragraph", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    expect(transform(adapter, blockId, "table")).toMatchObject({
      changed: true,
    });
    const table = nodeByBlockId(editor, blockId);
    expect(table.type.name).toBe("table");
    expect(table.childCount).toBe(3);
    expect(table.child(0).childCount).toBe(3);
    expect(table.child(0).child(0).type.name).toBe("tableHeader");
    expect(table.child(1).child(0).type.name).toBe("tableCell");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    destroy();
  });

  it("creates a Table with the dimensions selected by the slash picker", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text: "/" }],
        },
      ]),
    );
    expect(
      transform(adapter, blockId, "table", true, {
        rows: 2,
        columns: 4,
      }),
    ).toMatchObject({ changed: true });
    const table = nodeByBlockId(editor, blockId);
    expect(table.childCount).toBe(2);
    expect(table.child(0).childCount).toBe(4);
    expect(table.child(0).child(0).type.name).toBe("tableHeader");
    expect(table.child(1).child(0).type.name).toBe("tableCell");
    destroy();
  });

  it("creates an Image stub, selects it as a block, and enters Normal mode", async () => {
    const requestImeOff = vi.fn(() => ({
      supported: true,
      inactive: true,
      detail: "test",
    }));
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      requestImeOff,
    });
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );

    expect(transform(adapter, blockId, "image")).toMatchObject({
      changed: true,
      selection: "node",
    });
    const image = nodeByBlockId(editor, blockId);
    expect(image.type.name).toBe("image");
    expect(image.attrs).toMatchObject({
      src: "attachment:missing",
      attachmentId: "attachment:missing",
      alt: "Image Block stub",
      alignment: "center",
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(requestImeOff).toHaveBeenCalled();

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("opens only for typed / in an empty direct-body Paragraph", async () => {
    const onBlockTypePicker = vi.fn();
    const { destroy, editor } = await editorHarness({ onBlockTypePicker });
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    let position = -1;
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === blockId) position = nodePosition + 1;
    });
    editor.commands.setTextSelection(position);

    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, position, position, "/", () => editor.state.tr),
    );
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).toHaveBeenCalledWith({ blockId });

    onBlockTypePicker.mockClear();
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).not.toHaveBeenCalled();
    destroy();
  });

  it("does not open from paste, composition, a Header, or nonempty content", async () => {
    const onBlockTypePicker = vi.fn();
    const { destroy, editor } = await editorHarness({ onBlockTypePicker });
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    let position = -1;
    let headerPosition = -1;
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === blockId) position = nodePosition + 1;
      if (node.type.name === "sectionHeader") headerPosition = nodePosition + 1;
    });

    // Programmatic/paste insertion bypasses handleTextInput and cannot open it.
    editor.commands.setTextSelection(position);
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).not.toHaveBeenCalled();

    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === blockId) position = nodePosition + 1;
      if (node.type.name === "sectionHeader") headerPosition = nodePosition + 1;
    });
    editor.commands.setTextSelection(position);
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, position, position, "/", () => editor.state.tr),
    );
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).not.toHaveBeenCalled();
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend"));

    editor.commands.setTextSelection(headerPosition);
    editor.view.someProp("handleTextInput", (handler) =>
      handler(
        editor.view,
        headerPosition,
        headerPosition,
        "/",
        () => editor.state.tr,
      ),
    );
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).not.toHaveBeenCalled();
    destroy();
  });

  it("rejects an accepted picker target after the slash Paragraph changes", async () => {
    const { adapter, destroy, editor } = await editorHarness();
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text: "/changed" }],
        },
      ]),
    );
    expect(transform(adapter, blockId, "table", true)).toEqual({
      changed: false,
      reason: "stale-slash",
    });
    expect(nodeByBlockId(editor, blockId).type.name).toBe("paragraph");
    destroy();
  });

  it("keeps slash insertion and accepted conversion as separate Undo items", async () => {
    const onBlockTypePicker = vi.fn();
    const { adapter, destroy, editor, runtime } = await editorHarness({
      onBlockTypePicker,
    });
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    runtime.noteDocument.undoManager.clear();
    let position = -1;
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === blockId) position = nodePosition + 1;
    });
    editor.commands.setTextSelection(position);
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, position, position, "/", () => editor.state.tr),
    );
    editor.commands.insertContent("/");
    await Promise.resolve();

    expect(transform(adapter, blockId, "codeBlock", true)).toMatchObject({
      changed: true,
    });
    expect(nodeByBlockId(editor, blockId).type.name).toBe("codeBlock");
    expect(editor.commands.undo()).toBe(true);
    expect(nodeByBlockId(editor, blockId).type.name).toBe("paragraph");
    expect(nodeByBlockId(editor, blockId).textContent).toBe("/");
    expect(editor.commands.undo()).toBe(true);
    expect(nodeByBlockId(editor, blockId).textContent).toBe("");
    expect(editor.commands.redo()).toBe(true);
    expect(nodeByBlockId(editor, blockId).textContent).toBe("/");
    expect(editor.commands.redo()).toBe(true);
    expect(nodeByBlockId(editor, blockId).type.name).toBe("codeBlock");
    destroy();
  });

  it("finishes an o change before recording the accepted conversion", async () => {
    const { adapter, destroy, editor, runtime } = await editorHarness();
    const originalBlockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId: originalBlockId },
          content: [{ type: "text", text: "before" }],
        },
      ]),
    );
    editor.commands.focus();
    press(editor, "Escape");
    let originalPosition = -1;
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === originalBlockId) {
        originalPosition = nodePosition + 1;
      }
    });
    editor.commands.setTextSelection(originalPosition);
    runtime.noteDocument.undoManager.clear();
    runtime.noteDocument.undoManager.stopCapturing();

    press(editor, "o");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    const openedBlockId = editor.state.selection.$from.parent.attrs.blockId as
      string | undefined;
    expect(openedBlockId).toBeTruthy();
    editor.commands.insertContent("/");

    expect(
      transform(adapter, openedBlockId ?? "", "codeBlock", true),
    ).toMatchObject({ changed: true });
    expect(nodeByBlockId(editor, openedBlockId ?? "").type.name).toBe(
      "codeBlock",
    );

    expect(editor.commands.undo()).toBe(true);
    expect(nodeByBlockId(editor, openedBlockId ?? "").type.name).toBe(
      "paragraph",
    );
    expect(nodeByBlockId(editor, openedBlockId ?? "").textContent).toBe("/");
    expect(editor.commands.undo()).toBe(true);
    expect(() => nodeByBlockId(editor, openedBlockId ?? "")).toThrow(
      "Block not found",
    );
    expect(nodeByBlockId(editor, originalBlockId).textContent).toBe("before");
    destroy();
  });

  it("keeps the transform Undo boundary when two Windows share the NoteDoc", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    const blockId = createUuidV7();
    first.editor.commands.setContent(
      directBodyContent([
        { type: "paragraph", attrs: { blockId }, content: [] },
      ]),
    );
    runtime.noteDocument.undoManager.clear();
    let position = -1;
    first.editor.state.doc.descendants((node, nodePosition) => {
      if (node.attrs.blockId === blockId) position = nodePosition + 1;
    });
    first.editor.commands.setTextSelection(position);
    first.editor.commands.insertContent("/");
    expect(transform(first.adapter, blockId, "codeBlock", true)).toMatchObject({
      changed: true,
    });
    expect(nodeByBlockId(second.editor, blockId).type.name).toBe("codeBlock");

    expect(first.editor.commands.undo()).toBe(true);
    expect(nodeByBlockId(first.editor, blockId).type.name).toBe("paragraph");
    expect(nodeByBlockId(first.editor, blockId).textContent).toBe("/");
    expect(nodeByBlockId(second.editor, blockId).textContent).toBe("/");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("persists the structured transformed block through the normal editor gateway", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence);
    const noteId = runtime.noteId;
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const blockId = createUuidV7();
    editor.commands.setContent(
      directBodyContent([
        {
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text: "persisted" }],
        },
      ]),
    );
    expect(transform(adapter, blockId, "sourceBlock")).toMatchObject({
      changed: true,
    });
    await runtime.flush();
    adapter.destroy();
    runtime.destroy();
    root.remove();

    const reopened = await CoreRuntime.open(persistence);
    const productDocument = reopened.getNoteHandle(noteId).current;
    if (productDocument.kind !== "note") throw new Error("Expected NoteDoc");
    const persisted = sectionBodyBlocks(productDocument.rootSection).find(
      (value) => value.getAttribute("blockId") === blockId,
    );
    expect(persisted?.nodeName).toBe("sourceBlock");
    expect(persisted?.toString()).toContain("persisted");
    reopened.destroy();
  });
});
