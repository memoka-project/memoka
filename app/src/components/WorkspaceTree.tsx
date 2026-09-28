import { SymbolText } from "./SymbolText";
import { TreeIcon } from "./tree-presentation";
import { treeGuides } from "../core/tree-guides";
import {
  foldSidebarSubtree,
  isSidebarFoldCommand,
} from "../core/sidebar-folding";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { ALL_NOTES_TREE_ENTRY_ID, activeTab } from "../core/application-state";
import { ALL_NOTES_TITLE } from "../core/all-notes";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
} from "../core/application-key-config";
import { noteDisplayTitle } from "../core/documents";
import {
  activeNoteContextNodes,
  treeVisibleNamespaceNodes,
} from "../core/namespace";
import {
  deriveVisibleNoteTree,
  type TreeMoveDirection,
  type VisibleNoteTreeEntry,
} from "../core/note-tree";
import {
  advanceTreeInput,
  createTreeInputState,
  type TreeCommandId,
} from "../core/tree-keymap";
import type { CoreRuntime, RuntimeSnapshot } from "../core/runtime";
import { focusSurfaceFromPointer } from "./focus-surface";
import { navigateSidebar } from "../core/sidebar-navigation";

const TREE_ROW_HEIGHT_PX = 30;
const TREE_SEPARATOR_HEIGHT_PX = TREE_ROW_HEIGHT_PX / 2;
const TREE_OVERSCAN_ROWS = 8;
const DEFAULT_VIEWPORT_ROWS = 10;
type TreeRegion = "context" | "root";
interface TreeRow extends VisibleNoteTreeEntry {
  readonly rowId: string;
  readonly region: TreeRegion;
  readonly separator?: boolean;
}

function separatorRow(id: string): TreeRow {
  return {
    rowId: id,
    region: "root",
    separator: true,
    note: {
      noteId: id,
      parentNoteId: null,
      notePosition: "",
      createdAt: "",
      updatedAt: "",
      title: "",
    },
    depth: 0,
    hasChildren: false,
    expanded: true,
  };
}

function rowIndexAtOffset(
  offsets: readonly number[],
  position: number,
): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= position) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, offsets.length - 2);
}

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
    selectedEntryId: treeState.selectedEntryId,
    selectedRegion: treeState.selectedRegion ?? ("root" as TreeRegion),
    collapsedEntryIds: treeState.collapsedEntryIds,
    contextCollapsedEntryIds: treeState.contextCollapsedEntryIds ?? [],
  }));
  if (localTreeState.source !== treeState) {
    setLocalTreeState({
      source: treeState,
      selectedEntryId: treeState.selectedEntryId,
      selectedRegion: treeState.selectedRegion ?? "root",
      collapsedEntryIds: treeState.collapsedEntryIds,
      contextCollapsedEntryIds: treeState.contextCollapsedEntryIds ?? [],
    });
  }
  const localSelectedNoteId = localTreeState.selectedEntryId;
  const localSelectedRegion = localTreeState.selectedRegion;
  const localCollapsedNoteIds = localTreeState.collapsedEntryIds;
  const localContextCollapsedEntryIds = localTreeState.contextCollapsedEntryIds;
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
  const contextCollapsed = useMemo(
    () => new Set(localContextCollapsedEntryIds),
    [localContextCollapsedEntryIds],
  );
  const activeNoteId =
    snapshot.windows.find(
      (window) =>
        window.windowId === targetWindowId && window.bufferKind === "note",
    )?.noteId ?? null;
  const contextEntries = useMemo(
    () => activeNoteContextNodes(snapshot.namespaceEntries, activeNoteId),
    [snapshot.namespaceEntries, activeNoteId],
  );
  const activeContextEntryId = contextEntries.find(
    (entry) => entry.targetNoteId === activeNoteId,
  )?.entryId;
  const contextPathEntryIds = useMemo(() => {
    const byId = new Map(contextEntries.map((entry) => [entry.entryId, entry]));
    const path = new Set<string>();
    let entryId: string | null = activeContextEntryId ?? null;
    while (entryId && !path.has(entryId)) {
      path.add(entryId);
      entryId = byId.get(entryId)?.parentNoteId ?? null;
    }
    return path;
  }, [contextEntries, activeContextEntryId]);
  const treeEntries = useMemo(
    () => treeVisibleNamespaceNodes(snapshot.namespaceEntries),
    [snapshot.namespaceEntries],
  );
  const entries = useMemo((): TreeRow[] => {
    const contextRows = deriveVisibleNoteTree(
      contextEntries,
      contextCollapsed,
    ).map((entry): TreeRow => ({
      ...entry,
      rowId: `tree-context-${entry.note.noteId}`,
      region: "context",
    }));
    const rootRows = deriveVisibleNoteTree(treeEntries, collapsed).map(
      (entry): TreeRow => ({
        ...entry,
        rowId: `tree-note-${entry.note.noteId}`,
        region: "root",
      }),
    );
    return [
      {
        rowId: `tree-note-${ALL_NOTES_TREE_ENTRY_ID}`,
        region: "root",
        note: {
          noteId: ALL_NOTES_TREE_ENTRY_ID,
          parentNoteId: null,
          notePosition: "",
          createdAt: "",
          updatedAt: "",
          title: ALL_NOTES_TITLE,
        },
        depth: 0,
        hasChildren: false,
        expanded: true,
      },
      ...(contextRows.length || rootRows.length
        ? [separatorRow("tree-separator-all-notes")]
        : []),
      ...(contextRows.length
        ? [
            ...contextRows,
            ...(rootRows.length
              ? [separatorRow("tree-separator-context")]
              : []),
          ]
        : []),
      ...rootRows,
    ];
  }, [contextEntries, contextCollapsed, treeEntries, collapsed]);
  const rowOffsets = useMemo(() => {
    const offsets = [0];
    for (const entry of entries)
      offsets.push(
        offsets[offsets.length - 1]! +
          (entry.separator ? TREE_SEPARATOR_HEIGHT_PX : TREE_ROW_HEIGHT_PX),
      );
    return offsets;
  }, [entries]);
  const selectedRow =
    entries.find(
      (entry) =>
        !entry.separator &&
        entry.note.noteId === localSelectedNoteId &&
        entry.region === localSelectedRegion,
    ) ??
    entries.find(
      (entry) => !entry.separator && entry.note.noteId === localSelectedNoteId,
    ) ??
    (localSelectedNoteId
      ? entries.find(
          (entry) =>
            entry.region === "context" &&
            entry.note.noteId === activeContextEntryId,
        )
      : null) ??
    entries[0]!;
  const selectedEntryId = selectedRow.note.noteId;
  const selectedRegion = selectedRow.region;
  const selectedRowId = selectedRow.rowId;
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.rowId === selectedRowId),
  );
  const firstVisible = Math.max(
    0,
    rowIndexAtOffset(rowOffsets, scrollTop) - TREE_OVERSCAN_ROWS,
  );
  const lastVisible = Math.min(
    entries.length,
    rowIndexAtOffset(rowOffsets, scrollTop + viewportHeight) +
      1 +
      TREE_OVERSCAN_ROWS,
  );
  const visibleEntries = entries.slice(firstVisible, lastVisible);
  const guides = useMemo(
    () =>
      treeGuides(
        entries.map((entry) => ({
          ...entry,
          id: entry.region === "context" ? entry.rowId : entry.note.noteId,
        })),
      ),
    [entries],
  );
  const namespaceById = useMemo(
    () =>
      new Map(snapshot.namespaceEntries.map((entry) => [entry.entryId, entry])),
    [snapshot.namespaceEntries],
  );

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
    if (!element || entries.length === 0) return;
    const top = rowOffsets[selectedIndex]!;
    const bottom = rowOffsets[selectedIndex + 1]!;
    let nextScrollTop = element.scrollTop;
    if (top < element.scrollTop) nextScrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      nextScrollTop = Math.max(0, bottom - element.clientHeight);
    }
    if (nextScrollTop !== element.scrollTop) element.scrollTop = nextScrollTop;
    setScrollTop((current) =>
      current === nextScrollTop ? current : nextScrollTop,
    );
  }, [entries.length, rowOffsets, selectedIndex, selectedRowId]);

  const showError = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const persistTree = (
    selected: string | null,
    region: TreeRegion = selectedRegion,
    collapsedEntryIds = localCollapsedNoteIds,
    contextCollapsedEntryIds = localContextCollapsedEntryIds,
  ): void => {
    setLocalTreeState({
      source: treeState,
      selectedEntryId: selected,
      selectedRegion: region,
      collapsedEntryIds,
      contextCollapsedEntryIds,
    });
    void runtime
      .updateSidebar({
        side: "left",
        tree: {
          selectedEntryId: selected,
          selectedRegion: region,
          collapsedEntryIds,
          contextCollapsedEntryIds,
        },
      })
      .catch(showError);
  };

  const setCollapsed = (
    noteId: string,
    shouldCollapse: boolean,
    selected = selectedEntryId,
    region: TreeRegion = selectedRegion,
  ): void => {
    const next = new Set(
      region === "context"
        ? localContextCollapsedEntryIds
        : localCollapsedNoteIds,
    );
    if (shouldCollapse) next.add(noteId);
    else next.delete(noteId);
    persistTree(
      selected,
      region,
      region === "root" ? [...next].sort() : localCollapsedNoteIds,
      region === "context" ? [...next].sort() : localContextCollapsedEntryIds,
    );
  };

  const selectEntry = (entryId: string, region: TreeRegion): void => {
    inputState.current = createTreeInputState();
    if (entryId !== selectedEntryId || region !== selectedRegion)
      persistTree(entryId, region);
  };

  const openEntry = async (
    entryId: string | null,
    region: TreeRegion = selectedRegion,
  ): Promise<void> => {
    if (!entryId || busy) return;
    if (entryId === ALL_NOTES_TREE_ENTRY_ID) {
      if (entryId !== selectedEntryId || region !== selectedRegion)
        persistTree(entryId, region);
      await run(async () => {
        await runtime.openAllNotes(targetWindowId);
        onRequestEditorFocus(targetWindowId);
      });
      return;
    }
    const entry = namespaceById.get(entryId);
    if (!entry) return;
    inputState.current = createTreeInputState();
    const noteId = entry.targetNoteId;
    if (!noteId) {
      if (
        entries.find(
          (item) => item.note.noteId === entryId && item.region === region,
        )?.hasChildren
      ) {
        setCollapsed(
          entryId,
          !(region === "context" ? contextCollapsed : collapsed).has(entryId),
          entryId,
          region,
        );
      } else {
        selectEntry(entryId, region);
      }
      return;
    }
    if (entryId !== selectedEntryId || region !== selectedRegion)
      persistTree(entryId, region);
    await run(async () => {
      await onOpenNote(targetWindowId, noteId);
      onRequestEditorFocus(targetWindowId);
    });
  };

  const create = async (kind: "root" | "child" | "sibling"): Promise<void> => {
    if (
      (kind === "root" &&
        (selectedEntryId === ALL_NOTES_TREE_ENTRY_ID ||
          selectedRegion === "context")) ||
      (selectedRegion === "context" &&
        contextPathEntryIds.has(selectedEntryId) &&
        (kind === "sibling" || selectedEntryId !== activeContextEntryId))
    )
      return;
    if (
      kind !== "root" &&
      (!selectedEntryId || selectedEntryId === ALL_NOTES_TREE_ENTRY_ID)
    )
      return;
    await run(async () => {
      const result = await runtime.createNoteAtEntry(
        targetWindowId,
        selectedEntryId,
        kind,
      );
      const nextCollapsed = new Set(
        selectedRegion === "context"
          ? localContextCollapsedEntryIds
          : localCollapsedNoteIds,
      );
      if (kind === "child" && selectedEntryId) {
        nextCollapsed.delete(selectedEntryId);
      }
      await runtime.updateSidebar({
        side: "left",
        tree: {
          selectedEntryId:
            runtime
              .snapshot()
              .notes.find((note) => note.noteId === result.noteId)?.entryId ??
            null,
          selectedRegion,
          ...(selectedRegion === "context"
            ? { contextCollapsedEntryIds: [...nextCollapsed].sort() }
            : { collapsedEntryIds: [...nextCollapsed].sort() }),
        },
      });
      onRequestEditorFocus(targetWindowId);
    });
  };

  const move = async (
    direction: TreeMoveDirection,
    count: number,
  ): Promise<void> => {
    if (!selectedEntryId || selectedEntryId === ALL_NOTES_TREE_ENTRY_ID) return;
    await run(async () => {
      for (let index = 0; index < count; index += 1) {
        if (direction === "outdent" && selectedRegion === "context") {
          const entry = runtime
            .snapshot()
            .namespaceEntries.find((item) => item.entryId === selectedEntryId);
          if (
            contextPathEntryIds.has(selectedEntryId) ||
            entry?.parentNoteId === activeContextEntryId
          )
            break;
        }
        const result = await runtime.moveNamespaceEntry(
          selectedEntryId,
          direction,
        );
        if (!result.changed) break;
      }
      if (direction === "indent") {
        const moved = runtime
          .snapshot()
          .namespaceEntries.find((note) => note.entryId === selectedEntryId);
        if (moved?.parentNoteId) {
          const next = new Set(
            selectedRegion === "context"
              ? localContextCollapsedEntryIds
              : localCollapsedNoteIds,
          );
          next.delete(moved.parentNoteId);
          await runtime.updateSidebar({
            side: "left",
            tree:
              selectedRegion === "context"
                ? { contextCollapsedEntryIds: [...next].sort() }
                : { collapsedEntryIds: [...next].sort() },
          });
        }
      }
    });
  };

  const trash = async (): Promise<void> => {
    if (!selectedEntryId || selectedEntryId === ALL_NOTES_TREE_ENTRY_ID) return;
    if (
      selectedRegion === "context" &&
      selectedEntryId !== activeContextEntryId &&
      contextPathEntryIds.has(selectedEntryId)
    )
      return;
    await run(async () => {
      const result = await runtime.trashNamespaceEntry(selectedEntryId);
      setLocalTreeState((current) => ({
        ...current,
        selectedEntryId: result.fallbackEntryId,
      }));
    });
  };

  const execute = (
    command: TreeCommandId,
    count: number,
    countExplicit: boolean,
  ): void => {
    const selected = entries[selectedIndex] ?? null;
    if (isSidebarFoldCommand(command)) {
      if (selectedEntryId && selectedEntryId !== ALL_NOTES_TREE_ENTRY_ID) {
        const next = foldSidebarSubtree(
          deriveVisibleNoteTree(
            selectedRegion === "context" ? contextEntries : treeEntries,
          ).map((entry) => ({
            id: entry.note.noteId,
            depth: entry.depth,
            foldable: entry.hasChildren,
          })),
          selectedEntryId,
          selectedRegion === "context"
            ? localContextCollapsedEntryIds
            : localCollapsedNoteIds,
          command,
        );
        persistTree(
          selectedEntryId,
          selectedRegion,
          selectedRegion === "root" ? next : localCollapsedNoteIds,
          selectedRegion === "context" ? next : localContextCollapsedEntryIds,
        );
      }
      return;
    }
    if (command !== "cursor.left" && command !== "cursor.right") {
      const element = root.current;
      const result = navigateSidebar({
        command,
        count,
        countExplicit,
        items: entries.flatMap((entry, i) =>
          entry.separator
            ? []
            : [
                {
                  id: entry.rowId,
                  parentId: entry.note.parentNoteId
                    ? `${entry.region === "context" ? "tree-context" : "tree-note"}-${entry.note.parentNoteId}`
                    : null,
                  top: rowOffsets[i]!,
                  bottom: rowOffsets[i + 1]!,
                },
              ],
        ),
        selectedId: selectedRowId,
        scrollTop: element?.scrollTop ?? scrollTop,
        height: element?.clientHeight || viewportHeight,
        scrollHeight: rowOffsets[entries.length]!,
        history: runtime.sidebarJumpListFor(tab.id, "tree"),
        resolveHistoryId: (id) => {
          if (id === ALL_NOTES_TREE_ENTRY_ID)
            return `tree-note-${ALL_NOTES_TREE_ENTRY_ID}`;
          if (entries.some((item) => !item.separator && item.rowId === id))
            return id;
          const region: TreeRegion = id.startsWith("tree-context-")
            ? "context"
            : "root";
          const entryId = id.replace(/^tree-(?:context|note)-/u, "");
          let entry = namespaceById.get(entryId);
          while (entry) {
            const candidates = entries.filter(
              (item) => !item.separator && item.note.noteId === entry!.entryId,
            );
            const match =
              candidates.find((item) => item.region === region) ??
              candidates[0];
            if (match) return match.rowId;
            entry = entry.parentNoteId
              ? namespaceById.get(entry.parentNoteId)
              : undefined;
          }
          return null;
        },
      });
      if (result) {
        if (element) element.scrollTop = result.scrollTop;
        setScrollTop(result.scrollTop);
        if (result.selectedId !== selectedRowId) {
          const destination = entries.find(
            (entry) => entry.rowId === result.selectedId,
          );
          if (destination && !destination.separator)
            persistTree(destination.note.noteId, destination.region);
        }
        return;
      }
    }
    switch (command) {
      case "cursor.left":
        if (selected?.hasChildren && selected.expanded) {
          setCollapsed(selected.note.noteId, true);
        } else if (selected?.note.parentNoteId) {
          if (
            entries.some(
              (entry) =>
                entry.note.noteId === selected.note.parentNoteId &&
                entry.region === selectedRegion,
            )
          )
            persistTree(selected.note.parentNoteId, selectedRegion);
        }
        return;
      case "cursor.right":
        if (selected?.hasChildren && !selected.expanded) {
          setCollapsed(selected.note.noteId, false);
        } else if (selected?.hasChildren) {
          const child = entries[selectedIndex + 1];
          if (child?.region === selectedRegion && !child.separator)
            persistTree(child.note.noteId, selectedRegion);
        }
        return;
      case "note.open":
        void openEntry(selectedEntryId, selectedRegion);
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
        aria-activedescendant={selectedRowId}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            (inputState.current.pending.length || inputState.current.count)
          ) {
            inputState.current = createTreeInputState();
            event.preventDefault();
            onApplicationKeyDown?.(event);
            return;
          }
          if (onApplicationKeyDown?.(event)) {
            inputState.current = createTreeInputState();
            return;
          }
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
        onBlur={() => {
          inputState.current = createTreeInputState();
        }}
      >
        <div
          className="note-tree-spacer"
          style={{ height: rowOffsets[entries.length] }}
        >
          {visibleEntries.map((entry, offset) => {
            const index = firstVisible + offset;
            if (entry.separator)
              return (
                <div
                  key={entry.rowId}
                  className="note-tree-separator"
                  role="presentation"
                  aria-hidden="true"
                  style={{
                    top: rowOffsets[index],
                    height: TREE_SEPARATOR_HEIGHT_PX,
                  }}
                />
              );
            const selected = entry.rowId === selectedRowId;
            return (
              <div
                id={entry.rowId}
                key={entry.rowId}
                className={`note-tree-row${selected ? " note-tree-row--selected" : ""}`}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-selected={selected}
                aria-expanded={entry.hasChildren ? entry.expanded : undefined}
                onClick={() => {
                  if (selected) void openEntry(entry.note.noteId, entry.region);
                  else selectEntry(entry.note.noteId, entry.region);
                }}
                style={
                  {
                    "--tree-depth": entry.depth,
                    top: rowOffsets[index],
                    height: TREE_ROW_HEIGHT_PX,
                  } as CSSProperties
                }
              >
                {entry.hasChildren ? (
                  <button
                    type="button"
                    className="tree-disclosure"
                    tabIndex={-1}
                    aria-label={`${noteDisplayTitle(entry.note.title)}を${entry.expanded ? "折り畳む" : "展開する"}`}
                    aria-expanded={entry.expanded}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      inputState.current = createTreeInputState();
                      setCollapsed(
                        entry.note.noteId,
                        entry.expanded,
                        entry.note.noteId,
                        entry.region,
                      );
                      root.current?.focus();
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <TreeIcon
                      name={entry.expanded ? "chevron-down" : "chevron-right"}
                    />
                  </button>
                ) : (
                  <span className="tree-disclosure" aria-hidden="true" />
                )}
                <TreeIcon
                  name={
                    entry.note.noteId === ALL_NOTES_TREE_ENTRY_ID
                      ? "sheet"
                      : namespaceById.get(entry.note.noteId)?.targetNoteId
                        ? "file-text"
                        : entry.hasChildren && entry.expanded
                          ? "folder-open"
                          : "folder-closed"
                  }
                />
                <span className="tree-title">
                  <SymbolText text={noteDisplayTitle(entry.note.title)} />
                </span>
              </div>
            );
          })}
          <div className="tree-guides" aria-hidden="true">
            {guides
              .filter(
                (guide) =>
                  guide.start < lastVisible && guide.end > firstVisible,
              )
              .map((guide) => (
                <span
                  key={guide.id}
                  className="tree-guide"
                  data-tree-guide={guide.id}
                  style={
                    {
                      "--tree-depth": guide.depth,
                      top: rowOffsets[Math.max(guide.start, firstVisible)],
                      height:
                        rowOffsets[Math.min(guide.end, lastVisible)]! -
                        rowOffsets[Math.max(guide.start, firstVisible)]!,
                    } as CSSProperties
                  }
                />
              ))}
          </div>
        </div>
      </div>
      {error && (
        <p className="utility-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
