import { describe, expect, it } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  MemoryWorkspaceSearchIndexPort,
  WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
  toWireWorkspaceSearchIndexRebuildRequest,
  workspaceSearchIndexQuery,
  type WorkspaceSearchIndexedDocument,
} from "../app/src/core/workspace-search-index";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_796_300_000_000 + seed, (target) => {
      target.fill((seed * 47) & 0xff);
      return target;
    });
  };
}

class CountingLoadPersistencePort extends MemoryPersistencePort {
  noteLoadCount = 0;

  override async loadDocument(
    ...args: Parameters<MemoryPersistencePort["loadDocument"]>
  ): ReturnType<MemoryPersistencePort["loadDocument"]> {
    if (args[0] === "note") this.noteLoadCount += 1;
    return super.loadDocument(...args);
  }
}

describe("Memoka rebuildable Workspace search index", () => {
  it("selects trigram, Japanese auxiliary grams and short-query scan", () => {
    expect(
      workspaceSearchIndexQuery("workspace", 1, "日本語", "body"),
    ).toMatchObject({
      normalizedQuery: "日本語",
      scope: "body",
      strategy: "trigram",
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "本語", "body"),
    ).toMatchObject({
      strategy: "japanese-gram",
      matchExpression: '"本語"',
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "本", "body"),
    ).toMatchObject({
      strategy: "japanese-gram",
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "ＡＰ", "title"),
    ).toMatchObject({
      normalizedQuery: "ap",
      strategy: "scan",
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "api memoka", "title"),
    ).toMatchObject({
      normalizedTerms: ["api", "memoka"],
      strategy: "trigram",
      matchExpression: '"api" AND "memoka"',
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "  ", "title"),
    ).toMatchObject({
      strategy: "all-titles",
    });
    expect(
      workspaceSearchIndexQuery("workspace", 1, "  ", "body"),
    ).toMatchObject({
      strategy: "empty",
    });
  });

  it("serializes normalized text and Japanese grams without changing source fields", () => {
    const document: WorkspaceSearchIndexedDocument = {
      noteId: "note-1",
      title: "ＡＰＩ日本語",
      parentPath: "開発 / 親",
      updatedAt: "2026-08-10T00:00:00.000Z",
      sourceRevision: 3,
      blocks: [
        {
          blockId: "block-1",
          kind: "body",
          sectionId: "note-1",
          text: "本文の検索対象",
          logicalLineNumber: 1,
          sectionLineNumber: 1,
          lineIndex: 0,
          sourceOffset: 0,
        },
      ],
    };
    const wire = toWireWorkspaceSearchIndexRebuildRequest({
      schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      workspaceRevision: 4,
      documents: [document],
    });
    expect(wire.documents[0]).toMatchObject({
      sourceRevision: 3,
      sections: [
        {
          title: "ＡＰＩ日本語",
          normalizedTitle: "api日本語",
        },
      ],
    });
    expect(wire.documents[0].sections[0].titleJapaneseGrams.split(" ")).toEqual(
      expect.arrayContaining(["日", "日本", "本語"]),
    );
    expect(wire.documents[0].sections[0]).not.toHaveProperty("parentPath");
    expect(wire.documents[0].sections[0]).not.toHaveProperty("pathTitle");
    expect(wire.documents[0].blocks[0]).toMatchObject({
      text: "本文の検索対象",
      normalizedText: "本文の検索対象",
      sectionLineNumber: 1,
    });
    expect(wire.documents[0].blocks[0]).not.toHaveProperty("sectionTitle");
    expect(wire.documents[0].blocks[0]).not.toHaveProperty("sectionPath");
    expect(document).not.toHaveProperty("normalizedTitle");
  });

  it("invalidates a cached CRDT fallback before a live editor update is persisted", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "fallback cache",
    });
    expect(
      await runtime.searchWorkspace("immediate live text", "body"),
    ).toMatchObject({
      backend: "crdt-fallback",
      results: [],
    });

    const root = document.createElement("div");
    document.body.append(root);
    const attached = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    let paragraphPosition = -1;
    attached.editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") {
        paragraphPosition = position + 1;
      }
      return paragraphPosition < 0;
    });
    attached.editor.commands.setTextSelection(paragraphPosition);
    attached.editor.commands.insertContent("immediate live text");

    expect(
      await runtime.searchWorkspace("immediate live text", "body"),
    ).toMatchObject({
      backend: "crdt-fallback",
      results: [expect.objectContaining({ noteId: runtime.noteId })],
    });

    await runtime.flush();
    attached.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("uses the provider contract, updates durable note projections, and falls back safely", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "検索元",
      workspaceSearchIndex: index,
    });
    await runtime.flush();

    const first = await runtime.searchWorkspace("検索元");
    expect(first).toMatchObject({ backend: "sqlite-fts", warning: null });
    expect(first.results[0]).toMatchObject({
      noteId: runtime.noteId,
      kind: "title",
    });
    expect(index.rebuildCount).toBe(1);

    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-search-index-update",
      source: "ui",
      payload: { noteId: runtime.noteId, text: "永続化後に更新される検索本文" },
    });
    await runtime.flush();
    const updated = await runtime.searchWorkspace("更新される", "body");
    expect(updated.backend).toBe("sqlite-fts");
    expect(updated.results[0]).toMatchObject({ kind: "body" });

    index.failQuery = new Error("injected derived-index failure");
    const fallback = await runtime.searchWorkspace("更新される", "body");
    expect(fallback).toMatchObject({
      backend: "crdt-fallback",
      warning: "injected derived-index failure",
    });
    expect(fallback.results[0]).toMatchObject({ kind: "body" });
    expect(runtime.snapshot().persistence).toBe("ready");
    runtime.destroy();
  });

  it("coalesces consecutive NoteDoc changes before refreshing the derived index", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "検索元",
      workspaceSearchIndex: index,
    });
    await runtime.flush();

    for (const [operationId, text] of [
      ["op-search-coalesce-1", "途中"],
      ["op-search-coalesce-2", "最後の本文"],
    ] as const) {
      await runtime.executeCommand({
        name: "note.replace_text",
        operationId,
        source: "ui",
        payload: { noteId: runtime.noteId, text },
      });
    }
    await runtime.flush();

    expect(index.replaceCount).toBe(1);
    expect(index.rebuildCount).toBe(1);
    const result = await runtime.searchWorkspace("最後", "body");
    expect(result.backend).toBe("sqlite-fts");
    expect(result.results[0]).toMatchObject({ kind: "body" });
    runtime.destroy();
  });

  it("coalesces consecutive Root hierarchy updates until the search/flush boundary", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Parent",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    const parentId = runtime.noteId;
    const child = await runtime.createChildNote("window-1", parentId);
    await runtime.renameNote(child.noteId, "Child");
    await runtime.flush();
    const hierarchyUpdatesBeforeTyping = index.hierarchyUpdateCount;
    const rebuildsBeforeTyping = index.rebuildCount;

    await runtime.renameNote(parentId, "R");
    await runtime.renameNote(parentId, "Re");
    await runtime.renameNote(parentId, "Renamed");

    expect(index.hierarchyUpdateCount).toBe(hierarchyUpdatesBeforeTyping);
    expect(runtime.backgroundTaskSnapshot().searchIndex).toMatchObject({
      phase: "waiting",
      pendingHierarchyCount: 1,
      pendingNoteCount: 1,
    });
    expect(
      await runtime.searchWorkspace("Renamed Child", "title"),
    ).toMatchObject({
      backend: "sqlite-fts+crdt",
      results: [
        expect.objectContaining({
          noteId: child.noteId,
          parentPath: "/Renamed",
        }),
      ],
    });
    expect(index.hierarchyUpdateCount).toBe(hierarchyUpdatesBeforeTyping + 1);
    expect(index.rebuildCount).toBe(rebuildsBeforeTyping);
    await runtime.flush();
    expect(runtime.backgroundTaskSnapshot().searchIndex).toMatchObject({
      phase: "idle",
      pendingHierarchyCount: 0,
      pendingNoteCount: 0,
    });
    expect(
      await runtime.searchWorkspace("Renamed Child", "title"),
    ).toMatchObject({
      backend: "sqlite-fts",
      results: [
        expect.objectContaining({
          noteId: child.noteId,
          parentPath: "/Renamed",
        }),
      ],
    });
    runtime.destroy();
  });

  it("merges a durable dirty NoteDoc without waiting for its derived index refresh", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "hybrid source",
      workspaceSearchIndex: index,
    });
    await runtime.flush();

    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-hybrid-dirty-search",
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "derived indexを待たないdirty検索",
      },
    });
    const replacesBeforeSearch = index.replaceCount;
    const hybrid = await runtime.searchWorkspace("dirty検索", "body");
    expect(hybrid).toMatchObject({
      backend: "sqlite-fts+crdt",
      results: [expect.objectContaining({ noteId: runtime.noteId })],
    });
    expect(index.replaceCount).toBe(replacesBeforeSearch);

    const queriesBeforeEmpty = index.queryCount;
    expect(await runtime.searchWorkspace("  ", "body")).toMatchObject({
      results: [],
    });
    expect(index.queryCount).toBe(queriesBeforeEmpty);

    await runtime.flush();
    expect(await runtime.searchWorkspace("dirty検索", "body")).toMatchObject({
      backend: "sqlite-fts",
    });
    runtime.destroy();
  });

  it("keeps editor metadata revisions on the incremental index path", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "editor revision bridge",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });

    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") {
        paragraphPosition = position + 1;
      }
    });
    expect(paragraphPosition).toBeGreaterThan(0);
    editor.commands.setTextSelection(paragraphPosition);
    editor.commands.insertContent("検索indexの軽量更新");
    await runtime.flush();

    expect(index.replaceCount).toBe(1);
    expect(index.rebuildCount).toBe(1);
    expect(await runtime.searchWorkspace("軽量更新", "body")).toMatchObject({
      backend: "sqlite-fts",
      results: [expect.objectContaining({ noteId: runtime.noteId })],
    });
    adapter.destroy();
    runtime.destroy();
  });

  it("refreshes a loaded NoteDoc index without reloading its persisted history", async () => {
    const persistence = new CountingLoadPersistencePort();
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "live projection",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    const loadsBeforeEdit = persistence.noteLoadCount;

    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-live-search-projection",
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "SQLiteから再読込しない検索本文",
      },
    });
    await runtime.flush();

    expect(persistence.noteLoadCount).toBe(loadsBeforeEdit);
    expect(await runtime.searchWorkspace("再読込しない", "body")).toMatchObject(
      {
        backend: "sqlite-fts",
        results: [expect.objectContaining({ noteId: runtime.noteId })],
      },
    );
    runtime.destroy();
  });

  it("updates descendant search paths after rename and Tree move without loading every NoteDoc", async () => {
    const persistence = new CountingLoadPersistencePort();
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "Parent",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    const parentId = runtime.noteId;
    const child = await runtime.createChildNote("window-1", parentId);
    await runtime.renameNote(child.noteId, "Child");
    await runtime.flush();
    const rebuildsBeforeRename = index.rebuildCount;
    const loadsBeforeRename = persistence.noteLoadCount;

    await runtime.renameNote(parentId, "Renamed Parent");
    await runtime.flush();
    expect(index.rebuildCount).toBe(rebuildsBeforeRename);
    expect(index.hierarchyUpdateCount).toBeGreaterThan(0);
    expect(persistence.noteLoadCount).toBe(loadsBeforeRename);
    expect(
      await runtime.searchWorkspace("Renamed Child", "title"),
    ).toMatchObject({
      backend: "sqlite-fts",
      results: [
        expect.objectContaining({
          noteId: child.noteId,
          parentPath: "/Renamed Parent",
        }),
      ],
    });

    const updatedAtBeforeMove = runtime
      .snapshot()
      .notes.find(({ noteId }) => noteId === child.noteId)?.updatedAt;
    await runtime.moveNote(child.noteId, {
      targetParentId: null,
      placement: { kind: "last" },
    });
    await runtime.flush();
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === child.noteId)
        ?.updatedAt,
    ).toBe(updatedAtBeforeMove);
    expect(index.rebuildCount).toBe(rebuildsBeforeRename);
    expect(await runtime.searchWorkspace("Child", "title")).toMatchObject({
      results: [
        expect.objectContaining({ noteId: child.noteId, parentPath: "/" }),
      ],
    });
    runtime.destroy();
  });

  it("advances the index revision without rewriting hierarchy rows for a sibling reorder", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "First",
      workspaceSearchIndex: index,
    });
    const firstId = runtime.noteId;
    const second = await runtime.createSiblingNote("window-1", firstId);
    await runtime.renameNote(second.noteId, "Second");
    await runtime.flush();
    const hierarchyUpdatesBefore = index.hierarchyUpdateCount;
    const hierarchyEntriesBefore = index.hierarchyEntryUpdateCount;
    const updatedAtBefore = Object.fromEntries(
      runtime
        .snapshot()
        .notes.map(({ noteId, updatedAt }) => [noteId, updatedAt]),
    );

    expect(await runtime.reorderNote(firstId, "down")).toMatchObject({
      noteId: firstId,
      changed: true,
    });
    await runtime.flush();

    expect(index.hierarchyUpdateCount).toBe(hierarchyUpdatesBefore + 1);
    expect(index.hierarchyEntryUpdateCount).toBe(hierarchyEntriesBefore);
    expect(
      Object.fromEntries(
        runtime
          .snapshot()
          .notes.map(({ noteId, updatedAt }) => [noteId, updatedAt]),
      ),
    ).toEqual(updatedAtBefore);
    expect(await runtime.searchWorkspace("First", "title")).toMatchObject({
      backend: "sqlite-fts",
      results: [expect.objectContaining({ noteId: firstId })],
    });
    runtime.destroy();
  });

  it("borrows loaded NoteDocs when a stale index requires a full rebuild", async () => {
    const persistence = new CountingLoadPersistencePort();
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "stale live projection",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    const loadsBeforeEdit = persistence.noteLoadCount;
    index.clear();

    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-stale-live-search-projection",
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "stale時もlive NoteDocから再構築",
      },
    });
    await runtime.flush();

    expect(persistence.noteLoadCount).toBe(loadsBeforeEdit);
    expect(index.rebuildCount).toBe(2);
    expect(await runtime.searchWorkspace("再構築", "body")).toMatchObject({
      backend: "sqlite-fts",
      results: [expect.objectContaining({ noteId: runtime.noteId })],
    });
    runtime.destroy();
  });

  it("rebuilds a deleted in-memory derived index from CRDT state", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "再構築対象",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    index.clear();

    const result = await runtime.searchWorkspace("再構築");
    expect(result.backend).toBe("crdt-fallback");
    expect(result.results[0].title).toBe("再構築対象");
    await runtime.flush();
    expect(index.rebuildCount).toBe(2);
    expect((await runtime.searchWorkspace("再構築")).backend).toBe(
      "sqlite-fts",
    );
    runtime.destroy();
  });

  it("attempts a failed stale-index rebuild only once per source revision", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "再構築失敗",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    index.clear();
    index.failRebuild = new Error("injected rebuild failure");

    expect(await runtime.searchWorkspace("再構築失敗", "body")).toMatchObject({
      backend: "crdt-fallback",
    });
    await runtime.flush();
    const attemptsAfterFailure = index.rebuildAttemptCount;

    expect(await runtime.searchWorkspace("再構築", "body")).toMatchObject({
      backend: "crdt-fallback",
    });
    await runtime.flush();
    expect(index.rebuildAttemptCount).toBe(attemptsAfterFailure);
    runtime.destroy();
  });

  it("validates a current index at startup and rebuilds only when it is stale", async () => {
    const persistence = new MemoryPersistencePort();
    const index = new MemoryWorkspaceSearchIndexPort();
    const idFactory = deterministicIds();
    const first = await CoreRuntime.open(persistence, {
      idFactory,
      initialTitle: "起動時検証",
      workspaceSearchIndex: index,
    });
    await first.flush();
    expect(index.rebuildCount).toBe(1);
    first.destroy();

    const current = await CoreRuntime.open(persistence, {
      idFactory,
      workspaceSearchIndex: index,
    });
    await current.flush();
    expect(index.rebuildCount).toBe(1);
    current.destroy();

    index.clear();
    const stale = await CoreRuntime.open(persistence, {
      idFactory,
      workspaceSearchIndex: index,
    });
    await stale.flush();
    expect(index.rebuildCount).toBe(2);
    expect((await stale.searchWorkspace("起動時")).backend).toBe("sqlite-fts");
    stale.destroy();
  });
});
