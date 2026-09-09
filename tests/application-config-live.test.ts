import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createDefaultApplicationConfigPort,
  loadApplicationConfig,
} from "../app/src/platform/application-config";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const wire = {
  configPath: "/isolated/config.toml",
  config: {},
  theme: "nightfox",
  customThemes: {},
  fontFamily: "serif",
  zoomPercent: 100,
  noteMaxWidthPx: 1000,
  lineNumberMinWidthPx: 480,
  indentWidthPx: 24,
  japaneseWordSegmentation: "fine",
  japaneseLineBreakSegmentation: "fine",
  warning: null,
};

describe("application configuration reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads only changed revisions, accepts named themes without mutating the registry, and cleans up polling", async () => {
    let revision = "first";
    const loaded = {
      ...wire,
      theme: "mine",
      customThemes: { mine: { base: "dayfox", palette: { blue: "#123456" } } },
    };
    vi.mocked(invoke).mockImplementation(
      async (command) =>
        (command === "application_config_revision"
          ? revision
          : loaded) as never,
    );
    const listener = vi.fn();
    const unsubscribe =
      createDefaultApplicationConfigPort().subscribe!(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      valid: true,
      theme: "mine",
      customThemes: loaded.customThemes,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "application_key_config_load",
        ),
    ).toHaveLength(1);
    revision = "second";
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    const calls = vi.mocked(invoke).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    window.dispatchEvent(new Event("focus"));
    expect(invoke).toHaveBeenCalledTimes(calls);
  });

  it("does not publish a read that raced with a GUI setting write", async () => {
    let finishRead: ((value: unknown) => void) | undefined;
    let revision = "old";
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "application_config_revision") return revision as never;
      if (command === "application_key_config_load")
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      revision = "new";
      return undefined as never;
    });
    const port = createDefaultApplicationConfigPort();
    const listener = vi.fn();
    const unsubscribe = port.subscribe!(listener);
    await vi.advanceTimersByTimeAsync(0);
    await port.saveTheme("dayfox");
    finishRead!(wire);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    finishRead!({ ...wire, theme: "dayfox" });
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].theme).toBe("dayfox");
    unsubscribe();
  });

  it("caches the revision of the loaded bytes rather than an earlier probe", async () => {
    let revision = "before-read";
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "application_config_revision") return revision as never;
      revision = "loaded-bytes";
      return { ...wire, revision } as never;
    });
    const listener = vi.fn();
    const unsubscribe =
      createDefaultApplicationConfigPort().subscribe!(listener);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].revision).toBe("loaded-bytes");
    unsubscribe();
  });

  it("distinguishes invalid fallback settings from valid settings with a legacy warning", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockResolvedValue({
      ...wire,
      config: null,
      warning: "invalid TOML",
    });
    expect((await loadApplicationConfig()).valid).toBe(false);
    vi.mocked(invoke).mockResolvedValue({
      ...wire,
      warning: "retired binding ignored",
    });
    expect((await loadApplicationConfig()).valid).toBe(true);
  });
});
