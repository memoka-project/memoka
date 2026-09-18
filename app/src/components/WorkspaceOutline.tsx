import { SymbolText } from "./SymbolText";
import { TreeIcon } from "./tree-presentation";
import { treeGuides } from "../core/tree-guides";
import {
  foldSidebarSubtree,
  foldNoteRootSections,
  isSidebarFoldCommand,
  type SidebarFoldCommand,
} from "../core/sidebar-folding";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { outlineKeySequence, outlineKeymap } from "../core/outline-keymap";
import {
  deriveNoteOutline,
  nearestVisibleOutlineSectionId,
  visibleNoteOutlineEntries,
} from "../core/outline";
import { focusSurfaceFromPointer } from "./focus-surface";
import type { OutlineSidebarViewState } from "../core/application-state";
import { markupHeadingLevelForSectionDepth } from "../core/application-theme";
import { navigateSidebar } from "../core/sidebar-navigation";
import { advanceTreeInput, createTreeInputState } from "../core/tree-keymap";
import { createSidebarJumpList, type JumpHistory } from "../core/jump-list";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  type ApplicationKeyConfig,
} from "../core/application-key-config";

export function WorkspaceOutline({
  note,
  scopeSectionId,
  collapsedSectionIds = [],
  focusRequest,
  onJump,
  onFoldsChange,
  onClose,
  onFocus,
  onApplicationKeyDown,
  viewState,
  onViewStateChange,
  focused = true,
  keyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
  jumpList,
}: {
  note: Parameters<typeof deriveNoteOutline>[0];
  scopeSectionId?: string;
  collapsedSectionIds?: readonly string[];
  focusRequest: number;
  onJump: (sectionId: string) => Promise<void>;
  onFoldsChange?: (ids: readonly string[]) => Promise<void>;
  onClose: () => void;
  onFocus: () => void;
  onApplicationKeyDown?: (event: KeyboardEvent<HTMLElement>) => boolean;
  viewState?: OutlineSidebarViewState;
  onViewStateChange?: (viewState: OutlineSidebarViewState) => void;
  focused?: boolean;
  keyConfig?: ApplicationKeyConfig;
  jumpList?: JumpHistory<string>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const inputState = useRef(createTreeInputState());
  const localHistory = useRef(createSidebarJumpList());
  const history = jumpList ?? localHistory.current;
  const explicitScroll = useRef(false);
  const selectedRowElement = useRef<HTMLDivElement>(null);
  const allEntries = deriveNoteOutline(note, scopeSectionId);
  const collapsed = new Set(
    collapsedSectionIds.filter((id) => id !== note.noteId),
  );
  const entries = visibleNoteOutlineEntries(allEntries, collapsed);
  const visualDepthOffset = allEntries[0]?.sectionId === note.noteId ? 1 : 0;
  const parentIds = new Set(allEntries.map((entry) => entry.parentSectionId));
  const guides = treeGuides(
    entries.map((entry) => ({
      id: entry.sectionId,
      depth: entry.depth,
      hasChildren:
        entry.sectionId !== note.noteId && parentIds.has(entry.sectionId),
      expanded: !collapsed.has(entry.sectionId),
    })),
  );
  const firstSectionId = entries[0]?.sectionId ?? "";
  const resolvedSectionId =
    viewState?.noteId === note.noteId
      ? nearestVisibleOutlineSectionId(
          allEntries,
          entries,
          viewState.selectedSectionId,
        )
      : firstSectionId;
  const [localSelection, setLocalSelection] = useState({
    externalSectionId: resolvedSectionId,
    selectedSectionId: resolvedSectionId,
  });
  const selectedSectionId =
    localSelection.externalSectionId === resolvedSectionId
      ? localSelection.selectedSectionId
      : resolvedSectionId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected =
    entries.find(({ sectionId }) => sectionId === selectedSectionId) ??
    entries[0] ??
    null;

  useEffect(() => {
    if (focusRequest > 0) root.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    inputState.current = createTreeInputState();
    localHistory.current.clear();
  }, [note.noteId]);

  useEffect(() => {
    if (explicitScroll.current) {
      explicitScroll.current = false;
      return;
    }
    selectedRowElement.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [selected?.sectionId]);

  const selectSection = (sectionId: string): void => {
    setLocalSelection({
      externalSectionId: resolvedSectionId,
      selectedSectionId: sectionId,
    });
    onViewStateChange?.({
      noteId: note.noteId,
      selectedSectionId: sectionId || null,
    });
  };

  const jump = async (sectionId = selected?.sectionId): Promise<void> => {
    if (!sectionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onJump(sectionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const fold = (sectionId: string, command: SidebarFoldCommand): void => {
    if (busy || !onFoldsChange) return;
    if (sectionId === note.noteId && command.startsWith("fold.toggle")) return;
    const ids =
      sectionId === note.noteId
        ? foldNoteRootSections(
            allEntries.map((entry) => ({
              id: entry.sectionId,
              depth: entry.depth,
            })),
            note.noteId,
            collapsedSectionIds,
            command.slice("fold.".length),
          )
        : foldSidebarSubtree(
            allEntries.map((entry) => ({
              id: entry.sectionId,
              depth: entry.depth,
              foldable: true,
            })),
            sectionId,
            collapsedSectionIds,
            command,
          );
    setBusy(true);
    setError(null);
    void onFoldsChange(ids)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
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
      true,
    );
    inputState.current = resolution.state;
    if (resolution.consume) event.preventDefault();
    if (resolution.kind === "execute") {
      if (isSidebarFoldCommand(resolution.command)) {
        if (selected) fold(selected.sectionId, resolution.command);
        return;
      }
      const element = root.current;
      if (!element) return;
      const viewport = element.getBoundingClientRect();
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>(".outline-row"),
      );
      const items = entries.map((entry, i) => {
        const rect = rows[i]?.getBoundingClientRect();
        const top =
          rect && rect.height > 0
            ? rect.top - viewport.top + element.scrollTop
            : i * 30;
        return {
          id: entry.sectionId,
          parentId: entry.parentSectionId,
          top,
          bottom: top + (rect?.height || 30),
        };
      });
      const result = navigateSidebar({
        command: resolution.command,
        count: resolution.count,
        countExplicit: resolution.countExplicit,
        items,
        selectedId: selected?.sectionId ?? null,
        scrollTop: element.scrollTop,
        height: element.clientHeight || 300,
        scrollHeight: element.scrollHeight || items.at(-1)?.bottom || 0,
        history,
        resolveHistoryId: (id) =>
          allEntries.some((entry) => entry.sectionId === id)
            ? nearestVisibleOutlineSectionId(allEntries, entries, id) || null
            : null,
      });
      if (result) {
        element.scrollTop = result.scrollTop;
        if (result.selectedId !== selected?.sectionId) {
          explicitScroll.current =
            resolution.command.startsWith("viewport.") ||
            resolution.command.includes("page-") ||
            resolution.command.startsWith("cursor.screen-");
          selectSection(result.selectedId);
        }
      }
      return;
    }
    if (resolution.consume) return;
    const sequence = outlineKeySequence(event);
    if (!sequence) return;
    const command = outlineKeymap.resolve("outline.normal", sequence);
    if (
      !command ||
      command === "outline.select_next" ||
      command === "outline.select_previous"
    )
      return;
    event.preventDefault();
    if (command === "outline.close") onClose();
    else void jump();
  };

  return (
    <aside
      className={`workspace-outline focus-surface${focused ? " focus-surface--focused" : ""}`}
      aria-label="Outline"
      data-memoka-focus-surface="right-sidebar"
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) =>
        focusSurfaceFromPointer(event.target, root.current)
      }
    >
      <div
        ref={root}
        className="outline-list"
        role="tree"
        tabIndex={0}
        aria-label="Sectionアウトライン"
        aria-activedescendant={
          selected ? `outline-section-${selected.sectionId}` : undefined
        }
        onKeyDown={handleKeyDown}
        onBlur={() => {
          inputState.current = createTreeInputState();
        }}
      >
        <div className="outline-content">
          {entries.map((entry) => {
            const selectedRow = entry.sectionId === selected?.sectionId;
            const folded = collapsed.has(entry.sectionId);
            return (
              <div
                ref={selectedRow ? selectedRowElement : undefined}
                id={`outline-section-${entry.sectionId}`}
                key={entry.sectionId}
                className={`outline-row${selectedRow ? " outline-row--selected" : ""}`}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-selected={selectedRow}
                aria-expanded={
                  entry.sectionId === note.noteId ? undefined : !folded
                }
                data-memoka-markup-heading={markupHeadingLevelForSectionDepth(
                  entry.noteDepth,
                )}
                style={
                  {
                    "--outline-level": Math.max(
                      0,
                      entry.depth - visualDepthOffset,
                    ),
                  } as CSSProperties
                }
                onClick={() => {
                  inputState.current = createTreeInputState();
                  if (selectedRow) void jump(entry.sectionId);
                  else selectSection(entry.sectionId);
                }}
              >
                {entry.sectionId !== note.noteId && (
                  <button
                    type="button"
                    className="tree-disclosure outline-fold-state"
                    tabIndex={-1}
                    aria-label={`${entry.title}を${folded ? "展開する" : "折り畳む"}`}
                    aria-expanded={!folded}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.detail > 1) return;
                      inputState.current = createTreeInputState();
                      selectSection(entry.sectionId);
                      fold(entry.sectionId, "fold.toggle");
                      root.current?.focus();
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <TreeIcon
                      name={folded ? "chevron-right" : "chevron-down"}
                    />
                  </button>
                )}
                <span className="outline-title">
                  <SymbolText text={entry.title} />
                </span>
              </div>
            );
          })}
          <div className="tree-guides" aria-hidden="true">
            {guides.map((guide) => (
              <span
                key={guide.id}
                className="tree-guide"
                data-outline-guide={guide.id}
                style={
                  {
                    "--tree-depth": Math.max(
                      0,
                      guide.depth - visualDepthOffset,
                    ),
                    top: guide.start * 30,
                    height: (guide.end - guide.start) * 30,
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
