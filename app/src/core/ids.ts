export type RandomBytesSource = (target: Uint8Array) => Uint8Array;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_BYTES = 16;
const UUIDS_PER_RANDOM_BATCH = 4_096;
const BYTE_HEX = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, "0"),
);

function validateUuidV7Timestamp(timestampMs: number): void {
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > 0xffffffffffff
  ) {
    throw new Error("UUIDv7 timestamp must fit in 48 bits");
  }
}

function encodeUuidV7(bytes: Uint8Array, offset: number, timestampMs: number) {
  let remaining = timestampMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[offset + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[offset + 6] = (bytes[offset + 6]! & 0x0f) | 0x70;
  bytes[offset + 8] = (bytes[offset + 8]! & 0x3f) | 0x80;
  const hex = (index: number): string => BYTE_HEX[bytes[offset + index]!]!;
  return (
    hex(0) +
    hex(1) +
    hex(2) +
    hex(3) +
    "-" +
    hex(4) +
    hex(5) +
    "-" +
    hex(6) +
    hex(7) +
    "-" +
    hex(8) +
    hex(9) +
    "-" +
    hex(10) +
    hex(11) +
    hex(12) +
    hex(13) +
    hex(14) +
    hex(15)
  );
}

const cryptoRandomBytes: RandomBytesSource = (target) =>
  globalThis.crypto.getRandomValues(target);

export function createUuidV7(
  timestampMs = Date.now(),
  randomBytes: RandomBytesSource = cryptoRandomBytes,
): string {
  validateUuidV7Timestamp(timestampMs);
  const bytes = randomBytes(new Uint8Array(UUID_BYTES));
  if (bytes.length !== UUID_BYTES) {
    throw new Error("UUIDv7 random source must return 16 bytes");
  }
  return encodeUuidV7(bytes, 0, timestampMs);
}

/**
 * Generate many independent UUIDv7 values without one WebCrypto boundary per
 * ID. getRandomValues accepts at most 65,536 bytes, hence the 4,096-ID batches.
 */
export function createUuidV7Batch(
  count: number,
  timestampMs = Date.now(),
  randomBytes: RandomBytesSource = cryptoRandomBytes,
): string[] {
  validateUuidV7Timestamp(timestampMs);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("UUIDv7 batch count must be a non-negative safe integer");
  }
  const ids = new Array<string>(count);
  for (let start = 0; start < count; start += UUIDS_PER_RANDOM_BATCH) {
    const batchCount = Math.min(UUIDS_PER_RANDOM_BATCH, count - start);
    const bytes = randomBytes(new Uint8Array(batchCount * UUID_BYTES));
    if (bytes.length !== batchCount * UUID_BYTES) {
      throw new Error(
        `UUIDv7 random source must return ${batchCount * UUID_BYTES} bytes`,
      );
    }
    for (let index = 0; index < batchCount; index += 1) {
      ids[start + index] = encodeUuidV7(bytes, index * UUID_BYTES, timestampMs);
    }
  }
  return ids;
}

export function assertUuidV7(value: string, label = "id"): void {
  if (!UUID_V7_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase UUIDv7`);
  }
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
