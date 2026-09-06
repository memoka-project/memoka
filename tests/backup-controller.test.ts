import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupController } from "../app/src/core/history";
import type { CoreRuntime } from "../app/src/core/runtime";
import { backupFixture } from "./backup-fixture";

describe("backup cancellation and confirmed Core barrier", () => {
  afterEach(() => vi.useRealTimers());
  it("resumes scheduling without clearing a departure owned by the coordinator", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const controller = new BackupController(
      {} as CoreRuntime,
      backupFixture({
        setDeparture: async (active) => {
          calls.push(`departure:${active}`);
        },
        resume: async () => {
          calls.push("resume");
        },
      }),
      vi.fn(),
    );
    controller.pause();
    controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["resume"]);
    controller.destroy();
  });
  it("does not launch a late native capture after cancellation during the Core barrier", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const flushDurableState = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const run = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const controller = new BackupController(
      { flushDurableState } as unknown as CoreRuntime,
      backupFixture({ run, resume }),
      vi.fn(),
    );
    const pending = controller.run();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
    });
    const cancelled = controller.cancel();
    release();
    await cancelled;
    await rejected;
    expect(resume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("does not restart a cancelled flush when the earlier capture finishes successfully", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const native = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => native);
    const resume = vi.fn(async () => undefined);
    const controller = new BackupController(
      { flushDurableState: async () => undefined } as unknown as CoreRuntime,
      backupFixture({ run, resume }),
      vi.fn(),
    );
    const pending = controller.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    const flush = controller.flush();
    const rejected = expect(flush).rejects.toMatchObject({ code: "CANCELLED" });
    const cancelled = controller.cancel();
    release();
    await pending;
    await cancelled;
    await rejected;
    expect(run).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("does not enter native backup when Core saving fails, and can retry", async () => {
    vi.useFakeTimers();
    const flushDurableState = vi
      .fn()
      .mockRejectedValueOnce(new Error("Core failed"))
      .mockResolvedValue(undefined);
    const run = vi.fn(async () => undefined);
    const controller = new BackupController(
      { flushDurableState } as unknown as CoreRuntime,
      backupFixture({ run }),
      vi.fn(),
    );
    await expect(controller.run()).rejects.toThrow("Core failed");
    expect(run).not.toHaveBeenCalled();
    await controller.run();
    expect(run).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
});
