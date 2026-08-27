import { describe, expect, it } from "vitest";
import { decodeImeDeactivationResult } from "../app/src/core/ime-platform";

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
});
