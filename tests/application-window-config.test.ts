import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
      "core:window:allow-destroy",
      "core:window:allow-minimize",
      "core:window:allow-start-dragging",
      "core:window:allow-toggle-maximize",
      "dialog:allow-open",
      "opener:allow-default-urls",
      "process:allow-restart",
      "updater:default",
    ]);
  });

  it("registers single-instance ownership before every other native plugin", () => {
    const repositoryRoot = process.cwd();
    const cargo = readFileSync(
      resolve(repositoryRoot, "src-tauri/Cargo.toml"),
      "utf8",
    );
    const source = readFileSync(
      resolve(repositoryRoot, "src-tauri/src/lib.rs"),
      "utf8",
    );
    expect(cargo).toContain('tauri-plugin-single-instance = "2.4.3"');
    const singleInstance = source.indexOf(
      ".plugin(tauri_plugin_single_instance::init",
    );
    const dialog = source.indexOf(".plugin(tauri_plugin_dialog::init())");
    expect(singleInstance).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(singleInstance);
    expect(source).toContain("window.unminimize()?");
    expect(source).toContain("window.set_focus()");
  });
});
