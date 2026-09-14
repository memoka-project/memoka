import { afterEach, describe, expect, it, vi } from "vitest";
import { createSynchronizationPump } from "../app/src/core/native-sync";

afterEach(() => vi.useRealTimers());
describe("synchronization publication scheduling", () => {
  it("coalesces notifications with a fixed deadline, then drains the backlog without per-edit waits", async () => {
    vi.useFakeTimers();
    let remaining = 100;
    const apply = vi.fn(async () =>
      remaining-- > 0 ? ("applied" as const) : ("idle" as const),
    );
    const pump = createSynchronizationPump(apply);
    pump.request();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(10);
      pump.request();
    }
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(apply).toHaveBeenCalledTimes(101);
    pump.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("backs off during composition and cancels pending work on Workspace teardown", async () => {
    vi.useFakeTimers();
    const apply = vi.fn(async () => "deferred" as const);
    const pump = createSynchronizationPump(apply);
    pump.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(apply).toHaveBeenCalledTimes(2);
    pump.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
