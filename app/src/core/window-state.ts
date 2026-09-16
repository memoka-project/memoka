import { assertUuidV7 } from "./ids";
import type { VimMode } from "../vim/input";

export type { VimMode } from "../vim/input";

export interface WindowSelection {
  anchor: number;
  head: number;
}

export interface WindowLocalViewState {
  mode: VimMode;
  selection: WindowSelection | null;
  scrollTop: number;
  /** null means the NoteDoc Root Section. */
  focusedSectionId: string | null;
  /** Closed Sections in this Window only; IDs outside the mounted Focus are retained. */
  collapsedSectionIds: string[];
  /** Closed long Code Blocks in this Window only. */
  collapsedCodeBlockIds: string[];
  /** Interactive Details overrides; absent IDs use the authored open state. */
  detailsFoldOverrides: Record<string, boolean>;
}

export interface WindowViewState extends WindowLocalViewState {
  windowId: string;
  noteId: string;
}

export function createWindowLocalViewState(
  mode: VimMode = "insert",
): WindowLocalViewState {
  return {
    mode,
    selection: null,
    scrollTop: 0,
    focusedSectionId: null,
    collapsedSectionIds: [],
    collapsedCodeBlockIds: [],
    detailsFoldOverrides: {},
  };
}

export function createWindowViewState(
  windowId: string,
  noteId: string,
): WindowViewState {
  const state: WindowViewState = {
    windowId,
    noteId,
    ...createWindowLocalViewState(),
  };
  validateWindowViewState(state);
  return state;
}

export function validateWindowViewState(
  value: unknown,
): asserts value is WindowViewState {
  if (!value || typeof value !== "object") {
    throw new Error("Window-local state must be an object");
  }
  const state = value as Partial<WindowViewState>;
  if (typeof state.windowId !== "string" || state.windowId.length === 0) {
    throw new Error("Window-local state requires windowId");
  }
  if (typeof state.noteId !== "string") {
    throw new Error("Window-local state requires noteId");
  }
  assertUuidV7(state.noteId, "window noteId");
  validateWindowLocalViewState(state);
}

export function validateWindowLocalViewState(
  value: unknown,
): asserts value is WindowLocalViewState {
  if (!value || typeof value !== "object") {
    throw new Error("Window-local view must be an object");
  }
  const state = value as Partial<WindowLocalViewState>;
  if (
    !state.mode ||
    ![
      "normal",
      "insert",
      "replace",
      "visual-char",
      "visual-line",
      "visual-block",
    ].includes(state.mode)
  ) {
    throw new Error("Window-local state has an invalid mode");
  }
  if (
    typeof state.scrollTop !== "number" ||
    !Number.isFinite(state.scrollTop) ||
    state.scrollTop < 0
  ) {
    throw new Error("Window-local scrollTop must be non-negative");
  }
  if (state.selection !== null) {
    if (
      !state.selection ||
      !Number.isInteger(state.selection.anchor) ||
      !Number.isInteger(state.selection.head) ||
      state.selection.anchor < 0 ||
      state.selection.head < 0
    ) {
      throw new Error("Window-local selection must contain valid positions");
    }
  }
  if (state.focusedSectionId !== null) {
    if (typeof state.focusedSectionId !== "string") {
      throw new Error("Window-local view requires focusedSectionId");
    }
    assertUuidV7(state.focusedSectionId, "focused Section ID");
  }
  if (!Array.isArray(state.collapsedSectionIds)) {
    throw new Error("Window-local view requires collapsedSectionIds");
  }
  const collapsedSectionIds = new Set<string>();
  for (const sectionId of state.collapsedSectionIds) {
    if (typeof sectionId !== "string") {
      throw new Error("Window-local collapsed Section IDs must be strings");
    }
    assertUuidV7(sectionId, "collapsed Section ID");
    if (collapsedSectionIds.has(sectionId)) {
      throw new Error(`Duplicate collapsed Section ID: ${sectionId}`);
    }
    collapsedSectionIds.add(sectionId);
  }
  if (!Array.isArray(state.collapsedCodeBlockIds)) {
    throw new Error("Window-local view requires collapsedCodeBlockIds");
  }
  const collapsedCodeBlockIds = new Set<string>();
  for (const blockId of state.collapsedCodeBlockIds) {
    if (typeof blockId !== "string") {
      throw new Error("Window-local collapsed Code Block IDs must be strings");
    }
    assertUuidV7(blockId, "collapsed Code Block ID");
    if (collapsedCodeBlockIds.has(blockId)) {
      throw new Error(`Duplicate collapsed Code Block ID: ${blockId}`);
    }
    collapsedCodeBlockIds.add(blockId);
  }
  if (
    !state.detailsFoldOverrides ||
    typeof state.detailsFoldOverrides !== "object" ||
    Array.isArray(state.detailsFoldOverrides)
  ) {
    throw new Error("Window-local view requires detailsFoldOverrides");
  }
  for (const [blockId, open] of Object.entries(state.detailsFoldOverrides)) {
    assertUuidV7(blockId, "Details fold override ID");
    if (typeof open !== "boolean") {
      throw new Error(`Details fold override must be boolean: ${blockId}`);
    }
  }
}
