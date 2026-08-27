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
      code: key === "/" ? "Slash" : key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("Memoka current NoteDoc search", () => {
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
