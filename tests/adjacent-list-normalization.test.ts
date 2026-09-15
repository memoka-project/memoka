import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { productEditorExtensions } from "../app/src/editor/extensions";

function paragraph(text: string, blockId = createUuidV7()): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function item(text: string, checked: boolean | null = null): JSONContent {
  return {
    type: "listItem",
    attrs: { blockId: createUuidV7(), checked },
    content: [paragraph(text)],
  };
}

function list(
  type: "bulletList" | "orderedList",
  blockId: string,
  items: JSONContent[],
  start = 1,
): JSONContent {
  return {
    type,
    attrs: type === "orderedList" ? { blockId, start } : { blockId },
    content: items,
  };
}

function textPosition(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.isText && node.text?.includes(text)) {
      result = position + node.text.indexOf(text);
      return false;
    }
    return result < 0;
  });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}

function blockPosition(editor: Editor, blockId: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.attrs.blockId === blockId) {
      result = position;
      return false;
    }
    return result < 0;
  });
  if (result < 0) throw new Error(`Missing block: ${blockId}`);
  return result;
}

function directEditor(): {
  editor: Editor;
  destroy: () => void;
} {
  const note = createNoteDocument(createUuidV7());
  const editor = new Editor({
    extensions: productEditorExtensions(note, { directBodyOnly: true }),
  });
  return {
    editor,
    destroy: () => {
      editor.destroy();
      note.doc.destroy();
    },
  };
}

function loadedDirectEditor(content: JSONContent[]): {
  editor: Editor;
  destroy: () => void;
} {
  const note = createNoteDocument(createUuidV7());
  const writer = new Editor({
    extensions: productEditorExtensions(note, { directBodyOnly: true }).filter(
      (extension) => extension.name !== "memokaAdjacentListNormalization",
    ),
  });
  writer.commands.setContent({ type: "doc", content });
  writer.destroy();
  const editor = new Editor({
    extensions: productEditorExtensions(note, { directBodyOnly: true }),
  });
  return {
    editor,
    destroy: () => {
      editor.destroy();
      note.doc.destroy();
    },
  };
}

describe("adjacent List normalization", () => {
  it("merges matching list containers while preserving task state and ordered start", () => {
    const { editor, destroy } = directEditor();
    const bulletId = createUuidV7();
    const orderedId = createUuidV7();
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          list("bulletList", bulletId, [item("plain")]),
          list("bulletList", createUuidV7(), [item("task", false)]),
          list("orderedList", orderedId, [item("seven")], 7),
          list("orderedList", createUuidV7(), [item("continued")], 42),
        ],
      });

      expect(editor.state.doc.childCount).toBe(2);
      const bullet = editor.state.doc.child(0);
      expect(bullet.type.name).toBe("bulletList");
      expect(bullet.attrs.blockId).toBe(bulletId);
      expect(bullet.content.content.map((node) => node.textContent)).toEqual([
        "plain",
        "task",
      ]);
      expect(bullet.child(0).attrs.checked).toBeNull();
      expect(bullet.child(1).attrs.checked).toBe(false);

      const ordered = editor.state.doc.child(1);
      expect(ordered.type.name).toBe("orderedList");
      expect(ordered.attrs).toMatchObject({ blockId: orderedId, start: 7 });
      expect(ordered.content.content.map((node) => node.textContent)).toEqual([
        "seven",
        "continued",
      ]);
    } finally {
      destroy();
    }
  });

  it("does not merge bullet and ordered lists", () => {
    const { editor, destroy } = directEditor();
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          list("bulletList", createUuidV7(), [item("bullet")]),
          list("orderedList", createUuidV7(), [item("ordered")]),
        ],
      });
      expect(
        editor.state.doc.content.content.map((node) => node.type.name),
      ).toEqual(["bulletList", "orderedList"]);
    } finally {
      destroy();
    }
  });

  it("leaves loaded adjacency untouched until a new boundary joins its run", () => {
    const firstId = createUuidV7();
    const secondId = createUuidV7();
    const separatorId = createUuidV7();
    const thirdId = createUuidV7();
    const { editor, destroy } = loadedDirectEditor([
      paragraph("anchor"),
      list("bulletList", firstId, [item("first")]),
      list("bulletList", secondId, [item("second")]),
      paragraph("separator", separatorId),
      list("bulletList", thirdId, [item("third")]),
    ]);
    try {
      expect(editor.state.doc.childCount).toBe(5);
      editor.commands.insertContentAt(textPosition(editor, "first"), "X");
      expect(editor.state.doc.childCount).toBe(5);

      const thirdParagraphId = editor.state.doc.child(4).firstChild?.firstChild
        ?.attrs.blockId as string;
      const separatorPosition = blockPosition(editor, separatorId);
      const separatorSize =
        editor.state.doc.nodeAt(separatorPosition)!.nodeSize;
      editor.commands.setTextSelection(textPosition(editor, "third"));
      const transaction = editor.state.tr.delete(
        separatorPosition,
        separatorPosition + separatorSize,
      );
      editor.view.dispatch(transaction);

      expect(editor.state.doc.childCount).toBe(2);
      const merged = editor.state.doc.lastChild!;
      expect(merged.attrs.blockId).toBe(firstId);
      expect(merged.content.content.map((node) => node.textContent)).toEqual([
        "Xfirst",
        "second",
        "third",
      ]);
      expect(editor.state.selection.$from.parent.attrs.blockId).toBe(
        thirdParagraphId,
      );
      expect(editor.state.selection.$from.parentOffset).toBe(0);
    } finally {
      destroy();
    }
  });

  it("normalizes lists inside ListItems and Details bodies", () => {
    const { editor, destroy } = directEditor();
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          list("bulletList", createUuidV7(), [
            {
              type: "listItem",
              attrs: { blockId: createUuidV7(), checked: null },
              content: [
                paragraph("owner"),
                list("bulletList", createUuidV7(), [item("nested one")]),
                list("bulletList", createUuidV7(), [item("nested two")]),
              ],
            },
          ]),
          {
            type: "details",
            attrs: { blockId: createUuidV7(), open: true },
            content: [
              {
                type: "detailsSummary",
                attrs: { blockId: createUuidV7() },
                content: [{ type: "text", text: "Details" }],
              },
              {
                type: "detailsBody",
                attrs: { blockId: createUuidV7() },
                content: [
                  list("orderedList", createUuidV7(), [item("inside one")]),
                  list("orderedList", createUuidV7(), [item("inside two")]),
                ],
              },
            ],
          },
        ],
      });

      const owner = editor.state.doc.firstChild!.firstChild!;
      expect(owner.childCount).toBe(2);
      expect(owner.child(1).childCount).toBe(2);
      const detailsBody = editor.state.doc.child(1).child(1);
      expect(detailsBody.childCount).toBe(1);
      expect(detailsBody.firstChild!.childCount).toBe(2);
    } finally {
      destroy();
    }
  });

  it("normalizes across BodyChunk boundaries", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    const leftId = createUuidV7();
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
                content: [list("bulletList", leftId, [item("first chunk")])],
              },
              {
                type: "bodyChunk",
                attrs: { chunkId: createUuidV7() },
                content: [
                  list("bulletList", createUuidV7(), [item("second chunk")]),
                ],
              },
            ],
          },
          { type: "sectionChildren" },
        ],
      });

      const lists: ProseMirrorNode[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "bulletList") lists.push(node);
      });
      expect(lists).toHaveLength(1);
      expect(lists[0]?.attrs.blockId).toBe(leftId);
      expect(lists[0]?.childCount).toBe(2);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("records insertion and normalization as one Undo unit", () => {
    const { editor, destroy } = directEditor();
    const leftId = createUuidV7();
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          list("orderedList", leftId, [item("first")], 4),
          list("orderedList", createUuidV7(), [item("second")], 9),
        ],
      });
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.childCount).toBe(2);

      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      destroy();
    }
  });
});
