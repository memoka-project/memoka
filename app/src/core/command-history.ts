export const COMMAND_HISTORY_LIMIT = 200;
export const COMMAND_HISTORY_MAX_LENGTH = 4096;

export function readCommandHistory(value: unknown): readonly string[] {
  if (!value || typeof value !== "object") return [];
  const source = value as { schemaVersion?: unknown; entries?: unknown };
  if (source.schemaVersion !== 1 || !Array.isArray(source.entries)) return [];
  return [
    ...new Set(
      source.entries.filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.trim().length > 0 &&
          entry.length <= COMMAND_HISTORY_MAX_LENGTH &&
          !/[\r\n\0]/u.test(entry),
      ),
    ),
  ].slice(0, COMMAND_HISTORY_LIMIT);
}

export function recordCommandHistory(
  entries: readonly string[],
  value: string,
): readonly string[] {
  if (
    !value.trim() ||
    value.length > COMMAND_HISTORY_MAX_LENGTH ||
    /[\r\n\0]/u.test(value)
  ) {
    return entries;
  }
  return [value, ...entries.filter((entry) => entry !== value)].slice(
    0,
    COMMAND_HISTORY_LIMIT,
  );
}

export interface CommandHistoryBrowse {
  readonly draft: string;
  readonly draftSelectionStart: number;
  readonly draftSelectionEnd: number;
  readonly prefix: string;
  readonly index: number;
}

export function navigateCommandHistory(
  entries: readonly string[],
  value: string,
  selectionStart: number,
  selectionEnd: number,
  browse: CommandHistoryBrowse | null,
  direction: "older" | "newer",
  prefixOnly: boolean,
): { readonly value: string; readonly browse: CommandHistoryBrowse | null } {
  const current =
    browse ??
    ({
      draft: value,
      draftSelectionStart: selectionStart,
      draftSelectionEnd: selectionEnd,
      prefix: value.slice(0, selectionStart),
      index: -1,
    } satisfies CommandHistoryBrowse);
  if (direction === "older") {
    for (let index = current.index + 1; index < entries.length; index += 1) {
      if (prefixOnly && !entries[index]!.startsWith(current.prefix)) continue;
      return { value: entries[index]!, browse: { ...current, index } };
    }
    return { value, browse };
  }
  for (let index = current.index - 1; index >= 0; index -= 1) {
    if (prefixOnly && !entries[index]!.startsWith(current.prefix)) continue;
    return { value: entries[index]!, browse: { ...current, index } };
  }
  if (current.index >= 0) return { value: current.draft, browse: null };
  return { value, browse };
}
