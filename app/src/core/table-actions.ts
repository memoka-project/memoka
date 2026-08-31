import { normalizeWorkspaceSearchText } from "./workspace-search";

export const TABLE_ACTION_IDS = [
  "row.add_before",
  "row.add_after",
  "row.delete",
  "row.move_up",
  "row.move_down",
  "column.add_before",
  "column.add_after",
  "column.delete",
  "column.move_left",
  "column.move_right",
  "column.align_default",
  "column.align_left",
  "column.align_center",
  "column.align_right",
  "table.delete",
] as const;

export type TableActionId = (typeof TABLE_ACTION_IDS)[number];

export const TABLE_REPEATABLE_ACTION_IDS = [
  "row.add_before",
  "row.add_after",
  "column.add_before",
  "column.add_after",
] as const;

export type TableRepeatableActionId =
  (typeof TABLE_REPEATABLE_ACTION_IDS)[number];

export interface TableActionRepeat {
  readonly action: TableRepeatableActionId;
  readonly amount: number;
}

export function isTableRepeatableAction(
  action: TableActionId,
): action is TableRepeatableActionId {
  return (TABLE_REPEATABLE_ACTION_IDS as readonly TableActionId[]).includes(
    action,
  );
}

export interface TableActionCatalogEntry {
  readonly id: TableActionId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/** Best-first; SearchPane presents the first item nearest its input. */
export const TABLE_ACTION_CATALOG: readonly TableActionCatalogEntry[] = [
  {
    id: "row.add_after",
    name: "行を下に追加",
    aliases: ["row", "add", "below", "行", "追加", "下"],
    description: "対象範囲と同じ行数を、対象行の直後に追加します。",
  },
  {
    id: "row.add_before",
    name: "行を上に追加",
    aliases: ["row", "add", "above", "行", "追加", "上"],
    description: "対象範囲と同じ行数を、対象行の直前に追加します。",
  },
  {
    id: "column.add_after",
    name: "列を右に追加",
    aliases: ["column", "add", "right", "列", "追加", "右"],
    description: "対象範囲と同じ列数を、対象列の直後に追加します。",
  },
  {
    id: "column.add_before",
    name: "列を左に追加",
    aliases: ["column", "add", "left", "列", "追加", "左"],
    description: "対象範囲と同じ列数を、対象列の直前に追加します。",
  },
  {
    id: "row.delete",
    name: "行を削除",
    aliases: ["row", "delete", "remove", "行", "削除"],
    description: "対象行をまとめて削除します。",
  },
  {
    id: "column.delete",
    name: "列を削除",
    aliases: ["column", "delete", "remove", "列", "削除"],
    description: "対象列をまとめて削除します。",
  },
  {
    id: "row.move_up",
    name: "行を上へ移動",
    aliases: ["row", "move", "up", "行", "移動", "上"],
    description: "対象行の順序を保ったまま1行上へ移動します。",
  },
  {
    id: "row.move_down",
    name: "行を下へ移動",
    aliases: ["row", "move", "down", "行", "移動", "下"],
    description: "対象行の順序を保ったまま1行下へ移動します。",
  },
  {
    id: "column.move_left",
    name: "列を左へ移動",
    aliases: ["column", "move", "left", "列", "移動", "左"],
    description: "対象列の順序を保ったまま1列左へ移動します。",
  },
  {
    id: "column.move_right",
    name: "列を右へ移動",
    aliases: ["column", "move", "right", "列", "移動", "右"],
    description: "対象列の順序を保ったまま1列右へ移動します。",
  },
  {
    id: "column.align_default",
    name: "列の揃えを既定に戻す",
    aliases: ["align", "default", "column", "揃え", "既定", "列"],
    description: "対象列のMarkdown alignment指定を解除します。",
  },
  {
    id: "column.align_left",
    name: "列を左揃え",
    aliases: ["align", "left", "column", "揃え", "左", "列"],
    description: "対象列を左揃えにします。",
  },
  {
    id: "column.align_center",
    name: "列を中央揃え",
    aliases: ["align", "center", "column", "揃え", "中央", "列"],
    description: "対象列を中央揃えにします。",
  },
  {
    id: "column.align_right",
    name: "列を右揃え",
    aliases: ["align", "right", "column", "揃え", "右", "列"],
    description: "対象列を右揃えにします。",
  },
  {
    id: "table.delete",
    name: "Tableを削除",
    aliases: ["table", "delete", "remove", "表", "削除"],
    description: "Table全体を削除します。",
  },
];

export function filterTableActionCatalog(
  query: string,
): readonly TableActionCatalogEntry[] {
  const terms = normalizeWorkspaceSearchText(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return TABLE_ACTION_CATALOG;
  return TABLE_ACTION_CATALOG.filter((entry) => {
    const searchable = normalizeWorkspaceSearchText(
      [entry.name, ...entry.aliases, entry.description].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });
}
