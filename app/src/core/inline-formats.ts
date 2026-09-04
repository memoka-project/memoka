import { normalizeWorkspaceSearchText } from "./workspace-search";

export const INLINE_FORMAT_IDS = [
  "italic",
  "bold",
  "strike",
  "code",
  "highlight",
  "link",
  "clear",
] as const;

export type InlineFormatId = (typeof INLINE_FORMAT_IDS)[number];
export type InlineMarkFormat = Exclude<InlineFormatId, "link" | "clear">;

export type InlineFormatAction =
  | { readonly kind: "apply"; readonly format: InlineMarkFormat }
  | { readonly kind: "link"; readonly href: string }
  | { readonly kind: "clear" };

export interface InlineFormatCatalogEntry {
  readonly id: InlineFormatId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly example: string;
}

/** Best-first; SearchPane places the first item nearest its input. */
export const INLINE_FORMAT_CATALOG: readonly InlineFormatCatalogEntry[] = [
  {
    id: "italic",
    name: "斜体",
    aliases: ["italic", "emphasis", "イタリック", "強調"],
    description: "選択した文字を斜体にします。",
    example: "斜体のテキスト",
  },
  {
    id: "bold",
    name: "太字",
    aliases: ["bold", "strong", "ボールド", "強調"],
    description: "選択した文字を太字にします。",
    example: "太字のテキスト",
  },
  {
    id: "strike",
    name: "打ち消し",
    aliases: ["strike", "strikethrough", "取消", "取り消し線"],
    description: "選択した文字へ打ち消し線を付けます。",
    example: "打ち消したテキスト",
  },
  {
    id: "code",
    name: "コード",
    aliases: ["code", "inline code", "等幅", "インラインコード"],
    description: "選択した文字をインラインコードにします。",
    example: "inline_code()",
  },
  {
    id: "highlight",
    name: "ハイライト",
    aliases: ["highlight", "mark", "marker", "蛍光ペン", "マーカー"],
    description: "選択した文字へハイライトを付けます。",
    example: "ハイライトしたテキスト",
  },
  {
    id: "link",
    name: "リンク",
    aliases: ["link", "url", "href", "外部リンク"],
    description: "選択した文字へ外部URLを設定します。",
    example: "Memoka website",
  },
  {
    id: "clear",
    name: "全装飾を解除",
    aliases: ["clear", "remove", "reset", "書式解除", "装飾解除"],
    description: "対応している文字装飾と外部リンクをすべて外します。",
    example: "プレーンテキスト",
  },
];

export function filterInlineFormatCatalog(
  query: string,
): readonly InlineFormatCatalogEntry[] {
  const terms = normalizeWorkspaceSearchText(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return INLINE_FORMAT_CATALOG;
  return INLINE_FORMAT_CATALOG.filter((entry) => {
    const searchable = normalizeWorkspaceSearchText(
      [entry.name, ...entry.aliases, entry.description].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });
}
