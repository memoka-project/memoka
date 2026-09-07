import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { VimStructuralUnit } from "./block-semantics";

const isList = (node: ProseMirrorNode) =>
  node.type.name === "bulletList" || node.type.name === "orderedList";

/** Project exact logical rows, keeping only the necessary ancestor wrappers.
 * The complement removes empty owners and promotes their surviving children. */
export function projectListSelection(
  root: ProseMirrorNode,
  position: number,
  units: readonly VimStructuralUnit[],
  selected: boolean,
): ProseMirrorNode | null {
  const byPosition = new Map<number, VimStructuralUnit[]>();
  for (const unit of units) {
    const key =
      unit.kind === "code-line" || unit.kind === "hard-break-line"
        ? unit.blockPosition
        : unit.from;
    const rows = byPosition.get(key);
    if (rows) rows.push(unit);
    else byPosition.set(key, [unit]);
  }
  const visit = (node: ProseMirrorNode, pos: number): ProseMirrorNode[] => {
    const rows = byPosition.get(pos);
    if (rows?.length) {
      if (rows[0]!.kind !== "code-line" && rows[0]!.kind !== "hard-break-line")
        return selected ? [node] : [];
      const from = rows[0]!.from - pos - 1;
      const to = rows.at(-1)!.to - pos - 1;
      if (selected) return [node.copy(node.content.cut(from, to))];
      if (
        from === 0 &&
        to === node.content.size &&
        rows[0]!.kind === "hard-break-line"
      )
        return [];
      const cutFrom = to === node.content.size && from > 0 ? from - 1 : from;
      const cutTo = to < node.content.size ? to + 1 : to;
      return [
        node.copy(node.content.cut(0, cutFrom).append(node.content.cut(cutTo))),
      ];
    }
    if (node.isTextblock || node.isLeaf) return selected ? [] : [node];
    const children: ProseMirrorNode[] = [];
    node.forEach((child, offset) =>
      children.push(...visit(child, pos + 1 + offset)),
    );
    if (children.length === 0) return [];
    if (
      !selected &&
      node.type.name === "listItem" &&
      children.every(isList) &&
      node.content.content.some((child) => !isList(child))
    ) {
      return children.flatMap((list) => [...list.content.content]);
    }
    return [node.copy(Fragment.fromArray(children))];
  };
  return visit(root, position)[0] ?? null;
}
