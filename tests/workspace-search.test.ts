import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { noteBufferId } from "../app/src/core/application-state";
import {
  blockToYXml,
  createNoteDocument,
  type NoteBlock,
} from "../app/src/core/documents";
import {
  createSectionXml,
  insertChildSection,
  sectionBodyBlocks,
} from "../app/src/core/section-model";
import { createUuidV7 } from "../app/src/core/ids";
import {
  MemoryPersistencePort,
  type PersistencePort,
} from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { saveStableEditorPosition } from "../app/src/core/stable-position";
import {
  deriveWorkspaceSearchDocument,
  formatWorkspaceSearchAge,
  filterWorkspaceSearchCatalog,
  workspaceSearchMatchRanges,
  type WorkspaceSearchCatalog,
} from "../app/src/core/workspace-search";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_796_100_000_000 + seed, (target) => {
      target.fill((seed * 41) & 0xff);
      return target;
    });
  };
}

function press(
  editor: Editor,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

async function settle(runtime: CoreRuntime): Promise<void> {
  await runtime.flush();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await runtime.flush();
}

function editorRoot(): HTMLDivElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

describe("Memoka Workspace search", () => {
  it("indexes visible external Link labels without hidden mark attributes", () => {
    const noteId = createUuidV7();
    const blockId = createUuidV7();
    const note = createNoteDocument(noteId, [
      {
        type: "paragraph",
        blockId,
        content: [{ type: "text", text: "before visible after" }],
      },
    ]);
    const paragraph = sectionBodyBlocks(note.rootSection)[0];
    const text =
      paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
    if (!(text instanceof Y.XmlText)) throw new Error("Expected Y.XmlText");
    note.doc.transact(() => {
      text.format("before ".length, "visible".length, {
        link: {
          href: "https://hidden-url.example/path",
          target: "_blank",
          rel: "noopener noreferrer nofollow",
          class: null,
          title: null,
        },
      });
    });

    const document = deriveWorkspaceSearchDocument(note);
    const catalog: WorkspaceSearchCatalog = {
      documents: [document],
      failures: [],
    };
    expect(document.blocks).toContainEqual(
      expect.objectContaining({ blockId, text: "before visible after" }),
    );
    expect(filterWorkspaceSearchCatalog(catalog, "hidden-url", "body")).toEqual(
      [],
    );
    expect(
      filterWorkspaceSearchCatalog(catalog, "visible", "body")[0],
    ).toMatchObject({ blockId, matchOffset: "before ".length });
    note.doc.destroy();
  });

  it("derives Section titles, breadcrumbs and body results from NoteDoc CRDT state", () => {
    const ids = deterministicIds();
    const noteId = ids();
    const childSectionId = ids();
    const blocks: NoteBlock[] = [
      {
        type: "paragraph",
        blockId: ids(),
        content: [{ type: "text", text: "本文に検索対象があります" }],
      },
      {
        type: "image",
        blockId: ids(),
        attachmentId: ids(),
        altText: "設計図 image alt",
      },
      {
        type: "attachment",
        blockId: ids(),
        attachmentId: ids(),
        label: "検索資料 attachment label.pdf",
      },
    ];
    const note = createNoteDocument(noteId, blocks, "ＡＰＩ設計");
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(childSectionId, "日本語 Section"),
      );
    });
    const document = deriveWorkspaceSearchDocument(note);
    const catalog: WorkspaceSearchCatalog = {
      documents: [document],
      failures: [],
    };

    expect(filterWorkspaceSearchCatalog(catalog, "api")[0]).toMatchObject({
      kind: "title",
      title: "ＡＰＩ設計",
    });
    expect(
      filterWorkspaceSearchCatalog(catalog, "api", "title")[0],
    ).toMatchObject({
      kind: "title",
      title: "ＡＰＩ設計",
      parentPath: "/",
    });
    expect(
      filterWorkspaceSearchCatalog(catalog, "日本語 api", "title"),
    ).toHaveLength(1);
    expect(
      filterWorkspaceSearchCatalog(catalog, "api missing", "title"),
    ).toEqual([]);
    expect(
      filterWorkspaceSearchCatalog(catalog, "日本語 api", "title")[0],
    ).toMatchObject({
      kind: "title",
      sectionId: childSectionId,
      matchOffset: 0,
    });
    expect(
      filterWorkspaceSearchCatalog(catalog, "検索対象", "body")[0],
    ).toMatchObject({
      kind: "body",
      matchOffset: 3,
      preview: "本文に検索対象があります",
    });
    expect(
      filterWorkspaceSearchCatalog(catalog, "本文 検索対象", "body"),
    ).toHaveLength(1);
    expect(
      filterWorkspaceSearchCatalog(catalog, "image alt", "body")[0],
    ).toMatchObject({
      kind: "body",
      preview: "設計図 image alt",
    });
    expect(
      filterWorkspaceSearchCatalog(catalog, "attachment label", "body")[0],
    ).toMatchObject({
      kind: "body",
      preview: "検索資料 attachment label.pdf",
    });
    expect(filterWorkspaceSearchCatalog(catalog, "", "title", 1)).toHaveLength(
      1,
    );
    expect(() =>
      filterWorkspaceSearchCatalog(catalog, "x", "title", 0),
    ).toThrow("Workspace search result limit must be positive");
    note.doc.destroy();
  });

  it("projects the Vim logical-line model and stable source offsets", () => {
    const ids = deterministicIds();
    const paragraphId = ids();
    const listItemId = ids();
    const nestedItemId = ids();
    const tableRowId = ids();
    const codeId = ids();
    const imageId = ids();
    const note = createNoteDocument(ids(), [
      {
        type: "paragraph",
        blockId: paragraphId,
        content: [{ type: "text", text: "first" }],
      },
      {
        type: "bulletList",
        blockId: ids(),
        children: [
          {
            type: "listItem",
            blockId: listItemId,
            children: [
              {
                type: "paragraph",
                blockId: ids(),
                content: [{ type: "text", text: "parent item" }],
              },
              {
                type: "bulletList",
                blockId: ids(),
                children: [
                  {
                    type: "listItem",
                    blockId: nestedItemId,
                    children: [
                      {
                        type: "paragraph",
                        blockId: ids(),
                        content: [{ type: "text", text: "nested item" }],
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
        type: "table",
        blockId: ids(),
        children: [
          {
            type: "tableRow",
            blockId: tableRowId,
            children: [
              {
                type: "tableCell",
                blockId: ids(),
                children: [
                  {
                    type: "paragraph",
                    blockId: ids(),
                    content: [{ type: "text", text: "left" }],
                  },
                ],
              },
              {
                type: "tableCell",
                blockId: ids(),
                children: [
                  {
                    type: "paragraph",
                    blockId: ids(),
                    content: [{ type: "text", text: "right" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: "codeBlock", blockId: codeId, text: "one\ntwo" },
      {
        type: "image",
        blockId: imageId,
        attachmentId: ids(),
        altText: "diagram",
      },
    ]);
    const paragraph = sectionBodyBlocks(note.rootSection)[0] as Y.XmlElement;
    const hardBreak = new Y.XmlElement("hardBreak");
    const tail = new Y.XmlText();
    tail.insert(0, "second");
    paragraph.insert(paragraph.length, [hardBreak, tail]);

    const document = deriveWorkspaceSearchDocument(
      note,
      "logical",
      "",
      "2026-08-10T00:00:00.000Z",
    );
    expect(
      document.blocks.map(
        ({ blockId, text, logicalLineNumber, sourceOffset }) => ({
          blockId,
          text,
          logicalLineNumber,
          sourceOffset,
        }),
      ),
    ).toEqual([
      {
        blockId: paragraphId,
        text: "first",
        logicalLineNumber: 1,
        sourceOffset: 0,
      },
      {
        blockId: paragraphId,
        text: "second",
        logicalLineNumber: 2,
        sourceOffset: 6,
      },
      {
        blockId: listItemId,
        text: "parent item",
        logicalLineNumber: 3,
        sourceOffset: 0,
      },
      {
        blockId: nestedItemId,
        text: "nested item",
        logicalLineNumber: 4,
        sourceOffset: 0,
      },
      {
        blockId: tableRowId,
        text: "left | right",
        logicalLineNumber: 5,
        sourceOffset: 0,
      },
      { blockId: codeId, text: "one", logicalLineNumber: 6, sourceOffset: 0 },
      { blockId: codeId, text: "two", logicalLineNumber: 7, sourceOffset: 4 },
      {
        blockId: imageId,
        text: "diagram",
        logicalLineNumber: 8,
        sourceOffset: 0,
      },
    ]);
    const second = filterWorkspaceSearchCatalog(
      { documents: [document], failures: [] },
      "second",
      "body",
    )[0];
    expect(second).toMatchObject({
      logicalLineNumber: 2,
      lineIndex: 1,
      lineMatchOffset: 0,
      matchOffset: 6,
    });
    expect(workspaceSearchMatchRanges("ＡＰＩ api", "api")).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
    expect(
      workspaceSearchMatchRanges("alpha beta alpha", "beta alpha"),
    ).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 10 },
      { from: 11, to: 16 },
    ]);
    expect(
      formatWorkspaceSearchAge(
        "2026-08-09T23:59:50.000Z",
        Date.parse("2026-08-10T00:00:00.000Z"),
      ),
    ).toBe("10s");
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    expect(
      formatWorkspaceSearchAge(new Date(now - 8 * 60_000).toISOString(), now),
    ).toBe("8m");
    expect(
      formatWorkspaceSearchAge(
        new Date(now - 5 * 3_600_000).toISOString(),
        now,
      ),
    ).toBe("5h");
    expect(
      formatWorkspaceSearchAge(
        new Date(now - 9 * 86_400_000).toISOString(),
        now,
      ),
    ).toBe("9d");
    expect(
      formatWorkspaceSearchAge(
        new Date(now - 90 * 86_400_000).toISOString(),
        now,
      ),
    ).toBe("3mo");
    expect(
      formatWorkspaceSearchAge(
        new Date(now - 730 * 86_400_000).toISOString(),
        now,
      ),
    ).toBe("2y");
    note.doc.destroy();
  });

  it("orders title and body matches by note updated time", () => {
    const catalog: WorkspaceSearchCatalog = {
      documents: [
        {
          noteId: "older",
          title: "shared title",
          parentPath: "project",
          updatedAt: "2026-08-01T00:00:00.000Z",
          blocks: [
            {
              blockId: "older-block",
              kind: "body",
              sectionId: "older",
              text: "shared body",
              logicalLineNumber: 1,
              sectionLineNumber: 1,
              lineIndex: 0,
              sourceOffset: 0,
            },
          ],
        },
        {
          noteId: "newer",
          title: "shared title",
          parentPath: "project",
          updatedAt: "2026-08-02T00:00:00.000Z",
          blocks: [
            {
              blockId: "newer-block",
              kind: "body",
              sectionId: "newer",
              text: "shared body",
              logicalLineNumber: 1,
              sectionLineNumber: 1,
              lineIndex: 0,
              sourceOffset: 0,
            },
          ],
        },
      ],
      failures: [],
    };
    expect(
      filterWorkspaceSearchCatalog(catalog, "shared project", "title").map(
        ({ noteId }) => noteId,
      ),
    ).toEqual(["newer", "older"]);
    expect(
      filterWorkspaceSearchCatalog(catalog, "shared body", "body").map(
        ({ noteId }) => noteId,
      ),
    ).toEqual(["newer", "older"]);
  });

  it("scopes the shared title search to loaded Buffers and Trash roots", async () => {
    let now = "2026-08-01T00:00:00.000Z";
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => now,
      initialTitle: "first buffer",
    });
    const firstNoteId = runtime.noteId;
    now = "2026-08-02T00:00:00.000Z";
    const second = await runtime.createNoteAtEnd("window-1", "second buffer");

    expect(
      (
        await runtime.searchWorkspace("buffer", "title", 20, "buffers")
      ).results.map(({ noteId }) => noteId),
    ).toEqual([second.noteId, firstNoteId]);
    await runtime.closeBuffer(noteBufferId(firstNoteId));
    expect(
      (
        await runtime.searchWorkspace("buffer", "title", 20, "buffers")
      ).results.map(({ noteId }) => noteId),
    ).toEqual([second.noteId]);

    await runtime.moveNoteToTrash(second.noteId);
    const trash = await runtime.searchWorkspace("second", "title", 20, "trash");
    expect(trash).toMatchObject({ backend: "metadata", scope: "title" });
    expect(trash.results.map(({ noteId }) => noteId)).toEqual([second.noteId]);
    runtime.destroy();
  });

  it("opens an unloaded body result in one Window and records a Jump origin", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const first = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock: () => "2026-08-04T00:00:00.000Z",
      initialTitle: "source",
    });
    await addSecondWindow(first);
    const sourceNoteId = first.noteId;
    const target = await first.createNoteAtEnd("window-1", "target");
    await first.executeCommand({
      name: "note.replace_text",
      operationId: ids(),
      source: "internal",
      payload: {
        noteId: target.noteId,
        text: "before source 秘密の検索語 after",
      },
    });
    await settle(first);
    await first.openNote("window-1", sourceNoteId);
    await first.flush();
    first.destroy();

    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock: () => "2026-08-04T00:00:00.000Z",
    });
    expect(runtime.notes.has(target.noteId)).toBe(false);
    const catalog = await runtime.workspaceSearchCatalog();
    const result = filterWorkspaceSearchCatalog(
      catalog,
      "秘密の検索語",
      "body",
    )[0];
    expect(result).toMatchObject({ noteId: target.noteId, kind: "body" });
    expect(runtime.notes.has(target.noteId)).toBe(false);

    const sourceRoot = editorRoot();
    const source = runtime.editorForTesting("window-1", sourceRoot, {
      directBodyOnly: false,
    });
    source.editor.commands.setTextSelection(1);
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const navigation = await runtime.navigateWorkspaceSearchResult(
      "window-1",
      origin,
      result,
    );
    expect(navigation).toMatchObject({
      handled: true,
      detail: "jump:search:changed",
    });
    expect(navigation.destination).toBeUndefined();
    expect(runtime.windows.get("window-1")?.noteId).toBe(target.noteId);
    expect(runtime.windows.get("window-2")?.noteId).toBe(sourceNoteId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);
    source.adapter.destroy();
    sourceRoot.remove();

    const openedRoot = editorRoot();
    const opened = runtime.editorForTesting("window-1", openedRoot, {
      directBodyOnly: false,
    });
    let expectedPosition = -1;
    opened.editor.state.doc.descendants((node, position) => {
      const matchOffset = node.text?.indexOf("秘密の検索語") ?? -1;
      if (matchOffset >= 0) expectedPosition = position + matchOffset;
    });
    expect(expectedPosition).toBeGreaterThan(0);
    expect(opened.editor.state.selection.from).toBe(expectedPosition);
    expect(opened.adapter.vimSnapshot.action).toBe("jump:search:changed");

    press(opened.editor, "o", { ctrlKey: true, code: "KeyO" });
    await settle(runtime);
    expect(runtime.windows.get("window-1")?.noteId).toBe(sourceNoteId);

    opened.adapter.destroy();
    openedRoot.remove();
    runtime.destroy();
  });

  it("routes a child Section result by changing only Window-local focus", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "parent",
    });
    const noteId = runtime.noteId;
    const targetSectionId = createUuidV7();
    const note = runtime.getNoteHandle(noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(targetSectionId, "target child", [
          blockToYXml({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "section needle" }],
          }),
        ]),
      );
    });
    const root = editorRoot();
    const adapter = runtime.attachEditor("window-1", root);
    const origin = adapter.captureStablePosition();
    if (!origin) throw new Error("Stable origin was unavailable");
    const result = filterWorkspaceSearchCatalog(
      await runtime.workspaceSearchCatalog(),
      "section needle",
      "body",
    )[0]!;

    const navigation = await runtime.navigateWorkspaceSearchResult(
      "window-1",
      origin,
      result,
    );
    expect(navigation).toMatchObject({
      handled: true,
      detail: "jump:search:changed",
    });
    expect(
      runtime.snapshot().applicationWindow.windows["window-1"]?.bufferId,
    ).toBe(`note:${noteId}`);
    expect(runtime.windows.get("window-1")?.focusedSectionId).toBe(
      targetSectionId,
    );
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(1);

    adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("opens a result into an empty Window without inventing a Jump origin", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "source",
    });
    const target = await runtime.createNoteAtEnd("window-1", "empty target");
    await runtime.closeBuffer(noteBufferId(target.noteId));
    expect(runtime.windows.get("window-1")?.noteId).toBeNull();

    const result = filterWorkspaceSearchCatalog(
      await runtime.workspaceSearchCatalog(),
      "empty target",
    )[0];
    const navigation = await runtime.navigateWorkspaceSearchResult(
      "window-1",
      null,
      result,
    );

    expect(navigation).toMatchObject({
      handled: true,
      detail: "jump:search:changed",
    });
    expect(runtime.windows.get("window-1")?.noteId).toBe(target.noteId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(0);

    const root = editorRoot();
    const opened = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    expect(opened.editor.state.selection.from).toBe(1);
    expect(opened.adapter.vimSnapshot.action).toBe("jump:search:changed");

    opened.adapter.destroy();
    root.remove();
    runtime.destroy();
  });

  it("opens Workspace search from the Normal leader binding", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
    });
    const root = editorRoot();
    const onWorkspaceSearch = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onWorkspaceSearch,
      directBodyOnly: false,
    });
    editor.commands.focus();
    press(editor, "Escape");

    expect(press(editor, ",").defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.action).toBe("pending:leader");
    expect(press(editor, "f").defaultPrevented).toBe(true);
    expect(onWorkspaceSearch).toHaveBeenCalledTimes(1);
    expect(onWorkspaceSearch.mock.calls[0][0]).toMatchObject({
      noteId: runtime.noteId,
    });
    expect(onWorkspaceSearch.mock.calls[0][1]).toBe("title");
    expect(adapter.vimSnapshot.action).toBe("search:workspace:title:open");

    expect(press(editor, ",").defaultPrevented).toBe(true);
    expect(press(editor, "g").defaultPrevented).toBe(true);
    expect(onWorkspaceSearch.mock.calls[1][1]).toBe("body");
    expect(adapter.vimSnapshot.action).toBe("search:workspace:body:open");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("routes Leader utility commands through the product Vim session", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
    });
    const root = editorRoot();
    const onApplicationCommand = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onApplicationCommand,
      directBodyOnly: false,
    });
    editor.commands.focus();
    press(editor, "Escape");

    expect(press(editor, ",").defaultPrevented).toBe(true);
    expect(press(editor, "t").defaultPrevented).toBe(true);
    expect(onApplicationCommand).toHaveBeenCalledWith("utility.toggle-tree");
    expect(adapter.vimSnapshot.action).toBe("utility.toggle-tree:requested");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("opens the shared Application Command-line from Normal ':'", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
    });
    const root = editorRoot();
    const onCommandLine = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onCommandLine,
    });
    editor.commands.focus();
    press(editor, "Escape");

    expect(
      press(editor, ":", { code: "Semicolon", shiftKey: true })
        .defaultPrevented,
    ).toBe(true);
    expect(onCommandLine).toHaveBeenCalledTimes(1);
    expect(adapter.vimSnapshot.action).toBe("command-line:open");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("rejects stale origins and missing result notes without changing Jump state", async () => {
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: ids,
    });
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-1", "target");
    await runtime.openNote("window-1", sourceNoteId);
    const root = editorRoot();
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const origin = saveStableEditorPosition(
      runtime.noteDocument,
      source.editor.view,
    );
    const targetResult = filterWorkspaceSearchCatalog(
      await runtime.workspaceSearchCatalog(),
      "target",
    )[0];

    await runtime.openNote("window-1", target.noteId);
    await expect(
      runtime.navigateWorkspaceSearchResult("window-1", origin, targetResult),
    ).resolves.toEqual({ handled: false, detail: "jump:search:stale" });
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(0);

    await runtime.openNote("window-1", sourceNoteId);
    await expect(
      runtime.navigateWorkspaceSearchResult("window-1", origin, {
        ...targetResult,
        resultId: "missing:title",
        noteId: ids(),
      }),
    ).resolves.toEqual({
      handled: false,
      detail: "jump:search:missing-note",
    });
    expect(runtime.windows.get("window-1")?.noteId).toBe(sourceNoteId);
    expect(runtime.jumpListFor("window-1").snapshot().back).toHaveLength(0);

    source.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps title results when one unloaded NoteDoc cannot be read", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const first = await CoreRuntime.open(persistence, {
      idFactory: ids,
      initialTitle: "source",
    });
    const sourceNoteId = first.noteId;
    const target = await first.createNoteAtEnd("window-1", "recoverable title");
    await first.openNote("window-1", sourceNoteId);
    await first.flush();
    first.destroy();

    const failingPersistence: PersistencePort = {
      manifest: () => persistence.manifest(),
      commit: (request) => persistence.commit(request),
      compact: (request) => persistence.compact(request),
      loadLocalStates: () => persistence.loadLocalStates(),
      loadDocument: (kind, documentId) =>
        kind === "note" && documentId === target.noteId
          ? Promise.reject(new Error("injected search read failure"))
          : persistence.loadDocument(kind, documentId),
    };
    const runtime = await CoreRuntime.open(failingPersistence, {
      idFactory: ids,
    });

    const catalog = await runtime.workspaceSearchCatalog();
    expect(catalog.failures).toEqual([
      {
        noteId: target.noteId,
        title: "recoverable title",
        message: "injected search read failure",
      },
    ]);
    expect(
      filterWorkspaceSearchCatalog(catalog, "recoverable")[0],
    ).toMatchObject({
      noteId: target.noteId,
      kind: "title",
    });
    expect(runtime.notes.has(target.noteId)).toBe(false);

    runtime.destroy();
  });
});
