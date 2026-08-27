import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createNoteDocument,
  type DocumentKind,
} from "../app/src/core/documents";
import { CoreRuntime } from "../app/src/core/runtime";
import { addSecondWindow } from "./helpers/runtime";
import { createUuidV7 } from "../app/src/core/ids";
import {
  MemoryPersistencePort,
  type PersistenceCompactionRequest,
  type PersistenceCommitRequest,
  type PersistenceCommitResponse,
  type PersistenceManifest,
  type PersistencePort,
  type PersistedDocument,
  type PersistedLocalState,
} from "../app/src/core/persistence";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import { productEditorExtensions } from "../app/src/editor/extensions";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_795_435_200_000 + seed, (target) => {
      target.fill((seed * 17) & 0xff);
      return target;
    });
  };
}

function firstParagraphPosition(editor: Editor): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.type.name === "paragraph") result = position + 1;
  });
  if (result < 0) throw new Error("Editor has no paragraph");
  return result;
}

function bodyChunk(content: Array<Record<string, unknown>>) {
  return [
    {
      type: "bodyChunk",
      attrs: { chunkId: createUuidV7() },
      content,
    },
  ];
}

class RejectNextEditorCommitPort implements PersistencePort {
  private remainingFailures = 2;
  private armed = false;

  constructor(private readonly backing = new MemoryPersistencePort()) {}

  rejectNextEditorCommit(): void {
    this.armed = true;
  }

  manifest(): Promise<PersistenceManifest> {
    return this.backing.manifest();
  }

  commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    if (
      this.armed &&
      request.scope === "workspace-structure" &&
      request.documents.some(({ kind }) => kind === "note") &&
      this.remainingFailures > 0
    ) {
      this.remainingFailures -= 1;
      return Promise.reject(new Error("injected editor persistence failure"));
    }
    return this.backing.commit(request);
  }

  compact(
    request: PersistenceCompactionRequest,
  ): Promise<PersistenceCommitResponse> {
    return this.backing.compact(request);
  }

  loadDocument(
    kind: DocumentKind,
    documentId: string,
  ): Promise<PersistedDocument> {
    return this.backing.loadDocument(kind, documentId);
  }

  loadLocalStates(): Promise<PersistedLocalState[]> {
    return this.backing.loadLocalStates();
  }
}

class LocalStateCountingPort extends MemoryPersistencePort {
  localUiCommits = 0;

  override commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    if (request.scope === "local-ui") this.localUiCommits += 1;
    return super.commit(request);
  }
}

describe("Memoka TipTap adapter", () => {
  it("changes the Internal Link label revision only for Header edits", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-12T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const before = runtime.snapshot().internalLinkLabelRevision;

    editor.commands.insertContentAt(firstParagraphPosition(editor), "本文");
    await runtime.flush();
    expect(runtime.snapshot().internalLinkLabelRevision).toBe(before);

    let headerPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (headerPosition < 0 && node.type.name === "sectionHeader") {
        headerPosition = position + 1 + node.content.size;
      }
    });
    expect(headerPosition).toBeGreaterThan(0);
    editor.commands.insertContentAt(headerPosition, "見出し");
    await runtime.flush();
    expect(runtime.snapshot().internalLinkLabelRevision).toBe(before + 1);

    await runtime.reorderNote(runtime.noteId, "down");
    expect(runtime.snapshot().internalLinkLabelRevision).toBe(before + 1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("debounces rapid selection persistence after the next paint", async () => {
    const persistence = new LocalStateCountingPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-08-12T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setContent({
      type: "section",
      content: [
        {
          type: "sectionHeader",
          attrs: { sectionId: runtime.noteId, tags: "[]" },
          content: [{ type: "text", text: "Selection persistence" }],
        },
        {
          type: "sectionBody",
          content: bodyChunk([
            {
              type: "paragraph",
              attrs: { blockId: createUuidV7() },
              content: [{ type: "text", text: "abcdef" }],
            },
          ]),
        },
        { type: "sectionChildren" },
      ],
    });
    await runtime.flush();
    const before = persistence.localUiCommits;
    const start = firstParagraphPosition(editor);

    editor.commands.setTextSelection(start + 1);
    editor.commands.setTextSelection(start + 2);
    editor.commands.setTextSelection(start + 3);

    expect(persistence.localUiCommits).toBe(before);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    expect(persistence.localUiCommits).toBe(before);
    await new Promise((resolve) => window.setTimeout(resolve, 140));
    await runtime.flush();
    expect(persistence.localUiCommits).toBe(before + 1);
    expect(runtime.windows.get("window-1")?.selection).toEqual({
      anchor: start + 3,
      head: start + 3,
    });

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("persists scroll from the explicit Window scroll container", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const scroll = document.createElement("div");
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    const adapter = runtime.attachEditor("window-1", root, {
      scrollElement: scroll,
    });

    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    scroll.scrollTop = 137;
    scroll.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    await runtime.flush();
    expect(runtime.windows.get("window-1")?.scrollTop).toBe(137);

    adapter.destroy();
    runtime.destroy();
    scroll.remove();
  });

  it("moves an offscreen caret to the nearest visible logical line without scrolling it back", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-19T00:00:00.000Z",
    });
    const scroll = document.createElement("div");
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      scrollElement: scroll,
    });
    editor.commands.setContent({
      type: "section",
      content: [
        {
          type: "sectionHeader",
          attrs: { sectionId: runtime.noteId, tags: "[]" },
          content: [{ type: "text", text: "Viewport caret" }],
        },
        {
          type: "sectionBody",
          content: bodyChunk(
            Array.from({ length: 12 }, (_, index) => ({
              type: "paragraph",
              attrs: { blockId: createUuidV7() },
              content: [{ type: "text", text: `line ${index}` }],
            })),
          ),
        },
        { type: "sectionChildren" },
      ],
    });
    const positions: number[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph") positions.push(position + 1);
    });
    expect(positions).toHaveLength(12);
    const rect = (
      left: number,
      top: number,
      right: number,
      bottom: number,
    ): DOMRect =>
      ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 500, 100),
    );
    vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(
      rect(20, 0, 480, 300),
    );
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((position) => {
      const index = positions.reduce(
        (nearest, candidate, candidateIndex) =>
          Math.abs(candidate - position) <
          Math.abs(positions[nearest]! - position)
            ? candidateIndex
            : nearest,
        0,
      );
      const top = index * 20 - scroll.scrollTop;
      return { left: 40, right: 40, top, bottom: top + 18 };
    });
    vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ top }) => {
      const index = Math.max(
        0,
        Math.min(
          positions.length - 1,
          Math.floor((top + scroll.scrollTop) / 20),
        ),
      );
      return { pos: positions[index]!, inside: -1 };
    });

    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    editor.commands.setTextSelection(positions[0]!);
    scroll.scrollTop = 100;
    scroll.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    expect(editor.state.selection.head).toBe(positions[5]);
    expect(scroll.scrollTop).toBe(100);
    expect(adapter.vimSnapshot.mode).toBe("insert");

    editor.commands.setTextSelection(positions[10]!);
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    expect(editor.state.selection.head).toBe(positions[4]);
    expect(scroll.scrollTop).toBe(0);

    adapter.destroy();
    runtime.destroy();
    scroll.remove();
  });

  it("projects caret Section changes into the active tab Outline state", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-19T00:00:00.000Z",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    const childId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(note.rootSection, createSectionXml(childId, "child"));
    });
    const root = document.createElement("div");
    document.body.append(root);
    const onCaretSectionChange = vi.fn();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      onCaretSectionChange,
    });
    let childHeaderStart = -1;
    let rootBodyStart = -1;
    editor.state.doc.descendants((node, position) => {
      if (rootBodyStart < 0 && node.type.name === "paragraph") {
        rootBodyStart = position + 1;
      }
      if (
        childHeaderStart < 0 &&
        node.type.name === "sectionHeader" &&
        node.attrs.sectionId === childId
      ) {
        childHeaderStart = position + 1;
        return false;
      }
      return childHeaderStart < 0;
    });
    expect(childHeaderStart).toBeGreaterThan(0);
    expect(rootBodyStart).toBeGreaterThan(0);

    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    await runtime.flush();
    expect(onCaretSectionChange).toHaveBeenLastCalledWith(note.noteId);
    const initialCaretSectionCallCount = onCaretSectionChange.mock.calls.length;
    editor.commands.setTextSelection(rootBodyStart);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    expect(onCaretSectionChange).toHaveBeenCalledTimes(
      initialCaretSectionCallCount,
    );
    await runtime.updateSidebar({
      side: "right",
      outline: { noteId: note.noteId, selectedSectionId: childId },
    });
    await new Promise((resolve) => window.setTimeout(resolve, 140));
    await runtime.flush();
    let snapshot = runtime.snapshot().applicationWindow;
    let activeTab = snapshot.tabs.find(({ id }) => id === snapshot.activeTabId);
    expect(activeTab?.rightSidebar.outline.selectedSectionId).toBe(childId);

    await runtime.updateSidebar({
      side: "right",
      outline: { noteId: note.noteId, selectedSectionId: note.noteId },
    });

    editor.commands.setTextSelection(childHeaderStart);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    await runtime.flush();

    snapshot = runtime.snapshot().applicationWindow;
    activeTab = snapshot.tabs.find(({ id }) => id === snapshot.activeTabId);
    expect(activeTab?.rightSidebar.outline).toEqual({
      noteId: note.noteId,
      selectedSectionId: childId,
    });
    expect(onCaretSectionChange).toHaveBeenLastCalledWith(childId);
    expect(onCaretSectionChange).toHaveBeenCalledTimes(
      initialCaretSectionCallCount + 1,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("reveals Outline and Jump List destinations after scroll restoration", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-06T00:00:00.000Z",
    });
    const scroll = document.createElement("div");
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    const adapter = runtime.attachEditor("window-1", root, {
      scrollElement: scroll,
    });
    const editor = adapter.editor;
    editor.commands.setContent({
      type: "section",
      content: [
        {
          type: "sectionHeader",
          attrs: { sectionId: runtime.noteId, tags: "[]" },
          content: [{ type: "text", text: "Jump List origin" }],
        },
        {
          type: "sectionBody",
          content: bodyChunk(
            Array.from({ length: 30 }, (_, index) => ({
              type: "paragraph",
              attrs: { blockId: createUuidV7() },
              content: [{ type: "text", text: `spacer ${index}` }],
            })),
          ),
        },
        { type: "sectionChildren" },
      ],
    });
    editor.commands.setTextSelection(1);
    const origin = adapter.captureStablePosition();
    if (!origin) throw new Error("Stable origin was unavailable");
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const scrollRequestCount = (): number =>
      dispatch.mock.calls.filter(([transaction]) =>
        Boolean(transaction.scrolledIntoView),
      ).length;

    expect(
      adapter.applyNavigationDestination(
        {
          kind: "section-start",
          noteId: runtime.noteId,
          sectionId: runtime.noteId,
        },
        "jump:outline:changed",
      ),
    ).toBe("jump:outline:changed");
    expect(scrollRequestCount()).toBe(1);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    expect(scrollRequestCount()).toBe(2);

    expect(
      adapter.applyNavigationDestination(
        { kind: "stable", noteId: runtime.noteId, saved: origin },
        "jump:back:changed",
      ),
    ).toBe("jump:back:changed");
    expect(scrollRequestCount()).toBe(3);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    expect(scrollRequestCount()).toBe(4);

    dispatch.mockRestore();
    adapter.destroy();
    runtime.destroy();
    scroll.remove();
  });

  it("opens the Memoka structured block schema without a second serialization", () => {
    const noteId = "01900000-0000-7000-8000-000000000001";
    const targetSectionId = "01900000-0000-7000-8000-000000000002";
    const note = createNoteDocument(
      noteId,
      [
        {
          type: "paragraph",
          blockId: "01900000-0000-7000-8000-000000000003",
          content: [
            { type: "text", text: "本文 " },
            {
              type: "internalSectionLink",
              text: "リンク",
              targetSectionId,
            },
          ],
        },
        {
          type: "bulletList",
          blockId: "01900000-0000-7000-8000-000000000005",
          children: [
            {
              type: "listItem",
              blockId: "01900000-0000-7000-8000-000000000006",
              children: [
                {
                  type: "paragraph",
                  blockId: "01900000-0000-7000-8000-000000000007",
                  content: [{ type: "text", text: "項目" }],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          blockId: "01900000-0000-7000-8000-000000000008",
          language: "typescript",
          text: "const value = 1;",
        },
        {
          type: "image",
          blockId: "01900000-0000-7000-8000-000000000009",
          attachmentId: "01900000-0000-7000-8000-00000000000a",
          altText: "Image Block stub",
        },
        {
          type: "sourceBlock",
          blockId: "01900000-0000-7000-8000-00000000000b",
          sourceFormat: "markdown",
          text: "| raw | table |",
        },
        {
          type: "orderedList",
          blockId: "01900000-0000-7000-8000-00000000000c",
          start: 3,
          children: [
            {
              type: "listItem",
              blockId: "01900000-0000-7000-8000-00000000000d",
              children: [
                {
                  type: "paragraph",
                  blockId: "01900000-0000-7000-8000-00000000000e",
                  content: [{ type: "text", text: "番号付き項目" }],
                },
              ],
            },
          ],
        },
      ],
      "見出し",
    );
    const beforeOpen = Y.encodeStateVector(note.doc);
    const editor = new Editor({
      extensions: productEditorExtensions(note),
    });

    expect(editor.getJSON()).toMatchObject({
      type: "section",
      content: [
        {
          type: "sectionHeader",
          attrs: {
            sectionId: noteId,
          },
          content: [{ type: "text", text: "見出し" }],
        },
        {
          type: "sectionBody",
          content: [
            {
              type: "bodyChunk",
              content: [
                {
                  type: "paragraph",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-000000000003",
                  },
                  content: [
                    { type: "text", text: "本文 " },
                    {
                      type: "internalSectionLink",
                      attrs: { targetSectionId },
                      content: [{ type: "text", text: "リンク" }],
                    },
                  ],
                },
                {
                  type: "bulletList",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-000000000005",
                  },
                },
                {
                  type: "codeBlock",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-000000000008",
                    language: "typescript",
                  },
                  content: [{ type: "text", text: "const value = 1;" }],
                },
                {
                  type: "image",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-000000000009",
                    attachmentId: "01900000-0000-7000-8000-00000000000a",
                    alt: "Image Block stub",
                  },
                },
                {
                  type: "sourceBlock",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-00000000000b",
                    sourceFormat: "markdown",
                  },
                  content: [{ type: "text", text: "| raw | table |" }],
                },
                {
                  type: "orderedList",
                  attrs: {
                    blockId: "01900000-0000-7000-8000-00000000000c",
                    start: 3,
                  },
                },
              ],
            },
          ],
        },
        { type: "sectionChildren" },
      ],
    });
    expect(Y.encodeStateVector(note.doc)).toEqual(beforeOpen);
    editor.destroy();
    note.doc.destroy();
  });

  it("shares one NoteDoc across two editor views and persists native transactions", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
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

    first.editor.commands.insertContentAt(
      firstParagraphPosition(first.editor),
      "共有入力",
    );
    expect(second.editor.getText()).toContain("共有入力");
    await runtime.flush();
    expect(runtime.commands.log).toContainEqual(
      expect.objectContaining({
        name: "note.commit_editor_update",
        source: "editor",
        status: "committed",
      }),
    );
    const noteId = runtime.noteId;
    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    expect(reopened.noteId).toBe(noteId);
    expect(reopened.readNoteText()).toContain("共有入力");
    reopened.destroy();
  });

  it("keeps stable Root Section and block IDs in TipTap-created nodes", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    expect(editor.state.doc.firstChild?.attrs.sectionId).toBe(runtime.noteId);
    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") {
        paragraphPosition = position + 1;
      }
    });
    expect(paragraphPosition).toBeGreaterThan(0);
    editor.commands.setTextSelection(paragraphPosition);
    editor.commands.enter();
    const ids: unknown[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") {
        ids.push(node.attrs.blockId);
      }
    });
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.every((value) => typeof value === "string")).toBe(true);
    await runtime.flush();
    adapter.destroy();
    runtime.destroy();
  });

  it("remounts the editor at the last durable NoteDoc after commit failure", async () => {
    const persistence = new RejectNextEditorCommitPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const durableText = runtime.readNoteText();
    persistence.rejectNextEditorCommit();

    editor.commands.insertContentAt(firstParagraphPosition(editor), "未確定");
    expect(editor.getText()).toContain("未確定");
    await expect(runtime.flush()).rejects.toThrow(
      "injected editor persistence failure",
    );

    expect(runtime.readNoteText()).toBe(durableText);
    expect(adapter.editor.getText()).not.toContain("未確定");
    expect(runtime.commands.log).toContainEqual(
      expect.objectContaining({
        name: "note.commit_editor_update",
        source: "editor",
        status: "failed",
      }),
    );
    expect(runtime.transactions.log).toContainEqual(
      expect.objectContaining({
        scope: "workspace-structure",
        status: "rolled-back",
      }),
    );
    adapter.destroy();
    runtime.destroy();
  });
});
