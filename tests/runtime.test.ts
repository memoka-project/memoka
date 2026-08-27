import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  listNoteMetadata,
  loadNoteDocumentWithSectionIdentityRecovery,
  loadProductDocument,
  readNoteMetadata,
  readNotePlainText,
  readNoteTitle,
  replaceFirstTextBlock,
  replaceNoteSectionTree,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  MemoryPersistencePort,
  type PersistenceCommitRequest,
  type PersistenceCompactionRequest,
  type PersistenceCommitResponse,
} from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  childSections,
  createSectionXml,
  findSectionById,
  sectionChildren,
  sectionBodyBlocks,
  sectionBodyChunks,
  sectionHeader,
  sectionId,
  sectionSnapshot,
  type SectionSnapshot,
} from "../app/src/core/section-model";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter++;
    return createUuidV7(1_795_435_200_000 + seed, (target) => {
      target.fill(seed & 0xff);
      return target;
    });
  };
}

const clock = () => "2026-07-27T00:00:00.000Z";

class RejectFirstCompactionPort extends MemoryPersistencePort {
  private remainingFailures = 2;

  override compact(
    request: PersistenceCompactionRequest,
  ): Promise<PersistenceCommitResponse> {
    if (this.remainingFailures-- > 0) {
      return Promise.reject(new Error("injected snapshot compaction failure"));
    }
    return super.compact(request);
  }
}

class PausedEditorCommitPort extends MemoryPersistencePort {
  private armed = false;
  private releaseEditorCommits: (() => void) | null = null;
  private readonly editorGate = new Promise<void>((resolve) => {
    this.releaseEditorCommits = resolve;
  });

  resume(): void {
    this.releaseEditorCommits?.();
    this.releaseEditorCommits = null;
  }

  pause(): void {
    this.armed = true;
  }

  override async commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    if (
      this.armed &&
      request.scope === "workspace-structure" &&
      request.documents.some(({ kind }) => kind === "note")
    ) {
      await this.editorGate;
    }
    return super.commit(request);
  }
}

class RejectNextNoteDocCommitPort extends MemoryPersistencePort {
  private remainingFailures = 0;

  rejectNextNoteDocCommit(): void {
    // CoreTransactionGateway retries the same idempotent request once.
    this.remainingFailures = 2;
  }

  override commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    if (request.scope === "note-doc" && this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      return Promise.reject(new Error("injected Section repair failure"));
    }
    return super.commit(request);
  }
}

describe("Memoka Core Section-model vertical slice", () => {
  it("creates, edits, commits and reconstructs one NoteDoc after restart", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      initialTitle: "起動メモ",
    });
    expect(runtime.snapshot()).not.toHaveProperty("text");
    const noteId = runtime.noteId;
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: deterministicIds()(),
      source: "ui",
      payload: { noteId, text: "再起動してもCRDTから復元" },
    });
    expect(runtime.snapshot()).toMatchObject({
      title: "起動メモ",
      workspaceRevision: 2,
      noteRevision: 2,
    });
    expect(runtime.readNoteText()).toBe("再起動してもCRDTから復元");
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(reopened.noteId).toBe(noteId);
    expect(reopened.snapshot()).toMatchObject({
      title: "起動メモ",
      workspaceRevision: 2,
      noteRevision: 2,
    });
    expect(reopened.readNoteText()).toBe("再起動してもCRDTから復元");
    reopened.destroy();
  });

  it("opens a valid final Section tree after a structural replacement reuses a Yjs element", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
      initialTitle: "Structural replacement fixture",
    });
    const noteId = runtime.noteId;
    const originalId = ids();
    const insertedId = ids();
    const nestedId = ids();
    replaceNoteSectionTree(
      runtime.noteDocument,
      {
        ...sectionSnapshot(runtime.noteDocument.rootSection),
        children: [
          {
            sectionId: originalId,
            title: "Original",
            tags: [],
            body: [],
            children: [],
          },
        ],
      },
      clock(),
      Symbol("historical-structural-section"),
    );
    await runtime.flush();
    runtime.destroy();

    const beforeReplacement = await persistence.loadDocument("note", noteId);
    const replaced = loadProductDocument(
      "note",
      noteId,
      beforeReplacement.snapshot,
      beforeReplacement.updates.map(({ update }) => update),
    );
    if (replaced.kind !== "note") throw new Error("Expected NoteDoc");
    const retained = findSectionById(replaced.rootSection, originalId);
    if (!retained) throw new Error("Missing structural replacement fixture");
    const stateVector = Y.encodeStateVector(replaced.doc);
    replaced.doc.transact(() => {
      sectionHeader(retained).setAttribute("sectionId", insertedId);
      sectionChildren(replaced.rootSection).insert(0, [
        createSectionXml(
          originalId,
          "Original",
          [],
          [createSectionXml(nestedId, "Nested")],
        ),
      ]);
    }, Symbol("historical-structural-replacement"));
    const replacementUpdate = Y.encodeStateAsUpdate(replaced.doc, stateVector);
    await persistence.commit({
      operationId: ids(),
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: noteId,
          schemaVersion: replaced.schemaVersion,
          baseRevision: beforeReplacement.revision,
          snapshot: null,
          update: replacementUpdate,
        },
      ],
      localStates: [],
    });
    replaced.doc.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    expect(
      childSections(reopened.noteDocument.rootSection).map((section) =>
        sectionId(section),
      ),
    ).toEqual([originalId, insertedId]);
    expect(
      sectionId(
        childSections(childSections(reopened.noteDocument.rootSection)[0]!)[0]!,
      ),
    ).toBe(nestedId);
    expect(reopened.commands.log).not.toContainEqual(
      expect.objectContaining({ name: "note.repair_section_identity" }),
    );
    reopened.destroy();
  });

  it("appends an exact historical Section ID repair before opening a damaged NoteDoc", async () => {
    const persistence = new RejectNextNoteDocCommitPort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
      initialTitle: "Recovery fixture",
    });
    const noteId = runtime.noteId;
    const childId = ids();
    replaceNoteSectionTree(
      runtime.noteDocument,
      {
        ...sectionSnapshot(runtime.noteDocument.rootSection),
        children: [
          {
            sectionId: childId,
            title: "Child",
            tags: [],
            body: [
              {
                type: "paragraph",
                attrs: { blockId: ids() },
                content: [{ type: "text", text: "body" }],
              },
            ],
            children: [],
          },
        ],
      },
      clock(),
      Symbol("historical-valid-section"),
    );
    await runtime.flush();
    runtime.destroy();

    const beforeDamage = await persistence.loadDocument("note", noteId);
    const damaged = loadProductDocument(
      "note",
      noteId,
      beforeDamage.snapshot,
      beforeDamage.updates.map(({ update }) => update),
    );
    if (damaged.kind !== "note") throw new Error("Expected NoteDoc");
    const child = findSectionById(damaged.rootSection, childId);
    if (!child) throw new Error("Missing recovery fixture Section");
    const stateVector = Y.encodeStateVector(damaged.doc);
    damaged.doc.transact(() => {
      sectionHeader(child).setAttribute("sectionId", "");
    }, Symbol("historical-editor-defect"));
    const damagingUpdate = Y.encodeStateAsUpdate(damaged.doc, stateVector);
    await persistence.commit({
      operationId: ids(),
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: noteId,
          schemaVersion: damaged.schemaVersion,
          baseRevision: beforeDamage.revision,
          snapshot: null,
          update: damagingUpdate,
        },
      ],
      localStates: [],
    });
    damaged.doc.destroy();

    const persistedDamage = await persistence.loadDocument("note", noteId);
    expect(() =>
      loadProductDocument(
        "note",
        noteId,
        persistedDamage.snapshot,
        persistedDamage.updates.map(({ update }) => update),
      ),
    ).toThrow("sectionId must be a lowercase UUIDv7");

    persistence.rejectNextNoteDocCommit();
    await expect(
      CoreRuntime.open(persistence, {
        idFactory: ids,
        clock,
      }),
    ).rejects.toThrow("injected Section repair failure");
    expect((await persistence.loadDocument("note", noteId)).revision).toBe(
      persistedDamage.revision,
    );

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    expect(
      sectionId(findSectionById(reopened.noteDocument.rootSection, childId)!),
    ).toBe(childId);
    expect(reopened.commands.log).toContainEqual(
      expect.objectContaining({
        name: "note.repair_section_identity",
        source: "internal",
        status: "committed",
      }),
    );

    const persistedRepair = await persistence.loadDocument("note", noteId);
    const durable = loadProductDocument(
      "note",
      noteId,
      persistedRepair.snapshot,
      persistedRepair.updates.map(({ update }) => update),
    );
    expect(durable.kind).toBe("note");
    expect(persistedRepair.revision).toBe(persistedDamage.revision + 1);
    durable.doc.destroy();
    reopened.destroy();
  });

  it("persists duplicate block identity repair before exposing the NoteDoc", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
      initialTitle: "Block recovery fixture",
    });
    const noteId = runtime.noteId;
    await runtime.flush();
    runtime.destroy();

    const beforeDamage = await persistence.loadDocument("note", noteId);
    const damaged = loadProductDocument(
      "note",
      noteId,
      beforeDamage.snapshot,
      beforeDamage.updates.map(({ update }) => update),
    );
    if (damaged.kind !== "note") throw new Error("Expected NoteDoc");
    const first = sectionBodyBlocks(damaged.rootSection)[0]!;
    const duplicateId = String(first.getAttribute("blockId"));
    const stateVector = Y.encodeStateVector(damaged.doc);
    damaged.doc.transact(() => {
      sectionBodyChunks(damaged.rootSection)[0]!.insert(1, [first.clone()]);
    }, Symbol("historical-duplicate-block-id"));
    const update = Y.encodeStateAsUpdate(damaged.doc, stateVector);
    await persistence.commit({
      operationId: ids(),
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: noteId,
          schemaVersion: damaged.schemaVersion,
          baseRevision: beforeDamage.revision,
          snapshot: null,
          update,
        },
      ],
      localStates: [],
    });
    damaged.doc.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    const repairedIds = sectionBodyBlocks(
      reopened.noteDocument.rootSection,
    ).map((block) => String(block.getAttribute("blockId")));
    expect(repairedIds).toHaveLength(2);
    expect(new Set(repairedIds).size).toBe(2);
    expect(repairedIds).not.toContain(duplicateId);
    expect(reopened.commands.log).toContainEqual(
      expect.objectContaining({
        name: "note.repair_section_identity",
        source: "internal",
        status: "committed",
      }),
    );
    const persisted = await persistence.loadDocument("note", noteId);
    const durable = loadNoteDocumentWithSectionIdentityRecovery(
      noteId,
      persisted.snapshot,
      persisted.updates.map(({ update }) => update),
    );
    expect(durable.repair).toBeNull();
    durable.document.doc.destroy();
    reopened.destroy();
  });

  it("rolls CRDT, metadata and Window state back when persistence fails", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    const before = runtime.snapshot();
    const beforeText = runtime.readNoteText();
    await expect(
      runtime.executeCommand({
        name: "note.create",
        operationId: ids(),
        source: "ui",
        payload: {
          noteId: ids(),
          title: "部分確定してはいけない",
          createdAt: clock(),
          afterNoteId: runtime.noteId,
          windowId: "window-1",
          fault: "before-sql-commit",
        },
      }),
    ).rejects.toThrow("before-sql-commit");
    expect({
      ...runtime.snapshot(),
      error: null,
      persistence: "ready",
    }).toEqual(before);

    await expect(
      runtime.executeCommand({
        name: "note.replace_text",
        operationId: ids(),
        source: "ui",
        payload: {
          noteId: runtime.noteId,
          text: "本文も部分確定しない",
          fault: "before-sql-commit",
        },
      }),
    ).rejects.toThrow("before-sql-commit");
    expect(runtime.readNoteText()).toBe(beforeText);
    runtime.destroy();
  });

  it("persists Section depth changes atomically and rolls them back on failure", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
      initialTitle: "Root",
    });
    const noteId = runtime.noteId;
    const aId = ids();
    const bId = ids();
    const xId = ids();
    const cId = ids();
    const paragraph = (text: string): unknown => ({
      type: "paragraph",
      attrs: { blockId: ids() },
      content: text ? [{ type: "text", text }] : [],
    });
    const section = (
      sectionId: string,
      title: string,
      children: readonly SectionSnapshot[] = [],
    ): SectionSnapshot => ({
      sectionId,
      title,
      tags: [],
      body: [paragraph(`${title} body`)],
      children,
    });
    const original: SectionSnapshot = {
      sectionId: noteId,
      title: "Root",
      tags: [],
      body: [paragraph("Root body")],
      children: [
        section(aId, "A"),
        section(bId, "B", [section(xId, "X")]),
        section(cId, "C"),
      ],
    };
    replaceNoteSectionTree(
      runtime.noteDocument,
      original,
      clock(),
      Symbol("persisted-section-fixture"),
    );
    await runtime.flush();
    runtime.noteDocument.undoManager.clear();
    runtime.noteDocument.undoManager.stopCapturing();

    await expect(
      runtime.shiftSectionDepth(noteId, noteId, [bId], "deeper"),
    ).resolves.toMatchObject({
      noteId,
      changed: true,
      affectedSectionIds: [bId],
    });
    expect(runtime.noteDocument.undoManager.undoStack).toHaveLength(1);
    const committed = sectionSnapshot(runtime.noteDocument.rootSection);
    expect(committed.children.map(({ sectionId }) => sectionId)).toEqual([
      aId,
      cId,
    ]);
    expect(
      committed.children[0]?.children.map(({ sectionId }) => sectionId),
    ).toEqual([bId, xId]);
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    expect(sectionSnapshot(reopened.noteDocument.rootSection)).toEqual(
      committed,
    );
    await expect(
      reopened.executeCommand({
        name: "section.shift_depth",
        operationId: ids(),
        source: "editor",
        payload: {
          noteId,
          boundarySectionId: noteId,
          sectionIds: [bId],
          direction: "shallower",
          updatedAt: clock(),
          fault: "before-sql-commit",
        },
      }),
    ).rejects.toThrow("before-sql-commit");
    expect(sectionSnapshot(reopened.noteDocument.rootSection)).toEqual(
      committed,
    );
    expect(reopened.transactions.log.at(-1)?.status).toBe("rolled-back");
    reopened.destroy();

    const afterFailure = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock,
    });
    expect(sectionSnapshot(afterFailure.noteDocument.rootSection)).toEqual(
      committed,
    );
    afterFailure.destroy();
  });

  it("keeps notes flat, manually ordered and durable", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      initialTitle: "first",
    });
    const first = runtime.noteId;
    const third = await runtime.createNoteAtEnd("window-1", "third");
    const second = await runtime.createNoteAfter("window-1", first, "second");
    expect(
      listNoteMetadata(runtime.workspaceDocument)
        .filter(({ deletedAt }) => !deletedAt)
        .map(({ noteId }) => noteId),
    ).toEqual([first, second.noteId, third.noteId]);

    await runtime.reorderNote(second.noteId, "down");
    expect(
      listNoteMetadata(runtime.workspaceDocument)
        .filter(({ deletedAt }) => !deletedAt)
        .map(({ noteId }) => noteId),
    ).toEqual([first, third.noteId, second.noteId]);
    for (const metadata of listNoteMetadata(runtime.workspaceDocument)) {
      expect(metadata).not.toHaveProperty("parentId");
      expect(metadata).not.toHaveProperty("siblingPosition");
      expect(metadata.notePosition).toBeTruthy();
    }
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(
      listNoteMetadata(reopened.workspaceDocument)
        .filter(({ deletedAt }) => !deletedAt)
        .map(({ noteId }) => noteId),
    ).toEqual([first, third.noteId, second.noteId]);
    reopened.destroy();
  });

  it("renames the Root Section and its rebuildable workspace cache together", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      initialTitle: "before",
    });
    await runtime.renameNote(runtime.noteId, "after");
    expect(readNoteTitle(runtime.noteDocument)).toBe("after");
    expect(
      readNoteMetadata(runtime.workspaceDocument, runtime.noteId)?.title,
    ).toBe("after");
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(readNoteTitle(reopened.noteDocument)).toBe("after");
    expect(reopened.snapshot().title).toBe("after");
    reopened.destroy();
  });

  it("trashes only the selected flat note and keeps all displaying Windows valid", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      initialTitle: "first",
    });
    await addSecondWindow(runtime);
    const first = runtime.noteId;
    const second = await runtime.createNoteAtEnd("window-1", "second");
    await runtime.openNote("window-1", first);
    await runtime.openNote("window-2", first);

    const result = await runtime.moveNoteToTrash(first);
    expect(result).toMatchObject({
      trashedNoteIds: [first],
      fallbackNoteId: second.noteId,
    });
    expect(runtime.windows.get("window-1")?.noteId).toBe(second.noteId);
    expect(runtime.windows.get("window-2")?.noteId).toBe(second.noteId);
    expect(
      readNoteMetadata(runtime.workspaceDocument, second.noteId)?.deletedAt,
    ).toBeUndefined();
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(readNoteMetadata(reopened.workspaceDocument, first)?.deletedAt).toBe(
      clock(),
    );
    const restored = await reopened.restoreNoteFromTrash(first);
    expect(restored.restoredNoteIds).toEqual([first]);
    expect(
      readNoteMetadata(reopened.workspaceDocument, first)?.deletedAt,
    ).toBeUndefined();
    reopened.destroy();
  });

  it("recovers idempotently when commit succeeded but its response was lost", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
    });
    const ids = deterministicIds();
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: ids(),
      source: "ui",
      payload: {
        noteId: runtime.noteId,
        text: "一度だけ確定",
        fault: "after-commit-response",
      },
    });
    expect(runtime.readNoteText()).toBe("一度だけ確定");
    expect(runtime.transactions.log.at(-1)?.status).toBe("deduplicated");
    runtime.destroy();
  });

  it("folds committed editor updates into an exact snapshot", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      snapshotCompactionThreshold: 2,
    });
    const noteId = runtime.noteId;
    const editorOrigin = Symbol("editor-test");
    replaceFirstTextBlock(runtime.noteDocument, "first", editorOrigin);
    replaceFirstTextBlock(runtime.noteDocument, "second", editorOrigin);
    replaceFirstTextBlock(runtime.noteDocument, "third", editorOrigin);
    await runtime.flush();

    const persisted = await persistence.loadDocument("note", noteId);
    expect(persisted).toMatchObject({ revision: 4, snapshotRevision: 3 });
    expect(persisted.updates.map(({ revision }) => revision)).toEqual([4]);
    const snapshotOnly = loadProductDocument(
      "note",
      noteId,
      persisted.snapshot,
    );
    if (snapshotOnly.kind !== "note") throw new Error("Expected NoteDoc");
    expect(readNotePlainText(snapshotOnly)).toBe("second");
    snapshotOnly.doc.destroy();
    expect(runtime.snapshot()).toMatchObject({
      noteRevision: 4,
    });
    expect(runtime.readNoteText()).toBe("third");
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(reopened.readNoteText()).toBe("third");
    reopened.destroy();
  });

  it("compacts a large editor delta before the update-count threshold", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      snapshotCompactionThreshold: 128,
      snapshotCompactionByteThreshold: 64,
    });
    const noteId = runtime.noteId;
    replaceFirstTextBlock(
      runtime.noteDocument,
      "大きな差分".repeat(64),
      Symbol("large-editor-delta"),
    );
    await runtime.flush();

    const persisted = await persistence.loadDocument("note", noteId);
    expect(persisted).toMatchObject({
      revision: 2,
      snapshotRevision: 2,
      updates: [],
    });
    runtime.destroy();
  });

  it("keeps saving editor updates after maintenance compaction fails", async () => {
    const persistence = new RejectFirstCompactionPort();
    const errors: Error[] = [];
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
      snapshotCompactionThreshold: 1,
      onError: (error) => errors.push(error),
    });
    replaceFirstTextBlock(runtime.noteDocument, "first", Symbol("editor"));
    await runtime.flush();
    expect(errors).toHaveLength(1);
    replaceFirstTextBlock(runtime.noteDocument, "second", Symbol("editor"));
    await runtime.flush();
    expect(
      await persistence.loadDocument("note", runtime.noteId),
    ).toMatchObject({
      revision: 3,
      snapshotRevision: 3,
      updates: [],
    });
    runtime.destroy();
  });

  it("coalesces Runtime snapshots while rapid editor commits are queued", async () => {
    const persistence = new PausedEditorCommitPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    const snapshots: Array<{ persistence: string; revision: number | null }> =
      [];
    const unsubscribe = runtime.subscribe((snapshot) => {
      snapshots.push({
        persistence: snapshot.persistence,
        revision: snapshot.noteRevision,
      });
    });
    persistence.pause();
    const origin = Symbol("rapid-editor-input");
    replaceFirstTextBlock(runtime.noteDocument, "first", origin);
    replaceFirstTextBlock(runtime.noteDocument, "second", origin);
    replaceFirstTextBlock(runtime.noteDocument, "third", origin);

    // No document-sized React projection is emitted for every queued commit.
    expect(snapshots).toHaveLength(1);
    persistence.resume();
    await runtime.flush();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toEqual({ persistence: "ready", revision: 4 });

    unsubscribe();
    runtime.destroy();
  });

  it("keeps the large Tree metadata projection stable for body-only input", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
      initialTitle: "Root",
    });
    const before = runtime.snapshot().notes;

    replaceFirstTextBlock(runtime.noteDocument, "body update", Symbol("body"));
    await runtime.flush();
    expect(runtime.snapshot().notes).toBe(before);

    await runtime.renameNote(runtime.noteId, "Renamed Root");
    const renamed = runtime.snapshot().notes;
    expect(renamed).not.toBe(before);
    expect(renamed.find(({ noteId }) => noteId === runtime.noteId)?.title).toBe(
      "Renamed Root",
    );
    runtime.destroy();
  });

  it("creates, moves, trashes and restores one Note subtree through Core commands", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    const root = runtime.noteId;
    const child = await runtime.createChildNote("window-1", root);
    const grandchild = await runtime.createChildNote("window-1", child.noteId);
    const topLevelSibling = await runtime.createSiblingNote("window-1", root);

    expect(
      readNoteMetadata(runtime.workspaceDocument, child.noteId),
    ).toMatchObject({
      title: "",
      parentNoteId: root,
    });
    expect(
      readNoteMetadata(runtime.workspaceDocument, grandchild.noteId)
        ?.parentNoteId,
    ).toBe(child.noteId);
    expect(
      readNoteMetadata(runtime.workspaceDocument, topLevelSibling.noteId)
        ?.parentNoteId,
    ).toBeNull();

    await runtime.moveNoteInTree(grandchild.noteId, "outdent");
    expect(
      readNoteMetadata(runtime.workspaceDocument, grandchild.noteId)
        ?.parentNoteId,
    ).toBe(root);

    const trashed = await runtime.moveNoteToTrash(root);
    expect(new Set(trashed.trashedNoteIds)).toEqual(
      new Set([root, child.noteId, grandchild.noteId]),
    );
    expect(trashed.fallbackNoteId).toBe(topLevelSibling.noteId);
    expect(runtime.noteId).toBe(topLevelSibling.noteId);

    const restored = await runtime.restoreNoteFromTrash(root);
    expect(new Set(restored.restoredNoteIds)).toEqual(
      new Set([root, child.noteId, grandchild.noteId]),
    );
    for (const noteId of restored.restoredNoteIds) {
      expect(
        readNoteMetadata(runtime.workspaceDocument, noteId)?.deletedAt,
      ).toBeUndefined();
    }
    runtime.destroy();
  });
});
