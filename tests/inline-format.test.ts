import { Editor, type JSONContent } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { productEditorExtensions } from "../app/src/editor/extensions";
import {
  captureInlineFormatSelection,
  externalLinkAtPosition,
  runInlineFormatCommand,
} from "../app/src/vim/inline-format";
import type { InlineFormatPickerRequest } from "../app/src/editor/tiptap-adapter";

function withEditor(run: (editor: Editor) => void): void {
  const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
  const editor = new Editor({
    extensions: productEditorExtensions(note, { directBodyOnly: true }),
  });
  try {
    run(editor);
  } finally {
    editor.destroy();
    note.doc.destroy();
  }
}

function textRange(editor: Editor): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = -1;
  editor.state.doc.descendants((node, position) => {
    if (!node.isText) return;
    from = Math.min(from, position);
    to = Math.max(to, position + node.nodeSize);
  });
  if (!Number.isFinite(from) || to < 0) throw new Error("No text found");
  return { from, to };
}

function apply(
  editor: Editor,
  action: Parameters<typeof runInlineFormatCommand>[2],
) {
  const range = textRange(editor);
  editor.commands.setTextSelection(range);
  const selection = captureInlineFormatSelection(editor.view);
  if (!selection) throw new Error("Selection was not captured");
  return runInlineFormatCommand(editor.view, selection, action);
}

function press(editor: Editor, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

describe("Memoka inline formatting", () => {
  it("allows synthesized weight and oblique faces for Japanese editor text", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    const editor = document.createElement("div");
    editor.className = "memoka-editor";
    const bold = document.createElement("strong");
    bold.textContent = "日本語";
    const italic = document.createElement("em");
    italic.textContent = "日本語";
    const strike = document.createElement("s");
    strike.textContent = "日本語";
    const code = document.createElement("code");
    code.textContent = "日本語";
    const externalLink = document.createElement("a");
    externalLink.href = "https://example.com";
    externalLink.textContent = "外部リンク";
    const internalLink = document.createElement("span");
    internalLink.className = "internal-section-link";
    internalLink.textContent = "内部リンク";
    editor.append(bold, italic, strike, code, externalLink, internalLink);
    document.head.append(style);
    document.body.append(editor);
    try {
      expect(getComputedStyle(editor).fontSynthesis).toBe("weight style");
      expect(getComputedStyle(bold).fontWeight).toBe("700");
      expect(getComputedStyle(italic).fontStyle).toBe("oblique 12deg");
      expect(getComputedStyle(italic).textDecorationStyle).toBe("dotted");
      expect(getComputedStyle(italic).textDecorationLine).toBe("underline");
      expect(style.textContent).toContain(
        ".memoka-editor strong:not(.memoka-attachment-card__name)",
      );
      expect(style.textContent).toContain(
        "color: var(--memoka-color-markup-italic)",
      );
      expect(style.textContent).toContain(
        "color: var(--memoka-color-markup-strikethrough)",
      );
      expect(style.textContent).toContain(
        "color: var(--memoka-color-markup-raw)",
      );
      expect(style.textContent).toContain(
        "color: var(--memoka-color-markup-link-url)",
      );
      expect(style.textContent).toContain(
        "color: var(--memoka-color-markup-link-reference)",
      );
    } finally {
      editor.remove();
      style.remove();
    }
  });

  it("composes bold, italic, strike, code and a safe external link", () => {
    withEditor((editor) => {
      editor.commands.setContent("<p>formatted</p>");
      for (const format of ["bold", "italic", "strike", "code"] as const) {
        expect(apply(editor, { kind: "apply", format })).toMatchObject({
          changed: true,
        });
      }
      expect(
        apply(editor, { kind: "link", href: "https://example.com" }),
      ).toMatchObject({ changed: true });
      const text = editor.state.doc.firstChild?.firstChild;
      expect(text?.marks.map(({ type }) => type.name).sort()).toEqual([
        "bold",
        "code",
        "italic",
        "link",
        "strike",
      ]);
      expect(
        text?.marks.find(({ type }) => type.name === "link")?.attrs.href,
      ).toBe("https://example.com");
      expect(
        editor.view.dom.querySelector<HTMLAnchorElement>("a[href]")?.title,
      ).toBe("https://example.com");

      expect(apply(editor, { kind: "clear" })).toMatchObject({ changed: true });
      expect(editor.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
      expect(apply(editor, { kind: "clear" })).toEqual({
        changed: false,
        reason: "no-op",
      });
    });
  });

  it("formats multiple Paragraphs while retaining an atomic Internal Link", () => {
    withEditor((editor) => {
      const content: JSONContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "before" },
              {
                type: "internalSectionLink",
                attrs: {
                  targetSectionId: "01900000-0000-7000-8000-0000000000aa",
                },
                content: [{ type: "text", text: "Internal" }],
              },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      };
      editor.commands.setContent(content);
      expect(apply(editor, { kind: "apply", format: "bold" })).toMatchObject({
        changed: true,
      });
      const json = editor.getJSON();
      expect(json.content?.[0]?.content?.[0]?.marks).toEqual([
        { type: "bold" },
      ]);
      expect(json.content?.[0]?.content?.[1]).toMatchObject({
        type: "internalSectionLink",
      });
      expect(json.content?.[0]?.content?.[1]?.marks).toBeUndefined();
      expect(json.content?.[1]?.content?.[0]?.marks).toEqual([
        { type: "bold" },
      ]);
    });
  });

  it("rejects links across blocks and marks in Code Blocks atomically", () => {
    withEditor((editor) => {
      editor.commands.setContent("<p>one</p><p>two</p>");
      const range = textRange(editor);
      editor.commands.setTextSelection(range);
      const selection = captureInlineFormatSelection(editor.view)!;
      expect(
        runInlineFormatCommand(editor.view, selection, {
          kind: "link",
          href: "/relative",
        }),
      ).toEqual({ changed: false, reason: "link-multiple-blocks" });
      expect(
        editor.getJSON().content?.flatMap((node) => node.content ?? []),
      ).toEqual([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]);

      editor.commands.setContent("<pre><code>source</code></pre>");
      const codeRange = textRange(editor);
      editor.commands.setTextSelection(codeRange);
      const codeSelection = captureInlineFormatSelection(editor.view)!;
      expect(
        runInlineFormatCommand(editor.view, codeSelection, {
          kind: "apply",
          format: "italic",
        }),
      ).toEqual({ changed: false, reason: "unsupported-block" });
    });
  });

  it("rejects stale selections and resolves the external link under the cursor", () => {
    withEditor((editor) => {
      editor.commands.setContent(
        '<p><a href="https://example.com">linked</a> tail</p>',
      );
      const range = textRange(editor);
      editor.commands.setTextSelection({
        from: range.from,
        to: range.from + 2,
      });
      const selection = captureInlineFormatSelection(editor.view)!;
      editor.commands.insertContentAt(range.to, "!");
      expect(
        runInlineFormatCommand(editor.view, selection, {
          kind: "apply",
          format: "bold",
        }),
      ).toEqual({ changed: false, reason: "stale" });
      expect(externalLinkAtPosition(editor.state.doc, range.from)).toBe(
        "https://example.com",
      );
      expect(
        externalLinkAtPosition(editor.state.doc, range.from + 6),
      ).toBeNull();
    });
  });

  it("normalizes bare domains at the command boundary", () => {
    withEditor((editor) => {
      editor.commands.setContent("<p>website</p>");
      expect(
        apply(editor, { kind: "link", href: "example.com/docs" }),
      ).toMatchObject({
        changed: true,
        action: { kind: "link", href: "https://example.com/docs" },
      });
    });
  });

  it("opens the shared picker with visual m and applies one undoable change", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let request: InlineFormatPickerRequest | null = null;
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onInlineFormatPicker: (value) => {
        request = value;
      },
    });
    editor.commands.setContent("<p>alpha</p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "v");
    press(editor, "l");
    expect(press(editor, "m").defaultPrevented).toBe(true);
    const openedRequest = request as unknown as InlineFormatPickerRequest;
    expect(openedRequest.selectedText).toBe("al");
    expect(
      openedRequest.apply({ kind: "apply", format: "bold" }),
    ).toMatchObject({
      changed: true,
    });
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
      { type: "bold" },
    ]);

    press(editor, "u");
    await runtime.flush();
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined();

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("opens only absolute gx targets and reports relative links", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const openExternalLink = vi.fn(() => Promise.resolve());
    const onMessage = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      openExternalLink,
      onMessage,
    });
    editor.commands.setContent(
      '<p><a href="https://example.com">absolute</a> <a href="/relative">relative</a></p>',
    );
    editor.commands.focus();
    const anchor = editor.view.dom.querySelector("a");
    if (!(anchor instanceof HTMLElement))
      throw new Error("Link was not rendered");
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalLink).not.toHaveBeenCalled();
    press(editor, "Escape");
    editor.commands.setTextSelection(1);
    press(editor, "g");
    press(editor, "x");
    await Promise.resolve();
    expect(openExternalLink).toHaveBeenCalledWith("https://example.com");

    editor.commands.setTextSelection(10);
    press(editor, "g");
    press(editor, "x");
    expect(openExternalLink).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenLastCalledWith(
      "gx · 相対URLを解決する基準ディレクトリはまだありません",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps marks when a characterwise yank is put into plain text", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent("<p><strong>alpha</strong> omega</p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "v");
    press(editor, "l");
    press(editor, "y");
    press(editor, "$");
    expect(press(editor, "p").defaultPrevented).toBe(true);

    expect(editor.getText()).toBe("alpha omegaal");
    const paragraph = editor.state.doc.firstChild;
    const last = paragraph?.lastChild;
    expect(last?.text).toBe("al");
    expect(last?.marks.map(({ type }) => type.name)).toEqual(["bold"]);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha omega");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });
});
