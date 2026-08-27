export const SHARED_NAVIGATION_COMMAND_IDS = [
  "cursor.left",
  "cursor.right",
  "cursor.logical-up",
  "cursor.logical-down",
  "cursor.document-start",
  "cursor.document-end",
  "cursor.page-up",
  "cursor.page-down",
  "cursor.half-page-up",
  "cursor.half-page-down",
] as const;

export const TREE_SPECIFIC_COMMAND_IDS = [
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
] as const;

export const INLINE_FORMAT_COMMAND_IDS = ["selection.format"] as const;

export type SharedNavigationCommandId =
  (typeof SHARED_NAVIGATION_COMMAND_IDS)[number];
export type TreeSpecificCommandId = (typeof TREE_SPECIFIC_COMMAND_IDS)[number];
export type InlineFormatCommandId = (typeof INLINE_FORMAT_COMMAND_IDS)[number];

export interface ApplicationKeyConfig {
  readonly leaderKey: string;
  readonly sharedNavigationBindings?: Readonly<
    Record<SharedNavigationCommandId, readonly string[]>
  >;
  readonly treeBindings?: Readonly<
    Record<TreeSpecificCommandId, readonly string[]>
  >;
  readonly inlineFormatBindings?: Readonly<
    Record<InlineFormatCommandId, readonly string[]>
  >;
}

export interface PartialApplicationKeyConfig {
  readonly leaderKey?: string;
  readonly sharedNavigationBindings?: Readonly<
    Partial<Record<SharedNavigationCommandId, readonly string[]>>
  >;
  readonly treeBindings?: Readonly<
    Partial<Record<TreeSpecificCommandId, readonly string[]>>
  >;
  readonly inlineFormatBindings?: Readonly<
    Partial<Record<InlineFormatCommandId, readonly string[]>>
  >;
}

export const DEFAULT_APPLICATION_KEY_CONFIG: ApplicationKeyConfig =
  Object.freeze({
    leaderKey: ",",
    sharedNavigationBindings: Object.freeze({
      "cursor.left": ["h"],
      "cursor.right": ["l"],
      "cursor.logical-up": ["k"],
      "cursor.logical-down": ["j"],
      "cursor.document-start": ["gg"],
      "cursor.document-end": ["G"],
      "cursor.page-up": ["Ctrl+b"],
      "cursor.page-down": ["Ctrl+f"],
      "cursor.half-page-up": ["Ctrl+u"],
      "cursor.half-page-down": ["Ctrl+d"],
    }),
    treeBindings: Object.freeze({
      "note.open": ["Enter"],
      "note.create_sibling_after": ["a"],
      "note.create_child": ["c"],
      "note.create_root": ["A"],
      "note.move_up": ["K"],
      "note.move_down": ["J"],
      "note.move_outdent": ["H"],
      "note.move_indent": ["L"],
      "note.move_to_trash": ["D"],
      "trash.open": ["T"],
      "sidebar.close": ["Escape"],
    }),
    inlineFormatBindings: Object.freeze({
      "selection.format": ["m"],
    }),
  });

export function mergeApplicationKeyConfig(
  partial: PartialApplicationKeyConfig,
): ApplicationKeyConfig {
  const config: ApplicationKeyConfig = {
    leaderKey: partial.leaderKey ?? DEFAULT_APPLICATION_KEY_CONFIG.leaderKey,
    sharedNavigationBindings: mergeBindings(
      DEFAULT_APPLICATION_KEY_CONFIG.sharedNavigationBindings!,
      partial.sharedNavigationBindings,
    ),
    treeBindings: mergeBindings(
      DEFAULT_APPLICATION_KEY_CONFIG.treeBindings!,
      partial.treeBindings,
    ),
    inlineFormatBindings: mergeBindings(
      DEFAULT_APPLICATION_KEY_CONFIG.inlineFormatBindings!,
      partial.inlineFormatBindings,
    ),
  };
  validateApplicationKeyConfig(config);
  return config;
}

function mergeBindings<Command extends string>(
  defaults: Readonly<Record<Command, readonly string[]>>,
  overrides: Readonly<Partial<Record<Command, readonly string[]>>> | undefined,
): Readonly<Record<Command, readonly string[]>> {
  const merged: Record<Command, readonly string[]> = { ...defaults };
  if (overrides) {
    for (const command of Object.keys(overrides) as Command[]) {
      const sequences = overrides[command];
      if (sequences !== undefined) merged[command] = sequences;
    }
  }
  return merged;
}

export function validateApplicationKeyConfig(
  config: ApplicationKeyConfig,
): void {
  if (Array.from(config.leaderKey).length !== 1) {
    throw new Error("Leader key must be exactly one character");
  }
  validateBindingRecord(
    config.sharedNavigationBindings ??
      DEFAULT_APPLICATION_KEY_CONFIG.sharedNavigationBindings!,
    new Set(SHARED_NAVIGATION_COMMAND_IDS),
    "shared navigation",
  );
  validateBindingRecord(
    config.treeBindings ?? DEFAULT_APPLICATION_KEY_CONFIG.treeBindings!,
    new Set(TREE_SPECIFIC_COMMAND_IDS),
    "Tree",
  );
  validateBindingRecord(
    config.inlineFormatBindings ??
      DEFAULT_APPLICATION_KEY_CONFIG.inlineFormatBindings!,
    new Set(INLINE_FORMAT_COMMAND_IDS),
    "Visual inline format",
  );
  const effectiveTree = [
    ...Object.entries(
      config.sharedNavigationBindings ??
        DEFAULT_APPLICATION_KEY_CONFIG.sharedNavigationBindings!,
    ),
    ...Object.entries(
      config.treeBindings ?? DEFAULT_APPLICATION_KEY_CONFIG.treeBindings!,
    ),
  ].flatMap(([command, sequences]) =>
    sequences.map((sequence) => ({
      command,
      sequence,
      keys: sequenceKeys(sequence),
    })),
  );
  for (let left = 0; left < effectiveTree.length; left += 1) {
    for (let right = left + 1; right < effectiveTree.length; right += 1) {
      const a = effectiveTree[left]!;
      const b = effectiveTree[right]!;
      if (
        a.sequence === b.sequence ||
        isPrefix(a.keys, b.keys) ||
        isPrefix(b.keys, a.keys)
      ) {
        throw new Error(
          `Ambiguous Tree key bindings: ${a.command}:${a.sequence} and ${b.command}:${b.sequence}`,
        );
      }
    }
  }
  for (const binding of effectiveTree) {
    if (conflictsWithApplicationSidebar(binding.keys)) {
      throw new Error(
        `Tree key binding is reserved by the application: ${binding.command}:${binding.sequence}`,
      );
    }
  }
}

function conflictsWithApplicationSidebar(keys: readonly string[]): boolean {
  const first = keys[0];
  if (!first) return false;
  if (first === ":" || first === "t") return true;
  if (first === "g") {
    return keys.length === 1 || keys[1] === "t" || keys[1] === "T";
  }
  return [
    "Ctrl+c",
    "Ctrl+h",
    "Ctrl+j",
    "Ctrl+k",
    "Ctrl+l",
    "Ctrl+o",
    "Ctrl+w",
  ].includes(first);
}

function validateBindingRecord<Command extends string>(
  bindings: Readonly<Record<Command, readonly string[]>>,
  commands: ReadonlySet<string>,
  label: string,
): void {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error(`${label} key bindings must be an object`);
  }
  for (const [command, sequences] of Object.entries(bindings)) {
    if (!commands.has(command))
      throw new Error(`Unknown keymap command: ${command}`);
    if (!Array.isArray(sequences)) {
      throw new Error(`Key bindings for ${command} must be an array`);
    }
    const seen = new Set<string>();
    for (const sequence of sequences) {
      if (typeof sequence !== "string" || sequenceKeys(sequence).length === 0) {
        throw new Error(`Invalid key sequence for ${command}`);
      }
      if (seen.has(sequence)) {
        throw new Error(`Duplicate key sequence for ${command}: ${sequence}`);
      }
      seen.add(sequence);
    }
  }
}

function sequenceKeys(sequence: string): string[] {
  const tokens = sequence.trim().split(/\s+/u).filter(Boolean);
  const keys: string[] = [];
  for (const token of tokens) {
    if (
      /^Ctrl\+[a-z]$/u.test(token) ||
      ["Enter", "Escape", "Space", "Tab"].includes(token)
    ) {
      keys.push(token);
    } else if (/^[^\s]+$/u.test(token) && !token.includes("+")) {
      keys.push(...Array.from(token));
    } else {
      throw new Error(`Invalid key sequence: ${sequence}`);
    }
  }
  return keys;
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length < right.length &&
    left.every((value, index) => right[index] === value)
  );
}
