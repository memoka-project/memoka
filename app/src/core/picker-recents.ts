export const PICKER_RECENT_KINDS = [
  "command",
  "inline-format",
  "block-type",
  "alert-type",
  "symbol",
  "code-action",
  "code-language",
  "table-action",
  "theme",
  "font-ui",
  "font-japanese",
  "font-latin",
  "font-monospace",
] as const;

export type PickerRecentKind = (typeof PICKER_RECENT_KINDS)[number];
export type PickerRecents = Readonly<
  Partial<Record<PickerRecentKind, readonly string[]>>
>;
export const PICKER_RECENTS_LIMIT = 100;
export const EMPTY_PICKER_RECENTS: PickerRecents = Object.freeze({});

export function readPickerRecents(value: unknown): PickerRecents {
  if (!value || typeof value !== "object") return EMPTY_PICKER_RECENTS;
  const record = value as { schemaVersion?: unknown; recent?: unknown };
  if (
    record.schemaVersion !== 1 ||
    !record.recent ||
    typeof record.recent !== "object"
  ) {
    return EMPTY_PICKER_RECENTS;
  }
  const source = record.recent as Record<string, unknown>;
  const recent: Partial<Record<PickerRecentKind, readonly string[]>> = {};
  for (const kind of PICKER_RECENT_KINDS) {
    const ids = source[kind];
    if (!Array.isArray(ids)) continue;
    recent[kind] = [
      ...new Set(
        ids.filter(
          (id): id is string =>
            typeof id === "string" && id.length > 0 && id.length <= 512,
        ),
      ),
    ].slice(0, PICKER_RECENTS_LIMIT);
  }
  return recent;
}

export function recordPickerRecent(
  state: PickerRecents,
  kind: PickerRecentKind,
  id: string,
): PickerRecents {
  return {
    ...state,
    [kind]: [
      id,
      ...(state[kind] ?? []).filter((candidate) => candidate !== id),
    ].slice(0, PICKER_RECENTS_LIMIT),
  };
}

export function rankPickerItems<Item>(
  items: readonly Item[],
  kind: PickerRecentKind,
  state: PickerRecents,
  itemId: (item: Item) => string,
  priority?: (item: Item) => number,
): Item[] {
  const positions = new Map(
    (state[kind] ?? []).map((id, index) => [id, index]),
  );
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        (priority?.(right.item) ?? 0) - (priority?.(left.item) ?? 0) ||
        (positions.get(itemId(left.item)) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(itemId(right.item)) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
