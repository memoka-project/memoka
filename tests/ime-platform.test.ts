import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  createNormalModeImeGuard,
  decodeImeDeactivationResult,
} from "../app/src/core/ime-platform";

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockClear();
});

describe("Memoka IME platform boundary", () => {
  it("accepts only the typed deactivation response", () => {
    expect(
      decodeImeDeactivationResult({
        supported: true,
        inactive: true,
        detail: "fcitx5-inactive",
      }),
    ).toEqual({
      supported: true,
      inactive: true,
      detail: "fcitx5-inactive",
    });
  });

  it.each([
    null,
    {},
    { supported: "yes", inactive: true, detail: "invalid" },
    { supported: true, inactive: 1, detail: "invalid" },
    { supported: true, inactive: false, detail: null },
  ])("rejects an invalid platform response %#", (value) => {
    expect(decodeImeDeactivationResult(value)).toBeNull();
  });

  it("keeps the native guard active while any focused Normal editor owns it", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const first = createNormalModeImeGuard();
    const second = createNormalModeImeGuard();
    invoke.mockClear();

    first.setActive(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith(
      "set_normal_mode_ime_guard",
      expect.objectContaining({ active: true }),
    );

    second.setActive(true);
    first.setActive(false);
    expect(invoke).toHaveBeenCalledTimes(1);

    second.setActive(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "set_normal_mode_ime_guard",
      expect.objectContaining({ active: false }),
    );

    first.destroy();
    second.destroy();
  });
});
