const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/u;
const BARE_HOST =
  /^(?:localhost|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})(?::\d{1,5})?(?:[/?#].*)?$/u;
const OPENABLE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

export type ExternalLinkKind = "absolute" | "relative";

export type ExternalLinkNormalizationResult =
  | {
      readonly valid: true;
      readonly href: string;
      readonly kind: ExternalLinkKind;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "empty"
        | "control"
        | "whitespace"
        | "protocol-relative"
        | "scheme"
        | "invalid";
    };

/**
 * Normalize text entered in the link picker. This is also the single policy
 * used by Markdown/HTML import and the external URL opener.
 */
export function normalizeExternalLink(
  value: string,
): ExternalLinkNormalizationResult {
  const href = value.trim();
  if (!href) return { valid: false, reason: "empty" };
  if (
    [...href].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    return { valid: false, reason: "control" };
  }
  if (/\s/u.test(href)) return { valid: false, reason: "whitespace" };
  if (/[<>"']/u.test(href)) return { valid: false, reason: "invalid" };
  if (href.startsWith("//")) {
    return { valid: false, reason: "protocol-relative" };
  }

  const scheme = href.match(URL_SCHEME)?.[1]?.toLocaleLowerCase();
  if (scheme) {
    if (!OPENABLE_SCHEMES.has(scheme)) {
      return { valid: false, reason: "scheme" };
    }
    const payload = href.slice(href.indexOf(":") + 1);
    if (!payload) return { valid: false, reason: "invalid" };
    if (scheme === "http" || scheme === "https") {
      try {
        const parsed = new URL(href);
        if (!parsed.hostname) return { valid: false, reason: "invalid" };
      } catch {
        return { valid: false, reason: "invalid" };
      }
    }
    return { valid: true, href, kind: "absolute" };
  }

  if (BARE_HOST.test(href)) {
    return { valid: true, href: `https://${href}`, kind: "absolute" };
  }
  return { valid: true, href, kind: "relative" };
}

export function isSafeExternalLink(value: string): boolean {
  return normalizeExternalLink(value).valid;
}

export function externalLinkErrorMessage(
  result: Extract<ExternalLinkNormalizationResult, { valid: false }>,
): string {
  switch (result.reason) {
    case "empty":
      return "URLを入力してください";
    case "control":
    case "whitespace":
      return "URLに空白または制御文字を含めることはできません";
    case "protocol-relative":
      return "// から始まるURLは使用できません";
    case "scheme":
      return "http、https、mailto、tel、または相対URLを指定してください";
    case "invalid":
      return "URLの形式が正しくありません";
  }
}
