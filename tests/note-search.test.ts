import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  blockToYXml,
  createNoteDocument,
  type NoteBlock,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  deriveNoteSearchProjection,
  noteSearchStatusMessage,
  selectNoteSearchMatch,
} from "../app/src/core/note-search";
import {
  createBodyChunks,
  createSectionXml,
  insertChildSection,
  sectionBodyBlocks,
} from "../app/src/core/section-model";

function paragraph(blockId: string, text: string): NoteBlock {
  return {
    type: "paragraph",
    blockId,
    content: [{ type: "text", text }],
  };
}

function editorRoot(): HTMLDivElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function press(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key === "/" || key === "?" ? "Slash" : key,
      shiftKey: key === "?",
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("Memoka current NoteDoc search", () => {
  it("uses the last / or ? direction for n and reverses it for N", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const blockId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([blockToYXml(paragraph(blockId, "needle x needle"))]),
      );
    });
    const root = editorRoot();
    const { adapter } = runtime.editorForTesting("window-1", root);
    const captured = adapter.captureNoteSearchOrigin();
    expect(captured).not.toBeNull();
    const originAt = (offset: number) => ({
      ...captured!,
      location: { sectionId: note.noteId, blockId, offset },
    });
    const backward = await runtime.searchNote(
      "window-1",
      originAt(9),
      "needle",
      1,
      "backward",
    );
    expect(backward).toMatchObject({
      direction: "backward",
      matchIndex: 0,
      destination: { offset: 0 },
    });
    expect(noteSearchStatusMessage(backward)).toBe("?needle · 1/2");
    expect(
      await runtime.repeatNoteSearch("window-1", originAt(0), "forward"),
    ).toMatchObject({
      direction: "backward",
      matchIndex: 1,
      destination: { offset: 9 },
      wrapped: true,
    });
    expect(
      await runtime.repeatNoteSearch("window-1", originAt(9), "backward"),
    ).toMatchObject({
      direction: "backward",
      matchIndex: 0,
      destination: { offset: 0 },
      wrapped: true,
    });
    expect(
      await runtime.repeatNoteSearch("window-1", originAt(0), "forward"),
    ).toMatchObject({ destination: { offset: 9 } });
    expect(
      await runtime.searchNote("window-1", originAt(0), "needle"),
    ).toMatchObject({ direction: "forward", destination: { offset: 9 } });
    expect(
      await runtime.repeatNoteSearch("window-1", originAt(9), "forward"),
    ).toMatchObject({ direction: "forward", destination: { offset: 0 } });
    expect(
      await runtime.searchNote("window-1", originAt(9), "", 1, "backward"),
    ).toMatchObject({
      query: "needle",
      direction: "backward",
      destination: { offset: 0 },
    });
    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("collects visible Editor words and paints removable search hints", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = editorRoot();
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent("<p>abc 検索</p>");
    const words = adapter.noteSearchVisibleWords();
    expect(words.map(({ text }) => text)).toContain("abc");
    expect(words.map(({ text }) => text)).toContain("検索");
    const target = words.find(({ text }) => text === "検索")?.positions[0];
    expect(target).toBeDefined();
    adapter.showNoteSearchHints([{ label: "A", position: target! }]);
    expect(root.querySelector('[data-vim-find-hint="A"]')).not.toBeNull();
    adapter.clearNoteSearchHints();
    expect(root.querySelector('[data-vim-find-hint="A"]')).toBeNull();
    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("keeps visible fuzzy words separate across Table Cells", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = editorRoot();
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(
      "<table><tbody><tr><td><p>abc</p></td><td><p>検索</p></td></tr></tbody></table>",
    );
    expect(adapter.noteSearchVisibleWords().map(({ text }) => text)).toEqual(
      expect.arrayContaining(["abc", "検索"]),
    );
    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("repeats a selected fuzzy Migemo word by the lowercase query in document order", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const blockId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml(paragraph(blockId, "検索 kensaku 検索")),
        ]),
      );
    });
    const root = editorRoot();
    const { adapter } = runtime.editorForTesting("window-1", root);
    const origin = adapter.captureNoteSearchOrigin();
    expect(origin).not.toBeNull();
    const entered = await runtime.searchFuzzyNote(
      "window-1",
      {
        ...origin!,
        location: { sectionId: note.noteId, blockId, offset: 0 },
      },
      "kensaku",
      "検索",
    );
    expect(entered).toMatchObject({
      handled: true,
      query: "kensaku",
      matchCount: 3,
      matchIndex: 1,
      destination: { blockId, offset: 3 },
    });
    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...origin!,
          location: { sectionId: note.noteId, blockId, offset: 3 },
        },
        "forward",
      ),
    ).resolves.toMatchObject({
      matchIndex: 2,
      destination: { blockId, offset: 11 },
    });
    const backward = await runtime.searchFuzzyNote(
      "window-1",
      {
        ...origin!,
        location: { sectionId: note.noteId, blockId, offset: 11 },
      },
      "kensaku",
      "検索",
      "backward",
    );
    expect(backward).toMatchObject({
      direction: "backward",
      matchIndex: 1,
      destination: { blockId, offset: 3 },
    });
    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...origin!,
          location: { sectionId: note.noteId, blockId, offset: 3 },
        },
        "forward",
      ),
    ).resolves.toMatchObject({
      direction: "backward",
      matchIndex: 0,
      destination: { blockId, offset: 0 },
    });
    const selected = await runtime.selectFuzzyNoteSearch(
      "window-1",
      origin!,
      "kensaku",
      "検索",
      { sectionId: note.noteId, blockId, offset: 0 },
    );
    expect(selected).toMatchObject({
      handled: true,
      query: "kensaku",
      matchCount: 3,
      matchIndex: 0,
      destination: { blockId, offset: 0 },
    });
    const next = await runtime.repeatNoteSearch(
      "window-1",
      {
        ...origin!,
        location: { sectionId: note.noteId, blockId, offset: 0 },
      },
      "forward",
    );
    expect(next).toMatchObject({
      handled: true,
      query: "kensaku",
      matchIndex: 1,
      destination: { blockId, offset: 3 },
    });
    expect(
      await runtime.repeatNoteSearch(
        "window-1",
        {
          ...origin!,
          location: { sectionId: note.noteId, blockId, offset: 3 },
        },
        "backward",
      ),
    ).toMatchObject({ matchIndex: 0, destination: { blockId, offset: 0 } });
    await expect(
      runtime.selectFuzzyNoteSearch("window-1", origin!, "different", "別語", {
        sectionId: note.noteId,
        blockId,
        offset: 999,
      }),
    ).resolves.toMatchObject({
      handled: false,
      detail: "search:note:stale-target",
    });
    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...origin!,
          location: { sectionId: note.noteId, blockId, offset: 0 },
        },
        "forward",
      ),
    ).resolves.toMatchObject({ query: "kensaku", matchIndex: 1 });
    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("indexes Section Headers and nested direct bodies in document order", () => {
    const noteId = createUuidV7();
    const rootBlockId = createUuidV7();
    const childId = createUuidV7();
    const childBlockId = createUuidV7();
    const note = createNoteDocument(
      noteId,
      [paragraph(rootBlockId, "alpha 日本語 alpha")],
      "日本語メモ",
    );
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(childId, "子日本語", [
          blockToYXml(paragraph(childBlockId, "かな日本語")),
        ]),
      );
    });

    const projection = deriveNoteSearchProjection(note, "日本語");
    expect(
      projection.matches.map(({ sectionId, blockId, offset }) => ({
        sectionId,
        blockId,
        offset,
      })),
    ).toEqual([
      { sectionId: noteId, blockId: null, offset: 0 },
      { sectionId: noteId, blockId: rootBlockId, offset: 6 },
      { sectionId: childId, blockId: null, offset: 1 },
      { sectionId: childId, blockId: childBlockId, offset: 2 },
    ]);
    expect(
      deriveNoteSearchProjection(note, "日本語", childId).matches.map(
        ({ sectionId, blockId }) => ({ sectionId, blockId }),
      ),
    ).toEqual([
      { sectionId: childId, blockId: null },
      { sectionId: childId, blockId: childBlockId },
    ]);

    expect(
      selectNoteSearchMatch(
        projection,
        { sectionId: noteId, blockId: rootBlockId, offset: 6 },
        "forward",
      ),
    ).toMatchObject({
      index: 2,
      wrapped: false,
      match: { sectionId: childId, blockId: null, offset: 1 },
    });
    expect(
      selectNoteSearchMatch(
        projection,
        { sectionId: noteId, blockId: null, offset: 0 },
        "backward",
      ),
    ).toMatchObject({
      index: 3,
      wrapped: true,
      match: { sectionId: childId, blockId: childBlockId },
    });

    note.doc.destroy();
  });

  it("uses literal Japanese-friendly normalization and wraps counted repeats", () => {
    const noteId = createUuidV7();
    const blockId = createUuidV7();
    const note = createNoteDocument(
      noteId,
      [paragraph(blockId, "Ａbc abc ABC")],
      "",
    );
    const projection = deriveNoteSearchProjection(note, "abc");
    expect(projection.matches.map(({ offset }) => offset)).toEqual([0, 4, 8]);
    expect(
      selectNoteSearchMatch(
        projection,
        { sectionId: noteId, blockId, offset: 4 },
        "forward",
        3,
      ),
    ).toMatchObject({ index: 1, wrapped: true });
    expect(deriveNoteSearchProjection(note, "").matches).toEqual([]);

    note.doc.destroy();
  });

  it("searches nested list, table, code and image text without flattening a second SSOT", () => {
    const noteId = createUuidV7();
    const listParagraphId = createUuidV7();
    const tableParagraphId = createUuidV7();
    const codeId = createUuidV7();
    const imageId = createUuidV7();
    const note = createNoteDocument(noteId, [
      {
        type: "bulletList",
        blockId: createUuidV7(),
        children: [
          {
            type: "listItem",
            blockId: createUuidV7(),
            children: [paragraph(listParagraphId, "リスト固有語")],
          },
        ],
      },
      {
        type: "table",
        blockId: createUuidV7(),
        children: [
          {
            type: "tableRow",
            blockId: createUuidV7(),
            children: [
              {
                type: "tableCell",
                blockId: createUuidV7(),
                children: [paragraph(tableParagraphId, "表の固有語")],
              },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        blockId: codeId,
        text: "const 固有語 = true;",
      },
      {
        type: "image",
        blockId: imageId,
        attachmentId: createUuidV7(),
        altText: "画像固有語",
      },
    ]);

    expect(
      deriveNoteSearchProjection(note, "固有語").matches.map(
        ({ blockId }) => blockId,
      ),
    ).toEqual([listParagraphId, tableParagraphId, codeId, imageId]);
    note.doc.destroy();
  });

  it("keeps search and wrap inside the current Focused Section subtree", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const firstId = createUuidV7();
    const nestedId = createUuidV7();
    const secondId = createUuidV7();
    const firstBlockId = createUuidV7();
    const nestedBlockId = createUuidV7();
    const secondBlockId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(
          firstId,
          "first",
          [blockToYXml(paragraph(firstBlockId, "needle first"))],
          [
            createSectionXml(nestedId, "nested", [
              blockToYXml(paragraph(nestedBlockId, "needle nested")),
            ]),
          ],
        ),
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(secondId, "second", [
          blockToYXml(paragraph(secondBlockId, "needle sibling-only")),
        ]),
      );
    });
    await runtime.focusSection("window-1", note.noteId, firstId);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(firstId);

    const focusedRoot = editorRoot();
    const onNoteSearch = vi.fn();
    const focused = runtime.editorForTesting("window-1", focusedRoot, {
      directBodyOnly: false,
      onNoteSearch,
    });
    press(focused.editor, "Escape");
    press(focused.editor, "/");
    expect(onNoteSearch).toHaveBeenCalledTimes(1);
    const undoDepth = note.undoManager.undoStack.length;

    const navigation = await runtime.searchNote(
      "window-1",
      onNoteSearch.mock.calls[0]![0],
      "needle",
    );
    expect(navigation).toMatchObject({
      handled: true,
      matchCount: 2,
      matchIndex: 0,
      destination: {
        kind: "note-search-match",
        sectionId: firstId,
        blockId: firstBlockId,
      },
    });
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(firstId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);
    expect(note.undoManager.undoStack).toHaveLength(undoDepth);

    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...onNoteSearch.mock.calls[0]![0],
          location: {
            sectionId: firstId,
            blockId: firstBlockId,
            offset: 0,
          },
        },
        "forward",
      ),
    ).resolves.toMatchObject({
      handled: true,
      matchCount: 2,
      matchIndex: 1,
      destination: {
        sectionId: nestedId,
        blockId: nestedBlockId,
      },
    });
    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...onNoteSearch.mock.calls[0]![0],
          location: {
            sectionId: nestedId,
            blockId: nestedBlockId,
            offset: 0,
          },
        },
        "forward",
      ),
    ).resolves.toMatchObject({
      handled: true,
      matchCount: 2,
      matchIndex: 0,
      wrapped: true,
      destination: {
        sectionId: firstId,
        blockId: firstBlockId,
      },
    });
    await runtime.focusSection("window-1", note.noteId, note.noteId);
    await expect(
      runtime.repeatNoteSearch(
        "window-1",
        {
          ...onNoteSearch.mock.calls[0]![0],
          location: {
            sectionId: nestedId,
            blockId: nestedBlockId,
            offset: 0,
          },
        },
        "forward",
      ),
    ).resolves.toMatchObject({
      handled: true,
      matchCount: 3,
      matchIndex: 2,
      destination: {
        sectionId: secondId,
        blockId: secondBlockId,
      },
    });

    await runtime.focusSection("window-1", note.noteId, firstId);
    await expect(
      runtime.searchNote(
        "window-1",
        onNoteSearch.mock.calls[0]![0],
        "sibling-only",
      ),
    ).resolves.toMatchObject({ handled: false, matchCount: 0 });
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(firstId);

    focused.adapter.destroy();
    focusedRoot.remove();
    runtime.destroy();
  });

  it("repeats the last pattern with n and N without reopening the input", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      initialTitle: "root",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const blockId = createUuidV7();
    note.doc.transact(() => {
      const body = note.body;
      body.delete(0, body.length);
      body.insert(0, [
        ...createBodyChunks([
          blockToYXml(paragraph(blockId, "needle x needle")),
        ]),
      ]);
    });
    const linkHref = "https://hidden-url.example/path";
    const paragraphElement = sectionBodyBlocks(note.rootSection)[0];
    const text =
      paragraphElement instanceof Y.XmlElement ? paragraphElement.get(0) : null;
    if (!(text instanceof Y.XmlText))
      throw new Error("Expected paragraph text");
    note.doc.transact(() => {
      text.format(0, "needle".length, {
        link: {
          href: linkHref,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
          class: null,
          title: null,
        },
      });
    });
    expect(
      deriveNoteSearchProjection(note, "needle").units.find(
        (unit) => unit.blockId === blockId,
      )?.text,
    ).toBe("needle x needle");
    expect(deriveNoteSearchProjection(note, "hidden-url").matches).toEqual([]);
    const root = editorRoot();
    const onNoteSearch = vi.fn();
    const onMessage = vi.fn();
    const onCaretExternalLinkChange = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      onNoteSearch,
      onMessage,
      onCaretExternalLinkChange,
    });
    const anchor = root.querySelector<HTMLAnchorElement>("a[href]");
    expect(anchor?.textContent).toBe("needle");
    expect(anchor?.title).toBe(linkHref);
    press(editor, "Escape");
    press(editor, "/");
    const origin = onNoteSearch.mock.calls[0]![0];
    const first = await runtime.searchNote("window-1", origin, "needle");
    if (!first.destination) throw new Error("Search destination was missing");
    adapter.applyNavigationDestination(first.destination, first.detail);
    expect(onCaretExternalLinkChange).toHaveBeenLastCalledWith(linkHref);

    let blockStart = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.attrs.blockId === blockId) {
        blockStart = position + 1;
        return false;
      }
      return blockStart < 0;
    });
    expect(editor.state.selection.from).toBe(blockStart);

    press(editor, "n");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.state.selection.from).toBe(blockStart + 9);
    expect(onMessage).toHaveBeenLastCalledWith("/needle · 2/2");
    expect(onCaretExternalLinkChange).toHaveBeenLastCalledWith(null);
    press(editor, "N");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.state.selection.from).toBe(blockStart);
    expect(onMessage).toHaveBeenLastCalledWith("/needle · 1/2");
    expect(onCaretExternalLinkChange).toHaveBeenLastCalledWith(linkHref);

    note.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, "needle only");
    });
    press(editor, "/");
    const afterEditOrigin = onNoteSearch.mock.calls.at(-1)?.[0];
    if (!afterEditOrigin) throw new Error("Edited search origin was missing");
    await expect(
      runtime.repeatNoteSearch("window-1", afterEditOrigin, "forward"),
    ).resolves.toMatchObject({ handled: true, matchCount: 1 });

    adapter.destroy();
    root.remove();
    runtime.destroy();
  });
});
