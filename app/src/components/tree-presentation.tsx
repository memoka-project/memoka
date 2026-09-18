import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  createElement,
} from "lucide";

const icons = {
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "file-text": FileText,
  "folder-closed": FolderClosed,
  "folder-open": FolderOpen,
};
const masks = new Map<string, string>();

export function TreeIcon({ name }: { name: keyof typeof icons }) {
  let mask = masks.get(name);
  if (!mask) {
    mask = `url("data:image/svg+xml,${encodeURIComponent(createElement(icons[name], { stroke: "black" }).outerHTML)}")`;
    masks.set(name, mask);
  }
  return (
    <span
      className="tree-icon"
      data-tree-icon={name}
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}
