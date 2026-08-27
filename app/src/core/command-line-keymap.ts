import { DeclarativeKeymap } from "./keymap";

export type CommandLineKeymapContext = "command-line.insert";

export type CommandLineCommandId =
  "command-line.execute" | "command-line.close";

export const COMMAND_LINE_COMMAND_IDS: readonly CommandLineCommandId[] = [
  "command-line.execute",
  "command-line.close",
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
