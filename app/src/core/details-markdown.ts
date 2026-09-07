import { isSafeExternalLink } from "./external-links";

/** A balanced HTML details container embedded in Markdown (end is exclusive). */
export interface MarkdownDetailsRange {
  readonly end: number;
  readonly summary: string;
  readonly body: string;
  readonly open: boolean;
}

export function markdownDetailsRange(
  lines: readonly string[],
  start: number,
): MarkdownDetailsRange | null {
  const opening = lines[start]?.match(/^ {0,3}<details(?=[\s>])([^<>]*)>/iu);
  if (!opening) return null;
  let depth = 0;
  let fence: { character: string; length: number } | null = null;
  let comment = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (marker && !comment) {
      if (!fence) fence = { character: marker[0]!, length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;
    for (const token of line.matchAll(
      /<!--|-->|<\/?details(?=[\s>])[^<>]*>|`+[^`]*`+/giu,
    )) {
      if (token[0].startsWith("<!--")) {
        comment = true;
        continue;
      }
      if (token[0] === "-->") {
        comment = false;
        continue;
      }
      if (comment || token[0].startsWith("`")) continue;
      depth += /^<\//u.test(token[0]) ? -1 : 1;
      if (depth !== 0) continue;
      if (line.slice(token.index! + token[0].length).trim()) return null;
      const raw = lines.slice(start, index + 1).join("\n");
      const inner = trimBlankLines(
        raw.slice(opening[0].length, raw.lastIndexOf(token[0])),
      );
      const summary = inner.match(
        /^\s*<summary(?=[\s>])[^<>]*>([\s\S]*?)<\/summary\s*>/iu,
      );
      return {
        end: index + 1,
        summary: summary?.[1] ?? "",
        body: summary ? trimBlankLines(inner.slice(summary[0].length)) : inner,
        open: Array.from(
          (opening[1] ?? "").matchAll(
            /([^\s=/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu,
          ),
        ).some((attribute) => attribute[1]?.toLowerCase() === "open"),
      };
    }
  }
  return null;
}

function trimBlankLines(value: string): string {
  return value.replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/gu, "");
}

/** HTML summary text must not accidentally become Markdown punctuation. */
export function escapeDetailsSummaryText(text: string): string {
  return text.replace(
    /[&<>"'\\`*_[\]~=!\r\n]/gu,
    (character) => `&#${character.codePointAt(0)};`,
  );
}

export function detailsMarkdown(
  summary: string,
  body: string,
  open: boolean,
): string {
  return `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body.replace(/\n+$/u, "")}\n\n</details>\n\n`;
}

interface SummaryInline {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly SummaryInline[];
  readonly marks?: readonly { type: string; attrs?: Record<string, unknown> }[];
}

/** Shared by Editor Clipboard and portable Markdown rendering; no DOM required. */
export function detailsSummaryHtml(
  content: readonly SummaryInline[],
  resolveInternalLink?: (id: string, fallback: string) => string | null,
): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "<br>";
      if (node.type === "internalSectionLink") {
        const id = String(node.attrs?.targetSectionId ?? "");
        const label = String(
          node.attrs?.label ??
            node.content?.map((child) => child.text ?? "").join("") ??
            "",
        );
        return escapeDetailsSummaryText(
          `[[${id}|${resolveInternalLink?.(id, label) ?? label}]]`,
        );
      }
      let value = escapeDetailsSummaryText(node.text ?? "");
      for (const mark of node.marks ?? []) {
        const tag = {
          bold: "strong",
          italic: "em",
          strike: "s",
          code: "code",
          highlight: "mark",
        }[mark.type];
        if (tag) value = `<${tag}>${value}</${tag}>`;
        else if (mark.type === "link") {
          const href = String(mark.attrs?.href ?? "");
          if (isSafeExternalLink(href))
            value = `<a href="${escapeDetailsSummaryText(href)}">${value}</a>`;
        }
      }
      return value;
    })
    .join("");
}
