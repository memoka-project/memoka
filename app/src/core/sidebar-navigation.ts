import type { JumpHistory } from "./jump-list";

export interface SidebarNavigationItem {
  id: string;
  parentId: string | null;
  top: number;
  bottom: number;
}

export function isJumpMotion(command: string, countExplicit = false): boolean {
  return (
    command === "cursor.document-start" ||
    command === "cursor.document-end" ||
    command.startsWith("cursor.screen-") ||
    (countExplicit &&
      ["viewport.top", "viewport.center", "viewport.bottom"].includes(command))
  );
}

/** Geometry and history shared by virtual Tree rows and measured Outline rows. */
export function navigateSidebar(input: {
  command: string;
  count: number;
  countExplicit: boolean;
  items: readonly SidebarNavigationItem[];
  selectedId: string | null;
  scrollTop: number;
  height: number;
  scrollHeight: number;
  history: JumpHistory<string>;
  resolveHistoryId?: (id: string) => string | null;
}): { selectedId: string; scrollTop: number } | null {
  const { command, items, history, countExplicit } = input;
  if (!items.length) return null;
  const count = Math.max(1, input.count);
  let index = Math.max(
    0,
    items.findIndex((item) => item.id === input.selectedId),
  );
  const origin = items[index];
  const height = Math.max(1, input.height);
  const rowHeight = Math.max(1, origin.bottom - origin.top);
  const maxScroll = Math.max(0, input.scrollHeight - height);
  const clampScroll = (value: number) =>
    Math.max(0, Math.min(maxScroll, value));
  let scrollTop = clampScroll(input.scrollTop);
  const clampIndex = (value: number) =>
    Math.max(0, Math.min(items.length - 1, value));
  const closest = (y: number) =>
    items.reduce(
      (best, item, candidate) =>
        Math.abs((item.top + item.bottom) / 2 - y) <
        Math.abs((items[best].top + items[best].bottom) / 2 - y)
          ? candidate
          : best,
      0,
    );
  const visible = () => {
    let rows = items
      .map((item, i) => ({ item, i }))
      .filter(
        ({ item }) =>
          item.top >= scrollTop - 0.5 &&
          item.bottom <= scrollTop + height + 0.5,
      );
    if (!rows.length)
      rows = items
        .map((item, i) => ({ item, i }))
        .filter(
          ({ item }) =>
            item.bottom > scrollTop && item.top < scrollTop + height,
        );
    return rows.map(({ i }) => i);
  };
  let reveal = true;
  if (
    command === "navigation.jump-back" ||
    command === "navigation.jump-forward"
  ) {
    const resolve =
      input.resolveHistoryId ??
      ((id: string) => (items.some((item) => item.id === id) ? id : null));
    for (let n = 0; n < count; n++) {
      const current = items[index].id;
      const target =
        command === "navigation.jump-back"
          ? history.back(
              current,
              (id) => resolve(id) !== null && resolve(id) !== current,
            )
          : history.forward(
              current,
              (id) => resolve(id) !== null && resolve(id) !== current,
            );
      if (!target) break;
      index = items.findIndex((item) => item.id === resolve(target));
    }
  } else if (command === "cursor.logical-down")
    index = clampIndex(index + count);
  else if (command === "cursor.logical-up") index = clampIndex(index - count);
  else if (command === "cursor.document-start") index = clampIndex(count - 1);
  else if (command === "cursor.document-end")
    index = countExplicit ? clampIndex(count - 1) : items.length - 1;
  else if (command.startsWith("cursor.screen-")) {
    const rows = visible();
    if (!rows.length) return null;
    index = command.endsWith("top")
      ? rows[Math.min(count - 1, rows.length - 1)]
      : command.endsWith("bottom")
        ? rows[Math.max(0, rows.length - count)]
        : rows.reduce(
            (best, i) =>
              Math.abs(
                (items[i].top + items[i].bottom) / 2 - scrollTop - height / 2,
              ) <
              Math.abs(
                (items[best].top + items[best].bottom) / 2 -
                  scrollTop -
                  height / 2,
              )
                ? i
                : best,
            rows[0],
          );
  } else if (command.includes("page-")) {
    const distance = command.includes("half-page")
      ? height / 2
      : Math.max(rowHeight, height - 2 * rowHeight);
    const direction = command.endsWith("down") ? 1 : -1;
    const before = scrollTop;
    scrollTop = clampScroll(scrollTop + direction * distance * count);
    index = closest((origin.top + origin.bottom) / 2 + scrollTop - before);
    if (before === scrollTop)
      index =
        direction > 0 ? (visible().at(-1) ?? index) : (visible()[0] ?? index);
  } else if (
    command === "viewport.scroll-up" ||
    command === "viewport.scroll-down"
  ) {
    scrollTop = clampScroll(
      scrollTop + (command.endsWith("down") ? 1 : -1) * rowHeight * count,
    );
    if (origin.top < scrollTop) index = visible()[0] ?? closest(scrollTop);
    else if (origin.bottom > scrollTop + height)
      index = visible().at(-1) ?? closest(scrollTop + height);
    reveal = false;
  } else if (
    ["viewport.top", "viewport.center", "viewport.bottom"].includes(command)
  ) {
    if (countExplicit) index = clampIndex(count - 1);
    const target = items[index];
    scrollTop = clampScroll(
      command.endsWith("top")
        ? target.top
        : command.endsWith("bottom")
          ? target.bottom - height
          : (target.top + target.bottom - height) / 2,
    );
    reveal = false;
  } else if (command === "cursor.left") {
    index = Math.max(
      0,
      items.findIndex((item) => item.id === origin.parentId),
    );
    if (!origin.parentId) index = items.indexOf(origin);
  } else if (command === "cursor.right") {
    const child = items.findIndex((item) => item.parentId === origin.id);
    if (child >= 0) index = child;
  } else return null;
  const target = items[index];
  if (target.id !== origin.id && isJumpMotion(command, countExplicit))
    history.recordOrigin(origin.id);
  if (reveal) {
    if (target.top < scrollTop) scrollTop = clampScroll(target.top);
    else if (target.bottom > scrollTop + height)
      scrollTop = clampScroll(target.bottom - height);
  }
  return { selectedId: target.id, scrollTop };
}
