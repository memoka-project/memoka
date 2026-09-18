import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
  SHARED_NAVIGATION_COMMAND_IDS,
  type SharedNavigationCommandId,
} from "./application-key-config";
import {
  SIDEBAR_FOLD_BINDINGS,
  type SidebarFoldCommand,
} from "./sidebar-folding";

export type TreeCommandId =
  | SidebarFoldCommand
  | SharedNavigationCommandId
  | "navigation.jump-back"
  | "navigation.jump-forward"
  | "note.open"
  | "note.create_sibling_after"
  | "note.create_child"
  | "note.create_root"
  | "note.move_up"
  | "note.move_down"
  | "note.move_outdent"
  | "note.move_indent"
  | "note.move_to_trash"
  | "trash.open"
  | "sidebar.close";

export const TREE_COMMAND_IDS: readonly TreeCommandId[] = [
  ...SHARED_NAVIGATION_COMMAND_IDS,
  "navigation.jump-back",
  "navigation.jump-forward",
  "note.open",
  "note.create_sibling_after",
  "note.create_child",
  "note.create_root",
  "note.move_up",
  "note.move_down",
  "note.move_outdent",
  "note.move_indent",
  "note.move_to_trash",
  "trash.open",
  "sidebar.close",
];

export interface TreeInputState {
  readonly pending: readonly string[];
  readonly count: string;
}

export interface TreeKeyInput {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
}

export type TreeInputResolution =
  | { kind: "pending"; state: TreeInputState; consume: true }
  | {
      kind: "execute";
      state: TreeInputState;
      consume: true;
      command: TreeCommandId;
      count: number;
      countExplicit: boolean;
    }
  | { kind: "unmapped"; state: TreeInputState; consume: boolean };

export function createTreeInputState(): TreeInputState {
  return { pending: [], count: "" };
}

export function advanceTreeInput(
  state: TreeInputState,
  event: TreeKeyInput,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
  navigationOnly = false,
): TreeInputResolution {
  if (isModifierOnlyInput(event)) {
    return {
      kind: "unmapped",
      state,
      consume: false,
    };
  }
  const key = canonicalEventKey(event);
  if (!key) {
    return {
      kind: "unmapped",
      state: createTreeInputState(),
      consume: state.pending.length > 0 || Boolean(state.count),
    };
  }
  if (
    state.pending.length === 0 &&
    /^[0-9]$/u.test(key) &&
    (key !== "0" || state.count.length > 0)
  ) {
    return {
      kind: "pending",
      state: {
        pending: [],
        count: String(Math.min(9_999, Number(`${state.count}${key}`))),
      },
      consume: true,
    };
  }

  const pending = [...state.pending, key];
  if (key === "Escape" && (state.pending.length > 0 || state.count)) {
    return { kind: "unmapped", state: createTreeInputState(), consume: true };
  }
  const bindings = effectiveTreeBindings(keyConfig).filter(
    ({ command }) =>
      !navigationOnly ||
      command.startsWith("cursor.") ||
      command.startsWith("viewport.") ||
      command.startsWith("fold.") ||
      command.startsWith("navigation."),
  );
  const exact = bindings.find(({ keys }) => sameKeys(keys, pending));
  const hasLonger = bindings.some(
    ({ keys }) => keys.length > pending.length && startsWithKeys(keys, pending),
  );
  if (exact && !hasLonger) {
    const countExplicit = state.count.length > 0;
    if (countExplicit && !supportsCount(exact.command)) {
      return {
        kind: "unmapped",
        state: createTreeInputState(),
        consume: true,
      };
    }
    return {
      kind: "execute",
      state: createTreeInputState(),
      consume: true,
      command: exact.command,
      count: countExplicit ? Number(state.count) : 1,
      countExplicit,
    };
  }
  if (hasLonger) {
    return {
      kind: "pending",
      state: { pending, count: state.count },
      consume: true,
    };
  }
  return {
    kind: "unmapped",
    state: createTreeInputState(),
    consume: pending.length > 1 || Boolean(state.count),
  };
}

const modifierOnlyKeys = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);
const modifierOnlyCode = /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/u;

function isModifierOnlyInput(event: TreeKeyInput): boolean {
  return (
    modifierOnlyKeys.has(event.key) || modifierOnlyCode.test(event.code ?? "")
  );
}

function effectiveTreeBindings(
  config: ApplicationKeyConfig,
): Array<{ command: TreeCommandId; keys: string[] }> {
  // Native Tree navigation supplements the configurable Vim bindings without
  // changing how arrow keys move the caret in Editor buffers.
  const result: Array<{ command: TreeCommandId; keys: string[] }> = [
    ...Object.entries(SIDEBAR_FOLD_BINDINGS).map(([command, sequence]) => ({
      command: command as SidebarFoldCommand,
      keys: Array.from(sequence),
    })),
    { command: "cursor.left", keys: ["ArrowLeft"] },
    { command: "cursor.right", keys: ["ArrowRight"] },
    { command: "cursor.logical-up", keys: ["ArrowUp"] },
    { command: "cursor.logical-down", keys: ["ArrowDown"] },
    { command: "navigation.jump-back", keys: ["Ctrl+o"] },
    { command: "navigation.jump-forward", keys: ["Ctrl+i"] },
  ];
  const treeBindings =
    config.treeBindings ?? DEFAULT_APPLICATION_KEY_CONFIG.treeBindings!;
  const navigationBindings =
    config.sharedNavigationBindings ??
    DEFAULT_APPLICATION_KEY_CONFIG.sharedNavigationBindings!;
  for (const command of TREE_COMMAND_IDS) {
    const sequences =
      treeBindings[command as keyof typeof treeBindings] ??
      navigationBindings[command as keyof typeof navigationBindings];
    for (const sequence of sequences ?? []) {
      result.push({ command, keys: parseKeySequence(sequence) });
    }
  }
  return result;
}

export function parseKeySequence(sequence: string): string[] {
  const tokens = sequence.trim().split(/\s+/u).filter(Boolean);
  const keys: string[] = [];
  for (const token of tokens) {
    if (
      token.startsWith("Ctrl+") ||
      ["Enter", "Escape", "Space", "Tab"].includes(token)
    ) {
      keys.push(token);
    } else {
      keys.push(...Array.from(token));
    }
  }
  return keys;
}

function canonicalEventKey(event: TreeKeyInput): string | null {
  if (event.isComposing || event.altKey || event.metaKey) return null;
  if (event.ctrlKey) {
    const codeKey = event.code?.match(/^Key([A-Z])$/u)?.[1];
    const key = (codeKey ?? event.key).toLocaleLowerCase();
    return key.length === 1 ? `Ctrl+${key}` : null;
  }
  return event.key === " " ? "Space" : event.key;
}

function supportsCount(command: TreeCommandId): boolean {
  return (
    command.startsWith("cursor.") ||
    command.startsWith("viewport.") ||
    command.startsWith("navigation.") ||
    command === "note.move_up" ||
    command === "note.move_down" ||
    command === "note.move_outdent" ||
    command === "note.move_indent"
  );
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && startsWithKeys(left, right);
}

function startsWithKeys(
  candidate: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((key, index) => candidate[index] === key);
}
