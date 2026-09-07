import type { Editor } from "@tiptap/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import type { TiptapEditorAdapterOptions } from "../app/src/editor/tiptap-adapter";
import {
  BrowserVimClipboard,
  type ExplicitClipboardContent,
  UTF8_PLAIN_CLIPBOARD_MIME,
} from "../app/src/vim/clipboard";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
  vi.unstubAllGlobals();
});

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function pastePlain(editor: Editor, options: KeyboardEventInit = {}) {
  return press(editor, "V", { ctrlKey: true, shiftKey: true, ...options });
}

const plainContent = (content: string): ExplicitClipboardContent => ({
  availableTypes: ["text/html", "text/markdown", "text/plain"],
  sourceMime: "text/plain",
  content,
});

async function harness(options: TiptapEditorAdapterOptions = {}) {
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const root = document.createElement("div");
  document.body.append(root);
  const binding = runtime.editorForTesting("window-1", root, options);
  await runtime.flush();
  binding.editor.view.focus();
  cleanups.push(async () => {
    await runtime.flush();
    binding.adapter.destroy();
    runtime.destroy();
    root.remove();
  });
  return { ...binding, runtime };
}

describe("Insert Ctrl-Shift-v", () => {
  it("pastes Firefox's Japanese UTF-8 text into list items rather than its escaped plain target", async () => {
    const { editor, adapter } = await harness();
    editor.commands.setContent("<ul><li><p></p></li></ul>");
    editor.commands.setTextSelection(3);
    const lines = [
      "Ctrl-w x : 現在の画面と次の画面を入れ替える(eXchange)",
      "Ctrl-w H : 現在の画面を一番左に移動する",
    ];
    const formats: Record<string, string> = {
      "text/plain": String.raw`Ctrl-w x : \u73fe\u5728\u306e\u753b\u9762`,
      "text/html": `<pre>${lines.join("\n")}</pre>`,
      [UTF8_PLAIN_CLIPBOARD_MIME]: lines.join("\n"),
    };
    const getType = vi.fn(async (type: string) => ({
      text: async () => formats[type]!,
    }));
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => [{ types: Object.keys(formats), getType }],
      },
    });
    expect(pastePlain(editor).defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe(
        "clipboard:paste:list-lines:changed",
      ),
    );
    expect(getType).toHaveBeenCalledExactlyOnceWith(UTF8_PLAIN_CLIPBOARD_MIME);
    expect(
      editor.state.doc.firstChild!.content.content.map(
        (item) => item.textContent,
      ),
    ).toEqual(lines);
    expect(editor.state.doc.firstChild!.firstChild!.firstChild!.type.name).toBe(
      "paragraph",
    );
  });

  it("also prefers UTF-8 in a plain-only DOM paste event", async () => {
    const { editor, adapter } = await harness();
    editor.commands.setContent("<ul><li><p></p></li></ul>");
    editor.commands.setTextSelection(3);
    const formats: Record<string, string> = {
      "text/plain": String.raw`\u65e5\u672c\u8a9e`,
      [UTF8_PLAIN_CLIPBOARD_MIME]: "日本語\n本文",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: Object.keys(formats),
        files: [],
        getData: (type: string) => formats[type] ?? "",
      },
    });
    editor.view.dom.dispatchEvent(event);
    expect(adapter.vimSnapshot.action).toBe(
      "clipboard:paste:list-lines:changed",
    );
    expect(
      editor.state.doc.firstChild!.content.content.map(
        (item) => item.textContent,
      ),
    ).toEqual(["日本語", "本文"]);
  });

  it("preserves Japanese through the native JSON boundary without unescaping literal code", async () => {
    const { editor, adapter } = await harness();
    editor.commands.setContent("<ul><li><p></p></li></ul>");
    editor.commands.setTextSelection(3);
    const ipc = vi.fn((command: string, payload: unknown) => {
      expect(command).toBe("clipboard_read_explicit");
      expect(payload).toEqual({ format: "plain" });
      // JSON escapes belong to the transport; an escaped backslash belongs
      // to the copied text and must not be interpreted a second time.
      return JSON.parse(
        String.raw`{"availableTypes":["text/html","text/plain"],"sourceMime":"text/plain","content":"Ctrl-w x: \u73fe\u5728\u306e\u753b\u9762\ncode: \\u73fe"}`,
      );
    });
    mockIPC(ipc);
    pastePlain(editor);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe(
        "clipboard:paste:list-lines:changed",
      ),
    );
    expect(ipc).toHaveBeenCalledOnce();
    expect(
      editor.state.doc.firstChild!.content.content.map(
        (item) => item.textContent,
      ),
    ).toEqual(["Ctrl-w x: 現在の画面", String.raw`code: \u73fe`]);
  });

  it("pastes only literal text from mixed formats, in one Undo unit", async () => {
    const readExplicitClipboard = vi.fn(() =>
      plainContent("**太字ではない**\n# 見出しではない\n- 項目ではない"),
    );
    const readPreferredClipboard = vi.fn(() => ({
      availableTypes: ["text/html"],
      html: "<h1>must not be inserted</h1>",
      internal: null,
      markdown: null,
    }));
    const { editor, adapter, runtime } = await harness({
      readExplicitClipboard,
      readPreferredClipboard,
    });
    editor.commands.setContent("<p>anchor</p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    await runtime.flush();
    const before = editor.state.doc;

    expect(pastePlain(editor).defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:plain:changed"),
    );
    expect(readExplicitClipboard).toHaveBeenCalledExactlyOnceWith("plain");
    expect(readPreferredClipboard).not.toHaveBeenCalled();
    expect(
      editor.state.doc.content.content.map((node) => node.type.name),
    ).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(
      editor.state.doc.content.content.map((node) => node.textContent),
    ).toEqual(["**太字ではない**", "# 見出しではない", "- 項目ではない"]);
    editor.state.doc.descendants((node) => expect(node.marks).toHaveLength(0));
    const after = editor.state.doc;
    press(editor, "Escape");
    press(editor, "u");
    expect(editor.state.doc.eq(before)).toBe(true);
    press(editor, "r", { ctrlKey: true });
    expect(editor.state.doc.eq(after)).toBe(true);
  });

  it("does not import a Markdown note even at an empty Root title", async () => {
    const { editor, adapter } = await harness({
      directBodyOnly: false,
      readExplicitClipboard: () => plainContent("# Literal title"),
    });
    editor.commands.setTextSelection(1);
    pastePlain(editor);
    await vi.waitFor(() =>
      expect(editor.state.doc.firstChild?.textContent).toBe("# Literal title"),
    );
    expect(adapter.vimSnapshot.action).toBe("clipboard:paste:plain:changed");
    expect(editor.state.doc.maybeChild(2)?.childCount).toBe(0);
  });

  it("merges multiline literal text with the paragraph at the insertion point", async () => {
    const { editor, adapter } = await harness({
      directBodyOnly: false,
      readExplicitClipboard: () => plainContent("**X**\n`Y`"),
    });
    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph")
        paragraphPosition = position + 1;
    });
    expect(paragraphPosition).toBeGreaterThan(0);
    editor.commands.setTextSelection(paragraphPosition);
    editor.commands.insertContent("abcd");
    editor.commands.setTextSelection(paragraphPosition + 2);
    pastePlain(editor);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:plain:changed"),
    );
    const paragraphs: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") paragraphs.push(node.textContent);
      expect(node.marks).toHaveLength(0);
    });
    expect(paragraphs).toEqual(["ab**X**", "`Y`cd"]);
    editor.state.doc.check();
  });

  it("splits plain text lines into sibling list items instead of importing HTML", async () => {
    const { editor, adapter } = await harness({
      readExplicitClipboard: () => plainContent("**X**\r\nY"),
    });
    editor.commands.setContent(
      "<ul><li><p>abcd</p><ul><li><p>child</p></li></ul></li></ul>",
    );
    editor.commands.setTextSelection(5);
    pastePlain(editor);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe(
        "clipboard:paste:list-lines:changed",
      ),
    );
    const list = editor.state.doc.firstChild!;
    expect(
      list.content.content.map((node) => node.firstChild?.textContent),
    ).toEqual(["ab**X**", "Ycd"]);
    expect(list.lastChild?.lastChild?.textContent).toBe("child");
    expect(list.firstChild?.firstChild?.firstChild?.marks).toHaveLength(0);
    editor.state.doc.check();
  });

  it("keeps newlines inside code and does not infer a Table from plain text", async () => {
    const content = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { editor, adapter } = await harness({
      readExplicitClipboard: () => plainContent(content),
    });
    for (const block of ["<pre><code></code></pre>", "<p></p>"]) {
      editor.commands.setContent(block);
      editor.commands.setTextSelection(1);
      pastePlain(editor);
      await vi.waitFor(() =>
        expect(adapter.vimSnapshot.action).toBe(
          "clipboard:paste:plain:changed",
        ),
      );
      expect(
        editor.state.doc.content.content.every(
          (node) => node.type.name !== "table",
        ),
      ).toBe(true);
      if (block.startsWith("<pre>")) {
        expect(editor.state.doc.childCount).toBe(1);
        expect(editor.state.doc.firstChild?.textContent).toBe(content);
      }
      editor.state.doc.check();
    }
  });

  it.each(["selection", "document", "mode", "surface", "dom-focus"])(
    "drops an async read when %s changes",
    async (change) => {
      let complete!: (value: ExplicitClipboardContent) => void;
      const pending = new Promise<ExplicitClipboardContent>((resolve) => {
        complete = resolve;
      });
      const { editor, adapter } = await harness({
        readExplicitClipboard: () => pending,
      });
      editor.commands.setContent("<p>anchor</p>");
      editor.commands.setTextSelection(1);
      pastePlain(editor);
      if (change === "selection") editor.commands.setTextSelection(2);
      if (change === "document") editor.commands.insertContent("changed");
      if (change === "mode") press(editor, "Escape");
      if (change === "surface") adapter.setFocusSurfaceActive(false);
      if (change === "dom-focus") {
        const input = document.createElement("input");
        document.body.append(input);
        input.focus();
      }
      const before = editor.state.doc;
      complete(plainContent("must not be inserted"));
      // Leaving Insert invalidates the read generation immediately. Its late
      // result must not overwrite the newer mode:normal feedback either.
      await pending;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() =>
        expect(adapter.vimSnapshot.action).toBe(
          change === "mode" ? "mode:normal" : "clipboard:paste:stale",
        ),
      );
      expect(editor.state.doc.eq(before)).toBe(true);
    },
  );

  it("does not fall back to rich clipboard data when plain text is unavailable", async () => {
    const { editor, adapter } = await harness({
      readExplicitClipboard: () => null,
    });
    const before = editor.state.doc;
    expect(pastePlain(editor).defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:plain:empty"),
    );
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("leaves IME composition and Normal's Ctrl-v bindings alone", async () => {
    const readExplicitClipboard = vi.fn(() => plainContent("text"));
    const { editor } = await harness({ readExplicitClipboard });
    pastePlain(editor, { isComposing: true });
    expect(readExplicitClipboard).not.toHaveBeenCalled();
    press(editor, "Escape");
    pastePlain(editor);
    expect(readExplicitClipboard).not.toHaveBeenCalled();
  });
});

describe("explicit plain Clipboard transport", () => {
  it.each([false, true])(
    "selects UTF-8 across ClipboardItems regardless of their order (reverse=%s)",
    async (reverse) => {
      const readPlain = vi.fn(async () => ({
        text: async () => String.raw`\u65e5\u672c\u8a9e`,
      }));
      const readUtf8 = vi.fn(async () => ({ text: async () => "日本語" }));
      const items = [
        { types: ["text/plain", "text/html"], getType: readPlain },
        { types: [UTF8_PLAIN_CLIPBOARD_MIME], getType: readUtf8 },
      ];
      vi.stubGlobal("navigator", {
        clipboard: {
          read: async () => (reverse ? [...items].reverse() : items),
        },
      });
      await expect(
        new BrowserVimClipboard().readExplicit("plain"),
      ).resolves.toMatchObject({
        sourceMime: UTF8_PLAIN_CLIPBOARD_MIME,
        content: "日本語",
      });
      expect(readPlain).not.toHaveBeenCalled();
      expect(readUtf8).toHaveBeenCalledExactlyOnceWith(
        UTF8_PLAIN_CLIPBOARD_MIME,
      );
    },
  );

  it("reads text/plain when HTML is also available", async () => {
    const getType = vi.fn(async () => ({ text: async () => "plain 日本語" }));
    const readText = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => [{ types: ["text/html", "text/plain"], getType }],
        readText,
      },
    });
    await expect(
      new BrowserVimClipboard().readExplicit("plain"),
    ).resolves.toEqual({
      availableTypes: ["text/html", "text/plain"],
      sourceMime: "text/plain",
      content: "plain 日本語",
    });
    expect(getType).toHaveBeenCalledExactlyOnceWith("text/plain");
    expect(readText).not.toHaveBeenCalled();
  });

  it("falls back to readText, never to HTML", async () => {
    const getType = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => [{ types: ["text/html"], getType }],
        readText: async () => "fallback",
      },
    });
    await expect(
      new BrowserVimClipboard().readExplicit("plain"),
    ).resolves.toMatchObject({
      sourceMime: "text/plain",
      content: "fallback",
    });
    expect(getType).not.toHaveBeenCalled();
  });
});
