import {
  Bug,
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Flame,
  Info,
  Lightbulb,
  List,
  NotebookPen,
  Quote,
  ScrollText,
  TriangleAlert,
  X,
  Zap,
  createElement,
  type IconNode,
} from "lucide";
import { MARKDOWN_ALERT_TYPE_CATALOG } from "../core/markdown-alert";

const icons: Readonly<Record<string, IconNode>> = {
  note: NotebookPen,
  abstract: ScrollText,
  info: Info,
  todo: CircleCheck,
  tip: Lightbulb,
  important: CircleAlert,
  success: Check,
  question: CircleHelp,
  warning: TriangleAlert,
  caution: Flame,
  failure: X,
  danger: Zap,
  bug: Bug,
  example: List,
  quote: Quote,
};

const masks = new Map<string, string>();

/** Decorative CSS masks leave the editable document and clipboard text intact. */
export function alertIconMask(type: string): string {
  const canonical =
    MARKDOWN_ALERT_TYPE_CATALOG.find(
      (entry) => entry.id === type || entry.aliases.includes(type),
    )?.id ?? "note";
  const cached = masks.get(canonical);
  if (cached) return cached;
  const svg = createElement(icons[canonical] ?? NotebookPen, {
    stroke: "black",
  });
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")`;
  masks.set(canonical, mask);
  return mask;
}
