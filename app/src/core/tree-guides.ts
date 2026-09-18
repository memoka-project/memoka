interface TreeGuide {
  id: string;
  depth: number;
  start: number;
  end: number;
}

/** Half-open row ranges, including descendants whose parent is offscreen. */
export function treeGuides(
  entries: readonly {
    id: string;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
  }[],
): TreeGuide[] {
  const guides: TreeGuide[] = [];
  const stack: TreeGuide[] = [];
  entries.forEach((entry, index) => {
    while (stack.length && stack[stack.length - 1].depth >= entry.depth) {
      stack.pop()!.end = index;
    }
    if (entry.hasChildren && entry.expanded) {
      const guide = {
        id: entry.id,
        depth: entry.depth,
        start: index + 1,
        end: entries.length,
      };
      guides.push(guide);
      stack.push(guide);
    }
  });
  return guides;
}
