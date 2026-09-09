import { describe, expect, it, vi } from "vitest";
import {
  nativeAgentEdit,
  recoverAgentCommit,
  recoverAgentPublication,
  type AgentDelivery,
} from "../app/src/core/native-agent-edit";
import {
  MemoryPersistencePort,
  type PersistenceCommitRequest,
} from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryWorkspaceSearchIndexPort } from "../app/src/core/workspace-search-index";

class AgentDeliveryPersistence extends MemoryPersistencePort {
  commits: PersistenceCommitRequest[] = [];
  noteLoads = 0;
  override async commit(request: PersistenceCommitRequest) {
    const result = await super.commit(request);
    this.commits.push(request);
    return result;
  }
  override async loadDocument(
    ...args: Parameters<MemoryPersistencePort["loadDocument"]>
  ) {
    if (args[0] === "note") this.noteLoads++;
    return super.loadDocument(...args);
  }
}

describe("external edit delivery recovery", () => {
  const delivery: AgentDelivery = {
    result: { revision_after: 4, replayed: false, status: "applied" },
    documents: [],
  };
  it("keeps recovering the same ticket after repeated lost responses", async () => {
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockRejectedValueOnce({ code: "AGENT_RESPONSE_LOST" })
      .mockRejectedValueOnce("transport unavailable")
      .mockResolvedValue(delivery);
    const pause = vi.fn(async () => undefined);
    await expect(recoverAgentCommit(commit, pause)).resolves.toBe(delivery);
    expect(commit).toHaveBeenCalledTimes(4);
    expect(pause).toHaveBeenCalledTimes(3);
  });
  it("does not retry a rejected precommit request", async () => {
    const error = { code: "REVISION_CONFLICT" };
    const commit = vi.fn().mockRejectedValue(error);
    const pause = vi.fn(async () => undefined);
    await expect(recoverAgentCommit(commit, pause)).rejects.toBe(error);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });
  it("keeps the publication barrier after an observer fails and yields between retries", async () => {
    const publish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("observer failed");
      })
      .mockImplementation(() => undefined);
    const pause = vi.fn(async () => undefined);
    await expect(
      recoverAgentPublication(publish, () => true, pause),
    ).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it("does not publish into a retired Workspace runtime", async () => {
    const publish = vi.fn();
    await expect(recoverAgentPublication(publish, () => false)).resolves.toBe(
      false,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("indexes only the new or renamed hidden Note and only hierarchy on a move", async () => {
    const persistence = new AgentDeliveryPersistence();
    const index = new MemoryWorkspaceSearchIndexPort();
    const runtime = await CoreRuntime.open(persistence, {
      initialTitle: "Parent",
      workspaceSearchIndex: index,
    });
    await runtime.flush();
    // A separate in-memory runtime stands in for native private staging + SQL.
    // No user files, GUI or second real Workspace writer participate in this test.
    const source = await CoreRuntime.open(persistence);
    const prepare = vi
      .spyOn(nativeAgentEdit, "prepare")
      .mockResolvedValue({ complete: false });
    const commit = vi.spyOn(nativeAgentEdit, "commit");
    const before = runtime.snapshot();
    const rebuilds = index.rebuildCount;
    let noteId: string | undefined;
    const publish = async (change: () => Promise<unknown>) => {
      const baseRevision = runtime.snapshot().workspaceRevision;
      const start = persistence.commits.length;
      await change();
      const documents = persistence.commits
        .slice(start)
        .flatMap((request) => request.documents)
        .map((document) => ({
          kind: document.kind,
          document_id: document.documentId,
          revision: document.baseRevision + 1,
          update: Array.from(document.update ?? document.snapshot!),
        }));
      const entry = source
        .snapshot()
        .namespaceEntries.find((entry) => entry.targetNoteId === noteId)!;
      const delivery: AgentDelivery = {
        result: {
          revision_after: baseRevision + 1,
          status: "applied",
          replayed: false,
          workspace_revision_before: baseRevision,
          entry_id: entry.entryId,
        },
        documents,
      };
      commit.mockResolvedValueOnce(delivery);
      const loads = persistence.noteLoads;
      await runtime.applyExternalAgentEdit(
        "ticket",
        {
          workspace_id: runtime.workspaceDocument.workspaceId,
          note_id: null,
          expected_revision: null,
          request_id: "request",
        },
        () => true,
      );
      await runtime.flush();
      expect(runtime.snapshot().loadedNoteIds).toEqual(before.loadedNoteIds);
      expect(runtime.snapshot().noteId).toBe(before.noteId);
      expect(index.rebuildCount).toBe(rebuilds);
      return persistence.noteLoads - loads;
    };
    try {
      expect(
        await publish(async () => {
          noteId = (await source.createChildNote("window-1", source.noteId))
            .noteId;
        }),
      ).toBe(1);
      expect(
        await publish(() => source.renameNote(noteId!, "Hidden child")),
      ).toBe(1);
      expect(await runtime.searchWorkspace("Hidden", "title")).toMatchObject({
        backend: "sqlite-fts",
        results: [expect.objectContaining({ noteId, parentPath: "/Parent" })],
      });
      expect(
        await publish(() =>
          source.moveNote(noteId!, {
            targetParentId: null,
            placement: { kind: "first" },
          }),
        ),
      ).toBe(0);
      expect(await runtime.searchWorkspace("Hidden", "title")).toMatchObject({
        results: [expect.objectContaining({ noteId, parentPath: "/" })],
      });
    } finally {
      prepare.mockRestore();
      commit.mockRestore();
      source.destroy();
      runtime.destroy();
    }
  });
});
