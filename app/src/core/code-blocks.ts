import { all } from "lowlight";
import { normalizeWorkspaceSearchText } from "./workspace-search";

export const CODE_BLOCK_ACTION_IDS = ["copy", "language"] as const;
export type CodeBlockActionId = (typeof CODE_BLOCK_ACTION_IDS)[number];

export interface CodeBlockActionCatalogEntry {
  readonly id: CodeBlockActionId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

export const CODE_BLOCK_ACTION_CATALOG: readonly CodeBlockActionCatalogEntry[] =
  [
    {
      id: "copy",
      name: "コピー",
      aliases: ["copy", "clipboard", "yank", "コピー"],
      description: "コード本文だけをClipboardへコピーします。",
    },
    {
      id: "language",
      name: "言語設定",
      aliases: ["language", "syntax", "highlight", "言語", "構文"],
      description: "構文ハイライトに使う言語を設定します。",
    },
  ];

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  go: "Go",
  graphql: "GraphQL",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  markdown: "Markdown",
  objectivec: "Objective-C",
  php: "PHP",
  plaintext: "Plain text",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  xml: "HTML / XML",
  yaml: "YAML",
};

const LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  bash: ["sh", "zsh"],
  cpp: ["c++"],
  csharp: ["cs", "c#"],
  javascript: ["js", "jsx"],
  json: ["jsonc", "json5"],
  markdown: ["md"],
  objectivec: ["objc"],
  plaintext: ["plain", "text", "none", "なし"],
  python: ["py"],
  shell: ["console"],
  typescript: ["ts", "tsx"],
  xml: ["html", "svg", "xhtml"],
  yaml: ["yml"],
};

export interface CodeLanguageCatalogEntry {
  /** null is the authored no-language state and serializes as an empty fence. */
  readonly id: string | null;
  readonly name: string;
  readonly aliases: readonly string[];
}

export const CODE_LANGUAGE_CATALOG: readonly CodeLanguageCatalogEntry[] = [
  {
    id: null,
    name: "Plain text",
    aliases: ["plain", "plaintext", "text", "none", "なし"],
  },
  ...Object.keys(all)
    .filter((id) => id !== "plaintext")
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((id) => ({
      id,
      name: LANGUAGE_LABELS[id] ?? id,
      aliases: LANGUAGE_ALIASES[id] ?? [],
    })),
];

function matchesTerms(values: readonly string[], query: string): boolean {
  const terms = normalizeWorkspaceSearchText(query)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = normalizeWorkspaceSearchText(values.join(" "));
  return terms.every((term) => searchable.includes(term));
}

export function filterCodeBlockActionCatalog(
  query: string,
): readonly CodeBlockActionCatalogEntry[] {
  return CODE_BLOCK_ACTION_CATALOG.filter((entry) =>
    matchesTerms([entry.name, ...entry.aliases, entry.description], query),
  );
}

export function filterCodeLanguageCatalog(
  query: string,
): readonly CodeLanguageCatalogEntry[] {
  const normalized = normalizeWorkspaceSearchText(query).trim();
  const matching = CODE_LANGUAGE_CATALOG.filter((entry) =>
    matchesTerms(
      [entry.name, entry.id ?? "", ...entry.aliases, "言語 language"],
      query,
    ),
  );
  if (!normalized || normalized.includes(" ")) return matching;
  const score = (entry: CodeLanguageCatalogEntry): number => {
    const values = [entry.name, entry.id ?? "", ...entry.aliases].map(
      normalizeWorkspaceSearchText,
    );
    if (values.some((value) => value === normalized)) return 0;
    if (values.some((value) => value.startsWith(normalized))) return 1;
    return 2;
  };
  return matching
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ entry }) => entry);
}

export function codeLanguageLabel(language: unknown): string {
  if (typeof language !== "string" || !language) return "Plain text";
  return LANGUAGE_LABELS[language] ?? language;
}

export function isCodeLanguage(language: string | null): boolean {
  return CODE_LANGUAGE_CATALOG.some((entry) => entry.id === language);
}
