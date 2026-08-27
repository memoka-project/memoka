import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { productEditorExtensions } from "../app/src/editor/extensions";
import {
  BrowserVimClipboard,
  type ExplicitClipboardContent,
  MARKDOWN_CLIPBOARD_MIME,
  MEMOKA_CLIPBOARD_SCHEMA_VERSION,
  MEMOKA_CLIPBOARD_MIME,
  decodeVimClipboard,
  encodeVimClipboard,
  registerFromMarkdown,
} from "../app/src/vim/clipboard";
import type { VimRegister } from "../app/src/vim/editor-commands";
import { addSecondWindow } from "./helpers/runtime";
import { sectionSnapshot } from "../app/src/core/section-model";
import {
  largeMarkdownNoteFixture,
  paragraphPasteFixture,
} from "./helpers/large-note";

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

function paste(editor: Editor, formats: Record<string, string>): Event {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: Object.keys(formats),
      getData: (type: string) => formats[type] ?? "",
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function firstParagraphPosition(editor: Editor): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.type.name === "paragraph") result = position + 1;
  });
  if (result < 0) throw new Error("Editor has no paragraph");
  return result;
}

function directBodyJson(editor: Editor): unknown[] {
  const body = editor.state.doc.maybeChild(1);
  if (!body) return [];
  return body.content.content.flatMap((chunk) =>
    chunk.type.name === "bodyChunk" ? chunk.content.toJSON() : [],
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function listFixture() {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "internalSectionLink",
                    attrs: {
                      targetSectionId: "01900000-0000-7000-8000-0000000000aa",
                    },
                    content: [{ type: "text", text: "Linked note" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function structureRegister(editor: Editor): VimRegister {
  const list = editor.state.doc.firstChild;
  if (!list) throw new Error("List fixture is empty");
  return {
    kind: "structure",
    text: list.textContent,
    structureKind: "block",
    nodeNames: ["bulletList", "listItem", "paragraph", "internalSectionLink"],
    slice: editor.state.doc.slice(0, list.nodeSize),
  };
}

describe("Memoka structured Clipboard", () => {
  it("prepares a large plain-text paste asynchronously as one bounded Undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Large paste",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    attached.editor.commands.setTextSelection(
      firstParagraphPosition(attached.editor),
    );
    attached.editor.commands.focus();
    const text = paragraphPasteFixture({
      paragraphCount: 2_048,
      approximateParagraphBytes: 32,
    });
    runtime.noteDocument.undoManager.clear();
    runtime.noteDocument.undoManager.stopCapturing();

    const event = paste(attached.editor, { "text/plain": text });
    expect(event.defaultPrevented).toBe(true);
    expect(attached.adapter.vimSnapshot.action).toContain(
      "clipboard:paste:large:preparing",
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await runtime.flush();

    let paragraphs = 0;
    attached.editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") paragraphs += 1;
      return true;
    });
    expect(paragraphs).toBe(2_048);
    expect(attached.adapter.vimSnapshot.action).toBe(
      "clipboard:paste:large:changed",
    );
    expect(runtime.noteDocument.undoManager.undoStack).toHaveLength(1);
    expect(
      attached.editor.view.dom.querySelectorAll("p").length,
    ).toBeLessThanOrEqual(1_536);
    expect(attached.editor.commands.undo()).toBe(true);
    expect(attached.editor.state.doc.child(1).textContent).toBe("");

    attached.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("cancels a pending large plain-text paste with Escape", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "Large paste cancellation",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    attached.editor.commands.setTextSelection(
      firstParagraphPosition(attached.editor),
    );
    attached.editor.commands.focus();
    const before = attached.editor.getJSON();
    const event = paste(attached.editor, {
      "text/plain": paragraphPasteFixture({
        paragraphCount: 2_048,
        approximateParagraphBytes: 24,
      }),
    });
    expect(event.defaultPrevented).toBe(true);
    expect(press(attached.editor, "Escape").defaultPrevented).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(attached.editor.getJSON()).toEqual(before);
    expect(attached.adapter.vimSnapshot.action).toBe(
      "clipboard:paste:large:cancelled",
    );

    attached.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("imports plain external Markdown at an empty Root title, syncs, undoes and persists", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, { initialTitle: "" });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    const markdown = readFileSync(
      resolve(process.cwd(), "tests/fixtures/markdown-import.md"),
      "utf8",
    );
    first.editor.commands.setTextSelection(1);
    first.editor.commands.focus();

    const event = paste(first.editor, { "text/plain": markdown });
    expect(event.defaultPrevented).toBe(true);
    await runtime.flush();

    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.firstChild?.textContent).toBe(
        "Markdown Import Fixture",
      );
      expect(
        editor.state.doc.maybeChild(1)?.firstChild?.firstChild?.type.name,
      ).toBe("bulletList");
      expect(editor.state.doc.maybeChild(2)?.childCount).toBe(3);
    }
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === runtime.noteId)
        ?.title,
    ).toBe("Markdown Import Fixture");

    press(first.editor, "Escape");
    press(first.editor, "u");
    await runtime.flush();
    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.firstChild?.textContent).toBe("");
      expect(editor.state.doc.maybeChild(2)?.childCount).toBe(0);
    }

    expect(first.editor.commands.redo()).toBe(true);
    await runtime.flush();
    expect(first.editor.state.doc.firstChild?.textContent).toBe(
      "Markdown Import Fixture",
    );

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();

    const reopened = await CoreRuntime.open(persistence);
    const restored = sectionSnapshot(reopened.noteDocument.rootSection);
    expect(restored.title).toBe("Markdown Import Fixture");
    expect(restored.children).toHaveLength(3);
    expect(restored.children[0]?.title).toBe("Overview");
    reopened.destroy();
  });

  it("recovers a large plain Markdown title paste when WebKit omits all Clipboard types", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const markdown = largeMarkdownNoteFixture();
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      readPreferredClipboard: () =>
        Promise.resolve({
          availableTypes: ["text/plain;charset=utf-8"],
          internal: null,
          markdown: null,
          plain: markdown,
        }),
    });
    attached.editor.commands.setTextSelection(1);
    attached.editor.commands.focus();

    expect(new TextEncoder().encode(markdown).byteLength).toBeGreaterThan(
      128 * 1024,
    );
    const event = paste(attached.editor, {});
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(attached.adapter.vimSnapshot.action).toBe(
        "clipboard:paste:markdown-note:plain:changed",
      );
    });
    await runtime.flush();
    expect(attached.editor.state.doc.firstChild?.textContent).toBe(
      "Native large Markdown",
    );
    expect(attached.editor.getText()).toContain(
      "外部Markdownの転送確認 line 0123456789",
    );
    const imported = sectionSnapshot(runtime.noteDocument.rootSection);
    expect(imported.children.length).toBeGreaterThanOrEqual(2);
    expect(imported.children[0]?.title).toBe("Module 1");
    expect(imported.children[0]?.children[0]?.title).toBe("Details 1");

    attached.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("prefers whole-note Markdown to competing HTML only at the empty Root gate", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(1);
    editor.commands.focus();

    const event = paste(editor, {
      [MARKDOWN_CLIPBOARD_MIME]:
        "# Markdown title\n\nRoot body.\n\n## Markdown child",
      "text/html": "<p>HTML must not win at the whole-note gate</p>",
      "text/plain": "plain must not win",
    });
    expect(event.defaultPrevented).toBe(true);
    await runtime.flush();
    expect(adapter.vimSnapshot.action).toBe(
      "clipboard:paste:markdown-note:markdown:changed",
    );
    expect(editor.state.doc.firstChild?.textContent).toBe("Markdown title");
    expect(
      editor.state.doc.maybeChild(2)?.firstChild?.firstChild?.textContent,
    ).toBe("Markdown child");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("pastes plain Clipboard content explicitly as structured Markdown", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const markdown = "# Explicit heading\n\n- first\n- second";
    const first = runtime.editorForTesting("window-1", firstRoot, {
      readExplicitClipboard: () =>
        Promise.resolve({
          availableTypes: ["text/plain"],
          sourceMime: "text/plain",
          content: markdown,
        } satisfies ExplicitClipboardContent),
    });
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent("<p></p>");
    first.editor.commands.setTextSelection(1);
    first.editor.commands.focus();
    await runtime.flush();

    await expect(
      first.adapter.pasteExplicitClipboard("markdown"),
    ).resolves.toBe("changed");
    await runtime.flush();
    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.content.toJSON()).toMatchObject([
        { type: "paragraph" },
        { type: "bulletList" },
      ]);
      expect(editor.getText()).toContain("Explicit heading");
    }

    press(first.editor, "Escape");
    press(first.editor, "u");
    await runtime.flush();
    expect(first.editor.getText()).toBe("");
    expect(second.editor.getText()).toBe("");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("drops an explicit Clipboard result when the caret moves while reading", async () => {
    const pending = deferred<ExplicitClipboardContent | null>();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readExplicitClipboard: () => pending.promise,
    });
    editor.commands.setContent("<p>anchor</p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();

    const result = adapter.pasteExplicitClipboard("markdown");
    editor.commands.setTextSelection(2);
    pending.resolve({
      availableTypes: [MARKDOWN_CLIPBOARD_MIME],
      sourceMime: MARKDOWN_CLIPBOARD_MIME,
      content: "# stale",
    });

    await expect(result).resolves.toBe("stale");
    expect(editor.getText()).toBe("anchor");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("drops an explicit Clipboard result after the Window switches its active adapter", async () => {
    const pending = deferred<ExplicitClipboardContent | null>();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readExplicitClipboard: () => pending.promise,
    });
    editor.commands.setContent("<p>anchor</p>");
    editor.commands.setTextSelection(1);
    let currentTarget = true;

    const result = adapter.pasteExplicitClipboard(
      "markdown",
      () => currentTarget,
    );
    currentTarget = false;
    pending.resolve({
      availableTypes: [MARKDOWN_CLIPBOARD_MIME],
      sourceMime: MARKDOWN_CLIPBOARD_MIME,
      content: "# wrong note",
    });

    await expect(result).resolves.toBe("stale");
    expect(editor.getText()).toBe("anchor");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("encodes one transient payload plus HTML, Markdown and plain text", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent(listFixture());
    const register = structureRegister(editor);
    const formats = encodeVimClipboard(register, editor.schema);

    expect(JSON.parse(formats[MEMOKA_CLIPBOARD_MIME])).toMatchObject({
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "structure",
      structureKind: "block",
      text: "Linked note",
    });
    expect(formats["text/html"]).toContain("<ul");
    expect(formats["text/html"]).toContain("data-internal-section-id");
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "- [[01900000-0000-7000-8000-0000000000aa|Linked note]]",
    );
    expect(formats["text/plain"]).toBe(
      "- [[01900000-0000-7000-8000-0000000000aa|Linked note]]",
    );
    expect(
      encodeVimClipboard(
        { kind: "text", text: "# literal character selection" },
        editor.schema,
      )["text/plain"],
    ).toBe("# literal character selection");

    const decoded = decodeVimClipboard(
      formats[MEMOKA_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(decoded).toMatchObject({
      kind: "structure",
      text: "Linked note",
      structureKind: "block",
    });
    expect(
      decoded?.kind === "structure" && decoded.slice.content.toJSON(),
    ).toEqual(
      register.kind === "structure" ? register.slice.content.toJSON() : null,
    );
    editor.destroy();
    note.doc.destroy();
  });

  it("projects the current note title into copied Internal Link HTML and Markdown", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const resolveTitle = (noteId: string) =>
      noteId === "01900000-0000-7000-8000-0000000000aa" ? "Renamed note" : null;
    const editor = new Editor({
      extensions: productEditorExtensions(note, {
        directBodyOnly: true,
        resolveInternalLinkTitle: resolveTitle,
      }),
    });
    editor.commands.setContent(listFixture());
    const register = structureRegister(editor);
    const formats = encodeVimClipboard(register, editor.schema, resolveTitle);

    expect(formats["text/html"]).toContain("Renamed note");
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toContain(
      "[[01900000-0000-7000-8000-0000000000aa|Renamed note]]",
    );
    expect(
      JSON.parse(formats[MEMOKA_CLIPBOARD_MIME]) as { text: string },
    ).toMatchObject({ text: "Linked note" });

    editor.destroy();
    note.doc.destroy();
  });

  it("keeps characterwise marks in the internal, HTML and Markdown formats", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent(
      '<p><strong>Bold</strong> and <a href="/docs"><em>linked</em></a></p>',
    );
    const paragraph = editor.state.doc.firstChild;
    if (!paragraph) throw new Error("Paragraph fixture is empty");
    const register: VimRegister = {
      kind: "text",
      text: paragraph.textContent,
      slice: editor.state.doc.slice(1, 1 + paragraph.content.size),
    };
    const formats = encodeVimClipboard(register, editor.schema);

    expect(JSON.parse(formats[MEMOKA_CLIPBOARD_MIME])).toMatchObject({
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "text",
      text: "Bold and linked",
      slice: { openStart: 0, openEnd: 0 },
    });
    expect(formats["text/html"]).toContain("<strong>Bold</strong>");
    expect(formats["text/html"]).toContain('href="/docs"');
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "**Bold** and [_linked_](/docs)",
    );
    expect(formats["text/plain"]).toBe("Bold and linked");
    const decoded = decodeVimClipboard(
      formats[MEMOKA_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(decoded?.kind === "text" && decoded.slice?.content.toJSON()).toEqual(
      register.slice?.content.toJSON(),
    );

    editor.destroy();
    note.doc.destroy();
  });

  it("rejects malformed or unsupported internal payloads", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    expect(decodeVimClipboard("not-json", editor.schema)).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 99,
          kind: "text",
          text: "future",
        }),
        editor.schema,
      ),
    ).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
          kind: "text",
          text: "unsafe",
          slice: {
            content: [
              {
                type: "text",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
                text: "unsafe",
              },
            ],
            openStart: 0,
            openEnd: 0,
          },
        }),
        editor.schema,
      ),
    ).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 1,
          kind: "structure",
          text: "bad",
          structureKind: "block",
          nodeNames: ["unknownNode"],
          slice: {
            content: [{ type: "unknownNode" }],
            openStart: 0,
            openEnd: 0,
          },
        }),
        editor.schema,
      ),
    ).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 1,
          kind: "code-lines",
          text: "legacy();",
          lineCount: 1,
          codeBlockNodeName: "codeBlock",
          codeBlockAttrs: { language: "typescript" },
        }),
        editor.schema,
      ),
    ).toMatchObject({
      kind: "block-lines",
      behaviorId: "code-block",
      blockNodeName: "codeBlock",
      text: "legacy();",
    });
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 2,
          kind: "block-lines",
          text: "v2 source",
          lineCount: 1,
          behaviorId: "source-block",
          blockNodeName: "sourceBlock",
          blockAttrs: { sourceFormat: "markdown" },
        }),
        editor.schema,
      ),
    ).toMatchObject({
      kind: "block-lines",
      behaviorId: "source-block",
      blockNodeName: "sourceBlock",
      text: "v2 source",
    });
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 2,
          kind: "structure",
          text: "not available in v2",
          structureKind: "table-row",
          nodeNames: ["tableRow"],
          slice: {
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [{ type: "paragraph" }],
                  },
                ],
              },
            ],
            openStart: 0,
            openEnd: 0,
          },
        }),
        editor.schema,
      ),
    ).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 3,
          kind: "structure",
          text: "not a row",
          structureKind: "table-row",
          nodeNames: ["paragraph"],
          slice: {
            content: [{ type: "paragraph" }],
            openStart: 0,
            openEnd: 0,
          },
        }),
        editor.schema,
      ),
    ).toBeNull();
    expect(
      decodeVimClipboard(
        JSON.stringify({
          schemaVersion: 3,
          kind: "block-lines",
          text: "invalid open slice",
          lineCount: 1,
          behaviorId: "paragraph",
          blockNodeName: "paragraph",
          blockAttrs: {},
          slice: {
            content: [{ type: "text", text: "invalid open slice" }],
            openStart: 1,
            openEnd: 0,
          },
        }),
        editor.schema,
      ),
    ).toBeNull();
    editor.destroy();
    note.doc.destroy();
  });

  it("round-trips generic Source Block lines through the current Clipboard schema", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    const register: VimRegister = {
      kind: "block-lines",
      text: "| raw | table |",
      lineCount: 1,
      behaviorId: "source-block",
      blockNodeName: "sourceBlock",
      blockAttrs: {
        blockId: "01900000-0000-7000-8000-000000000002",
        sourceFormat: "markdown",
      },
    };
    const formats = encodeVimClipboard(register, editor.schema);

    expect(JSON.parse(formats[MEMOKA_CLIPBOARD_MIME])).toMatchObject({
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "block-lines",
      behaviorId: "source-block",
      blockNodeName: "sourceBlock",
    });
    expect(formats["text/html"]).toContain(
      'data-memoka-source-format="markdown"',
    );
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe("| raw | table |");
    expect(
      decodeVimClipboard(formats[MEMOKA_CLIPBOARD_MIME], editor.schema),
    ).toEqual(register);
    editor.destroy();
    note.doc.destroy();
  });

  it("preserves marked Paragraph Hard Break lines in the v3 block-lines payload", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "Bold" },
            { type: "hardBreak" },
            {
              type: "internalSectionLink",
              attrs: {
                targetSectionId: "01900000-0000-7000-8000-0000000000aa",
              },
              content: [{ type: "text", text: "Linked" }],
            },
          ],
        },
      ],
    });
    const paragraph = editor.state.doc.firstChild;
    if (!paragraph) throw new Error("Paragraph fixture is empty");
    const register: VimRegister = {
      kind: "block-lines",
      text: "Bold\nLinked",
      lineCount: 2,
      behaviorId: "paragraph",
      blockNodeName: "paragraph",
      blockAttrs: { ...paragraph.attrs },
      slice: editor.state.doc.slice(1, 1 + paragraph.content.size),
    };
    const formats = encodeVimClipboard(register, editor.schema);
    const payload = JSON.parse(formats[MEMOKA_CLIPBOARD_MIME]) as {
      slice?: { content?: unknown };
    };

    expect(payload.slice?.content).toEqual(register.slice?.content.toJSON());
    expect(formats["text/html"]).toContain("<strong>Bold</strong><br>");
    expect(formats["text/html"]).toContain("data-internal-section-id");
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "**Bold**  \n[[01900000-0000-7000-8000-0000000000aa|Linked]]",
    );
    expect(formats["text/plain"]).toBe("Bold\nLinked");
    const decoded = decodeVimClipboard(
      formats[MEMOKA_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(decoded).toMatchObject({
      kind: "block-lines",
      behaviorId: "paragraph",
      lineCount: 2,
    });
    expect(
      decoded?.kind === "block-lines" && decoded.slice?.content.toJSON(),
    ).toEqual(register.slice?.content.toJSON());

    editor.destroy();
    note.doc.destroy();
  });

  it("serializes nested lists and Source Block trailing text deterministically", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [{ type: "text", text: "| raw |  \n" }],
        },
      ],
    });
    const register: VimRegister = {
      kind: "structure",
      text: editor.getText(),
      structureKind: "block",
      nodeNames: ["bulletList", "listItem", "paragraph", "sourceBlock"],
      slice: editor.state.doc.slice(0, editor.state.doc.content.size),
    };
    const formats = encodeVimClipboard(register, editor.schema);

    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "- parent\n  - child\n\n| raw |  \n",
    );
    editor.destroy();
    note.doc.destroy();
  });

  it("round-trips blockquotes and horizontal rules through Markdown Clipboard", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "inside" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "horizontalRule" },
      ],
    });
    const register: VimRegister = {
      kind: "structure",
      text: editor.getText(),
      structureKind: "block",
      nodeNames: [
        "blockquote",
        "paragraph",
        "bulletList",
        "listItem",
        "horizontalRule",
      ],
      slice: editor.state.doc.slice(0, editor.state.doc.content.size),
    };

    const formats = encodeVimClipboard(register, editor.schema);
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "> quoted\n>\n> - inside\n\n---",
    );
    expect(formats["text/plain"]).toBe("> quoted\n>\n> - inside\n\n---");
    expect(formats["text/html"]).toContain("<blockquote");
    expect(formats["text/html"]).toContain("<hr");

    const decoded = registerFromMarkdown(
      formats[MARKDOWN_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(decoded).toMatchObject({
      kind: "structure",
      nodeNames: expect.arrayContaining(["blockquote", "horizontalRule"]),
    });
    expect(decoded?.slice?.content.toJSON()).toMatchObject([
      {
        type: "blockquote",
        content: [{ type: "paragraph" }, { type: "bulletList" }],
      },
      { type: "horizontalRule" },
    ]);
    editor.destroy();
    note.doc.destroy();
  });

  it("round-trips numbered and mixed nested lists through explicit Markdown", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 10 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "mixed child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "next" }],
                },
              ],
            },
          ],
        },
      ],
    });
    const register: VimRegister = {
      kind: "structure",
      text: editor.getText(),
      structureKind: "block",
      nodeNames: ["orderedList", "listItem", "paragraph", "bulletList"],
      slice: editor.state.doc.slice(0, editor.state.doc.content.size),
    };
    const formats = encodeVimClipboard(register, editor.schema);

    expect(formats["text/html"]).toContain("<ol");
    expect(formats["text/html"]).toContain('start="10"');
    expect(formats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "10. parent\n    - mixed child\n11. next",
    );
    const restored = registerFromMarkdown(
      formats[MARKDOWN_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(restored?.kind).toBe("structure");
    expect(
      restored?.kind === "structure" && restored.slice.content.toJSON(),
    ).toMatchObject([
      {
        type: "orderedList",
        attrs: { start: 10 },
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "parent" }],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "mixed child" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "next" }],
              },
            ],
          },
        ],
      },
    ]);
    editor.destroy();
    note.doc.destroy();
  });

  it("encodes a Table and a yanked TableRow as rich Clipboard formats", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { align: "left" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Name" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  attrs: { align: "right" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Value" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { align: "left" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "alpha" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  attrs: { align: "right" },
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          marks: [{ type: "code" }],
                          text: "a|b",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("Table fixture is empty");
    const tableRegister: VimRegister = {
      kind: "structure",
      text: table.textContent,
      structureKind: "block",
      nodeNames: ["table", "tableRow", "tableHeader", "tableCell", "paragraph"],
      slice: editor.state.doc.slice(0, table.nodeSize),
    };
    const tableFormats = encodeVimClipboard(tableRegister, editor.schema);

    expect(tableFormats["text/html"]).toContain("<table");
    expect(tableFormats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "| Name | Value |\n| :--- | ---: |\n| alpha | `a\\|b` |",
    );
    expect(tableFormats["text/plain"]).toBe(
      tableFormats[MARKDOWN_CLIPBOARD_MIME],
    );
    const restored = registerFromMarkdown(
      tableFormats[MARKDOWN_CLIPBOARD_MIME],
      editor.schema,
    );
    expect(
      restored?.kind === "structure" && restored.slice.content.toJSON(),
    ).toMatchObject([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{ type: "tableHeader" }, { type: "tableHeader" }],
          },
          {
            type: "tableRow",
            content: [{ type: "tableCell" }, { type: "tableCell" }],
          },
        ],
      },
    ]);

    let rowPosition = -1;
    let rowSize = 0;
    editor.state.doc.descendants((node, position) => {
      if (rowPosition < 0 && node.type.name === "tableRow") {
        rowPosition = position;
        rowSize = node.nodeSize;
        return false;
      }
      return true;
    });
    const rowRegister: VimRegister = {
      kind: "structure",
      text: "NameValue",
      structureKind: "table-row",
      nodeNames: ["tableRow"],
      slice: editor.state.doc.slice(rowPosition, rowPosition + rowSize),
    };
    const rowFormats = encodeVimClipboard(rowRegister, editor.schema);

    expect(JSON.parse(rowFormats[MEMOKA_CLIPBOARD_MIME])).toMatchObject({
      schemaVersion: MEMOKA_CLIPBOARD_SCHEMA_VERSION,
      kind: "structure",
      structureKind: "table-row",
    });
    expect(rowFormats["text/html"]).toMatch(/^<table><tbody><tr/u);
    expect(rowFormats[MARKDOWN_CLIPBOARD_MIME]).toBe(
      "| Name | Value |\n| :--- | ---: |",
    );
    expect(rowFormats["text/plain"]).toBe(rowFormats[MARKDOWN_CLIPBOARD_MIME]);
    expect(
      decodeVimClipboard(rowFormats[MEMOKA_CLIPBOARD_MIME], editor.schema),
    ).toMatchObject({
      kind: "structure",
      structureKind: "table-row",
      text: "NameValue",
    });
    editor.destroy();
    note.doc.destroy();
  });

  it("escapes paragraph-shaped text and inline Markdown punctuation", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "# literal *stars*" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "- item-shaped" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "code" }],
              text: "code`span",
            },
          ],
        },
      ],
    });
    const register: VimRegister = {
      kind: "structure",
      text: editor.getText(),
      structureKind: "block",
      nodeNames: ["paragraph"],
      slice: editor.state.doc.slice(0, editor.state.doc.content.size),
    };

    expect(
      encodeVimClipboard(register, editor.schema)[MARKDOWN_CLIPBOARD_MIME],
    ).toBe("\\# literal \\*stars\\*\n\n\\- item-shaped\n\n``code`span``");
    editor.destroy();
    note.doc.destroy();
  });

  it("pastes internal structure in Insert mode and refreshes block IDs", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent(listFixture());
    await runtime.flush();
    const originalListId = first.editor.state.doc.firstChild?.attrs.blockId;
    const formats = encodeVimClipboard(
      structureRegister(first.editor),
      first.editor.schema,
    );

    first.editor.commands.setContent("<p></p>");
    first.editor.commands.setTextSelection(1);
    first.editor.commands.focus();
    await runtime.flush();
    const event = paste(first.editor, {
      [MEMOKA_CLIPBOARD_MIME]: formats[MEMOKA_CLIPBOARD_MIME],
      "text/plain": formats["text/plain"],
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(first.adapter.vimSnapshot.action).toBe(
      "clipboard:paste:structure:changed",
    );
    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
      expect(editor.state.doc.firstChild?.textContent).toBe("Linked note");
      expect(editor.state.doc.firstChild?.attrs.blockId).not.toBe(
        originalListId,
      );
    }

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("wraps an internally copied TableRow in a fresh Table outside a Table", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { align: "right" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "copied cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();

    const sourceTable = editor.state.doc.firstChild;
    const sourceRow = sourceTable?.firstChild;
    if (!sourceTable || !sourceRow) throw new Error("Table fixture is empty");
    const sourceRowPosition = 1;
    const formats = encodeVimClipboard(
      {
        kind: "structure",
        text: sourceRow.textContent,
        structureKind: "table-row",
        nodeNames: ["tableRow", "tableCell", "paragraph"],
        slice: editor.state.doc.slice(
          sourceRowPosition,
          sourceRowPosition + sourceRow.nodeSize,
        ),
      },
      editor.schema,
    );
    const sourceIds = new Set<string>([
      sourceTable.attrs.blockId,
      sourceRow.attrs.blockId,
      sourceRow.firstChild?.attrs.blockId,
      sourceRow.firstChild?.firstChild?.attrs.blockId,
    ]);

    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();
    const event = paste(editor, {
      [MEMOKA_CLIPBOARD_MIME]: formats[MEMOKA_CLIPBOARD_MIME],
      "text/plain": formats["text/plain"],
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.action).toBe(
      "clipboard:paste:structure:changed",
    );
    const pastedTable = editor.state.doc.firstChild;
    expect(pastedTable?.type.name).toBe("table");
    expect(pastedTable?.textContent).toBe("copied cell");
    expect(pastedTable?.firstChild?.firstChild?.attrs.align).toBe("right");
    const pastedIds: string[] = [];
    pastedTable?.descendants((node) => {
      if (typeof node.attrs.blockId === "string") {
        pastedIds.push(node.attrs.blockId);
      }
    });
    if (typeof pastedTable?.attrs.blockId === "string") {
      pastedIds.push(pastedTable.attrs.blockId);
    }
    expect(pastedIds).toHaveLength(4);
    expect(pastedIds.every((blockId) => !sourceIds.has(blockId))).toBe(true);

    press(editor, "Escape");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("");
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("recovers filtered internal MIME through the native preferred-format reader", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const readPreferredClipboard = vi.fn();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      readPreferredClipboard,
    });
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent(listFixture());
    await runtime.flush();
    const originalListId = first.editor.state.doc.firstChild?.attrs.blockId;
    const formats = encodeVimClipboard(
      structureRegister(first.editor),
      first.editor.schema,
    );
    readPreferredClipboard.mockResolvedValue({
      availableTypes: Object.keys(formats),
      internal: formats[MEMOKA_CLIPBOARD_MIME],
      markdown: formats[MARKDOWN_CLIPBOARD_MIME],
    });

    first.editor.commands.setContent("<p></p>");
    first.editor.commands.setTextSelection(1);
    first.editor.commands.focus();
    await runtime.flush();
    const event = paste(first.editor, {
      "text/html": formats["text/html"],
      "text/plain": formats["text/plain"],
    });

    expect(event.defaultPrevented).toBe(true);
    expect(first.adapter.vimSnapshot.action).toBe("clipboard:paste:reading");
    await vi.waitFor(() => {
      expect(first.adapter.vimSnapshot.action).toBe(
        "clipboard:paste:structure:changed",
      );
    });
    await runtime.flush();

    expect(readPreferredClipboard).toHaveBeenCalledOnce();
    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
      expect(editor.state.doc.firstChild?.textContent).toBe("Linked note");
      expect(editor.state.doc.firstChild?.attrs.blockId).not.toBe(
        originalListId,
      );
    }

    press(first.editor, "Escape");
    press(first.editor, "u");
    await runtime.flush();
    expect(first.editor.getText()).toBe("");
    expect(second.editor.getText()).toBe("");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("recovers explicit Markdown after Wry normalizes its paste event to plain text", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const markdown = [
      "# Native Markdown",
      "",
      "- parent",
      "  - child",
      "",
      "> quoted",
      ">",
      "> - inside",
      "",
      "---",
      "",
      "```ts",
      "const native = true;",
      "```",
    ].join("\n");
    const first = runtime.editorForTesting("window-1", firstRoot, {
      readPreferredClipboard: () =>
        Promise.resolve({
          availableTypes: [MARKDOWN_CLIPBOARD_MIME],
          internal: null,
          markdown,
        }),
    });
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent("<p></p>");
    first.editor.commands.setTextSelection(1);
    first.editor.commands.focus();
    await runtime.flush();

    const event = paste(first.editor, { "text/plain": markdown });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(first.adapter.vimSnapshot.action).toBe(
        "clipboard:paste:markdown:changed",
      );
    });
    await runtime.flush();

    for (const editor of [first.editor, second.editor]) {
      expect(editor.state.doc.content.toJSON()).toMatchObject([
        { type: "paragraph" },
        { type: "bulletList" },
        { type: "blockquote" },
        { type: "horizontalRule" },
        { type: "codeBlock" },
      ]);
      expect(editor.getText()).toContain("Native Markdown");
      expect(editor.getText()).toContain("const native = true;");
    }

    press(first.editor, "Escape");
    press(first.editor, "u");
    await runtime.flush();
    expect(first.editor.getText()).toBe("");
    expect(second.editor.getText()).toBe("");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("keeps native plain text literal and isolated as one Undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readPreferredClipboard: () => Promise.resolve(null),
    });
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();

    const event = paste(editor, { "text/plain": "# literal" });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:plain:changed");
    });
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.getText()).toBe("# literal");

    press(editor, "Escape");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("uses HTML before native Markdown when a filtered internal payload is invalid", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readPreferredClipboard: () =>
        Promise.resolve({
          availableTypes: [
            MEMOKA_CLIPBOARD_MIME,
            "text/html",
            MARKDOWN_CLIPBOARD_MIME,
            "text/plain",
          ],
          internal: "{invalid",
          markdown: "# Markdown must not win",
        }),
    });
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();

    const event = paste(editor, {
      [MEMOKA_CLIPBOARD_MIME]: "",
      "text/html": "<p>HTML fallback</p>",
      [MARKDOWN_CLIPBOARD_MIME]: "",
      "text/plain": "plain fallback",
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:html:changed");
    });
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.getText()).toBe("HTML fallback");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("falls back to ordinary HTML when the native reader rejects", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readPreferredClipboard: () =>
        Promise.reject(new Error("native Clipboard unavailable")),
    });
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();

    const event = paste(editor, {
      "text/html": "<p><strong>External HTML</strong></p>",
      "text/plain": "External HTML",
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:html:changed");
    });
    await runtime.flush();
    expect(editor.getText()).toBe("External HTML");
    expect(editor.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(
      "bold",
    );

    press(editor, "Escape");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("drops a delayed native Clipboard result after the selection changes", async () => {
    const pending = deferred<{
      availableTypes: string[];
      internal: null;
      markdown: string;
    }>();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      readPreferredClipboard: () => pending.promise,
    });
    editor.commands.setContent("<p>anchor</p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();

    const event = paste(editor, { "text/plain": "# delayed" });
    expect(event.defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.action).toBe("clipboard:paste:reading");
    editor.commands.setTextSelection(2);
    pending.resolve({
      availableTypes: [MARKDOWN_CLIPBOARD_MIME],
      internal: null,
      markdown: "# delayed",
    });

    await vi.waitFor(() => {
      expect(adapter.vimSnapshot.action).toBe("clipboard:paste:stale");
    });
    expect(editor.getText()).toBe("anchor");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("pastes explicit Markdown as one durable structured Undo unit", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence);
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    first.editor.commands.setTextSelection(
      firstParagraphPosition(first.editor),
    );
    first.editor.commands.focus();
    await runtime.flush();

    const event = paste(first.editor, {
      [MARKDOWN_CLIPBOARD_MIME]: [
        "# Imported",
        "",
        "- first",
        "- second",
        "",
        "7. seventh",
        "8. eighth",
        "",
        "| unsupported | table |",
        "| --- | --- |",
        "| kept | raw |",
      ].join("\n"),
      "text/plain": "plain fallback",
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(first.adapter.vimSnapshot.action).toBe(
      "clipboard:paste:markdown:changed",
    );
    for (const editor of [first.editor, second.editor]) {
      expect(directBodyJson(editor)).toMatchObject([
        { type: "paragraph" },
        { type: "bulletList" },
        { type: "orderedList", attrs: { start: 7 } },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader" }, { type: "tableHeader" }],
            },
            {
              type: "tableRow",
              content: [{ type: "tableCell" }, { type: "tableCell" }],
            },
          ],
        },
      ]);
    }

    press(first.editor, "Escape");
    press(first.editor, "u");
    await runtime.flush();
    expect(first.editor.state.doc.child(1).childCount).toBe(1);
    expect(
      first.editor.state.doc.child(1).firstChild?.firstChild?.type.name,
    ).toBe("paragraph");
    expect(first.editor.state.doc.child(1).textContent).toBe("");
    expect(second.editor.state.doc.child(1).textContent).toBe("");

    const redo = new KeyboardEvent("keydown", {
      key: "r",
      code: "KeyR",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.editor.view.dom.dispatchEvent(redo);
    await runtime.flush();
    expect(
      first.editor.state.doc.child(1).firstChild?.firstChild?.type.name,
    ).toBe("paragraph");
    const noteId = runtime.noteId;

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();

    const reopened = await CoreRuntime.open(persistence);
    expect(reopened.noteId).toBe(noteId);
    const reopenedText = reopened.readNoteText();
    expect(reopenedText).toContain("Imported");
    expect(reopenedText).toContain("seventh");
    expect(reopenedText).toContain("unsupported\ntable");
    expect(reopenedText).toContain("kept\nraw");
    reopened.destroy();
  });

  it("falls back from a malformed internal payload to explicit Markdown", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent("<p></p>");
    editor.commands.setTextSelection(1);
    editor.commands.focus();
    await runtime.flush();

    const event = paste(editor, {
      [MEMOKA_CLIPBOARD_MIME]: "{not valid",
      [MARKDOWN_CLIPBOARD_MIME]: "# Recovered",
      "text/plain": "# Recovered",
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.action).toBe("clipboard:paste:markdown:changed");
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.getText()).toBe("# Recovered");
    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("falls back to text when a platform rejects rich ClipboardItem MIME", async () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    const write = vi.fn().mockRejectedValue(new Error("custom MIME rejected"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ClipboardItem",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class ClipboardItemStub {
        constructor(readonly items: Record<string, Blob>) {}
      },
    });

    try {
      await expect(
        new BrowserVimClipboard().write(
          { kind: "text", text: "fallback" },
          editor.schema,
        ),
      ).resolves.toBe("plain-text");
      expect(write).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith("fallback");
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (clipboardItemDescriptor) {
        Object.defineProperty(
          globalThis,
          "ClipboardItem",
          clipboardItemDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "ClipboardItem");
      }
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("reports a rich Clipboard write only in the Window that yanked", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ClipboardItem",
    );
    class ClipboardItemStub {
      constructor(readonly items: Record<string, Blob>) {}
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemStub,
    });
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);

    try {
      first.editor.commands.setContent("<p>rich copy</p>");
      first.editor.commands.setTextSelection(1);
      first.editor.commands.focus();
      press(first.editor, "Escape");
      press(first.editor, "y");
      press(first.editor, "y");
      expect(first.adapter.vimSnapshot.clipboard).toBe("writing");
      expect(second.adapter.vimSnapshot.clipboard).toBe("idle");
      await vi.waitFor(() => {
        expect(first.adapter.vimSnapshot.clipboard).toBe("rich");
      });
      expect(second.adapter.vimSnapshot.clipboard).toBe("idle");
      expect(writeText).not.toHaveBeenCalled();
      const item = write.mock.calls[0]?.[0]?.[0] as
        ClipboardItemStub | undefined;
      expect(Object.keys(item?.items ?? {}).sort()).toEqual(
        [
          MEMOKA_CLIPBOARD_MIME,
          "text/html",
          MARKDOWN_CLIPBOARD_MIME,
          "text/plain",
        ].sort(),
      );
    } finally {
      first.adapter.destroy();
      second.adapter.destroy();
      runtime.destroy();
      firstRoot.remove();
      secondRoot.remove();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (clipboardItemDescriptor) {
        Object.defineProperty(
          globalThis,
          "ClipboardItem",
          clipboardItemDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "ClipboardItem");
      }
    }
  });

  it("reports an unavailable Clipboard without changing the yank register", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);

    try {
      editor.commands.setContent("<p>local register</p>");
      editor.commands.setTextSelection(1);
      editor.commands.focus();
      press(editor, "Escape");
      press(editor, "y");
      press(editor, "y");
      await vi.waitFor(() => {
        expect(adapter.vimSnapshot.clipboard).toBe("unavailable");
      });
      expect(adapter.vimSnapshot.register).toBe("block: local register");
      expect(editor.getText()).toBe("local register");
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("does not let an older Clipboard failure overwrite a newer result", async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondWrite = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const writeText = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockReturnValueOnce(secondWrite);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ClipboardItem",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Reflect.deleteProperty(globalThis, "ClipboardItem");
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);

    try {
      editor.commands.setContent("<p>race</p>");
      editor.commands.setTextSelection(1);
      editor.commands.focus();
      press(editor, "Escape");
      press(editor, "y");
      press(editor, "y");
      press(editor, "y");
      press(editor, "y");
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(adapter.vimSnapshot.clipboard).toBe("writing");
      resolveSecond?.();
      await vi.waitFor(() => {
        expect(adapter.vimSnapshot.clipboard).toBe("plain-text");
      });
      rejectFirst?.(new Error("older write failed"));
      await Promise.resolve();
      await Promise.resolve();
      expect(adapter.vimSnapshot.clipboard).toBe("plain-text");
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (clipboardItemDescriptor) {
        Object.defineProperty(
          globalThis,
          "ClipboardItem",
          clipboardItemDescriptor,
        );
      }
    }
  });

  it("writes a Vim yank to the platform Clipboard without blocking the edit", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);

    try {
      editor.commands.setContent("<p>copy me</p>");
      editor.commands.setTextSelection(1);
      editor.commands.focus();
      press(editor, "Escape");
      press(editor, "y");
      press(editor, "y");
      expect(adapter.vimSnapshot.clipboard).toBe("writing");
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("copy me");
        expect(adapter.vimSnapshot.clipboard).toBe("plain-text");
      });
      expect(adapter.vimSnapshot.register).toBe("block: copy me");
      expect(editor.getText()).toBe("copy me");
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });
});
