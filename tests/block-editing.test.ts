import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { measureVimBlockCaretGeometry } from "../app/src/vim/caret-geometry";
import { addSecondWindow } from "./helpers/runtime";

function press(
  editor: Editor,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: options.code ?? key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

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

function firstNode(
  editor: Editor,
  typeName: string,
): { node: ProseMirrorNode; position: number } {
  let found: { node: ProseMirrorNode; position: number } | null = null;
  editor.state.doc.descendants((node, position) => {
    if (!found && node.type.name === typeName) {
      found = { node, position };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`Node not found: ${typeName}`);
  return found;
}

function nodeCount(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
  });
  return count;
}

function emptyTextblockPosition(editor: Editor): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.isTextblock && node.content.size === 0) {
      result = position + 1;
      return false;
    }
    return true;
  });
  if (result < 0) throw new Error("Empty textblock not found");
  return result;
}

async function productEditor() {
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root);
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

describe("Memoka block editing boundaries", () => {
  it("inherits the current Code Block line indentation on Enter", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "first\n    second" }],
        },
      ],
    });
    editor.commands.setTextSelection(
      textPosition(editor, "second") + "second".length,
    );

    const event = press(editor, "Enter");
    await runtime.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "first\n    second\n    ",
    );
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(adapter.vimSnapshot.action).toBe("code:newline-with-indent:changed");
    destroy();
  });

  it("edits Source Block lines through the shared block semantics", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [{ type: "text", text: "| first |\n  | second |" }],
        },
      ],
    });
    editor.commands.setTextSelection(
      textPosition(editor, "second") + "second |".length,
    );

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "| first |\n  | second |\n  ",
    );
    expect(adapter.vimSnapshot.action).toBe(
      "source:newline-with-indent:changed",
    );

    editor.commands.setTextSelection({
      from: textPosition(editor, "first"),
      to: textPosition(editor, "second") + "second".length,
    });
    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.action).toBe("source:indent:changed");
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "  | first |\n    | second |\n  ",
    );
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "  | first |\n    | second |\n  ",
    );
    destroy();
  });

  it("joins compatible Source Blocks without converting their type", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [{ type: "text", text: "| first |" }],
        },
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [{ type: "text", text: "| second |" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "| second |"));

    expect(press(editor, "Backspace").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("sourceBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "| first |\n| second |",
    );
    expect(adapter.vimSnapshot.action).toBe(
      "source:join-blocks-backward:changed",
    );
    destroy();
  });

  it("unwraps an empty Code Block to Paragraph at its boundary", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "typescript" } }],
    });
    editor.commands.setTextSelection(1);

    const event = press(editor, "Backspace");
    await runtime.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(adapter.vimSnapshot.action).toBe(
      "structure:unwrap-backward:changed",
    );
    destroy();
  });

  it.each([
    ["Backspace", "backward"],
    ["Delete", "forward"],
  ] as const)(
    "unwraps an adjacent empty Code Block before %s can cross it",
    async (key, direction) => {
      const { adapter, destroy, editor, runtime } = await productEditor();
      editor.commands.setContent({
        type: "doc",
        content:
          direction === "backward"
            ? [
                {
                  type: "codeBlock",
                  attrs: { language: "typescript" },
                },
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Body" }],
                },
              ]
            : [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Body" }],
                },
                {
                  type: "codeBlock",
                  attrs: { language: "typescript" },
                },
              ],
      });
      const codeBlockId = firstNode(editor, "codeBlock").node.attrs.blockId;
      editor.commands.setTextSelection(
        textPosition(editor, "Body") +
          (direction === "forward" ? "Body".length : 0),
      );

      const event = press(editor, key);
      await runtime.flush();
      expect(event.defaultPrevented).toBe(true);
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.child(0).type.name).toBe("paragraph");
      expect(editor.state.doc.child(1).type.name).toBe("paragraph");
      expect(
        direction === "backward"
          ? editor.state.doc.child(0).attrs.blockId
          : editor.state.doc.child(1).attrs.blockId,
      ).toBe(codeBlockId);
      expect(adapter.vimSnapshot.action).toBe(
        `structure:unwrap-adjacent-${direction}:changed`,
      );
      destroy();
    },
  );

  it.each([
    ["Backspace", "backward", 6],
    ["Delete", "forward", 5],
  ] as const)(
    "joins compatible Code Blocks with a preserved logical newline on %s",
    async (key, direction, expectedOffset) => {
      const { adapter, destroy, editor, runtime } = await productEditor();
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language: "typescript" },
            content: [{ type: "text", text: "first" }],
          },
          {
            type: "codeBlock",
            attrs: { language: "typescript" },
            content: [{ type: "text", text: "second" }],
          },
        ],
      });
      const leftBlockId = firstNode(editor, "codeBlock").node.attrs.blockId;
      editor.commands.setTextSelection(
        direction === "backward"
          ? textPosition(editor, "second")
          : textPosition(editor, "first") + "first".length,
      );

      const event = press(editor, key);
      await runtime.flush();
      expect(event.defaultPrevented).toBe(true);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.textContent).toBe("first\nsecond");
      expect(editor.state.doc.firstChild?.attrs.blockId).toBe(leftBlockId);
      expect(editor.state.selection.$from.parentOffset).toBe(expectedOffset);
      expect(adapter.vimSnapshot.action).toBe(
        `code:join-blocks-${direction}:changed`,
      );
      destroy();
    },
  );

  it.each([
    {
      label: "Code Block and Paragraph",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "code" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Body" }],
        },
      ],
      cursorText: "code",
      cursorOffset: "code".length,
      key: "Delete",
      direction: "forward",
    },
    {
      label: "Paragraph and Code Block",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Body" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "code" }],
        },
      ],
      cursorText: "code",
      cursorOffset: 0,
      key: "Backspace",
      direction: "backward",
    },
    {
      label: "different-language Code Blocks",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "first" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "rust" },
          content: [{ type: "text", text: "second" }],
        },
      ],
      cursorText: "first",
      cursorOffset: "first".length,
      key: "Delete",
      direction: "forward",
    },
  ])(
    "does not merge incompatible $label on boundary $key",
    async ({ content, cursorOffset, cursorText, direction, key }) => {
      const { adapter, destroy, editor, runtime } = await productEditor();
      editor.commands.setContent({ type: "doc", content });
      editor.commands.setTextSelection(
        textPosition(editor, cursorText) + cursorOffset,
      );
      const before = editor.state.doc.toJSON();

      const event = press(editor, key);
      await runtime.flush();
      expect(event.defaultPrevented).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(before);
      expect(adapter.vimSnapshot.action).toBe(
        `code:incompatible-boundary-${direction}:boundary`,
      );
      destroy();
    },
  );

  it("delegates Paragraph Enter and Shift+Enter to TipTap", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent("<p>firstsecond</p>");
    editor.commands.setTextSelection(
      textPosition(editor, "firstsecond") + "first".length,
    );

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe("first");
    expect(editor.state.doc.child(1).textContent).toBe("second");

    editor.commands.setContent("<p>firstsecond</p>");
    editor.commands.setTextSelection(
      textPosition(editor, "firstsecond") + "first".length,
    );
    expect(press(editor, "Enter", { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.child(1).type.name).toBe("hardBreak");
    destroy();
  });

  it.each([
    [
      "Numbered List",
      "7",
      { code: "Digit7", ctrlKey: true, shiftKey: true },
      "orderedList",
    ],
    [
      "Bullet List",
      "8",
      { code: "Digit8", ctrlKey: true, shiftKey: true },
      "bulletList",
    ],
    [
      "Code Block",
      "c",
      { code: "KeyC", ctrlKey: true, altKey: true },
      "codeBlock",
    ],
  ] as const)(
    "keeps TipTap's keyboard-only %s conversion available",
    async (_label, key, options, expectedNode) => {
      const { destroy, editor, runtime } = await productEditor();
      editor.commands.setContent("<p>convert me</p>");
      editor.commands.setTextSelection(textPosition(editor, "convert me"));

      expect(press(editor, key, options).defaultPrevented).toBe(true);
      await runtime.flush();
      expect(editor.state.doc.firstChild?.type.name).toBe(expectedNode);
      destroy();
    },
  );

  it("inserts a three-by-three Table through the keyboard-only shortcut", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);

    expect(
      press(editor, "9", {
        code: "Digit9",
        ctrlKey: true,
        shiftKey: true,
      }).defaultPrevented,
    ).toBe(true);
    await runtime.flush();
    expect(nodeCount(editor, "table")).toBe(1);
    expect(nodeCount(editor, "tableRow")).toBe(3);
    expect(nodeCount(editor, "tableHeader")).toBe(3);
    expect(nodeCount(editor, "tableCell")).toBe(6);
    const identities: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText && node.type.name !== "doc") {
        identities.push(node.attrs.blockId);
      }
    });
    expect(identities.every((identity) => typeof identity === "string")).toBe(
      true,
    );
    expect(new Set(identities).size).toBe(identities.length);
    destroy();
  });

  it("keeps Tab inside a Table and adds a row after the last cell", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "H1" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "H2" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A1" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A2" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "H1"));

    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("H2");
    expect(press(editor, "Tab", { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(editor.state.selection.$from.parent.textContent).toBe("H1");

    editor.commands.setTextSelection(textPosition(editor, "A2"));
    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    await runtime.flush();
    const table = firstNode(editor, "table").node;
    expect(table.childCount).toBe(3);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.textContent).toBe("");
    expect(adapter.vimSnapshot.action).toBe("table:add-row:changed");
    expect(editor.isFocused).toBe(true);
    destroy();
  });

  it("keeps ListItem Enter semantics delegated to TipTap", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "item" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(
      textPosition(editor, "item") + "item".length,
    );

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.textContent).toBe("");

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).type.name).toBe("bulletList");
    expect(editor.state.doc.child(0).childCount).toBe(1);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    destroy();
  });

  it("lifts an empty nested ListItem by exactly one level on Enter", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(emptyTextblockPosition(editor));

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    await runtime.flush();
    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(list?.child(0).textContent).toBe("parent");
    expect(list?.child(1).textContent).toBe("");
    expect(editor.state.selection.$from.parent.textContent).toBe("");
    destroy();
  });

  it("outdents a nested ListItem by one level on boundary Backspace", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "child"));

    expect(press(editor, "Backspace").defaultPrevented).toBe(true);
    await runtime.flush();
    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(list?.child(0).textContent).toBe("parent");
    expect(list?.child(1).textContent).toBe("child");
    destroy();
  });

  it("indents and outdents a ListItem without moving focus", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "child" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "child"));

    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    await runtime.flush();
    const firstItem = editor.state.doc.firstChild?.firstChild;
    expect(firstItem?.childCount).toBe(2);
    expect(firstItem?.child(1).type.name).toBe("bulletList");
    expect(firstItem?.child(1).firstChild?.textContent).toBe("child");
    expect(editor.isFocused).toBe(true);

    expect(press(editor, "Tab", { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe("child");
    expect(editor.isFocused).toBe(true);
    destroy();
  });

  it("indents and outdents every selected Code Block line", async () => {
    const { destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "first\nsecond" }],
        },
      ],
    });
    editor.commands.setTextSelection({
      from: textPosition(editor, "first"),
      to: textPosition(editor, "second") + "second".length,
    });

    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("  first\n  second");
    expect(press(editor, "Tab", { shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("first\nsecond");
    destroy();
  });

  it("treats dj in a Code Block as a two-line operation", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "first\nsecond\nthird" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "first"));
    press(editor, "Escape");
    press(editor, "d");
    press(editor, "j");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("third");
    expect(adapter.vimSnapshot.register).toBe("CodeLine×2: first second");

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "first\nsecond\nthird",
    );
    destroy();
  });

  it("puts Source Block lines outside the block without converting to code", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [{ type: "text", text: "| raw | table |" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After" }],
        },
      ],
    });
    const originalId = firstNode(editor, "sourceBlock").node.attrs.blockId;
    editor.commands.setTextSelection(textPosition(editor, "| raw |"));
    expect(defaultVimBlockSemantics.logicalLines(editor.view)[0]).toMatchObject(
      {
        kind: "code-line",
        blockNodeName: "sourceBlock",
      },
    );
    expect(
      defaultVimBlockSemantics.structuralUnits(editor.view)[0],
    ).toMatchObject({
      kind: "code-line",
      nodeName: "sourceBlock",
    });
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "y");
    press(editor, "j");
    press(editor, "p");
    await runtime.flush();

    expect(adapter.vimSnapshot.register).toBe("SourceLine×1: | raw | table |");
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(2).type.name).toBe("sourceBlock");
    expect(editor.state.doc.child(2).textContent).toBe("| raw | table |");
    expect(editor.state.doc.child(2).attrs.blockId).not.toBe(originalId);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(2);
    destroy();
  });

  it("deletes an Image Block NodeSelection as one block", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "/image-stub.svg",
            alt: "image block stub",
            attachmentId: "fixture-attachment",
          },
        },
      ],
    });
    editor.commands.setNodeSelection(0);

    const event = press(editor, "Delete");
    await runtime.flush();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(adapter.vimSnapshot.action).toBe(
      "block-atom:delete-forward:changed",
    );
    destroy();
  });

  it("renders a selected Horizontal Rule as one block-sized Vim caret", async () => {
    const { destroy, editor } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    const rule = firstNode(editor, "horizontalRule");
    const ruleElement = editor.view.nodeDOM(rule.position);
    expect(ruleElement).toBeInstanceOf(HTMLElement);
    const ruleLayout = vi
      .spyOn(ruleElement as HTMLElement, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(40, 96, 420, 18));

    editor.commands.setNodeSelection(rule.position);
    expect(
      (ruleElement as HTMLElement).classList.contains(
        "ProseMirror-selectednode",
      ),
    ).toBe(true);
    expect(measureVimBlockCaretGeometry(editor.view, rule.position)).toEqual({
      cursor: rule.position,
      left: 40,
      top: 96,
      width: 420,
      height: 18,
    });

    ruleLayout.mockRestore();
    destroy();
  });

  it("keeps the Horizontal Rule line visible inside a Visual Line selection", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    document.head.append(style);
    const { adapter, destroy, editor } = await productEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "horizontalRule" },
        { type: "horizontalRule" },
        { type: "horizontalRule" },
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    const rules: { element: HTMLElement; position: number }[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name !== "horizontalRule") return true;
      const element = editor.view.nodeDOM(position);
      expect(element).toBeInstanceOf(HTMLElement);
      rules.push({ element: element as HTMLElement, position });
      return true;
    });
    expect(rules).toHaveLength(4);
    const ruleLayouts = rules.map(({ element }, index) =>
      vi
        .spyOn(element, "getBoundingClientRect")
        .mockReturnValue(new DOMRect(40, 60 + index * 36, 420, 18)),
    );
    editor.commands.setNodeSelection(rules[1].position);
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "j");

    expect(adapter.vimSnapshot.mode).toBe("visual-line");
    const selectedRules = rules.filter(({ element }) =>
      element.classList.contains("memoka-visual-line-selected"),
    );
    expect(selectedRules).toHaveLength(2);
    for (const { element } of selectedRules) {
      const selectedStyle = getComputedStyle(element);
      expect(selectedStyle.backgroundColor).toBe(
        "var(--memoka-color-selection)",
      );
      expect(
        selectedStyle
          .getPropertyValue("--memoka-horizontal-rule-line-color")
          .trim(),
      ).toBe("var(--memoka-color-selection-text)");
      expect(style.textContent).toContain(
        "border: 1px solid var(--memoka-color-selection-border)",
      );
      expect(selectedStyle.backgroundImage).toContain("linear-gradient");
    }
    const caret = await vi.waitFor(() => {
      const rendered = [
        ...document.querySelectorAll<HTMLElement>(".memoka-vim-caret"),
      ].find((candidate) => candidate.style.display === "block");
      if (!rendered) throw new Error("Visual Line caret did not render");
      return rendered;
    });
    expect(caret.dataset.nodeName).toBe("horizontalRule");
    expect(caret.classList).toContain("memoka-vim-caret--horizontal-rule");
    expect(style.textContent).toContain(".memoka-vim-caret--horizontal-rule");
    expect(style.textContent).toContain("linear-gradient(\n      to bottom");

    for (const ruleLayout of ruleLayouts) ruleLayout.mockRestore();
    destroy();
    style.remove();
  });

  it("enters around a Horizontal Rule with i/I at the previous end and a/A at the next start", async () => {
    const { adapter, destroy, editor } = await productEditor();
    const fixture = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    };

    for (const key of ["i", "I", "a", "A"] as const) {
      editor.commands.setContent(fixture);
      const rule = firstNode(editor, "horizontalRule");
      editor.commands.setNodeSelection(rule.position);
      press(editor, "Escape");
      expect(press(editor, key).defaultPrevented).toBe(true);
      expect(adapter.vimSnapshot.mode).toBe("insert");
      const before = key === "i" || key === "I";
      expect(editor.state.selection.$from.parent.textContent).toBe(
        before ? "before" : "after",
      );
      expect(editor.state.selection.$from.parentOffset).toBe(
        before ? "before".length : 0,
      );
      press(editor, "Escape");
    }

    destroy();
  });

  it("creates a Paragraph when a Horizontal Rule has no i/I or a/A destination", async () => {
    const { adapter, destroy, editor, runtime } = await productEditor();

    for (const key of ["i", "I", "a", "A"] as const) {
      editor.commands.setContent({
        type: "doc",
        content: [{ type: "horizontalRule" }],
      });
      const rule = firstNode(editor, "horizontalRule");
      editor.commands.setNodeSelection(rule.position);
      press(editor, "Escape");
      press(editor, key);
      await runtime.flush();

      const before = key === "i" || key === "I";
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.child(before ? 0 : 1).type.name).toBe(
        "paragraph",
      );
      expect(editor.state.doc.child(before ? 1 : 0).type.name).toBe(
        "horizontalRule",
      );
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(adapter.vimSnapshot.mode).toBe("insert");
      press(editor, "Escape");
    }

    destroy();
  });

  it("treats an Internal Link as one non-editable character", async () => {
    const { destroy, editor } = await productEditor();
    const targetSectionId = "01900000-0000-7000-8000-0000000000aa";
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            {
              type: "internalSectionLink",
              attrs: { targetSectionId },
              content: [{ type: "text", text: "Target" }],
            },
            { type: "text", text: "B" },
          ],
        },
      ],
    });
    const originalLink = firstNode(editor, "internalSectionLink");
    const linkElement = editor.view.nodeDOM(originalLink.position);
    expect(originalLink.node.isAtom).toBe(true);
    expect(linkElement).toBeInstanceOf(HTMLElement);
    expect((linkElement as HTMLElement).contentEditable).toBe("false");
    expect(linkElement?.textContent).toBe("Target");

    const linkRect = new DOMRect(120, 80, 96, 22);
    const linkLayout = vi
      .spyOn(linkElement as HTMLElement, "getBoundingClientRect")
      .mockReturnValue(linkRect);
    expect(
      measureVimBlockCaretGeometry(editor.view, originalLink.position),
    ).toEqual({
      cursor: originalLink.position,
      left: 120,
      top: 80,
      width: 96,
      height: 22,
    });
    linkLayout.mockRestore();

    editor.commands.setTextSelection(originalLink.position + 3);
    editor.commands.focus();
    press(editor, "Escape");
    expect(editor.state.selection.from).toBe(originalLink.position);

    expect(press(editor, "h").defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(originalLink.position - 1);
    expect(press(editor, "l").defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(originalLink.position);
    expect(press(editor, "l").defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(
      originalLink.position + originalLink.node.nodeSize,
    );

    editor.commands.setTextSelection(originalLink.position);
    press(editor, "i");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.from).toBe(originalLink.position);
    editor.commands.insertContent("X");
    press(editor, "Escape");

    const movedLink = firstNode(editor, "internalSectionLink");
    editor.commands.setTextSelection(movedLink.position);
    press(editor, "a");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.from).toBe(
      movedLink.position + movedLink.node.nodeSize,
    );
    editor.commands.insertContent("Y");
    press(editor, "Escape");

    const unchangedLink = firstNode(editor, "internalSectionLink");
    expect(unchangedLink.node.textContent).toBe("Target");
    expect(editor.state.doc.firstChild?.textContent).toBe("AXTargetYB");

    editor.commands.setTextSelection(unchangedLink.position);
    expect(press(editor, "x").defaultPrevented).toBe(true);
    expect(nodeCount(editor, "internalSectionLink")).toBe(0);
    expect(editor.state.doc.firstChild?.textContent).toBe("AXYB");
    destroy();
  });

  it("round-trips Image Block dd, p and undo through both NoteDoc views", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "/image-stub.svg",
            alt: "image block stub",
            attachmentId: "fixture-attachment",
          },
        },
      ],
    });
    await runtime.flush();
    const originalBlockId = firstNode(first.editor, "image").node.attrs.blockId;
    first.editor.commands.setNodeSelection(0);
    first.editor.commands.focus();
    press(first.editor, "Escape");

    press(first.editor, "V");
    expect(first.adapter.vimSnapshot.mode).toBe("visual-line");
    expect(
      firstRoot
        .querySelector(".memoka-visual-line-selected")
        ?.getAttribute("data-vim-node-name"),
    ).toBe("image");
    press(first.editor, "y");
    expect(first.adapter.vimSnapshot.register).toContain("block:");

    press(first.editor, "d");
    press(first.editor, "d");
    await runtime.flush();
    expect(nodeCount(first.editor, "image")).toBe(0);
    expect(nodeCount(second.editor, "image")).toBe(0);
    expect(first.adapter.vimSnapshot.register).toContain("block:");

    press(first.editor, "p");
    await runtime.flush();
    expect(nodeCount(first.editor, "image")).toBe(1);
    expect(nodeCount(second.editor, "image")).toBe(1);
    const pastedBlockId = firstNode(first.editor, "image").node.attrs.blockId;
    expect(pastedBlockId).not.toBe(originalBlockId);
    expect(firstNode(second.editor, "image").node.attrs.blockId).toBe(
      pastedBlockId,
    );

    press(first.editor, "u");
    await runtime.flush();
    expect(nodeCount(first.editor, "image")).toBe(0);
    expect(nodeCount(second.editor, "image")).toBe(0);
    press(first.editor, "u");
    await runtime.flush();
    expect(firstNode(first.editor, "image").node.attrs.blockId).toBe(
      originalBlockId,
    );
    expect(firstNode(second.editor, "image").node.attrs.blockId).toBe(
      originalBlockId,
    );

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });
});
