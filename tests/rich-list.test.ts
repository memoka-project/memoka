import type { Editor, JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
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
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.lastChild!.type.name).toBe("paragraph");
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

  it("exits the whole outer list from code inside a nested quote", async () => {
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
    ).toEqual(["bulletList", "paragraph", "paragraph"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("");
    expect(editor.state.doc.lastChild!.textContent).toBe("existing");
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
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.lastChild!.textContent).toBe("tail");
    editor.commands.setTextSelection(position(editor, "tail"));
    key(editor, "V");
    key(editor, "d");
    expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe(
      "firstsecondchild",
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
