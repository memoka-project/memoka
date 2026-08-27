import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  outlineKeySequence,
  outlineKeymap,
  type OutlineCommandId,
} from "../core/outline-keymap";
import { deriveNoteOutline } from "../core/outline";
import { focusSurfaceFromPointer } from "./focus-surface";
import type { OutlineSidebarViewState } from "../core/application-state";

export function WorkspaceOutline({
  note,
  scopeSectionId,
  focusRequest,
  onJump,
  onClose,
  onFocus,
  onApplicationKeyDown,
  viewState,
  onViewStateChange,
  focused = true,
}: {
  note: Parameters<typeof deriveNoteOutline>[0];
  scopeSectionId?: string;
  focusRequest: number;
  onJump: (sectionId: string) => Promise<void>;
  onClose: () => void;
  onFocus: () => void;
  onApplicationKeyDown?: (event: KeyboardEvent<HTMLElement>) => boolean;
  viewState?: OutlineSidebarViewState;
  onViewStateChange?: (viewState: OutlineSidebarViewState) => void;
  focused?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const selectedRowElement = useRef<HTMLDivElement>(null);
  const entries = deriveNoteOutline(note, scopeSectionId);
  const firstSectionId = entries[0]?.sectionId ?? "";
  const resolvedSectionId =
    viewState?.noteId === note.noteId &&
    entries.some(({ sectionId }) => sectionId === viewState.selectedSectionId)
      ? (viewState.selectedSectionId ?? firstSectionId)
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

  const handleCommand = (command: OutlineCommandId): void => {
    const index = Math.max(
      0,
      entries.findIndex(({ sectionId }) => sectionId === selected?.sectionId),
    );
    if (command === "outline.close") onClose();
    else if (command === "outline.jump") void jump();
    else if (command === "outline.select_next") {
      selectSection(
        entries[Math.min(index + 1, entries.length - 1)]?.sectionId ?? "",
      );
    } else {
      selectSection(entries[Math.max(0, index - 1)]?.sectionId ?? "");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onApplicationKeyDown?.(event)) return;
    if (busy) return;
    const sequence = outlineKeySequence(event);
    if (!sequence) return;
    const command = outlineKeymap.resolve("outline.normal", sequence);
    if (!command) return;
    event.preventDefault();
    handleCommand(command);
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
      >
        {entries.map((entry) => {
          const selectedRow = entry.sectionId === selected?.sectionId;
          return (
            <div
              ref={selectedRow ? selectedRowElement : undefined}
              id={`outline-section-${entry.sectionId}`}
              key={entry.sectionId}
              className={`outline-row${selectedRow ? " outline-row--selected" : ""}`}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-selected={selectedRow}
              style={{ "--outline-level": entry.depth } as CSSProperties}
              onClick={() => {
                selectSection(entry.sectionId);
                void jump(entry.sectionId);
              }}
            >
              <span className="outline-level">§{entry.depth}</span>
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
      <div className="utility-statusline">OUTLINE</div>
    </aside>
  );
}
