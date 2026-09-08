import type { Editor, JSONContent } from "@tiptap/core";
import { DOMParser, Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { createUuidV7 } from "../app/src/core/ids";
import { runBlockTransformCommand } from "../app/src/vim/block-transform";
import { defaultVimBlockSemantics as semantics } from "../app/src/vim/block-semantics";
import {
  encodeVimClipboard,
  MARKDOWN_CLIPBOARD_MIME,
  type PreferredClipboardFormats,
} from "../app/src/vim/clipboard";
import { parseMarkdownPaste } from "../app/src/editor/markdown-paste";
import { sanitizeExternalHtml } from "../app/src/editor/html-paste";
import { insertAttachmentBlocks } from "../app/src/editor/attachment-insert";
import type { AttachmentMetadata } from "../app/src/core/attachments";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const p = (text = ""): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
const item = (...content: JSONContent[]): JSONContent => ({
  type: "listItem",
  content,
});
const list = (...content: JSONContent[]): JSONContent => ({
  type: "bulletList",
  content,
});
const code = (text = ""): JSONContent => ({
  type: "codeBlock",
  content: text ? [{ type: "text", text }] : [],
});
function key(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}
function position(editor: Editor, text: string) {
  let result = -1;
  editor.state.doc.descendants((node, pos) => {
    if (result < 0 && node.isText && node.text?.includes(text))
      result = pos + node.text.indexOf(text);
  });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}
function paste(editor: Editor, formats: Record<string, string>) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: Object.keys(formats),
      files: [],
      getData: (type: string) => formats[type] ?? "",
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}
async function harness(
  content: JSONContent[],
  clipboard?: PreferredClipboardFormats,
  onBlockTypePicker?: (request: { blockId: string }) => void,
) {
  const persistence = new MemoryPersistencePort();
  const runtime = await CoreRuntime.open(persistence);
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root, {
    onBlockTypePicker,
    ...(clipboard
      ? { readPreferredClipboard: () => Promise.resolve(clipboard) }
      : {}),
  });
  binding.editor.commands.setContent({ type: "doc", content });
  binding.editor.commands.focus();
  await runtime.flush();
  cleanups.push(async () => {
    await runtime.flush();
    binding.adapter.destroy();
    runtime.destroy();
    root.remove();
  });
  return { ...binding, runtime, persistence, root };
}

describe("rich ListItem editing", () => {
  it("imports empty tasks without treating escaped checkbox text as a task", async () => {
    const { editor } = await harness([p()]);
    const parsed = parseMarkdownPaste(
      "- [ ]\n- [X]\n- \\[x\\]",
      editor.schema,
    )!;
    const items = parsed.slice.content.firstChild!.content.content;
    expect(items.map((item) => item.attrs.checked)).toEqual([
      false,
      true,
      null,
    ]);
    expect(items[0]!.textContent).toBe("");
    expect(items[1]!.textContent).toBe("");
    expect(items[2]!.textContent).toBe("[x]");
  });
  it("keeps task checkbox state in sanitized HTML and rich blocks in Markdown", async () => {
    const { editor, runtime } = await harness([
      list(
        { ...item(code("日本語 code")), attrs: { checked: true } },
        { ...item(p("unchecked")), attrs: { checked: false } },
      ),
    ]);
    const container = document.createElement("div");
    container.innerHTML = sanitizeExternalHtml(editor.getHTML());
    const parsed = DOMParser.fromSchema(editor.schema).parse(container);
    expect(parsed.firstChild!.firstChild!.attrs.checked).toBe(true);
    expect(parsed.firstChild!.lastChild!.attrs.checked).toBe(false);
    expect(parsed.firstChild!.firstChild!.firstChild!.type.name).toBe(
      "codeBlock",
    );
    key(editor, "Escape");
    key(editor, "g");
    key(editor, "g");
    key(editor, "V");
    key(editor, "G");
    key(editor, "y");
    const markdown = encodeVimClipboard(
      runtime.vimRegister.read()!,
      editor.schema,
    )[MARKDOWN_CLIPBOARD_MIME];
    const imported = parseMarkdownPaste(markdown, editor.schema)!;
    let codeCount = 0;
    imported.slice.content.descendants((node) => {
      if (node.type.name === "codeBlock") codeCount++;
    });
    expect(codeCount).toBe(1);
    expect(imported.slice.content.firstChild!.firstChild!.attrs.checked).toBe(
      true,
    );
  });
  it("imports task state, preserves rich children, and serializes task markers", async () => {
    const { editor, runtime } = await harness([p()]);
    const parsed = parseMarkdownPaste(
      "- [ ] 日本語 **重要**\n\n  続き\n  - [X] 子\n- 普通",
      editor.schema,
    )!;
    editor.commands.setContent({
      type: "doc",
      content: parsed.slice.content.toJSON(),
    });
    const items = editor.state.doc.firstChild!.content.content;
    expect(items[0]!.attrs.checked).toBe(false);
    expect(items[0]!.lastChild!.firstChild!.attrs.checked).toBe(true);
    expect(items[1]!.attrs.checked).toBe(null);
    expect(
      editor.view.dom.querySelectorAll(".memoka-task-checkbox"),
    ).toHaveLength(2);
    expect(editor.state.doc.textContent).not.toContain("✓");
    key(editor, "Escape");
    key(editor, "g");
    key(editor, "g");
    key(editor, "V");
    key(editor, "G");
    key(editor, "y");
    const markdown = encodeVimClipboard(
      runtime.vimRegister.read()!,
      editor.schema,
    )[MARKDOWN_CLIPBOARD_MIME];
    expect(markdown).toContain("- [ ] 日本語 **重要**");
    expect(markdown).toContain("- [x] 子");
    expect(
      parseMarkdownPaste(markdown, editor.schema)!.slice.content.firstChild!
        .firstChild!.attrs.checked,
    ).toBe(false);
  });

  it("toggles a task by Normal Enter or mouse and keeps the user Undo history", async () => {
    const { editor, runtime, root } = await harness([
      list({ ...item(p("task")), attrs: { checked: false } }),
    ]);
    const note = runtime.getNoteHandle().current;
    if (note.kind !== "note") throw new Error("note");
    note.undoManager.clear();
    note.undoManager.stopCapturing();
    editor.commands.setTextSelection(position(editor, "task"));
    key(editor, "Escape");
    key(editor, "Enter");
    expect(editor.state.doc.firstChild!.firstChild!.attrs.checked).toBe(true);
    key(editor, "u");
    expect(editor.state.doc.firstChild!.firstChild!.attrs.checked).toBe(false);
    const button = root.querySelector<HTMLButtonElement>(
      ".memoka-task-checkbox",
    )!;
    button.click();
    expect(editor.state.doc.firstChild!.firstChild!.attrs.checked).toBe(true);
    expect(button.getAttribute("aria-checked")).toBe("true");
  });

  it.each(["Enter", "o", "O"])(
    "creates an unchecked task with %s",
    async (command) => {
      const { editor } = await harness([
        list({ ...item(p("task")), attrs: { checked: true } }),
      ]);
      editor.commands.setTextSelection(position(editor, "task") + 4);
      if (command !== "Enter") key(editor, "Escape");
      key(editor, command, { shiftKey: command === "O" });
      const items = editor.state.doc.firstChild!.content.content;
      expect(items).toHaveLength(2);
      expect(items[command === "O" ? 0 : 1]!.attrs.checked).toBe(false);
    },
  );

  it("does not toggle an ancestor task from a normal child item", async () => {
    const { editor } = await harness([
      list({
        ...item(p("parent"), list(item(p("child")))),
        attrs: { checked: true },
      }),
    ]);
    editor.commands.setTextSelection(position(editor, "child"));
    key(editor, "Escape");
    key(editor, "Enter");
    expect(editor.state.doc.firstChild!.firstChild!.attrs.checked).toBe(true);
  });

  it("converts a paragraph to a Task List using the common block picker command", async () => {
    const { editor } = await harness([list(item(p("todo")))]);
    const blockId =
      editor.state.doc.firstChild!.firstChild!.firstChild!.attrs.blockId;
    expect(
      runBlockTransformCommand(editor.view, {
        name: "block.transform",
        payload: { blockId, target: "taskList" },
      }).changed,
    ).toBe(true);
    expect(
      editor.state.doc.firstChild!.firstChild!.firstChild!.firstChild!.attrs
        .checked,
    ).toBe(false);
    expect(
      editor.view.dom.querySelector(".memoka-task-checkbox"),
    ).not.toBeNull();
  });
  it("splits a paragraph within its item with Alt-Enter and into siblings with Enter", async () => {
    const { editor } = await harness([list(item(p("abcd"), code("tail")))]);
    editor.commands.setTextSelection(position(editor, "abcd") + 2);
    key(editor, "Enter", { altKey: true });
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(
      editor.state.doc.firstChild!.firstChild!.content.content.map(
        (n) => n.textContent,
      ),
    ).toEqual(["ab", "cd", "tail"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("cd");
    key(editor, "Enter");
    expect(
      editor.state.doc.firstChild!.content.content.map((n) => n.textContent),
    ).toEqual(["ab", "cdtail"]);
    expect(editor.state.doc.firstChild!.lastChild!.lastChild!.type.name).toBe(
      "codeBlock",
    );
    editor.state.doc.check();
  });

  it("lets code own Enter and Alt-Enter leave code inside the item", async () => {
    const { editor } = await harness([list(item(code("ab"), p("tail")))]);
    editor.commands.setTextSelection(position(editor, "ab") + 1);
    key(editor, "Enter");
    expect(
      editor.state.doc.firstChild!.firstChild!.firstChild!.textContent,
    ).toBe("a\nb");
    key(editor, "Enter", { altKey: true });
    const blocks = editor.state.doc.firstChild!.firstChild!.content.content;
    expect(blocks.map((node) => node.textContent)).toEqual([
      "a\nb",
      "",
      "tail",
    ]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    key(editor, "Enter", { ctrlKey: true });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.lastChild!.firstChild!.type.name).toBe(
      "paragraph",
    );
  });

  it("keeps Ctrl-j/Ctrl-m equivalent to Enter and Shift-Enter inside the paragraph", async () => {
    const { editor } = await harness([list(item(p("abcd")))]);
    editor.commands.setTextSelection(position(editor, "abcd") + 1);
    key(editor, "Enter", { shiftKey: true });
    expect(
      editor.state.doc.firstChild!.firstChild!.firstChild!.child(1).type.name,
    ).toBe("hardBreak");
    key(editor, "j", { ctrlKey: true });
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    key(editor, "m", { ctrlKey: true });
    expect(editor.state.doc.firstChild!.childCount).toBe(3);
    editor.state.doc.check();
  });

  it("offers the slash picker in an empty first item paragraph and leaves / on cancellation", async () => {
    const onBlockTypePicker = vi.fn();
    const { editor } = await harness(
      [list(item(p()))],
      undefined,
      onBlockTypePicker,
    );
    editor.commands.setTextSelection(3);
    const blockId = String(editor.state.selection.$from.parent.attrs.blockId);
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, 3, 3, "/", () => editor.state.tr),
    );
    editor.commands.insertContent("/");
    await Promise.resolve();
    expect(onBlockTypePicker).toHaveBeenCalledWith({ blockId });
    // Closing the picker without a transform must not roll back normal input.
    expect(editor.state.doc.textContent).toBe("/");
  });

  it("creates a sibling at the nearest list depth from code inside a nested quote", async () => {
    const { editor } = await harness([
      list(
        item(
          p("parent"),
          list(item({ type: "blockquote", content: [code("inside")] })),
        ),
      ),
      p("existing"),
    ]);
    editor.commands.setTextSelection(position(editor, "inside"));
    key(editor, "Enter", { ctrlKey: true });
    expect(
      editor.state.doc.content.content.map((node) => node.type.name),
    ).toEqual(["bulletList", "paragraph"]);
    const nested = editor.state.doc.firstChild!.firstChild!.lastChild!;
    expect(nested.childCount).toBe(2);
    expect(nested.lastChild!.firstChild).toBe(
      editor.state.selection.$from.parent,
    );
    expect(editor.state.selection.$from.parent.textContent).toBe("");
    expect(editor.state.doc.lastChild!.textContent).toBe("existing");
  });

  it.each<JSONContent>([
    p("inside"),
    code("inside"),
    { type: "sourceBlock", content: [{ type: "text", text: "inside" }] },
    { type: "blockquote", content: [p("inside")] },
    {
      type: "blockquote",
      attrs: { alertType: "note" },
      content: [p("inside")],
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [p("inside")] }],
        },
      ],
    },
    { type: "image" },
    {
      type: "attachment",
      attrs: { attachmentId: createUuidV7(), label: "file.pdf" },
    },
    { type: "horizontalRule" },
  ])(
    "creates a first child before existing children from $type, with Undo/Redo",
    async (block) => {
      for (const opening of ["Ctrl-Enter", "o"]) {
        const { editor, adapter } = await harness([
          list(item(block, p("tail"), list(item(p("child")))), item(p("next"))),
        ]);
        if (opening === "o") key(editor, "Escape");
        if (["image", "attachment", "horizontalRule"].includes(block.type!)) {
          editor.view.dispatch(
            editor.state.tr.setSelection(
              NodeSelection.create(editor.state.doc, 2),
            ),
          );
        } else {
          editor.commands.setTextSelection(position(editor, "inside") + 2);
        }
        const before = editor.state.doc;
        const firstItem = before.firstChild!.firstChild!;
        const nextItem = before.firstChild!.lastChild!;
        const event =
          opening === "o"
            ? key(editor, "o")
            : key(editor, "Enter", { ctrlKey: true });
        expect(event.defaultPrevented).toBe(true);
        const result = editor.state.doc.firstChild!;
        expect(result.childCount).toBe(2);
        expect(result.firstChild!.attrs).toEqual(firstItem.attrs);
        expect(result.firstChild!.childCount).toBe(3);
        expect(result.firstChild!.child(0).eq(firstItem.child(0))).toBe(true);
        expect(result.firstChild!.child(1).eq(firstItem.child(1))).toBe(true);
        expect(result.lastChild!.eq(nextItem)).toBe(true);
        const children = result.firstChild!.lastChild!;
        expect(children.attrs).toEqual(firstItem.lastChild!.attrs);
        expect(children.childCount).toBe(2);
        expect(children.lastChild!.eq(firstItem.lastChild!.firstChild!)).toBe(
          true,
        );
        expect(children.firstChild!.childCount).toBe(1);
        const paragraph = children.firstChild!.firstChild!;
        expect(paragraph.type.name).toBe("paragraph");
        expect(paragraph.textContent).toBe("");
        expect(editor.state.selection.$from.parent).toBe(paragraph);
        expect(editor.state.selection.$from.parentOffset).toBe(0);
        expect(adapter.vimSnapshot.mode).toBe("insert");
        editor.state.doc.check();
        const after = editor.state.doc;
        key(editor, "Escape");
        key(editor, "u");
        expect(editor.state.doc.eq(before)).toBe(true);
        key(editor, "r", { ctrlKey: true });
        expect(editor.state.doc.eq(after)).toBe(true);
      }
    },
  );

  it.each(["Ctrl-Enter", "o"])(
    "preserves the display order of multiple child lists and trailing blocks with %s",
    async (opening) => {
      const { editor } = await harness([
        {
          type: "orderedList",
          attrs: { start: 4 },
          content: [
            item(
              p("parent"),
              list(item(p("child"))),
              p("continuation"),
              {
                type: "orderedList",
                attrs: { start: 9 },
                content: [item(p("other child"))],
              },
              code("tail"),
            ),
            item(p("sibling")),
          ],
        },
      ]);
      if (opening === "o") key(editor, "Escape");
      editor.commands.setTextSelection(position(editor, "parent"));
      const before = editor.state.doc;
      if (opening === "o") key(editor, "o");
      else key(editor, "Enter", { ctrlKey: true });
      const outer = editor.state.doc.firstChild!;
      expect(outer.attrs).toEqual(before.firstChild!.attrs);
      expect(outer.childCount).toBe(2);
      expect(
        outer.firstChild!.content.content.map((block) => block.type.name),
      ).toEqual([
        "paragraph",
        "bulletList",
        "paragraph",
        "orderedList",
        "codeBlock",
      ]);
      for (const index of [0, 2, 3, 4]) {
        expect(
          outer
            .firstChild!.child(index)
            .eq(before.firstChild!.firstChild!.child(index)),
        ).toBe(true);
      }
      const children = outer.firstChild!.child(1);
      expect(children.childCount).toBe(2);
      expect(children.attrs).toEqual(
        before.firstChild!.firstChild!.child(1).attrs,
      );
      expect(children.firstChild!.textContent).toBe("");
      expect(
        children.lastChild!.eq(
          before.firstChild!.firstChild!.child(1).firstChild!,
        ),
      ).toBe(true);
      expect(editor.state.doc.textContent).toBe(before.textContent);
      expect(outer.lastChild!.eq(before.firstChild!.lastChild!)).toBe(true);
      editor.state.doc.check();
    },
  );

  it("creates a new item rather than reusing an empty next sibling", async () => {
    const { editor } = await harness([list(item(p()), item(p()))]);
    editor.commands.setTextSelection(3);
    const oldFirst = editor.state.doc.firstChild!.firstChild!;
    const oldNext = editor.state.doc.firstChild!.lastChild!;
    key(editor, "Enter", { ctrlKey: true });
    const result = editor.state.doc.firstChild!;
    expect(result.childCount).toBe(3);
    expect(result.firstChild!.eq(oldFirst)).toBe(true);
    expect(result.lastChild!.eq(oldNext)).toBe(true);
    expect(result.child(1).attrs.blockId).not.toBe(oldFirst.attrs.blockId);
    expect(result.child(1).attrs.blockId).not.toBe(oldNext.attrs.blockId);
  });

  it.each(["bulletList", "orderedList"])(
    "puts copied list items first in an existing child %s without moving descendants",
    async (listType) => {
      const { editor, adapter } = await harness([
        list(
          item(p("copy"), list(item(p("copied child")))),
          item(
            code("target"),
            {
              type: listType,
              attrs: { start: 7 },
              content: [item(p("existing child")), item(p("second child"))],
            },
            p("tail"),
          ),
          item(p("next")),
        ),
      ]);
      key(editor, "Escape");
      editor.commands.setTextSelection(position(editor, "copy"));
      key(editor, "V");
      key(editor, "j");
      key(editor, "y");
      expect(adapter.vimSnapshot.register).toBe("ListItem: copy copied child");
      editor.commands.setTextSelection(position(editor, "target"));
      const before = editor.state.doc;
      expect(key(editor, "p").defaultPrevented).toBe(true);
      const outer = editor.state.doc.firstChild!;
      expect(outer.childCount).toBe(3);
      const parent = outer.child(1);
      expect(parent.attrs).toEqual(before.firstChild!.child(1).attrs);
      expect(
        parent.firstChild!.eq(before.firstChild!.child(1).firstChild!),
      ).toBe(true);
      expect(parent.lastChild!.eq(before.firstChild!.child(1).lastChild!)).toBe(
        true,
      );
      const children = parent.child(1);
      const oldChildren = before.firstChild!.child(1).child(1);
      expect(children.attrs).toEqual(oldChildren.attrs);
      expect(children.type.name).toBe(listType);
      expect(children.childCount).toBe(3);
      expect(children.firstChild!.textContent).toBe("copycopied child");
      expect(children.firstChild!.lastChild!.type.name).toBe("bulletList");
      expect(children.firstChild!.attrs.blockId).not.toBe(
        outer.firstChild!.attrs.blockId,
      );
      expect(children.child(1).eq(oldChildren.child(0))).toBe(true);
      expect(children.child(2).eq(oldChildren.child(1))).toBe(true);
      const after = editor.state.doc;
      editor.state.doc.check();
      key(editor, "u");
      expect(editor.state.doc.eq(before)).toBe(true);
      key(editor, "r", { ctrlKey: true });
      expect(editor.state.doc.eq(after)).toBe(true);
    },
  );

  it("keeps P before the owning item and characterwise p inside its text", async () => {
    const { editor } = await harness([
      list(item(p("copy")), item(p("target"), list(item(p("child"))))),
    ]);
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "copy"));
    key(editor, "y");
    key(editor, "y");
    editor.commands.setTextSelection(position(editor, "target"));
    key(editor, "P");
    expect(
      editor.state.doc.firstChild!.content.content.map(
        (node) => node.textContent,
      ),
    ).toEqual(["copy", "copy", "targetchild"]);
    editor.commands.setTextSelection(position(editor, "target"));
    key(editor, "v");
    key(editor, "y");
    key(editor, "p");
    expect(
      editor.state.doc.firstChild!.lastChild!.firstChild!.textContent,
    ).toBe("ttarget");
    expect(editor.state.doc.firstChild!.lastChild!.lastChild!.childCount).toBe(
      1,
    );
  });

  it("does not create a sibling during IME composition", async () => {
    const { editor } = await harness([list(item(p("inside")))]);
    editor.commands.setTextSelection(position(editor, "inside"));
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const before = editor.state.doc;
    key(editor, "Enter", { ctrlKey: true, isComposing: true });
    expect(editor.state.doc.eq(before)).toBe(true);
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "inside" }),
    );
  });

  it.each([
    "codeBlock",
    "sourceBlock",
    "blockquote",
    "alert",
    "table",
    "image",
    "horizontalRule",
  ] as const)(
    "replaces the first / paragraph with %s without a filler paragraph",
    async (target) => {
      const { editor } = await harness([list(item(p("/"), p("tail")))]);
      const original = editor.state.doc.firstChild!.firstChild!;
      const blockId = String(original.firstChild!.attrs.blockId);
      const result = runBlockTransformCommand(editor.view, {
        name: "block.transform",
        payload: { blockId, target, consumeSlash: true },
      });
      expect(result.changed).toBe(true);
      const changed = editor.state.doc.firstChild!.firstChild!;
      expect(changed.attrs.blockId).toBe(original.attrs.blockId);
      expect(changed.childCount).toBe(2);
      expect(changed.firstChild!.type.name).toBe(
        target === "alert" ? "blockquote" : target,
      );
      expect(changed.firstChild!.attrs.blockId).toBe(blockId);
      expect(changed.lastChild!.textContent).toBe("tail");
      editor.state.doc.check();
    },
  );

  it("inserts attachments in the item and Alt-Enter after an atomic first block", async () => {
    const { editor } = await harness([list(item(p(), p("tail")))]);
    editor.commands.setTextSelection(3);
    const id = createUuidV7();
    expect(
      insertAttachmentBlocks(editor.view, [
        {
          attachmentId: id,
          originalFilename: "file.pdf",
          previewable: false,
        } as AttachmentMetadata,
      ]).changed,
    ).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.doc.firstChild!.firstChild!.firstChild!.type.name).toBe(
      "attachment",
    );
    key(editor, "Enter", { altKey: true });
    expect(
      editor.state.doc.firstChild!.firstChild!.content.content.map(
        (node) => node.type.name,
      ),
    ).toEqual(["attachment", "paragraph", "paragraph"]);
    editor.state.doc.check();
  });

  it("treats hard breaks as logical lines and does not delete other blocks or descendants", async () => {
    const paragraph = {
      type: "paragraph",
      content: [
        { type: "text", text: "first" },
        { type: "hardBreak" },
        { type: "text", text: "second" },
      ],
    };
    const { editor, adapter } = await harness([
      list(item(paragraph, p("tail"), list(item(p("child"))))),
    ]);
    expect(
      semantics
        .logicalLines(editor.view)
        .map((line) => editor.state.doc.textBetween(line.from, line.to)),
    ).toEqual(["first", "second", "tail", "child"]);
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "first"));
    key(editor, "d");
    key(editor, "d");
    expect(editor.state.doc.textContent).toBe("secondtailchild");
    key(editor, "u");
    expect(editor.state.doc.textContent).toBe("firstsecondtailchild");
    editor.commands.setTextSelection(position(editor, "tail"));
    key(editor, "V");
    key(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ListItem: tail");
    key(editor, "p");
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(
      editor.state.doc.firstChild!.firstChild!.lastChild!.firstChild!
        .textContent,
    ).toBe("tail");
    editor.commands.setTextSelection(position(editor, "tail"));
    key(editor, "V");
    key(editor, "d");
    expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe(
      "firstsecondtailchild",
    );
    editor.state.doc.check();
  });

  it.each(["X\nY", "X\r\nY\r\n", "X\n\nY\n"])(
    "pastes ordinary text as siblings with tail preservation: %j",
    async (text) => {
      const { editor } = await harness([list(item(p("abcd"), code("tail")))]);
      editor.commands.setTextSelection(position(editor, "abcd") + 2);
      expect(paste(editor, { "text/plain": text }).defaultPrevented).toBe(true);
      const expected = text.includes("\n\n")
        ? ["abX", "", "Ycdtail"]
        : ["abX", "Ycdtail"];
      expect(
        editor.state.doc.firstChild!.content.content.map(
          (node) => node.textContent,
        ),
      ).toEqual(expected);
      editor.state.doc.check();
    },
  );

  it("uses preferred native plain text for Insert paste", async () => {
    const { editor } = await harness([list(item(p("ab")))], {
      availableTypes: ["text/plain"],
      plain: "X\nY\n",
      internal: null,
      markdown: null,
    });
    editor.commands.setTextSelection(position(editor, "ab") + 1);
    paste(editor, { "text/plain": "webview fallback" });
    await vi.waitFor(() =>
      expect(editor.state.doc.firstChild!.childCount).toBe(2),
    );
    expect(
      editor.state.doc.firstChild!.content.content.map(
        (node) => node.textContent,
      ),
    ).toEqual(["aX", "Yb"]);
  });

  it.each<Record<string, string>>([
    { "text/markdown": "```js\ncode\n```\n\n> quote" },
    {
      "text/html":
        "<pre><code>code</code></pre><blockquote><p>quote</p></blockquote>",
    },
  ])(
    "pastes explicitly structured blocks into the current item: %j",
    async (formats) => {
      const { editor } = await harness([list(item(p(), p("tail")))]);
      editor.commands.setTextSelection(3);
      paste(editor, { "text/plain": "code\nquote", ...formats });
      expect(editor.state.doc.firstChild!.childCount).toBe(1);
      expect(
        editor.state.doc.firstChild!.firstChild!.content.content.map(
          (node) => node.type.name,
        ),
      ).toEqual(["codeBlock", "blockquote", "paragraph"]);
      expect(editor.state.doc.textContent).toBe("codequotetail");
      editor.state.doc.check();
    },
  );

  it("puts an external rich block inside the item in Normal mode", async () => {
    const { editor } = await harness([list(item(p("first"), p("tail")))], {
      availableTypes: ["text/markdown", "text/plain"],
      plain: "code",
      internal: null,
      markdown: "```js\ncode\n```",
    });
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "first"));
    key(editor, "p");
    await vi.waitFor(() =>
      expect(editor.state.doc.firstChild!.firstChild!.childCount).toBe(3),
    );
    expect(
      editor.state.doc.firstChild!.firstChild!.content.content.map(
        (node) => node.type.name,
      ),
    ).toEqual(["paragraph", "codeBlock", "paragraph"]);
    expect(editor.state.doc.textContent).toBe("firstcodetail");
    editor.state.doc.check();
  });

  it("indents an item only once when several of its logical lines are selected", async () => {
    const { editor } = await harness([
      list(item(p("first")), item(p("one"), p("two"), code("three"))),
    ]);
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "one"));
    key(editor, "V");
    key(editor, "j");
    key(editor, ">");
    const outer = editor.state.doc.firstChild!;
    expect(outer.childCount).toBe(1);
    expect(
      outer.firstChild!.lastChild!.firstChild!.content.content.map(
        (node) => node.textContent,
      ),
    ).toEqual(["one", "two", "three"]);
    expect(editor.state.doc.textContent).toBe("firstonetwothree");
    editor.state.doc.check();
  });

  it("preserves preorder when outdenting a nested item before later blocks", async () => {
    const { editor } = await harness([
      list(
        item(
          p("parent"),
          list(item(code("child")), item(p("sibling"))),
          p("tail"),
        ),
      ),
    ]);
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "child"));
    key(editor, "<");
    key(editor, "<");
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.textContent).toBe("parentchildsiblingtail");
    expect(editor.state.doc.firstChild!.lastChild!.lastChild!.textContent).toBe(
      "tail",
    );
    editor.state.doc.check();
  });

  it("indents lists inside a quote without moving them outside its wrapper", async () => {
    const { editor } = await harness([
      list(
        item({
          type: "blockquote",
          content: [list(item(code("first")), item(code("second")))],
        }),
      ),
    ]);
    key(editor, "Escape");
    editor.commands.setTextSelection(position(editor, "second"));
    key(editor, ">");
    key(editor, ">");
    let quoteList =
      editor.state.doc.firstChild!.firstChild!.firstChild!.firstChild!;
    expect(quoteList.childCount).toBe(1);
    expect(quoteList.firstChild!.lastChild!.firstChild!.textContent).toBe(
      "second",
    );
    key(editor, "<");
    key(editor, "<");
    quoteList =
      editor.state.doc.firstChild!.firstChild!.firstChild!.firstChild!;
    expect(quoteList.childCount).toBe(2);
    expect(editor.state.doc.textContent).toBe("firstsecond");
    editor.state.doc.check();
  });

  it.each(["p", "P"])(
    "uses external plain text for Normal %s and restores its cursor on Undo",
    async (put) => {
      const clipboard = {
        availableTypes: ["text/plain"],
        plain: "X\nY\n",
        internal: null,
        markdown: null,
      };
      const { editor, adapter } = await harness(
        [list(item(p("ab")))],
        clipboard,
      );
      key(editor, "Escape");
      const before = position(editor, "ab");
      editor.commands.setTextSelection(before);
      key(editor, put);
      await vi.waitFor(() =>
        expect(
          editor.state.doc.firstChild!.childCount,
          JSON.stringify(adapter.vimSnapshot),
        ).toBe(2),
      );
      expect(
        editor.state.doc.firstChild!.content.content.map(
          (node) => node.textContent,
        ),
      ).toEqual(put === "p" ? ["aX", "Yb"] : ["X", "Yab"]);
      expect(
        editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.from + 1,
        ),
      ).toBe("Y");
      key(editor, "u");
      expect(editor.state.doc.textContent).toBe("ab");
      expect(editor.state.selection.from).toBe(before);
    },
  );

  it("round trips mixed rich item blocks through Markdown, including a non-paragraph first block", async () => {
    const { editor } = await harness([p()]);
    const source = [
      "- > [!TIP]",
      "  > **quote**",
      "",
      "  first  ",
      "  second",
      "",
      "  ```js",
      "  const a = 1;",
      "  ```",
      "",
      "  | a | b |",
      "  | --- | --- |",
      "  | c | d |",
      "",
      "  ![image](https://example.com/image.png)",
      "",
      "  - child",
      "",
      "  last paragraph",
      "- sibling",
    ].join("\n");
    const parsed = parseMarkdownPaste(source, editor.schema)!;
    expect(parsed.sourceBlockCount).toBe(0);
    const listNode = parsed.slice.content.firstChild!;
    expect(
      listNode.firstChild!.content.content.map((node) => node.type.name),
    ).toEqual([
      "blockquote",
      "paragraph",
      "codeBlock",
      "table",
      "image",
      "bulletList",
      "paragraph",
    ]);
    expect(listNode.firstChild!.child(1).child(1).type.name).toBe("hardBreak");
    const markdown = encodeVimClipboard(
      {
        kind: "structure",
        text: source,
        structureKind: "block",
        nodeNames: parsed.nodeNames,
        slice: new Slice(Fragment.from(listNode), 0, 0),
      },
      editor.schema,
    )[MARKDOWN_CLIPBOARD_MIME];
    const again = parseMarkdownPaste(markdown, editor.schema)!;
    const stripIds = (node: JSONContent): JSONContent => ({
      type: node.type,
      text: node.text,
      marks: node.marks,
      content: node.content?.map(stripIds),
    });
    expect(stripIds(again.slice.content.firstChild!.toJSON())).toEqual(
      stripIds(listNode.toJSON()),
    );
    again.slice.content.firstChild!.check();
  });

  it("reloads rich item content with all block identities intact", async () => {
    const { editor, runtime, persistence } = await harness([
      list(item(code("code"), p("second"), list(item(p("nested"))), p("tail"))),
    ]);
    editor.commands.setTextSelection(position(editor, "code"));
    await runtime.flush();
    const original = editor.getJSON();
    const reopened = await CoreRuntime.open(persistence);
    const element = document.createElement("div");
    document.body.append(element);
    const binding = reopened.editorForTesting("window-1", element);
    cleanups.push(async () => {
      await reopened.flush();
      binding.adapter.destroy();
      reopened.destroy();
      element.remove();
    });
    expect(binding.editor.getJSON()).toEqual(original);
    binding.editor.state.doc.check();
  });
});
