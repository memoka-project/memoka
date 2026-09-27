import { DeclarativeKeymap } from "./keymap";

export type CommandLineKeymapContext = "command-line.insert";

export type CommandLineCommandId =
  | "command-line.execute"
  | "command-line.close"
  | "command-line.keep_focus"
  | "command-line.history_older_prefix"
  | "command-line.history_newer_prefix"
  | "command-line.history_older"
  | "command-line.history_newer";

export const COMMAND_LINE_COMMAND_IDS: readonly CommandLineCommandId[] = [
  "command-line.execute",
  "command-line.close",
  "command-line.keep_focus",
  "command-line.history_older_prefix",
  "command-line.history_newer_prefix",
  "command-line.history_older",
  "command-line.history_newer",
];

export const commandLineKeymap = new DeclarativeKeymap<
  CommandLineKeymapContext,
  CommandLineCommandId
>(
  [
    {
      context: "command-line.insert",
      sequence: "Enter",
      command: "command-line.execute",
    },
    {
      context: "command-line.insert",
      sequence: "Escape",
      command: "command-line.close",
    },
    {
      context: "command-line.insert",
      sequence: "Ctrl+c",
      command: "command-line.close",
    },
    {
      context: "command-line.insert",
      sequence: "Tab",
      command: "command-line.keep_focus",
    },
    {
      context: "command-line.insert",
      sequence: "ArrowUp",
      command: "command-line.history_older_prefix",
    },
    {
      context: "command-line.insert",
      sequence: "ArrowDown",
      command: "command-line.history_newer_prefix",
    },
    {
      context: "command-line.insert",
      sequence: "Ctrl+p",
      command: "command-line.history_older",
    },
    {
      context: "command-line.insert",
      sequence: "Ctrl+n",
      command: "command-line.history_newer",
    },
  ],
  COMMAND_LINE_COMMAND_IDS,
);

export function commandLineKeySequence(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): string | null {
  if (event.altKey || event.metaKey) return null;
  return event.ctrlKey ? `Ctrl+${event.key.toLocaleLowerCase()}` : event.key;
}
