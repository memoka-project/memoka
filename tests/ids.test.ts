import { describe, expect, it } from "vitest";
import {
  assertUuidV7,
  createUuidV7,
  createUuidV7Batch,
  isUuidV7,
} from "../app/src/core/ids";

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

  it("fills UUIDv7 randomness in bounded batches", () => {
    let sequence = 0;
    const batchSizes: number[] = [];
    const ids = createUuidV7Batch(4_097, 0x0123456789ab, (target) => {
      batchSizes.push(target.length);
      for (let offset = 0; offset < target.length; offset += 16) {
        let value = sequence;
        sequence += 1;
        for (let index = 15; index >= 10; index -= 1) {
          target[offset + index] = value & 0xff;
          value = Math.floor(value / 256);
        }
      }
      return target;
    });

    expect(batchSizes).toEqual([65_536, 16]);
    expect(ids).toHaveLength(4_097);
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(4_097);
    expect(ids[0]).toBe("01234567-89ab-7000-8000-000000000000");
    expect(ids.at(-1)).toBe("01234567-89ab-7000-8000-000000001000");
    expect(() => createUuidV7Batch(-1)).toThrow("batch count");
  });
});
