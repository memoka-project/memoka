import { normalizeWorkspaceSearchText } from "./workspace-search";

export const BLOCK_TRANSFORM_TARGETS = [
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "table",
  "sourceBlock",
  "image",
] as const;

export type BlockTransformTarget = (typeof BLOCK_TRANSFORM_TARGETS)[number];

export interface TableDimensions {
  readonly rows: number;
  readonly columns: number;
}

export type BlockTypePickerTarget = BlockTransformTarget | "attachment";

export interface BlockTypeCatalogEntry {
  readonly id: BlockTypePickerTarget;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly example: string;
}

/**
 * Best-first order. Search panes render best-first entries from the bottom,
 * therefore Paragraph is the initial selection nearest the query input.
 */
export const BLOCK_TYPE_CATALOG: readonly BlockTypeCatalogEntry[] = [
  {
    id: "paragraph",
    name: "Paragraph",
    aliases: ["paragraph", "text", "本文", "段落", "テキスト"],
    description: "通常の本文ブロックに変更します。",
    example: "自由な文章を書きます。",
  },
  {
    id: "bulletList",
    name: "Bullet List",
    aliases: ["bullet", "unordered", "list", "箇条書き", "リスト"],
    description: "箇条書きリストに変更します。",
    example: "• 項目",
  },
  {
    id: "orderedList",
    name: "Numbered List",
    aliases: ["numbered", "ordered", "list", "番号", "番号付きリスト"],
    description: "番号付きリストに変更します。",
    example: "1. 項目",
  },
  {
    id: "codeBlock",
    name: "Code Block",
    aliases: ["code", "program", "コード", "コードブロック"],
    description: "プレーンテキストのコードブロックに変更します。",
    example: "const value = 1;",
  },
  {
    id: "table",
    name: "Table",
    aliases: ["table", "grid", "表", "テーブル"],
    description: "行数と列数を選んで表を作成します。先頭行は見出しです。",
    example: "| 見出し | 見出し | 見出し |",
  },
  {
    id: "sourceBlock",
    name: "Source Block",
    aliases: ["source", "markdown", "raw", "ソース", "マークダウン"],
    description: "Markdownソースをそのまま扱うブロックに変更します。",
    example: "**Markdown source**",
  },
  {
    id: "image",
    name: "Image Block stub",
    aliases: ["image", "picture", "画像"],
    description: "画像未設定のImage Block stubを作成します。",
    example: "[ Image Block stub ]",
  },
  {
    id: "attachment",
    name: "Attachment File",
    aliases: ["attachment", "file", "添付", "ファイル"],
    description: "ファイルを選択し、画像または添付ブロックとして挿入します。",
    example: "📎 document.pdf",
  },
];

export function filterBlockTypeCatalog(
  query: string,
): readonly BlockTypeCatalogEntry[] {
  const terms = normalizeWorkspaceSearchText(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return BLOCK_TYPE_CATALOG;
  return BLOCK_TYPE_CATALOG.filter((entry) => {
    const searchable = normalizeWorkspaceSearchText(
      [entry.name, ...entry.aliases, entry.description].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });
}
