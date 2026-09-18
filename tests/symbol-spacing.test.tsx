import { Editor } from "@tiptap/core";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import { InlineSymbols } from "../app/src/editor/inline-symbols";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  SYMBOL_SPACE_CLASS,
  symbolSpacingOffsets,
  textblockSymbolSpacingOffsets,
} from "../app/src/core/symbol-spacing";
import { SymbolText } from "../app/src/components/SymbolText";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { textAutospaceCompensationForTextblock } from "../app/src/editor/text-autospace";
import {
  loadSymbolIcons,
  renderSymbolText,
} from "../app/src/editor/symbol-icons";

describe("display-only symbol spacing", () => {
  it("does not rescan an unchanged document to lazily load icons", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineSymbols],
      content: "<p>plain text</p>",
    });
    const plugin = editor.state.plugins.find(
      (plugin) => plugin.getState(editor.state)?.composing === false,
    );
    const doc = editor.state.doc;
    const scan = vi.spyOn(doc, "descendants");
    const view = plugin!.spec.view!(editor.view);
    try {
      expect(scan).toHaveBeenCalledTimes(1);
      view.update?.(editor.view, editor.state);
      view.update?.(editor.view, editor.state);
      expect(scan).toHaveBeenCalledTimes(1);
      editor.commands.insertContent("changed");
      const nextScan = vi.spyOn(editor.state.doc, "descendants");
      view.update?.(editor.view, editor.state);
      expect(nextScan).toHaveBeenCalledTimes(1);
      view.update?.(editor.view, editor.state);
      expect(nextScan).toHaveBeenCalledTimes(1);
    } finally {
      view.destroy?.();
      editor.destroy();
    }
  });
  it("does not double-space Japanese beside variation selectors and keycap marks", () => {
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      const node = editor.schema.node("paragraph", null, [
        editor.schema.text("日❤️日1️⃣日A日"),
      ]);
      const result = textAutospaceCompensationForTextblock(node, 0);
      // Only the final 日A日 gets the CJK/Latin compatibility spacing.
      expect(result?.decorations.map((entry) => entry.from)).toEqual([9, 10]);
      expect(textblockSymbolSpacingOffsets(node)).toEqual([1, 3, 4, 7]);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });
  it.each([
    ["日😀A", [1, 3]],
    ["😀😃", [2]],
    ["a👍🏽b", [1, 5]],
    ["a👨‍👩‍👧‍👦b", [1, 12]],
    ["a🇯🇵b", [1, 5]],
    ["a1️⃣b", [1, 4]],
    ["a❤️b", [1, 3]],
    ["a❤︎b", []],
    ["😀", []],
    [" a😀 b", [2]],
    ["😀\n😃", []],
    ["a123#*b", []],
    ["日Ab本", []],
    [":lucide-check::lucide-smile:", [14]],
    ["😀:lucide-check:😃", [2, 16]],
    ["日:lucide-check:A", [1, 15]],
    ["日:lucide-missing-name:A", []],
  ] as const)(
    "adds a single gap at grapheme/icon boundaries in %s",
    (text, expected) => {
      expect(symbolSpacingOffsets(text)).toEqual(expected);
    },
  );

  it("uses identical boundaries in React labels and internal-link NodeViews without changing text", async () => {
    await loadSymbolIcons();
    const text = "日👨‍👩‍👧‍👦:lucide-check:🇯🇵A";
    const { container } = render(<SymbolText text={text} />);
    const element = document.createElement("span");
    renderSymbolText(element, text);
    expect(container.querySelectorAll(`.${SYMBOL_SPACE_CLASS}`)).toHaveLength(
      4,
    );
    expect(element.querySelectorAll(`.${SYMBOL_SPACE_CLASS}`)).toHaveLength(4);
    expect(element.textContent).toBe(text);
    expect(container.textContent).toBe("日👨‍👩‍👧‍👦🇯🇵A");
  });

  it("spaces across marks, leaves code unchanged, and keeps spacing out of serialized text and HTML", async () => {
    await loadSymbolIcons();
    const note = createNoteDocument(createUuidV7());
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "日👨" },
              { type: "text", text: "‍👩‍👧‍👦:lucide-", marks: [{ type: "bold" }] },
              { type: "text", text: "check:😀A" },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "A😀:lucide-check:日",
                marks: [{ type: "code" }],
              },
            ],
          },
          { type: "codeBlock", content: [{ type: "text", text: "A😀B" }] },
          { type: "sourceBlock", content: [{ type: "text", text: "A😀B" }] },
        ],
      });
      const json = editor.getJSON();
      const nodes: (typeof editor.state.doc)[] = [];
      editor.state.doc.descendants((node) => {
        if (node.isTextblock) nodes.push(node);
      });
      expect(textblockSymbolSpacingOffsets(nodes[0]!)).toHaveLength(4);
      for (const node of nodes.slice(1))
        expect(textblockSymbolSpacingOffsets(node)).toEqual([]);
      expect(
        editor.view.dom.querySelectorAll(`.${SYMBOL_SPACE_CLASS}`),
      ).toHaveLength(4);
      expect(editor.getHTML()).not.toContain(SYMBOL_SPACE_CLASS);
      expect(editor.getText()).toContain("日👨‍👩‍👧‍👦:lucide-check:😀A");
      expect(editor.getJSON()).toEqual(json);
      editor.commands.setTextSelection(2);
      expect(editor.getJSON()).toEqual(json);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });
});
