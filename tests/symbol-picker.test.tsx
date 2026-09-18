import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { SymbolPicker } from "../app/src/components/SymbolPicker";
import { SymbolText } from "../app/src/components/SymbolText";
import {
  filterSymbols,
  iconTokens,
  loadSymbolCatalog,
  textblockIconTokens,
} from "../app/src/core/symbols";
import {
  createNoteDocument,
  createReplicatedNoteDocumentFromSectionSnapshot,
  encodeProductDocument,
  loadProductDocument,
  readNoteTitle,
  type NoteDocument,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { sectionSnapshot } from "../app/src/core/section-model";
import { renderSectionMarkdown } from "../app/src/core/section-markdown-backup";
import * as Y from "yjs";
import { japaneseLineBreakPlan } from "../app/src/editor/japanese-line-breaking";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { loadSymbolIcons } from "../app/src/editor/symbol-icons";
import type { SymbolPickerRequest } from "../app/src/editor/tiptap-adapter";
import { textblockGraphemeStarts } from "../app/src/vim/graphemes";

const token = ":lucide-smile:";
function key(editor: Editor, value: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}
async function editorFixture() {
  const persistence = new MemoryPersistencePort();
  const runtime = await CoreRuntime.open(persistence);
  const root = document.createElement("div");
  document.body.append(root);
  let request: SymbolPickerRequest | null = null;
  const { editor, adapter } = runtime.editorForTesting("window-1", root, {
    onSymbolPicker: (value) => {
      request = value;
    },
  });
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before after" }] },
    ],
  });
  await runtime.flush();
  editor.commands.focus();
  const start = (() => {
    let position = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText) position = pos;
    });
    return position;
  })();
  editor.commands.setTextSelection(start + 7);
  key(editor, "i");
  return {
    persistence,
    runtime,
    editor,
    adapter,
    start,
    request: () => request,
    destroy: () => {
      adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  };
}

describe("emoji and Lucide symbols", () => {
  it("bundles complete, unique pinned catalogs and ranks exact names before prefixes", async () => {
    const catalog = await loadSymbolCatalog();
    expect(catalog.filter((item) => item.type === "Emoji")).toHaveLength(3953);
    expect(catalog.filter((item) => item.type === "Lucide")).toHaveLength(1848);
    expect(new Set(catalog.map((item) => item.id)).size).toBe(catalog.length);
    for (const emoji of ["👍🏽", "🇯🇵", "👨‍👩‍👧‍👦"])
      expect(filterSymbols(catalog, emoji, "Emoji")[0]?.value).toBe(emoji);
    expect(filterSymbols(catalog, "smile", "Lucide")[0]?.name).toBe(
      "face-slightly-smiling",
    );
    expect(filterSymbols(catalog, "grinning face", "Emoji")[0]?.value).toBe(
      "😀",
    );
    expect(
      iconTokens(`${token}:lucide-check::lucide-unknown-name:`).map(
        ({ name }) => name,
      ),
    ).toEqual(["face-slightly-smiling", "check"]);
    expect(iconTokens(":lucide-smile")).toEqual([]);
    expect(iconTokens(":lucide-constructor:")).toEqual([]);
    expect(filterSymbols(catalog, ":lucide-smile:", "Lucide")[0]?.name).toBe(
      "face-slightly-smiling",
    );
  });

  it("switches filters with Ctrl-1/2/3, retains the query and accepts a symbol in the shared pane", async () => {
    const apply = vi.fn(() => true);
    const close = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <SymbolPicker
        session={{ windowId: "window-1", apply, restoreFocus }}
        onClose={close}
      />,
    );
    const input = screen.getByRole("combobox");
    await waitFor(() =>
      expect(screen.getAllByRole("option")).toHaveLength(200),
    );
    fireEvent.change(input, { target: { value: "smile" } });
    fireEvent.keyDown(input, { key: "3", ctrlKey: true });
    expect((input as HTMLInputElement).value).toBe("smile");
    expect(
      screen
        .getByRole("button", { name: "Lucide · Ctrl-3" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "2", ctrlKey: true, isComposing: true });
    expect(
      screen
        .getByRole("button", { name: "Lucide · Ctrl-3" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "2", ctrlKey: true });
    expect(
      screen
        .getByRole("button", { name: "Emoji · Ctrl-2" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "1", ctrlKey: true });
    expect(
      screen
        .getByRole("button", { name: "All · Ctrl-1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.keyDown(input, { key: "3", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(apply).toHaveBeenCalledWith(":lucide-face-slightly-smiling:");
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledOnce());
  });

  it.each(["Escape", "c"])(
    "cancels without insertion using %s",
    async (key) => {
      const apply = vi.fn(() => true);
      const close = vi.fn();
      const restoreFocus = vi.fn();
      render(
        <SymbolPicker
          session={{ windowId: "window-1", apply, restoreFocus }}
          onClose={close}
        />,
      );
      fireEvent.keyDown(screen.getByRole("combobox"), {
        key,
        ctrlKey: key === "c",
      });
      expect(apply).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      await waitFor(() => expect(restoreFocus).toHaveBeenCalledOnce());
    },
  );

  it("keeps a failed origin open without moving focus to another editor", async () => {
    const close = vi.fn();
    render(
      <SymbolPicker
        session={{
          windowId: "window-1",
          apply: () => false,
          restoreFocus: vi.fn(),
        }}
        onClose={close}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")).toHaveLength(200),
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.getByText(/入力元が変更/)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it("renders title icons and preserves unknown notation", async () => {
    render(<SymbolText text={`Note ${token} :lucide-missing-name:`} />);
    expect(
      await screen.findByRole("img", { name: "face-slightly-smiling" }),
    ).toBeTruthy();
    expect(screen.getByText(/:lucide-missing-name:/)).toBeTruthy();
  });

  it("highlights title search matches without splitting an icon token", async () => {
    const { container } = render(
      <SymbolText
        text={`Note ${token} tail`}
        highlights={[
          { from: 0, to: 4 },
          { from: 6, to: 12 },
        ]}
      />,
    );
    const icon = await screen.findByRole("img", {
      name: "face-slightly-smiling",
    });
    expect(icon.closest("mark")).not.toBeNull();
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.textContent).toBe("Note  tail");
  });

  it("recognizes across marks, excludes inline code and code blocks, and exports canonical source", async () => {
    await loadSymbolIcons();
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
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
              { type: "text", text: "日:lucide-" },
              { type: "text", text: "smile:本", marks: [{ type: "bold" }] },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: token, marks: [{ type: "code" }] }],
          },
          { type: "codeBlock", content: [{ type: "text", text: token }] },
          { type: "sourceBlock", content: [{ type: "text", text: token }] },
        ],
      });
      const nodes: ReturnType<typeof editor.state.doc.nodeAt>[] = [];
      editor.state.doc.descendants((node) => {
        if (node.isTextblock) nodes.push(node);
      });
      expect(textblockIconTokens(nodes[0]!)).toHaveLength(1);
      expect(textblockGraphemeStarts(nodes[0]!)).toEqual([
        0,
        1,
        token.length + 1,
      ]);
      for (const node of nodes.slice(1))
        expect(textblockIconTokens(node!)).toEqual([]);
      expect(
        editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
      ).toHaveLength(1);
      expect(editor.getText()).toContain(token);
      expect(editor.getHTML()).not.toContain("memoka-symbol-source");
      const json = editor.getJSON();
      editor.commands.setContent(json);
      expect(editor.getJSON()).toEqual(json);
      expect(
        editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
      ).toHaveLength(1);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("inserts a selected symbol in Insert as an independent undo unit, with redo", async () => {
    const fixture = await editorFixture();
    try {
      const { editor, adapter, start } = fixture;
      editor.commands.setTextSelection({ from: start + 7, to: start + 12 });
      key(editor, "e", { ctrlKey: true });
      expect(fixture.request()).not.toBeNull();
      expect(fixture.request()!.apply(token)).toBe(true);
      expect(editor.getText()).toBe(`before ${token}`);
      expect(adapter.vimSnapshot.mode).toBe("insert");
      expect(editor.state.selection.head).toBe(start + 7 + token.length);
      key(editor, "Escape");
      key(editor, "u");
      expect(editor.getText()).toBe("before after");
      key(editor, "r", { ctrlKey: true });
      expect(editor.getText()).toBe(`before ${token}`);
      await fixture.runtime.flush();
    } finally {
      fixture.destroy();
    }
  });

  it("rejects selection/document changes and a destroyed origin", async () => {
    const fixture = await editorFixture();
    try {
      key(fixture.editor, "e", { ctrlKey: true });
      fixture.editor.commands.setTextSelection(fixture.start);
      expect(fixture.request()!.apply(token)).toBe(false);
      key(fixture.editor, "e", { ctrlKey: true });
      fixture.editor.commands.insertContent("changed");
      expect(fixture.request()!.apply(token)).toBe(false);
      key(fixture.editor, "e", { ctrlKey: true });
      fixture.adapter.destroy();
      expect(fixture.request()!.apply(token)).toBe(false);
    } finally {
      fixture.destroy();
    }
  });

  it("retains token text after a persisted runtime restart", async () => {
    const fixture = await editorFixture();
    key(fixture.editor, "e", { ctrlKey: true });
    expect(fixture.request()!.apply(`👍🏽${token}`)).toBe(true);
    await fixture.runtime.flush();
    fixture.destroy();
    const reopened = await CoreRuntime.open(fixture.persistence);
    const root = document.createElement("div");
    const { editor, adapter } = reopened.editorForTesting("window-1", root);
    try {
      expect(editor.getText()).toBe(`before 👍🏽${token}after`);
      await waitFor(() =>
        expect(
          editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
        ).toHaveLength(1),
      );
    } finally {
      adapter.destroy();
      reopened.destroy();
    }
  });

  it.each([
    "list",
    "table",
    "details",
    "quote",
    "alert",
    "code",
    "inline-code",
  ])(
    "inserts in %s without changing its surrounding structure",
    async (kind) => {
      await loadSymbolIcons();
      const fixture = await editorFixture();
      const paragraph: JSONContent = {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "target",
            ...(kind === "inline-code" ? { marks: [{ type: "code" }] } : {}),
          },
        ],
      };
      const blocks: Record<string, JSONContent> = {
        list: {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph] }],
        },
        table: {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [paragraph] }],
            },
          ],
        },
        details: {
          type: "details",
          attrs: { open: true },
          content: [
            {
              type: "detailsSummary",
              content: [{ type: "text", text: "Summary" }],
            },
            { type: "detailsBody", content: [paragraph] },
          ],
        },
        quote: { type: "blockquote", content: [paragraph] },
        alert: {
          type: "blockquote",
          attrs: { alertType: "note" },
          content: [paragraph],
        },
        code: {
          type: "codeBlock",
          content: [{ type: "text", text: "target" }],
        },
        "inline-code": paragraph,
      };
      try {
        const { editor } = fixture;
        editor.commands.setContent({ type: "doc", content: [blocks[kind]!] });
        let position = -1;
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === "target") position = pos + 3;
        });
        editor.commands.setTextSelection(position);
        key(editor, "e", { ctrlKey: true });
        expect(fixture.request()!.apply(token)).toBe(true);
        expect(editor.getText()).toContain(`tar${token}get`);
        expect(
          editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
        ).toHaveLength(kind === "code" || kind === "inline-code" ? 0 : 1);
        expect(fixture.adapter.vimSnapshot.mode).toBe("insert");
      } finally {
        fixture.destroy();
      }
    },
  );

  it("retains title and body tokens in replicated snapshots, synchronization and Markdown", async () => {
    await loadSymbolIcons();
    const noteId = createUuidV7();
    const note = createReplicatedNoteDocumentFromSectionSnapshot(
      noteId,
      {
        sectionId: noteId,
        title: `Title ${token}`,
        children: [],
        tags: [],
        body: [
          {
            type: "paragraph",
            attrs: { blockId: createUuidV7() },
            content: [{ type: "text", text: `本文 ${token} 👍🏽` }],
          },
        ],
      },
      createUuidV7(),
    );
    const replica = loadProductDocument(
      "note",
      noteId,
      encodeProductDocument(note),
      [],
      createUuidV7(),
    ) as NoteDocument;
    const editor = new Editor({ extensions: productEditorExtensions(note) });
    try {
      expect(
        editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
      ).toHaveLength(2);
      editor.commands.setTextSelection(1);
      editor.commands.insertContent(":lucide-check:");
      Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(note.doc));
      expect(readNoteTitle(replica)).toBe(`:lucide-check:Title ${token}`);
      const snapshot = sectionSnapshot(replica.rootSection);
      expect(renderSectionMarkdown(snapshot.title, snapshot.body)).toContain(
        token,
      );
      expect(renderSectionMarkdown(snapshot.title, snapshot.body)).toContain(
        ":lucide-check:",
      );
      const restored = loadProductDocument(
        "note",
        noteId,
        encodeProductDocument(replica),
      ) as NoteDocument;
      try {
        expect(sectionSnapshot(restored.rootSection)).toEqual(snapshot);
      } finally {
        restored.doc.destroy();
      }
    } finally {
      editor.destroy();
      note.doc.destroy();
      replica.doc.destroy();
    }
  });

  it("defers new token decoration during composition without removing existing icons", async () => {
    await loadSymbolIcons();
    const fixture = await editorFixture();
    try {
      key(fixture.editor, "e", { ctrlKey: true });
      expect(fixture.request()!.apply(token)).toBe(true);
      const editor = fixture.editor;
      expect(
        editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
      ).toHaveLength(1);
      editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      editor.commands.insertContent(token);
      expect(
        editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
      ).toHaveLength(1);
      editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      await waitFor(() =>
        expect(
          editor.view.dom.querySelectorAll(".memoka-symbol-icon"),
        ).toHaveLength(2),
      );
    } finally {
      fixture.destroy();
    }
  });

  it("keeps Japanese line-break widgets outside virtual icon ranges", async () => {
    const fixture = await editorFixture();
    try {
      fixture.editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `日本語${token}本文です。` }],
          },
        ],
      });
      let paragraph = fixture.editor.state.doc.firstChild!;
      fixture.editor.state.doc.descendants((node) => {
        if (node.type.name === "paragraph") paragraph = node;
      });
      for (const offset of japaneseLineBreakPlan(paragraph, "fine")
        ?.breakOffsets ?? [])
        expect(offset <= 3 || offset >= 3 + token.length).toBe(true);
    } finally {
      fixture.destroy();
    }
  });

  it("keeps Insert arrows, Shift selection, Ctrl-w and forward Delete outside icon source", async () => {
    const fixture = await editorFixture();
    try {
      const { editor, start } = fixture;
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `a${token}b` }],
          },
        ],
      });
      editor.commands.setTextSelection(start + 1);
      key(editor, "ArrowRight");
      expect(editor.state.selection.head).toBe(start + 1 + token.length);
      key(editor, "ArrowLeft", { shiftKey: true });
      expect(editor.state.selection.to - editor.state.selection.from).toBe(
        token.length,
      );
      editor.commands.setTextSelection(start + 1 + token.length);
      key(editor, "w", { ctrlKey: true });
      expect(editor.getText()).toBe("ab");
      editor.commands.insertContent(token);
      editor.commands.setTextSelection(start + 1);
      key(editor, "Delete");
      expect(editor.getText()).toBe("ab");
    } finally {
      fixture.destroy();
    }
  });

  it.each([token, `a${token}`, `${token}:lucide-check:`])(
    "keeps end-of-line and word motions on complete symbols: %s",
    async (text) => {
      const fixture = await editorFixture();
      try {
        const { editor, start } = fixture;
        editor.commands.setContent({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        });
        editor.commands.setTextSelection(start);
        key(editor, "Escape");
        key(editor, "$");
        const last = iconTokens(text).at(-1)!;
        expect(editor.state.selection.head).toBe(start + last.from);
        key(editor, "a");
        expect(editor.state.selection.head).toBe(start + text.length);
        key(editor, "Escape");
        expect(editor.state.selection.head).toBe(start + last.from);
        key(editor, "0");
        key(editor, "w");
        key(editor, "b");
        const offset = editor.state.selection.head - start;
        expect(
          iconTokens(text).some(
            (icon) => offset > icon.from && offset < icon.to,
          ),
        ).toBe(false);
      } finally {
        fixture.destroy();
      }
    },
  );
});
