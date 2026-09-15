import { Extension } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  TextSelection,
  type Selection,
  type Transaction,
} from "@tiptap/pm/state";
import { ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { isReplicatedProjection } from "../core/replicated-editor-binding";
import {
  BODY_CHUNK_NODE,
  SECTION_BODY_NODE,
  SECTION_NODE,
} from "../core/section-model";

const NORMALIZATION_META = "memoka:adjacent-list-normalization";
const LIST_TYPES = new Set(["bulletList", "orderedList"]);

interface PositionedBlock {
  readonly node: ProseMirrorNode;
  readonly position: number;
}

interface ListRun {
  readonly entries: readonly PositionedBlock[];
}

interface TextEndpointBookmark {
  readonly blockId: string;
  readonly offset: number;
}

function directChildren(
  node: ProseMirrorNode,
  contentStart: number,
): PositionedBlock[] {
  const children: PositionedBlock[] = [];
  node.forEach((child, offset) => {
    children.push({ node: child, position: contentStart + offset });
  });
  return children;
}

/** Lists the logical block containers, flattening invisible BodyChunk edges. */
function blockSequences(doc: ProseMirrorNode): PositionedBlock[][] {
  const sequences: PositionedBlock[][] = [];
  if (doc.type.name !== SECTION_NODE) {
    sequences.push(directChildren(doc, 0));
  }
  doc.descendants((node, position) => {
    if (node.type.name === SECTION_BODY_NODE) {
      const blocks: PositionedBlock[] = [];
      node.forEach((chunk, chunkOffset) => {
        if (chunk.type.name !== BODY_CHUNK_NODE) return;
        blocks.push(...directChildren(chunk, position + 2 + chunkOffset));
      });
      sequences.push(blocks);
    } else if (
      node.type.name === "listItem" ||
      node.type.name === "detailsBody"
    ) {
      sequences.push(directChildren(node, position + 1));
    }
    return true;
  });
  return sequences;
}

function blockId(node: ProseMirrorNode): string | null {
  const value = node.attrs.blockId;
  return typeof value === "string" && value ? value : null;
}

function compatiblePairKey(
  left: ProseMirrorNode,
  right: ProseMirrorNode,
): string | null {
  if (left.type !== right.type || !LIST_TYPES.has(left.type.name)) {
    return null;
  }
  const leftId = blockId(left);
  const rightId = blockId(right);
  return leftId && rightId
    ? `${left.type.name}\u0000${leftId}\u0000${rightId}`
    : null;
}

function containsList(fragment: Fragment): boolean {
  let found = false;
  fragment.forEach((node) => {
    if (LIST_TYPES.has(node.type.name)) {
      found = true;
      return;
    }
    node.descendants((descendant) => {
      if (LIST_TYPES.has(descendant.type.name)) {
        found = true;
        return false;
      }
      return !found;
    });
  });
  return found;
}

/** Avoid a document-wide adjacency scan for ordinary inline typing. */
function mayCreateListBoundary(transaction: Transaction): boolean {
  return transaction.steps.some((step, index) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    if (containsList(step.slice.content)) return true;
    if (step.from === step.to) return false;
    const before = transaction.docs[index]!;
    const $from = before.resolve(step.from);
    const $to = before.resolve(step.to);
    return !$from.sameParent($to) || !$from.parent.inlineContent;
  });
}

function compatibleAdjacencies(doc: ProseMirrorNode): ReadonlySet<string> {
  const result = new Set<string>();
  for (const blocks of blockSequences(doc)) {
    for (let index = 1; index < blocks.length; index += 1) {
      const key = compatiblePairKey(
        blocks[index - 1]!.node,
        blocks[index]!.node,
      );
      if (key) result.add(key);
    }
  }
  return result;
}

function newCompatibleRuns(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
): ListRun[] {
  const oldAdjacencies = compatibleAdjacencies(oldDoc);
  const runs: ListRun[] = [];
  for (const blocks of blockSequences(newDoc)) {
    let index = 0;
    while (index < blocks.length) {
      const first = blocks[index]!;
      if (!LIST_TYPES.has(first.node.type.name)) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (
        end < blocks.length &&
        blocks[end]!.node.type === first.node.type
      ) {
        end += 1;
      }
      const entries = blocks.slice(index, end);
      if (
        entries.length > 1 &&
        entries.every(({ node }) => blockId(node)) &&
        entries.slice(1).some(({ node }, pairIndex) => {
          const key = compatiblePairKey(entries[pairIndex]!.node, node);
          return key !== null && !oldAdjacencies.has(key);
        })
      ) {
        runs.push({ entries });
      }
      index = end;
    }
  }
  // Descendant runs start after their containing list. Normalizing from the
  // end lets an outer merge read the already-normalized descendant content.
  return runs.sort(
    (left, right) => right.entries[0]!.position - left.entries[0]!.position,
  );
}

function locateBlock(
  doc: ProseMirrorNode,
  requestedId: string,
): PositionedBlock | null {
  let result: PositionedBlock | null = null;
  doc.descendants((node, position) => {
    if (node.attrs.blockId === requestedId) {
      result = { node, position };
      return false;
    }
    return result === null;
  });
  return result;
}

function captureTextEndpoint(
  doc: ProseMirrorNode,
  position: number,
): TextEndpointBookmark | null {
  const $position = doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const id = blockId($position.node(depth));
    if (id) {
      return {
        blockId: id,
        offset: position - $position.start(depth),
      };
    }
  }
  return null;
}

function resolveTextEndpoint(
  doc: ProseMirrorNode,
  bookmark: TextEndpointBookmark | null,
): number | null {
  if (!bookmark) return null;
  const target = locateBlock(doc, bookmark.blockId);
  if (!target) return null;
  return (
    target.position +
    1 +
    Math.max(0, Math.min(bookmark.offset, target.node.content.size))
  );
}

function restoreTextSelection(
  transaction: Transaction,
  selection: Selection,
  anchor: TextEndpointBookmark | null,
  head: TextEndpointBookmark | null,
): void {
  if (!(selection instanceof TextSelection)) return;
  const resolvedAnchor = resolveTextEndpoint(transaction.doc, anchor);
  const resolvedHead = resolveTextEndpoint(transaction.doc, head);
  if (resolvedAnchor === null || resolvedHead === null) return;
  transaction.setSelection(
    TextSelection.create(transaction.doc, resolvedAnchor, resolvedHead),
  );
}

function isYSyncProjection(transaction: Transaction): boolean {
  let candidate: Transaction | undefined = transaction;
  while (candidate) {
    if (candidate.getMeta(ySyncPluginKey)) return true;
    candidate = candidate.getMeta("appendedTransaction") as
      Transaction | undefined;
  }
  return false;
}

/**
 * Makes newly-created compatible list boundaries canonical without rewriting
 * adjacent lists merely because an existing document was opened or edited.
 */
export const AdjacentListNormalization = Extension.create({
  name: "memokaAdjacentListNormalization",
  priority: 1_130,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          const changedTransactions = transactions.filter(
            (transaction) => transaction.docChanged,
          );
          if (
            transactions.some(isReplicatedProjection) ||
            transactions.some((transaction) =>
              transaction.getMeta(NORMALIZATION_META),
            ) ||
            changedTransactions.length === 0 ||
            changedTransactions.every(isYSyncProjection) ||
            !changedTransactions.some(mayCreateListBoundary)
          ) {
            return null;
          }
          const runs = newCompatibleRuns(oldState.doc, newState.doc);
          if (runs.length === 0) return null;

          const originalSelection = newState.selection;
          const anchor = captureTextEndpoint(
            newState.doc,
            originalSelection.anchor,
          );
          const head = captureTextEndpoint(
            newState.doc,
            originalSelection.head,
          );
          const transaction = newState.tr.setMeta(NORMALIZATION_META, true);
          if (
            originalSelection instanceof TextSelection &&
            anchor !== null &&
            head !== null
          ) {
            // Deleting a list that temporarily owns the caret makes
            // ProseMirror map it through a non-text List boundary. Park it at
            // a valid text position and restore the ID-relative bookmark once
            // the whole run has been rebuilt.
            transaction.setSelection(TextSelection.atStart(transaction.doc));
          }

          for (const run of runs) {
            const ids = run.entries.map(({ node }) => blockId(node)!);
            const current = ids.map((id) => locateBlock(transaction.doc, id));
            if (
              current.some(
                (entry) => !entry || entry.node.type !== current[0]?.node.type,
              )
            ) {
              continue;
            }
            const lists = current as PositionedBlock[];
            let appendedItems = Fragment.empty;
            for (const { node } of lists.slice(1)) {
              appendedItems = appendedItems.append(node.content);
            }
            for (const right of [...lists.slice(1)].reverse()) {
              transaction.delete(
                right.position,
                right.position + right.node.nodeSize,
              );
            }
            const mappedLeft = locateBlock(transaction.doc, ids[0]!);
            if (!mappedLeft) continue;
            transaction.insert(
              mappedLeft.position + mappedLeft.node.nodeSize - 1,
              appendedItems,
            );
          }

          if (!transaction.docChanged) return null;
          restoreTextSelection(transaction, originalSelection, anchor, head);
          return transaction;
        },
      }),
    ];
  },
});
