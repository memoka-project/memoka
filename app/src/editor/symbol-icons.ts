import { createElement, type IconNode } from "lucide";
import { iconTokens } from "../core/symbols";
import {
  SYMBOL_SPACE_CLASS,
  symbolSpacingOffsets,
} from "../core/symbol-spacing";

let data: Readonly<Record<string, { node: IconNode }>> | null = null;
let loading: Promise<void> | null = null;
const masks = new Map<string, string>();
export function loadSymbolIcons(): Promise<void> {
  return (loading ??= import("../core/data/symbol-icons.json").then(
    (module) => {
      data = module.default as unknown as Readonly<
        Record<string, { node: IconNode }>
      >;
    },
  ));
}
export function symbolIconMask(name: string): string | undefined {
  if (masks.has(name)) return masks.get(name);
  const node = data?.[name]?.node;
  if (!node) return undefined;
  const svg = createElement(node, { stroke: "black" });
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")`;
  masks.set(name, mask);
  return mask;
}

/** NodeViews use the same recognition as React titles, without changing content. */
export function renderSymbolText(element: HTMLElement, text: string): void {
  const tokens = iconTokens(text);
  const spaces = symbolSpacingOffsets(text, tokens);
  element.textContent = text;
  if (!tokens.length && !spaces.length) return;
  if (tokens.length && !data) {
    void loadSymbolIcons()
      .then(() => {
        if (element.textContent === text) renderSymbolText(element, text);
      })
      .catch(() => undefined);
    return;
  }
  const fragment = element.ownerDocument.createDocumentFragment();
  const appendSpace = () => {
    const space = element.ownerDocument.createElement("span");
    space.className = SYMBOL_SPACE_CLASS;
    space.setAttribute("aria-hidden", "true");
    fragment.append(space);
  };
  const appendText = (from: number, to: number) => {
    let cursor = from;
    for (const position of spaces) {
      if (position < from || position >= to) continue;
      fragment.append(text.slice(cursor, position));
      appendSpace();
      cursor = position;
    }
    fragment.append(text.slice(cursor, to));
  };
  let offset = 0;
  for (const token of tokens) {
    appendText(offset, token.from);
    if (spaces.includes(token.from)) appendSpace();
    const source = element.ownerDocument.createElement("span");
    source.className = "memoka-symbol-source";
    source.textContent = text.slice(token.from, token.to);
    const icon = element.ownerDocument.createElement("span");
    icon.className = "memoka-symbol-icon";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", token.name);
    icon.style.setProperty("--symbol-mask", symbolIconMask(token.name)!);
    fragment.append(source, icon);
    offset = token.to;
  }
  appendText(offset, text.length);
  element.replaceChildren(fragment);
}
