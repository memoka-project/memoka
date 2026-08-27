import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/src/App";

describe("Workspace Tree", () => {
  it("creates and moves hierarchy by keyboard without assigning row mouse actions", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const initial = tree.querySelector<HTMLElement>(
      '[role="treeitem"][aria-selected="true"]',
    );
    if (!initial) throw new Error("Initial Tree item did not mount");
    const initialId = initial.id;

    tree.focus();
    fireEvent.keyDown(tree, { key: "c", code: "KeyC" });
    const child = await waitFor(() => {
      const selected = tree.querySelector<HTMLElement>(
        '[role="treeitem"][aria-selected="true"]',
      );
      if (!selected || selected.id === initialId) {
        throw new Error("Child Note was not selected");
      }
      expect(selected.getAttribute("aria-level")).toBe("2");
      return selected;
    });
    const childId = child.id;
    expect(
      view.container.querySelector(
        '[data-note-title-placeholder="新しいノート"]',
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "ノートタイトル" }),
    ).toBeNull();

    tree = screen.getByRole("tree", { name: "ノートツリー" });
    const rootRow = document.getElementById(initialId);
    if (!rootRow) throw new Error("Root Tree row did not mount");
    fireEvent.mouseDown(rootRow);
    fireEvent.click(rootRow);
    expect(document.activeElement).toBe(tree);
    expect(
      tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
        ?.id,
    ).toBe(childId);

    fireEvent.keyDown(tree, { key: "H", code: "KeyH", shiftKey: true });
    await waitFor(() =>
      expect(document.getElementById(childId)?.getAttribute("aria-level")).toBe(
        "1",
      ),
    );

    fireEvent.keyDown(tree, { key: "D", code: "KeyD", shiftKey: true });
    await waitFor(() =>
      expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(1),
    );
    expect(
      tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
        ?.id,
    ).toBe(initialId);
    view.unmount();
  });

  it("moves a Note by two sibling positions with a physical 2 Shift J sequence", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const firstNoteId = tree.querySelector<HTMLElement>(
      '[role="treeitem"][aria-selected="true"]',
    )?.id;
    if (!firstNoteId) throw new Error("Initial Tree item did not mount");

    for (let expectedCount = 2; expectedCount <= 4; expectedCount += 1) {
      tree.focus();
      fireEvent.keyDown(tree, { key: "A", code: "KeyA", shiftKey: true });
      await waitFor(() =>
        expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(
          expectedCount,
        ),
      );
      tree = screen.getByRole("tree", { name: "ノートツリー" });
    }

    tree.focus();
    fireEvent.keyDown(tree, { key: "g", code: "KeyG" });
    fireEvent.keyDown(tree, { key: "g", code: "KeyG" });
    await waitFor(() =>
      expect(
        tree.querySelector<HTMLElement>(
          '[role="treeitem"][aria-selected="true"]',
        )?.id,
      ).toBe(firstNoteId),
    );
    const originalOrder = Array.from(
      tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
      (item) => item.id,
    );

    fireEvent.keyDown(tree, { key: "2", code: "Digit2" });
    fireEvent.keyDown(tree, { key: "Shift", code: "ShiftLeft" });
    fireEvent.keyDown(tree, {
      key: "J",
      code: "KeyJ",
      shiftKey: true,
    });

    await waitFor(() => {
      const movedOrder = Array.from(
        tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
        (item) => item.id,
      );
      expect(movedOrder).toEqual([
        originalOrder[1],
        originalOrder[2],
        originalOrder[0],
        originalOrder[3],
      ]);
    });
    view.unmount();
  });
});
