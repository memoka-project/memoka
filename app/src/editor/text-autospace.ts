import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration } from "@tiptap/pm/view";

export const TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE =
  "data-memoka-text-autospace-inline-end";
export const TEXT_AUTOSPACE_AFTER_CLASS = "memoka-text-autospace-after";

interface TextAutospaceCompensationEntry {
  readonly position: number;
}

export interface TextAutospaceCompensation {
  readonly decorations: readonly Decoration[];
  readonly signature: string;
}

const IDEOGRAPH =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\u31c0-\u31ef\u31f0-\u31ff]/u;
const NON_IDEOGRAPHIC_ALPHANUMERIC = /[\p{Letter}\p{Mark}\p{Decimal_Number}]/u;
const PUNCTUATION = /\p{Punctuation}/u;

function firstCodePoint(value: string): string {
  return Array.from(value)[0] ?? "";
}

function lastCodePoint(value: string): string {
  const points = Array.from(value);
  return points.at(-1) ?? "";
}

function isIdeograph(value: string): boolean {
  return value.length > 0 && !PUNCTUATION.test(value) && IDEOGRAPH.test(value);
}

function isNonIdeographicAlphanumeric(value: string): boolean {
  return (
    value.length > 0 &&
    !isIdeograph(value) &&
    NON_IDEOGRAPHIC_ALPHANUMERIC.test(value)
  );
}

export function needsTextAutospaceBetween(
  before: string,
  after: string,
): boolean {
  return (
    (isIdeograph(before) && isNonIdeographicAlphanumeric(after)) ||
    (isNonIdeographicAlphanumeric(before) && isIdeograph(after))
  );
}

function hasCodeMark(node: ProseMirrorNode): boolean {
  return node.marks.some((mark) => mark.type.name === "code");
}

function compensationEntries(
  node: ProseMirrorNode,
): readonly TextAutospaceCompensationEntry[] {
  if (!node.isTextblock || node.type.spec.code) return [];
  const entries: TextAutospaceCompensationEntry[] = [];
  let previous: string | null = null;

  const append = (value: string, position: number): void => {
    if (previous && needsTextAutospaceBetween(previous, value)) {
      entries.push({ position });
    }
    previous = value;
  };

  node.forEach((child, offset) => {
    if (child.isText && !hasCodeMark(child)) {
      let characterOffset = 0;
      for (const character of Array.from(child.text ?? "")) {
        append(character, offset + characterOffset);
        characterOffset += character.length;
      }
      return;
    }
    if (!child.isText && child.isInline && child.isAtom && child.textContent) {
      append(firstCodePoint(child.textContent), offset);
      previous = lastCodePoint(child.textContent);
      return;
    }
    // Inline code has symmetric authored padding and Code/Hard Breaks must not
    // inherit prose spacing across their boundaries.
    previous = null;
  });
  return entries;
}

export function textAutospaceCompensationForTextblock(
  node: ProseMirrorNode,
  nodePosition: number,
): TextAutospaceCompensation | null {
  const entries = compensationEntries(node);
  if (entries.length === 0) return null;
  const contentStart = nodePosition + 1;
  return {
    decorations: entries.map((entry) => {
      const position = contentStart + entry.position;
      return Decoration.widget(
        position,
        (view) => {
          const element = view.dom.ownerDocument.createElement("span");
          element.className = TEXT_AUTOSPACE_AFTER_CLASS;
          element.contentEditable = "false";
          element.setAttribute("aria-hidden", "true");
          return element;
        },
        {
          key: `memoka-text-autospace:${position}`,
          // Keep this zero-height widget before the character's DOM position.
          // A positive side makes domAtPos(pos, 1) stop at the widget, so Vim
          // measures the spacer instead of the following glyph.
          side: -1,
          ignoreSelection: true,
        },
      );
    }),
    signature: entries.map((entry) => String(entry.position)).join(","),
  };
}

function rangeWidth(document: Document, element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const width = range.getBoundingClientRect().width;
  range.detach();
  return width;
}

/** Detects WebKit's missing autospace at the closing edge of inline boxes. */
export function hasTextAutospaceInlineEndBug(document: Document): boolean {
  const view = document.defaultView;
  if (!view?.CSS?.supports("text-autospace", "normal")) return false;
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;visibility:hidden;white-space:nowrap;font:32px sans-serif;";
  host.innerHTML = [
    '<span data-case="plain" style="text-autospace:normal">\u65e5A\u65e5</span>',
    '<span data-case="plain-none" style="text-autospace:no-autospace">\u65e5A\u65e5</span>',
    '<span data-case="split" style="text-autospace:normal">\u65e5<span>A</span>\u65e5</span>',
    '<span data-case="split-none" style="text-autospace:no-autospace">\u65e5<span>A</span>\u65e5</span>',
  ].join("");
  // Each sample needs its own inline formatting context. In WebKit, adjacent
  // inline samples can corrupt even the no-autospace baseline's range width,
  // making the broken split sample appear to have the full native spacing.
  for (const sample of host.children) {
    (sample as HTMLElement).style.display = "inline-block";
  }
  (document.body ?? document.documentElement).append(host);
  const width = (name: string): number =>
    rangeWidth(
      document,
      host.querySelector<HTMLElement>(`[data-case="${name}"]`)!,
    );
  const plainSpacing = width("plain") - width("plain-none");
  const splitSpacing = width("split") - width("split-none");
  host.remove();
  return plainSpacing > 1 && splitSpacing < plainSpacing - 0.5;
}

export function applyTextAutospaceCompatibility(document: Document): void {
  document.documentElement.setAttribute(
    TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE,
    hasTextAutospaceInlineEndBug(document) ? "broken" : "native",
  );
}
