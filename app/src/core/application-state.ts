import { assertUuidV7 } from "./ids";
import {
  createWindowLocalViewState,
  validateWindowLocalViewState,
  type WindowLocalViewState,
  type WindowViewState as LegacyWindowViewState,
} from "./window-state";

export const APPLICATION_WINDOW_STATE_SCHEMA_VERSION = 6;

export type UtilityBufferKind = "tree" | "search" | "trash" | "outline";

export type LeftSidebarUtility = "tree" | "search";
export type SidebarSide = "left" | "right";

export interface TreeSidebarViewState {
  selectedNoteId: string | null;
  collapsedNoteIds: string[];
}

export interface OutlineSidebarViewState {
  noteId: string | null;
  selectedSectionId: string | null;
}

export interface LeftSidebarState {
  visible: boolean;
  widthPx: number;
  utility: LeftSidebarUtility;
  tree: TreeSidebarViewState;
}

export interface RightSidebarState {
  visible: boolean;
  widthPx: number;
  utility: "outline";
  outline: OutlineSidebarViewState;
}

export type SidebarUpdateInput =
  | {
      side: "left";
      visible?: boolean;
      widthPx?: number;
      utility?: LeftSidebarUtility;
      tree?: Partial<TreeSidebarViewState>;
      focus?: boolean;
    }
  | {
      side: "right";
      visible?: boolean;
      widthPx?: number;
      utility?: "outline";
      outline?: Partial<OutlineSidebarViewState>;
      focus?: boolean;
    };

export type BufferState =
  | {
      id: string;
      kind: "note";
      noteId: string;
    }
  | {
      id: string;
      kind: "utility";
      utility: UtilityBufferKind;
    };

export interface EditorWindowState {
  id: string;
  bufferId: string | null;
  view: WindowLocalViewState;
}

export type SplitDirection = "horizontal" | "vertical";

export type WindowFocusDirection = "left" | "right" | "up" | "down";

export type SplitNode =
  | { type: "leaf"; windowId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

export interface TabPageState {
  id: string;
  root: SplitNode;
  activeWindowId: string;
  leftSidebar: LeftSidebarState;
  rightSidebar: RightSidebarState;
}

export type ApplicationFocusOwner =
  | { area: "window"; windowId: string }
  | { area: "left-sidebar" }
  | { area: "right-sidebar" };

export interface ApplicationWindowState {
  schemaVersion: typeof APPLICATION_WINDOW_STATE_SCHEMA_VERSION;
  applicationWindowId: string;
  tabs: TabPageState[];
  activeTabId: string;
  windows: Record<string, EditorWindowState>;
  buffers: Record<string, BufferState>;
  focusOwner: ApplicationFocusOwner;
}

export interface CreateApplicationWindowStateInput {
  applicationWindowId: string;
  tabId: string;
  windowId: string;
  buffer?: BufferState | null;
  mode?: WindowLocalViewState["mode"];
}

export interface SplitWindowInput {
  targetWindowId: string;
  newWindowId: string;
  splitId: string;
  direction: SplitDirection;
  bufferId?: string | null;
  placement?: "before" | "after";
}

export interface OpenBufferInWindowOptions {
  mode?: WindowLocalViewState["mode"];
  activate?: boolean;
}

export function noteBufferId(noteId: string): string {
  assertUuidV7(noteId, "note buffer noteId");
  return `note:${noteId}`;
}

export function utilityBufferId(utility: UtilityBufferKind): string {
  return `utility:${utility}`;
}

export function createNoteBuffer(noteId: string): BufferState {
  return { id: noteBufferId(noteId), kind: "note", noteId };
}

function bufferNoteId(buffer: BufferState | null): string | null {
  if (!buffer) return null;
  if (buffer.kind === "note") return buffer.noteId;
  return null;
}

function createLeftSidebarState(
  selectedNoteId: string | null = null,
): LeftSidebarState {
  return {
    visible: true,
    widthPx: 248,
    utility: "tree",
    tree: { selectedNoteId, collapsedNoteIds: [] },
  };
}

function createRightSidebarState(): RightSidebarState {
  return {
    visible: false,
    widthPx: 248,
    utility: "outline",
    outline: { noteId: null, selectedSectionId: null },
  };
}

export function createApplicationWindowState(
  input: CreateApplicationWindowStateInput,
): ApplicationWindowState {
  assertNonEmptyId(input.applicationWindowId, "applicationWindowId");
  assertNonEmptyId(input.tabId, "tabId");
  assertNonEmptyId(input.windowId, "windowId");
  const buffer = input.buffer ?? null;
  if (buffer) validateBufferState(buffer);
  const state: ApplicationWindowState = {
    schemaVersion: APPLICATION_WINDOW_STATE_SCHEMA_VERSION,
    applicationWindowId: input.applicationWindowId,
    tabs: [
      {
        id: input.tabId,
        root: { type: "leaf", windowId: input.windowId },
        activeWindowId: input.windowId,
        leftSidebar: createLeftSidebarState(bufferNoteId(buffer)),
        rightSidebar: createRightSidebarState(),
      },
    ],
    activeTabId: input.tabId,
    windows: {
      [input.windowId]: {
        id: input.windowId,
        bufferId: buffer?.id ?? null,
        view: createWindowLocalViewState(input.mode),
      },
    },
    buffers: buffer ? { [buffer.id]: structuredClone(buffer) } : {},
    focusOwner: { area: "window", windowId: input.windowId },
  };
  validateApplicationWindowState(state);
  return state;
}

export function activeTab(state: ApplicationWindowState): TabPageState {
  validateApplicationWindowState(state);
  return requireActiveTab(state);
}

export function activeEditorWindow(
  state: ApplicationWindowState,
): EditorWindowState {
  const tab = activeTab(state);
  return state.windows[tab.activeWindowId];
}

export function listTabWindowIds(
  state: ApplicationWindowState,
  tabId = state.activeTabId,
): string[] {
  validateApplicationWindowState(state);
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error(`Unknown tab page: ${tabId}`);
  return collectWindowIds(tab.root);
}

export function openBufferInCurrentWindow(
  state: ApplicationWindowState,
  buffer: BufferState,
): ApplicationWindowState {
  const tab = activeTab(state);
  return openBufferInWindow(state, tab.activeWindowId, buffer);
}

export function openBufferInWindow(
  state: ApplicationWindowState,
  windowId: string,
  buffer: BufferState,
  options: OpenBufferInWindowOptions = {},
): ApplicationWindowState {
  validateBufferState(buffer);
  const next = cloneValidState(state);
  const tab = tabContainingWindow(next, windowId);
  if (!tab) throw new Error(`Unknown window: ${windowId}`);
  next.buffers[buffer.id] = structuredClone(buffer);
  const window = next.windows[windowId];
  window.bufferId = buffer.id;
  window.view = createWindowLocalViewState(options.mode ?? "normal");
  if (options.activate !== false) {
    next.activeTabId = tab.id;
    tab.activeWindowId = windowId;
    next.focusOwner = { area: "window", windowId };
  }
  validateApplicationWindowState(next);
  return next;
}

export function splitWindow(
  state: ApplicationWindowState,
  input: SplitWindowInput,
): ApplicationWindowState {
  assertNonEmptyId(input.newWindowId, "newWindowId");
  assertNonEmptyId(input.splitId, "splitId");
  if (input.direction !== "horizontal" && input.direction !== "vertical") {
    throw new Error(`Unknown split direction: ${String(input.direction)}`);
  }
  if (
    input.placement !== undefined &&
    input.placement !== "before" &&
    input.placement !== "after"
  ) {
    throw new Error(`Unknown split placement: ${String(input.placement)}`);
  }
  const next = cloneValidState(state);
  if (next.windows[input.newWindowId]) {
    throw new Error(`Window already exists: ${input.newWindowId}`);
  }
  if (findSplit(next, input.splitId)) {
    throw new Error(`Split already exists: ${input.splitId}`);
  }
  const tab = tabContainingWindow(next, input.targetWindowId);
  if (!tab) throw new Error(`Unknown window: ${input.targetWindowId}`);
  const target = next.windows[input.targetWindowId];
  const bufferId =
    input.bufferId === undefined ? target.bufferId : input.bufferId;
  if (bufferId !== null && !next.buffers[bufferId]) {
    throw new Error(`Unknown buffer: ${bufferId}`);
  }
  const newLeaf: SplitNode = { type: "leaf", windowId: input.newWindowId };
  const targetLeaf: SplitNode = {
    type: "leaf",
    windowId: input.targetWindowId,
  };
  const replacement: SplitNode = {
    type: "split",
    id: input.splitId,
    direction: input.direction,
    ratio: 0.5,
    first: input.placement === "before" ? newLeaf : targetLeaf,
    second: input.placement === "before" ? targetLeaf : newLeaf,
  };
  tab.root = rebalanceSplitComponentContainingSplit(
    replaceWindowLeaf(tab.root, input.targetWindowId, replacement),
    input.splitId,
    input.direction,
  );
  tab.activeWindowId = input.newWindowId;
  next.windows[input.newWindowId] = {
    id: input.newWindowId,
    bufferId,
    view: createWindowLocalViewState("normal"),
  };
  next.activeTabId = tab.id;
  next.focusOwner = { area: "window", windowId: input.newWindowId };
  validateApplicationWindowState(next);
  return next;
}

export function focusWindow(
  state: ApplicationWindowState,
  windowId: string,
): ApplicationWindowState {
  const next = cloneValidState(state);
  const tab = tabContainingWindow(next, windowId);
  if (!tab) throw new Error(`Unknown window: ${windowId}`);
  next.activeTabId = tab.id;
  tab.activeWindowId = windowId;
  next.focusOwner = { area: "window", windowId };
  validateApplicationWindowState(next);
  return next;
}

export function windowInDirection(
  state: ApplicationWindowState,
  windowId: string,
  direction: WindowFocusDirection,
): string | null {
  validateApplicationWindowState(state);
  if (!isWindowFocusDirection(direction)) {
    throw new Error(`Unknown Window focus direction: ${String(direction)}`);
  }
  const tab = tabContainingWindow(state, windowId);
  if (!tab) throw new Error(`Unknown window: ${windowId}`);
  const rectangles = new Map<string, WindowRectangle>();
  collectWindowRectangles(
    tab.root,
    { left: 0, top: 0, right: 1, bottom: 1 },
    rectangles,
  );
  const source = rectangles.get(windowId);
  if (!source) throw new Error(`Unknown window: ${windowId}`);
  const candidates = [...rectangles.entries()]
    .filter(([candidateWindowId]) => candidateWindowId !== windowId)
    .map(([candidateWindowId, rectangle]) => ({
      windowId: candidateWindowId,
      score: directionalScore(source, rectangle, direction),
    }))
    .filter(
      (candidate): candidate is { windowId: string; score: DirectionalScore } =>
        candidate.score !== null,
    )
    .sort(compareDirectionalCandidates);
  return candidates[0]?.windowId ?? null;
}

export function focusWindowInDirection(
  state: ApplicationWindowState,
  windowId: string,
  direction: WindowFocusDirection,
): ApplicationWindowState {
  const targetWindowId = windowInDirection(state, windowId, direction);
  return targetWindowId ? focusWindow(state, targetWindowId) : state;
}

export function closeWindow(
  state: ApplicationWindowState,
  windowId: string,
): ApplicationWindowState {
  const next = cloneValidState(state);
  const tab = tabContainingWindow(next, windowId);
  if (!tab) throw new Error(`Unknown window: ${windowId}`);
  if (tab.root.type === "leaf") {
    const window = next.windows[windowId];
    window.bufferId = null;
    window.view = createWindowLocalViewState("normal");
    if (next.activeTabId === tab.id) {
      next.focusOwner = { area: "window", windowId };
    }
    validateApplicationWindowState(next);
    return next;
  }
  const closed = removeWindowLeaf(tab.root, windowId);
  if (!closed.removed) throw new Error(`Unknown window: ${windowId}`);
  tab.root = closed.node;
  delete next.windows[windowId];
  const remainingWindowIds = collectWindowIds(tab.root);
  if (tab.activeWindowId === windowId) {
    tab.activeWindowId = closed.preferredWindowId ?? remainingWindowIds[0];
  }
  if (
    next.focusOwner.area === "window" &&
    next.focusOwner.windowId === windowId
  ) {
    next.focusOwner = { area: "window", windowId: tab.activeWindowId };
  }
  validateApplicationWindowState(next);
  return next;
}

export function keepOnlyWindow(
  state: ApplicationWindowState,
  windowId: string,
): ApplicationWindowState {
  validateApplicationWindowState(state);
  const currentTab = tabContainingWindow(state, windowId);
  if (!currentTab) throw new Error(`Unknown window: ${windowId}`);
  const currentWindowIds = collectWindowIds(currentTab.root);
  if (
    currentWindowIds.length === 1 &&
    !currentTab.leftSidebar.visible &&
    !currentTab.rightSidebar.visible &&
    state.activeTabId === currentTab.id &&
    currentTab.activeWindowId === windowId &&
    state.focusOwner.area === "window" &&
    state.focusOwner.windowId === windowId
  ) {
    return state;
  }

  const next = cloneValidState(state);
  const tab = tabContainingWindow(next, windowId);
  if (!tab) throw new Error(`Unknown window: ${windowId}`);
  for (const closedWindowId of collectWindowIds(tab.root)) {
    if (closedWindowId !== windowId) delete next.windows[closedWindowId];
  }
  tab.root = { type: "leaf", windowId };
  tab.activeWindowId = windowId;
  tab.leftSidebar.visible = false;
  tab.rightSidebar.visible = false;
  next.activeTabId = tab.id;
  next.focusOwner = { area: "window", windowId };
  validateApplicationWindowState(next);
  return next;
}

export function createTabPage(
  state: ApplicationWindowState,
  input: {
    tabId: string;
    windowId: string;
    bufferId?: string | null;
  },
): ApplicationWindowState {
  assertNonEmptyId(input.tabId, "tabId");
  assertNonEmptyId(input.windowId, "windowId");
  const next = cloneValidState(state);
  const sourceTab = requireActiveTab(next);
  if (next.tabs.some(({ id }) => id === input.tabId)) {
    throw new Error(`Tab page already exists: ${input.tabId}`);
  }
  if (next.windows[input.windowId]) {
    throw new Error(`Window already exists: ${input.windowId}`);
  }
  const bufferId = input.bufferId ?? null;
  if (bufferId !== null && !next.buffers[bufferId]) {
    throw new Error(`Unknown buffer: ${input.bufferId}`);
  }
  next.windows[input.windowId] = {
    id: input.windowId,
    bufferId,
    view: createWindowLocalViewState("normal"),
  };
  const leftSidebar = structuredClone(sourceTab.leftSidebar);
  const rightSidebar = structuredClone(sourceTab.rightSidebar);
  leftSidebar.visible = false;
  rightSidebar.visible = false;
  next.tabs.push({
    id: input.tabId,
    root: { type: "leaf", windowId: input.windowId },
    activeWindowId: input.windowId,
    leftSidebar,
    rightSidebar,
  });
  next.activeTabId = input.tabId;
  next.focusOwner = { area: "window", windowId: input.windowId };
  validateApplicationWindowState(next);
  return next;
}

export function switchTabPage(
  state: ApplicationWindowState,
  tabId: string,
): ApplicationWindowState {
  const next = cloneValidState(state);
  const tab = next.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error(`Unknown tab page: ${tabId}`);
  next.activeTabId = tabId;
  next.focusOwner = { area: "window", windowId: tab.activeWindowId };
  validateApplicationWindowState(next);
  return next;
}

export function adjacentTabPageId(
  state: ApplicationWindowState,
  direction: "next" | "previous",
  tabId = state.activeTabId,
): string {
  validateApplicationWindowState(state);
  if (direction !== "next" && direction !== "previous") {
    throw new Error(`Unknown TabPage direction: ${String(direction)}`);
  }
  const index = state.tabs.findIndex((candidate) => candidate.id === tabId);
  if (index < 0) throw new Error(`Unknown tab page: ${tabId}`);
  const offset = direction === "next" ? 1 : -1;
  return state.tabs[(index + offset + state.tabs.length) % state.tabs.length]
    .id;
}

export function closeTabPage(
  state: ApplicationWindowState,
  tabId: string,
): ApplicationWindowState {
  const next = cloneValidState(state);
  if (next.tabs.length === 1) {
    throw new Error("Cannot close the last tab page");
  }
  const index = next.tabs.findIndex((candidate) => candidate.id === tabId);
  if (index < 0) throw new Error(`Unknown tab page: ${tabId}`);
  const [removed] = next.tabs.splice(index, 1);
  for (const windowId of collectWindowIds(removed.root)) {
    delete next.windows[windowId];
  }
  if (next.activeTabId === tabId) {
    const active = next.tabs[Math.min(index, next.tabs.length - 1)];
    next.activeTabId = active.id;
    next.focusOwner = {
      area: "window",
      windowId: active.activeWindowId,
    };
  }
  validateApplicationWindowState(next);
  return next;
}

export function updateWindowView(
  state: ApplicationWindowState,
  windowId: string,
  update: Partial<WindowLocalViewState>,
): ApplicationWindowState {
  const next = cloneValidState(state);
  const window = next.windows[windowId];
  if (!window) throw new Error(`Unknown window: ${windowId}`);
  const updated = { ...window.view, ...structuredClone(update) };
  validateWindowLocalViewState(updated);
  window.view = updated;
  validateApplicationWindowState(next);
  return next;
}

export function updateSidebar(
  state: ApplicationWindowState,
  input: SidebarUpdateInput,
): ApplicationWindowState {
  const next = cloneValidState(state);
  const tab = requireActiveTab(next);
  const sidebar = input.side === "left" ? tab.leftSidebar : tab.rightSidebar;
  if (input.visible !== undefined) sidebar.visible = input.visible;
  if (input.widthPx !== undefined) sidebar.widthPx = input.widthPx;
  if (input.side === "left" && input.utility !== undefined) {
    tab.leftSidebar.utility = input.utility;
  }
  if (input.side === "right" && input.utility !== undefined) {
    tab.rightSidebar.utility = input.utility;
  }
  if (input.side === "left" && input.tree !== undefined) {
    tab.leftSidebar.tree = {
      ...tab.leftSidebar.tree,
      ...structuredClone(input.tree),
    };
  }
  if (input.side === "right" && input.outline !== undefined) {
    tab.rightSidebar.outline = {
      ...tab.rightSidebar.outline,
      ...structuredClone(input.outline),
    };
  }
  if (input.focus) {
    if (!sidebar.visible) {
      throw new Error(`Cannot focus a hidden ${input.side} sidebar`);
    }
    next.focusOwner = {
      area: input.side === "left" ? "left-sidebar" : "right-sidebar",
    };
  } else if (
    !sidebar.visible &&
    next.focusOwner.area === `${input.side}-sidebar`
  ) {
    next.focusOwner = { area: "window", windowId: tab.activeWindowId };
  }
  validateApplicationWindowState(next);
  return next;
}

export function removeNotesFromSidebarViews(
  state: ApplicationWindowState,
  removedNoteIds: ReadonlySet<string>,
  notesFallbackNoteId: string | null,
): ApplicationWindowState {
  if (removedNoteIds.size === 0) return state;
  const next = cloneValidState(state);
  let changed = false;
  for (const tab of next.tabs) {
    const tree = tab.leftSidebar.tree;
    if (tree.selectedNoteId && removedNoteIds.has(tree.selectedNoteId)) {
      tree.selectedNoteId = notesFallbackNoteId;
      changed = true;
    }
    const nextCollapsed = tree.collapsedNoteIds.filter(
      (noteId) => !removedNoteIds.has(noteId),
    );
    if (nextCollapsed.length !== tree.collapsedNoteIds.length) {
      tree.collapsedNoteIds = nextCollapsed;
      changed = true;
    }

    const outline = tab.rightSidebar.outline;
    if (outline.noteId && removedNoteIds.has(outline.noteId)) {
      const bufferId = next.windows[tab.activeWindowId]?.bufferId ?? null;
      outline.noteId = bufferId
        ? bufferNoteId(next.buffers[bufferId] ?? null)
        : null;
      outline.selectedSectionId = null;
      changed = true;
    }
  }
  if (!changed) return state;
  validateApplicationWindowState(next);
  return next;
}

export function closeBuffer(
  state: ApplicationWindowState,
  bufferId: string,
): ApplicationWindowState {
  const next = cloneValidState(state);
  if (!next.buffers[bufferId]) throw new Error(`Unknown buffer: ${bufferId}`);
  for (const window of Object.values(next.windows)) {
    if (window.bufferId !== bufferId) continue;
    window.bufferId = null;
    window.view = createWindowLocalViewState("normal");
  }
  delete next.buffers[bufferId];
  validateApplicationWindowState(next);
  return next;
}

export function serializeApplicationWindowState(
  state: ApplicationWindowState,
): string {
  validateApplicationWindowState(state);
  return JSON.stringify(state);
}

export function reloadApplicationWindowState(
  serialized: string,
): ApplicationWindowState {
  const migrated = migrateApplicationWindowState(JSON.parse(serialized));
  validateApplicationWindowState(migrated.state);
  return migrated.state;
}

export function migrateApplicationWindowState(value: unknown): {
  state: unknown;
  changed: boolean;
} {
  if (
    value &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 5
  ) {
    const state = structuredClone(value) as {
      schemaVersion: number;
      tabs?: Array<{
        leftSidebar?: {
          utility?: string;
          notes?: { selectedNoteId?: string | null };
          tree?: TreeSidebarViewState;
        };
      }>;
      buffers?: Record<
        string,
        { id?: string; kind?: string; utility?: string }
      >;
    };
    state.schemaVersion = APPLICATION_WINDOW_STATE_SCHEMA_VERSION;
    for (const tab of state.tabs ?? []) {
      const sidebar = tab.leftSidebar;
      if (!sidebar) continue;
      if (sidebar.utility === "notes") sidebar.utility = "tree";
      sidebar.tree = {
        selectedNoteId: sidebar.notes?.selectedNoteId ?? null,
        collapsedNoteIds: [],
      };
      delete sidebar.notes;
    }
    if (state.buffers) {
      const legacy = state.buffers["utility:notes"];
      if (legacy?.kind === "utility" && legacy.utility === "notes") {
        delete state.buffers["utility:notes"];
        legacy.id = "utility:tree";
        legacy.utility = "tree";
        state.buffers["utility:tree"] = legacy;
      }
    }
    return { state, changed: true };
  }
  return { state: value, changed: false };
}

export function migrateLegacyWindowStates(input: {
  applicationWindowId: string;
  tabId: string;
  windows: readonly LegacyWindowViewState[];
}): ApplicationWindowState {
  if (input.windows.length === 0) {
    throw new Error("Legacy Window migration requires at least one window");
  }
  const windows = [...input.windows].sort((left, right) =>
    left.windowId.localeCompare(right.windowId),
  );
  const first = windows[0];
  let state = createApplicationWindowState({
    applicationWindowId: input.applicationWindowId,
    tabId: input.tabId,
    windowId: first.windowId,
    buffer: createNoteBuffer(first.noteId),
    mode: first.mode,
  });
  state.windows[first.windowId].view = legacyView(first);
  for (const [index, legacy] of windows.slice(1).entries()) {
    const buffer = createNoteBuffer(legacy.noteId);
    state.buffers[buffer.id] = buffer;
    state = splitWindow(state, {
      targetWindowId: state.tabs[0].activeWindowId,
      newWindowId: legacy.windowId,
      splitId: `legacy-split-${index + 1}`,
      direction: "vertical",
      bufferId: buffer.id,
    });
    state.windows[legacy.windowId].view = legacyView(legacy);
  }
  const preferredActive = state.windows["window-1"]
    ? "window-1"
    : first.windowId;
  state.tabs[0].activeWindowId = preferredActive;
  state.focusOwner = { area: "window", windowId: preferredActive };
  validateApplicationWindowState(state);
  return state;
}

export function validateApplicationWindowState(
  value: unknown,
): asserts value is ApplicationWindowState {
  if (!value || typeof value !== "object") {
    throw new Error("Application Window state must be an object");
  }
  const state = value as Partial<ApplicationWindowState>;
  if (state.schemaVersion !== APPLICATION_WINDOW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Application Window state schema: ${String(state.schemaVersion)}`,
    );
  }
  assertNonEmptyId(state.applicationWindowId, "applicationWindowId");
  if (!Array.isArray(state.tabs) || state.tabs.length === 0) {
    throw new Error("Application Window state requires at least one tab page");
  }
  if (!state.windows || typeof state.windows !== "object") {
    throw new Error("Application Window state requires windows");
  }
  if (Array.isArray(state.windows)) {
    throw new Error("Application Window windows must be an object map");
  }
  if (!state.buffers || typeof state.buffers !== "object") {
    throw new Error("Application Window state requires buffers");
  }
  if (Array.isArray(state.buffers)) {
    throw new Error("Application Window buffers must be an object map");
  }
  const tabIds = new Set<string>();
  const layoutWindowIds = new Set<string>();
  const splitIds = new Set<string>();
  for (const tab of state.tabs) {
    assertNonEmptyId(tab?.id, "tab page id");
    if (tabIds.has(tab.id)) throw new Error(`Duplicate tab page: ${tab.id}`);
    tabIds.add(tab.id);
    const tabWindowIds = new Set<string>();
    validateSplitNode(tab.root, tabWindowIds, splitIds, new WeakSet());
    if (!tabWindowIds.has(tab.activeWindowId)) {
      throw new Error(
        `Active window ${tab.activeWindowId} is not in tab page ${tab.id}`,
      );
    }
    validateSidebarState(tab.leftSidebar, "left");
    validateTreeSidebarViewState(tab.leftSidebar?.tree);
    validateSidebarState(tab.rightSidebar, "right");
    validateOutlineSidebarViewState(tab.rightSidebar?.outline);
    for (const windowId of tabWindowIds) {
      if (layoutWindowIds.has(windowId)) {
        throw new Error(`Window appears in multiple tab pages: ${windowId}`);
      }
      layoutWindowIds.add(windowId);
    }
  }
  if (!state.activeTabId || !tabIds.has(state.activeTabId)) {
    throw new Error(`Unknown active tab page: ${String(state.activeTabId)}`);
  }
  for (const [bufferId, buffer] of Object.entries(state.buffers)) {
    validateBufferState(buffer);
    if (buffer.id !== bufferId) {
      throw new Error(`Buffer key does not match its id: ${bufferId}`);
    }
  }
  for (const [windowId, window] of Object.entries(state.windows)) {
    if (!window || typeof window !== "object") {
      throw new Error(`Window state must be an object: ${windowId}`);
    }
    if (window.id !== windowId) {
      throw new Error(`Window key does not match its id: ${windowId}`);
    }
    if (!layoutWindowIds.has(windowId)) {
      throw new Error(`Window is not present in a tab layout: ${windowId}`);
    }
    if (window.bufferId !== null && typeof window.bufferId !== "string") {
      throw new Error(`Window ${windowId} has an invalid buffer reference`);
    }
    if (window.bufferId !== null && !state.buffers[window.bufferId]) {
      throw new Error(
        `Window ${windowId} references unknown buffer: ${window.bufferId}`,
      );
    }
    validateWindowLocalViewState(window.view);
  }
  if (Object.keys(state.windows).length !== layoutWindowIds.size) {
    const missing = [...layoutWindowIds].find(
      (windowId) => !state.windows?.[windowId],
    );
    throw new Error(
      `Layout references unknown window: ${missing ?? "unknown"}`,
    );
  }
  const active = requireActiveTab(state as ApplicationWindowState);
  const leftSidebar = active.leftSidebar;
  const rightSidebar = active.rightSidebar;
  const focus = state.focusOwner as
    { area?: unknown; windowId?: unknown } | undefined;
  if (!focus || typeof focus !== "object") {
    throw new Error("Application Window state requires a focus owner");
  }
  if (focus.area === "window") {
    assertNonEmptyId(focus.windowId, "focused windowId");
    if (!collectWindowIds(active.root).includes(focus.windowId)) {
      throw new Error(
        `Focused window is not in the active tab page: ${focus.windowId}`,
      );
    }
    if (focus.windowId !== active.activeWindowId) {
      throw new Error(
        `Focused window is not the active window: ${focus.windowId}`,
      );
    }
  } else if (focus.area !== "left-sidebar" && focus.area !== "right-sidebar") {
    throw new Error(`Unknown focus owner: ${String(focus.area)}`);
  } else if (
    (focus.area === "left-sidebar" && !leftSidebar.visible) ||
    (focus.area === "right-sidebar" && !rightSidebar.visible)
  ) {
    throw new Error(`Focused ${focus.area} must be visible`);
  }
}

function validateBufferState(value: unknown): asserts value is BufferState {
  if (!value || typeof value !== "object") {
    throw new Error("Buffer state must be an object");
  }
  const buffer = value as {
    id?: unknown;
    kind?: unknown;
    noteId?: unknown;
    utility?: unknown;
  };
  assertNonEmptyId(buffer.id, "buffer id");
  if (buffer.kind === "note") {
    assertNonEmptyId(buffer.noteId, "note buffer noteId");
    assertUuidV7(buffer.noteId, "note buffer noteId");
    if (buffer.id !== noteBufferId(buffer.noteId)) {
      throw new Error(`Note buffer has a non-canonical id: ${buffer.id}`);
    }
    return;
  }
  if (buffer.kind === "utility") {
    if (!isUtilityBufferKind(buffer.utility)) {
      throw new Error(`Unknown utility buffer: ${String(buffer.utility)}`);
    }
    if (buffer.id !== utilityBufferId(buffer.utility)) {
      throw new Error(`Utility buffer has a non-canonical id: ${buffer.id}`);
    }
    return;
  }
  throw new Error(`Unknown buffer kind: ${String(buffer.kind)}`);
}

function validateSplitNode(
  value: unknown,
  windowIds: Set<string>,
  splitIds: Set<string>,
  visited: WeakSet<object>,
): void {
  if (!value || typeof value !== "object") {
    throw new Error("Split layout node must be an object");
  }
  const node = value as {
    type?: unknown;
    windowId?: unknown;
    id?: unknown;
    direction?: unknown;
    ratio?: unknown;
    first?: unknown;
    second?: unknown;
  };
  if (visited.has(node))
    throw new Error("Split layout must not contain cycles");
  visited.add(node);
  if (node.type === "leaf") {
    assertNonEmptyId(node.windowId, "layout windowId");
    if (windowIds.has(node.windowId)) {
      throw new Error(`Duplicate window in tab layout: ${node.windowId}`);
    }
    windowIds.add(node.windowId);
    return;
  }
  if (node.type !== "split") {
    throw new Error(`Unknown split node type: ${String(node.type)}`);
  }
  assertNonEmptyId(node.id, "split id");
  if (splitIds.has(node.id)) throw new Error(`Duplicate split: ${node.id}`);
  splitIds.add(node.id);
  if (node.direction !== "horizontal" && node.direction !== "vertical") {
    throw new Error(`Unknown split direction: ${String(node.direction)}`);
  }
  if (
    typeof node.ratio !== "number" ||
    !Number.isFinite(node.ratio) ||
    node.ratio <= 0 ||
    node.ratio >= 1
  ) {
    throw new Error("Split ratio must be greater than 0 and less than 1");
  }
  validateSplitNode(node.first, windowIds, splitIds, visited);
  validateSplitNode(node.second, windowIds, splitIds, visited);
}

function validateSidebarState(
  sidebar: LeftSidebarState | RightSidebarState | undefined,
  side: "left" | "right",
): void {
  if (!sidebar || typeof sidebar !== "object") {
    throw new Error(`Application Window state requires ${side} sidebar state`);
  }
  if (typeof sidebar.visible !== "boolean") {
    throw new Error(`${side} sidebar visibility must be boolean`);
  }
  if (
    typeof sidebar.widthPx !== "number" ||
    !Number.isFinite(sidebar.widthPx) ||
    sidebar.widthPx <= 0
  ) {
    throw new Error(`${side} sidebar width must be positive`);
  }
  if (side === "left") {
    if (sidebar.utility !== "tree" && sidebar.utility !== "search") {
      throw new Error(`Unknown left sidebar utility: ${sidebar.utility}`);
    }
  } else if (sidebar.utility !== "outline") {
    throw new Error(`Unknown right sidebar utility: ${sidebar.utility}`);
  }
}

function validateTreeSidebarViewState(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Tree sidebar requires view state");
  }
  const tree = value as Partial<TreeSidebarViewState>;
  if (tree.selectedNoteId !== null) {
    assertNonEmptyId(tree.selectedNoteId, "Tree selected noteId");
  }
  if (!Array.isArray(tree.collapsedNoteIds)) {
    throw new Error("Tree collapsed note IDs must be an array");
  }
  const seen = new Set<string>();
  for (const noteId of tree.collapsedNoteIds) {
    assertNonEmptyId(noteId, "Tree collapsed noteId");
    if (seen.has(noteId)) {
      throw new Error(`Duplicate collapsed Tree note: ${noteId}`);
    }
    seen.add(noteId);
  }
}

function validateOutlineSidebarViewState(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Outline sidebar requires view state");
  }
  const outline = value as Partial<OutlineSidebarViewState>;
  if (outline.noteId !== null) {
    assertNonEmptyId(outline.noteId, "Outline noteId");
  }
  if (outline.selectedSectionId !== null) {
    assertNonEmptyId(outline.selectedSectionId, "Outline selected Section ID");
  }
}

function isUtilityBufferKind(value: unknown): value is UtilityBufferKind {
  return (
    value === "tree" ||
    value === "search" ||
    value === "trash" ||
    value === "outline"
  );
}

function cloneValidState(
  state: ApplicationWindowState,
): ApplicationWindowState {
  validateApplicationWindowState(state);
  return structuredClone(state);
}

function requireActiveTab(state: ApplicationWindowState): TabPageState {
  const tab = state.tabs.find(({ id }) => id === state.activeTabId);
  if (!tab) throw new Error(`Unknown active tab page: ${state.activeTabId}`);
  return tab;
}

function tabContainingWindow(
  state: ApplicationWindowState,
  windowId: string,
): TabPageState | null {
  return (
    state.tabs.find((tab) => collectWindowIds(tab.root).includes(windowId)) ??
    null
  );
}

function collectWindowIds(node: SplitNode): string[] {
  return node.type === "leaf"
    ? [node.windowId]
    : [...collectWindowIds(node.first), ...collectWindowIds(node.second)];
}

interface WindowRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface DirectionalScore {
  overlapRank: number;
  primaryGap: number;
  perpendicularDistance: number;
}

function isWindowFocusDirection(value: unknown): value is WindowFocusDirection {
  return (
    value === "left" || value === "right" || value === "up" || value === "down"
  );
}

function collectWindowRectangles(
  node: SplitNode,
  rectangle: WindowRectangle,
  result: Map<string, WindowRectangle>,
): void {
  if (node.type === "leaf") {
    result.set(node.windowId, rectangle);
    return;
  }
  if (node.direction === "vertical") {
    const boundary =
      rectangle.left + (rectangle.right - rectangle.left) * node.ratio;
    collectWindowRectangles(
      node.first,
      { ...rectangle, right: boundary },
      result,
    );
    collectWindowRectangles(
      node.second,
      { ...rectangle, left: boundary },
      result,
    );
    return;
  }
  const boundary =
    rectangle.top + (rectangle.bottom - rectangle.top) * node.ratio;
  collectWindowRectangles(
    node.first,
    { ...rectangle, bottom: boundary },
    result,
  );
  collectWindowRectangles(node.second, { ...rectangle, top: boundary }, result);
}

function directionalScore(
  source: WindowRectangle,
  candidate: WindowRectangle,
  direction: WindowFocusDirection,
): DirectionalScore | null {
  const epsilon = Number.EPSILON * 8;
  const horizontal = direction === "left" || direction === "right";
  const sourcePrimaryStart = horizontal ? source.left : source.top;
  const sourcePrimaryEnd = horizontal ? source.right : source.bottom;
  const candidatePrimaryStart = horizontal ? candidate.left : candidate.top;
  const candidatePrimaryEnd = horizontal ? candidate.right : candidate.bottom;
  const before = direction === "left" || direction === "up";
  const inDirection = before
    ? candidatePrimaryEnd <= sourcePrimaryStart + epsilon
    : candidatePrimaryStart >= sourcePrimaryEnd - epsilon;
  if (!inDirection) return null;
  const sourceCrossStart = horizontal ? source.top : source.left;
  const sourceCrossEnd = horizontal ? source.bottom : source.right;
  const candidateCrossStart = horizontal ? candidate.top : candidate.left;
  const candidateCrossEnd = horizontal ? candidate.bottom : candidate.right;
  const overlap =
    Math.min(sourceCrossEnd, candidateCrossEnd) -
    Math.max(sourceCrossStart, candidateCrossStart);
  return {
    overlapRank: overlap > epsilon ? 0 : 1,
    primaryGap: before
      ? sourcePrimaryStart - candidatePrimaryEnd
      : candidatePrimaryStart - sourcePrimaryEnd,
    perpendicularDistance: Math.abs(
      (sourceCrossStart + sourceCrossEnd) / 2 -
        (candidateCrossStart + candidateCrossEnd) / 2,
    ),
  };
}

function compareDirectionalCandidates(
  left: { windowId: string; score: DirectionalScore },
  right: { windowId: string; score: DirectionalScore },
): number {
  return (
    left.score.overlapRank - right.score.overlapRank ||
    left.score.primaryGap - right.score.primaryGap ||
    left.score.perpendicularDistance - right.score.perpendicularDistance ||
    left.windowId.localeCompare(right.windowId)
  );
}

function replaceWindowLeaf(
  node: SplitNode,
  targetWindowId: string,
  replacement: SplitNode,
): SplitNode {
  if (node.type === "leaf") {
    return node.windowId === targetWindowId ? replacement : node;
  }
  return {
    ...node,
    first: replaceWindowLeaf(node.first, targetWindowId, replacement),
    second: replaceWindowLeaf(node.second, targetWindowId, replacement),
  };
}

interface SplitRebalanceResult {
  node: SplitNode;
  connected: boolean;
}

/**
 * Equalize only the maximal same-direction split component created around the
 * target Window. An orthogonal split is a layout boundary: a vertical group
 * nested in one row must not resize an unrelated vertical group above it.
 */
function rebalanceSplitComponentContainingSplit(
  node: SplitNode,
  targetSplitId: string,
  direction: SplitDirection,
): SplitNode {
  const visit = (current: SplitNode): SplitRebalanceResult => {
    if (current.type === "leaf") {
      return { node: current, connected: false };
    }

    const first = visit(current.first);
    const second = visit(current.second);
    const connected =
      current.id === targetSplitId ||
      (current.direction === direction &&
        (first.connected || second.connected));
    const next: SplitNode = {
      ...current,
      first: first.node,
      second: second.node,
    };
    return {
      node: connected
        ? equalizeSameDirectionSplitComponent(next, direction)
        : next,
      connected,
    };
  };

  return visit(node).node;
}

function equalizeSameDirectionSplitComponent(
  node: SplitNode,
  direction: SplitDirection,
): SplitNode {
  if (node.type !== "split" || node.direction !== direction) return node;
  const firstPaneCount = sameDirectionPaneCount(node.first, direction);
  const secondPaneCount = sameDirectionPaneCount(node.second, direction);
  return {
    ...node,
    ratio: firstPaneCount / (firstPaneCount + secondPaneCount),
    first: equalizeSameDirectionSplitComponent(node.first, direction),
    second: equalizeSameDirectionSplitComponent(node.second, direction),
  };
}

function sameDirectionPaneCount(
  node: SplitNode,
  direction: SplitDirection,
): number {
  return node.type === "split" && node.direction === direction
    ? sameDirectionPaneCount(node.first, direction) +
        sameDirectionPaneCount(node.second, direction)
    : 1;
}

function removeWindowLeaf(
  node: SplitNode,
  targetWindowId: string,
): { node: SplitNode; removed: boolean; preferredWindowId: string | null } {
  if (node.type === "leaf") {
    return { node, removed: false, preferredWindowId: null };
  }
  if (node.first.type === "leaf" && node.first.windowId === targetWindowId) {
    return {
      node: node.second,
      removed: true,
      preferredWindowId: collectWindowIds(node.second)[0],
    };
  }
  if (node.second.type === "leaf" && node.second.windowId === targetWindowId) {
    const ids = collectWindowIds(node.first);
    return {
      node: node.first,
      removed: true,
      preferredWindowId: ids[ids.length - 1],
    };
  }
  const first = removeWindowLeaf(node.first, targetWindowId);
  if (first.removed) return { ...first, node: { ...node, first: first.node } };
  const second = removeWindowLeaf(node.second, targetWindowId);
  if (second.removed) {
    return { ...second, node: { ...node, second: second.node } };
  }
  return { node, removed: false, preferredWindowId: null };
}

function findSplit(state: ApplicationWindowState, splitId: string): boolean {
  const contains = (node: SplitNode): boolean =>
    node.type === "split" &&
    (node.id === splitId || contains(node.first) || contains(node.second));
  return state.tabs.some((tab) => contains(tab.root));
}

function legacyView(state: LegacyWindowViewState): WindowLocalViewState {
  return {
    mode: state.mode,
    selection: state.selection ? { ...state.selection } : null,
    scrollTop: state.scrollTop,
    focusedSectionId: null,
  };
}

function assertNonEmptyId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
