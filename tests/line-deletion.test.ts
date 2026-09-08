import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { parseMarkdownNote } from "../app/src/editor/markdown-paste";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const p = (text = ""): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
const code = (type: string, text = ""): JSONContent => ({
  type,
  content: text ? [{ type: "text", text }] : [],
});
const quote = (...content: JSONContent[]): JSONContent => ({
  type: "blockquote",
  content,
});
const details = (title: string, ...content: JSONContent[]): JSONContent => ({
  type: "details",
  content: [
    { ...p(title), type: "detailsSummary" },
    { type: "detailsBody", content },
  ],
});
const item = (...content: JSONContent[]): JSONContent => ({
  type: "listItem",
  content,
});
const list = (...content: JSONContent[]): JSONContent => ({
  type: "bulletList",
  content,
});

function key(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}

function position(editor: Editor, type: string, text?: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (
      found < 0 &&
      node.type.name === type &&
      (text === undefined || node.textContent === text)
    )
      found = pos + 1;
  });
  if (found < 0) throw new Error(`Missing ${type}: ${text}`);
  return found;
}

function count(editor: Editor, type: string): number {
  let found = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === type) found++;
  });
  return found;
}

async function harness(content: JSONContent[], sectionModel = false) {
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root, {
    directBodyOnly: !sectionModel,
  });
  cleanups.push(() => {
    binding.adapter.destroy();
    runtime.destroy();
    root.remove();
  });
  const { editor } = binding;
  if (sectionModel) {
    const parsed = parseMarkdownNote(
      "# Note\n\nplaceholder",
      editor.schema,
      editor.state.doc.firstChild!.attrs.sectionId,
    )!.root.toJSON();
    parsed.content[1].content[0].content = content;
    editor.commands.setContent(parsed);
  } else editor.commands.setContent({ type: "doc", content });
  editor.commands.focus();
  key(editor, "Escape");
  await runtime.flush();
  return { ...binding, runtime };
}

function deleteLines(editor: Editor, command: string, lines = 1) {
  if (command === "dd") {
    if (lines > 1) key(editor, String(lines));
    key(editor, "d");
  } else {
    key(editor, "V");
    for (let index = 1; index < lines; index++) key(editor, "j");
  }
  key(editor, "d");
}

describe.each(["dd", "V d"])("empty block removal with %s", (command) => {
  it.each([
    {
      name: "empty Code",
      block: code("codeBlock"),
      target: "codeBlock",
      removed: "codeBlock",
    },
    {
      name: "last Code line",
      block: code("codeBlock", "本文"),
      target: "codeBlock",
      removed: "codeBlock",
    },
    {
      name: "empty Source",
      block: code("sourceBlock"),
      target: "sourceBlock",
      removed: "sourceBlock",
    },
    {
      name: "last Source line",
      block: code("sourceBlock", "本文"),
      target: "sourceBlock",
      removed: "sourceBlock",
    },
    {
      name: "empty Quote",
      block: quote(p()),
      target: "paragraph",
      removed: "blockquote",
    },
    {
      name: "last Quote paragraph",
      block: quote(p("本文")),
      target: "paragraph",
      removed: "blockquote",
    },
    {
      name: "Alert",
      block: {
        ...quote(p("本文")),
        attrs: { alertType: "warning", alertTitle: "注意" },
      },
      target: "paragraph",
      removed: "blockquote",
    },
    {
      name: "nested Quote with Code",
      block: quote(quote(code("codeBlock", "本文"))),
      target: "codeBlock",
      removed: "blockquote",
    },
    {
      name: "untitled Details",
      block: details("", p("本文")),
      target: "paragraph",
      removed: "details",
    },
    {
      name: "last Table row",
      block: {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [p("本文")] }],
          },
        ],
      },
      target: "paragraph",
      removed: "table",
    },
    {
      name: "empty Table",
      block: {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [p()] }],
          },
        ],
      },
      target: "paragraph",
      removed: "table",
    },
  ])(
    "removes $name and restores it with one undo",
    async ({ block, target, removed }) => {
      const { editor, adapter, runtime } = await harness(
        [block, p("after")],
        true,
      );
      const before = editor.state.doc;
      editor.commands.setTextSelection(position(editor, target));
      deleteLines(editor, command);
      expect(adapter.vimSnapshot.mode).toBe("normal");
      expect(count(editor, removed)).toBe(0);
      expect(editor.state.doc.textContent).toBe("Noteafter");
      expect(editor.state.selection.$from.parent.textContent).toBe("after");
      editor.state.doc.check();
      await runtime.flush();
      const after = editor.state.doc;
      key(editor, "u");
      expect(editor.state.doc.eq(before)).toBe(true);
      key(editor, "r", { ctrlKey: true });
      expect(editor.state.doc.eq(after)).toBe(true);
    },
  );

  it.each(["codeBlock", "sourceBlock"])(
    "removes only the selected %s lines until its content is empty",
    async (type) => {
      const { editor } = await harness([
        code(type, "first\nsecond\nthird"),
        p("after"),
      ]);
      editor.commands.setTextSelection(position(editor, type));
      deleteLines(editor, command, 2);
      expect(editor.state.doc.firstChild!.type.name).toBe(type);
      expect(editor.state.doc.firstChild!.textContent).toBe("third");
      editor.commands.setTextSelection(position(editor, type));
      deleteLines(editor, command);
      expect(count(editor, type)).toBe(0);
      expect(editor.state.doc.textContent).toBe("after");
    },
  );

  it("keeps unselected text, images, siblings and titled Details", async () => {
    const { editor } = await harness([
      quote(p("remove"), p("keep")),
      quote(p("remove image sibling"), {
        type: "image",
        attrs: { src: "/image-stub.svg", attachmentId: "fixture-image" },
      }),
      details("Summary", code("sourceBlock", "remove source")),
      code("sourceBlock"),
      p("after"),
    ]);
    for (const text of ["remove", "remove image sibling"]) {
      editor.commands.setTextSelection(position(editor, "paragraph", text));
      deleteLines(editor, command);
    }
    editor.commands.setTextSelection(
      position(editor, "sourceBlock", "remove source"),
    );
    deleteLines(editor, command);
    expect(count(editor, "blockquote")).toBe(2);
    expect(count(editor, "image")).toBe(1);
    expect(count(editor, "details")).toBe(1);
    expect(count(editor, "sourceBlock")).toBe(1);
    expect(editor.state.doc.textContent).toBe("keepSummaryafter");
    editor.state.doc.check();
  });

  it("keeps an unselected empty Table row", async () => {
    const { editor } = await harness([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [p("remove")] }],
          },
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [p()] }],
          },
        ],
      },
      p("after"),
    ]);
    editor.commands.setTextSelection(position(editor, "paragraph", "remove"));
    deleteLines(editor, command);
    expect(count(editor, "table")).toBe(1);
    expect(count(editor, "tableRow")).toBe(1);
    editor.state.doc.check();
  });

  it.each(["codeBlock", "sourceBlock"])(
    "removes empty %s within a ListItem without removing descendants",
    async (type) => {
      const { editor } = await harness([
        list(item(code(type), list(item(p("child")))), item(p("sibling"))),
        p("after"),
      ]);
      editor.commands.setTextSelection(position(editor, type));
      deleteLines(editor, command);
      expect(count(editor, type)).toBe(0);
      expect(editor.state.doc.textContent).toBe("childsiblingafter");
      expect(
        editor.state.doc.firstChild!.firstChild!.firstChild!.textContent,
      ).toBe("child");
      editor.state.doc.check();
    },
  );

  it("keeps a nonempty Details Summary after deleting its last body block in a list", async () => {
    const { editor } = await harness([
      list(item(details("Summary", code("sourceBlock", "remove")), p("tail"))),
      p("after"),
    ]);
    editor.commands.setTextSelection(position(editor, "sourceBlock"));
    deleteLines(editor, command);
    expect(count(editor, "sourceBlock")).toBe(0);
    expect(count(editor, "details")).toBe(1);
    expect(editor.state.doc.textContent).toBe("Summarytailafter");
    editor.state.doc.check();
  });

  it("removes the emptied Quote around a deleted list", async () => {
    const { editor } = await harness([
      quote(list(item(p("remove")))),
      p("after"),
    ]);
    editor.commands.setTextSelection(position(editor, "paragraph", "remove"));
    deleteLines(editor, command);
    expect(count(editor, "blockquote")).toBe(0);
    expect(count(editor, "bulletList")).toBe(0);
    expect(editor.state.doc.textContent).toBe("after");
    editor.state.doc.check();
  });

  it.each([true, false])(
    "cleans blocks in a mixed selection with the list first=%s",
    async (listFirst) => {
      const block = code("sourceBlock");
      const selectedList = list(item(p("remove")));
      const { editor } = await harness([
        quote(...(listFirst ? [selectedList, block] : [block, selectedList])),
        p("after"),
      ]);
      const before = editor.state.doc;
      editor.commands.setTextSelection(
        listFirst
          ? position(editor, "paragraph", "remove")
          : position(editor, "sourceBlock"),
      );
      deleteLines(editor, command, 2);
      expect(count(editor, "sourceBlock")).toBe(0);
      expect(count(editor, "blockquote")).toBe(0);
      expect(editor.state.doc.textContent).toBe("after");
      editor.state.doc.check();
      key(editor, "u");
      expect(editor.state.doc.eq(before)).toBe(true);
    },
  );

  it("preserves the unselected Code suffix in a mixed selection", async () => {
    const { editor } = await harness([
      list(item(p("remove"))),
      code("codeBlock", "first\nsecond\nkeep"),
      p("after"),
    ]);
    editor.commands.setTextSelection(position(editor, "paragraph", "remove"));
    deleteLines(editor, command, 3);
    expect(count(editor, "bulletList")).toBe(0);
    expect(editor.state.doc.firstChild!.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild!.textContent).toBe("keep");
    editor.state.doc.check();
  });

  it("leaves a valid input line when the last body block is removed", async () => {
    const { editor } = await harness([code("sourceBlock")], true);
    const title = editor.state.doc.firstChild;
    editor.commands.setTextSelection(position(editor, "sourceBlock"));
    deleteLines(editor, command);
    expect(count(editor, "sourceBlock")).toBe(0);
    expect(editor.state.doc.firstChild).toBe(title);
    expect(editor.state.selection.$from.parent.inlineContent).toBe(true);
    editor.state.doc.check();
  });
});

it.each(["cc", "V c"])(
  "keeps an empty Code Block as an input target for %s",
  async (command) => {
    const { editor, adapter } = await harness([
      code("codeBlock", "text"),
      p("after"),
    ]);
    editor.commands.setTextSelection(position(editor, "codeBlock"));
    key(editor, command === "cc" ? "c" : "V");
    key(editor, "c");
    expect(count(editor, "codeBlock")).toBe(1);
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("replacement");
    expect(editor.state.doc.firstChild!.textContent).toBe("replacement");
  },
);
