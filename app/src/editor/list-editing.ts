import { Node, mergeAttributes } from "@tiptap/core";
import { Fragment, type ResolvedPos } from "@tiptap/pm/model";
import {
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { liftListItem } from "@tiptap/pm/schema-list";
import { createUuidV7, createUuidV7Batch } from "../core/ids";

export function owningListItemDepth(position: ResolvedPos): number | null {
  for (let depth = position.depth; depth > 0; depth--) {
    if (position.node(depth).type.name === "listItem") return depth;
  }
  return null;
}

export function isDirectListParagraph(position: ResolvedPos): boolean {
  return (
    position.parent.type.name === "paragraph" &&
    position.depth > 0 &&
    position.node(position.depth - 1).type.name === "listItem"
  );
}

/** First child when present, otherwise the next sibling in display order. */
export function listItemAfterPosition(position: ResolvedPos): number | null {
  const depth = owningListItemDepth(position);
  if (depth === null) return null;
  let childListOffset: number | null = null;
  position.node(depth).forEach((child, offset) => {
    if (
      childListOffset === null &&
      (child.type.name === "bulletList" || child.type.name === "orderedList")
    )
      childListOffset = offset;
  });
  return childListOffset === null
    ? position.after(depth)
    : position.start(depth) + childListOffset + 1;
}

export const insertListItemAfter: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const depth = owningListItemDepth($from);
  const paragraph = state.schema.nodes.paragraph;
  if (
    depth === null ||
    !paragraph ||
    $to.depth < depth ||
    $from.node(depth) !== $to.node(depth)
  )
    return false;
  const item = $from.node(depth);
  const position = listItemAfterPosition($from);
  if (position === null) return false;
  const $target = state.doc.resolve(position);
  const index = $target.index();
  if (!$target.parent.canReplaceWith(index, index, item.type)) return false;
  if (!dispatch) return true;

  const [itemId, paragraphId] = createUuidV7Batch(2);
  const inserted = item.type.create(
    { blockId: itemId },
    paragraph.create({ blockId: paragraphId }),
  );
  const tr = state.tr.insert(position, inserted);
  tr.setSelection(TextSelection.create(tr.doc, position + 2));
  dispatch(tr.scrollIntoView());
  return true;
};

export const insertListParagraph: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const depth = owningListItemDepth($from);
  if (
    depth === null ||
    $to.depth < depth ||
    $from.node(depth) !== $to.node(depth)
  )
    return false;
  if (!dispatch) return true;
  const paragraph = state.schema.nodes.paragraph!;
  let tr = state.tr;
  if (
    $from.depth === depth + 1 &&
    $from.parent.type === paragraph &&
    $from.sameParent($to)
  ) {
    tr = tr.deleteSelection();
    const position = tr.selection.from;
    tr.split(position, 1, [
      { type: paragraph, attrs: { blockId: createUuidV7() } },
    ]);
    tr.setSelection(TextSelection.create(tr.doc, position + 2));
  } else {
    const position =
      $from.depth > depth
        ? $from.after(depth + 1)
        : $from.pos + ($from.nodeAfter?.nodeSize ?? 0);
    tr.insert(position, paragraph.create({ blockId: createUuidV7() }));
    tr.setSelection(TextSelection.create(tr.doc, position + 1));
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/** Split only direct paragraphs. Inner code/table/quote blocks own Enter. */
export const splitRichListItem: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const depth = owningListItemDepth($from);
  if (
    depth === null ||
    $from.depth !== depth + 1 ||
    $from.parent.type.name !== "paragraph" ||
    !$from.sameParent($to)
  )
    return false;
  const item = $from.node(depth);
  if (item.childCount === 1 && $from.parent.content.size === 0) {
    return liftListItem(item.type)(state, dispatch);
  }
  if (!dispatch) return true;
  const tr = replaceListParagraphWithLines(state.tr, ["", ""]);
  if (!tr) return false;
  dispatch(tr.scrollIntoView());
  return true;
};

/** Shared by Enter, DOM/native paste, and p/P. Preserve the entire tail. */
export function replaceListParagraphWithLines(
  tr: Transaction,
  lines: readonly string[],
): Transaction | null {
  const { $from, $to } = tr.selection;
  const depth = owningListItemDepth($from);
  if (
    depth === null ||
    $from.depth !== depth + 1 ||
    $from.parent.type.name !== "paragraph" ||
    !$from.sameParent($to) ||
    lines.length < 2
  )
    return null;
  const item = $from.node(depth);
  const paragraph = $from.parent;
  const beforeBlocks = item.content.cut(0, $from.before() - $from.start(depth));
  const afterBlocks = item.content.cut($from.after() - $from.start(depth));
  const prefix = paragraph.content.cut(0, $from.parentOffset);
  const suffix = paragraph.content.cut($to.parentOffset);
  const marks = tr.storedMarks ?? $from.marks();
  const freshIds = createUuidV7Batch((lines.length - 1) * 2);
  const items = lines.map((text, index) => {
    let content = text
      ? Fragment.from(tr.doc.type.schema.text(text, marks))
      : Fragment.empty;
    if (index === 0) content = prefix.append(content);
    if (index === lines.length - 1) content = content.append(suffix);
    let blocks = Fragment.from(
      paragraph.type.create(
        index === 0
          ? paragraph.attrs
          : { ...paragraph.attrs, blockId: freshIds[(index - 1) * 2] },
        content,
      ),
    );
    if (index === 0) blocks = beforeBlocks.append(blocks);
    if (index === lines.length - 1) blocks = blocks.append(afterBlocks);
    return item.type.create(
      index === 0
        ? item.attrs
        : { ...item.attrs, blockId: freshIds[(index - 1) * 2 + 1] },
      blocks,
    );
  });
  const from = $from.before(depth);
  const lastStart =
    from + items.slice(0, -1).reduce((size, node) => size + node.nodeSize, 0);
  tr.replaceWith(from, $from.after(depth), items);
  tr.setSelection(
    TextSelection.create(tr.doc, lastStart + 2 + lines.at(-1)!.length),
  );
  return tr;
}

export function plainListPasteLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

export function pastePlainListText(
  tr: Transaction,
  text: string,
): Transaction | null {
  const { $from, $to } = tr.selection;
  const depth = owningListItemDepth($from);
  if (
    !/[\r\n]/u.test(text) ||
    depth === null ||
    $from.depth !== depth + 1 ||
    $from.parent.type.name !== "paragraph" ||
    !$from.sameParent($to)
  )
    return null;
  const lines = plainListPasteLines(text);
  return lines.length === 1
    ? tr.insertText(lines[0]!)
    : replaceListParagraphWithLines(tr, lines);
}

export const RichListItem = Node.create({
  name: "listItem",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "li" }],
  renderHTML: ({ HTMLAttributes }) => [
    "li",
    mergeAttributes(HTMLAttributes),
    0,
  ],
  addKeyboardShortcuts() {
    return {
      Enter: () =>
        splitRichListItem(this.editor.state, this.editor.view.dispatch),
    };
  },
});
