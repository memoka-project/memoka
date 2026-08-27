import { describe, expect, it } from "vitest";
import { InputLatencyMonitor } from "../app/src/core/development-diagnostics";

describe("development diagnostics", () => {
  it("measures keydown through the corresponding input's next frame", () => {
    const root = document.createElement("main");
    const editor = document.createElement("div");
    editor.className = "application-workspace";
    root.append(editor);
    document.body.append(root);
    let now = 10;
    let frame: FrameRequestCallback | null = null;
    const monitor = new InputLatencyMonitor(
      root,
      () => now,
      (callback) => {
        frame = callback;
        return 1;
      },
      () => undefined,
    );

    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        bubbles: true,
      }),
    );
    now = 14;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(frame).not.toBeNull();
    now = 27;
    runFrame(frame, now);

    expect(monitor.snapshot()).toMatchObject({
      lastKey: "a",
      lastMs: 17,
      p50Ms: 17,
      p95Ms: 17,
      maxMs: 17,
      sampleCount: 1,
      slowSampleCount: 0,
    });
    monitor.destroy();
  });

  it("does not let debug-line mutations complete an input sample", async () => {
    const root = document.createElement("main");
    const workspace = document.createElement("div");
    workspace.className = "application-workspace";
    const debug = document.createElement("footer");
    debug.className = "debug-line";
    root.append(workspace, debug);
    document.body.append(root);
    let now = 0;
    let frame: FrameRequestCallback | null = null;
    const monitor = new InputLatencyMonitor(
      root,
      () => now,
      (callback) => {
        frame = callback;
        return 1;
      },
      () => undefined,
    );

    workspace.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        code: "KeyJ",
        bubbles: true,
      }),
    );
    debug.textContent = "poll";
    await Promise.resolve();
    expect(frame).toBeNull();

    workspace.classList.add("changed");
    await Promise.resolve();
    expect(frame).not.toBeNull();
    now = 12;
    runFrame(frame, now);
    expect(monitor.snapshot().lastMs).toBe(12);
    monitor.destroy();
  });
});

function runFrame(frame: FrameRequestCallback | null, now: number): void {
  if (!frame) throw new Error("Expected a scheduled animation frame");
  frame(now);
}
