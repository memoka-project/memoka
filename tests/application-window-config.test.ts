import { describe, expect, it } from "vitest";
import capabilities from "../src-tauri/capabilities/default.json";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("Memoka application window configuration", () => {
  it("uses a frameless resizable main window", () => {
    expect(tauriConfig.app.windows).toHaveLength(1);
    expect(tauriConfig.app.windows[0]).toMatchObject({
      title: "Memoka",
      resizable: true,
      decorations: false,
    });
    expect(tauriConfig).not.toHaveProperty("plugins.updater");
  });

  it("grants only the native operations used by chrome, data-area selection and external links", () => {
    expect(capabilities.permissions).toEqual([
      "core:default",
      "core:window:allow-close",
      "core:window:allow-minimize",
      "core:window:allow-start-dragging",
      "core:window:allow-toggle-maximize",
      "dialog:allow-open",
      "opener:allow-default-urls",
      "process:allow-restart",
      "updater:default",
    ]);
  });
});
