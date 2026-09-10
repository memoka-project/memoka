import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  addNoteMetadata,
  cloneProductDocument,
  createReplicatedWorkspaceDocument,
  createWorkspaceDocument,
  encodeProductDocument,
  listNoteMetadata,
  loadProductDocument,
  type WorkspaceDocument,
} from "../app/src/core/documents";
import {
  applyNamespacePlan,
  listNamespaceEntries,
  planNamespaceEdit,
  readMainNamespace,
  type NamespaceEdit,
} from "../app/src/core/namespace";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import native from "./fixtures/replicated-namespace-native.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const destroy of cleanup.splice(0).reverse()) destroy();
});
const at = "2026-09-10T00:00:00.000Z";

it("uses the persisted copy identity for production bootstrap, new Notes and reopened Editors", async () => {
  const replicaId = createUuidV7();
  class CurrentPersistence extends MemoryPersistencePort {
    override async manifest() {
      return {
        ...(await super.manifest()),
        databaseSchemaVersion: 7,
        replicaId,
      };
    }
  }
  const persistence = new CurrentPersistence();
  const core = await CoreRuntime.open(persistence);
  cleanup.push(() => core.destroy());
  expect(core.workspaceDocument.schemaVersion).toBe(4);
  expect(core.workspaceDocument.replicated?.replicaId).toBe(replicaId);
  expect(core.noteDocument.schemaVersion).toBe(7);
  expect(core.noteDocument.replicated?.replicaId).toBe(replicaId);
  const created = await core.createChildNote("window-1", core.noteId);
  await core.flush();
  const reopened = await CoreRuntime.open(persistence);
  cleanup.push(() => reopened.destroy());
  await reopened.openNote("window-1", created.noteId);
  expect(reopened.noteDocument.replicated?.replicaId).toBe(replicaId);
  expect(reopened.workspaceDocument.replicated?.replicaId).toBe(replicaId);
});
function keep(workspace: WorkspaceDocument): WorkspaceDocument {
  cleanup.push(() => workspace.doc.destroy());
  return workspace;
}
function edit(workspace: WorkspaceDocument, request: NamespaceEdit) {
  const plan = planNamespaceEdit(workspace, request, createUuidV7());
  applyNamespacePlan(workspace, plan, "test:local");
  return plan;
}
function group(
  workspace: WorkspaceDocument,
  name: string,
  parentEntryId: string | null = null,
) {
  const entryId = createUuidV7();
  edit(workspace, { kind: "create-group", entryId, name, parentEntryId, at });
  return entryId;
}
function source() {
  const legacy = keep(createWorkspaceDocument(createUuidV7()));
  return keep(createReplicatedWorkspaceDocument(legacy, createUuidV7()));
}
function fork(workspace: WorkspaceDocument) {
  return keep(
    loadProductDocument(
      "workspace",
      workspace.workspaceId,
      encodeProductDocument(workspace),
      [],
      createUuidV7(),
    ) as WorkspaceDocument,
  );
}
function entries(workspace: WorkspaceDocument) {
  return listNamespaceEntries(workspace.root);
}
function merge(workspace: WorkspaceDocument, peers: WorkspaceDocument[]) {
  for (const peer of peers)
    Y.applyUpdate(workspace.doc, encodeProductDocument(peer));
  const loaded = keep(
    loadProductDocument(
      "workspace",
      workspace.workspaceId,
      encodeProductDocument(workspace),
    ) as WorkspaceDocument,
  );
  expect(entries(loaded)).toEqual(entries(workspace));
}

describe("replicated Main Namespace", () => {
  it("merges a Rust move and rename with a concurrent Yjs child creation in either order", () => {
    const original = keep(
      loadProductDocument(
        "workspace",
        native.source.workspaceId,
        Uint8Array.from(native.source.snapshot),
        [],
        createUuidV7(),
      ) as WorkspaceDocument,
    );
    const peer = fork(original);
    const child = group(peer, "Concurrent child", native.entryId);
    const javascript = encodeProductDocument(peer);
    const rust = Uint8Array.from(native.update);
    for (const updates of [
      [javascript, rust],
      [rust, javascript],
    ]) {
      const target = fork(original);
      for (const update of updates) Y.applyUpdate(target.doc, update);
      const moved = entries(target).find(
        (entry) => entry.entryId === native.entryId,
      )!;
      const expected =
        native.expectedEntries[
          native.entryId as keyof typeof native.expectedEntries
        ];
      expect(moved.name).toBe("Native renamed");
      expect(moved.parentEntryId).toBe(expected.parent_entry_id);
      expect(
        entries(target).find((entry) => entry.entryId === child)?.parentEntryId,
      ).toBe(native.entryId);
      expect(
        readMainNamespace(target.root)
          .entries.get(native.entryId)
          ?.has("parent_entry_id"),
      ).toBe(false);
    }
  });
  it("converts groups, Notes, managed Help and independent Trash without modifying the source", () => {
    const old = keep(createWorkspaceDocument(createUuidV7()));
    const parent = group(old, "Parent"),
      earlier = group(old, "Earlier", parent);
    addNoteMetadata(old, {
      noteId: createUuidV7(),
      title: "Help",
      systemRole: "help",
      parentEntryId: parent,
      notePosition: "a0",
      createdAt: at,
      updatedAt: at,
    });
    edit(old, { kind: "trash", entryId: earlier, at });
    edit(old, { kind: "trash", entryId: parent, at });
    const bytes = encodeProductDocument(old),
      expected = entries(old);
    const normalized = keep(
      createReplicatedWorkspaceDocument(old, createUuidV7()),
    );
    expect(encodeProductDocument(old)).toEqual(bytes);
    expect(entries(normalized)).toEqual(expected);
    expect(listNoteMetadata(normalized)).toEqual(listNoteMetadata(old));
    expect(normalized.schemaVersion).toBe(4);
    expect(
      keep(cloneProductDocument(normalized) as WorkspaceDocument).replicated!
        .replicaId,
    ).toBe(normalized.replicated!.replicaId);
    edit(normalized, { kind: "restore", entryId: parent, at });
    expect(
      entries(normalized).find((entry) => entry.entryId === earlier)?.deletedAt,
    ).toBe(at);
    expect(listNoteMetadata(normalized)[0]?.deletedAt).toBeUndefined();
  });

  it("converges three replicas after cyclic moves, renames, duplicate and reversed delivery", () => {
    const a = source(),
      x = group(a, "X"),
      y = group(a, "Y"),
      z = group(a, "Z");
    const b = fork(a),
      c = fork(a);
    edit(a, {
      kind: "move-to",
      entryId: x,
      targetParentId: y,
      placement: { kind: "last" },
      at,
    });
    edit(b, {
      kind: "move-to",
      entryId: y,
      targetParentId: z,
      placement: { kind: "last" },
      at,
    });
    edit(c, {
      kind: "move-to",
      entryId: z,
      targetParentId: x,
      placement: { kind: "last" },
      at,
    });
    edit(c, { kind: "rename-group", entryId: x, name: "Edited X", at });
    const updates = [a, b, c].map(encodeProductDocument);
    let writes = 0;
    const onUpdate = () => {
      writes++;
    };
    a.doc.on("update", onUpdate);
    for (const [index, peer] of [a, b, c].entries()) {
      for (const update of index % 2 ? updates : [...updates].reverse())
        Y.applyUpdate(peer.doc, update);
      for (const update of updates) Y.applyUpdate(peer.doc, update);
      expect(entries(peer).find((entry) => entry.entryId === x)?.name).toBe(
        "Edited X",
      );
    }
    const received = writes;
    expect(entries(a)).toEqual(entries(b));
    expect(entries(a)).toEqual(entries(c));
    expect(a.replicated!.project().tree.reverted.size).toBe(1);
    expect(writes).toBe(received);
    a.doc.off("update", onUpdate);
    // A subsequent explicit move remains possible after cycle correction.
    const top = entries(a).find((entry) => entry.parentEntryId === null)!;
    const child = entries(a).find(
      (entry) => entry.parentEntryId === top.entryId,
    )!;
    edit(a, {
      kind: "move-to",
      entryId: child.entryId,
      targetParentId: null,
      placement: { kind: "last" },
      at,
    });
    merge(b, [a]);
    merge(c, [b]);
    expect(entries(a)).toEqual(entries(c));
  });

  it("keeps a concurrent child addition and edit under a deleted parent and restores them", () => {
    const a = source(),
      parent = group(a, "Parent"),
      b = fork(a);
    edit(a, { kind: "trash", entryId: parent, at });
    const noteId = createUuidV7();
    addNoteMetadata(b, {
      noteId,
      title: "Offline child",
      parentEntryId: parent,
      notePosition: "a0",
      createdAt: at,
      updatedAt: at,
    });
    edit(b, {
      kind: "rename-group",
      entryId: parent,
      name: "Edited parent",
      at,
    });
    merge(a, [b]);
    merge(b, [a]);
    expect(listNoteMetadata(a)[0]).toMatchObject({
      noteId,
      deletedAt: at,
      title: "Offline child",
    });
    expect(entries(a).find((entry) => entry.entryId === parent)?.name).toBe(
      "Edited parent",
    );
    edit(a, { kind: "restore", entryId: parent, at });
    merge(b, [a]);
    expect(listNoteMetadata(b)[0]?.deletedAt).toBeUndefined();
  });

  it("binds restoration to observed deletions even if another delete arrives before commit", () => {
    const a = source(),
      id = group(a, "protected"),
      b = fork(a);
    edit(a, { kind: "trash", entryId: id, at });
    const restore = planNamespaceEdit(
      a,
      { kind: "restore", entryId: id, at },
      createUuidV7(),
    );
    edit(b, { kind: "trash", entryId: id, at });
    merge(a, [b]);
    applyNamespacePlan(a, restore, "test:local");
    expect(entries(a)[0]?.deletedAt).toBe(at);
    expect(a.replicated!.project().activeDeletions.get(id)).toHaveLength(1);
    edit(a, { kind: "restore", entryId: id, at });
    merge(b, [a]);
    expect(entries(b)[0]?.deletedAt).toBeUndefined();
  });

  it("rejects invalid references, unknown fields and physical placement keys at the load boundary", () => {
    const original = source(),
      id = group(original, "entry");
    for (const corrupt of [
      (workspace: WorkspaceDocument) =>
        readMainNamespace(workspace.root)
          .entries.get(id)!
          .set("parent_entry_id", id),
      (workspace: WorkspaceDocument) => {
        const edge = [...workspace.replicated!.placements.values()][0]!;
        workspace.replicated!.placements.set(edge.operationId, {
          ...edge,
          parentId: createUuidV7(),
        });
      },
      (workspace: WorkspaceDocument) => {
        const edge = [...workspace.replicated!.placements.values()][0]!;
        workspace.replicated!.placements.set(edge.operationId, {
          ...edge,
          extra: true,
        } as typeof edge);
      },
    ]) {
      const broken = fork(original);
      corrupt(broken);
      expect(() =>
        loadProductDocument(
          "workspace",
          broken.workspaceId,
          encodeProductDocument(broken),
        ),
      ).toThrow();
    }
  });

  it("runs normal Core group, Note, move and Trash commands through the owner and reopens", async () => {
    const metadata = source(),
      persistence = new MemoryPersistencePort();
    await persistence.commit({
      operationId: createUuidV7(),
      scope: "bootstrap",
      documents: [
        {
          kind: "workspace",
          documentId: metadata.id,
          schemaVersion: 4,
          baseRevision: 0,
          snapshot: encodeProductDocument(metadata),
          update: null,
        },
      ],
      localStates: [],
    });
    const runtime = await CoreRuntime.open(persistence);
    cleanup.push(() => runtime.destroy());
    const parent = await runtime.createNamespaceGroup(null, "Parent");
    const child = await runtime.createNamespaceGroup(parent.entryId, "Child");
    const note = await runtime.createNoteAtEntry(
      "window-1",
      child.entryId,
      "child",
    );
    expect(runtime.noteDocument.schemaVersion).toBe(7);
    await runtime.renameNamespaceGroup(parent.entryId, "Renamed");
    await runtime.trashNamespaceEntry(parent.entryId);
    expect(
      runtime.snapshot().notes.find((item) => item.noteId === note.noteId)
        ?.deletedAt,
    ).toBeTruthy();
    await runtime.restoreNamespaceEntry(child.entryId);
    await runtime.flushDurableState();
    const stored = await persistence.loadDocument("workspace", metadata.id);
    const reopened = keep(
      loadProductDocument(
        "workspace",
        metadata.id,
        stored.snapshot,
        stored.updates.map(({ update }) => update),
      ) as WorkspaceDocument,
    );
    expect(reopened.schemaVersion).toBe(4);
    expect(
      listNoteMetadata(reopened).find((item) => item.noteId === note.noteId)
        ?.deletedAt,
    ).toBeUndefined();
    expect(
      entries(reopened).find((entry) => entry.entryId === parent.entryId)?.name,
    ).toBe("Renamed");
    expect(
      [...readMainNamespace(reopened.root).entries.values()].every(
        (entry) => !entry.has("parent_entry_id"),
      ),
    ).toBe(true);
  });
});
