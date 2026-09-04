import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";

export type ListDepthDirection = "deeper" | "shallower";

export interface ListNodeTransformResult {
  readonly node: ProseMirrorNode | null;
  readonly changed: boolean;
}

function isList(node: ProseMirrorNode): boolean {
  return node.type.name === "bulletList" || node.type.name === "orderedList";
}

function isListItem(node: ProseMirrorNode): boolean {
  return node.type.name === "listItem" || node.type.name === "list_item";
}

function listItemId(node: ProseMirrorNode): string | null {
  if (!isListItem(node)) return null;
  const value = node.attrs.blockId;
  return typeof value === "string" && value ? value : null;
}

function children(node: ProseMirrorNode): ProseMirrorNode[] {
  return Array.from({ length: node.childCount }, (_, index) =>
    node.child(index),
  );
}

function copyWithChildren(
  node: ProseMirrorNode,
  nextChildren: readonly ProseMirrorNode[],
): ProseMirrorNode {
  return node.copy(Fragment.fromArray([...nextChildren]));
}

function appendItemsToNestedList(
  item: ProseMirrorNode,
  listTemplate: ProseMirrorNode,
  appendedItems: readonly ProseMirrorNode[],
): ProseMirrorNode {
  if (appendedItems.length === 0) return item;
  const content = children(item);
  const last = content.at(-1);
  if (last?.type === listTemplate.type) {
    content[content.length - 1] = last.copy(
      last.content.append(Fragment.fromArray([...appendedItems])),
    );
  } else {
    content.push(listTemplate.copy(Fragment.fromArray([...appendedItems])));
  }
  return copyWithChildren(item, content);
}

export function listContainsSelectedItems(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): boolean {
  let contains = false;
  list.descendants((node) => {
    const id = listItemId(node);
    if (id && selectedItemIds.has(id)) {
      contains = true;
      return false;
    }
    return !contains;
  });
  return contains;
}

export function selectedListItemsHaveUnselectedDescendants(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): boolean {
  const visit = (
    node: ProseMirrorNode,
    belowSelectedItem: boolean,
  ): boolean => {
    const id = listItemId(node);
    const selected = id !== null && selectedItemIds.has(id);
    if (isListItem(node) && belowSelectedItem && !selected) return true;
    const nextBelowSelected = belowSelectedItem || selected;
    for (let index = 0; index < node.childCount; index += 1) {
      if (visit(node.child(index), nextBelowSelected)) return true;
    }
    return false;
  };
  return visit(list, false);
}

function indentItemDescendants(
  item: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): { node: ProseMirrorNode; changed: boolean } {
  let changed = false;
  const content = children(item).map((child) => {
    if (!isList(child)) return child;
    const transformed = indentList(child, selectedItemIds);
    changed ||= transformed.changed;
    return transformed.node;
  });
  return {
    node: changed ? copyWithChildren(item, content) : item,
    changed,
  };
}

function indentList(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): { node: ProseMirrorNode; changed: boolean } {
  const result: ProseMirrorNode[] = [];
  let changed = false;
  for (const item of children(list)) {
    const id = listItemId(item);
    if (id && selectedItemIds.has(id) && result.length > 0) {
      const previous = result.pop();
      if (!previous) continue;
      result.push(appendItemsToNestedList(previous, list, [item]));
      changed = true;
      continue;
    }

    // A first sibling cannot move deeper. Its selected descendants may still
    // move where their own preceding sibling makes the operation applicable.
    const transformed = indentItemDescendants(item, selectedItemIds);
    result.push(transformed.node);
    changed ||= transformed.changed;
  }
  return {
    node: changed ? copyWithChildren(list, result) : list,
    changed,
  };
}

interface OutdentItemResult {
  readonly items: readonly ProseMirrorNode[];
  readonly changed: boolean;
}

interface OutdentNestedListResult {
  readonly remaining: ProseMirrorNode | null;
  readonly lifted: readonly ProseMirrorNode[];
  readonly changed: boolean;
}

function outdentItem(
  item: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): OutdentItemResult {
  const content: ProseMirrorNode[] = [];
  const lifted: ProseMirrorNode[] = [];
  let changed = false;
  for (const child of children(item)) {
    if (!isList(child)) {
      content.push(child);
      continue;
    }
    const transformed = outdentNestedList(child, selectedItemIds);
    if (transformed.remaining) content.push(transformed.remaining);
    lifted.push(...transformed.lifted);
    changed ||= transformed.changed;
  }
  const owner = changed ? copyWithChildren(item, content) : item;
  return { items: [owner, ...lifted], changed };
}

function outdentNestedList(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): OutdentNestedListResult {
  const listItems = children(list);
  const firstSelected = listItems.findIndex((item) => {
    const id = listItemId(item);
    return id !== null && selectedItemIds.has(id);
  });

  if (firstSelected < 0) {
    const remaining: ProseMirrorNode[] = [];
    let changed = false;
    for (const item of listItems) {
      const transformed = outdentItem(item, selectedItemIds);
      remaining.push(...transformed.items);
      changed ||= transformed.changed;
    }
    return {
      remaining: changed ? copyWithChildren(list, remaining) : list,
      lifted: [],
      changed,
    };
  }

  const remaining: ProseMirrorNode[] = [];
  const lifted: ProseMirrorNode[] = [];
  let changed = true;
  for (let index = 0; index < listItems.length; index += 1) {
    const item = listItems[index]!;
    const id = listItemId(item);
    const selected = id !== null && selectedItemIds.has(id);
    if (index < firstSelected) {
      const transformed = outdentItem(item, selectedItemIds);
      remaining.push(...transformed.items);
      changed ||= transformed.changed;
      continue;
    }
    if (selected) {
      // The complete subtree travels with a selected item. Selected
      // descendants must not receive a second depth change.
      lifted.push(item);
      continue;
    }

    const transformed = outdentItem(item, selectedItemIds);
    const previous = lifted.pop();
    if (!previous) {
      remaining.push(...transformed.items);
      changed ||= transformed.changed;
      continue;
    }
    // Keeping later unselected siblings under the last lifted item preserves
    // preorder. Moving them back under the old parent would place them before
    // the item that was just lifted.
    lifted.push(appendItemsToNestedList(previous, list, transformed.items));
    changed ||= transformed.changed;
  }

  return {
    remaining: remaining.length > 0 ? copyWithChildren(list, remaining) : null,
    lifted,
    changed,
  };
}

function outdentList(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): { node: ProseMirrorNode; changed: boolean } {
  const result: ProseMirrorNode[] = [];
  let changed = false;
  for (const item of children(list)) {
    // Direct children of an outer list are already at the shallowest list
    // depth. They stay put, while applicable selected descendants may lift.
    const transformed = outdentItem(item, selectedItemIds);
    result.push(...transformed.items);
    changed ||= transformed.changed;
  }
  return {
    node: changed ? copyWithChildren(list, result) : list,
    changed,
  };
}

export function shiftSelectedListItemDepth(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
  direction: ListDepthDirection,
): ListNodeTransformResult {
  if (!isList(list) || selectedItemIds.size === 0) {
    return { node: list, changed: false };
  }
  const transformed =
    direction === "deeper"
      ? indentList(list, selectedItemIds)
      : outdentList(list, selectedItemIds);
  return { node: transformed.node, changed: transformed.changed };
}

function deleteFromList(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): ListNodeTransformResult {
  const result: ProseMirrorNode[] = [];
  let changed = false;
  for (const item of children(list)) {
    const id = listItemId(item);
    const selected = id !== null && selectedItemIds.has(id);
    const itemContent: ProseMirrorNode[] = [];
    const promoted: ProseMirrorNode[] = [];
    let itemChanged = false;
    for (const child of children(item)) {
      if (!isList(child)) {
        if (!selected) itemContent.push(child);
        continue;
      }
      const transformed = deleteFromList(child, selectedItemIds);
      itemChanged ||= transformed.changed;
      if (!transformed.node) continue;
      if (selected) promoted.push(...children(transformed.node));
      else itemContent.push(transformed.node);
    }

    if (selected) {
      result.push(...promoted);
      changed = true;
      continue;
    }
    result.push(itemChanged ? copyWithChildren(item, itemContent) : item);
    changed ||= itemChanged;
  }
  return {
    node: result.length > 0 ? copyWithChildren(list, result) : null,
    changed,
  };
}

/** Deletes selected logical ListItem rows and promotes unselected children. */
export function deleteSelectedListItems(
  list: ProseMirrorNode,
  selectedItemIds: ReadonlySet<string>,
): ListNodeTransformResult {
  if (!isList(list) || selectedItemIds.size === 0) {
    return { node: list, changed: false };
  }
  return deleteFromList(list, selectedItemIds);
}
