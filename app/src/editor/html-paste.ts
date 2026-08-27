import { isSafeExternalLink } from "../core/external-links";

const BLOCKED_ELEMENTS = [
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "picture",
  "select",
  "source",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
  "track",
  "video",
] as const;

const SAFE_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  code: new Set(["class"]),
  ol: new Set(["start"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};
const SAFE_CODE_CLASS = /^language-[\p{L}\p{N}_+-]+$/u;
const SAFE_INTEGER = /^-?\d+$/u;

/**
 * Parse external HTML in a detached document and remove active content before
 * ProseMirror's schema parser sees it. Schema parsing remains responsible for
 * discarding unsupported document structure.
 */
export function sanitizeExternalHtml(html: string): string {
  const detached = document.implementation.createHTMLDocument("");
  detached.body.innerHTML = html;
  for (const selector of BLOCKED_ELEMENTS) {
    detached.body.querySelectorAll(selector).forEach((element) => {
      element.remove();
    });
  }
  detached.body.querySelectorAll("*").forEach((element) => {
    const tagName = element.tagName.toLocaleLowerCase();
    const allowed = SAFE_ATTRIBUTES[tagName] ?? new Set<string>();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase();
      if (
        !allowed.has(name) ||
        (name === "href" && !isSafeExternalLink(attribute.value)) ||
        (name === "class" && !SAFE_CODE_CLASS.test(attribute.value.trim())) ||
        ((name === "start" || name === "colspan" || name === "rowspan") &&
          !SAFE_INTEGER.test(attribute.value.trim()))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return detached.body.innerHTML;
}
