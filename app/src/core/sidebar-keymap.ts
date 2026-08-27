import { DeclarativeKeymap } from "./keymap";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  validateApplicationKeyConfig,
  type ApplicationKeyConfig,
} from "./application-key-config";

export type SidebarCommandId =
  | "application.command_line"
  | "workspace.search_title"
  | "workspace.search_body"
  | "workspace.search_buffers"
  | "utility.toggle-tree"
  | "utility.toggle-outline"
  | "sidebar.close"
  | "window.focus-left"
  | "window.focus-down"
  | "window.focus-up"
  | "window.focus-right"
  | "tab.create"
  | "tab.close"
  | "tab.next"
  | "tab.previous";

export const SIDEBAR_COMMAND_IDS: readonly SidebarCommandId[] = [
  "application.command_line",
  "workspace.search_title",
  "workspace.search_body",
  "workspace.search_buffers",
  "utility.toggle-tree",
  "utility.toggle-outline",
  "sidebar.close",
  "window.focus-left",
  "window.focus-down",
  "window.focus-up",
  "window.focus-right",
  "tab.create",
  "tab.close",
  "tab.next",
  "tab.previous",
];

export const sidebarKeymap = new DeclarativeKeymap<
  "sidebar.normal",
  SidebarCommandId
>(
  [
    {
      context: "sidebar.normal",
      sequence: ":",
      command: "application.command_line",
    },
    {
      context: "sidebar.normal",
      sequence: "Leader f",
      command: "workspace.search_title",
    },
    {
      context: "sidebar.normal",
      sequence: "Leader g",
      command: "workspace.search_body",
    },
    {
      context: "sidebar.normal",
      sequence: "Leader t",
      command: "utility.toggle-tree",
    },
    {
      context: "sidebar.normal",
      sequence: "Leader o",
      command: "utility.toggle-outline",
    },
    {
      context: "sidebar.normal",
      sequence: "Leader b",
      command: "workspace.search_buffers",
    },
    {
      context: "sidebar.normal",
      sequence: "Ctrl+w h",
      command: "window.focus-left",
    },
    {
      context: "sidebar.normal",
      sequence: "Ctrl+w j",
      command: "window.focus-down",
    },
    {
      context: "sidebar.normal",
      sequence: "Ctrl+w k",
      command: "window.focus-up",
    },
    {
      context: "sidebar.normal",
      sequence: "Ctrl+w l",
      command: "window.focus-right",
    },
    {
      context: "sidebar.normal",
      sequence: "Ctrl+w c",
      command: "sidebar.close",
    },
    {
      context: "sidebar.normal",
      sequence: "gt",
      command: "tab.next",
    },
    {
      context: "sidebar.normal",
      sequence: "gT",
      command: "tab.previous",
    },
    {
      context: "sidebar.normal",
      sequence: "tc",
      command: "tab.create",
    },
    {
      context: "sidebar.normal",
      sequence: "tn",
      command: "tab.next",
    },
    {
      context: "sidebar.normal",
      sequence: "tp",
      command: "tab.previous",
    },
    {
      context: "sidebar.normal",
      sequence: "td",
      command: "tab.close",
    },
  ],
  SIDEBAR_COMMAND_IDS,
);

export interface SidebarInputState {
  readonly pending: "g" | "tab" | "leader" | "window" | null;
}

export type SidebarInputAction =
  | { readonly kind: "execute"; readonly command: SidebarCommandId }
  | {
      readonly kind: "pending";
      readonly prefix: "g" | "tab" | "leader" | "window";
    }
  | { readonly kind: "cancel" }
  | { readonly kind: "unmapped" };

export interface SidebarInputResolution {
  readonly state: SidebarInputState;
  readonly action: SidebarInputAction;
  readonly consume: boolean;
}

export interface SidebarKeyInput {
  readonly key: string;
  readonly code?: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
}

const modifierOnlyKeys = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);
const modifierOnlyCode = /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/u;

export function createSidebarInputState(): SidebarInputState {
  return { pending: null };
}

export function sidebarKeySequence(event: SidebarKeyInput): string | null {
  if (event.isComposing || event.altKey || event.metaKey) return null;
  if (event.ctrlKey) {
    const codeKey = event.code?.match(/^Key([CHJKLOW])$/u)?.[1];
    const key = (codeKey ?? event.key).toLocaleLowerCase();
    return ["c", "h", "j", "k", "l", "o", "w"].includes(key)
      ? `Ctrl+${key}`
      : null;
  }
  return event.key;
}

function idleResolution(
  key: string,
  keyConfig: ApplicationKeyConfig,
): SidebarInputResolution {
  if (key === keyConfig.leaderKey) {
    return {
      state: { pending: "leader" },
      action: { kind: "pending", prefix: "leader" },
      consume: true,
    };
  }
  if (key === "Ctrl+w") {
    return {
      state: { pending: "window" },
      action: { kind: "pending", prefix: "window" },
      consume: true,
    };
  }
  const command = sidebarKeymap.resolve("sidebar.normal", key);
  if (command) {
    return {
      state: createSidebarInputState(),
      action: { kind: "execute", command },
      consume: true,
    };
  }
  if (key === "g") {
    return {
      state: { pending: "g" },
      action: { kind: "pending", prefix: "g" },
      // Tree also owns `gg`. Keep the application prefix alive for gt/gT,
      // while allowing the utility parser to observe the same first key.
      consume: false,
    };
  }
  if (key === "t") {
    return {
      state: { pending: "tab" },
      action: { kind: "pending", prefix: "tab" },
      consume: true,
    };
  }
  // A modified key that is not an Application binding must not be replayed as
  // the utility's unmodified key. In particular, an obsolete direct Ctrl-l
  // must never reach the focused utility as an unmodified key on WebKitGTK.
  if (key.startsWith("Ctrl+")) {
    return {
      state: createSidebarInputState(),
      action: { kind: "unmapped" },
      consume: true,
    };
  }
  return {
    state: createSidebarInputState(),
    action: { kind: "unmapped" },
    consume: false,
  };
}

export function advanceSidebarInput(
  state: SidebarInputState,
  event: SidebarKeyInput,
  keyConfig: ApplicationKeyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
): SidebarInputResolution {
  validateApplicationKeyConfig(keyConfig);
  if (
    modifierOnlyKeys.has(event.key) ||
    modifierOnlyCode.test(event.code ?? "")
  ) {
    return {
      state,
      action: { kind: "unmapped" },
      consume: false,
    };
  }
  const key = sidebarKeySequence(event);
  if (!key) {
    return {
      state: createSidebarInputState(),
      action: { kind: "unmapped" },
      consume: false,
    };
  }
  if (!state.pending) return idleResolution(key, keyConfig);
  if (key === "Escape") {
    return {
      state: createSidebarInputState(),
      action: { kind: "cancel" },
      consume: true,
    };
  }
  const windowKey = key.startsWith("Ctrl+") ? key.slice("Ctrl+".length) : key;
  const sequence =
    state.pending === "g"
      ? `g${key}`
      : state.pending === "tab"
        ? `t${key}`
        : state.pending === "leader"
          ? `Leader ${key}`
          : `Ctrl+w ${windowKey}`;
  const command = sidebarKeymap.resolve("sidebar.normal", sequence);
  if (command) {
    return {
      state: createSidebarInputState(),
      action: { kind: "execute", command },
      consume: true,
    };
  }
  if (state.pending === "window") {
    return {
      state: createSidebarInputState(),
      action: { kind: "unmapped" },
      consume: true,
    };
  }
  if (state.pending === "g") {
    return {
      state: createSidebarInputState(),
      action: { kind: "unmapped" },
      consume: false,
    };
  }
  return idleResolution(key, keyConfig);
}
