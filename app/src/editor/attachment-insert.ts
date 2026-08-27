import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { AttachmentMetadata } from "../core/attachments";
import { createUuidV7 } from "../core/ids";
import { BODY_CHUNK_NODE, SECTION_BODY_NODE } from "../core/section-model";

export interface AttachmentInsertTarget {
  readonly blockId?: string;
  readonly consumeSlash?: boolean;
  readonly position?: number;
  readonly placement?: "before" | "after";
}

export type AttachmentInsertResult =
  | {
      readonly changed: true;
      readonly beforeCursor: number;
      readonly lastPosition: number;
      readonly populatedImageStub: boolean;
    }
  | {
      readonly changed: false;
      readonly reason: "empty" | "stale" | "unsupported";
    };

interface DirectBodyBlock {
  readonly node: ProseMirrorNode;
  readonly position: number;
  readonly parent: ProseMirrorNode;
  readonly index: number;
}

export function insertAttachmentBlocks(
  view: EditorView,
  attachments: readonly AttachmentMetadata[],
  target: AttachmentInsertTarget = {},
): AttachmentInsertResult {
  if (attachments.length === 0) return { changed: false, reason: "empty" };
  const beforeCursor = view.state.selection.head;
  const targetBlock = target.blockId
    ? directBodyBlockById(view.state.doc, target.blockId)
    : directBodyBlockAtPosition(
        view.state.doc,
        target.position ?? view.state.selection.head,
      );
  if (!targetBlock) return { changed: false, reason: "unsupported" };
  if (
    target.consumeSlash &&
    (targetBlock.node.type.name !== "paragraph" ||
      targetBlock.node.textContent !== "/")
  ) {
    return { changed: false, reason: "stale" };
  }

  const only = attachments[0];
  const selectedNode =
    view.state.selection instanceof NodeSelection
      ? view.state.selection.node
      : null;
  if (
    attachments.length === 1 &&
    only?.previewable &&
    target.blockId === undefined &&
    target.position === undefined &&
    selectedNode?.type.name === "image" &&
    selectedNode.attrs.attachmentId === "attachment:missing"
  ) {
    const transaction = view.state.tr.setNodeMarkup(
      view.state.selection.from,
      undefined,
      {
        ...selectedNode.attrs,
        src: `attachment:${only.attachmentId}`,
        attachmentId: only.attachmentId,
        alt: only.originalFilename,
      },
    );
    transaction.setSelection(
      NodeSelection.create(transaction.doc, view.state.selection.from),
    );
    transaction.setMeta("memoka.attachment.insert", {
      count: 1,
      populatedImageStub: true,
    });
    view.dispatch(transaction);
    return {
      changed: true,
      beforeCursor,
      lastPosition: view.state.selection.from,
      populatedImageStub: true,
    };
  }

  const nodes = attachments.map((attachment) =>
    attachmentNode(view, attachment),
  );
  if (nodes.some((node) => node === null)) {
    return { changed: false, reason: "unsupported" };
  }
  const inserted = nodes as ProseMirrorNode[];
  const replaceCurrent =
    target.placement === undefined &&
    (target.consumeSlash === true ||
      (targetBlock.node.type.name === "paragraph" &&
        targetBlock.node.content.size === 0));
  const insertionPosition =
    replaceCurrent || target.placement === "before"
      ? targetBlock.position
      : targetBlock.position + targetBlock.node.nodeSize;
  let transaction: Transaction;
  try {
    transaction = replaceCurrent
      ? view.state.tr.replaceWith(
          targetBlock.position,
          targetBlock.position + targetBlock.node.nodeSize,
          inserted,
        )
      : view.state.tr.insert(insertionPosition, inserted);
  } catch {
    return { changed: false, reason: "unsupported" };
  }
  let lastPosition = transaction.mapping.map(insertionPosition, -1);
  for (let index = 0; index < inserted.length - 1; index += 1) {
    lastPosition += inserted[index]!.nodeSize;
  }
  try {
    transaction.setSelection(
      NodeSelection.create(transaction.doc, lastPosition),
    );
  } catch {
    return { changed: false, reason: "unsupported" };
  }
  transaction.setMeta("memoka.attachment.insert", {
    count: attachments.length,
    populatedImageStub: false,
  });
  view.dispatch(transaction);
  return {
    changed: true,
    beforeCursor,
    lastPosition,
    populatedImageStub: false,
  };
}

function attachmentNode(
  view: EditorView,
  attachment: AttachmentMetadata,
): ProseMirrorNode | null {
  if (attachment.previewable) {
    const image = view.state.schema.nodes.image;
    return (
      image?.create({
        blockId: createUuidV7(),
        src: `attachment:${attachment.attachmentId}`,
        attachmentId: attachment.attachmentId,
        alt: attachment.originalFilename,
        title: null,
        alignment: "center",
        width: null,
      }) ?? null
    );
  }
  const attachmentNode = view.state.schema.nodes.attachment;
  return (
    attachmentNode?.create({
      blockId: createUuidV7(),
      attachmentId: attachment.attachmentId,
      label: attachment.originalFilename,
    }) ?? null
  );
}

function directBodyBlockById(
  doc: ProseMirrorNode,
  blockId: string,
): DirectBodyBlock | null {
  let result: DirectBodyBlock | null = null;
  doc.descendants((node, position, parent, index) => {
    if (
      result === null &&
      node.attrs.blockId === blockId &&
      (parent?.type.name === SECTION_BODY_NODE ||
        parent?.type.name === BODY_CHUNK_NODE ||
        parent?.type.name === "doc")
    ) {
      result = { node, position, parent, index };
      return false;
    }
    return result === null;
  });
  return result;
}

function directBodyBlockAtPosition(
  doc: ProseMirrorNode,
  rawPosition: number,
): DirectBodyBlock | null {
  const position = Math.max(0, Math.min(rawPosition, doc.content.size));
  const $position = doc.resolve(position);
  for (let depth = $position.depth; depth >= 0; depth -= 1) {
    const parent = $position.node(depth);
    if (
      parent.type.name !== SECTION_BODY_NODE &&
      parent.type.name !== BODY_CHUNK_NODE &&
      parent.type.name !== "doc"
    ) {
      continue;
    }
    const index = Math.min(
      $position.index(depth),
      Math.max(0, parent.childCount - 1),
    );
    if (parent.childCount === 0) return null;
    const node = parent.child(index);
    let nodePosition = $position.start(depth);
    for (let childIndex = 0; childIndex < index; childIndex += 1) {
      nodePosition += parent.child(childIndex).nodeSize;
    }
    return { node, position: nodePosition, parent, index };
  }
  let nearest: DirectBodyBlock | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  doc.descendants((node, nodePosition, parent, index) => {
    if (
      parent?.type.name !== SECTION_BODY_NODE &&
      parent?.type.name !== BODY_CHUNK_NODE &&
      parent?.type.name !== "doc"
    ) {
      return true;
    }
    const distance =
      position < nodePosition
        ? nodePosition - position
        : position > nodePosition + node.nodeSize
          ? position - (nodePosition + node.nodeSize)
          : 0;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { node, position: nodePosition, parent, index };
    }
    return distance !== 0;
  });
  return nearest;
}
