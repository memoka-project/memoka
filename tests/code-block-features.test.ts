import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_HIGHLIGHT_MAX_UTF8_BYTES,
  codeFoldHiddenEntries,
  runCodeBlockFoldCommand,
  type CodeCopyResult,
} from "../app/src/editor/code-block";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  CODE_LANGUAGE_CATALOG,
  filterCodeLanguageCatalog,
} from "../app/src/core/code-blocks";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import type { CodeActionPickerRequest } from "../app/src/editor/tiptap-adapter";
import { BrowserVimClipboard } from "../app/src/vim/clipboard";

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

function textPosition(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.isText && node.text?.includes(text)) {
      result = position + node.text.indexOf(text);
      return false;
    }
    return result < 0;
  });
  if (result < 0) throw new Error(`Missing text: ${text}`);
  return result;
}

function codeContent(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `const line${index + 1} = ${index + 1}`,
  ).join("\n");
}

function codeBlock(blockId: string, text: string, language: string | null) {
  return {
    type: "codeBlock",
    attrs: { blockId, language },
    content: [{ type: "text", text }],
  };
}

describe("Code Block presentation and actions", () => {
  it("highlights an explicit language and folds only long blocks to five logical lines", async () => {
    const note = createNoteDocument(createUuidV7());
    const root = document.createElement("div");
    document.body.append(root);
    const copy = vi.fn<
      (blockId: string) => CodeCopyResult | Promise<CodeCopyResult>
    >(() => "copied");
    const editor = new Editor({
      element: root,
      extensions: productEditorExtensions(note, {
        directBodyOnly: true,
        onCopyCodeBlock: copy,
      }),
    });
    const blockId = createUuidV7();
    const text = codeContent(11);
    try {
      editor.commands.setContent({
        type: "doc",
        content: [codeBlock(blockId, text, "typescript")],
      });
      editor.commands.setTextSelection(textPosition(editor, "line1"));
      expect(root.querySelector(".hljs-keyword")?.textContent).toBe("const");
      expect(
        root
          .querySelector(".memoka-code-block")
          ?.getAttribute("data-code-expanded"),
      ).toBe("true");
      expect(defaultVimBlockSemantics.logicalLines(editor.view)).toHaveLength(
        11,
      );

      expect(runCodeBlockFoldCommand(editor.view, "close")).toMatchObject({
        changed: true,
      });
      expect(codeFoldHiddenEntries(editor.state)).toHaveLength(1);
      expect(
        root
          .querySelector(".memoka-code-block")
          ?.getAttribute("data-code-expanded"),
      ).toBe("false");
      expect(defaultVimBlockSemantics.logicalLines(editor.view)).toHaveLength(
        5,
      );
      expect(
        (root.querySelector(".memoka-code-block__fold") as HTMLElement).dataset
          .label,
      ).toBe("+6 lines");
      expect(
        Array.from(root.querySelectorAll(".memoka-code-block__hidden-lines"))
          .map((element) => element.textContent)
          .join(""),
      ).toBe(text.slice(text.indexOf("\nconst line6")));

      (
        root.querySelector(".memoka-code-block__copy") as HTMLButtonElement
      ).click();
      await Promise.resolve();
      expect(copy).toHaveBeenCalledExactlyOnceWith(blockId);

      expect(runCodeBlockFoldCommand(editor.view, "open")).toMatchObject({
        changed: true,
      });
      expect(defaultVimBlockSemantics.logicalLines(editor.view)).toHaveLength(
        11,
      );
    } finally {
      editor.destroy();
      note.doc.destroy();
      root.remove();
    }
  });

  it("highlights and preserves TOML through its Lowlight alias", () => {
    const note = createNoteDocument(createUuidV7());
    const root = document.createElement("div");
    document.body.append(root);
    const editor = new Editor({
      element: root,
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [codeBlock(createUuidV7(), 'title = "Memoka"', "toml")],
      });
      expect(editor.state.doc.firstChild?.attrs.language).toBe("toml");
      expect(root.querySelector(".hljs-attr")?.textContent).toBe("title");
      expect(root.querySelector(".hljs-string")?.textContent).toBe('"Memoka"');
    } finally {
      editor.destroy();
      note.doc.destroy();
      root.remove();
    }
  });

  it("keeps short, unknown, and oversized blocks plain without changing their language", () => {
    const note = createNoteDocument(createUuidV7());
    const root = document.createElement("div");
    document.body.append(root);
    const editor = new Editor({
      element: root,
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          codeBlock(createUuidV7(), "alpha", "unknown-language"),
          codeBlock(
            createUuidV7(),
            `const value = 1;${" ".repeat(CODE_HIGHLIGHT_MAX_UTF8_BYTES)}`,
            "typescript",
          ),
          codeBlock(createUuidV7(), codeContent(10), null),
        ],
      });
      expect(root.querySelectorAll("[class*='hljs-']")).toHaveLength(0);
      expect(editor.state.doc.firstChild?.attrs.language).toBe(
        "unknown-language",
      );
      expect(
        Array.from(root.querySelectorAll(".memoka-code-block"))
          .at(-1)
          ?.getAttribute("data-code-foldable"),
      ).toBe("false");
      expect(runCodeBlockFoldCommand(editor.view, "close")).toBeNull();
    } finally {
      editor.destroy();
      note.doc.destroy();
      root.remove();
    }
  });

  it("offers every built-in language and routes Space a to Code actions", async () => {
    expect(CODE_LANGUAGE_CATALOG.length).toBeGreaterThan(190);
    expect(filterCodeLanguageCatalog("abnf")).toMatchObject([{ id: "abnf" }]);
    expect(filterCodeLanguageCatalog("toml")).toMatchObject([
      { id: "toml", name: "TOML" },
    ]);

    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let request: CodeActionPickerRequest | null = null;
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onCodeActionPicker: (next) => {
        request = next;
      },
    });
    const blockId = createUuidV7();
    const clipboard = vi
      .spyOn(BrowserVimClipboard.prototype, "write")
      .mockResolvedValue("plain-text");
    try {
      editor.commands.setContent({
        type: "doc",
        content: [codeBlock(blockId, "const answer = 42", null)],
      });
      editor.commands.setTextSelection(textPosition(editor, "answer"));
      editor.commands.focus();
      press(editor, "Escape");
      press(editor, " ");
      press(editor, "a");
      const opened = request as unknown as CodeActionPickerRequest | null;
      expect(opened?.selection).toMatchObject({ blockId, language: null });
      expect(opened?.setLanguage("typescript")).toMatchObject({
        changed: true,
        language: "typescript",
      });
      expect(editor.state.doc.firstChild?.attrs.language).toBe("typescript");
      expect(root.querySelector(".hljs-keyword")?.textContent).toBe("const");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.firstChild?.attrs.language).toBeNull();
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.firstChild?.attrs.language).toBe("typescript");

      await opened?.copy();
      expect(clipboard).toHaveBeenCalledWith(
        { kind: "text", text: "const answer = 42" },
        editor.schema,
        expect.anything(),
      );
    } finally {
      clipboard.mockRestore();
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("keeps folds window-local and moves a hidden caret to the fifth line", () => {
    const note = createNoteDocument(createUuidV7());
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = new Editor({
      element: firstRoot,
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    const blockId = createUuidV7();
    first.commands.setContent({
      type: "doc",
      content: [codeBlock(blockId, codeContent(12), "javascript")],
    });
    const second = new Editor({
      element: secondRoot,
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      first.commands.setTextSelection(textPosition(first, "line12"));
      expect(
        runCodeBlockFoldCommand(first.view, "close-recursive"),
      ).toMatchObject({ changed: true });
      expect(first.state.selection.$from.parentOffset).toBe(
        codeContent(5).length,
      );
      expect(codeFoldHiddenEntries(first.state)).toHaveLength(1);

      const hiddenPosition = textPosition(first, "line12");
      const posAtCoords = vi
        .spyOn(first.view, "posAtCoords")
        .mockReturnValue({ pos: hiddenPosition, inside: 0 });
      const pointer = new MouseEvent("mousedown", {
        button: 0,
        clientX: 100,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      });
      firstRoot.querySelector(".memoka-code-block pre")?.dispatchEvent(pointer);
      expect(pointer.defaultPrevented).toBe(true);
      expect(codeFoldHiddenEntries(first.state)).toHaveLength(1);
      expect(first.state.selection.$from.parentOffset).toBe(
        codeContent(5).length,
      );
      posAtCoords.mockRestore();

      first.commands.setTextSelection(hiddenPosition);
      expect(codeFoldHiddenEntries(first.state)).toHaveLength(0);
      expect(
        firstRoot
          .querySelector(".memoka-code-block")
          ?.getAttribute("data-code-expanded"),
      ).toBe("true");

      expect(runCodeBlockFoldCommand(first.view, "close")).toMatchObject({
        changed: true,
      });
      expect(codeFoldHiddenEntries(first.state)).toHaveLength(1);
      expect(codeFoldHiddenEntries(second.state)).toHaveLength(0);
      expect(
        secondRoot
          .querySelector(".memoka-code-block")
          ?.getAttribute("data-code-expanded"),
      ).toBe("true");
    } finally {
      second.destroy();
      first.destroy();
      note.doc.destroy();
      firstRoot.remove();
      secondRoot.remove();
    }
  });

  it("restores a Window-local fold after restarting the application", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      initialTitle: "Code fold persistence",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: true,
    });
    const blockId = createUuidV7();
    attached.editor.commands.setContent({
      type: "doc",
      content: [codeBlock(blockId, codeContent(12), "javascript")],
    });
    attached.editor.commands.setTextSelection(1);
    expect(
      runCodeBlockFoldCommand(attached.editor.view, "close"),
    ).toMatchObject({ changed: true });
    await runtime.flush();
    expect(runtime.windows.get("window-1")?.collapsedCodeBlockIds).toEqual([
      blockId,
    ]);
    attached.adapter.destroy();
    runtime.destroy();
    root.remove();

    const reopened = await CoreRuntime.open(persistence);
    const reopenedRoot = document.createElement("div");
    document.body.append(reopenedRoot);
    const reopenedEditor = reopened.editorForTesting("window-1", reopenedRoot, {
      directBodyOnly: true,
    });
    try {
      expect(reopened.windows.get("window-1")?.collapsedCodeBlockIds).toEqual([
        blockId,
      ]);
      expect(codeFoldHiddenEntries(reopenedEditor.editor.state)).toHaveLength(
        1,
      );
    } finally {
      reopenedEditor.adapter.destroy();
      reopened.destroy();
      reopenedRoot.remove();
    }
  });
});
