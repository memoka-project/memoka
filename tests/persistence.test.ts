import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MemoryPersistencePort,
  type PersistenceCompactionRequest,
  type PersistenceCommitRequest,
} from "../app/src/core/persistence";

function createYjsHistory() {
  const doc = new Y.Doc();
  const text = doc.getText("body");
  text.insert(0, "one");
  const snapshot = Y.encodeStateAsUpdate(doc);
  let stateVector = Y.encodeStateVector(doc);
  text.insert(text.length, "-two");
  const update2 = Y.encodeStateAsUpdate(doc, stateVector);
  stateVector = Y.encodeStateVector(doc);
  text.insert(text.length, "-three");
  const update3 = Y.encodeStateAsUpdate(doc, stateVector);
  doc.destroy();
  return { snapshot, update2, update3 };
}

function readYjsText(snapshot: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot);
    return doc.getText("body").toString();
  } finally {
    doc.destroy();
  }
}

const HISTORY = createYjsHistory();
const SNAPSHOT = HISTORY.snapshot;

function createRequest(
  operationId: string,
  fault?: PersistenceCommitRequest["fault"],
): PersistenceCommitRequest {
  return {
    operationId,
    scope: "workspace-structure",
    documents: [
      {
        kind: "workspace",
        documentId: "workspace-1",
        schemaVersion: 2,
        baseRevision: 0,
        snapshot: SNAPSHOT,
        update: null,
      },
      {
        kind: "note",
        documentId: "note-1",
        schemaVersion: 2,
        baseRevision: 0,
        snapshot: SNAPSHOT,
        update: null,
      },
    ],
    localStates: [
      {
        windowId: "window-1",
        state: { mode: "insert", scrollTop: 0 },
      },
    ],
    fault,
  };
}

describe("Memoka persistence port contract", () => {
  it("commits multiple CRDT documents and local state atomically", async () => {
    const persistence = new MemoryPersistencePort();
    await persistence.commit(createRequest("op-create"));
    expect((await persistence.manifest()).activeWorkspaceId).toBe(
      "workspace-1",
    );
    expect(
      await persistence.loadDocument("workspace", "workspace-1"),
    ).toMatchObject({ revision: 1, snapshotRevision: 1 });
    expect(await persistence.loadDocument("note", "note-1")).toMatchObject({
      revision: 1,
      snapshotRevision: 1,
    });
    expect(await persistence.loadLocalStates()).toHaveLength(1);
  });

  it("leaves no partial state when commit fails", async () => {
    const persistence = new MemoryPersistencePort();
    await expect(
      persistence.commit(createRequest("op-fail", "before-sql-commit")),
    ).rejects.toThrow("before-sql-commit");
    expect((await persistence.manifest()).activeWorkspaceId).toBeNull();
    await expect(persistence.loadDocument("note", "note-1")).rejects.toThrow(
      "unknown",
    );
    expect(await persistence.loadLocalStates()).toEqual([]);
  });

  it("deduplicates a retry after a committed response was lost", async () => {
    const persistence = new MemoryPersistencePort();
    await expect(
      persistence.commit(
        createRequest("op-lost-response", "after-commit-response"),
      ),
    ).rejects.toThrow("after-commit-response");
    const retry = await persistence.commit(createRequest("op-lost-response"));
    expect(retry.deduplicated).toBe(true);
    expect(await persistence.loadDocument("note", "note-1")).toMatchObject({
      revision: 1,
    });
  });

  it("compacts updates without changing the content revision", async () => {
    const persistence = new MemoryPersistencePort();
    await persistence.commit(createRequest("op-create"));
    await persistence.commit({
      operationId: "op-edit-2",
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: "note-1",
          schemaVersion: 2,
          baseRevision: 1,
          snapshot: null,
          update: HISTORY.update2,
        },
      ],
      localStates: [],
    });
    await persistence.commit({
      operationId: "op-edit-3",
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: "note-1",
          schemaVersion: 2,
          baseRevision: 2,
          snapshot: null,
          update: HISTORY.update3,
        },
      ],
      localStates: [],
    });

    const response = await persistence.compact({
      operationId: "op-compact",
      kind: "note",
      documentId: "note-1",
      schemaVersion: 2,
      expectedRevision: 3,
    });

    expect(response.documents).toEqual([
      { kind: "note", documentId: "note-1", revision: 3 },
    ]);
    const compacted = await persistence.loadDocument("note", "note-1");
    expect(compacted).toMatchObject({
      revision: 3,
      snapshotRevision: 3,
      updates: [],
    });
    expect(readYjsText(compacted.snapshot)).toBe("one-two-three");
  });

  it("rolls a failed snapshot compaction back atomically", async () => {
    const persistence = new MemoryPersistencePort();
    await persistence.commit(createRequest("op-create"));
    await persistence.commit({
      operationId: "op-edit",
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: "note-1",
          schemaVersion: 2,
          baseRevision: 1,
          snapshot: null,
          update: HISTORY.update2,
        },
      ],
      localStates: [],
    });
    const before = await persistence.loadDocument("note", "note-1");

    await expect(
      persistence.compact({
        operationId: "op-compact-fail",
        kind: "note",
        documentId: "note-1",
        schemaVersion: 2,
        expectedRevision: 2,
        fault: "before-sql-commit",
      }),
    ).rejects.toThrow("before-sql-commit");
    expect(await persistence.loadDocument("note", "note-1")).toEqual(before);
  });

  it("deduplicates a compaction retry after the response is lost", async () => {
    const persistence = new MemoryPersistencePort();
    await persistence.commit(createRequest("op-create"));
    await persistence.commit({
      operationId: "op-edit",
      scope: "note-doc",
      documents: [
        {
          kind: "note",
          documentId: "note-1",
          schemaVersion: 2,
          baseRevision: 1,
          snapshot: null,
          update: HISTORY.update2,
        },
      ],
      localStates: [],
    });
    const request: PersistenceCompactionRequest = {
      operationId: "op-compact-lost-response",
      kind: "note",
      documentId: "note-1",
      schemaVersion: 2,
      expectedRevision: 2,
      fault: "after-commit-response",
    };

    await expect(persistence.compact(request)).rejects.toThrow(
      "after-commit-response",
    );
    const retry = await persistence.compact({ ...request, fault: undefined });

    expect(retry.deduplicated).toBe(true);
    const persisted = await persistence.loadDocument("note", "note-1");
    expect(persisted).toMatchObject({
      revision: 2,
      snapshotRevision: 2,
      updates: [],
    });
    expect(readYjsText(persisted.snapshot)).toBe("one-two");
  });
});
