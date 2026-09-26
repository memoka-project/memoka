import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CompactDictionary, Migemo } from "jsmigemo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import { createUuidV7 } from "../app/src/core/ids";
import { loadNoteMigemo } from "../app/src/core/note-migemo";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  emptySearchRankingState,
  learnSearchRankingSelection,
  rankingScore,
  recordSearchRankingOpen,
  type RankedWorkspaceResult,
} from "../app/src/core/workspace-search-ranking";
import { MemoryWorkspaceSearchIndexPort } from "../app/src/core/workspace-search-index";
import type { WorkspaceSearchResult } from "../app/src/core/workspace-search";

vi.mock("../app/src/core/note-migemo", () => ({
  loadNoteMigemo: vi.fn(),
}));

function deterministicIds() {
  let counter = 0;
  return () => createUuidV7(1_796_500_000_000 + counter++);
}

function migemo(): Migemo {
  const bytes = readFileSync(
    resolve(process.cwd(), "app/src/assets/migemo-compact-dict.bin"),
  );
  const value = new Migemo();
  value.setDict(
    new CompactDictionary(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return value;
}

beforeEach(() => {
  vi.mocked(loadNoteMigemo).mockResolvedValue(migemo());
});

describe("Workspace smart search", () => {
  it("returns one Note per match, excludes Section titles, and matches Note ancestors", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "親ノート",
    });
    const note = runtime.getNoteHandle(runtime.noteId).current;
    if (note.kind !== "note") throw new Error("Expected NoteDoc");
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(createUuidV7(), "除外するSection"),
      );
    });
    const child = await runtime.createChildNote("window-1", runtime.noteId);
    await runtime.renameNote(child.noteId, "子ノート");

    expect(
      (await runtime.searchWorkspace("除外するSection", "title")).results,
    ).toEqual([]);
    const byAncestor = await runtime.searchWorkspace("親 子", "title");
    expect(byAncestor.results).toHaveLength(1);
    expect(byAncestor.results[0]).toMatchObject({
      noteId: child.noteId,
      sectionId: child.noteId,
      title: "子ノート",
      parentPath: "/親ノート",
    });
    const romaji = await runtime.searchWorkspace("no-to", "title");
    expect(romaji.results.map((result) => result.noteId)).toContain(
      child.noteId,
    );
    expect(romaji.results[0]?.titleRanges?.length).toBeGreaterThan(0);
    runtime.destroy();
  });

  it("finds Japanese body text from romaji in the index and CRDT fallback", async () => {
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "検索ノート",
      workspaceSearchIndex: index,
    });
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: "op-smart-body",
      source: "ui",
      payload: { noteId: runtime.noteId, text: "本文に検索があります" },
    });
    await runtime.flush();
    const indexed = await runtime.searchWorkspace("kensaku", "body");
    expect(indexed.backend).toBe("sqlite-fts");
    expect(indexed.results).toHaveLength(1);
    expect(indexed.results[0]).toMatchObject({
      noteId: runtime.noteId,
      kind: "body",
      matchOffset: "本文に".length,
    });
    expect(indexed.results[0]?.lineRanges).toEqual([
      { from: "本文に".length, to: "本文に検索".length },
    ]);
    index.failQuery = new Error("injected index failure");
    const fallback = await runtime.searchWorkspace("kensaku", "body");
    expect(fallback.backend).toBe("crdt-fallback");
    expect(fallback.results[0]?.resultId).toBe(indexed.results[0]?.resultId);
    expect(
      (await runtime.searchWorkspace("検索", "body")).results,
    ).toHaveLength(1);
    runtime.destroy();
  });

  it("does not treat a partial ASCII Migemo syllable as a match", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "alert",
    });
    const englishNoteId = runtime.noteId;
    const japaneseNote = await runtime.createChildNote(
      "window-1",
      englishNoteId,
    );
    await runtime.renameNote(japaneseNote.noteId, "テスト");
    for (const [noteId, text] of [
      [englishNoteId, "alert"],
      [japaneseNote.noteId, "alert テスト"],
    ]) {
      await runtime.executeCommand({
        name: "note.replace_text",
        operationId: `op-smart-te-${noteId}`,
        source: "ui",
        payload: { noteId, text },
      });
    }
    const titleResults = (await runtime.searchWorkspace("te", "title")).results;
    expect(titleResults.map(({ noteId }) => noteId)).toEqual([
      japaneseNote.noteId,
    ]);
    expect(titleResults[0]?.titleRanges).toEqual([{ from: 0, to: 1 }]);
    const bodyResults = (await runtime.searchWorkspace("te", "body")).results;
    expect(bodyResults.map(({ noteId }) => noteId)).toEqual([
      japaneseNote.noteId,
    ]);
    expect(bodyResults[0]?.lineRanges).toEqual([{ from: 6, to: 7 }]);
    runtime.destroy();
  });

  it("continues literal search and reports when the Migemo dictionary cannot load", async () => {
    vi.mocked(loadNoteMigemo).mockRejectedValue(
      new Error("dictionary unavailable"),
    );
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "検索ノート",
    });
    const title = await runtime.searchWorkspace("kensaku", "title");
    expect(title.results).toEqual([]);
    expect(title.migemoUnavailable).toBe(true);
    const body = await runtime.searchWorkspace("kensaku", "body");
    expect(body.results).toEqual([]);
    expect(body.migemoUnavailable).toBe(true);
    runtime.destroy();
  });

  it("persists Note opening history across restart and learns from skipped candidates", async () => {
    const persistence = new MemoryPersistencePort();
    const idFactory = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory,
      initialTitle: "alpha",
    });
    const firstId = runtime.noteId;
    const second = await runtime.createNoteAfter("window-1", firstId, "beta");
    const afterCreation = (await persistence.loadLocalStates()).find(
      ({ windowId }) => windowId.startsWith("search-ranking:"),
    );
    expect(afterCreation?.state).toMatchObject({
      visits: { [second.noteId]: expect.objectContaining({ score: 1 }) },
    });
    await runtime.openNote("window-1", firstId);
    await runtime.openNote("window-1", second.noteId);
    await runtime.flush();
    const beforeLearning = (await runtime.searchWorkspace("", "title")).results;
    await runtime.learnWorkspaceSearchSelection(
      "window-1",
      beforeLearning[1]!,
      [beforeLearning[0]!],
      runtime.captureWorkspaceSearchRankingContext("window-1"),
    );
    const stored = (await persistence.loadLocalStates()).find(({ windowId }) =>
      windowId.startsWith("search-ranking:"),
    );
    expect(stored?.state).toMatchObject({
      schemaVersion: 1,
      previousNoteId: firstId,
      visits: {
        [firstId]: expect.objectContaining({ score: expect.any(Number) }),
        [second.noteId]: expect.objectContaining({ score: expect.any(Number) }),
      },
    });
    expect(stored?.state.weights).not.toEqual([6, 2, 1.5, 0.8, 0.7, 0.5]);
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, { idFactory });
    const results = (await reopened.searchWorkspace("", "title")).results;
    expect(results.find(({ noteId }) => noteId === firstId)?.openStatus).toBe(
      "previous",
    );
    reopened.destroy();

    const result = (noteId: string) => ({ noteId }) as WorkspaceSearchResult;
    const selected: RankedWorkspaceResult = {
      result: result("selected"),
      match: 1,
      pathMatch: 0,
    };
    const skipped: RankedWorkspaceResult = {
      result: result("skipped"),
      match: 0,
      pathMatch: 1,
    };
    const state = recordSearchRankingOpen(
      emptySearchRankingState(),
      "selected",
      null,
      "2026-09-26T00:00:00.000Z",
    );
    const context = {
      state,
      now: "2026-09-26T00:00:00.000Z",
      activeNoteId: null,
      openNoteIds: new Set<string>(),
      paths: new Map<string, string>(),
    };
    const learned = learnSearchRankingSelection(
      state,
      selected,
      [skipped],
      context,
    );
    expect(learned.weights[0]).toBeGreaterThan(state.weights[0]!);
    expect(learned.weights[1]).toBeLessThan(state.weights[1]!);
    expect(
      rankingScore(selected, { ...context, state: learned }),
    ).toBeGreaterThan(rankingScore(selected, context));
  });
});
