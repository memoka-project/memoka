import { describe, expect, it } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { MAX_BUDOUX_TEXT_LENGTH } from "../app/src/vim/word-semantics";
import { setJapaneseSegmentationConfiguration } from "../app/src/core/japanese-segmentation";
import {
  needsTextAutospaceBetween,
  TEXT_AUTOSPACE_AFTER_CLASS,
  TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
} from "../app/src/editor/text-autospace";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function lineBreakingEditor() {
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root);
  return {
    ...binding,
    root,
    runtime,
    destroy: () => {
      binding.adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  };
}

describe("Japanese display line breaking", () => {
  it("recognizes Japanese and alphanumeric autospace boundaries", () => {
    expect(needsTextAutospaceBetween("日", "A")).toBe(true);
    expect(needsTextAutospaceBetween("9", "語")).toBe(true);
    expect(needsTextAutospaceBetween("日", "語")).toBe(false);
    expect(needsTextAutospaceBetween("A", "9")).toBe(false);
    expect(needsTextAutospaceBetween("`", "語")).toBe(false);
    expect(needsTextAutospaceBetween("。", "A")).toBe(false);
  });

  it("switches fine, BudouX, and native display splitting without changing the document", async () => {
    const { destroy, editor, root } = await lineBreakingEditor();
    const value =
      "Table内のNormal Ctrl-vはCell矩形を選ぶTable限定Visual Blockとする。";
    editor.commands.setContent(`<p>${value}</p>`);
    const before = editor.getJSON();

    setJapaneseSegmentationConfiguration({
      wordSegmentation: "fine",
      lineBreakSegmentation: "budoux",
    });
    await nextFrame();
    await nextFrame();
    expect(root.querySelectorAll("wbr[data-memoka-budoux-break]")).toHaveLength(
      4,
    );

    setJapaneseSegmentationConfiguration({
      wordSegmentation: "fine",
      lineBreakSegmentation: "fine",
    });
    await nextFrame();
    await nextFrame();
    expect(root.querySelectorAll("wbr[data-memoka-budoux-break]")).toHaveLength(
      5,
    );

    setJapaneseSegmentationConfiguration({
      wordSegmentation: "fine",
      lineBreakSegmentation: "native",
    });
    await nextFrame();
    await nextFrame();
    expect(root.querySelector(".memoka-budoux-textblock")).toBeNull();
    expect(root.querySelector("wbr[data-memoka-budoux-break]")).toBeNull();
    expect(editor.getJSON()).toEqual(before);
    destroy();
  });

  it("applies the same wrapping projection to Section titles", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "日本語のセクションタイトルを編集する",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const binding = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    await nextFrame();
    await nextFrame();
    const header = root.querySelector("header[data-section-header]");
    expect(header?.classList.contains("memoka-budoux-textblock")).toBe(true);
    expect(
      header?.querySelector("wbr[data-memoka-budoux-break]"),
    ).not.toBeNull();
    binding.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("adds model-neutral BudouX opportunities only to prose", async () => {
    const { destroy, editor, root } = await lineBreakingEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "日本語の文章を" },
            {
              type: "text",
              marks: [{ type: "code" }],
              text: "コード日本語",
            },
            { type: "text", text: "快適に編集する" },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "日本語のコードブロック" }],
        },
      ],
    });
    const before = editor.getJSON();
    await nextFrame();
    await nextFrame();

    const paragraph = root.querySelector("p");
    expect(paragraph?.classList.contains("memoka-budoux-textblock")).toBe(true);
    expect(
      paragraph?.querySelectorAll("wbr[data-memoka-budoux-break='true']")
        .length,
    ).toBeGreaterThan(0);
    expect(paragraph?.querySelector("code wbr")).toBeNull();
    expect(root.querySelector("pre.memoka-budoux-textblock")).toBeNull();
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.doc.textContent).not.toContain("\u200b");
    destroy();
  });

  it("adds model-neutral corrections to plain and marked prose boundaries", async () => {
    document.documentElement.setAttribute(
      TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
      "broken",
    );
    const { destroy, editor, root } = await lineBreakingEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Code Block上部と日本語" },
            {
              type: "text",
              marks: [{ type: "bold" }],
              text: "true",
            },
            { type: "text", text: "では" },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "code" }],
              text: "code",
            },
            { type: "text", text: "本文" },
          ],
        },
      ],
    });
    const before = editor.getJSON();
    await nextFrame();
    await nextFrame();

    const corrections = root.querySelectorAll(`.${TEXT_AUTOSPACE_AFTER_CLASS}`);
    expect(
      Array.from(corrections).every((element) => !element.textContent),
    ).toBe(true);
    expect(
      root.querySelectorAll(`.${TEXT_AUTOSPACE_AFTER_CLASS}`),
    ).toHaveLength(3);
    expect(
      root
        .querySelectorAll("p")[1]
        ?.querySelector(`.${TEXT_AUTOSPACE_AFTER_CLASS}`),
    ).toBeNull();
    expect(editor.getJSON()).toEqual(before);
    destroy();
    document.documentElement.removeAttribute(
      TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
    );
  });

  it("rebuilds autospace after replacing content with the same boundary offsets", async () => {
    document.documentElement.setAttribute(
      TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
      "broken",
    );
    const { destroy, editor, root } = await lineBreakingEditor();
    try {
      for (const html of ["日A日", "日<strong>A</strong>日", "語9語"]) {
        editor.commands.setContent(`<p>${html}</p>`);
        const before = editor.getJSON();
        await nextFrame();
        await nextFrame();
        expect(
          root.querySelectorAll(`.${TEXT_AUTOSPACE_AFTER_CLASS}`),
        ).toHaveLength(2);
        expect(editor.getJSON()).toEqual(before);
      }
    } finally {
      destroy();
      document.documentElement.removeAttribute(
        TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
      );
    }
  });

  it("resolves character DOM positions past autospace widgets", async () => {
    document.documentElement.setAttribute(
      TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
      "broken",
    );
    const { destroy, editor } = await lineBreakingEditor();
    try {
      for (const html of [
        "日A日",
        "日<strong>A</strong>日",
        "日本語IMEの変換中はEditor内",
      ]) {
        editor.commands.setContent(`<p>${html}</p>`);
        await nextFrame();
        await nextFrame();
        editor.state.doc.descendants((node, position) => {
          if (!node.isText) return;
          for (let offset = 0; offset < node.nodeSize; offset++) {
            const dom = editor.view.domAtPos(position + offset, 1);
            expect(dom.node.nodeType).toBe(Node.TEXT_NODE);
            expect(dom.node.nodeValue?.[dom.offset]).toBe(node.text?.[offset]);
          }
        });
      }
    } finally {
      destroy();
      document.documentElement.removeAttribute(
        TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
      );
    }
  });

  it("uses native wrapping for oversized single textblocks", async () => {
    const { destroy, editor, root } = await lineBreakingEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "日".repeat(MAX_BUDOUX_TEXT_LENGTH + 1),
            },
          ],
        },
      ],
    });
    await nextFrame();
    await nextFrame();
    expect(root.querySelector(".memoka-budoux-textblock")).toBeNull();
    expect(root.querySelector("wbr[data-memoka-budoux-break]")).toBeNull();
    destroy();
  });

  it("defers rebuilding decorations during IME composition", async () => {
    const { destroy, editor, root } = await lineBreakingEditor();
    editor.commands.setContent("<p>plain text</p>");
    await nextFrame();
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    editor.commands.setContent("<p>日本語の文章を編集する</p>");
    await nextFrame();
    expect(root.querySelector(".memoka-budoux-textblock")).toBeNull();

    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await nextFrame();
    await nextFrame();
    expect(
      root.querySelector("p")?.classList.contains("memoka-budoux-textblock"),
    ).toBe(true);
    destroy();
  });
});
