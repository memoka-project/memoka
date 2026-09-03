export const TAB_SHORTCUT_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
] as const;

export type TabShortcutKey = (typeof TAB_SHORTCUT_KEYS)[number];
export type TabDirectCommandId = `tab.select-${TabShortcutKey}`;

export const TAB_DIRECT_COMMAND_IDS: readonly TabDirectCommandId[] =
  Object.freeze(
    TAB_SHORTCUT_KEYS.map((key): TabDirectCommandId => `tab.select-${key}`),
  );

export function tabShortcutKeyAtIndex(index: number): TabShortcutKey | null {
  return Number.isInteger(index) && index >= 0
    ? (TAB_SHORTCUT_KEYS[index] ?? null)
    : null;
}

export function tabDirectCommandForKey(key: string): TabDirectCommandId | null {
  return isTabShortcutKey(key) ? `tab.select-${key}` : null;
}

export function isTabDirectCommand(
  command: string,
): command is TabDirectCommandId {
  return TAB_DIRECT_COMMAND_IDS.includes(command as TabDirectCommandId);
}

export function tabIndexForDirectCommand(command: TabDirectCommandId): number {
  return TAB_SHORTCUT_KEYS.indexOf(
    command.slice("tab.select-".length) as TabShortcutKey,
  );
}

function isTabShortcutKey(key: string): key is TabShortcutKey {
  return TAB_SHORTCUT_KEYS.includes(key as TabShortcutKey);
}
