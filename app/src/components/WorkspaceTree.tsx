import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { activeTab } from "../core/application-state";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
} from "../core/application-key-config";
import { noteDisplayTitle } from "../core/documents";
import {
  deriveVisibleNoteTree,
  type TreeMoveDirection,
} from "../core/note-tree";
import {
  advanceTreeInput,
  createTreeInputState,
  type TreeCommandId,
} from "../core/tree-keymap";
import type { CoreRuntime, RuntimeSnapshot } from "../core/runtime";
import { focusSurfaceFromPointer } from "./focus-surface";

const TREE_ROW_HEIGHT_PX = 28;
const TREE_OVERSCAN_ROWS = 8;
const DEFAULT_VIEWPORT_ROWS = 10;

export interface WorkspaceTreeProps {
  runtime: CoreRuntime;
  snapshot: RuntimeSnapshot;
  targetWindowId: string;
  focusRequest: number;
  onOpenNote: (windowId: string, noteId: string) => Promise<void>;
  onRequestEditorFocus: (windowId: string) => void;
  onOpenTrash: () => void;
  onClose: () => void;
  onFocus: () => void | Promise<void>;
  focused?: boolean;
  keyConfig?: ApplicationKeyConfig;
  onApplicationKeyDown?: (event: KeyboardEvent<HTMLElement>) => boolean;
}

export function WorkspaceTree({
  runtime,
  snapshot,
  targetWindowId,
  focusRequest,
  onOpenNote,
  onRequestEditorFocus,
  onOpenTrash,
  onClose,
  onFocus,
  focused = true,
  keyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
  onApplicationKeyDown,
}: WorkspaceTreeProps) {
  const root = useRef<HTMLDivElement>(null);
  const inputState = useRef(createTreeInputState());
  const tab = activeTab(snapshot.applicationWindow);
  const treeState = tab.leftSidebar.tree;
  const [localTreeState, setLocalTreeState] = useState(() => ({
    source: treeState,
    selectedNoteId: treeState.selectedNoteId,
    collapsedNoteIds: treeState.collapsedNoteIds,
  }));
  if (localTreeState.source !== treeState) {
    setLocalTreeState({
      source: treeState,
      selectedNoteId: treeState.selectedNoteId,
      collapsedNoteIds: treeState.collapsedNoteIds,
    });
  }
  const localSelectedNoteId = localTreeState.selectedNoteId;
  const localCollapsedNoteIds = localTreeState.collapsedNoteIds;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    TREE_ROW_HEIGHT_PX * DEFAULT_VIEWPORT_ROWS,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const collapsed = useMemo(
    () => new Set(localCollapsedNoteIds),
    [localCollapsedNoteIds],
  );
  const entries = useMemo(
    () => deriveVisibleNoteTree(snapshot.notes, collapsed),
    [snapshot.notes, collapsed],
  );
  const selectedNoteId = entries.some(
    (entry) => entry.note.noteId === localSelectedNoteId,
  )
    ? localSelectedNoteId
    : (entries[0]?.note.noteId ?? null);
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.note.noteId === selectedNoteId),
  );
  const firstVisible = Math.max(
    0,
    Math.floor(scrollTop / TREE_ROW_HEIGHT_PX) - TREE_OVERSCAN_ROWS,
  );
  const lastVisible = Math.min(
    entries.length,
    Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT_PX) +
      TREE_OVERSCAN_ROWS,
  );
  const visibleEntries = entries.slice(firstVisible, lastVisible);

  useEffect(() => {
    if (focusRequest > 0) root.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element || selectedNoteId === null || entries.length === 0) return;
    const top = selectedIndex * TREE_ROW_HEIGHT_PX;
    const bottom = top + TREE_ROW_HEIGHT_PX;
    let nextScrollTop = element.scrollTop;
    if (top < element.scrollTop) nextScrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      nextScrollTop = Math.max(0, bottom - element.clientHeight);
    }
    if (nextScrollTop !== element.scrollTop) element.scrollTop = nextScrollTop;
    setScrollTop((current) =>
      current === nextScrollTop ? current : nextScrollTop,
    );
  }, [entries.length, selectedIndex, selectedNoteId]);

  const showError = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const persistTree = (
    selected: string | null,
    collapsedNoteIds = localCollapsedNoteIds,
  ): void => {
    setLocalTreeState({
      source: treeState,
      selectedNoteId: selected,
      collapsedNoteIds,
    });
    void runtime
      .updateSidebar({
        side: "left",
        tree: { selectedNoteId: selected, collapsedNoteIds },
      })
      .catch(showError);
  };

  const setCollapsed = (noteId: string, shouldCollapse: boolean): void => {
    const next = new Set(localCollapsedNoteIds);
    if (shouldCollapse) next.add(noteId);
    else next.delete(noteId);
    persistTree(selectedNoteId, [...next].sort());
  };

  const selectIndex = (index: number): void => {
    const bounded = Math.max(0, Math.min(entries.length - 1, index));
    persistTree(entries[bounded]?.note.noteId ?? null);
  };

  const openSelected = async (): Promise<void> => {
    if (!selectedNoteId) return;
    await run(() => onOpenNote(targetWindowId, selectedNoteId));
    onRequestEditorFocus(targetWindowId);
  };

  const create = async (kind: "root" | "child" | "sibling"): Promise<void> => {
    if (kind !== "root" && !selectedNoteId) return;
    await run(async () => {
      const result =
        kind === "root"
          ? await runtime.createRootNote(targetWindowId)
          : kind === "child"
            ? await runtime.createChildNote(targetWindowId, selectedNoteId!)
            : await runtime.createSiblingNote(targetWindowId, selectedNoteId!);
      const nextCollapsed = new Set(localCollapsedNoteIds);
      if (kind === "child" && selectedNoteId) {
        nextCollapsed.delete(selectedNoteId);
      }
      await runtime.updateSidebar({
        side: "left",
        tree: {
          selectedNoteId: result.noteId,
          collapsedNoteIds: [...nextCollapsed].sort(),
        },
      });
      onRequestEditorFocus(targetWindowId);
    });
  };

  const move = async (
    direction: TreeMoveDirection,
    count: number,
  ): Promise<void> => {
    if (!selectedNoteId) return;
    await run(async () => {
      for (let index = 0; index < count; index += 1) {
        const result = await runtime.moveNoteInTree(selectedNoteId, direction);
        if (!result.changed) break;
      }
      if (direction === "indent") {
        const moved = runtime
          .snapshot()
          .notes.find((note) => note.noteId === selectedNoteId);
        if (moved?.parentNoteId) {
          const next = new Set(localCollapsedNoteIds);
          next.delete(moved.parentNoteId);
          await runtime.updateSidebar({
            side: "left",
            tree: { collapsedNoteIds: [...next].sort() },
          });
        }
      }
    });
  };

  const trash = async (): Promise<void> => {
    if (!selectedNoteId) return;
    await run(async () => {
      const result = await runtime.moveNoteToTrash(selectedNoteId);
      setLocalTreeState((current) => ({
        ...current,
        selectedNoteId: result.fallbackNoteId,
      }));
    });
  };

  const execute = (
    command: TreeCommandId,
    count: number,
    countExplicit: boolean,
  ): void => {
    const selected = entries[selectedIndex] ?? null;
    switch (command) {
      case "cursor.logical-down":
        selectIndex(selectedIndex + count);
        return;
      case "cursor.logical-up":
        selectIndex(selectedIndex - count);
        return;
      case "cursor.document-start":
        selectIndex(count - 1);
        return;
      case "cursor.document-end":
        selectIndex(countExplicit ? count - 1 : entries.length - 1);
        return;
      case "cursor.page-down":
      case "cursor.page-up":
      case "cursor.half-page-down":
      case "cursor.half-page-up": {
        const rows = Math.max(
          1,
          Math.floor(
            (root.current?.clientHeight ?? viewportHeight) / TREE_ROW_HEIGHT_PX,
          ),
        );
        const page = command.includes("half")
          ? Math.max(1, Math.floor(rows / 2))
          : Math.max(1, rows - 2);
        const direction = command.endsWith("down") ? 1 : -1;
        selectIndex(selectedIndex + direction * page * count);
        return;
      }
      case "cursor.left":
        if (selected?.hasChildren && selected.expanded) {
          setCollapsed(selected.note.noteId, true);
        } else if (selected?.note.parentNoteId) {
          persistTree(selected.note.parentNoteId);
        }
        return;
      case "cursor.right":
        if (selected?.hasChildren && !selected.expanded) {
          setCollapsed(selected.note.noteId, false);
        } else if (selected?.hasChildren) {
          persistTree(
            entries[selectedIndex + 1]?.note.noteId ?? selectedNoteId,
          );
        }
        return;
      case "note.open":
        void openSelected();
        return;
      case "note.create_root":
        void create("root");
        return;
      case "note.create_child":
        void create("child");
        return;
      case "note.create_sibling_after":
        void create("sibling");
        return;
      case "note.move_up":
        void move("up", count);
        return;
      case "note.move_down":
        void move("down", count);
        return;
      case "note.move_outdent":
        void move("outdent", count);
        return;
      case "note.move_indent":
        void move("indent", count);
        return;
      case "note.move_to_trash":
        void trash();
        return;
      case "trash.open":
        onOpenTrash();
        return;
      case "sidebar.close":
        onClose();
    }
  };

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className={`workspace-sidebar workspace-tree focus-surface${focused ? " focus-surface--focused" : ""}`}
      aria-label="Tree"
      data-memoka-focus-surface="left-sidebar"
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) =>
        focusSurfaceFromPointer(event.target, root.current)
      }
    >
      <div
        ref={root}
        className="note-tree"
        role="tree"
        aria-label="ノートツリー"
        tabIndex={0}
        aria-activedescendant={
          selectedNoteId ? `tree-note-${selectedNoteId}` : undefined
        }
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if (onApplicationKeyDown?.(event)) return;
          if (busy) return;
          const resolution = advanceTreeInput(
            inputState.current,
            event.nativeEvent,
            keyConfig,
          );
          inputState.current = resolution.state;
          if (resolution.consume) event.preventDefault();
          if (resolution.kind === "execute") {
            execute(
              resolution.command,
              resolution.count,
              resolution.countExplicit,
            );
          }
        }}
      >
        <div
          className="note-tree-spacer"
          style={{ height: entries.length * TREE_ROW_HEIGHT_PX }}
        >
          {visibleEntries.map((entry, offset) => {
            const index = firstVisible + offset;
            const selected = entry.note.noteId === selectedNoteId;
            return (
              <div
                id={`tree-note-${entry.note.noteId}`}
                key={entry.note.noteId}
                className={`note-tree-row${selected ? " note-tree-row--selected" : ""}`}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-selected={selected}
                aria-expanded={entry.hasChildren ? entry.expanded : undefined}
                style={
                  {
                    "--tree-depth": entry.depth,
                    top: index * TREE_ROW_HEIGHT_PX,
                    height: TREE_ROW_HEIGHT_PX,
                  } as CSSProperties
                }
              >
                <span className="tree-disclosure" aria-hidden="true">
                  {entry.hasChildren ? (entry.expanded ? "▾" : "▸") : "·"}
                </span>
                <span className="tree-title">
                  {noteDisplayTitle(entry.note.title)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <p className="utility-error" role="alert">
          {error}
        </p>
      )}
      <div className="utility-statusline">TREE</div>
    </aside>
  );
}
