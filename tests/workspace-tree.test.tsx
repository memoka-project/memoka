import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import {
  WorkspaceTree,
  type WorkspaceTreeProps,
} from "../app/src/components/WorkspaceTree";
import { activeTab } from "../app/src/core/application-state";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

function treeProps(runtime: CoreRuntime): WorkspaceTreeProps {
  return {
    runtime,
    snapshot: runtime.snapshot(),
    targetWindowId: "window-1",
    focusRequest: 1,
    onOpenNote: vi.fn(async () => {}),
    onRequestEditorFocus: vi.fn(),
    onOpenTrash: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
  };
}

function selectedId(tree: HTMLElement): string | undefined {
  return tree.querySelector('[role="treeitem"][aria-selected="true"]')?.id;
}

describe("Workspace Tree", () => {
  it("creates and moves hierarchy by keyboard without an inline rename UI", async () => {
    const view = render(<App />);
    let tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const initial = tree.querySelector<HTMLElement>(
      '[role="treeitem"][aria-selected="true"]',
    );
    if (!initial) throw new Error("Initial Tree item did not mount");
    const initialId = initial.id;
    expect(
      tree.closest("aside")?.querySelector(".utility-statusline"),
    ).toBeNull();

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
    tree.focus();
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

  it("opens the clicked Note rather than the previous selection and focuses its Editor", async () => {
    const view = render(<App />);
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    const rootId = selectedId(tree)!;
    const rootEditor = await waitFor(() => {
      const editor =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!editor) throw new Error("Editor did not mount");
      return editor;
    });
    const rootNoteId = rootEditor.dataset.noteId;

    tree.focus();
    fireEvent.keyDown(tree, { key: "c", code: "KeyC" });
    const childId = await waitFor(() => {
      expect(selectedId(tree)).not.toBe(rootId);
      expect(document.activeElement?.getAttribute("data-note-id")).not.toBe(
        rootNoteId,
      );
      expect(document.activeElement?.classList.contains("memoka-editor")).toBe(
        true,
      );
      return selectedId(tree)!;
    });
    const childNoteId = (document.activeElement as HTMLElement).dataset.noteId;

    const rootRow = document.getElementById(rootId)!;
    const rootTitle = rootRow.querySelector(".tree-title")!;
    fireEvent.mouseOver(rootTitle);
    expect(selectedId(tree)).toBe(childId);
    fireEvent.mouseDown(rootTitle);
    fireEvent.click(rootTitle);
    await waitFor(() => {
      expect(selectedId(tree)).toBe(rootId);
      expect(document.activeElement?.getAttribute("data-note-id")).toBe(
        rootNoteId,
      );
      expect(document.activeElement?.classList.contains("memoka-editor")).toBe(
        true,
      );
      expect(
        tree.closest("aside")?.classList.contains("focus-surface--focused"),
      ).toBe(false);
    });

    // Opening an already selected Note must also return real DOM focus.
    fireEvent.mouseDown(rootRow);
    fireEvent.click(rootRow);
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("data-note-id")).toBe(
        rootNoteId,
      );
      expect(document.activeElement?.classList.contains("memoka-editor")).toBe(
        true,
      );
    });

    // Rows (including their blank space), not only their title, are clickable.
    const childRow = document.getElementById(childId)!;
    fireEvent.mouseDown(childRow);
    fireEvent.click(childRow);
    await waitFor(() => {
      expect(selectedId(tree)).toBe(childId);
      expect(document.activeElement?.getAttribute("data-note-id")).toBe(
        childNoteId,
      );
    });

    tree.focus();
    expect(fireEvent.keyDown(tree, { key: "ArrowUp" })).toBe(false);
    await waitFor(() => expect(selectedId(tree)).toBe(rootId));
    expect(fireEvent.keyDown(tree, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() =>
      expect(rootRow.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() =>
      expect(rootRow.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(selectedId(tree)).toBe(rootId);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    await waitFor(() => expect(selectedId(tree)).toBe(childId));
    expect(document.activeElement).toBe(tree);
    view.unmount();
  });

  it("uses arrow keys for visible rows, hierarchy, boundaries and counted scrolling", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const rootId = runtime.snapshot().namespaceEntries[0]!.entryId;
      const child = await runtime.createNamespaceGroup(rootId, "Child");
      const grandchild = await runtime.createNamespaceGroup(
        child.entryId,
        "Grandchild",
      );
      const sibling = await runtime.createNamespaceGroup(null, "Sibling");
      await runtime.updateSidebar({
        side: "left",
        tree: { selectedEntryId: rootId, collapsedEntryIds: [] },
      });
      const view = render(<WorkspaceTree {...treeProps(runtime)} />);
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      Object.defineProperty(tree, "clientHeight", {
        configurable: true,
        value: 28,
      });
      const select = (key: string, entryId: string) => {
        expect(fireEvent.keyDown(tree, { key })).toBe(false);
        expect(selectedId(tree)).toBe(`tree-note-${entryId}`);
        expect(document.activeElement).toBe(tree);
      };
      select("ArrowUp", rootId);
      select("ArrowRight", child.entryId);
      select("ArrowRight", grandchild.entryId);
      select("ArrowRight", grandchild.entryId);
      select("ArrowLeft", child.entryId);
      select("ArrowLeft", child.entryId); // collapse
      expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
      select("ArrowDown", sibling.entryId); // skip the hidden grandchild
      select("ArrowDown", sibling.entryId);
      select("ArrowUp", child.entryId);
      select("ArrowRight", child.entryId); // expand without moving
      select("ArrowUp", rootId);
      fireEvent.keyDown(tree, { key: "3" });
      select("ArrowDown", sibling.entryId);
      expect(tree.scrollTop).toBe(3 * 28);
      fireEvent.keyDown(tree, { key: "3" });
      select("ArrowUp", rootId);
      expect(tree.scrollTop).toBe(0);
      view.unmount();
    } finally {
      runtime.destroy();
    }
  });

  it("selects and toggles a clicked Group without opening a Note or stealing Tree focus", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const group = await runtime.createNamespaceGroup(null, "Group");
      await runtime.createNamespaceGroup(group.entryId, "Child group");
      const props = treeProps(runtime);
      const view = render(<WorkspaceTree {...props} />);
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const row = screen
        .getByText("Group")
        .closest<HTMLElement>('[role="treeitem"]')!;
      fireEvent.keyDown(tree, { key: "3" });
      fireEvent.mouseDown(row);
      fireEvent.click(row);
      expect(selectedId(tree)).toBe(`tree-note-${group.entryId}`);
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Child group")).toBeNull();
      expect(document.activeElement).toBe(tree);
      await waitFor(() =>
        expect(
          activeTab(runtime.snapshot().applicationWindow).leftSidebar.tree,
        ).toMatchObject({
          selectedEntryId: group.entryId,
          collapsedEntryIds: [group.entryId],
        }),
      );
      // Clicking clears any unfinished keyboard count, so Enter still opens.
      fireEvent.keyDown(tree, { key: "Enter" });
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("Child group")).toBeTruthy();
      expect(props.onOpenNote).not.toHaveBeenCalled();
      expect(props.onRequestEditorFocus).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      runtime.destroy();
    }
  });

  it("keeps Tree focus and reports an error when a clicked Note cannot open", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    try {
      const props = treeProps(runtime);
      props.onOpenNote = vi.fn(async () => {
        throw new Error("Cannot open Note");
      });
      const view = render(<WorkspaceTree {...props} />);
      const tree = screen.getByRole("tree", { name: "ノートツリー" });
      const row = tree.querySelector('[role="treeitem"]')!;
      fireEvent.mouseDown(row);
      fireEvent.click(row);
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Cannot open Note",
      );
      expect(document.activeElement).toBe(tree);
      expect(props.onRequestEditorFocus).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      runtime.destroy();
    }
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
