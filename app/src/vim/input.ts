import { DeclarativeKeymap, type KeyBinding } from "../core/keymap";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  INLINE_FORMAT_COMMAND_IDS,
  SHARED_NAVIGATION_COMMAND_IDS,
  TABLE_COMMAND_IDS,
  validateApplicationKeyConfig,
  type ApplicationKeyConfig,
} from "../core/application-key-config";
import {
  resolveLeaderShortcut,
  type LeaderShortcutResolution,
} from "../core/leader-shortcuts";
import {
  TAB_DIRECT_COMMAND_IDS,
  TAB_SHORTCUT_KEYS,
  type TabDirectCommandId,
} from "../core/tab-shortcuts";

export type VimMode =
  | "normal"
  | "insert"
  | "replace"
  | "visual-char"
  | "visual-line"
  | "visual-block";

export const VIM_COMMANDS = [
  "mode.insert",
  "mode.append",
  "mode.replace",
  "mode.normal",
  "mode.visual-char",
  "mode.visual-line",
  "mode.visual-block",
  "insert.line-start",
  "insert.line-end",
  "insert.backspace",
  "insert.newline",
  "insert.delete-line-prefix",
  "insert.delete-word-backward",
  "line.open-below",
  "line.open-above",
  "cursor.left",
  "cursor.right",
  "cursor.logical-up",
  "cursor.logical-down",
  "cursor.display-up",
  "cursor.display-down",
  "cursor.page-up",
  "cursor.page-down",
  "cursor.half-page-up",
  "cursor.half-page-down",
  "cursor.document-start",
  "cursor.document-end",
  "navigation.follow-link",
  "navigation.open-image-tab",
  "navigation.open-external-link",
  "navigation.jump-back",
  "navigation.jump-forward",
  "section.focus-current",
  "section.focus-parent",
  "section.fold-open",
  "section.fold-open-recursive",
  "section.fold-close",
  "section.fold-close-recursive",
  "section.fold-toggle",
  "section.fold-toggle-recursive",
  "section.demote",
  "section.promote",
  "workspace.search_title",
  "workspace.search_body",
  "workspace.search_buffers",
  "note.search",
  "note.search_next",
  "note.search_previous",
  "application.command_line",
  "application.command_picker",
  "utility.toggle-tree",
  "utility.toggle-outline",
  "window.split-horizontal",
  "window.split-vertical",
  "window.focus-left",
  "window.focus-down",
  "window.focus-up",
  "window.focus-right",
  "window.close",
  "window.only",
  "tab.create",
  "tab.close",
  "tab.next",
  "tab.previous",
  ...TAB_DIRECT_COMMAND_IDS,
  "motion.line-start",
  "motion.line-end",
  "motion.word-forward",
  "motion.word-backward",
  "motion.word-end",
  "motion.big-word-forward",
  "motion.big-word-backward",
  "motion.big-word-end",
  "text-object.inner-word",
  "text-object.around-word",
  "text-object.inner-paragraph",
  "text-object.around-paragraph",
  "operator.delete",
  "operator.yank",
  "operator.change",
  "line.delete",
  "line.yank",
  "line.change",
  "line.delete-to-end",
  "line.change-to-end",
  "line.join",
  "line.join-raw",
  "character.delete",
  "replace.character",
  "selection.yank",
  "selection.delete",
  "selection.change",
  "selection.paste",
  "selection.format",
  "selection.reselect",
  "context.action_picker",
  "table.next_cell",
  "table.previous_cell",
  "put.after",
  "put.before",
  "history.undo",
  "history.redo",
  "edit.repeat",
] as const;

export type VimCommand = (typeof VIM_COMMANDS)[number];

export interface KeyContext {
  isComposing: boolean;
  targetKind: "note-body" | "title" | "sidebar";
}

export type VimOperator = "delete" | "yank" | "change";

export const MAX_VIM_COUNT = 9_999;

export type VimPendingInput =
  | {
      kind: "operator";
      operator: VimOperator;
      key: "d" | "y" | "c";
      count: string;
      textObjectPrefix?: "i" | "a";
    }
  | {
      kind: "prefix";
      key: "g" | "t" | "z" | ">" | "<" | "leader" | "Ctrl+w";
      count: string;
    }
  | {
      kind: "replace-character";
      key: "r";
      count: string;
    }
  | {
      kind: "custom-prefix";
      sequence: string;
      count: string;
    };

export interface VimInputState {
  pending: VimPendingInput | null;
  count: string;
}

export type VimInputAction =
  | {
      kind: "execute";
      command: VimCommand;
      argument?: string;
    }
  | {
      kind: "pending";
      detail:
        | "pending:delete"
        | "pending:count"
        | "pending:g"
        | "pending:tab"
        | "pending:section"
        | "pending:section-demote"
        | "pending:section-promote"
        | "pending:leader"
        | "pending:window"
        | "pending:yank"
        | "pending:change"
        | "pending:replace-character"
        | "pending:text-object-inner"
        | "pending:text-object-around"
        | "pending:keymap";
    }
  | {
      kind: "unmapped";
    }
  | {
      kind: "leader-shortcut";
      resolution: Exclude<LeaderShortcutResolution, { kind: "execute" }> | null;
    };

export interface VimInputResolution {
  state: VimInputState;
  sequence: string;
  resolvedCommand: VimCommand | null;
  operator: VimOperator | null;
  count: number;
  countExplicit?: boolean;
  argument?: string;
  action: VimInputAction;
}

function modeBindings(
  context: VimMode,
  commands: Readonly<Record<string, VimCommand>>,
): KeyBinding<VimMode, VimCommand>[] {
  return Object.entries(commands).map(([sequence, command]) => ({
    context,
    sequence,
    command,
  }));
}

const defaultTabDirectBindings = Object.fromEntries(
  TAB_SHORTCUT_KEYS.map((key) => [
    `t${key}`,
    `tab.select-${key}` as TabDirectCommandId,
  ]),
) as Readonly<Record<string, TabDirectCommandId>>;

export const DEFAULT_VIM_KEY_BINDINGS: readonly KeyBinding<
  VimMode,
  VimCommand
>[] = [
  ...modeBindings("normal", {
    Escape: "mode.normal",
    i: "mode.insert",
    a: "mode.append",
    I: "insert.line-start",
    A: "insert.line-end",
    o: "line.open-below",
    O: "line.open-above",
    R: "mode.replace",
    h: "cursor.left",
    l: "cursor.right",
    j: "cursor.logical-down",
    k: "cursor.logical-up",
    gj: "cursor.display-down",
    gk: "cursor.display-up",
    gg: "cursor.document-start",
    gf: "navigation.follow-link",
    "Ctrl+wgf": "navigation.open-image-tab",
    gx: "navigation.open-external-link",
    zf: "section.focus-current",
    zF: "section.focus-parent",
    zo: "section.fold-open",
    zO: "section.fold-open-recursive",
    zc: "section.fold-close",
    zC: "section.fold-close-recursive",
    za: "section.fold-toggle",
    zA: "section.fold-toggle-recursive",
    ">>": "section.demote",
    "<<": "section.promote",
    gt: "tab.next",
    gT: "tab.previous",
    tc: "tab.create",
    tn: "tab.next",
    tp: "tab.previous",
    td: "tab.close",
    ...defaultTabDirectBindings,
    G: "cursor.document-end",
    "Ctrl+o": "navigation.jump-back",
    "Ctrl+i": "navigation.jump-forward",
    "/": "note.search",
    n: "note.search_next",
    N: "note.search_previous",
    ":": "application.command_line",
    "Ctrl+b": "cursor.page-up",
    "Ctrl+f": "cursor.page-down",
    "Ctrl+u": "cursor.half-page-up",
    "Ctrl+d": "cursor.half-page-down",
    "Ctrl+ws": "window.split-horizontal",
    "Ctrl+wv": "window.split-vertical",
    "Ctrl+wh": "window.focus-left",
    "Ctrl+wj": "window.focus-down",
    "Ctrl+wk": "window.focus-up",
    "Ctrl+wl": "window.focus-right",
    "Ctrl+wc": "window.close",
    "Ctrl+wo": "window.only",
    "0": "motion.line-start",
    $: "motion.line-end",
    w: "motion.word-forward",
    b: "motion.word-backward",
    e: "motion.word-end",
    W: "motion.big-word-forward",
    B: "motion.big-word-backward",
    E: "motion.big-word-end",
    d: "operator.delete",
    y: "operator.yank",
    c: "operator.change",
    dd: "line.delete",
    yy: "line.yank",
    cc: "line.change",
    D: "line.delete-to-end",
    C: "line.change-to-end",
    S: "line.change",
    J: "line.join",
    gJ: "line.join-raw",
    x: "character.delete",
    r: "replace.character",
    p: "put.after",
    P: "put.before",
    v: "mode.visual-char",
    V: "mode.visual-line",
    "Ctrl+v": "mode.visual-block",
    gv: "selection.reselect",
    Tab: "table.next_cell",
    "Shift+Tab": "table.previous_cell",
    u: "history.undo",
    "Ctrl+r": "history.redo",
    ".": "edit.repeat",
  }),
  ...modeBindings("insert", {
    Escape: "mode.normal",
    "Ctrl+c": "mode.normal",
    "Ctrl+h": "insert.backspace",
    "Ctrl+j": "insert.newline",
    "Ctrl+m": "insert.newline",
    "Ctrl+u": "insert.delete-line-prefix",
    "Ctrl+w": "insert.delete-word-backward",
    "Ctrl+t": "section.demote",
    "Ctrl+d": "section.promote",
  }),
  ...modeBindings("replace", {
    Escape: "mode.normal",
  }),
  ...modeBindings("visual-char", {
    Escape: "mode.normal",
    h: "cursor.left",
    l: "cursor.right",
    j: "cursor.logical-down",
    k: "cursor.logical-up",
    gj: "cursor.display-down",
    gk: "cursor.display-up",
    gg: "cursor.document-start",
    G: "cursor.document-end",
    "Ctrl+b": "cursor.page-up",
    "Ctrl+f": "cursor.page-down",
    "Ctrl+u": "cursor.half-page-up",
    "Ctrl+d": "cursor.half-page-down",
    "0": "motion.line-start",
    $: "motion.line-end",
    w: "motion.word-forward",
    b: "motion.word-backward",
    e: "motion.word-end",
    y: "selection.yank",
    d: "selection.delete",
    c: "selection.change",
    p: "selection.paste",
    P: "selection.paste",
    m: "selection.format",
    gv: "selection.reselect",
  }),
  ...modeBindings("visual-line", {
    Escape: "mode.normal",
    h: "cursor.left",
    l: "cursor.right",
    j: "cursor.logical-down",
    k: "cursor.logical-up",
    gj: "cursor.display-down",
    gk: "cursor.display-up",
    gg: "cursor.document-start",
    G: "cursor.document-end",
    "Ctrl+b": "cursor.page-up",
    "Ctrl+f": "cursor.page-down",
    "Ctrl+u": "cursor.half-page-up",
    "Ctrl+d": "cursor.half-page-down",
    ">": "section.demote",
    "<": "section.promote",
    y: "selection.yank",
    d: "selection.delete",
    c: "selection.change",
    p: "selection.paste",
    P: "selection.paste",
    gv: "selection.reselect",
  }),
  ...modeBindings("visual-block", {
    Escape: "mode.normal",
    h: "cursor.left",
    l: "cursor.right",
    j: "cursor.logical-down",
    k: "cursor.logical-up",
    gj: "cursor.display-down",
    gk: "cursor.display-up",
    gg: "cursor.document-start",
    G: "cursor.document-end",
    "0": "motion.line-start",
    $: "motion.line-end",
    y: "selection.yank",
    d: "selection.delete",
    c: "selection.change",
    p: "selection.paste",
    P: "selection.paste",
    gv: "selection.reselect",
  }),
];

const defaultVimKeymap = new DeclarativeKeymap(
  DEFAULT_VIM_KEY_BINDINGS,
  VIM_COMMANDS,
);

const sharedNavigationCommands = new Set<VimCommand>(
  SHARED_NAVIGATION_COMMAND_IDS,
);
const sharedNavigationModes = new Set<VimMode>([
  "normal",
  "visual-char",
  "visual-line",
  "visual-block",
]);
const vimKeymapCache = new WeakMap<
  ApplicationKeyConfig,
  DeclarativeKeymap<VimMode, VimCommand>
>();

const operatorMotions: Partial<Record<string, VimCommand>> = {
  h: "cursor.left",
  l: "cursor.right",
  j: "cursor.logical-down",
  k: "cursor.logical-up",
  "0": "motion.line-start",
  $: "motion.line-end",
  w: "motion.word-forward",
  b: "motion.word-backward",
  e: "motion.word-end",
  W: "motion.big-word-forward",
  B: "motion.big-word-backward",
  E: "motion.big-word-end",
};

const modifierOnlyKeys = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

export function resolveKey(
  mode: VimMode,
  sequence: string,
  context: KeyContext,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
): VimCommand | null {
  if (context.isComposing) return null;
  const command = effectiveVimKeymap(keyConfig).resolve(mode, sequence);
  if (
    [
      "line.delete",
      "line.yank",
      "line.change",
      "line.delete-to-end",
      "line.change-to-end",
      "line.join",
      "line.join-raw",
      "character.delete",
      "replace.character",
      "line.open-below",
      "line.open-above",
      "section.fold-open",
      "section.fold-open-recursive",
      "section.fold-close",
      "section.fold-close-recursive",
      "section.fold-toggle",
      "section.fold-toggle-recursive",
      "section.demote",
      "section.promote",
    ].includes(command ?? "") &&
    context.targetKind !== "note-body"
  ) {
    return null;
  }
  return command;
}

export function createVimInputState(): VimInputState {
  return { pending: null, count: "" };
}

function pendingKey(pending: VimPendingInput | null): string {
  if (pending?.kind === "operator") {
    return `${pending.key}${pending.textObjectPrefix ?? ""}`;
  }
  if (pending?.kind === "custom-prefix") return pending.sequence;
  return pending?.kind === "prefix" && pending.key === "leader"
    ? "Leader "
    : (pending?.key ?? "");
}

function inputSequence(
  state: VimInputState,
  key: string,
  keyConfig: ApplicationKeyConfig,
): string {
  if (!state.pending) return `${state.count}${key}`;
  if (state.pending.kind === "operator") {
    return `${state.pending.count}${state.pending.key}${state.count}${state.pending.textObjectPrefix ?? ""}${key}`;
  }
  if (state.pending.kind === "custom-prefix") {
    return `${state.pending.count}${state.pending.sequence}${key}`;
  }
  const prefix =
    state.pending.key === "leader" ? keyConfig.leaderKey : state.pending.key;
  return `${state.pending.count}${prefix}${key}`;
}

function parsedCount(count: string): number {
  if (!count) return 1;
  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(parsed, MAX_VIM_COUNT))
    : 1;
}

function multipliedCount(left: string, right: string): number {
  return Math.min(parsedCount(left) * parsedCount(right), MAX_VIM_COUNT);
}

function isCountDigit(state: VimInputState, key: string): boolean {
  if (!/^\d$/u.test(key)) return false;
  if (state.pending?.kind === "replace-character") return false;
  if (state.pending?.kind === "prefix") return false;
  if (state.pending?.kind === "operator" && state.pending.textObjectPrefix) {
    return false;
  }
  return key !== "0" || state.count.length > 0;
}

function appendCount(count: string, key: string): string {
  const next = `${count}${key}`;
  return `${Math.min(Number.parseInt(next, 10), MAX_VIM_COUNT)}`;
}

export function advanceVimInput(
  state: VimInputState,
  mode: VimMode,
  key: string,
  context: KeyContext,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
): VimInputResolution {
  validateApplicationKeyConfig(keyConfig);
  const acceptsApplicationKeys = context.targetKind === "note-body";
  const semanticKey =
    state.pending?.kind === "prefix" &&
    state.pending.key === "Ctrl+w" &&
    /^Ctrl\+[chjklosv]$/u.test(key)
      ? key.slice("Ctrl+".length)
      : key;
  const sequence = inputSequence(state, semanticKey, keyConfig);
  const commandSequence = `${pendingKey(state.pending)}${semanticKey}`;
  const leaderPrefixKey =
    state.pending === null &&
    key === keyConfig.leaderKey &&
    mode !== "insert" &&
    mode !== "replace" &&
    acceptsApplicationKeys;
  const resolvedCommand = leaderPrefixKey
    ? null
    : resolveKey(mode, commandSequence, context, keyConfig);
  const operatorInput =
    state.pending?.kind === "operator" ? state.pending : null;
  const pendingOperator = operatorInput?.operator ?? null;
  const textObjectPrefix = operatorInput?.textObjectPrefix;

  // Typing symbols such as `$` produces a standalone Shift keydown first.
  // Modifier-only events must not cancel a pending Operator, prefix, or Count.
  if (modifierOnlyKeys.has(key)) {
    return {
      state,
      sequence,
      resolvedCommand: null,
      operator: null,
      count: parsedCount(state.count),
      action: { kind: "unmapped" },
    };
  }

  if (state.pending?.kind === "prefix" && state.pending.key === "leader") {
    if (context.isComposing) {
      return {
        state: createVimInputState(),
        sequence,
        resolvedCommand: null,
        operator: null,
        count: parsedCount(state.pending.count),
        action: { kind: "unmapped" },
      };
    }
    if (key === "Escape") {
      return {
        state: createVimInputState(),
        sequence,
        resolvedCommand: null,
        operator: null,
        count: parsedCount(state.pending.count),
        action: { kind: "leader-shortcut", resolution: null },
      };
    }
    const leaderResolution = resolveLeaderShortcut(key, "editor");
    if (leaderResolution.kind === "execute") {
      return {
        state: createVimInputState(),
        sequence,
        resolvedCommand: leaderResolution.command,
        operator: null,
        count: parsedCount(state.pending.count),
        countExplicit: state.pending.count.length > 0,
        action: { kind: "execute", command: leaderResolution.command },
      };
    }
    return {
      state: createVimInputState(),
      sequence,
      resolvedCommand: null,
      operator: null,
      count: parsedCount(state.pending.count),
      countExplicit: state.pending.count.length > 0,
      action: { kind: "leader-shortcut", resolution: leaderResolution },
    };
  }

  if (
    !context.isComposing &&
    context.targetKind === "note-body" &&
    mode !== "insert" &&
    mode !== "replace" &&
    isCountDigit(state, key)
  ) {
    const count = appendCount(state.count, key);
    return {
      state: { ...state, count },
      sequence,
      resolvedCommand: null,
      operator: null,
      count: parsedCount(count),
      action: { kind: "pending", detail: "pending:count" },
    };
  }

  if (
    !context.isComposing &&
    context.targetKind === "note-body" &&
    state.pending?.kind === "replace-character"
  ) {
    if (key === "Escape") {
      return {
        state: createVimInputState(),
        sequence,
        resolvedCommand: "mode.normal",
        operator: null,
        count: 1,
        action: { kind: "execute", command: "mode.normal" },
      };
    }
    if (Array.from(key).length === 1) {
      return {
        state: createVimInputState(),
        sequence,
        resolvedCommand: "replace.character",
        operator: null,
        count: parsedCount(state.pending.count),
        argument: key,
        action: {
          kind: "execute",
          command: "replace.character",
          argument: key,
        },
      };
    }
    return {
      state: createVimInputState(),
      sequence,
      resolvedCommand: null,
      operator: null,
      count: 1,
      action: { kind: "unmapped" },
    };
  }

  if (
    !context.isComposing &&
    context.targetKind === "note-body" &&
    pendingOperator &&
    textObjectPrefix &&
    (key === "w" || key === "p")
  ) {
    const object: VimCommand =
      key === "w"
        ? textObjectPrefix === "i"
          ? "text-object.inner-word"
          : "text-object.around-word"
        : textObjectPrefix === "i"
          ? "text-object.inner-paragraph"
          : "text-object.around-paragraph";
    return {
      state: createVimInputState(),
      sequence,
      resolvedCommand: object,
      operator: pendingOperator,
      count: multipliedCount(operatorInput?.count ?? "", state.count),
      action: { kind: "execute", command: object },
    };
  }

  if (
    !context.isComposing &&
    context.targetKind === "note-body" &&
    pendingOperator &&
    !textObjectPrefix &&
    (key === "i" || key === "a")
  ) {
    return {
      state: {
        pending: {
          ...(state.pending as Extract<VimPendingInput, { kind: "operator" }>),
          textObjectPrefix: key,
        },
        count: state.count,
      },
      sequence,
      resolvedCommand: null,
      operator: null,
      count: parsedCount(state.count),
      action: {
        kind: "pending",
        detail:
          key === "i"
            ? "pending:text-object-inner"
            : "pending:text-object-around",
      },
    };
  }

  if (
    !context.isComposing &&
    context.targetKind === "note-body" &&
    pendingOperator &&
    !textObjectPrefix &&
    operatorMotions[key]
  ) {
    const command = operatorMotions[key] as VimCommand;
    return {
      state: createVimInputState(),
      sequence,
      resolvedCommand: command,
      operator: pendingOperator,
      count: multipliedCount(operatorInput?.count ?? "", state.count),
      action: { kind: "execute", command },
    };
  }

  const prefixKey = leaderPrefixKey
    ? "leader"
    : key === "g" &&
        mode !== "insert" &&
        mode !== "replace" &&
        !(state.pending?.kind === "prefix" && state.pending.key === "Ctrl+w")
      ? "g"
      : key === "z" && mode === "normal" && acceptsApplicationKeys
        ? "z"
        : (key === ">" || key === "<") &&
            mode === "normal" &&
            acceptsApplicationKeys
          ? key
          : key === "t" && mode === "normal" && acceptsApplicationKeys
            ? "t"
            : key === "Ctrl+w" && mode === "normal" && acceptsApplicationKeys
              ? "Ctrl+w"
              : null;
  const customPrefix =
    !context.isComposing &&
    !resolvedCommand &&
    hasVimKeyPrefix(mode, commandSequence, keyConfig);
  if (!context.isComposing && !resolvedCommand && (prefixKey || customPrefix)) {
    const pending: VimPendingInput = prefixKey
      ? { kind: "prefix", key: prefixKey, count: state.count }
      : {
          kind: "custom-prefix",
          sequence: commandSequence,
          count:
            state.pending?.kind === "custom-prefix"
              ? state.pending.count
              : state.count,
        };
    return {
      state: {
        pending,
        count: "",
      },
      sequence,
      resolvedCommand,
      operator: null,
      count: parsedCount(state.count),
      action: {
        kind: "pending",
        detail: !prefixKey
          ? "pending:keymap"
          : prefixKey === "g"
            ? "pending:g"
            : prefixKey === "z"
              ? "pending:section"
              : prefixKey === ">"
                ? "pending:section-demote"
                : prefixKey === "<"
                  ? "pending:section-promote"
                  : prefixKey === "t"
                    ? "pending:tab"
                    : prefixKey === "leader"
                      ? "pending:leader"
                      : "pending:window",
      },
    };
  }

  if (resolvedCommand === "operator.delete") {
    return {
      state: {
        pending: {
          kind: "operator",
          operator: "delete",
          key: "d",
          count: state.count,
        },
        count: "",
      },
      sequence,
      resolvedCommand,
      operator: null,
      count: parsedCount(state.count),
      action: { kind: "pending", detail: "pending:delete" },
    };
  }

  if (resolvedCommand === "operator.yank") {
    return {
      state: {
        pending: {
          kind: "operator",
          operator: "yank",
          key: "y",
          count: state.count,
        },
        count: "",
      },
      sequence,
      resolvedCommand,
      operator: null,
      count: parsedCount(state.count),
      action: { kind: "pending", detail: "pending:yank" },
    };
  }

  if (resolvedCommand === "operator.change") {
    return {
      state: {
        pending: {
          kind: "operator",
          operator: "change",
          key: "c",
          count: state.count,
        },
        count: "",
      },
      sequence,
      resolvedCommand,
      operator: null,
      count: parsedCount(state.count),
      action: { kind: "pending", detail: "pending:change" },
    };
  }

  if (resolvedCommand === "replace.character") {
    return {
      state: {
        pending: {
          kind: "replace-character",
          key: "r",
          count: state.count,
        },
        count: "",
      },
      sequence,
      resolvedCommand,
      operator: null,
      count: parsedCount(state.count),
      action: { kind: "pending", detail: "pending:replace-character" },
    };
  }

  return {
    state: createVimInputState(),
    sequence,
    resolvedCommand,
    operator: null,
    count:
      state.pending?.kind === "prefix" ||
      state.pending?.kind === "custom-prefix"
        ? parsedCount(state.pending.count)
        : pendingOperator
          ? multipliedCount(operatorInput?.count ?? "", state.count)
          : parsedCount(state.count),
    countExplicit:
      state.pending?.kind === "prefix" ||
      state.pending?.kind === "custom-prefix"
        ? state.pending.count.length > 0
        : pendingOperator
          ? Boolean(operatorInput?.count || state.count)
          : state.count.length > 0,
    action: resolvedCommand
      ? { kind: "execute", command: resolvedCommand }
      : { kind: "unmapped" },
  };
}

export function validateVimKeyConfig(config: ApplicationKeyConfig): void {
  validateApplicationKeyConfig(config);
  effectiveVimKeymap(config);
}

function effectiveVimKeymap(
  config: ApplicationKeyConfig,
): DeclarativeKeymap<VimMode, VimCommand> {
  if (config === DEFAULT_APPLICATION_KEY_CONFIG) return defaultVimKeymap;
  const cached = vimKeymapCache.get(config);
  if (cached) return cached;
  const bindings = DEFAULT_VIM_KEY_BINDINGS.filter(
    ({ context, command }) =>
      !(
        sharedNavigationModes.has(context) &&
        sharedNavigationCommands.has(command)
      ) &&
      command !== "selection.format" &&
      !TABLE_COMMAND_IDS.includes(
        command as (typeof TABLE_COMMAND_IDS)[number],
      ),
  );
  const configured =
    config.sharedNavigationBindings ??
    DEFAULT_APPLICATION_KEY_CONFIG.sharedNavigationBindings!;
  for (const context of sharedNavigationModes) {
    for (const command of SHARED_NAVIGATION_COMMAND_IDS) {
      for (const sequence of configured[command]) {
        const normalized = normalizeConfiguredVimSequence(sequence);
        const conflict = bindings.find((binding) => {
          if (binding.context !== context) return false;
          const configuredKeys = vimSequenceKeys(normalized);
          const existingKeys = vimSequenceKeys(binding.sequence);
          return (
            isKeyPrefix(configuredKeys, existingKeys) ||
            isKeyPrefix(existingKeys, configuredKeys)
          );
        });
        if (conflict) {
          throw new Error(
            `Ambiguous ${context} key bindings: ${command}:${normalized} and ${conflict.command}:${conflict.sequence}`,
          );
        }
        bindings.push({
          context,
          sequence: normalized,
          command,
        });
      }
    }
  }
  const inlineFormat =
    config.inlineFormatBindings ??
    DEFAULT_APPLICATION_KEY_CONFIG.inlineFormatBindings!;
  for (const command of INLINE_FORMAT_COMMAND_IDS) {
    for (const sequence of inlineFormat[command]) {
      const normalized = normalizeConfiguredVimSequence(sequence);
      const conflict = bindings.find((binding) => {
        if (binding.context !== "visual-char") return false;
        const configuredKeys = vimSequenceKeys(normalized);
        const existingKeys = vimSequenceKeys(binding.sequence);
        return (
          isKeyPrefix(configuredKeys, existingKeys) ||
          isKeyPrefix(existingKeys, configuredKeys)
        );
      });
      if (conflict) {
        throw new Error(
          `Ambiguous visual-char key bindings: ${command}:${normalized} and ${conflict.command}:${conflict.sequence}`,
        );
      }
      bindings.push({
        context: "visual-char",
        sequence: normalized,
        command,
      });
    }
  }
  const table =
    config.tableBindings ?? DEFAULT_APPLICATION_KEY_CONFIG.tableBindings!;
  for (const command of TABLE_COMMAND_IDS) {
    const contexts: readonly VimMode[] = ["normal"];
    for (const context of contexts) {
      for (const sequence of table[command]) {
        const normalized = normalizeConfiguredVimSequence(sequence);
        const conflict = bindings.find((binding) => {
          if (binding.context !== context) return false;
          const configuredKeys = vimSequenceKeys(normalized);
          const existingKeys = vimSequenceKeys(binding.sequence);
          return (
            isKeyPrefix(configuredKeys, existingKeys) ||
            isKeyPrefix(existingKeys, configuredKeys)
          );
        });
        if (conflict) {
          throw new Error(
            `Ambiguous ${context} key bindings: ${command}:${normalized} and ${conflict.command}:${conflict.sequence}`,
          );
        }
        bindings.push({ context, sequence: normalized, command });
      }
    }
  }
  const keymap = new DeclarativeKeymap(bindings, VIM_COMMANDS);
  vimKeymapCache.set(config, keymap);
  return keymap;
}

function hasVimKeyPrefix(
  mode: VimMode,
  sequence: string,
  config: ApplicationKeyConfig,
): boolean {
  return effectiveVimKeymap(config)
    .bindings()
    .some((binding) => {
      if (binding.context !== mode) return false;
      const candidate = vimSequenceKeys(binding.sequence);
      const prefix = vimSequenceKeys(sequence);
      return candidate.length > prefix.length && isKeyPrefix(prefix, candidate);
    });
}

function normalizeConfiguredVimSequence(sequence: string): string {
  return sequence
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => (token === "Leader" ? "Leader " : token))
    .join("");
}

function vimSequenceKeys(sequence: string): string[] {
  const keys: string[] = [];
  for (const token of sequence.match(
    /Ctrl\+[a-z]|Shift\+Tab|Leader\s|Tab|Escape|Enter|./gu,
  ) ?? []) {
    keys.push(token === "Leader " ? "Leader" : token);
  }
  return keys;
}

function isKeyPrefix(
  prefix: readonly string[],
  candidate: readonly string[],
): boolean {
  return prefix.every((key, index) => candidate[index] === key);
}

const vimWindowCommands = new Set<VimCommand>([
  "window.split-horizontal",
  "window.split-vertical",
  "window.focus-left",
  "window.focus-down",
  "window.focus-up",
  "window.focus-right",
  "window.close",
  "window.only",
  "tab.create",
  "tab.close",
  "tab.next",
  "tab.previous",
  ...TAB_DIRECT_COMMAND_IDS,
]);

export type VimWindowCommand =
  | "window.split-horizontal"
  | "window.split-vertical"
  | "window.focus-left"
  | "window.focus-down"
  | "window.focus-up"
  | "window.focus-right"
  | "window.close"
  | "window.only"
  | "tab.create"
  | "tab.close"
  | "tab.next"
  | "tab.previous"
  | TabDirectCommandId;

export function isVimWindowCommand(
  command: VimCommand,
): command is VimWindowCommand {
  return vimWindowCommands.has(command);
}

const vimApplicationCommands = new Set<VimCommand>([
  "utility.toggle-tree",
  "utility.toggle-outline",
]);

export type VimApplicationCommand =
  "utility.toggle-tree" | "utility.toggle-outline";

export function isVimApplicationCommand(
  command: VimCommand,
): command is VimApplicationCommand {
  return vimApplicationCommands.has(command);
}
