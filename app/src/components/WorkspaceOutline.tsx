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
  const collapsed = new Set(collapsedSectionIds);
  const entries = visibleNoteOutlineEntries(allEntries, collapsed);
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
            : i * 28;
        return {
          id: entry.sectionId,
          parentId: entry.parentSectionId,
          top,
          bottom: top + (rect?.height || 28),
        };
      });
      const result = navigateSidebar({
        command: resolution.command,
        count: resolution.count,
        countExplicit: resolution.countExplicit,
        items,
        selectedId: selected?.sectionId ?? null,
        scrollTop: element.scrollTop,
        height: element.clientHeight || 280,
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
              aria-expanded={!folded}
              data-memoka-markup-heading={markupHeadingLevelForSectionDepth(
                entry.noteDepth,
              )}
              style={{ "--outline-level": entry.depth } as CSSProperties}
              onClick={() => {
                selectSection(entry.sectionId);
                void jump(entry.sectionId);
              }}
            >
              <span className="outline-fold-state" aria-hidden="true">
                {folded ? "▸" : "▾"}
              </span>
              <span className="outline-title">{entry.title}</span>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="utility-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
