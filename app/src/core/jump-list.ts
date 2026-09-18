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
export class JumpHistory<T> {
  private readonly backEntries: T[] = [];
  private readonly forwardEntries: T[] = [];

  constructor(
    private readonly clone: (entry: T) => T,
    private readonly equal: (left: T | undefined, right: T) => boolean,
    private readonly validate: (entry: T) => void,
    private readonly maximumEntries = 100,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("Jump List maximum must be a positive safe integer");
    }
  }

  recordOrigin(origin: T): void {
    this.validate(origin);
    if (!this.equal(this.backEntries.at(-1), origin)) {
      this.backEntries.push(this.clone(origin));
      this.trim(this.backEntries);
    }
    this.forwardEntries.length = 0;
  }

  back(current: T, canVisit: (entry: T) => boolean = () => true): T | null {
    return this.move(current, this.backEntries, this.forwardEntries, canVisit);
  }

  forward(current: T, canVisit: (entry: T) => boolean = () => true): T | null {
    return this.move(current, this.forwardEntries, this.backEntries, canVisit);
  }

  snapshot(): { back: readonly T[]; forward: readonly T[] } {
    return {
      back: this.backEntries.map(this.clone),
      forward: this.forwardEntries.map(this.clone),
    };
  }

  clear(): void {
    this.backEntries.length = 0;
    this.forwardEntries.length = 0;
  }

  restore(snapshot: { back: readonly T[]; forward: readonly T[] }): void {
    for (const entry of [...snapshot.back, ...snapshot.forward]) {
      this.validate(entry);
    }
    this.backEntries.splice(
      0,
      this.backEntries.length,
      ...snapshot.back.map(this.clone),
    );
    this.forwardEntries.splice(
      0,
      this.forwardEntries.length,
      ...snapshot.forward.map(this.clone),
    );
    this.trim(this.backEntries);
    this.trim(this.forwardEntries);
  }

  private move(
    current: T,
    source: T[],
    destination: T[],
    canVisit: (entry: T) => boolean,
  ): T | null {
    this.validate(current);
    let target = source.pop();
    while (target && !canVisit(target)) target = source.pop();
    if (!target) return null;
    if (!this.equal(destination.at(-1), current)) {
      destination.push(this.clone(current));
      this.trim(destination);
    }
    return this.clone(target);
  }

  private trim(entries: T[]): void {
    if (entries.length > this.maximumEntries) {
      entries.splice(0, entries.length - this.maximumEntries);
    }
  }
}

/** Browser-history-style, Window-local Jump List. */
export class WindowJumpList extends JumpHistory<StableEditorPosition> {
  constructor(
    readonly windowId: string,
    maximumEntries = 100,
  ) {
    super(cloneEntry, sameLocation, validateEntry, maximumEntries);
    if (!windowId) throw new Error("Jump List requires a windowId");
  }
}

export function createSidebarJumpList(): JumpHistory<string> {
  return new JumpHistory<string>(
    (entry) => entry,
    (left, right) => left === right,
    (entry) => {
      if (!entry) throw new Error("Sidebar Jump List requires an item ID");
    },
  );
}
