export type LeaderShortcutSurface = "editor" | "sidebar" | "empty-window";

export type LeaderShortcutId =
  | "context-actions"
  | "buffers"
  | "commands"
  | "settings"
  | "title-search"
  | "body-search"
  | "history"
  | "links"
  | "note-actions"
  | "outline"
  | "paste"
  | "note-search"
  | "tree"
  | "view"
  | "workspace"
  | "yank"
  | "help";

export type LeaderActiveCommandId =
  | "context.action_picker"
  | "workspace.search_buffers"
  | "application.command_picker"
  | "workspace.search_title"
  | "workspace.search_body"
  | "utility.toggle-outline"
  | "note.search"
  | "utility.toggle-tree";

interface LeaderShortcutBase {
  readonly id: LeaderShortcutId;
  /** The fixed, case-sensitive key following the configurable Leader key. */
  readonly key: string;
  readonly label: string;
  readonly surfaces: readonly LeaderShortcutSurface[];
}

export interface ActiveLeaderShortcut extends LeaderShortcutBase {
  readonly status: "active";
  readonly command: LeaderActiveCommandId;
}

export interface ReservedLeaderShortcut extends LeaderShortcutBase {
  readonly status: "reserved";
}

export type LeaderShortcut = ActiveLeaderShortcut | ReservedLeaderShortcut;

const ALL_SURFACES = [
  "editor",
  "sidebar",
  "empty-window",
] as const satisfies readonly LeaderShortcutSurface[];

/**
 * Stable application-owned Leader namespace. Only the physical Leader key is
 * configurable; category keys are deliberately fixed for Help, plugins, and
 * configuration portability.
 */
export const LEADER_SHORTCUT_CATALOG: readonly LeaderShortcut[] = [
  {
    id: "context-actions",
    key: "a",
    label: "Context Actions",
    status: "active",
    command: "context.action_picker",
    surfaces: ["editor"],
  },
  {
    id: "buffers",
    key: "b",
    label: "Buffer Search",
    status: "active",
    command: "workspace.search_buffers",
    surfaces: ALL_SURFACES,
  },
  {
    id: "commands",
    key: "c",
    label: "Command Picker",
    status: "active",
    command: "application.command_picker",
    surfaces: ALL_SURFACES,
  },
  {
    id: "settings",
    key: "C",
    label: "Config / Settings",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "title-search",
    key: "f",
    label: "Title Search",
    status: "active",
    command: "workspace.search_title",
    surfaces: ALL_SURFACES,
  },
  {
    id: "body-search",
    key: "g",
    label: "Body Search",
    status: "active",
    command: "workspace.search_body",
    surfaces: ALL_SURFACES,
  },
  {
    id: "history",
    key: "h",
    label: "History / Recent / Jump",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "links",
    key: "l",
    label: "Links / Backlinks",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "note-actions",
    key: "n",
    label: "Note Actions",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "outline",
    key: "o",
    label: "Outline",
    status: "active",
    command: "utility.toggle-outline",
    surfaces: ALL_SURFACES,
  },
  {
    id: "paste",
    key: "p",
    label: "Paste / Yank History",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "note-search",
    key: "s",
    label: "Note Search",
    status: "active",
    command: "note.search",
    surfaces: ["editor", "sidebar"],
  },
  {
    id: "tree",
    key: "t",
    label: "Tree",
    status: "active",
    command: "utility.toggle-tree",
    surfaces: ALL_SURFACES,
  },
  {
    id: "view",
    key: "v",
    label: "View / Window Layout",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "workspace",
    key: "w",
    label: "Workspace",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "yank",
    key: "y",
    label: "Yank / Export",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
  {
    id: "help",
    key: "?",
    label: "Help / Diagnostics",
    status: "reserved",
    surfaces: ALL_SURFACES,
  },
] as const;

export type LeaderShortcutResolution =
  | {
      readonly kind: "execute";
      readonly shortcut: ActiveLeaderShortcut;
      readonly command: LeaderActiveCommandId;
    }
  | {
      readonly kind: "reserved";
      readonly shortcut: ReservedLeaderShortcut;
    }
  | {
      readonly kind: "unavailable";
      readonly shortcut: ActiveLeaderShortcut;
    }
  | { readonly kind: "unmapped"; readonly key: string };

export function resolveLeaderShortcut(
  key: string,
  surface: LeaderShortcutSurface,
): LeaderShortcutResolution {
  const shortcut = LEADER_SHORTCUT_CATALOG.find(
    (candidate) => candidate.key === key,
  );
  if (!shortcut) return { kind: "unmapped", key };
  if (shortcut.status === "reserved") return { kind: "reserved", shortcut };
  if (!shortcut.surfaces.includes(surface)) {
    return { kind: "unavailable", shortcut };
  }
  return { kind: "execute", shortcut, command: shortcut.command };
}

export function leaderShortcutMessage(
  resolution: Exclude<LeaderShortcutResolution, { kind: "execute" }>,
  leaderKey: string,
): string {
  if (resolution.kind === "unmapped") {
    return `${leaderKey}${resolution.key} · 未割当`;
  }
  const binding = `${leaderKey}${resolution.shortcut.key}`;
  return resolution.kind === "reserved"
    ? `${binding} · ${resolution.shortcut.label} · 予約済み（未実装）`
    : `${binding} · ${resolution.shortcut.label} · この画面では利用できません`;
}

export function leaderShortcutForCommand(
  command: LeaderActiveCommandId,
): ActiveLeaderShortcut {
  const shortcut = LEADER_SHORTCUT_CATALOG.find(
    (candidate) =>
      candidate.status === "active" && candidate.command === command,
  );
  if (!shortcut || shortcut.status !== "active") {
    throw new Error(`Unknown Leader command: ${command}`);
  }
  return shortcut;
}

export function isLeaderActiveCommand(
  command: string,
): command is LeaderActiveCommandId {
  return LEADER_SHORTCUT_CATALOG.some(
    (shortcut) => shortcut.status === "active" && shortcut.command === command,
  );
}
