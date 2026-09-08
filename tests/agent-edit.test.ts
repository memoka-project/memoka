import { describe, expect, it, vi } from "vitest";
import {
  recoverAgentCommit,
  recoverAgentPublication,
  type AgentDelivery,
} from "../app/src/core/native-agent-edit";

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
});
