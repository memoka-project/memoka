import { DeclarativeKeymap } from "./keymap";

export type OutlineKeymapContext = "outline.normal";
export type OutlineCommandId =
  | "outline.select_next"
  | "outline.select_previous"
  | "outline.jump"
  | "outline.close";

export const OUTLINE_COMMAND_IDS: readonly OutlineCommandId[] = [
  "outline.select_next",
  "outline.select_previous",
  "outline.jump",
  "outline.close",
];

export const outlineKeymap = new DeclarativeKeymap<
  OutlineKeymapContext,
  OutlineCommandId
>(
  [
    {
      context: "outline.normal",
      sequence: "j",
      command: "outline.select_next",
    },
    {
      context: "outline.normal",
      sequence: "k",
      command: "outline.select_previous",
    },
    { context: "outline.normal", sequence: "Enter", command: "outline.jump" },
    {
      context: "outline.normal",
      sequence: "Escape",
      command: "outline.close",
    },
  ],
  OUTLINE_COMMAND_IDS,
);

export function outlineKeySequence(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): string | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  return event.key;
}
