import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addNoteMetadata,
  createReplicatedNoteDocumentFromSectionSnapshot,
  createReplicatedWorkspaceDocument,
  createWorkspaceDocument,
  encodeProductDocument,
  loadProductDocument,
  readNotePlainText,
  readNoteUpdatedAt,
  readNoteMetadata,
  type NoteDocument,
  type WorkspaceDocument,
} from "../app/src/core/documents";
import {
  applyNamespacePlan,
  planNamespaceEdit,
} from "../app/src/core/namespace";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  recoverSyncCommit,
  type SyncDelivery,
  type SyncPreparation,
  type SyncPublicationPort,
} from "../app/src/core/native-sync";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});
const at = "2026-09-01T00:00:00.000Z";
const remoteAt = "2026-09-02T00:00:00.000Z";
function base64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
async function fixture() {
  const persistence = new MemoryPersistencePort();
  const replica = createUuidV7(),
    noteId = createUuidV7(),
    blockId = createUuidV7();
  const note = createReplicatedNoteDocumentFromSectionSnapshot(
    noteId,
    {
      sectionId: noteId,
      title: "Shared",
      tags: [],
      children: [],
      body: [
        {
          type: "paragraph",
          attrs: { blockId },
          content: [{ type: "text", text: "abc" }],
        },
      ],
    },
    replica,
    { createdAt: at },
  );
  const legacy = createWorkspaceDocument(createUuidV7());
  addNoteMetadata(legacy, {
    noteId,
    notePosition: "a0",
    title: "Shared",
    createdAt: at,
    updatedAt: at,
  });
  const workspace = createReplicatedWorkspaceDocument(legacy, replica);
  await persistence.commit({
    operationId: createUuidV7(),
    scope: "bootstrap",
    localStates: [],
    documents: [note, workspace].map((doc) => ({
      kind: doc.kind,
      documentId: doc.id,
      schemaVersion: doc.schemaVersion,
      baseRevision: 0,
      snapshot: encodeProductDocument(doc),
      update: null,
    })),
  });
  const peer = loadProductDocument(
    "note",
    noteId,
    encodeProductDocument(note),
    [],
    createUuidV7(),
  ) as NoteDocument;
  cleanup.push(() => peer.doc.destroy());
  const peerWorkspace = loadProductDocument(
    "workspace",
    workspace.id,
    encodeProductDocument(workspace),
    [],
    createUuidV7(),
  ) as WorkspaceDocument;
  cleanup.push(() => peerWorkspace.doc.destroy());
  peer.replicated!.clock = () => remoteAt;
  note.doc.destroy();
  workspace.doc.destroy();
  legacy.doc.destroy();
  const core = await CoreRuntime.open(persistence, {
    clock: () => "2026-09-10T00:00:00.000Z",
  });
  cleanup.push(() => core.destroy());
  await core.openNote("window-1", noteId);
  const element = document.createElement("div");
  document.body.append(element);
  const adapter = core.attachEditor("window-1", element);
  cleanup.push(() => adapter.destroy());
  let position = 0;
  adapter.editor.state.doc.descendants((node, pos) => {
    if (node.attrs.blockId === blockId) position = pos + 1;
  });
  adapter.editor.commands.setTextSelection(position);
  await core.flush();
  const remote = () => {
    const vector = Y.encodeStateVector(peer.doc);
    peer.replicated!.transact(() =>
      (peer.replicated!.inline(blockId).get(0) as Y.XmlText).insert(
        3,
        " remote",
      ),
    );
    return Y.encodeStateAsUpdate(peer.doc, vector);
  };
  const port = async (
    update = remote(),
    kind: "note" | "workspace" = "note",
    affectedNoteIds = [noteId],
  ) => {
    const documentId = kind === "note" ? noteId : peerWorkspace.id;
    const persisted = await persistence.loadDocument(kind, documentId);
    const document = {
      kind,
      documentId,
      baseRevision: persisted.revision,
      schemaVersion: kind === "note" ? 7 : 4,
      update,
      snapshot: null,
    };
    const delivery: SyncDelivery = {
      localHelpNoteIds: [],
      workspaceId: core.workspaceDocument.workspaceId,
      groupId: createUuidV7(),
      affectedNoteIds,
      frontier: { received: {}, applied: {} },
      workspaceRevisionBefore: kind === "workspace" ? persisted.revision : null,
      documents: [
        {
          kind,
          documentId,
          revision: persisted.revision + 1,
          update: base64(update),
        },
      ],
    };
    const prepared: SyncPreparation = {
      id: createUuidV7(),
      workspaceId: delivery.workspaceId,
      groupId: delivery.groupId,
      affectedNoteIds,
      documents: [document],
      delivery: null,
    };
    const operationId = createUuidV7();
    const commit = vi.fn(async () => {
      await persistence.commit({
        operationId,
        scope: "note-doc",
        documents: [document],
        localStates: [],
      });
      return delivery;
    });
    const port = {
      prepare: vi.fn(async () => prepared),
      commit,
      cancel: vi.fn(async () => {}),
      ack: vi.fn(async () => {}),
    } satisfies SyncPublicationPort;
    return { port, prepared, delivery, update };
  };
  const trash = async () => {
    const vector = Y.encodeStateVector(peerWorkspace.doc);
    const entryId = readNoteMetadata(peerWorkspace, noteId)!.entryId!;
    applyNamespacePlan(
      peerWorkspace,
      planNamespaceEdit(
        peerWorkspace,
        { kind: "trash", entryId, at: remoteAt },
        createUuidV7(),
      ),
      "peer",
    );
    return port(Y.encodeStateAsUpdate(peerWorkspace.doc, vector), "workspace");
  };
  return { core, persistence, adapter, port, trash, noteId };
}

describe("durable synchronization publication", () => {
  it("defers a Workspace-only Trash update during IME and preserves input queued after its SQL commit for restoration", async () => {
    const { core, persistence, adapter, trash, noteId } = await fixture();
    const note = core.noteDocument;
    const remote = await trash();
    const composition = (type: string) =>
      adapter.editor.view.dom.dispatchEvent(
        new CompositionEvent(type, { bubbles: true }),
      );
    composition("compositionstart");
    expect(await core.applyNextSynchronization(remote.port, () => true)).toBe(
      "deferred",
    );
    expect(remote.port.commit).not.toHaveBeenCalled();
    composition("compositionend");
    await vi.waitFor(() => expect(adapter.editor.view.composing).toBe(false));
    const commit = remote.port.commit.getMockImplementation()!;
    remote.port.commit.mockImplementation(async () => {
      const delivery = await commit();
      composition("compositionstart");
      return delivery;
    });
    const pending = core.applyNextSynchronization(remote.port, () => true);
    await vi.waitFor(() => expect(adapter.editor.view.composing).toBe(true));
    adapter.editor.commands.insertContent("保護した入力 ");
    composition("compositionend");
    expect(await pending).toBe("applied");
    await core.flush();
    expect(readNoteMetadata(core.workspaceDocument, noteId)!.deletedAt).toBe(
      remoteAt,
    );
    expect(readNotePlainText(note)).toBe("保護した入力 abc");
    const saved = await persistence.loadDocument("note", noteId);
    const loaded = loadProductDocument(
      "note",
      noteId,
      saved.snapshot!,
      saved.updates.map((u) => u.update),
      createUuidV7(),
    ) as NoteDocument;
    expect(readNotePlainText(loaded)).toBe("保護した入力 abc");
    loaded.doc.destroy();
    await core.restoreNoteFromTrash(noteId);
    await core.openNote("window-1", noteId);
    expect(readNotePlainText(core.noteDocument)).toBe("保護した入力 abc");
  });

  it("updates the mounted Editor without echo, timestamp rewrite, local Undo entry or DOM replacement", async () => {
    const { core, persistence, adapter, port } = await fixture();
    const remote = await port();
    const dom = adapter.editor.view.dom;
    const undo = core.noteDocument.undoManager.undoStack.length;
    const save = vi.spyOn(persistence, "commit");
    expect(await core.applyNextSynchronization(remote.port, () => true)).toBe(
      "applied",
    );
    await core.flush();
    expect(readNotePlainText(core.noteDocument)).toBe("abc remote");
    expect(adapter.editor.state.doc.textContent).toContain("abc remote");
    expect(adapter.editor.view.dom).toBe(dom);
    expect(readNoteUpdatedAt(core.noteDocument)).toBe(remoteAt);
    expect(core.noteDocument.undoManager.undoStack).toHaveLength(undo);
    expect(
      save.mock.calls.flatMap(([request]) => request.documents),
    ).toHaveLength(1);
    expect(remote.port.ack).toHaveBeenCalledWith(remote.prepared.id);
  });

  it("cancels stale preparation after local input and merges both edits on retry", async () => {
    const { core, adapter, port } = await fixture();
    const remote = await port();
    let resolve!: (value: SyncPreparation) => void;
    remote.port.prepare.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = core.applyNextSynchronization(remote.port, () => true);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    adapter.editor.commands.insertContent("local ");
    resolve(remote.prepared);
    expect(await pending).toBe("deferred");
    expect(remote.port.commit).not.toHaveBeenCalled();
    expect(remote.port.cancel).toHaveBeenCalledWith(remote.prepared.id);
    await core.flush();
    const retry = await port(remote.update);
    expect(await core.applyNextSynchronization(retry.port, () => true)).toBe(
      "applied",
    );
    expect(readNotePlainText(core.noteDocument)).toBe("local abc remote");
  });

  it("defers before SQL during composition and also holds a committed delivery until a newly started composition ends", async () => {
    const { core, adapter, port } = await fixture();
    const remote = await port();
    adapter.editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(await core.applyNextSynchronization(remote.port, () => true)).toBe(
      "deferred",
    );
    expect(remote.port.commit).not.toHaveBeenCalled();
    adapter.editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() => expect(adapter.editor.view.composing).toBe(false));
    const commit = remote.port.commit.getMockImplementation()!;
    remote.port.commit.mockImplementation(async () => {
      const delivery = await commit();
      adapter.editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      return delivery;
    });
    const pending = core.applyNextSynchronization(remote.port, () => true);
    await vi.waitFor(() => expect(adapter.editor.view.composing).toBe(true));
    expect(readNotePlainText(core.noteDocument)).toBe("abc");
    adapter.editor.commands.insertContent("日本語");
    let flushed = false;
    const flush = core.flushDurableState().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    adapter.editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(await pending).toBe("applied");
    await flush;
    expect(readNotePlainText(core.noteDocument)).toBe("日本語abc remote");
  });

  it("replays a retained delivery after a lost ack without rewinding newer local revisions", async () => {
    const { core, adapter, port } = await fixture();
    const remote = await port();
    remote.port.ack.mockRejectedValueOnce(new Error("reply lost"));
    await expect(
      core.applyNextSynchronization(remote.port, () => true),
    ).rejects.toThrow("reply lost");
    adapter.editor.commands.insertContent("local ");
    await core.flush();
    remote.prepared.delivery = remote.delivery;
    remote.prepared.documents = [];
    adapter.editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(await core.applyNextSynchronization(remote.port, () => true)).toBe(
      "deferred",
    );
    expect(remote.port.cancel).not.toHaveBeenCalled();
    adapter.editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() => expect(adapter.editor.view.composing).toBe(false));
    expect(await core.applyNextSynchronization(remote.port, () => true)).toBe(
      "applied",
    );
    expect(remote.port.commit).toHaveBeenCalledTimes(1);
    adapter.editor.commands.insertContent("again ");
    await core.flush();
    expect(readNotePlainText(core.noteDocument)).toBe("local again abc remote");
  });

  it("retries ambiguous commit responses with the same ticket and stops on a definite precommit rejection", async () => {
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC lost"))
      .mockRejectedValueOnce({ code: "SYNC_RESPONSE_LOST" })
      .mockResolvedValue({ documents: [] });
    const port = { commit } as unknown as SyncPublicationPort;
    const pause = vi.fn(async () => {});
    await recoverSyncCommit(port, "ticket", pause);
    expect(commit.mock.calls).toEqual([["ticket"], ["ticket"], ["ticket"]]);
    expect(pause).toHaveBeenCalledTimes(2);
    commit.mockRejectedValue({ code: "REVISION_CONFLICT" });
    await expect(recoverSyncCommit(port, "ticket", pause)).rejects.toEqual({
      code: "REVISION_CONFLICT",
    });
  });
});
