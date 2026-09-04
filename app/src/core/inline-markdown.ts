import { isSafeExternalLink } from "./external-links";

export interface InlineMarkdownMark {
  readonly name: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** Deterministic Markdown projection for one ProseMirror text run. */
export function inlineMarkdownText(
  text: string,
  marks: readonly InlineMarkdownMark[],
): string {
  const code = marks.some(({ name }) => name === "code");
  let value = code
    ? renderInlineCode(text)
    : text.replaceAll(/([\\`*_[\]~<>!])/gu, "\\$1").replaceAll("==", "\\=\\=");
  if (marks.some(({ name }) => name === "strike")) value = `~~${value}~~`;
  if (marks.some(({ name }) => name === "italic")) value = `_${value}_`;
  if (marks.some(({ name }) => name === "bold")) value = `**${value}**`;
  const link = marks.find(({ name }) => name === "link");
  const target = String(link?.attrs?.href ?? "");
  if (link && isSafeExternalLink(target)) {
    value = `[${value}](${target.replaceAll(/([\\()])/gu, "\\$1")})`;
  }
  if (marks.some(({ name }) => name === "highlight")) value = `==${value}==`;
  return value;
}

function renderInlineCode(value: string): string {
  const runs = value.match(/`+/gu) ?? [];
  const longest = Math.max(0, ...runs.map(({ length }) => length));
  const fence = "`".repeat(longest + 1);
  const padding = /^`|`$/u.test(value) || /^\s|\s$/u.test(value) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}
