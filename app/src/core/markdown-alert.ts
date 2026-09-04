import { normalizeWorkspaceSearchText } from "./workspace-search";

export type MarkdownAlertFold = "expanded" | "collapsed";

export interface MarkdownAlert {
  readonly type: string;
  readonly title: string | null;
  readonly fold: MarkdownAlertFold | null;
}

export interface MarkdownAlertTypeCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/**
 * Canonical creation presets. Markdown import deliberately accepts and
 * preserves the wider Obsidian alias/custom-type space, while the picker keeps
 * creation concise by grouping aliases under their canonical visual type.
 */
export const MARKDOWN_ALERT_TYPE_CATALOG: readonly MarkdownAlertTypeCatalogEntry[] =
  [
    {
      id: "note",
      name: "Note",
      aliases: ["note", "メモ", "注記"],
      description: "一般的な補足情報を示します。",
    },
    {
      id: "abstract",
      name: "Abstract",
      aliases: ["abstract", "summary", "tldr", "概要", "要約"],
      description: "概要や要約を示します（Summary / TL;DR）。",
    },
    {
      id: "info",
      name: "Info",
      aliases: ["info", "information", "情報"],
      description: "参照してほしい情報を示します。",
    },
    {
      id: "todo",
      name: "Todo",
      aliases: ["todo", "task", "タスク", "やること"],
      description: "未完了の作業を示します。",
    },
    {
      id: "tip",
      name: "Tip",
      aliases: ["tip", "hint", "ヒント", "コツ"],
      description: "役立つヒントやコツを示します。",
    },
    {
      id: "important",
      name: "Important",
      aliases: ["important", "重要"],
      description: "特に重要な情報を示します。",
    },
    {
      id: "success",
      name: "Success",
      aliases: ["success", "check", "done", "成功", "完了"],
      description: "成功または完了した内容を示します。",
    },
    {
      id: "question",
      name: "Question",
      aliases: ["question", "help", "faq", "質問", "ヘルプ"],
      description: "質問、ヘルプ、FAQを示します。",
    },
    {
      id: "warning",
      name: "Warning",
      aliases: ["warning", "attention", "警告", "注意"],
      description: "注意が必要な内容を示します。",
    },
    {
      id: "caution",
      name: "Caution",
      aliases: ["caution", "警告", "危険"],
      description: "GitHub形式の強い警告を示します。",
    },
    {
      id: "failure",
      name: "Failure",
      aliases: ["failure", "fail", "missing", "失敗", "不足"],
      description: "失敗または不足している内容を示します。",
    },
    {
      id: "danger",
      name: "Danger",
      aliases: ["danger", "error", "危険", "エラー"],
      description: "危険またはエラーを示します。",
    },
    {
      id: "bug",
      name: "Bug",
      aliases: ["bug", "不具合", "バグ"],
      description: "不具合に関する内容を示します。",
    },
    {
      id: "example",
      name: "Example",
      aliases: ["example", "sample", "例", "サンプル"],
      description: "例やサンプルを示します。",
    },
    {
      id: "quote",
      name: "Quote",
      aliases: ["quote", "cite", "引用", "出典"],
      description: "引用や出典を示します。",
    },
  ];

export function filterMarkdownAlertTypeCatalog(
  query: string,
): readonly MarkdownAlertTypeCatalogEntry[] {
  const terms = normalizeWorkspaceSearchText(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return MARKDOWN_ALERT_TYPE_CATALOG;
  return MARKDOWN_ALERT_TYPE_CATALOG.filter((entry) => {
    const searchable = normalizeWorkspaceSearchText(
      [entry.name, ...entry.aliases, entry.description].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });
}

const ALERT_TYPE = /^[a-z][a-z0-9_-]{0,63}$/u;
const ALERT_MARKER =
  /^\[!([A-Za-z][A-Za-z0-9_-]{0,63})\]([+-])?(?:[ \t]+(.+?))?[ \t]*$/u;
const GITHUB_ALERT_TYPES = new Set([
  "note",
  "tip",
  "important",
  "warning",
  "caution",
]);
const ALERT_LABELS: Readonly<Record<string, string>> = {
  note: "Note",
  abstract: "Abstract",
  summary: "Summary",
  tldr: "TL;DR",
  info: "Info",
  todo: "Todo",
  tip: "Tip",
  hint: "Hint",
  important: "Important",
  success: "Success",
  check: "Check",
  done: "Done",
  question: "Question",
  help: "Help",
  faq: "FAQ",
  warning: "Warning",
  caution: "Caution",
  attention: "Attention",
  failure: "Failure",
  fail: "Fail",
  missing: "Missing",
  danger: "Danger",
  error: "Error",
  bug: "Bug",
  example: "Example",
  quote: "Quote",
  cite: "Cite",
};

export function normalizeMarkdownAlertType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return ALERT_TYPE.test(normalized) ? normalized : null;
}

export function normalizeMarkdownAlertFold(
  value: unknown,
): MarkdownAlertFold | null {
  return value === "expanded" || value === "collapsed" ? value : null;
}

export function normalizeMarkdownAlertTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized || null;
}

export function parseMarkdownAlertMarker(value: string): MarkdownAlert | null {
  const match = value.match(ALERT_MARKER);
  const type = normalizeMarkdownAlertType(match?.[1]);
  if (!match || !type) return null;
  return {
    type,
    title: normalizeMarkdownAlertTitle(match[3]),
    fold: match[2] === "+" ? "expanded" : match[2] === "-" ? "collapsed" : null,
  };
}

export function markdownAlertLabel(attributes: {
  readonly alertType?: unknown;
  readonly alertTitle?: unknown;
}): string {
  const title = normalizeMarkdownAlertTitle(attributes.alertTitle);
  if (title) return title;
  const type = normalizeMarkdownAlertType(attributes.alertType) ?? "note";
  return (
    ALERT_LABELS[type] ??
    type
      .split(/[-_]+/u)
      .filter(Boolean)
      .map(
        (part) =>
          `${part[0]?.toLocaleUpperCase("en-US") ?? ""}${part.slice(1)}`,
      )
      .join(" ")
  );
}

export function markdownAlertMarker(attributes: {
  readonly alertType?: unknown;
  readonly alertTitle?: unknown;
  readonly alertFold?: unknown;
}): string | null {
  const type = normalizeMarkdownAlertType(attributes.alertType);
  if (!type) return null;
  const markerType = GITHUB_ALERT_TYPES.has(type)
    ? type.toLocaleUpperCase("en-US")
    : type;
  const fold = normalizeMarkdownAlertFold(attributes.alertFold);
  const foldMarker =
    fold === "expanded" ? "+" : fold === "collapsed" ? "-" : "";
  const title = normalizeMarkdownAlertTitle(attributes.alertTitle);
  return `[!${markerType}]${foldMarker}${title ? ` ${title}` : ""}`;
}
