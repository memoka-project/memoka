import {
  generateKeyBetween,
  generateNKeysBetween,
} from "jittered-fractional-indexing";

export const SIBLING_POSITION_JITTER_BITS = 64;

const UINT64_MASK = (1n << 64n) - 1n;
const FNV1A_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_PRIME = 0x100000001b3n;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const SPLITMIX_MULTIPLIER_1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MULTIPLIER_2 = 0x94d049bb133111ebn;

export function compareSiblingPositions(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function isCanonicalSiblingPosition(position: string): boolean {
  if (position.length === 0) return false;
  try {
    generateKeyBetween(position, null, { jitterBits: 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Separates seed fields structurally so concatenation cannot make two
 * operation/note/workspace tuples produce the same byte sequence.
 */
export function siblingPositionSeed(
  workspaceId: string,
  operationId: string,
  noteId: string,
): string {
  return JSON.stringify([workspaceId, operationId, noteId]);
}

/**
 * Produces a canonical Rocicorp fractional-index key after `lower` and, when
 * supplied, before `upper`. Jitter is deterministic for an operation so a
 * persistence retry produces byte-for-byte identical CRDT state.
 */
export function siblingPositionAfter(
  lower: string | null,
  upper: string | null,
  seed: string,
): string {
  if (lower === null && upper !== null) {
    throw new Error(
      "A position after no lower bound cannot have an upper bound",
    );
  }
  return siblingPositionBetween(lower, upper, seed);
}

/**
 * Produces a canonical key strictly between optional bounds with 64 bits of
 * deterministic jitter. Exact duplicate positions are deliberately handled by
 * the flat-note collision planner rather than silently inventing an order here.
 */
export function siblingPositionBetween(
  lower: string | null,
  upper: string | null,
  seed: string,
): string {
  validateBounds(lower, upper);
  return generateKeyBetween(lower, upper, jitterOptions(seed));
}

/**
 * Generates an ordered batch for local collision repair. The caller is
 * responsible for limiting the batch to the explicitly manipulated collision
 * bucket; this function never performs a workspace-wide reindex.
 */
export function siblingPositionsBetween(
  lower: string | null,
  upper: string | null,
  count: number,
  seed: string,
): string[] {
  validateBounds(lower, upper);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      "Sibling position count must be a non-negative safe integer",
    );
  }
  return generateNKeysBetween(lower, upper, count, jitterOptions(seed));
}

function validateBounds(lower: string | null, upper: string | null): void {
  if (lower !== null && lower.length === 0) {
    throw new Error("Sibling position lower bound must not be empty");
  }
  if (upper !== null && upper.length === 0) {
    throw new Error("Sibling position upper bound must not be empty");
  }
  if (
    lower !== null &&
    upper !== null &&
    compareSiblingPositions(lower, upper) >= 0
  ) {
    throw new Error("Sibling position bounds must be strictly ordered");
  }
}

function jitterOptions(seed: string): {
  jitterBits: number;
  getRandomBit: () => boolean;
} {
  if (seed.length === 0) {
    throw new Error("Sibling position jitter seed must not be empty");
  }
  return {
    jitterBits: SIBLING_POSITION_JITTER_BITS,
    getRandomBit: createDeterministicRandomBit(seed),
  };
}

/**
 * FNV-1a supplies a stable 64-bit seed and SplitMix64 expands it into an
 * unbiased deterministic bit stream. This is collision jitter, not a security
 * primitive; no platform RNG is consulted.
 */
function createDeterministicRandomBit(seed: string): () => boolean {
  let state = hashSeed(seed);
  let buffer = 0n;
  let remainingBits = 0;
  return () => {
    if (remainingBits === 0) {
      state = (state + SPLITMIX_INCREMENT) & UINT64_MASK;
      let mixed = state;
      mixed = ((mixed ^ (mixed >> 30n)) * SPLITMIX_MULTIPLIER_1) & UINT64_MASK;
      mixed = ((mixed ^ (mixed >> 27n)) * SPLITMIX_MULTIPLIER_2) & UINT64_MASK;
      buffer = (mixed ^ (mixed >> 31n)) & UINT64_MASK;
      remainingBits = 64;
    }
    const bit = (buffer & 1n) === 1n;
    buffer >>= 1n;
    remainingBits -= 1;
    return bit;
  };
}

function hashSeed(seed: string): bigint {
  let hash = FNV1A_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV1A_PRIME) & UINT64_MASK;
  }
  return hash;
}
