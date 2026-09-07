/** Shared by Note, Image, Empty Windows and the Sidebar application keymap. */
export const WINDOW_SHORTCUTS = {
  s: "window.split-horizontal",
  v: "window.split-vertical",
  h: "window.focus-left",
  j: "window.focus-down",
  k: "window.focus-up",
  l: "window.focus-right",
  t: "window.focus-first",
  b: "window.focus-last",
  w: "window.focus-next",
  W: "window.focus-previous",
  p: "window.focus-recent",
  "+": "window.height-increase",
  "-": "window.height-decrease",
  "<": "window.width-decrease",
  ">": "window.width-increase",
  "=": "window.equalize",
  H: "window.move-left",
  L: "window.move-right",
  J: "window.move-down",
  K: "window.move-up",
  c: "window.close",
  o: "window.only",
} as const;

export type WindowShortcutCommand =
  (typeof WINDOW_SHORTCUTS)[keyof typeof WINDOW_SHORTCUTS];

export const WINDOW_SHORTCUT_COMMANDS = Object.values(WINDOW_SHORTCUTS);

export function windowShortcutCommand(
  key: string,
): WindowShortcutCommand | null {
  const unmodified = key.startsWith("Ctrl+") ? key.slice(5) : key;
  return WINDOW_SHORTCUTS[unmodified as keyof typeof WINDOW_SHORTCUTS] ?? null;
}

/** Shift must be retained: h/H and w/W have different meanings. */
export function windowShortcutKey(event: {
  key: string;
  code?: string;
  shiftKey?: boolean;
}): string {
  const letter = event.code?.match(/^Key([A-Z])$/u)?.[1];
  return letter
    ? event.shiftKey || /^[A-Z]$/u.test(event.key)
      ? letter
      : letter.toLowerCase()
    : event.key;
}
