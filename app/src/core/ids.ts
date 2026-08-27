export type RandomBytesSource = (target: Uint8Array) => Uint8Array;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createUuidV7(
  timestampMs = Date.now(),
  randomBytes: RandomBytesSource = (target) =>
    globalThis.crypto.getRandomValues(target),
): string {
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > 0xffffffffffff
  ) {
    throw new Error("UUIDv7 timestamp must fit in 48 bits");
  }
  const bytes = randomBytes(new Uint8Array(16));
  if (bytes.length !== 16) {
    throw new Error("UUIDv7 random source must return 16 bytes");
  }

  let remaining = timestampMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

export function assertUuidV7(value: string, label = "id"): void {
  if (!UUID_V7_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase UUIDv7`);
  }
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
