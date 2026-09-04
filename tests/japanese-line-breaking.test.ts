import { describe, expect, it } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { MAX_BUDOUX_TEXT_LENGTH } from "../app/src/vim/word-semantics";
import { setJapaneseSegmentationConfiguration } from "../app/src/core/japanese-segmentation";

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
