import { Editor } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import {
  createNoteDocument,
  encodeProductDocument,
  loadProductDocument,
  readNotePlainText,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { renderSectionMarkdown } from "../app/src/core/section-markdown-backup";
import {
  productEditorExtensions,
  productMarkdownImportSchema,
} from "../app/src/editor/extensions";
import {
  detailsFoldHiddenEntries,
  runDetailsFoldCommand,
} from "../app/src/editor/details";
import {
  parseMarkdownNote,
  parseMarkdownPaste,
} from "../app/src/editor/markdown-paste";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { runBlockTransformCommand } from "../app/src/vim/block-transform";
import {
  runEditorExitBlock,
  runEditorInsertEnter,
  runEditorVimCommand,
} from "../app/src/vim/editor-commands";
import { deriveNoteSearchProjection } from "../app/src/core/note-search";
import { sanitizeExternalHtml } from "../app/src/editor/html-paste";
import { encodeVimClipboard } from "../app/src/vim/clipboard";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";

const schema = productMarkdownImportSchema();
const markdown = `<details>\n<summary>日本語 <strong>詳細</strong>と<code>a_b</code></summary>\n\n本文\n\n- 項目\n\n\`\`\`js\nconst example = '</details>';\n\`\`\`\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<details open>\n<summary>入れ子</summary>\n\n内側の本文\n\n</details>\n\n</details>`;

function inList(source: string): string {
  return `- 外側\n\n${source
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n\n  項目末尾\n\n- 次の項目`;
}

function harness(source = markdown) {
  const note = createNoteDocument(createUuidV7());
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: productEditorExtensions(note),
  });
  const parsed = parseMarkdownNote(
    `# ノート\n\n${source}\n\n後続`,
    editor.schema,
    note.noteId,
  )!;
  editor.commands.setContent(parsed.root.toJSON());
  const position = (text: string) => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text?.includes(text))
        found = pos + node.text.indexOf(text);
    });
    if (found < 0) throw new Error(`Missing ${text}`);
    return found;
  };
  const select = (text: string) =>
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, position(text)),
      ),
    );
  const destroy = () => {
    editor.destroy();
    note.doc.destroy();
    element.remove();
  };
  return { note, editor, position, select, destroy };
}

describe("Details blocks", () => {
  it("leaves an empty Summary blank without placeholder text", () => {
    const { editor, destroy } = harness(
      "<details open>\n<summary></summary>\n\n本文\n\n</details>",
    );
    try {
      const summary = editor.view.dom.querySelector(".memoka-details-summary")!;
      expect(summary.hasAttribute("data-placeholder")).toBe(false);
      expect(summary.textContent).not.toContain("詳細");
      expect(editor.getHTML()).not.toContain('data-placeholder="詳細"');
    } finally {
      destroy();
    }
  });

  it.each([
    "list",
    "nested list",
    "code in list",
    "list in outer ListItem",
    "list in nested Details",
  ])(
    "exits the entire list into a new Details body paragraph with Ctrl-Enter: %s",
    async (variant) => {
      const runtime = await CoreRuntime.open(new MemoryPersistencePort());
      const element = document.createElement("div");
      document.body.append(element);
      const { editor, adapter } = runtime.editorForTesting(
        "window-1",
        element,
        { directBodyOnly: false },
      );
      try {
        const listBody =
          variant === "nested list"
            ? "- 親項目\n  - 現在項目\n  - 子の後続\n- 兄弟項目"
            : variant === "code in list"
              ? "- 親項目\n\n  ```\n  現在項目\n  ```\n\n- 兄弟項目"
              : "- 現在項目\n- 兄弟項目";
        let source = `<details open>\n<summary>対象</summary>\n\n${listBody}\n\n既存段落\n\n</details>`;
        if (variant === "list in outer ListItem") source = inList(source);
        if (variant === "list in nested Details")
          source = `<details open>\n<summary>外側</summary>\n\n${source}\n\n外側の末尾\n\n</details>`;
        editor.commands.setContent(
          parseMarkdownNote(
            `# Note\n\n${source}`,
            editor.schema,
            editor.state.doc.firstChild!.attrs.sectionId,
          )!.root.toJSON(),
        );
        let cursor = -1;
        editor.state.doc.descendants((node, position) => {
          if (node.isText && node.text?.includes("現在項目"))
            cursor = position + node.text.indexOf("現在項目");
        });
        expect(cursor).toBeGreaterThan(0);
        editor.commands.setTextSelection(cursor);
        editor.commands.focus();
        const before = editor.state.doc;
        const $before = editor.state.selection.$from;
        let bodyDepth = $before.depth;
        while (
          bodyDepth > 0 &&
          $before.node(bodyDepth).type.name !== "detailsBody"
        )
          bodyDepth--;
        const body = $before.node(bodyDepth);
        expect(body.firstChild!.type.name).toBe("bulletList");
        expect(body.childCount).toBe(2);
        const press = (key: string, options: KeyboardEventInit = {}) =>
          editor.view.dom.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
              ...options,
            }),
          );
        press("Enter", { ctrlKey: true });
        expect(adapter.vimSnapshot.mode).toBe("insert");
        const { $from } = editor.state.selection;
        expect($from.node($from.depth - 1).type.name).toBe("detailsBody");
        const afterBody = $from.node($from.depth - 1);
        expect(afterBody.childCount).toBe(3);
        expect(afterBody.child(0).eq(body.child(0))).toBe(true);
        expect(afterBody.child(2).eq(body.child(1))).toBe(true);
        expect(afterBody.child(1)).toBe($from.parent);
        expect($from.parent.textContent).toBe("");
        expect($from.parentOffset).toBe(0);
        editor.state.doc.check();
        const after = editor.state.doc;
        press("Escape");
        press("u");
        expect(editor.state.doc.eq(before)).toBe(true);
        press("r", { ctrlKey: true });
        expect(editor.state.doc.eq(after)).toBe(true);
      } finally {
        adapter.destroy();
        runtime.destroy();
        element.remove();
      }
    },
  );

  it.each([
    { text: "先頭", cursor: "先頭", expected: ["先頭", "追加"] },
    {
      text: "先頭\n\n末尾",
      cursor: "先頭",
      expected: ["先頭", "追加", "末尾"],
    },
    {
      text: "先頭\n\n末尾",
      cursor: "末尾",
      expected: ["先頭", "末尾", "追加"],
    },
  ])(
    "opens the next paragraph inside Details after $cursor in $text",
    ({ text, cursor, expected }) => {
      for (const wrapper of ["none", "details", "list"]) {
        const details = `<details open>\n<summary>詳細</summary>\n\n${text}\n\n</details>`;
        const source =
          wrapper === "details"
            ? `<details open>\n<summary>外側</summary>\n\n${details}\n\n</details>`
            : wrapper === "list"
              ? inList(details)
              : details;
        const { editor, select, destroy } = harness(source);
        try {
          select(cursor);
          const { $from } = editor.state.selection;
          const bodyDepth = $from.depth - 1;
          expect($from.node(bodyDepth).type.name).toBe("detailsBody");
          const bodyId = $from.node(bodyDepth).attrs.blockId;
          const result = runEditorVimCommand(
            editor.view,
            "line.open-below",
            "normal",
            null,
          );
          expect(result.handled).toBe(true);
          expect(result.nextMode).toBe("insert");
          editor.commands.insertContent("追加");
          const body = editor.state.selection.$from.node(bodyDepth);
          expect(body?.type.name, wrapper).toBe("detailsBody");
          expect(body.attrs.blockId).toBe(bodyId);
          expect(body.content.content.map((node) => node.textContent)).toEqual(
            expected,
          );
          editor.state.doc.check();
        } finally {
          destroy();
        }
      }
    },
  );

  it.each([
    {
      body: "```js\n先頭\n末尾\n```",
      type: "codeBlock",
      expected: "先頭\n追加\n末尾",
    },
    { body: "- 先頭\n- 末尾", type: "bulletList", expected: "先頭追加末尾" },
    {
      body: "| 先頭 | B |\n| --- | --- |\n| C | D |",
      type: "table",
      expected: "先頭B追加CD",
    },
    { body: "> 先頭\n>\n> 末尾", type: "blockquote", expected: "先頭追加末尾" },
  ])(
    "keeps $type line opening inside Details nested in a ListItem",
    ({ body, type, expected }) => {
      const { editor, select, destroy } = harness(
        inList(
          `<details open>\n<summary>詳細</summary>\n\n${body}\n\n</details>`,
        ),
      );
      try {
        select("先頭");
        expect(
          runEditorVimCommand(editor.view, "line.open-below", "normal", null)
            .handled,
        ).toBe(true);
        editor.commands.insertContent("追加");
        const { $from } = editor.state.selection;
        let bodyDepth = $from.depth;
        while (
          bodyDepth > 0 &&
          $from.node(bodyDepth).type.name !== "detailsBody"
        )
          bodyDepth--;
        expect(bodyDepth).toBeGreaterThan(0);
        const detailsBody = $from.node(bodyDepth);
        expect(detailsBody.childCount).toBe(1);
        expect(detailsBody.firstChild!.type.name).toBe(type);
        expect(detailsBody.textContent).toBe(expected);
        expect(editor.state.doc.textContent).toContain("項目末尾次の項目");
        editor.state.doc.check();
      } finally {
        destroy();
      }
    },
  );

  it("opens a line in an empty Details body with the o key and undoes opening plus typing together", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const element = document.createElement("div");
    document.body.append(element);
    const { editor, adapter } = runtime.editorForTesting("window-1", element, {
      directBodyOnly: false,
    });
    try {
      editor.commands.setContent(
        parseMarkdownNote(
          `# Note\n\n${inList("<details open>\n<summary>詳細</summary>\n\n</details>")}`,
          editor.schema,
          editor.state.doc.firstChild!.attrs.sectionId,
        )!.root.toJSON(),
      );
      let bodyPosition = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "detailsBody") bodyPosition = pos;
      });
      editor.commands.setTextSelection(bodyPosition + 2);
      editor.commands.focus();
      const press = (key: string) =>
        editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      press("Escape");
      const before = editor.state.doc;
      press("o");
      expect(adapter.vimSnapshot.mode).toBe("insert");
      const { $from } = editor.state.selection;
      expect($from.node($from.depth - 1).type.name).toBe("detailsBody");
      expect($from.node($from.depth - 1).childCount).toBe(2);
      editor.commands.insertContent("追加");
      press("Escape");
      const after = editor.state.doc;
      press("u");
      expect(editor.state.doc.eq(before)).toBe(true);
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "r",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(editor.state.doc.eq(after)).toBe(true);
    } finally {
      adapter.destroy();
      runtime.destroy();
      element.remove();
    }
  });

  it("opens the slash picker in a Details body and keeps / until confirmation", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const element = document.createElement("div");
    document.body.append(element);
    const onBlockTypePicker = vi.fn();
    const { editor, adapter } = runtime.editorForTesting("window-1", element, {
      directBodyOnly: false,
      onBlockTypePicker,
    });
    try {
      editor.commands.setContent(
        parseMarkdownNote(
          "# Note\n\n<details open>\n<summary>Details</summary>\n\n</details>",
          editor.schema,
          editor.state.doc.firstChild!.attrs.sectionId,
        )!.root.toJSON(),
      );
      let paragraph = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "paragraph") paragraph = pos + 1;
      });
      editor.commands.setTextSelection(paragraph);
      const blockId = editor.state.selection.$from.parent.attrs.blockId;
      editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, paragraph, paragraph, "/", () => editor.state.tr),
      );
      editor.commands.insertContent("/");
      await Promise.resolve();
      expect(onBlockTypePicker).toHaveBeenCalledWith({ blockId });
      expect(editor.state.selection.$from.parent.textContent).toBe("/");
    } finally {
      adapter.destroy();
      runtime.destroy();
      element.remove();
    }
  });
  it("routes Normal Enter and z commands to Details, and preserves the container through yy/p and Undo", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence);
    const element = document.createElement("div");
    document.body.append(element);
    const { editor, adapter } = runtime.editorForTesting("window-1", element, {
      directBodyOnly: false,
    });
    try {
      const rootId = editor.state.doc.firstChild!.attrs.sectionId;
      editor.commands.setContent(
        parseMarkdownNote(
          `# Note\n\n${markdown}\n\nend`,
          editor.schema,
          rootId,
        )!.root.toJSON(),
      );
      let summary = 0;
      editor.state.doc.descendants((node, pos) => {
        if (!summary && node.type.name === "detailsSummary") summary = pos + 1;
      });
      editor.commands.setTextSelection(summary);
      editor.commands.focus();
      const press = (key: string) =>
        editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
            shiftKey: /^[A-Z]$/u.test(key),
            bubbles: true,
            cancelable: true,
          }),
        );
      press("Escape");
      press("Enter");
      expect(adapter.vimSnapshot.action).toContain("details:fold-toggle");
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      let body = 0;
      editor.state.doc.descendants((node, pos) => {
        if (!body && node.isText && node.text === "本文") body = pos;
      });
      editor.commands.setTextSelection(body);
      const unchanged = editor.state.doc.toJSON();
      press("Enter");
      expect(editor.state.doc.toJSON()).toEqual(unchanged);
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      editor.commands.setTextSelection(summary);
      press("z");
      press("C");
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(2);
      press("y");
      press("y");
      press("p");
      let count = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "details") count++;
      });
      expect(count).toBe(4);
      press("u");
      count = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "details") count++;
      });
      expect(count).toBe(2);
    } finally {
      adapter.destroy();
      runtime.destroy();
      element.remove();
    }
  });

  it("folds independently in two editors sharing one NoteDoc", () => {
    const { editor, note, select, destroy } = harness();
    const other = new Editor({ extensions: productEditorExtensions(note) });
    try {
      select("日本語");
      runDetailsFoldCommand(editor.view, "open");
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      expect(detailsFoldHiddenEntries(other.state)).toHaveLength(1);
      editor.commands.insertContent("編集");
      expect(other.state.doc.textContent).toContain("編集");
      expect(detailsFoldHiddenEntries(other.state)).toHaveLength(1);
    } finally {
      other.destroy();
      destroy();
    }
  });

  it("reloads rich Details and every block identity from the persisted NoteDoc", () => {
    const { note, destroy } = harness();
    try {
      const loaded = loadProductDocument(
        "note",
        note.noteId,
        encodeProductDocument(note),
      );
      try {
        expect(loaded.kind).toBe("note");
        if (loaded.kind !== "note") throw new Error("Expected NoteDoc");
        expect(loaded.schemaVersion).toBe(6);
        expect(loaded.rootSection.toString()).toBe(note.rootSection.toString());
        expect(readNotePlainText(loaded)).toBe(readNotePlainText(note));
      } finally {
        loaded.doc.destroy();
      }
    } finally {
      destroy();
    }
  });

  it("retains Markdown-looking literal summary text and link marks through export", () => {
    const parsed = parseMarkdownPaste(
      '<details open><summary><em>foo &#42;bar&#42;</em> <a href="https://example.com/?a=1&amp;b=2">link</a></summary>\n\nbody\n\n</details>',
      schema,
    )!;
    const exported = renderSectionMarkdown(
      "Export",
      parsed.slice.content.toJSON(),
    );
    const again = parseMarkdownNote(exported, schema, createUuidV7())!;
    let summary: unknown = null;
    again.root.descendants((node) => {
      if (node.type.name === "detailsSummary") summary = node.toJSON().content;
    });
    expect(summary).toEqual(
      parsed.slice.content.firstChild!.firstChild!.toJSON().content,
    );
  });

  it("keeps malformed details as source and safely bounds nesting", () => {
    const parsed = parseMarkdownPaste(
      "<details>\n<summary>missing close</summary>",
      schema,
    )!;
    expect(parsed.sourceBlockCount).toBeGreaterThan(0);
    expect(
      parsed.slice.content.textBetween(0, parsed.slice.content.size),
    ).toContain("missing close");
    const tooDeep = `${"<details>\n<summary>x</summary>\n\n".repeat(132)}body\n\n${"</details>\n\n".repeat(132)}`;
    expect(
      parseMarkdownPaste(tooDeep, schema)?.sourceBlockCount,
    ).toBeGreaterThan(0);
  });
  it("imports nested Markdown blocks and preserves them in portable Markdown", () => {
    const parsed = parseMarkdownPaste(markdown, schema)!;
    expect(parsed.sourceBlockCount).toBe(0);
    expect(parsed.slice.content.childCount).toBe(1);
    expect(parsed.nodeNames).toEqual(
      expect.arrayContaining([
        "details",
        "detailsSummary",
        "detailsBody",
        "bulletList",
        "codeBlock",
        "table",
      ]),
    );
    const details = parsed.slice.content.firstChild!;
    expect(details.attrs.open).toBe(false);
    expect(details.firstChild!.textContent).toBe("日本語 詳細とa_b");
    expect(details.firstChild!.child(1).marks[0]?.type.name).toBe("bold");
    const exported = renderSectionMarkdown(
      "Export",
      parsed.slice.content.toJSON(),
    );
    const imported = parseMarkdownNote(exported, schema, createUuidV7())!;
    expect(imported.sourceBlockCount).toBe(0);
    expect(imported.sectionCount).toBe(1);
    expect(imported.root.textContent).toContain("内側の本文");
    expect(exported).toContain("<details open>");
    expect(exported).toContain("<strong>詳細</strong>");
  });

  it("does not turn headings inside details into Sections", () => {
    const parsed = parseMarkdownNote(
      "# Note\n\n<details>\n<summary>More</summary>\n\n## Inside\n\ntext\n\n</details>\n\n## Outside\n\nbody",
      schema,
      createUuidV7(),
    )!;
    expect(parsed.sectionCount).toBe(2);
    expect(parsed.sourceBlockCount).toBe(0);
    expect(parsed.root.textContent).toContain("## Inside");
  });

  it("imports details as a rich ListItem block", () => {
    const source = `- before\n\n  ${markdown.replaceAll("\n", "\n  ")}\n\n- after`;
    const parsed = parseMarkdownPaste(source, schema)!;
    expect(parsed.sourceBlockCount).toBe(0);
    expect(parsed.nodeNames).toContain("details");
    expect(parsed.slice.content.firstChild!.childCount).toBe(2);
    expect(
      parsed.slice.content.firstChild!.firstChild!.child(1).type.name,
    ).toBe("details");
  });

  it("round trips native HTML without retaining active HTML attributes", () => {
    const parsed = parseMarkdownPaste(markdown, schema)!;
    const wrapper = document.createElement("div");
    wrapper.append(
      DOMSerializer.fromSchema(schema).serializeFragment(parsed.slice.content),
    );
    const clean = document.createElement("div");
    clean.innerHTML = sanitizeExternalHtml(wrapper.innerHTML);
    const imported = DOMParser.fromSchema(schema).parseSlice(clean);
    expect(imported.content.firstChild!.type.name).toBe("details");
    expect(imported.content.firstChild!.attrs.open).toBe(false);
    expect(imported.content.firstChild!.textContent).toBe(
      parsed.slice.content.firstChild!.textContent,
    );
  });

  it("folds locally without editing Yjs, skips hidden lines, and reveals a search destination", () => {
    const { editor, note, select, destroy } = harness();
    try {
      select("日本語");
      const before = readNotePlainText(note);
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(1);
      expect(
        defaultVimBlockSemantics
          .logicalLines(editor.view)
          .map((line) => line.blockNodeName),
      ).not.toContain("codeBlock");
      expect(
        deriveNoteSearchProjection(note, "内側の本文").matches,
      ).toHaveLength(1);
      const undoCount = note.undoManager.undoStack.length;
      expect(
        runDetailsFoldCommand(editor.view, "open-recursive")?.changed,
      ).toBe(true);
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      expect(
        runDetailsFoldCommand(editor.view, "close-recursive")?.changed,
      ).toBe(true);
      select("内側の本文");
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      expect(readNotePlainText(note)).toBe(before);
      expect(note.undoManager.undoStack).toHaveLength(undoCount);
    } finally {
      destroy();
    }
  });

  it.each(["note-search-match", "search-match"] as const)(
    "reveals nested Details before clamping a Normal %s destination",
    async (kind) => {
      const runtime = await CoreRuntime.open(new MemoryPersistencePort());
      const element = document.createElement("div");
      document.body.append(element);
      const { editor, adapter } = runtime.editorForTesting(
        "window-1",
        element,
        {
          directBodyOnly: false,
        },
      );
      try {
        editor.commands.setContent(
          parseMarkdownNote(
            `# Note\n\n${markdown}\n\n<details>\n<summary>別の詳細</summary>\n\n別の本文\n\n</details>`,
            editor.schema,
            runtime.noteId,
          )!.root.toJSON(),
        );
        let summary = 0;
        let unrelatedSummary = 0;
        let target = 0;
        let blockId = "";
        editor.state.doc.descendants((node, pos) => {
          if (!summary && node.type.name === "detailsSummary")
            summary = pos + 1;
          if (
            node.type.name === "detailsSummary" &&
            node.textContent === "別の詳細"
          )
            unrelatedSummary = pos + 1;
          if (node.isTextblock && node.textContent === "内側の本文") {
            target = pos + 1;
            blockId = node.attrs.blockId;
          }
        });
        editor.commands.setTextSelection(unrelatedSummary);
        runDetailsFoldCommand(editor.view, "close");
        editor.commands.setTextSelection(summary);
        runDetailsFoldCommand(editor.view, "close-recursive");
        expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(3);
        const before = editor.state.doc;
        const undoDepth = runtime.noteDocument.undoManager.undoStack.length;
        const destination = {
          kind,
          noteId: runtime.noteId,
          sectionId: runtime.noteId,
          blockId,
          offset: 1,
          query: "側の本文",
          sectionLineNumber: 1,
        };
        expect(
          adapter.applyNavigationDestination(destination, "search:details", {
            focus: false,
            reveal: false,
          }),
        ).toBe("search:details");
        expect(editor.state.selection.head).toBe(target + 1);
        expect(adapter.vimSnapshot.mode).toBe("normal");
        expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(1);
        expect(editor.state.doc.eq(before)).toBe(true);
        expect(runtime.noteDocument.undoManager.undoStack).toHaveLength(
          undoDepth,
        );
      } finally {
        adapter.destroy();
        runtime.destroy();
        element.remove();
      }
    },
  );

  it("supports summary Enter, body Ctrl-Enter, and whole-block yy/dd", () => {
    const { editor, select, destroy } = harness();
    try {
      select("日本語");
      expect(runEditorInsertEnter(editor.view, false).handled).toBe(true);
      expect(editor.state.selection.$from.parent.textContent).toBe("本文");
      expect(detailsFoldHiddenEntries(editor.state)).toHaveLength(0);
      expect(runEditorExitBlock(editor.view).handled).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(
        editor.state.selection.$from.node(
          editor.state.selection.$from.depth - 1,
        ).type.name,
      ).toBe("bodyChunk");
      select("日本語");
      const result = runEditorVimCommand(
        editor.view,
        "line.yank",
        "normal",
        null,
      );
      expect(result.handled).toBe(true);
      expect(result.register?.kind).toBe("structure");
      expect(
        encodeVimClipboard(result.register!, editor.schema)["text/markdown"],
      ).toContain("<details>");
      expect(
        encodeVimClipboard(result.register!, editor.schema)["text/markdown"],
      ).toContain("内側の本文");
      expect(
        runEditorVimCommand(editor.view, "line.delete", "normal", null).handled,
      ).toBe(true);
      expect(editor.state.doc.textContent).not.toContain("内側の本文");
      expect(editor.state.doc.textContent).toContain("後続");
    } finally {
      destroy();
    }
  });

  it("creates Details with slash conversion and allows slash conversion inside its body", () => {
    const { editor, select, destroy } = harness("/");
    try {
      select("/");
      const blockId = editor.state.selection.$from.parent.attrs.blockId;
      const result = runBlockTransformCommand(editor.view, {
        name: "block.transform",
        payload: { blockId, target: "details", consumeSlash: true },
      });
      expect(result.changed).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe(
        "detailsSummary",
      );
      expect(editor.state.selection.$from.parent.textContent).toBe("");
      runEditorInsertEnter(editor.view, false);
      const paragraph = editor.state.selection.$from.parent;
      expect(
        runBlockTransformCommand(editor.view, {
          name: "block.transform",
          payload: { blockId: paragraph.attrs.blockId, target: "codeBlock" },
        }).changed,
      ).toBe(true);
    } finally {
      destroy();
    }
  });
});
