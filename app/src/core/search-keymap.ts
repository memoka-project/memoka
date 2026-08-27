import { DeclarativeKeymap } from "./keymap";

export type SearchKeymapContext = "search.insert" | "search.trash";

export type SearchCommandId =
  | "search.select_next"
  | "search.select_previous"
  | "search.accept"
  | "search.restore"
  | "search.ignore"
  | "search.close";

export const SEARCH_COMMAND_IDS: readonly SearchCommandId[] = [
  "search.select_next",
  "search.select_previous",
  "search.accept",
  "search.restore",
  "search.ignore",
  "search.close",
];

export const searchKeymap = new DeclarativeKeymap<
  SearchKeymapContext,
  SearchCommandId
>(
  [
    {
      context: "search.insert",
      sequence: "ArrowDown",
      command: "search.select_next",
    },
    {
      context: "search.insert",
      sequence: "Ctrl+n",
      command: "search.select_next",
    },
    {
      context: "search.insert",
      sequence: "ArrowUp",
      command: "search.select_previous",
    },
    {
      context: "search.insert",
      sequence: "Ctrl+p",
      command: "search.select_previous",
    },
    {
      context: "search.insert",
      sequence: "Enter",
      command: "search.accept",
    },
    {
      context: "search.insert",
      sequence: "Tab",
      command: "search.accept",
    },
    {
      context: "search.insert",
      sequence: "Escape",
      command: "search.close",
    },
    {
      context: "search.insert",
      sequence: "Ctrl+c",
      command: "search.close",
    },
    {
      context: "search.trash",
      sequence: "ArrowDown",
      command: "search.select_next",
    },
    {
      context: "search.trash",
      sequence: "Ctrl+n",
      command: "search.select_next",
    },
    {
      context: "search.trash",
      sequence: "ArrowUp",
      command: "search.select_previous",
    },
    {
      context: "search.trash",
      sequence: "Ctrl+p",
      command: "search.select_previous",
    },
    {
      context: "search.trash",
      sequence: "r",
      command: "search.restore",
    },
    {
      context: "search.trash",
      sequence: "Enter",
      command: "search.ignore",
    },
    {
      context: "search.trash",
      sequence: "Tab",
      command: "search.ignore",
    },
    {
      context: "search.trash",
      sequence: "Escape",
      command: "search.close",
    },
    {
      context: "search.trash",
      sequence: "Ctrl+c",
      command: "search.close",
    },
  ],
  SEARCH_COMMAND_IDS,
);

export function searchKeySequence(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): string | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    const key = event.key.toLocaleLowerCase();
    return key === "c" || key === "n" || key === "p" ? `Ctrl+${key}` : null;
  }
  return event.key;
}
