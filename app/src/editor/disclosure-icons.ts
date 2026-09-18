import { ChevronDown, ChevronRight, createElement } from "lucide";

const masks = new Map<boolean, string>();

export function disclosureIconMask(expanded: boolean): string {
  let mask = masks.get(expanded);
  if (!mask) {
    const svg = createElement(expanded ? ChevronDown : ChevronRight, {
      stroke: "black",
    });
    mask = `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")`;
    masks.set(expanded, mask);
  }
  return mask;
}
