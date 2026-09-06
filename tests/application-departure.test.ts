import { describe, expect, it, vi } from "vitest";
import {
  ApplicationDeparture,
  type ApplicationDepartureProgress,
} from "../app/src/core/application-departure";
import { backupFixture } from "./backup-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let progress: ApplicationDepartureProgress | null = null;
  const coordinator = new ApplicationDeparture((value) => {
    progress = value;
  });
  const options = {
    kind: "quit" as const,
    save: vi.fn(async () => undefined),
    backup: backupFixture(),
    controller: {
      pause: vi.fn(),
      resume: vi.fn(),
      flush: vi.fn(async (): Promise<void> => undefined),
      cancel: vi.fn(async (): Promise<void> => undefined),
    },
    complete: vi.fn(async () => undefined),
  };
  return { coordinator, options, progress: () => progress };
}

describe("shared quit/switch/update durability barrier", () => {
  it.each(["quit", "switch-workspace", "update"] as const)(
    "%s only proceeds after Core, local capture and transfer",
    async (kind) => {
      const { coordinator, options } = fixture();
      const order: string[] = [];
      options.save.mockImplementation(async () => {
        order.push("core");
      });
      options.controller.flush.mockImplementation(async () => {
        order.push("backup");
      });
      options.complete.mockImplementation(async () => {
        order.push("complete");
      });
      expect(await coordinator.start({ ...options, kind })).toBe(true);
      expect(order).toEqual(["core", "backup", "complete"]);
      expect(options.controller.pause).toHaveBeenCalledOnce();
      expect(options.controller.resume).not.toHaveBeenCalled();
    },
  );

  it("never skips a failed Core save, and retry establishes a new barrier", async () => {
    const { coordinator, options, progress } = fixture();
    options.save.mockRejectedValueOnce(new Error("disk full"));
    const result = coordinator.start(options);
    await vi.waitFor(() => expect(progress()?.stage).toBe("saving-error"));
    await coordinator.leave(true);
    expect(options.complete).not.toHaveBeenCalled();
    expect(options.controller.flush).not.toHaveBeenCalled();
    coordinator.retry();
    expect(await result).toBe(true);
    expect(options.save).toHaveBeenCalledTimes(2);
  });

  it("retains local success on transfer failure until retry or explicit skip", async () => {
    const { coordinator, options, progress } = fixture();
    const state = await options.backup.status();
    options.backup.status = async () => ({
      ...state,
      config: {
        ...state.config,
        destinations: [
          {
            id: "offline",
            path: "/offline",
            repository_id: "repo",
            enabled: true,
            retention: state.config.local_retention,
          },
        ],
      },
      status: {
        ...state.status,
        destinations: {
          offline: {
            phase: "error",
            protected_capture_at: null,
            last_copy_at: null,
            maintenance_error: null,
            pending_copy_count: 1,
            expired_copy_count: 0,
            error: { code: "OFFLINE", message: "Target disconnected" },
          },
        },
      },
    });
    const result = coordinator.start({ ...options, kind: "switch-workspace" });
    await vi.waitFor(() => expect(progress()?.stage).toBe("backup-error"));
    expect(progress()?.error).toContain("ローカル履歴は保存済み");
    expect(options.complete).not.toHaveBeenCalled();
    await coordinator.leave(true);
    expect(await result).toBe(true);
    expect(options.controller.cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for disabled destinations with old errors", async () => {
    const { coordinator, options } = fixture();
    const state = await options.backup.status();
    options.backup.status = async () => ({
      ...state,
      config: {
        ...state.config,
        destinations: [
          {
            id: "disabled",
            path: "/offline",
            repository_id: "repo",
            enabled: false,
            retention: state.config.local_retention,
          },
        ],
      },
      status: {
        ...state.status,
        destinations: {
          disabled: {
            phase: "disabled",
            protected_capture_at: null,
            last_copy_at: null,
            error: { code: "OFFLINE", message: "not connected" },
            maintenance_error: null,
            pending_copy_count: 10,
            expired_copy_count: 3,
          },
        },
      },
    });
    expect(await coordinator.start(options)).toBe(true);
    expect(options.complete).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "waits for child reaping when cancelling with proceed=%s",
    async (proceed) => {
      const { coordinator, options, progress } = fixture();
      const copying = deferred();
      const reaped = deferred();
      options.controller.flush.mockImplementation(() => copying.promise);
      options.controller.cancel.mockImplementation(async () => {
        await reaped.promise;
        copying.resolve();
      });
      const result = coordinator.start({ ...options, kind: "update" });
      await vi.waitFor(() =>
        expect(options.controller.flush).toHaveBeenCalledOnce(),
      );
      const leaving = coordinator.leave(proceed);
      expect(progress()?.stage).toBe("cancelling");
      expect(options.complete).not.toHaveBeenCalled();
      expect(options.controller.resume).not.toHaveBeenCalled();
      reaped.resolve();
      await leaving;
      expect(await result).toBe(proceed);
      expect(options.complete).toHaveBeenCalledTimes(proceed ? 1 : 0);
      expect(options.controller.resume).toHaveBeenCalledTimes(proceed ? 0 : 1);
      expect(progress()).toBeNull();
    },
  );

  it("does not start a second departure or finish from an old cancelled attempt", async () => {
    const { coordinator, options, progress } = fixture();
    const copying = deferred();
    options.controller.flush.mockImplementationOnce(() => copying.promise);
    options.controller.cancel.mockImplementation(async () => {
      copying.resolve();
    });
    const first = coordinator.start(options);
    await vi.waitFor(() =>
      expect(options.controller.flush).toHaveBeenCalledOnce(),
    );
    expect(await coordinator.start(options)).toBe(false);
    await coordinator.leave(false);
    expect(await first).toBe(false);
    expect(await coordinator.start({ ...options, kind: "update" })).toBe(true);
    expect(options.complete).toHaveBeenCalledOnce();
    expect(progress()).toBeNull();
  });
});
