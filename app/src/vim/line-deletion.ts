import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

interface DeletionRange {
  readonly from: number;
  readonly to: number;
}

// Never collapse Section/Note identities or an unselected list/table/atom just
// because textContent is empty. Images, attachments and empty cells are content.
const removableBlocks = new Set([
  "paragraph",
  "codeBlock",
  "code_block",
  "sourceBlock",
  "source_block",
  "blockquote",
  "details",
  "table",
]);

function hasRemainingContent(
  node: ProseMirrorNode,
  position: number,
  range: DeletionRange,
): boolean {
  if (position >= range.from && position + node.nodeSize <= range.to)
    return false;
  if (node.isText || node.isLeaf) return true;
  if (
    !removableBlocks.has(node.type.name) &&
    node.type.name !== "detailsSummary" &&
    node.type.name !== "detailsBody"
  )
    return true;
  let childPosition = position + 1;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (hasRemainingContent(child, childPosition, range)) return true;
    childPosition += child.nodeSize;
  }
  return false;
}

/** Expand only ancestors touched by this line deletion, not unrelated blanks. */
export function expandEmptyLineDeletion(
  doc: ProseMirrorNode,
  range: DeletionRange,
): DeletionRange {
  let { from, to } = range;
  for (const boundary of [range.from, range.to]) {
    const $boundary = doc.resolve(boundary);
    for (let depth = $boundary.depth; depth > 0; depth--) {
      const node = $boundary.node(depth);
      const position = $boundary.before(depth);
      if (
        removableBlocks.has(node.type.name) &&
        !hasRemainingContent(node, position, { from, to })
      ) {
        from = Math.min(from, position);
        to = Math.max(to, position + node.nodeSize);
      }
    }
  }
  return { from, to };
}

/** Used after exact row projection inside a rich ListItem. */
export function isEmptyLineDeletionBlock(node: ProseMirrorNode): boolean {
  return (
    removableBlocks.has(node.type.name) &&
    !hasRemainingContent(node, 0, { from: -1, to: -1 })
  );
}
