import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { paragraphPasteFixture } from "./helpers/large-note";

function firstParagraphCursor(editor: Editor): number {
  let cursor = -1;
  editor.state.doc.descendants((node, position) => {
    if (cursor < 0 && node.type.name === "paragraph") cursor = position + 1;
    return cursor < 0;
  });
  if (cursor < 0) throw new Error("fixture has no Paragraph");
  return cursor;
}

function press(
  editor: Editor,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function composition(
  editor: Editor,
  type: "compositionstart" | "compositionend",
): void {
  editor.view.dom.dispatchEvent(
    new CompositionEvent(type, {
      bubbles: true,
      cancelable: true,
      data: "",
    }),
  );
}

describe("Memoka large-note hot paths", () => {
  it("pastes thousands of Paragraphs with unique IDs as one undo item", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    try {
      editor.commands.setTextSelection(firstParagraphCursor(editor));
      const before = editor.getJSON();
      note.undoManager.clear();
      note.undoManager.stopCapturing();

      expect(
        editor.view.pasteText(
          paragraphPasteFixture({
            paragraphCount: 2_048,
            approximateParagraphBytes: 48,
          }),
          new Event("paste") as ClipboardEvent,
        ),
      ).toBe(true);

      const paragraphIds: string[] = [];
      const chunkSizes: number[] = [];
      let lastParagraphCursor = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "bodyChunk") {
          chunkSizes.push(node.childCount);
        }
        if (node.type.name === "paragraph") {
          paragraphIds.push(String(node.attrs.blockId ?? ""));
          lastParagraphCursor = position + 1;
        }
        return true;
      });
      expect(paragraphIds).toHaveLength(2_048);
      expect(paragraphIds.every((blockId) => blockId.length > 0)).toBe(true);
      expect(new Set(paragraphIds).size).toBe(paragraphIds.length);
      expect(chunkSizes.length).toBeGreaterThan(1);
      expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(256);
      expect(editor.view.dom.querySelectorAll("p").length).toBeLessThanOrEqual(
        1_536,
      );
      expect(
        editor.view.dom.querySelectorAll(".memoka-body-chunk--static").length,
      ).toBeGreaterThan(0);
      editor.commands.setTextSelection(lastParagraphCursor);
      expect(
        editor.view.dom.querySelector(
          `[data-block-id="${paragraphIds.at(-1)}"]`,
        ),
      ).not.toBeNull();
      expect(editor.view.dom.querySelectorAll("p").length).toBeLessThanOrEqual(
        1_536,
      );
      expect(note.undoManager.undoStack).toHaveLength(1);

      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("caches document projections and leaves character arrays lazy", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    try {
      editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: note.noteId, tags: "[]" },
          },
          {
            type: "sectionBody",
            content: [
              {
                type: "bodyChunk",
                attrs: { chunkId: createUuidV7() },
                content: Array.from({ length: 1_000 }, () => ({
                  type: "paragraph",
                  attrs: { blockId: createUuidV7() },
                  content: [{ type: "text", text: "x".repeat(1_024) }],
                })),
              },
            ],
          },
          { type: "sectionChildren" },
        ],
      });

      const first = defaultVimBlockSemantics.logicalLines(editor.view);
      const second = defaultVimBlockSemantics.logicalLines(editor.view);
      expect(second).toBe(first);
      expect(first).toHaveLength(1_001);
      expect(
        Object.getOwnPropertyDescriptor(first[1]!, "cursorPositions")?.get,
      ).toBeTypeOf("function");

      const structural = defaultVimBlockSemantics.structuralUnits(editor.view);
      expect(
        Object.getOwnPropertyDescriptor(structural[1]!, "cursorPositions")?.get,
      ).toBeTypeOf("function");
      expect(defaultVimBlockSemantics.structuralUnits(editor.view)).toBe(
        structural,
      );
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("keeps Vim selection and IME input correct across virtualized chunks", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Chunk boundary",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const blockIds = Array.from({ length: 700 }, () => createUuidV7());
    try {
      editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: runtime.noteId, tags: "[]" },
            content: [{ type: "text", text: "Chunk boundary" }],
          },
          {
            type: "sectionBody",
            content: [
              {
                type: "bodyChunk",
                attrs: { chunkId: createUuidV7() },
                content: blockIds.map((blockId, index) => ({
                  type: "paragraph",
                  attrs: { blockId },
                  content: [
                    {
                      type: "text",
                      text: `line-${String(index).padStart(4, "0")}`,
                    },
                  ],
                })),
              },
            ],
          },
          { type: "sectionChildren" },
        ],
      });

      const positions = new Map<string, number>();
      editor.state.doc.descendants((node, position) => {
        const blockId = String(node.attrs.blockId ?? "");
        if (blockId) positions.set(blockId, position + 1);
        return true;
      });
      expect(
        editor.view.dom.querySelectorAll(".memoka-body-chunk--static").length,
      ).toBeGreaterThan(0);

      const visualStart = positions.get(blockIds[255]!)!;
      editor.commands.setTextSelection(visualStart);
      editor.commands.focus();
      press(editor, "Escape");
      press(editor, "V", { shiftKey: true, code: "KeyV" });
      press(editor, "G", { shiftKey: true, code: "KeyG" });
      expect(adapter.vimSnapshot.mode).toBe("visual-line");
      press(editor, "y");
      expect(adapter.vimSnapshot).toMatchObject({ mode: "normal" });
      expect(adapter.vimSnapshot.register).toContain("line-0255");
      expect(adapter.vimSnapshot.register).toContain("line-0699");

      const imeBlockId = blockIds[512]!;
      editor.commands.setTextSelection(positions.get(imeBlockId)!);
      press(editor, "i");
      composition(editor, "compositionstart");
      expect(press(editor, "j", { isComposing: true }).defaultPrevented).toBe(
        false,
      );
      editor.commands.insertContent("日本語");
      composition(editor, "compositionend");
      expect(editor.state.doc.textContent).toContain("日本語line-0512");
      expect(
        editor.view.dom.querySelector(`[data-block-id="${imeBlockId}"]`),
      ).not.toBeNull();
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("activates representative rich blocks only when their distant chunk is reached", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    try {
      const blocks: JSONContent[] = Array.from({ length: 600 }, (_, index) => ({
        type: "paragraph",
        attrs: { blockId: createUuidV7() },
        content: [{ type: "text", text: `ordinary-${index}` }],
      }));
      blocks.splice(
        512,
        1,
        {
          type: "codeBlock",
          attrs: { blockId: createUuidV7(), language: "text" },
          content: [{ type: "text", text: "distant-code" }],
        },
        {
          type: "table",
          attrs: { blockId: createUuidV7() },
          content: [
            {
              type: "tableRow",
              attrs: { blockId: createUuidV7() },
              content: [
                {
                  type: "tableCell",
                  attrs: { blockId: createUuidV7(), colspan: 1, rowspan: 1 },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { blockId: createUuidV7() },
                      content: [{ type: "text", text: "distant-table" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          attrs: { blockId: createUuidV7() },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: createUuidV7() },
              content: [{ type: "text", text: "distant-quote" }],
            },
          ],
        },
        { type: "horizontalRule", attrs: { blockId: createUuidV7() } },
      );
      editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: note.noteId, tags: "[]" },
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
      });

      let firstPosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (
          node.type.name === "paragraph" &&
          node.textContent === "ordinary-0"
        ) {
          firstPosition = position + 1;
        }
        return firstPosition < 0;
      });
      editor.commands.setTextSelection(firstPosition);

      expect(editor.view.dom.querySelector("pre")).toBeNull();
      expect(editor.view.dom.querySelector(".memoka-table")).toBeNull();
      expect(editor.view.dom.querySelector("blockquote")).toBeNull();
      expect(editor.view.dom.querySelector("hr")).toBeNull();

      let codePosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "codeBlock") codePosition = position + 1;
        return codePosition < 0;
      });
      expect(codePosition).toBeGreaterThan(0);
      editor.commands.setTextSelection(codePosition);

      expect(editor.view.dom.querySelector("pre")?.textContent).toContain(
        "distant-code",
      );
      expect(
        editor.view.dom.querySelector(".memoka-table")?.textContent,
      ).toContain("distant-table");
      expect(
        editor.view.dom.querySelector("blockquote")?.textContent,
      ).toContain("distant-quote");
      expect(editor.view.dom.querySelector("hr")).not.toBeNull();
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("keeps inactive Table previews close to their rendered row geometry", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    const chunkIds = Array.from({ length: 4 }, () => createUuidV7());
    const blockIds = Array.from({ length: 3 }, () => createUuidV7());
    const tableCell = (text: string): JSONContent => ({
      type: "tableCell",
      attrs: { blockId: createUuidV7(), colspan: 1, rowspan: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: createUuidV7() },
          content: [{ type: "text", text }],
        },
      ],
    });
    try {
      editor.commands.setContent({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: note.noteId, tags: "[]" },
          },
          {
            type: "sectionBody",
            content: [
              ...chunkIds.slice(0, 3).map((chunkId, index) => ({
                type: "bodyChunk",
                attrs: { chunkId },
                content: [
                  {
                    type: "paragraph",
                    attrs: { blockId: blockIds[index] },
                    content: [{ type: "text", text: `line-${index}` }],
                  },
                ],
              })),
              {
                type: "bodyChunk",
                attrs: { chunkId: chunkIds[3] },
                content: [
                  {
                    type: "table",
                    attrs: { blockId: createUuidV7() },
                    content: [
                      {
                        type: "tableRow",
                        attrs: { blockId: createUuidV7() },
                        content: [
                          tableCell("a"),
                          tableCell("b"),
                          tableCell("c"),
                        ],
                      },
                      {
                        type: "tableRow",
                        attrs: { blockId: createUuidV7() },
                        content: [
                          tableCell("d"),
                          tableCell("e"),
                          tableCell("f"),
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { type: "sectionChildren" },
        ],
      });
      editor.commands.setTextSelection(firstParagraphCursor(editor));

      const target = editor.view.dom.querySelector<HTMLElement>(
        `[data-body-chunk-id="${chunkIds[3]}"]`,
      );
      expect(target?.dataset.bodyChunkVirtualized).toBe("true");
      expect(
        target?.querySelector(".memoka-body-chunk__static-content")
          ?.textContent,
      ).toBe("a | b | c\nd | e | f");
      expect(target?.style.getPropertyValue("--memoka-body-chunk-rows")).toBe(
        "2",
      );
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });
});
