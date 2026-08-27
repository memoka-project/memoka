import { assertUuidV7 } from "./ids";
import type { StableEditorPosition } from "./stable-position";

export type JumpEntryAvailability = (entry: StableEditorPosition) => boolean;

export interface WindowJumpListSnapshot {
  back: readonly StableEditorPosition[];
  forward: readonly StableEditorPosition[];
}

function cloneEntry(entry: StableEditorPosition): StableEditorPosition {
  return { ...entry, relative: entry.relative.slice() };
}

function validateEntry(entry: StableEditorPosition): void {
  assertUuidV7(entry.noteId, "jump noteId");
  if (entry.sectionId !== undefined) {
    assertUuidV7(entry.sectionId, "jump focused Section ID");
  }
  if (!Number.isSafeInteger(entry.offset) || entry.offset < 0) {
    throw new Error("Jump offset must be a non-negative safe integer");
  }
  if (!(entry.relative instanceof Uint8Array) || entry.relative.length === 0) {
    throw new Error("Jump relative position must not be empty");
  }
}

function sameLocation(
  left: StableEditorPosition | undefined,
  right: StableEditorPosition,
): boolean {
  return (
    left?.noteId === right.noteId &&
    left.sectionId === right.sectionId &&
    left.blockId === right.blockId &&
    left.offset === right.offset
  );
}

/** Browser-history-style, Window-local Jump List. */
export class WindowJumpList {
  private readonly backEntries: StableEditorPosition[] = [];
  private readonly forwardEntries: StableEditorPosition[] = [];

  constructor(
    readonly windowId: string,
    private readonly maximumEntries = 100,
  ) {
    if (!windowId) throw new Error("Jump List requires a windowId");
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("Jump List maximum must be a positive safe integer");
    }
  }

  recordOrigin(origin: StableEditorPosition): void {
    validateEntry(origin);
    if (!sameLocation(this.backEntries.at(-1), origin)) {
      this.backEntries.push(cloneEntry(origin));
      this.trim(this.backEntries);
    }
    this.forwardEntries.length = 0;
  }

  back(
    current: StableEditorPosition,
    canVisit: JumpEntryAvailability = () => true,
  ): StableEditorPosition | null {
    return this.move(current, this.backEntries, this.forwardEntries, canVisit);
  }

  forward(
    current: StableEditorPosition,
    canVisit: JumpEntryAvailability = () => true,
  ): StableEditorPosition | null {
    return this.move(current, this.forwardEntries, this.backEntries, canVisit);
  }

  snapshot(): WindowJumpListSnapshot {
    return {
      back: this.backEntries.map(cloneEntry),
      forward: this.forwardEntries.map(cloneEntry),
    };
  }

  clear(): void {
    this.backEntries.length = 0;
    this.forwardEntries.length = 0;
  }

  restore(snapshot: WindowJumpListSnapshot): void {
    for (const entry of [...snapshot.back, ...snapshot.forward]) {
      validateEntry(entry);
    }
    this.backEntries.splice(
      0,
      this.backEntries.length,
      ...snapshot.back.map(cloneEntry),
    );
    this.forwardEntries.splice(
      0,
      this.forwardEntries.length,
      ...snapshot.forward.map(cloneEntry),
    );
    this.trim(this.backEntries);
    this.trim(this.forwardEntries);
  }

  private move(
    current: StableEditorPosition,
    source: StableEditorPosition[],
    destination: StableEditorPosition[],
    canVisit: JumpEntryAvailability,
  ): StableEditorPosition | null {
    validateEntry(current);
    let target = source.pop();
    while (target && !canVisit(target)) target = source.pop();
    if (!target) return null;
    if (!sameLocation(destination.at(-1), current)) {
      destination.push(cloneEntry(current));
      this.trim(destination);
    }
    return cloneEntry(target);
  }

  private trim(entries: StableEditorPosition[]): void {
    if (entries.length > this.maximumEntries) {
      entries.splice(0, entries.length - this.maximumEntries);
    }
  }
}
