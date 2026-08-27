import { describe, expect, it } from "vitest";
import { assertUuidV7, createUuidV7, isUuidV7 } from "../app/src/core/ids";

describe("Memoka UUIDv7 identifiers", () => {
  it("encodes the timestamp, version and RFC variant", () => {
    const id = createUuidV7(0x0123456789ab, (target) => {
      target.fill(0xff);
      return target;
    });
    expect(id).toBe("01234567-89ab-7fff-bfff-ffffffffffff");
    expect(isUuidV7(id)).toBe(true);
  });

  it("rejects non-v7 identifiers at the Core boundary", () => {
    expect(() => assertUuidV7("01900000-0000-4000-8000-000000000000")).toThrow(
      "UUIDv7",
    );
    expect(() => createUuidV7(-1)).toThrow("48 bits");
  });
});
