import { noteDisplayTitle, type NoteMetadata } from "../core/documents";
import {
  listTabWindowIds,
  type ApplicationWindowState,
  type BufferState,
  type TabPageState,
} from "../core/application-state";
import { tabShortcutKeyAtIndex } from "../core/tab-shortcuts";
import type { DesktopWindowPort } from "../platform/desktop-window";
import {
  ApplicationWindowControls,
  ApplicationWindowDragRegion,
  type WindowControlErrorHandler,
} from "./ApplicationWindowChrome";

export function ApplicationTabBar({
  state,
  notes,
  imageLabel = () => "Image",
  onSwitch,
  onCreate,
  onClose,
  desktopWindow,
  onWindowControlError,
}: {
  state: ApplicationWindowState;
  notes: readonly NoteMetadata[];
  imageLabel?: (attachmentId: string) => string;
  onSwitch: (tabId: string) => void;
  onCreate: () => void;
  onClose: (tabId: string) => void;
  desktopWindow: DesktopWindowPort | null;
  onWindowControlError: WindowControlErrorHandler;
}) {
  return (
    <nav className="application-tab-bar" aria-label="タブページ">
      <div className="application-tab-strip">
        <div className="application-tab-list" role="tablist">
          {state.tabs.map((tab, index) => {
            const active = tab.id === state.activeTabId;
            const windowCount = listTabWindowIds(state, tab.id).length;
            const label = tabLabel(tab, state, notes, imageLabel);
            const shortcutKey = tabShortcutKeyAtIndex(index);
            return (
              <div
                key={tab.id}
                className={`application-tab${active ? " application-tab--active" : ""}`}
                data-tab-id={tab.id}
                data-tab-shortcut={
                  shortcutKey === null ? undefined : `t${shortcutKey}`
                }
              >
                <button
                  type="button"
                  className="application-tab-select"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={`${shortcutKey === null ? "" : `t${shortcutKey} · `}${label} · ${windowCount} Window`}
                  onClick={() => onSwitch(tab.id)}
                >
                  {shortcutKey !== null && (
                    <span className="application-tab-index">{shortcutKey}</span>
                  )}
                  <span className="application-tab-title">{label}</span>
                  {windowCount > 1 && (
                    <span className="application-tab-window-count">
                      {windowCount}W
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="application-tab-close"
                  aria-label={`${label}のTabPageを閉じる`}
                  title="TabPageを閉じる"
                  disabled={state.tabs.length === 1}
                  onClick={() => onClose(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="application-tab-create"
          aria-label="新しいTabPage"
          title="空のTabPageを作る"
          onClick={onCreate}
        >
          ＋
        </button>
        <ApplicationWindowDragRegion
          desktopWindow={desktopWindow}
          onError={onWindowControlError}
        />
      </div>
      <ApplicationWindowControls
        desktopWindow={desktopWindow}
        onError={onWindowControlError}
      />
    </nav>
  );
}

function tabLabel(
  tab: TabPageState,
  state: ApplicationWindowState,
  notes: readonly NoteMetadata[],
  imageLabel: (attachmentId: string) => string,
): string {
  const window = state.windows[tab.activeWindowId];
  if (!window || window.bufferId === null) return "[No Buffer]";
  const buffer = state.buffers[window.bufferId];
  if (!buffer) return "[No Buffer]";
  const noteId = contentBufferNoteId(buffer);
  const title = noteId
    ? notes.find((note) => note.noteId === noteId)?.title
    : null;
  if (buffer.kind === "utility") return buffer.utility.toUpperCase();
  if (buffer.kind === "image") return imageLabel(buffer.attachmentId);
  return title === null || title === undefined
    ? "Unknown note"
    : noteDisplayTitle(title);
}

function contentBufferNoteId(buffer: BufferState | undefined): string | null {
  if (!buffer) return null;
  if (buffer.kind === "note") return buffer.noteId;
  return null;
}
