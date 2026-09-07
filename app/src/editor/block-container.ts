import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { BODY_CHUNK_NODE, SECTION_BODY_NODE } from "../core/section-model";

/** Editable block owners, as opposed to structural wrappers such as a Table. */
export function isBlockContainer(name: string | undefined): boolean {
  return (
    name === SECTION_BODY_NODE ||
    name === BODY_CHUNK_NODE ||
    name === "listItem"
  );
}

export function editableBlockById(
  doc: ProseMirrorNode,
  blockId: string,
): {
  node: ProseMirrorNode;
  position: number;
  parent: ProseMirrorNode;
  index: number;
} | null {
  let found: {
    node: ProseMirrorNode;
    position: number;
    parent: ProseMirrorNode;
    index: number;
  } | null = null;
  doc.descendants((node, position, parent, index) => {
    if (
      !found &&
      node.attrs.blockId === blockId &&
      parent &&
      isBlockContainer(parent.type.name)
    ) {
      found = { node, position, parent, index };
    }
    return !found;
  });
  return found;
}
