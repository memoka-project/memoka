export const SIDEBAR_FOLD_BINDINGS = {
  "fold.open": "zo",
  "fold.close": "zc",
  "fold.toggle": "za",
  "fold.open-recursive": "zO",
  "fold.close-recursive": "zC",
  "fold.toggle-recursive": "zA",
} as const;

export type SidebarFoldCommand = keyof typeof SIDEBAR_FOLD_BINDINGS;

/** Note Root is never folded: operate on its children, or all Sections. */
export function foldNoteRootSections(
  entries: readonly { id: string; depth: number }[],
  noteId: string,
  collapsedIds: readonly string[],
  action: string,
): string[] {
  const next = new Set(collapsedIds.filter((id) => id !== noteId));
  if (action.startsWith("toggle")) return [...next].sort();
  for (const entry of entries) {
    if (
      entry.id === noteId ||
      (!action.endsWith("recursive") && entry.depth !== 1)
    )
      continue;
    if (action.startsWith("close")) next.add(entry.id);
    else if (action.startsWith("open")) next.delete(entry.id);
  }
  return [...next].sort();
}

export function isSidebarFoldCommand(
  command: string,
): command is SidebarFoldCommand {
  return Object.hasOwn(SIDEBAR_FOLD_BINDINGS, command);
}

/** The complete preorder includes hidden descendants for recursive operations. */
export function foldSidebarSubtree(
  entries: readonly { id: string; depth: number; foldable: boolean }[],
  selectedId: string,
  collapsedIds: readonly string[],
  command: SidebarFoldCommand,
): string[] {
  const index = entries.findIndex((entry) => entry.id === selectedId);
  const selected = entries[index];
  if (!selected?.foldable) return [...collapsedIds];
  const next = new Set(collapsedIds);
  const close =
    command.startsWith("fold.close") ||
    (command.startsWith("fold.toggle") && !next.has(selectedId));
  const recursive = command.endsWith("-recursive");
  for (let i = index; i < entries.length; i++) {
    const entry = entries[i];
    if (i > index && (!recursive || entry.depth <= selected.depth)) break;
    if (!entry.foldable) continue;
    if (close) next.add(entry.id);
    else next.delete(entry.id);
  }
  return [...next].sort();
}
