import type { JSONContent } from "@tiptap/core";
import type { UndoManager } from "yjs";
import { describe, expect, it, vi } from "vitest";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { BrowserVimClipboard } from "../app/src/vim/clipboard";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  content: [text(value)],
});

async function harness(content: JSONContent[]) {
  const clipboard = vi
    .spyOn(BrowserVimClipboard.prototype, "write")
    .mockResolvedValue("rich");
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const { adapter, editor } = runtime.editorForTesting("window-1", root, {
    requestImeOff: () => ({ supported: true, inactive: true, detail: "test" }),
    setNormalModeImeGuardActive: () => {},
  });
  editor.commands.setContent({ type: "doc", content });
  editor.view.focus();
  const press = (...keys: string[]) => {
    for (const key of keys)
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
  };
  press("Escape");
  await runtime.flush();
  const undo = editor.state.plugins
    .map(
      (plugin) =>
        plugin.getState(editor.state)?.undoManager as UndoManager | undefined,
    )
    .find(Boolean);
  if (!undo) throw new Error("Editor UndoManager not found");
  undo.clear();
  const position = (value: string) => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(value))
        found = pos + node.text!.indexOf(value);
    });
    if (found < 0) throw new Error(`Text not found: ${value}`);
    return found;
  };
  return {
    editor,
    adapter,
    runtime,
    root,
    press,
    position,
    clipboard,
    undo,
    select(value: string, offset = 0) {
      editor.commands.setTextSelection(position(value) + offset);
    },
    selected() {
      return editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
        "\n",
        "\uFFFC",
      );
    },
    destroy() {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      clipboard.mockRestore();
    },
  };
}

describe("Visual Char edits and text objects", () => {
  it("treats s as change and undoes deletion plus delayed insertion in one step", async () => {
    const h = await harness([paragraph("alpha beta gamma")]);
    try {
      h.select("beta", 3);
      h.press("v", "h", "h", "h", "s");
      expect(h.adapter.vimSnapshot.mode).toBe("insert");
      expect(h.editor.getText()).toBe("alpha  gamma");
      expect(h.runtime.vimRegister.read()?.text).toBe("beta");
      h.undo.lastChange = 1;
      h.editor.commands.insertContent("新規");
      h.press("Escape");
      await h.runtime.flush();
      expect(h.editor.getText()).toBe("alpha 新規 gamma");
      expect(h.undo.undoStack).toHaveLength(1);
      h.press("u");
      expect(h.editor.getText()).toBe("alpha beta gamma");
      expect(h.editor.state.selection.head).toBe(h.position("beta"));
    } finally {
      h.destroy();
    }
  });

  it.each([false, true])(
    "replaces every selected Unicode character and keeps marks (backward=%s)",
    async (backward) => {
      const h = await harness([
        {
          type: "paragraph",
          content: [
            text("left "),
            { type: "text", text: "日😀語", marks: [{ type: "bold" }] },
            text(" right"),
          ],
        },
      ]);
      try {
        h.runtime.vimRegister.set({ kind: "text", text: "unchanged register" });
        const before = h.editor.getJSON();
        h.select("日😀語", backward ? 3 : 0);
        h.press("v", ...(backward ? ["h", "h", "h"] : ["l", "l", "l"]), "r");
        expect(h.editor.getJSON()).toEqual(before);
        h.press("🦊");
        expect(h.adapter.vimSnapshot.mode).toBe("normal");
        expect(h.editor.getText()).toBe("left 🦊🦊🦊 right");
        expect(
          h.editor.state.doc.firstChild?.child(1).marks[0]?.type.name,
        ).toBe("bold");
        expect(h.runtime.vimRegister.read()?.text).toBe("unchanged register");
        expect(h.undo.undoStack).toHaveLength(1);
        expect(h.editor.state.selection.head).toBe(h.position("🦊"));
        h.press("u");
        expect(h.editor.getJSON()).toEqual(before);
        expect(h.editor.state.selection.head).toBe(h.position("日"));
      } finally {
        h.destroy();
      }
    },
  );

  it("preserves Hard Breaks, Code newlines and container identities in multi-block r", async () => {
    const h = await harness([
      {
        type: "paragraph",
        content: [text("ab"), { type: "hardBreak" }, text("cd")],
      },
      { type: "codeBlock", content: [text("ef\ngh")] },
      { type: "blockquote", content: [paragraph("ij")] },
    ]);
    try {
      const before = h.editor.getJSON();
      h.select("ab");
      h.press("v", "G", "$", "r", "x");
      expect(h.editor.state.doc.child(0).content.toJSON()).toEqual([
        text("xx"),
        { type: "hardBreak" },
        text("xx"),
      ]);
      expect(h.editor.state.doc.child(1).textContent).toBe("xx\nxx");
      expect(h.editor.state.doc.child(2).textContent).toBe("xx");
      expect(h.editor.getJSON().content?.map((n) => n.attrs)).toEqual(
        before.content?.map((n) => n.attrs),
      );
      expect(h.undo.undoStack).toHaveLength(1);
      h.press("u");
      expect(h.editor.getJSON()).toEqual(before);
    } finally {
      h.destroy();
    }
  });

  it("does not replace the hidden body of a collapsed Details block", async () => {
    const h = await harness([
      paragraph("before"),
      {
        type: "details",
        attrs: { open: false },
        content: [
          { type: "detailsSummary", content: [text("title")] },
          { type: "detailsBody", content: [paragraph("hidden body")] },
        ],
      },
      paragraph("after"),
    ]);
    try {
      h.select("before");
      h.press("v", "G", "$", "r", "x");
      expect(h.editor.state.doc.child(1).firstChild?.textContent).toBe("xxxxx");
      expect(h.editor.state.doc.child(1).lastChild?.textContent).toBe(
        "hidden body",
      );
    } finally {
      h.destroy();
    }
  });

  it("treats an Internal Link as one replaceable atom, without visiting its label twice", async () => {
    const h = await harness([
      {
        type: "paragraph",
        content: [
          text("left "),
          {
            type: "internalSectionLink",
            attrs: { targetSectionId: "01900000-0000-7000-8000-0000000000aa" },
            content: [text("Link label")],
          },
          text(" right"),
        ],
      },
    ]);
    try {
      const before = h.editor.getJSON();
      h.editor.commands.setTextSelection(6);
      h.press("v", "i", "w");
      expect(h.editor.state.selection.to - h.editor.state.selection.from).toBe(
        12,
      );
      h.press("r", "X");
      expect(h.editor.getText()).toBe("left X right");
      h.press("u");
      expect(h.editor.getJSON()).toEqual(before);
    } finally {
      h.destroy();
    }
  });

  it.each([
    { keys: ["i", "w"], expected: "beta" },
    { keys: ["a", "w"], expected: "beta " },
    { keys: ["2", "i", "w"], expected: "beta gamma" },
    { keys: ["i", "w", "i", "w"], expected: "beta gamma" },
    { keys: ["i", "p"], expected: "alpha beta gamma" },
  ])(
    "selects $keys using the shared object ranges",
    async ({ keys, expected }) => {
      const h = await harness([paragraph("alpha beta gamma")]);
      try {
        h.select("beta", 3); // Inclusive Visual head must not resolve the following whitespace.
        h.press("v", ...keys);
        expect(h.adapter.vimSnapshot.mode).toBe("visual-char");
        expect(h.selected()).toBe(expected);
        h.press("y");
        expect(h.runtime.vimRegister.read()?.text).toBe(expected);
        expect(h.undo.undoStack).toHaveLength(0);
      } finally {
        h.destroy();
      }
    },
  );

  it.each([1, 2])(
    "keeps the opposite anchor when %i word objects extend a backward selection",
    async (count) => {
      const h = await harness([paragraph("alpha beta gamma")]);
      try {
        h.select("gamma", 2);
        h.press("v", "h", "h", "h", String(count), "i", "w");
        expect(h.selected()).toBe(count === 1 ? "beta gam" : "alpha beta gam");
        expect(h.editor.state.selection.head).toBeLessThan(
          h.editor.state.selection.anchor,
        );
      } finally {
        h.destroy();
      }
    },
  );

  it("uses the same Japanese word boundary for yiw and viwy", async () => {
    const h = await harness([paragraph("日本語の文章を自然に編集する")]);
    try {
      h.select("編集");
      h.press("y", "i", "w");
      const expected = h.runtime.vimRegister.read()?.text;
      h.select("編集");
      h.press("v", "i", "w");
      expect(h.selected()).toBe(expected);
      h.press("y");
      expect(h.runtime.vimRegister.read()?.text).toBe(expected);
    } finally {
      h.destroy();
    }
  });

  it("v2ap keeps both structural units selected through the mode transition", async () => {
    const h = await harness([
      paragraph("first"),
      paragraph("second"),
      paragraph("third"),
    ]);
    try {
      h.select("first", 2);
      h.press("v", "2", "a", "p", "y");
      expect(h.runtime.vimRegister.read()?.text).toContain("first");
      expect(h.runtime.vimRegister.read()?.text).toContain("second");
      expect(h.runtime.vimRegister.read()?.text).not.toContain("third");
    } finally {
      h.destroy();
    }
  });

  it("does not let aw swallow neighbouring Table Cells", async () => {
    const h = await harness([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("left   ")] },
              { type: "tableCell", content: [paragraph("word")] },
              { type: "tableCell", content: [{ type: "paragraph" }] },
            ],
          },
        ],
      },
    ]);
    try {
      h.select("word", 2);
      h.press("v", "a", "w");
      expect(h.selected()).toBe("word");
      h.press("s");
      expect(h.editor.state.doc.firstChild?.firstChild?.childCount).toBe(3);
      expect(
        h.editor.state.doc.firstChild?.firstChild?.firstChild?.textContent,
      ).toBe("left   ");
    } finally {
      h.destroy();
    }
  });

  it("selects ap structurally without copying unselected nested ListItems", async () => {
    const h = await harness([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("parent"),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("child")] }],
              },
            ],
          },
          { type: "listItem", content: [paragraph("sibling")] },
        ],
      },
    ]);
    try {
      h.select("parent", 2);
      h.press("v", "a", "p");
      expect(h.adapter.vimSnapshot.mode).toBe("visual-line");
      h.press("y");
      expect(h.runtime.vimRegister.read()?.text).toBe("parent");
      expect(h.runtime.vimRegister.read()?.kind).toBe("structure");
      h.press("g", "v");
      expect(h.adapter.vimSnapshot.mode).toBe("visual-line");
    } finally {
      h.destroy();
    }
  });

  it.each([
    ["r", "Escape"],
    ["i", "Escape"],
    ["a", "Escape"],
    ["i", "q"],
  ])("cancels incomplete Visual input %s without editing", async (...keys) => {
    const h = await harness([paragraph("alpha")]);
    try {
      const before = h.editor.getJSON();
      h.select("alpha");
      h.press("v", ...keys);
      expect(h.editor.getJSON()).toEqual(before);
      expect(h.undo.undoStack).toHaveLength(0);
      expect(h.adapter.vimSnapshot.mode).toBe(
        keys.includes("Escape") ? "normal" : "visual-char",
      );
    } finally {
      h.destroy();
    }
  });

  it("selects and replaces the last word in a rightmost Table Cell", async () => {
    const h = await harness([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("left")] },
              { type: "tableCell", content: [paragraph("last word")] },
            ],
          },
        ],
      },
    ]);
    try {
      const before = h.editor.getJSON();
      h.select("word", 3);
      h.press("v", "i", "w");
      expect(h.selected()).toBe("word");
      h.press("r", "X");
      expect(h.editor.state.doc.firstChild?.firstChild?.childCount).toBe(2);
      expect(
        h.editor.state.doc.firstChild?.firstChild?.child(1).textContent,
      ).toBe("last XXXX");
      h.press("u");
      expect(h.editor.getJSON()).toEqual(before);
    } finally {
      h.destroy();
    }
  });

  it.each([1, 2])(
    "Y yanks %i logical lines like yy and publishes the clipboard",
    async (count) => {
      const h = await harness([
        {
          type: "paragraph",
          content: [
            text("before"),
            { type: "hardBreak" },
            text("alpha beta"),
            { type: "hardBreak" },
            text("after"),
          ],
        },
      ]);
      try {
        h.select("alpha", 4);
        const cursor = h.editor.state.selection.head;
        const before = h.editor.state.doc;
        h.press(String(count), "Y");
        const yanked = h.runtime.vimRegister.read();
        expect(yanked?.text).toBe(
          count === 1 ? "alpha beta" : "alpha beta\nafter",
        );
        expect(h.clipboard).toHaveBeenCalled();
        expect(h.editor.state.selection.head).toBe(cursor);
        h.press(String(count), "y", "y");
        expect(h.runtime.vimRegister.read()).toEqual(yanked);
        expect(h.editor.state.doc).toBe(before);
        expect(h.undo.undoStack).toHaveLength(0);
      } finally {
        h.destroy();
      }
    },
  );
});
