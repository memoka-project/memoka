import { describe, expect, it, vi } from "vitest";
import {
  ApplicationDeparture,
  type ApplicationDepartureKind,
  type ApplicationDepartureProgress,
} from "../app/src/core/application-departure";
import { backupFixture } from "./backup-fixture";
import { BackupController, type BackupPort } from "../app/src/core/history";
import type { CoreRuntime } from "../app/src/core/runtime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(kind: ApplicationDepartureKind = "switch-workspace") {
  let progress: ApplicationDepartureProgress | null = null;
  const coordinator = new ApplicationDeparture((value) => {
    progress = value;
  });
  const options = {
    kind,
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
  it("quits after Core save and safe child cleanup without waiting for backup success", async () => {
    const { coordinator, options, progress } = fixture("quit");
    const saved = deferred();
    const reaped = deferred();
    const order: string[] = [];
    options.save.mockImplementation(async () => {
      await saved.promise;
      order.push("core");
    });
    options.controller.cancel.mockImplementation(async () => {
      order.push("stop");
      await reaped.promise;
    });
    options.complete.mockImplementation(async () => {
      order.push("close");
    });
    options.backup.status = vi.fn(async () => {
      throw new Error("Backup destination is offline");
    });
    options.backup.waitTransfers = vi.fn(() => new Promise(() => undefined));
    options.backup.setDeparture = vi.fn(async () => undefined);
    const result = coordinator.start(options);
    expect(options.controller.pause).toHaveBeenCalledOnce();
    expect(await coordinator.start(options)).toBe(false);
    await vi.waitFor(() => expect(options.save).toHaveBeenCalledOnce());
    expect(options.controller.cancel).not.toHaveBeenCalled();
    expect(options.complete).not.toHaveBeenCalled();
    saved.resolve();
    await vi.waitFor(() => expect(progress()?.stage).toBe("stopping"));
    await coordinator.leave(false);
    expect(options.controller.resume).not.toHaveBeenCalled();
    expect(options.complete).not.toHaveBeenCalled();
    reaped.resolve();
    expect(await result).toBe(true);
    expect(order).toEqual(["core", "stop", "close"]);
    expect(options.controller.flush).not.toHaveBeenCalled();
    expect(options.backup.status).not.toHaveBeenCalled();
    expect(options.backup.waitTransfers).not.toHaveBeenCalled();
    expect(options.backup.setDeparture).not.toHaveBeenCalled();
  });

  it("does not force quit if child cleanup fails; retry saves and stops again", async () => {
    const { coordinator, options, progress } = fixture("quit");
    options.controller.cancel.mockRejectedValueOnce(
      new Error("cleanup failed"),
    );
    const result = coordinator.start(options);
    await vi.waitFor(() => expect(progress()?.stage).toBe("stopping-error"));
    await coordinator.leave(true);
    expect(options.complete).not.toHaveBeenCalled();
    coordinator.retry();
    expect(await result).toBe(true);
    expect(options.save).toHaveBeenCalledTimes(2);
    expect(options.controller.cancel).toHaveBeenCalledTimes(2);
    expect(options.controller.flush).not.toHaveBeenCalled();
  });

  it("waits for failed quit cleanup before reopening background admission", async () => {
    const { coordinator, options, progress } = fixture("quit");
    const reaped = deferred();
    options.controller.cancel
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockImplementationOnce(() => reaped.promise);
    const result = coordinator.start(options);
    await vi.waitFor(() => expect(progress()?.stage).toBe("stopping-error"));
    const leaving = coordinator.leave(false);
    expect(options.controller.resume).not.toHaveBeenCalled();
    reaped.resolve();
    await leaving;
    expect(await result).toBe(false);
    expect(options.controller.resume).toHaveBeenCalledOnce();
    expect(options.complete).not.toHaveBeenCalled();
  });

  it("stops an earlier manual capture without starting a final capture on quit", async () => {
    const { coordinator, options } = fixture("quit");
    const active = deferred();
    const nativeRun = vi.fn(() => active.promise);
    const nativeCancel = vi.fn(async () => active.resolve());
    const port = backupFixture({ run: nativeRun, cancel: nativeCancel });
    const controller = new BackupController(
      { flushDurableState: async () => undefined } as unknown as CoreRuntime,
      port,
      vi.fn(),
    );
    controller.pause();
    try {
      const manual = controller.run();
      await vi.waitFor(() => expect(nativeRun).toHaveBeenCalledOnce());
      expect(
        await coordinator.start({ ...options, backup: port, controller }),
      ).toBe(true);
      await manual;
      expect(nativeCancel).toHaveBeenCalledOnce();
      expect(nativeRun).toHaveBeenCalledOnce();
      expect(options.complete).toHaveBeenCalledOnce();
    } finally {
      active.resolve();
      controller.destroy();
    }
  });

  it("keeps waiting beyond 30 seconds without cancelling a transfer or entering an error", async () => {
    const { coordinator, options, progress } = fixture();
    vi.useFakeTimers();
    try {
      const transfer = deferred();
      const waitTransfers = vi.fn(() => transfer.promise);
      const setDeparture = vi
        .fn<NonNullable<BackupPort["setDeparture"]>>()
        .mockResolvedValue(undefined);
      options.backup.waitTransfers = waitTransfers;
      options.backup.setDeparture = setDeparture;
      options.controller.flush.mockImplementation(async () => {
        expect(setDeparture).toHaveBeenCalledWith(true, expect.any(String));
      });
      const result = coordinator.start(options);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(progress()?.stage).toBe("backup");
      expect(waitTransfers).toHaveBeenCalledExactlyOnceWith(
        setDeparture.mock.calls[0]![1],
      );
      expect(options.controller.cancel).not.toHaveBeenCalled();
      expect(options.complete).not.toHaveBeenCalled();
      transfer.resolve();
      expect(await result).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["switch-workspace", "update"] as const)(
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

  it("can depart after upload even when verification is queued or failed", async () => {
    const { coordinator, options } = fixture();
    const base = await options.backup.status();
    options.backup.status = async () => ({
      ...base,
      config: {
        ...base.config,
        destinations: [
          {
            id: "drive",
            enabled: true,
            location: {
              kind: "google-drive",
              connection_id: "test",
              root_folder_id: "test",
              display_name: "test",
            },
            repository_id: "test",
            retention: { last: 48, daily: 30, monthly: 12 },
          },
        ],
      },
      status: {
        ...base.status,
        destinations: {
          drive: {
            phase: "verification-pending",
            protected_capture_at: null,
            last_copy_at: "2026-09-06T12:00:00Z",
            pending_copy_count: 0,
            expired_copy_count: 0,
            pending_verification_count: 1,
            error: null,
            maintenance_error: null,
            verification_error: {
              code: "TEMPORARY",
              message: "Deferred verification unavailable",
            },
          },
        },
      },
    });
    expect(await coordinator.start(options)).toBe(true);
    expect(options.controller.cancel).not.toHaveBeenCalled();
  });

  it.each(["quit", "switch-workspace", "update"] as const)(
    "%s never skips a failed Core save, and retry establishes a new barrier",
    async (kind) => {
      const { coordinator, options, progress } = fixture(kind);
      options.save.mockRejectedValueOnce(new Error("disk full"));
      const result = coordinator.start(options);
      await vi.waitFor(() => expect(progress()?.stage).toBe("saving-error"));
      await coordinator.leave(true);
      expect(options.complete).not.toHaveBeenCalled();
      expect(options.controller.flush).not.toHaveBeenCalled();
      expect(options.controller.cancel).not.toHaveBeenCalled();
      coordinator.retry();
      expect(await result).toBe(true);
      expect(options.save).toHaveBeenCalledTimes(2);
    },
  );

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
            location: { kind: "local-directory", path: "/offline" },
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
            location: { kind: "local-directory", path: "/offline" },
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

  it("waits for child reaping only when explicitly interrupting backup to proceed", async () => {
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
    const leaving = coordinator.leave(true);
    expect(progress()?.stage).toBe("cancelling");
    expect(options.complete).not.toHaveBeenCalled();
    expect(options.controller.resume).not.toHaveBeenCalled();
    reaped.resolve();
    await leaving;
    expect(await result).toBe(true);
    expect(options.controller.cancel).toHaveBeenCalledOnce();
    expect(options.complete).toHaveBeenCalledOnce();
    expect(options.controller.resume).not.toHaveBeenCalled();
    expect(progress()).toBeNull();
  });

  it.each(["switch-workspace", "update"] as const)(
    "withdraws %s without cancelling a manual backup or a queued final capture",
    async (kind) => {
      vi.useFakeTimers();
      const { coordinator, options, progress } = fixture();
      const copying = deferred();
      const nativeRun = vi.fn(() => copying.promise);
      const nativeCancel = vi.fn(async () => undefined);
      const setDeparture = vi
        .fn<NonNullable<BackupPort["setDeparture"]>>()
        .mockResolvedValue(undefined);
      const port = backupFixture({
        run: nativeRun,
        cancel: nativeCancel,
        setDeparture,
        status: vi.fn(options.backup.status),
      });
      const controller = new BackupController(
        { flushDurableState: async () => undefined } as unknown as CoreRuntime,
        port,
        vi.fn(),
      );
      try {
        controller.pause();
        const manual = controller.run();
        await vi.advanceTimersByTimeAsync(0);
        expect(nativeRun).toHaveBeenCalledOnce();
        const result = coordinator.start({
          ...options,
          kind,
          backup: port,
          controller,
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(progress()?.stage).toBe("backup");
        expect(port.status).toHaveBeenCalledOnce();
        await coordinator.leave(false);
        expect(await result).toBe(false);
        expect(nativeCancel).not.toHaveBeenCalled();
        expect(setDeparture.mock.calls).toEqual([
          [true, expect.any(String)],
          [false, setDeparture.mock.calls[0]![1]],
        ]);
        expect(progress()).toBeNull();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(port.status).toHaveBeenCalledOnce(); // old modal poll is stopped
        copying.resolve();
        await manual;
        await vi.advanceTimersByTimeAsync(0);
        expect(nativeRun).toHaveBeenCalledOnce(); // no cancelled departure's final capture
        expect(options.complete).not.toHaveBeenCalled();
      } finally {
        copying.resolve();
        controller.destroy();
        vi.useRealTimers();
      }
    },
  );

  it("detaches cloud waiting, preserving the transfer and isolating a subsequent switch", async () => {
    const { coordinator, options, progress } = fixture();
    const firstWait = deferred();
    const secondWait = deferred();
    const detach = deferred();
    const waitTransfers = vi
      .fn<NonNullable<BackupPort["waitTransfers"]>>()
      .mockImplementationOnce(() => firstWait.promise)
      .mockImplementationOnce(() => secondWait.promise);
    const setDeparture = vi.fn<NonNullable<BackupPort["setDeparture"]>>(
      async (active) => {
        if (!active) await detach.promise;
      },
    );
    options.backup.waitTransfers = waitTransfers;
    options.backup.setDeparture = setDeparture;
    const first = coordinator.start(options);
    await vi.waitFor(() => expect(waitTransfers).toHaveBeenCalledOnce());
    const cancel = coordinator.leave(false);
    expect(progress()?.stage).toBe("resuming");
    expect(options.controller.cancel).not.toHaveBeenCalled();
    expect(options.controller.resume).not.toHaveBeenCalled();
    detach.resolve();
    await cancel;
    expect(await first).toBe(false);
    expect(options.controller.resume).toHaveBeenCalledOnce();
    const second = coordinator.start(options);
    await vi.waitFor(() => expect(waitTransfers).toHaveBeenCalledTimes(2));
    expect(waitTransfers.mock.calls[0]![0]).not.toBe(
      waitTransfers.mock.calls[1]![0],
    );
    firstWait.resolve();
    await Promise.resolve();
    expect(progress()?.stage).toBe("backup");
    expect(options.complete).not.toHaveBeenCalled();
    secondWait.resolve();
    expect(await second).toBe(true);
    expect(options.complete).toHaveBeenCalledOnce();
    expect(options.controller.cancel).not.toHaveBeenCalled();
  });

  it("does not start a second departure or finish from an old cancelled attempt", async () => {
    const { coordinator, options, progress } = fixture();
    const copying = deferred();
    options.controller.flush.mockImplementationOnce(() => copying.promise);
    const first = coordinator.start(options);
    await vi.waitFor(() =>
      expect(options.controller.flush).toHaveBeenCalledOnce(),
    );
    expect(await coordinator.start(options)).toBe(false);
    await coordinator.leave(false);
    expect(await first).toBe(false);
    expect(await coordinator.start({ ...options, kind: "update" })).toBe(true);
    copying.resolve();
    await Promise.resolve();
    expect(options.complete).toHaveBeenCalledOnce();
    expect(progress()).toBeNull();
  });
});
