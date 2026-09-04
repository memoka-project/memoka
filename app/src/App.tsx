import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { CoreRuntime, type RuntimeSnapshot } from "./core/runtime";
import { createDefaultPersistencePort } from "./core/persistence";
import { noteDisplayTitle, type NoteDocument } from "./core/documents";
import type {
  WorkspaceSearchScope,
  WorkspaceSearchTarget,
} from "./core/workspace-search";
import type { VimSessionSnapshot } from "./vim/session";
import {
  ApplicationCommandLine,
  type ApplicationCommandLineSession,
} from "./components/ApplicationCommandLine";
import {
  ApplicationCommandPicker,
  type ApplicationCommandPickerSession,
} from "./components/ApplicationCommandPicker";
import {
  ApplicationNoteSearch,
  type ApplicationNoteSearchSession,
} from "./components/ApplicationNoteSearch";
import { InternalLinkPicker } from "./components/InternalLinkPicker";
import {
  BlockTypePicker,
  type BlockTypePickerSession,
} from "./components/BlockTypePicker";
import {
  InlineFormatPicker,
  type InlineFormatPickerSession,
} from "./components/InlineFormatPicker";
import {
  TableActionPicker,
  type TableActionPickerSession,
} from "./components/TableActionPicker";
import { ThemePicker, type ThemePickerSession } from "./components/ThemePicker";
import { FontPicker, type FontPickerSession } from "./components/FontPicker";
import {
  WorkspaceSearchPalette,
  type WorkspaceSearchSession,
} from "./components/WorkspaceSearchPalette";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { WorkspaceOutline } from "./components/WorkspaceOutline";
import { ApplicationTabBar } from "./components/ApplicationTabBar";
import { DevelopmentDebugTasks } from "./components/DevelopmentDebugTasks";
import { ApplicationUpdatePrompt } from "./components/ApplicationUpdatePrompt";
import {
  ApplicationShutdownProgress,
  type ApplicationShutdownProgressState,
} from "./components/ApplicationShutdownProgress";
import {
  ApplicationWindowControls,
  ApplicationWindowDragRegion,
  type WindowControlErrorHandler,
} from "./components/ApplicationWindowChrome";
import { focusSurfaceFromPointer } from "./components/focus-surface";
import type { ApplicationCommandId } from "./core/application-command";
import {
  DEFAULT_APPLICATION_THEME_ID,
  normalizeApplicationThemeId,
  type ApplicationThemeId,
} from "./core/application-theme";
import {
  APPLICATION_ZOOM_STEP_PERCENT,
  DEFAULT_APPLICATION_FONT_FAMILY,
  DEFAULT_APPLICATION_INDENT_WIDTH_PX,
  DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  DEFAULT_APPLICATION_ZOOM_PERCENT,
  DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX,
  DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  MAX_APPLICATION_INDENT_WIDTH_PX,
  MAX_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  MAX_APPLICATION_NOTE_MAX_WIDTH_PX,
  MIN_APPLICATION_INDENT_WIDTH_PX,
  MIN_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  MIN_APPLICATION_NOTE_MAX_WIDTH_PX,
  clampApplicationZoomPercent,
  normalizeApplicationIndentWidthPx,
  normalizeApplicationLineNumberMinWidthPx,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
  shouldHideApplicationLineNumbers,
} from "./core/application-appearance";
import {
  DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
  DEFAULT_JAPANESE_WORD_SEGMENTATION,
  normalizeJapaneseLineBreakSegmentationMode,
  normalizeJapaneseWordSegmentationMode,
  setJapaneseSegmentationConfiguration,
  type JapaneseLineBreakSegmentationMode,
  type JapaneseWordSegmentationMode,
} from "./core/japanese-segmentation";
import type { TiptapEditorAdapter } from "./editor/tiptap-adapter";
import type { EditorNavigationDestination } from "./core/editor-navigation";
import type { InternalLinkCompletionSnapshot } from "./editor/internal-link-completion";
import {
  activeTab as applicationActiveTab,
  listTabWindowIds,
  type LeftSidebarUtility,
  type SplitNode,
} from "./core/application-state";
import {
  isTabDirectCommand,
  tabDirectCommandForKey,
  tabIndexForDirectCommand,
  tabShortcutKeyAtIndex,
} from "./core/tab-shortcuts";
import type { VimApplicationCommand, VimWindowCommand } from "./vim/input";
import { validateVimKeyConfig } from "./vim/input";
import {
  advanceSidebarInput,
  createSidebarInputState,
  type SidebarCommandId,
} from "./core/sidebar-keymap";
import {
  DEFAULT_APPLICATION_KEY_CONFIG,
  validateApplicationKeyConfig,
  type ApplicationKeyConfig,
} from "./core/application-key-config";
import {
  isLeaderActiveCommand,
  leaderShortcutForCommand,
  leaderShortcutMessage,
  resolveLeaderShortcut,
  type LeaderActiveCommandId,
  type LeaderShortcutResolution,
} from "./core/leader-shortcuts";
import {
  createDefaultDesktopWindowPort,
  type DesktopWindowPort,
} from "./platform/desktop-window";
import {
  createDefaultAttachmentRepository,
  type AttachmentRepository,
} from "./core/attachments";
import {
  createDefaultDataAreaPort,
  type DataAreaPort,
} from "./platform/data-area";
import {
  createDefaultPortableMirrorPort,
  PortableMirrorController,
  type PortableMirrorPort,
} from "./core/portable-mirror";
import {
  createDefaultApplicationUpdatePort,
  type ApplicationRelease,
  type ApplicationUpdatePort,
  type ApplicationUpdateProgress,
} from "./platform/application-update";
import {
  createDefaultApplicationDiagnosticsPort,
  type ApplicationDiagnosticsPort,
} from "./platform/application-diagnostics";
import {
  createDefaultApplicationConfigPort,
  type ApplicationConfigPort,
} from "./platform/application-config";
import { applyApplicationTheme } from "./platform/application-theme";
import {
  applyApplicationIndentWidth,
  applyApplicationFont,
  applyApplicationNoteMaxWidth,
  createDefaultApplicationZoomPort,
  refreshApplicationLayout,
  type ApplicationZoomPort,
} from "./platform/application-appearance";

export interface AppProps {
  initialTheme?: ApplicationThemeId;
  initialFontFamily?: string;
  initialZoomPercent?: number;
  initialNoteMaxWidthPx?: number;
  initialLineNumberMinWidthPx?: number;
  initialIndentWidthPx?: number;
  initialJapaneseWordSegmentation?: JapaneseWordSegmentationMode;
  initialJapaneseLineBreakSegmentation?: JapaneseLineBreakSegmentationMode;
  applicationConfig?: ApplicationConfigPort;
  applicationZoom?: ApplicationZoomPort;
  keyConfig?: ApplicationKeyConfig;
  keyConfigWarning?: string | null;
  showDebugLine?: boolean;
  desktopWindow?: DesktopWindowPort | null;
  dataArea?: DataAreaPort;
  portableMirror?: PortableMirrorPort | null;
  applicationUpdate?: ApplicationUpdatePort;
  diagnostics?: ApplicationDiagnosticsPort;
  startupUpdateDelayMs?: number;
  waitForMirrorOnExit?: boolean;
}

type VimCommandOrigin = "window" | "left-sidebar" | "right-sidebar";

export function App({
  initialTheme = DEFAULT_APPLICATION_THEME_ID,
  initialFontFamily = DEFAULT_APPLICATION_FONT_FAMILY,
  initialZoomPercent = DEFAULT_APPLICATION_ZOOM_PERCENT,
  initialNoteMaxWidthPx = DEFAULT_APPLICATION_NOTE_MAX_WIDTH_PX,
  initialLineNumberMinWidthPx = DEFAULT_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX,
  initialIndentWidthPx = DEFAULT_APPLICATION_INDENT_WIDTH_PX,
  initialJapaneseWordSegmentation = DEFAULT_JAPANESE_WORD_SEGMENTATION,
  initialJapaneseLineBreakSegmentation = DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
  applicationConfig: applicationConfigOverride,
  applicationZoom: applicationZoomOverride,
  keyConfig = DEFAULT_APPLICATION_KEY_CONFIG,
  keyConfigWarning = null,
  showDebugLine = Boolean(
    (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV,
  ),
  desktopWindow: desktopWindowOverride,
  dataArea: dataAreaOverride,
  portableMirror: portableMirrorOverride,
  applicationUpdate: applicationUpdateOverride,
  diagnostics: diagnosticsOverride,
  startupUpdateDelayMs = 10_000,
  waitForMirrorOnExit = true,
}: AppProps = {}) {
  validateApplicationKeyConfig(keyConfig);
  validateVimKeyConfig(keyConfig);
  const [defaultApplicationConfig] = useState(
    createDefaultApplicationConfigPort,
  );
  const applicationConfig =
    applicationConfigOverride ?? defaultApplicationConfig;
  const [themeId, setThemeId] = useState<ApplicationThemeId>(initialTheme);
  const [fontFamily, setFontFamily] = useState(initialFontFamily);
  const [zoomPercent, setZoomPercent] = useState(initialZoomPercent);
  const [noteMaxWidthPx, setNoteMaxWidthPx] = useState(initialNoteMaxWidthPx);
  const [lineNumberMinWidthPx, setLineNumberMinWidthPx] = useState(
    initialLineNumberMinWidthPx,
  );
  const [indentWidthPx, setIndentWidthPx] = useState(initialIndentWidthPx);
  const [japaneseWordSegmentation, setJapaneseWordSegmentation] = useState(
    initialJapaneseWordSegmentation,
  );
  const [japaneseLineBreakSegmentation, setJapaneseLineBreakSegmentation] =
    useState(initialJapaneseLineBreakSegmentation);
  const [defaultApplicationZoom] = useState(createDefaultApplicationZoomPort);
  const applicationZoom = applicationZoomOverride ?? defaultApplicationZoom;
  const [defaultDesktopWindow] = useState(createDefaultDesktopWindowPort);
  const [attachmentRepository] = useState(createDefaultAttachmentRepository);
  const [defaultDataArea] = useState(createDefaultDataAreaPort);
  const dataArea = dataAreaOverride ?? defaultDataArea;
  const [defaultPortableMirror] = useState(createDefaultPortableMirrorPort);
  const portableMirror =
    portableMirrorOverride === undefined
      ? defaultPortableMirror
      : portableMirrorOverride;
  const [defaultApplicationUpdate] = useState(
    createDefaultApplicationUpdatePort,
  );
  const applicationUpdate =
    applicationUpdateOverride ?? defaultApplicationUpdate;
  const [defaultDiagnostics] = useState(
    createDefaultApplicationDiagnosticsPort,
  );
  const diagnostics = diagnosticsOverride ?? defaultDiagnostics;
  const desktopWindow =
    desktopWindowOverride === undefined
      ? defaultDesktopWindow
      : desktopWindowOverride;
  const [runtime, setRuntime] = useState<CoreRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [dataAreaStatusChecked, setDataAreaStatusChecked] = useState(false);
  const [dataAreaRequired, setDataAreaRequired] = useState(false);
  const [dataAreaBusy, setDataAreaBusy] = useState(false);
  const [focusRequests, setFocusRequests] = useState<Record<string, number>>(
    {},
  );
  const [workspaceSearch, setWorkspaceSearch] =
    useState<WorkspaceSearchSession | null>(null);
  const [commandLine, setCommandLine] =
    useState<ApplicationCommandLineSession | null>(null);
  const [commandPicker, setCommandPicker] =
    useState<ApplicationCommandPickerSession | null>(null);
  const [noteSearch, setNoteSearch] =
    useState<ApplicationNoteSearchSession | null>(null);
  const [blockTypePicker, setBlockTypePicker] =
    useState<BlockTypePickerSession | null>(null);
  const [inlineFormatPicker, setInlineFormatPicker] =
    useState<InlineFormatPickerSession | null>(null);
  const [tableActionPicker, setTableActionPicker] =
    useState<TableActionPickerSession | null>(null);
  const [themePicker, setThemePicker] = useState<ThemePickerSession | null>(
    null,
  );
  const [fontPicker, setFontPicker] = useState<FontPickerSession | null>(null);
  const [commandMessage, setCommandMessage] = useState(keyConfigWarning ?? "");
  const [availableUpdate, setAvailableUpdate] =
    useState<ApplicationRelease | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<{
    release: ApplicationRelease;
    restoreFocus: () => void;
  } | null>(null);
  const [updateProgress, setUpdateProgress] =
    useState<ApplicationUpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [shutdownProgress, setShutdownProgress] =
    useState<ApplicationShutdownProgressState | null>(null);
  const [applicationActive, setApplicationActive] = useState(true);
  const [treeFocusRequest, setTreeFocusRequest] = useState(0);
  const [outlineFocusRequest, setOutlineFocusRequest] = useState(0);
  const editorAdapters = useRef(new Map<string, TiptapEditorAdapter>());
  const restoredFocusRuntime = useRef<CoreRuntime | null>(null);
  const applicationCommandQueue = useRef<Promise<void>>(Promise.resolve());
  const sidebarInputState = useRef(createSidebarInputState());
  const sidebarFocusGeneration = useRef(0);
  const controlKeyPressed = useRef(false);
  const zoomPercentRef = useRef(initialZoomPercent);
  const persistedZoomPercent = useRef(initialZoomPercent);
  const zoomRequestGeneration = useRef(0);
  const noteMaxWidthPxRef = useRef(initialNoteMaxWidthPx);
  const persistedNoteMaxWidthPx = useRef(initialNoteMaxWidthPx);
  const noteMaxWidthRequestGeneration = useRef(0);
  const lineNumberMinWidthPxRef = useRef(initialLineNumberMinWidthPx);
  const persistedLineNumberMinWidthPx = useRef(initialLineNumberMinWidthPx);
  const lineNumberMinWidthRequestGeneration = useRef(0);
  const indentWidthPxRef = useRef(initialIndentWidthPx);
  const persistedIndentWidthPx = useRef(initialIndentWidthPx);
  const indentWidthRequestGeneration = useRef(0);
  const japaneseWordSegmentationRef = useRef(initialJapaneseWordSegmentation);
  const persistedJapaneseWordSegmentation = useRef(
    initialJapaneseWordSegmentation,
  );
  const japaneseWordSegmentationRequestGeneration = useRef(0);
  const japaneseLineBreakSegmentationRef = useRef(
    initialJapaneseLineBreakSegmentation,
  );
  const persistedJapaneseLineBreakSegmentation = useRef(
    initialJapaneseLineBreakSegmentation,
  );
  const japaneseLineBreakSegmentationRequestGeneration = useRef(0);
  const appRoot = useRef<HTMLElement>(null);
  const applicationActiveRef = useRef(true);
  const requestedEditorFocus = useRef<string | null>(null);
  const pointerEditorFocusIntent = useRef<string | null>(null);
  const editorFocusRequestSequence = useRef(0);
  const runtimeRef = useRef<CoreRuntime | null>(null);
  const portableMirrorController = useRef<PortableMirrorController | null>(
    null,
  );
  const shutdownInFlight = useRef(false);
  const startupUpdateCheckStarted = useRef(false);

  useLayoutEffect(() => {
    applyApplicationTheme(document.documentElement, themeId);
  }, [themeId]);
  useLayoutEffect(() => {
    applyApplicationFont(document.documentElement, fontFamily);
    refreshApplicationLayout();
  }, [fontFamily]);
  useLayoutEffect(() => {
    applyApplicationNoteMaxWidth(document.documentElement, noteMaxWidthPx);
    refreshApplicationLayout();
  }, [noteMaxWidthPx]);
  useLayoutEffect(() => {
    applyApplicationIndentWidth(document.documentElement, indentWidthPx);
    refreshApplicationLayout();
  }, [indentWidthPx]);
  useLayoutEffect(() => {
    japaneseWordSegmentationRef.current = japaneseWordSegmentation;
    japaneseLineBreakSegmentationRef.current = japaneseLineBreakSegmentation;
    setJapaneseSegmentationConfiguration({
      wordSegmentation: japaneseWordSegmentation,
      lineBreakSegmentation: japaneseLineBreakSegmentation,
    });
  }, [japaneseLineBreakSegmentation, japaneseWordSegmentation]);

  const changeApplicationZoom = useCallback(
    async (requestedZoomPercent: number): Promise<void> => {
      const requested = normalizeApplicationZoomPercent(requestedZoomPercent);
      if (requested === null) {
        setCommandMessage(
          `:zoom · 50〜200の10%刻みで指定してください: ${requestedZoomPercent}`,
        );
        return;
      }
      if (requested === zoomPercentRef.current) {
        setCommandMessage(`zoom · ${requested}%`);
        return;
      }

      const generation = ++zoomRequestGeneration.current;
      zoomPercentRef.current = requested;
      setZoomPercent(requested);
      setCommandMessage(`zoom · ${requested}%`);
      try {
        await applicationZoom.setZoomPercent(requested);
        if (generation !== zoomRequestGeneration.current) return;
        refreshApplicationLayout();
        await applicationConfig.saveZoomPercent(requested);
        if (generation !== zoomRequestGeneration.current) return;
        persistedZoomPercent.current = requested;
      } catch (cause) {
        if (generation !== zoomRequestGeneration.current) return;
        const fallback = persistedZoomPercent.current;
        zoomPercentRef.current = fallback;
        setZoomPercent(fallback);
        try {
          await applicationZoom.setZoomPercent(fallback);
          refreshApplicationLayout();
        } catch {
          // Keep the original failure visible; a second platform error adds no
          // actionable information for the user.
        }
        setCommandMessage(
          `zoom · 変更を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig, applicationZoom],
  );

  const changeApplicationNoteMaxWidth = useCallback(
    async (requestedNoteMaxWidthPx: number): Promise<void> => {
      const requested = normalizeApplicationNoteMaxWidthPx(
        requestedNoteMaxWidthPx,
      );
      if (requested === null) {
        setCommandMessage(
          `:note-width · offまたは${MIN_APPLICATION_NOTE_MAX_WIDTH_PX}〜${MAX_APPLICATION_NOTE_MAX_WIDTH_PX}の整数で指定してください: ${requestedNoteMaxWidthPx}`,
        );
        return;
      }
      if (requested === noteMaxWidthPxRef.current) {
        setCommandMessage(`:note-width · ${noteMaxWidthLabel(requested)}`);
        return;
      }

      const generation = ++noteMaxWidthRequestGeneration.current;
      noteMaxWidthPxRef.current = requested;
      setNoteMaxWidthPx(requested);
      setCommandMessage(`:note-width · ${noteMaxWidthLabel(requested)}`);
      try {
        await applicationConfig.saveNoteMaxWidthPx(requested);
        if (generation !== noteMaxWidthRequestGeneration.current) return;
        persistedNoteMaxWidthPx.current = requested;
      } catch (cause) {
        if (generation !== noteMaxWidthRequestGeneration.current) return;
        const fallback = persistedNoteMaxWidthPx.current;
        noteMaxWidthPxRef.current = fallback;
        setNoteMaxWidthPx(fallback);
        setCommandMessage(
          `:note-width · 変更を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig],
  );

  const changeApplicationLineNumberMinWidth = useCallback(
    async (requestedLineNumberMinWidthPx: number): Promise<void> => {
      const requested = normalizeApplicationLineNumberMinWidthPx(
        requestedLineNumberMinWidthPx,
      );
      if (requested === null) {
        setCommandMessage(
          `:line-number-min-width · offまたは${MIN_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX}〜${MAX_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX}の整数で指定してください: ${requestedLineNumberMinWidthPx}`,
        );
        return;
      }
      if (requested === lineNumberMinWidthPxRef.current) {
        setCommandMessage(
          `:line-number-min-width · ${lineNumberMinWidthLabel(requested)}`,
        );
        return;
      }

      const generation = ++lineNumberMinWidthRequestGeneration.current;
      lineNumberMinWidthPxRef.current = requested;
      setLineNumberMinWidthPx(requested);
      setCommandMessage(
        `:line-number-min-width · ${lineNumberMinWidthLabel(requested)}`,
      );
      try {
        await applicationConfig.saveLineNumberMinWidthPx(requested);
        if (generation !== lineNumberMinWidthRequestGeneration.current) return;
        persistedLineNumberMinWidthPx.current = requested;
      } catch (cause) {
        if (generation !== lineNumberMinWidthRequestGeneration.current) return;
        const fallback = persistedLineNumberMinWidthPx.current;
        lineNumberMinWidthPxRef.current = fallback;
        setLineNumberMinWidthPx(fallback);
        setCommandMessage(
          `:line-number-min-width · 変更を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig],
  );

  const changeApplicationIndentWidth = useCallback(
    async (requestedIndentWidthPx: number): Promise<void> => {
      const requested = normalizeApplicationIndentWidthPx(
        requestedIndentWidthPx,
      );
      if (requested === null) {
        setCommandMessage(
          `:indent-width · ${MIN_APPLICATION_INDENT_WIDTH_PX}〜${MAX_APPLICATION_INDENT_WIDTH_PX}の整数で指定してください: ${requestedIndentWidthPx}`,
        );
        return;
      }
      if (requested === indentWidthPxRef.current) {
        setCommandMessage(`:indent-width · ${requested}px`);
        return;
      }

      const generation = ++indentWidthRequestGeneration.current;
      indentWidthPxRef.current = requested;
      setIndentWidthPx(requested);
      setCommandMessage(`:indent-width · ${requested}px`);
      try {
        await applicationConfig.saveIndentWidthPx(requested);
        if (generation !== indentWidthRequestGeneration.current) return;
        persistedIndentWidthPx.current = requested;
      } catch (cause) {
        if (generation !== indentWidthRequestGeneration.current) return;
        const fallback = persistedIndentWidthPx.current;
        indentWidthPxRef.current = fallback;
        setIndentWidthPx(fallback);
        setCommandMessage(
          `:indent-width · 変更を保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig],
  );

  const changeJapaneseWordSegmentation = useCallback(
    async (requested: JapaneseWordSegmentationMode): Promise<void> => {
      if (requested === japaneseWordSegmentationRef.current) {
        setCommandMessage(`:word-segmentation · ${requested}`);
        return;
      }
      const generation = ++japaneseWordSegmentationRequestGeneration.current;
      japaneseWordSegmentationRef.current = requested;
      setJapaneseWordSegmentation(requested);
      setJapaneseSegmentationConfiguration({
        wordSegmentation: requested,
        lineBreakSegmentation: japaneseLineBreakSegmentationRef.current,
      });
      setCommandMessage(`:word-segmentation · ${requested}`);
      try {
        await applicationConfig.saveJapaneseWordSegmentation(requested);
        if (generation !== japaneseWordSegmentationRequestGeneration.current) {
          return;
        }
        persistedJapaneseWordSegmentation.current = requested;
      } catch (cause) {
        if (generation !== japaneseWordSegmentationRequestGeneration.current) {
          return;
        }
        const fallback = persistedJapaneseWordSegmentation.current;
        japaneseWordSegmentationRef.current = fallback;
        setJapaneseWordSegmentation(fallback);
        setJapaneseSegmentationConfiguration({
          wordSegmentation: fallback,
          lineBreakSegmentation: japaneseLineBreakSegmentationRef.current,
        });
        setCommandMessage(
          `:word-segmentation · 保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig],
  );

  const changeJapaneseLineBreakSegmentation = useCallback(
    async (requested: JapaneseLineBreakSegmentationMode): Promise<void> => {
      if (requested === japaneseLineBreakSegmentationRef.current) {
        setCommandMessage(`:line-break-segmentation · ${requested}`);
        return;
      }
      const generation =
        ++japaneseLineBreakSegmentationRequestGeneration.current;
      japaneseLineBreakSegmentationRef.current = requested;
      setJapaneseLineBreakSegmentation(requested);
      setJapaneseSegmentationConfiguration({
        wordSegmentation: japaneseWordSegmentationRef.current,
        lineBreakSegmentation: requested,
      });
      setCommandMessage(`:line-break-segmentation · ${requested}`);
      try {
        await applicationConfig.saveJapaneseLineBreakSegmentation(requested);
        if (
          generation !== japaneseLineBreakSegmentationRequestGeneration.current
        ) {
          return;
        }
        persistedJapaneseLineBreakSegmentation.current = requested;
      } catch (cause) {
        if (
          generation !== japaneseLineBreakSegmentationRequestGeneration.current
        ) {
          return;
        }
        const fallback = persistedJapaneseLineBreakSegmentation.current;
        japaneseLineBreakSegmentationRef.current = fallback;
        setJapaneseLineBreakSegmentation(fallback);
        setJapaneseSegmentationConfiguration({
          wordSegmentation: japaneseWordSegmentationRef.current,
          lineBreakSegmentation: fallback,
        });
        setCommandMessage(
          `:line-break-segmentation · 保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [applicationConfig],
  );

  useEffect(() => {
    const handleZoomKeyDown = (event: globalThis.KeyboardEvent): void => {
      const control =
        event.ctrlKey ||
        event.metaKey ||
        event.getModifierState("Control") ||
        controlKeyPressed.current;
      if (!control || event.altKey) return;
      const requested = applicationZoomShortcutTarget(
        event,
        zoomPercentRef.current,
      );
      if (requested === null) return;
      event.preventDefault();
      event.stopPropagation();
      void changeApplicationZoom(requested);
    };
    window.addEventListener("keydown", handleZoomKeyDown, true);
    return () => window.removeEventListener("keydown", handleZoomKeyDown, true);
  }, [changeApplicationZoom]);
  const applicationReadyRecorded = useRef(false);

  const recordDiagnostic = useCallback(
    (event: Parameters<ApplicationDiagnosticsPort["record"]>[0]): void => {
      void diagnostics.record(event).catch(() => undefined);
    },
    [diagnostics],
  );

  const checkForApplicationUpdate = useCallback(
    async (explicit: boolean): Promise<ApplicationRelease | null> => {
      let info: Awaited<ReturnType<ApplicationDiagnosticsPort["info"]>>;
      try {
        info = await diagnostics.info();
      } catch {
        recordDiagnostic("update-check-failed");
        if (explicit) {
          setCommandMessage(
            ":update · 更新機構の状態を取得できませんでした（診断ログを確認してください）",
          );
        }
        return null;
      }
      if (!info.updaterConfigured) {
        if (explicit) {
          setCommandMessage(
            ":update · 更新機構は署名済みの配布版でのみ有効です",
          );
        }
        return null;
      }
      recordDiagnostic("update-check-started");
      if (explicit) setCommandMessage(":update · 更新を確認中…");
      try {
        const release = await applicationUpdate.check();
        if (!release) {
          recordDiagnostic("update-not-available");
          if (explicit) {
            setCommandMessage(
              `:update · Memoka v${info.applicationVersion}は最新版です`,
            );
          }
          setAvailableUpdate(null);
          return null;
        }
        setAvailableUpdate(release);
        recordDiagnostic("update-available");
        if (!explicit) {
          setCommandMessage(
            `Memoka v${release.version}を利用できます · :update`,
          );
        }
        return release;
      } catch {
        setAvailableUpdate(null);
        recordDiagnostic("update-check-failed");
        if (explicit) {
          setCommandMessage(
            ":update · 更新情報を取得できませんでした（診断ログを確認してください）",
          );
        }
        return null;
      }
    },
    [applicationUpdate, diagnostics, recordDiagnostic],
  );

  const handleWindowControlError = useCallback<WindowControlErrorHandler>(
    (action, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      setCommandMessage(`${action}に失敗しました: ${detail}`);
    },
    [],
  );

  const markEditorPointerFocus = useCallback((windowId: string): void => {
    pointerEditorFocusIntent.current = windowId;
    requestedEditorFocus.current = windowId;
  }, []);

  const requestEditorFocus = useCallback((windowId: string): void => {
    requestedEditorFocus.current = windowId;
    editorFocusRequestSequence.current += 1;
    const request = editorFocusRequestSequence.current;
    setFocusRequests((current) => ({
      ...current,
      [windowId]: request,
    }));
  }, []);

  const clearEditorFocusRequests = useCallback((): void => {
    pointerEditorFocusIntent.current = null;
    requestedEditorFocus.current = null;
    setFocusRequests((current) =>
      Object.keys(current).length === 0 ? current : {},
    );
  }, []);

  const consumeEditorFocusRequest = useCallback(
    (windowId: string, request: number): void => {
      setFocusRequests((current) => {
        if (current[windowId] !== request) return current;
        const next = { ...current };
        delete next[windowId];
        return next;
      });
    },
    [],
  );

  const registerEditorAdapter = useCallback(
    (windowId: string, adapter: TiptapEditorAdapter | null): void => {
      if (adapter) editorAdapters.current.set(windowId, adapter);
      else editorAdapters.current.delete(windowId);
    },
    [],
  );

  const applyNavigationDestinationToWindow = useCallback(
    (
      windowId: string,
      destination: EditorNavigationDestination,
      detail: string,
    ): string | null => {
      return (
        editorAdapters.current
          .get(windowId)
          ?.applyNavigationDestination(destination, detail) ?? null
      );
    },
    [],
  );

  const requestLeftUtilityFocus = useCallback((): void => {
    setTreeFocusRequest((current) => current + 1);
  }, []);

  const openCommandLine = useCallback(
    (session: ApplicationCommandLineSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setNoteSearch(null);
      setCommandPicker(null);
      setBlockTypePicker(null);
      setInlineFormatPicker(null);
      setTableActionPicker(null);
      setCommandLine(session);
    },
    [clearEditorFocusRequests],
  );

  const openWorkspaceSearch = useCallback(
    (session: WorkspaceSearchSession): void => {
      clearEditorFocusRequests();
      setCommandLine(null);
      setCommandPicker(null);
      setNoteSearch(null);
      setBlockTypePicker(null);
      setInlineFormatPicker(null);
      setTableActionPicker(null);
      setWorkspaceSearch(session);
    },
    [clearEditorFocusRequests],
  );

  const openNoteSearch = useCallback(
    (session: ApplicationNoteSearchSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setCommandLine(null);
      setCommandPicker(null);
      setBlockTypePicker(null);
      setInlineFormatPicker(null);
      setTableActionPicker(null);
      setNoteSearch(session);
    },
    [clearEditorFocusRequests],
  );

  const openBlockTypePicker = useCallback(
    (session: BlockTypePickerSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setCommandLine(null);
      setCommandPicker(null);
      setNoteSearch(null);
      setInlineFormatPicker(null);
      setTableActionPicker(null);
      setBlockTypePicker(session);
    },
    [clearEditorFocusRequests],
  );

  const openInlineFormatPicker = useCallback(
    (session: InlineFormatPickerSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setCommandLine(null);
      setCommandPicker(null);
      setNoteSearch(null);
      setBlockTypePicker(null);
      setTableActionPicker(null);
      setInlineFormatPicker(session);
    },
    [clearEditorFocusRequests],
  );

  const openTableActionPicker = useCallback(
    (session: TableActionPickerSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setCommandLine(null);
      setCommandPicker(null);
      setNoteSearch(null);
      setBlockTypePicker(null);
      setInlineFormatPicker(null);
      setTableActionPicker(session);
    },
    [clearEditorFocusRequests],
  );

  const openCommandPicker = useCallback(
    (session: ApplicationCommandPickerSession): void => {
      clearEditorFocusRequests();
      setWorkspaceSearch(null);
      setCommandLine(null);
      setNoteSearch(null);
      setBlockTypePicker(null);
      setInlineFormatPicker(null);
      setTableActionPicker(null);
      setCommandPicker(session);
    },
    [clearEditorFocusRequests],
  );

  const openNoteFromUtility = useCallback(
    async (windowId: string, noteId: string): Promise<void> => {
      if (!runtime) throw new Error("Core runtimeを利用できません");
      const adapter = editorAdapters.current.get(windowId);
      const origin = adapter?.captureStablePosition();
      if (!adapter || !origin) {
        await runtime.openNote(windowId, noteId);
        return;
      }
      const navigation = await runtime.navigateNoteOpen(
        windowId,
        origin,
        noteId,
      );
      if (!navigation.handled) throw new Error(navigation.detail);
    },
    [runtime],
  );

  const executeVimWindowCommand = useCallback(
    async (
      windowId: string,
      command: VimWindowCommand,
      origin: VimCommandOrigin = "window",
    ): Promise<void> => {
      if (!runtime) return;
      try {
        let targetWindowId = windowId;
        switch (command) {
          case "window.split-horizontal":
            targetWindowId = (
              await runtime.splitEditorWindow(windowId, "horizontal")
            ).windowId;
            break;
          case "window.split-vertical":
            targetWindowId = (
              await runtime.splitEditorWindow(windowId, "vertical")
            ).windowId;
            break;
          case "window.focus-left":
          case "window.focus-down":
          case "window.focus-up":
          case "window.focus-right": {
            const direction = command.replace("window.focus-", "") as
              "left" | "down" | "up" | "right";
            if (origin === "left-sidebar") {
              if (direction !== "right") {
                setCommandMessage(`${command} · sidebar boundary`);
                return;
              }
              targetWindowId = (await runtime.focusEditorWindow(windowId))
                .windowId;
              break;
            }
            if (origin === "right-sidebar") {
              if (direction !== "left") {
                setCommandMessage(`${command} · sidebar boundary`);
                return;
              }
              targetWindowId = (await runtime.focusEditorWindow(windowId))
                .windowId;
              break;
            }
            const result = await runtime.focusEditorWindowInDirection(
              windowId,
              direction,
            );
            if (result.changed) {
              targetWindowId = result.windowId;
              break;
            }
            const applicationWindow = runtime.snapshot().applicationWindow;
            const tab = applicationActiveTab(applicationWindow);
            if (direction === "left" && tab.leftSidebar.visible) {
              sidebarFocusGeneration.current += 1;
              setFocusRequests((current) =>
                Object.keys(current).length === 0 ? current : {},
              );
              await runtime.updateSidebar({ side: "left", focus: true });
              requestLeftUtilityFocus();
              setCommandMessage(`${command} · left-sidebar`);
              return;
            }
            if (direction === "right" && tab.rightSidebar.visible) {
              sidebarFocusGeneration.current += 1;
              setFocusRequests((current) =>
                Object.keys(current).length === 0 ? current : {},
              );
              await runtime.updateSidebar({ side: "right", focus: true });
              setOutlineFocusRequest((current) => current + 1);
              setCommandMessage(`${command} · right-sidebar`);
              return;
            }
            targetWindowId = result.windowId;
            break;
          }
          case "window.close":
            targetWindowId = (await runtime.closeEditorWindow(windowId))
              .activeWindowId;
            break;
          case "window.only":
            targetWindowId = (await runtime.keepOnlyEditorWindow(windowId))
              .windowId;
            break;
          case "tab.create":
            targetWindowId = (await runtime.createEditorTab()).windowId;
            break;
          case "tab.close":
            targetWindowId = (
              await runtime.closeEditorTab(
                runtime.snapshot().applicationWindow.activeTabId,
              )
            ).activeWindowId;
            break;
          case "tab.next":
          case "tab.previous":
            targetWindowId = (
              await runtime.cycleEditorTab(
                command === "tab.next" ? "next" : "previous",
              )
            ).windowId;
            break;
          default: {
            if (!isTabDirectCommand(command)) break;
            const tabIndex = tabIndexForDirectCommand(command);
            const applicationWindow = runtime.snapshot().applicationWindow;
            const tab = applicationWindow.tabs[tabIndex];
            if (!tab) {
              const shortcutKey = tabShortcutKeyAtIndex(tabIndex);
              throw new Error(
                `t${shortcutKey ?? "?"} · ${tabIndex + 1}番目のTabPageはありません`,
              );
            }
            targetWindowId = (await runtime.switchEditorTab(tab.id)).windowId;
            break;
          }
        }
        requestEditorFocus(targetWindowId);
        setCommandMessage(`${command} · ${targetWindowId}`);
      } catch (error) {
        setCommandMessage(
          error instanceof Error ? error.message : String(error),
        );
        if (origin === "window") requestEditorFocus(windowId);
      }
    },
    [requestEditorFocus, requestLeftUtilityFocus, runtime],
  );

  const executeVimApplicationCommand = useCallback(
    (command: VimApplicationCommand): void => {
      if (!runtime) return;
      sidebarFocusGeneration.current += 1;
      applicationCommandQueue.current = applicationCommandQueue.current.then(
        async () => {
          try {
            const applicationWindow = runtime.snapshot().applicationWindow;
            const tab = applicationActiveTab(applicationWindow);
            if (command === "utility.toggle-outline") {
              if (tab.rightSidebar.visible) {
                const result = await runtime.updateSidebar({
                  side: "right",
                  visible: false,
                });
                if (result.focusOwner.area === "window") {
                  requestEditorFocus(result.focusOwner.windowId);
                }
                setCommandMessage("utility.outline · closed");
              } else {
                clearEditorFocusRequests();
                await runtime.updateSidebar({
                  side: "right",
                  visible: true,
                  utility: "outline",
                  focus: true,
                });
                setOutlineFocusRequest((current) => current + 1);
                setCommandMessage("utility.outline · opened");
              }
            } else {
              const utility = "tree";
              const isVisible =
                tab.leftSidebar.visible && tab.leftSidebar.utility === utility;
              if (isVisible) {
                const result = await runtime.updateSidebar({
                  side: "left",
                  visible: false,
                });
                if (result.focusOwner.area === "window") {
                  requestEditorFocus(result.focusOwner.windowId);
                }
                setCommandMessage(`utility.${utility} · closed`);
              } else {
                clearEditorFocusRequests();
                await runtime.updateSidebar({
                  side: "left",
                  visible: true,
                  utility,
                  focus: true,
                });
                requestLeftUtilityFocus();
                setCommandMessage(`utility.${utility} · opened`);
              }
            }
          } catch (error) {
            setCommandMessage(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );
    },
    [
      clearEditorFocusRequests,
      requestEditorFocus,
      requestLeftUtilityFocus,
      runtime,
    ],
  );

  const replaceRuntime = useCallback((next: CoreRuntime): void => {
    const previous = runtimeRef.current;
    runtimeRef.current = next;
    setRuntime(next);
    setSnapshot(next.snapshot());
    if (previous && previous !== next) previous.destroy();
  }, []);

  const openSelectedDataArea = useCallback(async (): Promise<CoreRuntime> => {
    return CoreRuntime.open(createDefaultPersistencePort(), {
      onError: (error) => setStartupError(error.message),
    });
  }, []);

  useEffect(() => {
    let active = true;
    void dataArea
      .status()
      .then(async (status) => {
        if (!active) return;
        setDataAreaStatusChecked(true);
        if (!status.selected) {
          setDataAreaRequired(true);
          return;
        }
        setDataAreaBusy(true);
        const next = await openSelectedDataArea();
        if (!active) {
          next.destroy();
          return;
        }
        replaceRuntime(next);
        setDataAreaRequired(false);
        setStartupError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDataAreaStatusChecked(true);
        setDataAreaRequired(true);
        setStartupError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setDataAreaBusy(false);
      });
    return () => {
      active = false;
    };
  }, [dataArea, openSelectedDataArea, replaceRuntime]);

  useEffect(
    () => () => {
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    },
    [],
  );

  const chooseAndOpenDataArea = useCallback(async (): Promise<boolean> => {
    const selected = await dataArea.chooseDirectory();
    if (!selected) return false;
    const previousStatus = await dataArea.status().catch(() => null);
    const current = runtimeRef.current;
    let activated = false;
    setDataAreaBusy(true);
    setStartupError(null);
    try {
      await portableMirrorController.current?.flush();
      await current?.flush();
      await dataArea.activate(selected);
      activated = true;
      const next = await openSelectedDataArea();
      replaceRuntime(next);
      setDataAreaRequired(false);
      return true;
    } catch (error) {
      if (
        activated &&
        current &&
        previousStatus?.selected &&
        previousStatus.path
      ) {
        await dataArea.activate(previousStatus.path).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (current) setCommandMessage(`:switch-workspace · ${message}`);
      else {
        setStartupError(message);
        setDataAreaRequired(true);
      }
      return false;
    } finally {
      setDataAreaStatusChecked(true);
      setDataAreaBusy(false);
    }
  }, [dataArea, openSelectedDataArea, replaceRuntime]);

  useEffect(() => {
    portableMirrorController.current?.destroy();
    portableMirrorController.current = null;
    if (!runtime || !portableMirror) return;
    const controller = new PortableMirrorController(
      runtime,
      portableMirror,
      (error) => setCommandMessage(`mirror · ${error.message}`),
    );
    portableMirrorController.current = controller;
    return () => {
      controller.destroy();
      if (portableMirrorController.current === controller) {
        portableMirrorController.current = null;
      }
    };
  }, [portableMirror, runtime]);

  useEffect(() => {
    if (!runtime) return;
    if (!applicationReadyRecorded.current) {
      applicationReadyRecorded.current = true;
      recordDiagnostic("application-ready");
    }
    if (startupUpdateCheckStarted.current) return;
    const timeout = window.setTimeout(
      () => {
        if (startupUpdateCheckStarted.current) return;
        startupUpdateCheckStarted.current = true;
        void checkForApplicationUpdate(false);
      },
      Math.max(0, startupUpdateDelayMs),
    );
    return () => window.clearTimeout(timeout);
  }, [
    checkForApplicationUpdate,
    recordDiagnostic,
    runtime,
    startupUpdateDelayMs,
  ]);

  useEffect(() => {
    if (!startupError) return;
    recordDiagnostic("workspace-open-failed");
  }, [recordDiagnostic, startupError]);

  const requestApplicationShutdown = useCallback(async (): Promise<void> => {
    if (shutdownInFlight.current) return;
    if (!runtime || !desktopWindow?.forceClose) {
      setCommandMessage(":quit · デスクトップの終了処理を利用できません");
      return;
    }
    shutdownInFlight.current = true;
    let failureStage: ApplicationShutdownProgressState["stage"] = "saving";
    try {
      setShutdownProgress({ stage: "saving", mirror: null });
      await nextBrowserPaint();
      await runtime.flushDurableState();
      const mirrorController = portableMirrorController.current;
      if (waitForMirrorOnExit && mirrorController) {
        failureStage = "mirror";
        const refreshMirrorProgress = (): void => {
          setShutdownProgress({
            stage: "mirror",
            mirror: mirrorController.activitySnapshot(),
          });
        };
        refreshMirrorProgress();
        const refreshTimer = globalThis.setInterval(refreshMirrorProgress, 75);
        try {
          await nextBrowserPaint();
          await mirrorController.flush();
        } finally {
          globalThis.clearInterval(refreshTimer);
        }
      }
      failureStage = "closing";
      setShutdownProgress({ stage: "closing", mirror: null });
      await desktopWindow.forceClose();
    } catch (error) {
      shutdownInFlight.current = false;
      setShutdownProgress(null);
      const operation =
        failureStage === "mirror"
          ? "mirror生成"
          : failureStage === "closing"
            ? "終了処理"
            : "保存";
      setCommandMessage(
        `終了前の${operation}に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [desktopWindow, runtime, waitForMirrorOnExit]);

  useEffect(() => {
    if (!runtime || !desktopWindow?.subscribeToCloseRequested) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void desktopWindow
      .subscribeToCloseRequested(() => {
        if (disposed) return;
        return requestApplicationShutdown();
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error: unknown) => {
        setCommandMessage(
          `終了処理を準備できませんでした: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopWindow, requestApplicationShutdown, runtime]);

  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribe(setSnapshot);
  }, [runtime]);

  useEffect(() => {
    if (
      !runtime ||
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))
    ) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed || event.payload.type !== "drop") return;
          const scale = window.devicePixelRatio || 1;
          const left = event.payload.position.x / scale;
          const top = event.payload.position.y / scale;
          const target = document.elementFromPoint(left, top);
          const surface =
            target instanceof Element
              ? target.closest<HTMLElement>(".editor-window[data-window-id]")
              : null;
          const windowId = surface?.dataset.windowId;
          const adapter = windowId
            ? editorAdapters.current.get(windowId)
            : undefined;
          if (!windowId || !adapter || event.payload.paths.length === 0) {
            return;
          }
          markEditorPointerFocus(windowId);
          void runtime.focusEditorWindow(windowId).catch(() => undefined);
          setCommandMessage("添付ファイルを読み込み中");
          void adapter.importAttachmentPathsAtCoordinates(
            event.payload.paths,
            left,
            top,
          );
        }),
      )
      .then((disposeListener) => {
        if (disposed) disposeListener();
        else unlisten = disposeListener;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [markEditorPointerFocus, runtime]);

  useEffect(() => {
    const pointerWindowId = pointerEditorFocusIntent.current;
    const focusOwner = snapshot?.applicationWindow.focusOwner;
    if (
      pointerWindowId &&
      focusOwner?.area === "window" &&
      focusOwner.windowId === pointerWindowId
    ) {
      pointerEditorFocusIntent.current = null;
    }
  }, [snapshot]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key === "Control" ||
        event.code === "ControlLeft" ||
        event.code === "ControlRight"
      ) {
        controlKeyPressed.current = true;
      }
    };
    const handleKeyUp = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key === "Control" ||
        event.code === "ControlLeft" ||
        event.code === "ControlRight"
      ) {
        controlKeyPressed.current = false;
      }
    };
    const reset = (): void => {
      controlKeyPressed.current = false;
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const restoreManagedFocus = useCallback((): void => {
    if (!runtime || !snapshot) return;
    if (shutdownProgress) {
      appRoot.current
        ?.querySelector<HTMLElement>("[data-memoka-focus-surface='shutdown']")
        ?.focus();
      return;
    }
    if (updatePrompt) {
      appRoot.current
        ?.querySelector<HTMLElement>("[data-memoka-focus-surface='update']")
        ?.focus();
      return;
    }
    if (workspaceSearch) {
      appRoot.current
        ?.querySelector<HTMLInputElement>(
          "input[aria-label='ワークスペースを検索']",
        )
        ?.focus();
      return;
    }
    if (themePicker) {
      appRoot.current
        ?.querySelector<HTMLInputElement>(
          "input[aria-label='カラーテーマを検索']",
        )
        ?.focus();
      return;
    }
    if (fontPicker) {
      appRoot.current
        ?.querySelector<HTMLInputElement>(
          "input[aria-label='フォント名またはfont-familyを入力']",
        )
        ?.focus();
      return;
    }
    if (noteSearch) {
      appRoot.current
        ?.querySelector<HTMLInputElement>("input[aria-label='ノート内を検索']")
        ?.focus();
      return;
    }
    if (commandPicker) {
      appRoot.current
        ?.querySelector<HTMLInputElement>(
          "input[aria-label='Memoka Commandを検索']",
        )
        ?.focus();
      return;
    }
    if (commandLine) {
      appRoot.current
        ?.querySelector<HTMLInputElement>("input[aria-label='Memoka Command']")
        ?.focus();
      return;
    }
    const requestedWindowId = requestedEditorFocus.current;
    const currentSnapshot = runtime.snapshot();
    const requestedWindow = requestedWindowId
      ? currentSnapshot.windows.find(
          (candidate) => candidate.windowId === requestedWindowId,
        )
      : null;
    const requestedAdapter = requestedWindowId
      ? editorAdapters.current.get(requestedWindowId)
      : null;
    const requestedWindowState = requestedWindowId
      ? currentSnapshot.applicationWindow.windows[requestedWindowId]
      : null;
    const requestedBuffer =
      requestedWindowState?.bufferId === null ||
      requestedWindowState?.bufferId === undefined
        ? undefined
        : currentSnapshot.applicationWindow.buffers[
            requestedWindowState.bufferId
          ];
    const requestedAdapterNoteId =
      requestedAdapter?.editor.view.dom.dataset.noteId;
    const requestedAdapterMatchesBuffer =
      requestedAdapterNoteId !== undefined &&
      requestedBuffer?.kind === "note" &&
      requestedBuffer.noteId === requestedAdapterNoteId;
    if (
      requestedAdapter &&
      !requestedAdapter.editor.isDestroyed &&
      requestedAdapterMatchesBuffer
    ) {
      // A direct pointer focus is known before its asynchronous Core command
      // updates the snapshot. Recover that newest intent instead of restoring
      // the stale focus owner from the previous render.
      requestedAdapter.editor.view.focus();
      return;
    }
    if (requestedWindow?.noteId) {
      // The Window already changed Buffer, but React has not attached its new
      // adapter yet. Its attach effect will project focus to the new Editor;
      // never refocus the stale adapter from the previous Buffer.
      return;
    }
    const focusOwner = currentSnapshot.applicationWindow.focusOwner;
    if (focusOwner.area === "window") {
      requestEditorFocus(focusOwner.windowId);
    } else if (focusOwner.area === "left-sidebar") {
      requestLeftUtilityFocus();
    } else {
      setOutlineFocusRequest((current) => current + 1);
    }
  }, [
    commandPicker,
    commandLine,
    fontPicker,
    noteSearch,
    requestEditorFocus,
    requestLeftUtilityFocus,
    runtime,
    shutdownProgress,
    snapshot,
    themePicker,
    updatePrompt,
    workspaceSearch,
  ]);

  useEffect(() => {
    if (!runtime || !snapshot || restoredFocusRuntime.current === runtime) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || restoredFocusRuntime.current === runtime) return;
      restoredFocusRuntime.current = runtime;
      if (!isOperableFocusTarget(document.activeElement, appRoot.current)) {
        restoreManagedFocus();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [restoreManagedFocus, runtime, snapshot]);

  useEffect(() => {
    let recoveryTimer: number | null = null;
    const scheduleRecovery = (): void => {
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        const focusOwner = snapshot?.applicationWindow.focusOwner;
        const expectedWindowId =
          requestedEditorFocus.current ??
          (focusOwner?.area === "window" ? focusOwner.windowId : null);
        if (
          applicationActiveRef.current &&
          !isOperableFocusTarget(
            document.activeElement,
            appRoot.current,
            expectedWindowId,
          )
        ) {
          restoreManagedFocus();
        }
      }, 0);
    };
    const handleWindowBlur = (): void => {
      applicationActiveRef.current = false;
      setApplicationActive(false);
    };
    const handleWindowFocus = (): void => {
      applicationActiveRef.current = true;
      setApplicationActive(true);
      scheduleRecovery();
    };
    document.addEventListener("focusout", scheduleRecovery, true);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      document.removeEventListener("focusout", scheduleRecovery, true);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [restoreManagedFocus, snapshot]);

  const reconcileEditorDomFocus = useCallback(
    (windowId: string): void => {
      if (!runtime) return;
      const applicationWindow = runtime.snapshot().applicationWindow;
      const expectedWindowId =
        pointerEditorFocusIntent.current ?? requestedEditorFocus.current;
      if (expectedWindowId && expectedWindowId !== windowId) {
        // WebKitGTK may restore the previously focused contenteditable after
        // the pointer target has already become Core's focus owner. A bare
        // focus event is not a new navigation intent: keep the latest managed
        // request authoritative and project it back into the DOM.
        queueMicrotask(restoreManagedFocus);
        return;
      }
      if (!expectedWindowId && applicationWindow.focusOwner.area !== "window") {
        // Replacing the Buffer displayed by a Window can make WebKit focus the
        // newly mounted contenteditable. Without an explicit pointer or
        // managed focus request, the persisted Sidebar owner remains
        // authoritative.
        queueMicrotask(restoreManagedFocus);
        return;
      }

      requestedEditorFocus.current = windowId;
      const activeTab = applicationWindow.tabs.find(
        ({ id }) => id === applicationWindow.activeTabId,
      );
      if (
        activeTab?.activeWindowId === windowId &&
        applicationWindow.focusOwner.area === "window" &&
        applicationWindow.focusOwner.windowId === windowId
      ) {
        return;
      }

      void runtime.focusEditorWindow(windowId).catch(() => {
        if (pointerEditorFocusIntent.current === windowId) {
          pointerEditorFocusIntent.current = null;
        }
        const latestApplicationWindow = runtime.snapshot().applicationWindow;
        const latestTab = latestApplicationWindow.tabs.find(
          ({ id }) => id === latestApplicationWindow.activeTabId,
        );
        if (latestTab) requestEditorFocus(latestTab.activeWindowId);
      });
    },
    [requestEditorFocus, restoreManagedFocus, runtime],
  );

  if (startupError && !runtime) {
    return (
      <main className="app-shell app-shell--startup">
        <header
          className="application-tab-bar application-tab-bar--startup"
          aria-label="アプリケーションタイトルバー"
        >
          <ApplicationWindowDragRegion
            desktopWindow={desktopWindow}
            onError={handleWindowControlError}
          />
          <ApplicationWindowControls
            desktopWindow={desktopWindow}
            onError={handleWindowControlError}
          />
        </header>
        <section className="startup-panel" role="alert">
          <p className="eyebrow">Memoka</p>
          <h1>ワークスペースを開けませんでした</h1>
          <pre>{startupError}</pre>
          <button
            className="startup-panel__action"
            type="button"
            onClick={() => void chooseAndOpenDataArea()}
          >
            Workspaceデータ領域を選択
          </button>
        </section>
      </main>
    );
  }

  if (
    !runtime ||
    !snapshot ||
    dataAreaBusy ||
    !dataAreaStatusChecked ||
    dataAreaRequired
  ) {
    return (
      <main className="app-shell app-shell--startup">
        <header
          className="application-tab-bar application-tab-bar--startup"
          aria-label="アプリケーションタイトルバー"
        >
          <ApplicationWindowDragRegion
            desktopWindow={desktopWindow}
            onError={handleWindowControlError}
          />
          <ApplicationWindowControls
            desktopWindow={desktopWindow}
            onError={handleWindowControlError}
          />
        </header>
        <section className="startup-panel">
          <p className="eyebrow">Memoka</p>
          <h1>
            {dataAreaRequired
              ? "Workspaceデータ領域を選択してください"
              : "Memokaを準備しています"}
          </h1>
          {dataAreaRequired ? (
            <>
              <p>
                内部データと自動Markdown
                mirrorを保存する空のディレクトリを選びます。
              </p>
              <button
                className="startup-panel__action"
                type="button"
                onClick={() => void chooseAndOpenDataArea()}
              >
                ディレクトリを選択
              </button>
            </>
          ) : null}
        </section>
      </main>
    );
  }

  const activeTabPage = snapshot.applicationWindow.tabs.find(
    ({ id }) => id === snapshot.applicationWindow.activeTabId,
  );
  if (!activeTabPage) {
    throw new Error(
      `Unknown active TabPage: ${snapshot.applicationWindow.activeTabId}`,
    );
  }
  const activeWindowIds = listTabWindowIds(snapshot.applicationWindow);
  const effectiveTargetWindowId = activeTabPage.activeWindowId;
  const visibleWindows = activeWindowIds.map((windowId) => {
    const windowState = snapshot.windows.find(
      (candidate) => candidate.windowId === windowId,
    );
    if (!windowState) {
      throw new Error(`Active Tab references unknown Window: ${windowId}`);
    }
    return windowState;
  });
  const targetWindow =
    visibleWindows.find(
      ({ windowId }) => windowId === effectiveTargetWindowId,
    ) ?? visibleWindows[0];
  const outlineNoteId = targetWindow?.noteId ?? null;
  const outlineDocument = outlineNoteId
    ? (runtime.getNoteHandle(outlineNoteId).current as NoteDocument)
    : null;
  const outlineScopeSectionId = outlineNoteId
    ? (targetWindow?.focusedSectionId ?? outlineNoteId)
    : null;
  const { leftSidebar, rightSidebar } = activeTabPage;
  const workspaceColumns = [
    leftSidebar.visible ? `${leftSidebar.widthPx}px` : null,
    "minmax(0, 1fr)",
    rightSidebar.visible ? `${rightSidebar.widthPx}px` : null,
  ]
    .filter((column): column is string => column !== null)
    .join(" ");
  const transientFocus = shutdownProgress
    ? "shutdown"
    : workspaceSearch
      ? "workspace-search"
      : themePicker
        ? "theme-picker"
        : blockTypePicker
          ? "block-type-picker"
          : inlineFormatPicker
            ? "inline-format-picker"
            : tableActionPicker
              ? "table-action-picker"
              : noteSearch
                ? "note-search"
                : commandPicker
                  ? "command-picker"
                  : commandLine
                    ? "command-line"
                    : null;
  const applicationFocusOwner = snapshot.applicationWindow.focusOwner;
  const leftSidebarFocused =
    transientFocus === null && applicationFocusOwner.area === "left-sidebar";
  const rightSidebarFocused =
    transientFocus === null && applicationFocusOwner.area === "right-sidebar";

  const handleApplicationPointerDown = (
    event: MouseEvent<HTMLElement>,
  ): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      shutdownProgress &&
      !target.closest("[data-memoka-focus-surface='shutdown']")
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      updateProgress &&
      !target.closest("[data-memoka-focus-surface='update']")
    ) {
      event.preventDefault();
      event.stopPropagation();
      queueMicrotask(restoreManagedFocus);
      return;
    }
    if (
      target.closest(
        "[data-memoka-focus-surface], .application-window-drag-region, button, input, textarea, select, [contenteditable='true']",
      )
    ) {
      return;
    }
    queueMicrotask(restoreManagedFocus);
  };

  const persistSidebarFocus = async (side: "left" | "right"): Promise<void> => {
    clearEditorFocusRequests();
    const expectedArea = side === "left" ? "left-sidebar" : "right-sidebar";
    if (runtime.snapshot().applicationWindow.focusOwner.area === expectedArea) {
      return;
    }
    try {
      await runtime.updateSidebar({ side, focus: true });
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const openLeftSidebar = async (
    utility: Exclude<LeftSidebarUtility, "search">,
  ): Promise<void> => {
    try {
      clearEditorFocusRequests();
      await runtime.updateSidebar({
        side: "left",
        visible: true,
        utility,
        focus: true,
      });
      requestLeftUtilityFocus();
      setCommandMessage(`sidebar.left · ${utility}`);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const openTree = (): void => {
    void openLeftSidebar("tree");
  };

  const openRightOutline = async (): Promise<void> => {
    try {
      clearEditorFocusRequests();
      await runtime.updateSidebar({
        side: "right",
        visible: true,
        utility: "outline",
        focus: true,
      });
      setOutlineFocusRequest((current) => current + 1);
      setCommandMessage("sidebar.right · outline");
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const closeSidebar = async (side: "left" | "right"): Promise<void> => {
    try {
      const result = await runtime.updateSidebar({ side, visible: false });
      const windowId =
        result.focusOwner.area === "window"
          ? result.focusOwner.windowId
          : effectiveTargetWindowId;
      requestEditorFocus(windowId);
      setCommandMessage(`sidebar.${side} · closed`);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const createTab = async (): Promise<void> => {
    try {
      const { windowId } = await runtime.createEditorTab();
      requestEditorFocus(windowId);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const switchTab = async (tabId: string): Promise<void> => {
    try {
      const { windowId } = await runtime.switchEditorTab(tabId);
      requestEditorFocus(windowId);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const closeTab = async (tabId: string): Promise<void> => {
    try {
      const { activeWindowId } = await runtime.closeEditorTab(tabId);
      requestEditorFocus(activeWindowId);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const closeCurrentBuffer = async (): Promise<void> => {
    const window = snapshot.applicationWindow.windows[effectiveTargetWindowId];
    if (!window || window.bufferId === null) {
      setCommandMessage("Bufferは開かれていません");
      requestEditorFocus(effectiveTargetWindowId);
      return;
    }
    try {
      await runtime.closeBuffer(window.bufferId);
      setCommandMessage("buffer.close · Windowは空になりました");
      requestEditorFocus(effectiveTargetWindowId);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error));
      requestEditorFocus(effectiveTargetWindowId);
    }
  };

  const openWorkspaceSearchFromApplication = (
    restoreFocus: () => void,
    scope: WorkspaceSearchScope,
    target: WorkspaceSearchTarget = "workspace",
  ): void => {
    const adapter = editorAdapters.current.get(effectiveTargetWindowId);
    const origin = adapter?.captureStablePosition() ?? null;
    if (targetWindow?.noteId !== null && !origin) {
      setCommandMessage("検索対象Windowの現在位置を取得できませんでした");
      return;
    }
    openWorkspaceSearch({
      windowId: effectiveTargetWindowId,
      scope,
      target,
      origin,
      applyDestination: (destination, detail) =>
        applyNavigationDestinationToWindow(
          effectiveTargetWindowId,
          destination,
          detail,
        ),
      restoreFocus,
    });
    setCommandMessage(`workspace.search.${target}.${scope} · application`);
  };

  const openNoteSearchFromApplication = (restoreFocus: () => void): void => {
    const adapter = editorAdapters.current.get(effectiveTargetWindowId);
    const origin = adapter?.captureNoteSearchOrigin() ?? null;
    if (!adapter || !origin || targetWindow?.noteId === null) {
      setCommandMessage("Note Search · 検索対象のNoteがありません");
      queueMicrotask(restoreFocus);
      return;
    }
    openNoteSearch({
      windowId: effectiveTargetWindowId,
      origin,
      applyDestination: (destination, detail) =>
        applyNavigationDestinationToWindow(
          effectiveTargetWindowId,
          destination,
          detail,
        ),
      requestInputMethodDeactivation: () =>
        adapter.requestInputMethodDeactivation(),
      restoreFocus,
      focusResult: () => requestEditorFocus(effectiveTargetWindowId),
    });
    setCommandMessage("note.search · application");
  };

  const executeLeaderCommand = (
    command: LeaderActiveCommandId,
    restoreFocus: () => void,
  ): void => {
    if (command === "application.command_picker") {
      openCommandPicker({ restoreFocus });
    } else if (command === "note.search") {
      openNoteSearchFromApplication(restoreFocus);
    } else if (command === "context.action_picker") {
      const shortcut = leaderShortcutForCommand(command);
      setCommandMessage(
        `${keyConfig.leaderKey}${shortcut.key} · ${shortcut.label} · この画面では利用できません`,
      );
      queueMicrotask(restoreFocus);
    } else if (
      command === "workspace.search_title" ||
      command === "workspace.search_body" ||
      command === "workspace.search_buffers"
    ) {
      openWorkspaceSearchFromApplication(
        restoreFocus,
        command === "workspace.search_body" ? "body" : "title",
        command === "workspace.search_buffers" ? "buffers" : "workspace",
      );
    } else {
      executeVimApplicationCommand(command);
    }
  };

  const executeSidebarCommand = (
    command: SidebarCommandId,
    restoreFocus: () => void,
    sidebarSide: "left" | "right",
  ): void => {
    if (isLeaderActiveCommand(command)) {
      executeLeaderCommand(command, restoreFocus);
    } else if (command === "application.command_line") {
      openCommandLine({ restoreFocus });
    } else if (command === "sidebar.close") {
      void closeSidebar(sidebarSide);
    } else {
      void executeVimWindowCommand(
        effectiveTargetWindowId,
        command,
        `${sidebarSide}-sidebar`,
      );
    }
  };

  const handleSidebarApplicationKeyDown = (
    event: KeyboardEvent<HTMLElement>,
  ): boolean => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches(
        "input, textarea, select, button, [contenteditable='true']",
      )
    ) {
      return false;
    }
    sidebarFocusGeneration.current += 1;
    const utilityElement = event.currentTarget;
    const resolution = advanceSidebarInput(
      sidebarInputState.current,
      {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey:
          event.ctrlKey ||
          event.getModifierState("Control") ||
          controlKeyPressed.current,
        metaKey: event.metaKey,
        // Sidebar roots are not editable composition targets. WebKitGTK can
        // retain a stale composition flag after Editor focus leaves, so it
        // must not disable application-level Sidebar navigation.
        isComposing: false,
      },
      keyConfig,
    );
    sidebarInputState.current = resolution.state;
    if (!resolution.consume) return false;
    event.preventDefault();
    const sidebarSide = utilityElement.closest("[aria-label='Outline']")
      ? "right"
      : "left";
    const restoreSidebarFocus = (): void => {
      const restoreGeneration = ++sidebarFocusGeneration.current;
      if (utilityElement.isConnected) utilityElement.focus();
      void runtime
        .updateSidebar({ side: sidebarSide, focus: true })
        .then(() => {
          if (sidebarFocusGeneration.current !== restoreGeneration) return;
          if (sidebarSide === "right") {
            setOutlineFocusRequest((current) => current + 1);
          } else {
            requestLeftUtilityFocus();
          }
        })
        .catch((error: unknown) => {
          setCommandMessage(
            error instanceof Error ? error.message : String(error),
          );
        });
    };
    if (resolution.action.kind === "pending") {
      setCommandMessage(`pending:sidebar:${resolution.action.prefix}`);
    } else if (resolution.action.kind === "cancel") {
      setCommandMessage("sidebar sequence cancelled");
    } else if (resolution.action.kind === "leader-shortcut") {
      setCommandMessage(
        leaderShortcutMessage(
          resolution.action.resolution,
          keyConfig.leaderKey,
        ),
      );
    } else if (resolution.action.kind === "execute") {
      executeSidebarCommand(
        resolution.action.command,
        restoreSidebarFocus,
        sidebarSide,
      );
    }
    return true;
  };

  const performApplicationUpdate = async (): Promise<void> => {
    if (!updatePrompt || !runtime || updateProgress) return;
    const { release, restoreFocus } = updatePrompt;
    setUpdateError(null);
    if (!release.canSelfUpdate) {
      try {
        await applicationUpdate.openReleasePage();
        setCommandMessage(
          `:update · v${release.version}の配布ページを開きました`,
        );
        setUpdatePrompt(null);
        queueMicrotask(restoreFocus);
      } catch {
        setUpdateError("配布ページを開けませんでした");
      }
      return;
    }

    setUpdateProgress({
      phase: "preparing",
      downloadedBytes: 0,
      contentLength: null,
    });
    recordDiagnostic("update-install-started");
    try {
      // The updater may launch the installer as soon as download completes.
      // Publish the latest mirror and durable CRDT state before giving it that
      // authority; a flush failure must leave the running version untouched.
      await portableMirrorController.current?.flush();
      await runtime.flush();
      setUpdateProgress({
        phase: "downloading",
        downloadedBytes: 0,
        contentLength: null,
      });
      await applicationUpdate.downloadAndInstall(setUpdateProgress);
      await applicationUpdate.relaunch();
      // A native relaunch normally terminates the process before resolving.
      // Keep the UI usable if a platform adapter returns without exiting.
      setUpdatePrompt(null);
      setUpdateProgress(null);
      queueMicrotask(restoreFocus);
    } catch {
      recordDiagnostic("update-install-failed");
      setUpdateProgress(null);
      setUpdateError(
        "更新を適用できませんでした。現在のバージョンを継続します。診断ログを確認してください。",
      );
    }
  };

  const executeApplicationCommand = (
    command: ApplicationCommandId,
    message: string,
    argument: string | null,
  ): void => {
    const session = commandLine;
    setCommandLine(null);
    setCommandMessage(message);
    switch (command) {
      case "utility.tree":
        openTree();
        return;
      case "workspace.search_buffers":
        openWorkspaceSearchFromApplication(
          session?.restoreFocus ??
            (() => requestEditorFocus(effectiveTargetWindowId)),
          "title",
          "buffers",
        );
        return;
      case "utility.outline":
        void openRightOutline();
        return;
      case "workspace.search_trash":
        openWorkspaceSearchFromApplication(
          session?.restoreFocus ??
            (() => requestEditorFocus(effectiveTargetWindowId)),
          "title",
          "trash",
        );
        return;
      case "window.split-horizontal":
        void executeVimWindowCommand(
          effectiveTargetWindowId,
          "window.split-horizontal",
        );
        return;
      case "window.split-vertical":
        void executeVimWindowCommand(
          effectiveTargetWindowId,
          "window.split-vertical",
        );
        return;
      case "window.close":
        void executeVimWindowCommand(effectiveTargetWindowId, "window.close");
        return;
      case "buffer.close":
        void closeCurrentBuffer();
        return;
      case "tab.next":
        void executeVimWindowCommand(effectiveTargetWindowId, "tab.next");
        return;
      case "tab.previous":
        void executeVimWindowCommand(effectiveTargetWindowId, "tab.previous");
        return;
      case "tab.create":
        void createTab();
        return;
      case "tab.close":
        void closeTab(snapshot.applicationWindow.activeTabId);
        return;
      case "editor.paste_markdown":
      case "editor.paste_html": {
        const format =
          command === "editor.paste_markdown" ? "markdown" : "html";
        const adapter = editorAdapters.current.get(effectiveTargetWindowId);
        if (!adapter) {
          setCommandMessage(
            `:${`paste-${format}`} · 編集可能なBufferがありません`,
          );
          session?.restoreFocus();
          return;
        }
        setCommandMessage(`:${`paste-${format}`} · Clipboardを読み取り中`);
        void adapter
          .pasteExplicitClipboard(
            format,
            () =>
              editorAdapters.current.get(effectiveTargetWindowId) === adapter,
          )
          .then((result) => {
            const detail =
              result === "changed"
                ? "貼り付けました"
                : result === "empty"
                  ? "貼り付け可能な内容がありません"
                  : result === "stale"
                    ? "読み取り中に編集位置が変わりました"
                    : "Clipboardを読み取れませんでした";
            setCommandMessage(`:${`paste-${format}`} · ${detail}`);
            requestEditorFocus(effectiveTargetWindowId);
          });
        return;
      }
      case "editor.attach": {
        const adapter = editorAdapters.current.get(effectiveTargetWindowId);
        if (!adapter) {
          setCommandMessage(":attach · 編集可能なBufferがありません");
          session?.restoreFocus();
          return;
        }
        adapter.chooseAttachmentFiles();
        return;
      }
      case "workspace.switch":
        void chooseAndOpenDataArea().then((changed) => {
          if (changed) setCommandMessage(":switch-workspace · 切り替えました");
          else session?.restoreFocus();
        });
        return;
      case "application.update":
        void (async () => {
          const release =
            availableUpdate ?? (await checkForApplicationUpdate(true));
          if (!release) {
            session?.restoreFocus();
            return;
          }
          setUpdateError(null);
          setUpdateProgress(null);
          setUpdatePrompt({
            release,
            restoreFocus:
              session?.restoreFocus ??
              (() => requestEditorFocus(effectiveTargetWindowId)),
          });
        })();
        return;
      case "application.version":
        void diagnostics.info().then(
          (info) => {
            setCommandMessage(
              `Memoka v${info.applicationVersion} · Tauri ${info.tauriVersion} · ${info.operatingSystem}/${info.architecture} · ${info.bundleType}`,
            );
            session?.restoreFocus();
          },
          () => {
            setCommandMessage(
              ":version · バージョン情報を取得できませんでした",
            );
            session?.restoreFocus();
          },
        );
        return;
      case "application.diagnostics":
        void diagnostics.info().then(
          (info) => {
            setCommandMessage(
              `Memoka v${info.applicationVersion} · log ${info.logDirectory} · telemetry off`,
            );
            session?.restoreFocus();
          },
          () => {
            setCommandMessage(":diagnostics · 診断情報を取得できませんでした");
            session?.restoreFocus();
          },
        );
        return;
      case "application.colorscheme": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          clearEditorFocusRequests();
          setThemePicker({ initialThemeId: themeId, restoreFocus });
          setCommandMessage(":colorscheme · テーマを選択");
          return;
        }
        const requestedTheme = normalizeApplicationThemeId(argument);
        if (!requestedTheme) {
          setCommandMessage(`:colorscheme · 未対応のテーマです: ${argument}`);
          queueMicrotask(restoreFocus);
          return;
        }
        const previousTheme = themeId;
        setThemeId(requestedTheme);
        queueMicrotask(restoreFocus);
        void applicationConfig.saveTheme(requestedTheme).then(
          () => {
            setCommandMessage(`:colorscheme · ${requestedTheme}`);
          },
          (cause: unknown) => {
            setThemeId(previousTheme);
            setCommandMessage(
              `:colorscheme · 保存できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          },
        );
        return;
      }
      case "application.font": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        clearEditorFocusRequests();
        setFontPicker({ initialFontFamily: fontFamily, restoreFocus });
        setCommandMessage(":font · フォントを選択");
        return;
      }
      case "application.zoom": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(`:zoom · ${zoomPercent}%`);
          queueMicrotask(restoreFocus);
          return;
        }
        const parsed = /^\d+$/u.test(argument) ? Number(argument) : Number.NaN;
        const requested = normalizeApplicationZoomPercent(parsed);
        if (requested === null) {
          setCommandMessage(
            `:zoom · 50〜200の10%刻みで指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeApplicationZoom(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.note_width": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(
            `:note-width · ${noteMaxWidthLabel(noteMaxWidthPx)}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        const parsed =
          argument.toLocaleLowerCase() === "off"
            ? DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX
            : /^\d+$/u.test(argument)
              ? Number(argument)
              : Number.NaN;
        const requested = normalizeApplicationNoteMaxWidthPx(parsed);
        if (requested === null) {
          setCommandMessage(
            `:note-width · offまたは${MIN_APPLICATION_NOTE_MAX_WIDTH_PX}〜${MAX_APPLICATION_NOTE_MAX_WIDTH_PX}の整数で指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeApplicationNoteMaxWidth(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.line_number_min_width": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(
            `:line-number-min-width · ${lineNumberMinWidthLabel(lineNumberMinWidthPx)}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        const parsed =
          argument.toLocaleLowerCase() === "off"
            ? DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX
            : /^\d+$/u.test(argument)
              ? Number(argument)
              : Number.NaN;
        const requested = normalizeApplicationLineNumberMinWidthPx(parsed);
        if (requested === null) {
          setCommandMessage(
            `:line-number-min-width · offまたは${MIN_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX}〜${MAX_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX}の整数で指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeApplicationLineNumberMinWidth(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.indent_width": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(`:indent-width · ${indentWidthPx}px`);
          queueMicrotask(restoreFocus);
          return;
        }
        const parsed = /^\d+$/u.test(argument) ? Number(argument) : Number.NaN;
        const requested = normalizeApplicationIndentWidthPx(parsed);
        if (requested === null) {
          setCommandMessage(
            `:indent-width · ${MIN_APPLICATION_INDENT_WIDTH_PX}〜${MAX_APPLICATION_INDENT_WIDTH_PX}の整数で指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeApplicationIndentWidth(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.japanese_word_segmentation": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(`:word-segmentation · ${japaneseWordSegmentation}`);
          queueMicrotask(restoreFocus);
          return;
        }
        const requested = normalizeJapaneseWordSegmentationMode(argument);
        if (!requested) {
          setCommandMessage(
            `:word-segmentation · fine、budoux、unicodeのいずれかを指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeJapaneseWordSegmentation(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.japanese_line_break_segmentation": {
        const restoreFocus =
          session?.restoreFocus ??
          (() => requestEditorFocus(effectiveTargetWindowId));
        if (argument === null) {
          setCommandMessage(
            `:line-break-segmentation · ${japaneseLineBreakSegmentation}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        const requested = normalizeJapaneseLineBreakSegmentationMode(argument);
        if (!requested) {
          setCommandMessage(
            `:line-break-segmentation · fine、budoux、nativeのいずれかを指定してください: ${argument}`,
          );
          queueMicrotask(restoreFocus);
          return;
        }
        void changeJapaneseLineBreakSegmentation(requested);
        queueMicrotask(restoreFocus);
        return;
      }
      case "application.quit":
        void requestApplicationShutdown();
        return;
      case "application.help":
        void runtime.openHelpNote(effectiveTargetWindowId).then(
          (result) => {
            setCommandMessage(
              result.created
                ? ":help · Memoka helpを作成しました"
                : result.restored
                  ? ":help · Memoka helpを復元・同期しました"
                  : ":help · Memoka helpを同期しました",
            );
            requestEditorFocus(result.windowId);
          },
          (error: unknown) => {
            setCommandMessage(
              error instanceof Error ? error.message : String(error),
            );
            if (session) queueMicrotask(session.restoreFocus);
          },
        );
        return;
    }
  };

  const renderEditorWindow = (windowId: string): ReactNode => {
    const windowState = visibleWindows.find(
      (candidate) => candidate.windowId === windowId,
    );
    if (!windowState) {
      throw new Error(`Active Tab references unknown Window: ${windowId}`);
    }
    const focusOwner = snapshot.applicationWindow.focusOwner;
    const focused =
      transientFocus === null &&
      focusOwner.area === "window" &&
      focusOwner.windowId === windowState.windowId;
    const focusRequest =
      transientFocus === null &&
      focusOwner.area === "window" &&
      focusOwner.windowId === windowState.windowId
        ? (focusRequests[windowState.windowId] ?? 0)
        : 0;
    const applicationWindowState =
      snapshot.applicationWindow.windows[windowState.windowId];
    if (windowState.noteId === null) {
      return (
        <EmptyEditorWindow
          key={windowState.windowId}
          windowId={windowState.windowId}
          focused={focused}
          focusRequest={focusRequest}
          canApplyFocusRequest={() =>
            requestedEditorFocus.current === windowState.windowId
          }
          onFocusRequestApplied={(request) =>
            consumeEditorFocusRequest(windowState.windowId, request)
          }
          onPointerFocusIntent={() =>
            markEditorPointerFocus(windowState.windowId)
          }
          onFocus={() => reconcileEditorDomFocus(windowState.windowId)}
          onCommandLine={openCommandLine}
          onLeaderCommand={executeLeaderCommand}
          onLeaderResolution={(resolution) =>
            setCommandMessage(
              leaderShortcutMessage(resolution, keyConfig.leaderKey),
            )
          }
          onWindowCommand={executeVimWindowCommand}
          keyConfig={keyConfig}
        />
      );
    }
    const note = snapshot.notes.find(
      ({ noteId }) => noteId === windowState.noteId,
    );
    return (
      <EditorWindow
        key={windowState.windowId}
        runtime={runtime}
        attachmentRepository={attachmentRepository}
        windowId={windowState.windowId}
        noteId={windowState.noteId}
        focusedSectionId={
          applicationWindowState?.view.focusedSectionId ?? windowState.noteId
        }
        label={note ? noteDisplayTitle(note.title) : "Unknown note"}
        focused={focused}
        internalLinkLabelRevision={snapshot.internalLinkLabelRevision}
        focusRequest={focusRequest}
        canApplyFocusRequest={() =>
          requestedEditorFocus.current === windowState.windowId
        }
        onFocusRequestApplied={(request) =>
          consumeEditorFocusRequest(windowState.windowId, request)
        }
        onPointerFocusIntent={() =>
          markEditorPointerFocus(windowState.windowId)
        }
        onFocus={() => reconcileEditorDomFocus(windowState.windowId)}
        onWorkspaceSearch={openWorkspaceSearch}
        onBlockTypePicker={openBlockTypePicker}
        onInlineFormatPicker={openInlineFormatPicker}
        onTableActionPicker={openTableActionPicker}
        onMessage={setCommandMessage}
        onNoteSearch={openNoteSearch}
        onCommandLine={openCommandLine}
        onCommandPicker={openCommandPicker}
        onApplicationCommand={executeVimApplicationCommand}
        onWindowCommand={executeVimWindowCommand}
        keyConfig={keyConfig}
        lineNumberMinWidthPx={lineNumberMinWidthPx}
        onAdapterChange={registerEditorAdapter}
      />
    );
  };

  return (
    <main
      ref={appRoot}
      className={`app-shell${applicationActive ? "" : " app-shell--inactive"}${updateProgress ? " app-shell--update-busy" : ""}${shutdownProgress ? " app-shell--shutdown-busy" : ""}`}
      data-persistence-state={snapshot.persistence}
      data-workspace-revision={snapshot.workspaceRevision}
      data-note-revision={snapshot.noteRevision ?? undefined}
      data-application-focus={
        transientFocus ??
        (applicationFocusOwner.area === "window"
          ? `window:${applicationFocusOwner.windowId}`
          : applicationFocusOwner.area)
      }
      onMouseDownCapture={handleApplicationPointerDown}
    >
      <ApplicationTabBar
        state={snapshot.applicationWindow}
        notes={snapshot.notes}
        onSwitch={(tabId) => void switchTab(tabId)}
        onCreate={() => void createTab()}
        onClose={(tabId) => void closeTab(tabId)}
        desktopWindow={desktopWindow}
        onWindowControlError={handleWindowControlError}
      />

      <div
        className="application-workspace"
        style={{ gridTemplateColumns: workspaceColumns }}
      >
        {leftSidebar.visible &&
          (leftSidebar.utility === "tree" ? (
            <WorkspaceTree
              key={activeTabPage.id}
              runtime={runtime}
              snapshot={snapshot}
              targetWindowId={effectiveTargetWindowId}
              focusRequest={
                transientFocus === null &&
                snapshot.applicationWindow.focusOwner.area === "left-sidebar"
                  ? treeFocusRequest
                  : 0
              }
              onOpenTrash={() =>
                openWorkspaceSearchFromApplication(
                  requestLeftUtilityFocus,
                  "title",
                  "trash",
                )
              }
              onOpenNote={openNoteFromUtility}
              onRequestEditorFocus={requestEditorFocus}
              onClose={() => void closeSidebar("left")}
              onFocus={() => persistSidebarFocus("left")}
              onApplicationKeyDown={handleSidebarApplicationKeyDown}
              keyConfig={keyConfig}
              focused={leftSidebarFocused}
            />
          ) : (
            <SearchSidebarNotice
              focusRequest={
                transientFocus === null &&
                snapshot.applicationWindow.focusOwner.area === "left-sidebar"
                  ? treeFocusRequest
                  : 0
              }
              onFocus={() => persistSidebarFocus("left")}
              onApplicationKeyDown={handleSidebarApplicationKeyDown}
              focused={leftSidebarFocused}
            />
          ))}
        <section className="workspace" aria-label="Editorウィンドウ">
          <EditorSplitLayout
            node={activeTabPage.root}
            renderWindow={renderEditorWindow}
          />
        </section>
        {rightSidebar.visible && outlineDocument && outlineNoteId ? (
          <WorkspaceOutline
            key={`${activeTabPage.id}:${outlineNoteId}`}
            note={outlineDocument}
            scopeSectionId={outlineScopeSectionId ?? undefined}
            viewState={rightSidebar.outline}
            onViewStateChange={(outline) => {
              void runtime
                .updateSidebar({ side: "right", outline })
                .catch((error: unknown) => {
                  setCommandMessage(
                    error instanceof Error ? error.message : String(error),
                  );
                });
            }}
            focusRequest={
              transientFocus === null &&
              snapshot.applicationWindow.focusOwner.area === "right-sidebar"
                ? outlineFocusRequest
                : 0
            }
            onJump={async (sectionId) => {
              const adapter = editorAdapters.current.get(
                effectiveTargetWindowId,
              );
              const origin = adapter?.captureStablePosition();
              if (!adapter || !origin) {
                throw new Error("対象Windowの現在位置を取得できませんでした");
              }
              // Mark the destination Window before moving its caret. A target
              // outside the mounted Focused Section first returns to the Root
              // view, so this also covers the resulting Editor remount.
              requestEditorFocus(effectiveTargetWindowId);
              const navigation = await runtime.navigateOutline(
                effectiveTargetWindowId,
                origin,
                outlineNoteId,
                sectionId,
              );
              if (!navigation.handled) {
                throw new Error(navigation.detail);
              }
              const currentAdapter = editorAdapters.current.get(
                effectiveTargetWindowId,
              );
              if (navigation.destination) {
                const applied = currentAdapter?.applyNavigationDestination(
                  navigation.destination,
                  navigation.detail,
                );
                if (!applied) {
                  throw new Error(
                    "対象Sectionの表示位置を解決できませんでした",
                  );
                }
              } else if (currentAdapter === adapter) {
                runtime.applyPendingNavigation(
                  effectiveTargetWindowId,
                  currentAdapter,
                );
              }
              await runtime.focusEditorWindow(effectiveTargetWindowId);
              queueMicrotask(() => {
                editorAdapters.current
                  .get(effectiveTargetWindowId)
                  ?.editor.commands.focus();
              });
            }}
            onClose={() => {
              void closeSidebar("right");
            }}
            onFocus={() => persistSidebarFocus("right")}
            onApplicationKeyDown={handleSidebarApplicationKeyDown}
            focused={rightSidebarFocused}
          />
        ) : rightSidebar.visible ? (
          <EmptyOutlineNotice
            focusRequest={
              transientFocus === null &&
              snapshot.applicationWindow.focusOwner.area === "right-sidebar"
                ? outlineFocusRequest
                : 0
            }
            onFocus={() => persistSidebarFocus("right")}
            onApplicationKeyDown={handleSidebarApplicationKeyDown}
            focused={rightSidebarFocused}
          />
        ) : null}
      </div>

      {shutdownProgress ? (
        <ApplicationShutdownProgress progress={shutdownProgress} />
      ) : updatePrompt ? (
        <ApplicationUpdatePrompt
          release={updatePrompt.release}
          progress={updateProgress}
          error={updateError}
          onConfirm={() => void performApplicationUpdate()}
          onClose={() => {
            const restoreFocus = updatePrompt.restoreFocus;
            setUpdatePrompt(null);
            setUpdateError(null);
            setUpdateProgress(null);
            queueMicrotask(restoreFocus);
          }}
        />
      ) : workspaceSearch ? (
        <WorkspaceSearchPalette
          runtime={runtime}
          session={workspaceSearch}
          onClose={() => setWorkspaceSearch(null)}
          focused
        />
      ) : themePicker ? (
        <ThemePicker
          session={themePicker}
          onPreview={setThemeId}
          onAccept={async (selectedTheme) => {
            await applicationConfig.saveTheme(selectedTheme);
            setThemeId(selectedTheme);
            setCommandMessage(`:colorscheme · ${selectedTheme}`);
            setThemePicker(null);
            queueMicrotask(themePicker.restoreFocus);
          }}
          onCancel={() => {
            setThemeId(themePicker.initialThemeId);
            setThemePicker(null);
          }}
          focused
        />
      ) : fontPicker ? (
        <FontPicker
          session={fontPicker}
          onPreview={setFontFamily}
          onAccept={async (selectedFontFamily) => {
            await applicationConfig.saveFontFamily(selectedFontFamily);
            setFontFamily(selectedFontFamily);
            setCommandMessage(`:font · ${selectedFontFamily}`);
            setFontPicker(null);
            queueMicrotask(fontPicker.restoreFocus);
          }}
          onCancel={() => {
            setFontFamily(fontPicker.initialFontFamily);
            setFontPicker(null);
          }}
          focused
        />
      ) : blockTypePicker ? (
        <BlockTypePicker
          session={blockTypePicker}
          onClose={() => setBlockTypePicker(null)}
          onMessage={setCommandMessage}
          focused
        />
      ) : inlineFormatPicker ? (
        <InlineFormatPicker
          session={inlineFormatPicker}
          onClose={() => setInlineFormatPicker(null)}
          onMessage={setCommandMessage}
          focused
        />
      ) : tableActionPicker ? (
        <TableActionPicker
          session={tableActionPicker}
          onClose={() => setTableActionPicker(null)}
          onMessage={setCommandMessage}
          focused
        />
      ) : noteSearch ? (
        <ApplicationNoteSearch
          runtime={runtime}
          session={noteSearch}
          onClose={() => setNoteSearch(null)}
          onMessage={setCommandMessage}
          focused
        />
      ) : commandPicker ? (
        <ApplicationCommandPicker
          session={commandPicker}
          onSelect={(command) => {
            const restoreFocus = commandPicker.restoreFocus;
            setCommandPicker(null);
            openCommandLine({
              restoreFocus,
              initialValue: `${command.name}${command.argument === "optional" ? " " : ""}`,
            });
            setCommandMessage(`:${command.name} · Command-lineへ転記`);
          }}
          onClose={() => setCommandPicker(null)}
          focused
        />
      ) : commandLine ? (
        <ApplicationCommandLine
          session={commandLine}
          onExecute={executeApplicationCommand}
          onClose={() => setCommandLine(null)}
          focused
        />
      ) : (
        <div
          className="application-commandline application-commandline--idle"
          onMouseDown={() => queueMicrotask(restoreManagedFocus)}
        >
          <span className="commandline-prompt">:</span>
          <span>{commandMessage}</span>
        </div>
      )}

      {showDebugLine && (
        <footer className="debug-line" aria-label="開発デバッグ情報">
          <span>focus {transientFocus ?? applicationFocusOwner.area}</span>
          <span>save {snapshot.persistence}</span>
          <span>workspace rev {snapshot.workspaceRevision}</span>
          <span>note rev {snapshot.noteRevision ?? "-"}</span>
          <span>note {snapshot.noteId ?? "-"}</span>
          <span>window {effectiveTargetWindowId}</span>
          <DevelopmentDebugTasks
            runtime={runtime}
            mirrorController={portableMirrorController}
            applicationRoot={appRoot}
          />
          {keyConfigWarning && <span>keymap {keyConfigWarning}</span>}
        </footer>
      )}

      {(snapshot.error || startupError) && (
        <div className="error-banner" role="alert">
          {snapshot.error ?? startupError}
        </div>
      )}
    </main>
  );
}

function EditorSplitLayout({
  node,
  renderWindow,
}: {
  node: SplitNode;
  renderWindow: (windowId: string) => ReactNode;
}): ReactNode {
  if (node.type === "leaf") return renderWindow(node.windowId);
  const style: CSSProperties =
    node.direction === "vertical"
      ? {
          gridTemplateColumns: `minmax(0, ${node.ratio}fr) minmax(0, ${1 - node.ratio}fr)`,
        }
      : {
          gridTemplateRows: `minmax(0, ${node.ratio}fr) minmax(0, ${1 - node.ratio}fr)`,
        };
  return (
    <div
      className={`editor-split editor-split--${node.direction}`}
      data-split-id={node.id}
      data-split-direction={node.direction}
      style={style}
    >
      <EditorSplitLayout node={node.first} renderWindow={renderWindow} />
      <EditorSplitLayout node={node.second} renderWindow={renderWindow} />
    </div>
  );
}

function nextBrowserPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const complete = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(complete, 50);
    window.requestAnimationFrame(complete);
  });
}

function SearchSidebarNotice({
  focusRequest,
  onFocus,
  onApplicationKeyDown,
  focused,
}: {
  focusRequest: number;
  onFocus: () => void;
  onApplicationKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  focused: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusRequest > 0) root.current?.focus();
  }, [focusRequest]);
  return (
    <aside
      ref={root}
      className={`workspace-sidebar search-sidebar-notice focus-surface${focused ? " focus-surface--focused" : ""}`}
      aria-label="Search"
      data-memoka-focus-surface="left-sidebar"
      tabIndex={0}
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) =>
        focusSurfaceFromPointer(event.target, root.current)
      }
      onKeyDown={(event) => {
        onApplicationKeyDown(event);
      }}
    >
      <div className="utility-empty" />
      <div className="utility-statusline">SEARCH</div>
    </aside>
  );
}

function EmptyOutlineNotice({
  focusRequest,
  onFocus,
  onApplicationKeyDown,
  focused,
}: {
  focusRequest: number;
  onFocus: () => void;
  onApplicationKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean;
  focused: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusRequest > 0) root.current?.focus();
  }, [focusRequest]);
  return (
    <aside
      ref={root}
      className={`workspace-sidebar empty-outline-notice focus-surface${focused ? " focus-surface--focused" : ""}`}
      aria-label="Outline"
      data-memoka-focus-surface="right-sidebar"
      tabIndex={0}
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) =>
        focusSurfaceFromPointer(event.target, root.current)
      }
      onKeyDown={(event) => {
        onApplicationKeyDown(event);
      }}
    >
      <div className="utility-empty" />
      <div className="utility-statusline">OUTLINE</div>
    </aside>
  );
}

function EmptyEditorWindow({
  windowId,
  focused,
  focusRequest,
  canApplyFocusRequest,
  onFocusRequestApplied,
  onPointerFocusIntent,
  onFocus,
  onCommandLine,
  onLeaderCommand,
  onLeaderResolution,
  onWindowCommand,
  keyConfig,
}: {
  windowId: string;
  focused: boolean;
  focusRequest: number;
  canApplyFocusRequest: () => boolean;
  onFocusRequestApplied: (request: number) => void;
  onPointerFocusIntent: () => void;
  onFocus: () => void;
  onCommandLine: (session: ApplicationCommandLineSession) => void;
  onLeaderCommand: (
    command: LeaderActiveCommandId,
    restoreFocus: () => void,
  ) => void;
  onLeaderResolution: (
    resolution: Exclude<LeaderShortcutResolution, { kind: "execute" }>,
  ) => void;
  onWindowCommand: (
    windowId: string,
    command: VimWindowCommand,
  ) => Promise<void>;
  keyConfig: ApplicationKeyConfig;
}) {
  const root = useRef<HTMLElement>(null);
  const [prefix, setPrefix] = useState<"" | "g" | "tab" | "leader" | "ctrl-w">(
    "",
  );

  useEffect(() => {
    const target = root.current;
    if (focusRequest <= 0 || !canApplyFocusRequest() || !target) return;
    target.focus();
    onFocusRequestApplied(focusRequest);
  }, [canApplyFocusRequest, focusRequest, onFocusRequestApplied]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const codeKey = event.code.match(/^Key([A-Z])$/u)?.[1]?.toLowerCase();
    const shortcutKey = codeKey ?? event.key.toLowerCase();
    if (event.key === "Escape") {
      setPrefix("");
      return;
    }
    if (
      EMPTY_WINDOW_MODIFIER_ONLY_KEYS.has(event.key) ||
      EMPTY_WINDOW_MODIFIER_ONLY_CODE.test(event.code)
    ) {
      return;
    }
    if (
      prefix === "" &&
      event.key === keyConfig.leaderKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      setPrefix("leader");
      return;
    }
    if (event.key === ":" && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setPrefix("");
      onCommandLine({ restoreFocus: () => root.current?.focus() });
      return;
    }
    if (event.ctrlKey && shortcutKey === "w") {
      event.preventDefault();
      setPrefix("ctrl-w");
      return;
    }
    if (prefix === "ctrl-w") {
      const command = EMPTY_WINDOW_CTRL_W_COMMANDS[shortcutKey];
      setPrefix("");
      if (!command) return;
      event.preventDefault();
      void onWindowCommand(windowId, command);
      return;
    }
    if (prefix === "g") {
      setPrefix("");
      const command =
        event.key === "t"
          ? "tab.next"
          : event.key === "T"
            ? "tab.previous"
            : null;
      if (!command) return;
      event.preventDefault();
      void onWindowCommand(windowId, command);
      return;
    }
    if (prefix === "tab") {
      const command =
        EMPTY_WINDOW_TAB_COMMANDS[event.key] ??
        tabDirectCommandForKey(event.key);
      setPrefix("");
      if (!command) return;
      event.preventDefault();
      void onWindowCommand(windowId, command);
      return;
    }
    if (prefix === "leader") {
      setPrefix("");
      event.preventDefault();
      const resolution = resolveLeaderShortcut(event.key, "empty-window");
      if (resolution.kind === "execute") {
        onLeaderCommand(resolution.command, () => root.current?.focus());
      } else {
        onLeaderResolution(resolution);
      }
      return;
    }
    if (event.key === "g" && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setPrefix("g");
      return;
    }
    if (event.key === "t" && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setPrefix("tab");
    }
  };

  return (
    <article
      ref={root}
      className={`editor-window empty-editor-window focus-surface${focused ? " focus-surface--focused" : ""}`}
      data-window-id={windowId}
      data-buffer-state="empty"
      data-vim-mode="normal"
      data-vim-action={prefix || "no buffer"}
      data-memoka-focus-surface={`window:${windowId}`}
      tabIndex={0}
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) => {
        onPointerFocusIntent();
        focusSurfaceFromPointer(event.target, root.current);
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="empty-editor-window__body" />
      <div className="window-statusline">
        <span className="window-title">[No Buffer]</span>
      </div>
    </article>
  );
}

const EMPTY_WINDOW_CTRL_W_COMMANDS: Readonly<Record<string, VimWindowCommand>> =
  {
    s: "window.split-horizontal",
    v: "window.split-vertical",
    h: "window.focus-left",
    j: "window.focus-down",
    k: "window.focus-up",
    l: "window.focus-right",
    c: "window.close",
    o: "window.only",
  };

const EMPTY_WINDOW_TAB_COMMANDS: Readonly<Record<string, VimWindowCommand>> = {
  c: "tab.create",
  n: "tab.next",
  p: "tab.previous",
  d: "tab.close",
};

const EMPTY_WINDOW_MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);
const EMPTY_WINDOW_MODIFIER_ONLY_CODE =
  /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/u;

function EditorWindow({
  runtime,
  attachmentRepository,
  windowId,
  noteId,
  focusedSectionId,
  label,
  focused,
  internalLinkLabelRevision,
  focusRequest,
  canApplyFocusRequest,
  onFocusRequestApplied,
  onPointerFocusIntent,
  onFocus,
  onWorkspaceSearch,
  onBlockTypePicker,
  onInlineFormatPicker,
  onTableActionPicker,
  onMessage,
  onNoteSearch,
  onCommandLine,
  onCommandPicker,
  onApplicationCommand,
  onWindowCommand,
  keyConfig,
  lineNumberMinWidthPx,
  onAdapterChange,
}: {
  runtime: CoreRuntime;
  attachmentRepository: AttachmentRepository;
  windowId: string;
  noteId: string;
  focusedSectionId: string;
  label: string;
  focused: boolean;
  internalLinkLabelRevision: number;
  focusRequest: number;
  canApplyFocusRequest: () => boolean;
  onFocusRequestApplied: (request: number) => void;
  onPointerFocusIntent: () => void;
  onFocus: () => void;
  onWorkspaceSearch: (session: WorkspaceSearchSession) => void;
  onBlockTypePicker: (session: BlockTypePickerSession) => void;
  onInlineFormatPicker: (session: InlineFormatPickerSession) => void;
  onTableActionPicker: (session: TableActionPickerSession) => void;
  onMessage: (message: string) => void;
  onNoteSearch: (session: ApplicationNoteSearchSession) => void;
  onCommandLine: (session: ApplicationCommandLineSession) => void;
  onCommandPicker: (session: ApplicationCommandPickerSession) => void;
  onApplicationCommand: (command: VimApplicationCommand) => void;
  onWindowCommand: (
    windowId: string,
    command: VimWindowCommand,
  ) => Promise<void>;
  keyConfig: ApplicationKeyConfig;
  lineNumberMinWidthPx: number;
  onAdapterChange: (
    windowId: string,
    adapter: TiptapEditorAdapter | null,
  ) => void;
}) {
  const editorWindow = useRef<HTMLElement>(null);
  const editorScroll = useRef<HTMLDivElement>(null);
  const editorRoot = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<TiptapEditorAdapter | null>(null);
  const focusedRef = useRef(focused);
  const restoreEditorFocusOnAttach = useRef(false);
  const [vimSnapshot, setVimSnapshot] = useState<VimSessionSnapshot | null>(
    null,
  );
  const [internalLinkCompletion, setInternalLinkCompletion] =
    useState<InternalLinkCompletionSnapshot | null>(null);
  const [caretExternalLink, setCaretExternalLink] = useState<string | null>(
    null,
  );
  const [caretSectionProjection, setCaretSectionProjection] = useState<{
    noteId: string;
    focusedSectionId: string;
    sectionId: string;
  } | null>(null);

  useLayoutEffect(() => {
    const element = editorWindow.current;
    if (!element) return;
    const update = (width: number): void => {
      element.dataset.lineNumbersHidden = String(
        shouldHideApplicationLineNumbers(width, lineNumberMinWidthPx),
      );
    };
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      update(entry?.contentRect.width ?? element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [lineNumberMinWidthPx]);

  useEffect(() => {
    if (!editorRoot.current || !editorScroll.current) return;
    const attachedRoot = editorRoot.current;
    setVimSnapshot(null);
    setInternalLinkCompletion(null);
    setCaretExternalLink(null);
    const adapter = runtime.attachEditor(windowId, attachedRoot, {
      onVimSnapshot: setVimSnapshot,
      onCaretSectionChange: (sectionId) => {
        const currentSectionId = sectionId ?? focusedSectionId;
        setCaretSectionProjection((current) =>
          current?.noteId === noteId &&
          current.focusedSectionId === focusedSectionId &&
          current.sectionId === currentSectionId
            ? current
            : {
                noteId,
                focusedSectionId,
                sectionId: currentSectionId,
              },
        );
      },
      onCaretExternalLinkChange: setCaretExternalLink,
      onInternalLinkCompletion: setInternalLinkCompletion,
      internalLinkPopupId: `internal-link-picker-${windowId}`,
      onWorkspaceSearch: (origin, scope, target) =>
        onWorkspaceSearch({
          windowId,
          scope,
          target,
          origin,
          applyDestination: (destination, detail) =>
            adapterRef.current?.applyNavigationDestination(
              destination,
              detail,
            ) ?? null,
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onBlockTypePicker: ({ blockId }) =>
        onBlockTypePicker({
          windowId,
          blockId,
          transform: (target, tableDimensions) =>
            adapter.transformBlock(blockId, target, true, tableDimensions),
          attach: () =>
            adapter.chooseAttachmentFiles({ blockId, consumeSlash: true }),
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onInlineFormatPicker: (request) =>
        onInlineFormatPicker({
          windowId,
          selectedText: request.selectedText,
          existingHref: request.existingHref,
          apply: request.apply,
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onTableActionPicker: (request) =>
        onTableActionPicker({
          windowId,
          selection: request.selection,
          apply: request.apply,
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onMessage,
      onNoteSearch: (origin) =>
        onNoteSearch({
          windowId,
          origin,
          applyDestination: (destination, detail) =>
            adapterRef.current?.applyNavigationDestination(
              destination,
              detail,
            ) ?? null,
          requestInputMethodDeactivation: () =>
            adapterRef.current?.requestInputMethodDeactivation(),
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onCommandLine: () =>
        onCommandLine({
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onCommandPicker: () =>
        onCommandPicker({
          restoreFocus: () => adapterRef.current?.editor.commands.focus(),
        }),
      onApplicationCommand,
      onWindowCommand: (command) => {
        void onWindowCommand(windowId, command);
      },
      keyConfig,
      scrollElement: editorScroll.current,
      attachmentRepository,
    });
    adapterRef.current = adapter;
    adapter.setFocusSurfaceActive(focusedRef.current);
    onAdapterChange(windowId, adapter);
    if (restoreEditorFocusOnAttach.current) {
      restoreEditorFocusOnAttach.current = false;
      adapter.editor.commands.focus();
    }
    return () => {
      if (attachedRoot.contains(attachedRoot.ownerDocument.activeElement)) {
        restoreEditorFocusOnAttach.current = true;
      }
      if (adapterRef.current === adapter) adapterRef.current = null;
      onAdapterChange(windowId, null);
      adapter.destroy();
    };
  }, [
    runtime,
    attachmentRepository,
    windowId,
    noteId,
    focusedSectionId,
    onWorkspaceSearch,
    onBlockTypePicker,
    onInlineFormatPicker,
    onTableActionPicker,
    onMessage,
    onNoteSearch,
    onCommandLine,
    onCommandPicker,
    onApplicationCommand,
    onWindowCommand,
    keyConfig,
    onAdapterChange,
  ]);

  useLayoutEffect(() => {
    focusedRef.current = focused;
    const adapter = adapterRef.current;
    const adapterHasCurrentNote =
      adapter?.editor.view.dom.dataset.noteId === noteId;
    adapter?.setFocusSurfaceActive(focused && adapterHasCurrentNote);
    if (
      focused &&
      adapter &&
      adapterHasCurrentNote &&
      canApplyFocusRequest() &&
      !adapter.editor.view.hasFocus()
    ) {
      // Core's focus owner is authoritative. A WebKitGTK click can briefly
      // return DOM focus to the previous contenteditable while the Core
      // transaction is settling, so project the committed owner back to the
      // corresponding Editor before keyboard input can remain in that Window.
      adapter.editor.view.focus();
    }
  }, [canApplyFocusRequest, focused, noteId]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (focusRequest <= 0 || !canApplyFocusRequest() || !adapter) return;
    if (adapter.editor.view.dom.dataset.noteId !== noteId) return;
    adapter.editor.commands.focus();
    onFocusRequestApplied(focusRequest);
  }, [canApplyFocusRequest, focusRequest, noteId, onFocusRequestApplied]);

  useEffect(() => {
    adapterRef.current?.refreshInternalLinkLabels();
    adapterRef.current?.refreshInternalLinkCompletion();
  }, [internalLinkLabelRevision]);
  const clipboard = vimSnapshot?.clipboard ?? "idle";
  const imeOff = vimSnapshot?.imeOff ?? "idle";
  const mode =
    vimSnapshot?.mode ?? runtime.windows.get(windowId)?.mode ?? "insert";
  const action = vimSnapshot?.action ?? "ready";
  const largePasteProgress = action.match(
    /^clipboard:paste:large:preparing:(\d+)%$/u,
  )?.[1];
  const register = vimSnapshot?.register ?? "(empty)";
  const caretSectionId =
    caretSectionProjection?.noteId === noteId &&
    caretSectionProjection.focusedSectionId === focusedSectionId
      ? caretSectionProjection.sectionId
      : focusedSectionId;
  const sectionBreadcrumb = runtime.sectionBreadcrumb(noteId, caretSectionId);
  const showBreadcrumb = sectionBreadcrumb.length > 1;

  const moveCaretToBreadcrumbSection = (sectionId: string): void => {
    const originAdapter = adapterRef.current;
    const current = originAdapter?.captureStablePosition() ?? null;
    if (!originAdapter || !current) {
      originAdapter?.editor.commands.focus();
      return;
    }
    void runtime
      .navigateOutline(windowId, current, noteId, sectionId)
      .then(async (navigation) => {
        if (!navigation.handled) throw new Error(navigation.detail);
        const currentAdapter = adapterRef.current;
        if (navigation.destination) {
          const applied = currentAdapter?.applyNavigationDestination(
            navigation.destination,
            navigation.detail,
          );
          if (!applied) {
            throw new Error("対象Sectionの表示位置を解決できませんでした");
          }
        } else if (currentAdapter === originAdapter) {
          runtime.applyPendingNavigation(windowId, currentAdapter);
        }
        await runtime.focusEditorWindow(windowId);
        queueMicrotask(() => {
          adapterRef.current?.editor.commands.focus();
        });
      })
      .catch(() => adapterRef.current?.editor.commands.focus());
  };

  return (
    <article
      ref={editorWindow}
      className={`editor-window focus-surface${focused ? " focus-surface--focused" : ""}`}
      data-window-id={windowId}
      data-note-id={noteId}
      data-vim-mode={mode}
      data-vim-action={action}
      data-vim-register={register}
      data-clipboard-status={clipboard}
      data-ime-off-status={imeOff}
      data-ime-off-detail={vimSnapshot?.imeOffDetail ?? "not-requested"}
      data-memoka-focus-surface={`window:${windowId}`}
      onFocusCapture={onFocus}
      onMouseDownCapture={(event) => {
        if (event.button !== 0) return;
        onPointerFocusIntent();
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (
          target.closest(
            ".internal-link-picker, button, input, textarea, select",
          )
        )
          return;
        const editor = adapterRef.current?.editor;
        if (!editor || editor.isDestroyed || editor.view.hasFocus()) return;

        // A click in contenteditable padding does not reliably focus
        // ProseMirror in WebKitGTK. Focus synchronously, then leave the native
        // mousedown untouched so ProseMirror can still resolve a text click.
        editor.view.focus();
      }}
    >
      <div className="editor-viewport">
        <div ref={editorScroll} className="editor-scroll">
          <div ref={editorRoot} className="editor-root" />
        </div>
      </div>
      {internalLinkCompletion && (
        <InternalLinkPicker
          completion={internalLinkCompletion}
          onSelect={(candidateNoteId) =>
            adapterRef.current?.acceptInternalLinkCandidate(candidateNoteId)
          }
        />
      )}
      {largePasteProgress !== undefined && (
        <div className="editor-large-paste" role="status" aria-live="polite">
          <span>大きなテキストを準備中</span>
          <progress value={Number(largePasteProgress)} max={100} />
          <span>{largePasteProgress}% · Esc / Ctrl-C でキャンセル</span>
        </div>
      )}
      <div className="window-statusline">
        {focused && <span className="window-mode">{modeLabel(mode)}</span>}
        <span className="window-title">
          {showBreadcrumb ? (
            <nav className="window-breadcrumb" aria-label="Section breadcrumb">
              {sectionBreadcrumb.map((entry, index) => (
                <span key={entry.sectionId} className="window-breadcrumb__part">
                  {index > 0 && (
                    <span className="window-breadcrumb__separator">/</span>
                  )}
                  {index === sectionBreadcrumb.length - 1 ? (
                    <span aria-current="page">{entry.title}</span>
                  ) : (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() =>
                        moveCaretToBreadcrumbSection(entry.sectionId)
                      }
                    >
                      {entry.title}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            label
          )}
        </span>
        {focused && caretExternalLink && (
          <span
            className="window-external-link"
            title={caretExternalLink}
            aria-label={`外部リンク: ${caretExternalLink}`}
          >
            ↗ {caretExternalLink}
          </span>
        )}
      </div>
    </article>
  );
}

function noteMaxWidthLabel(noteMaxWidthPx: number): string {
  return noteMaxWidthPx === DISABLED_APPLICATION_NOTE_MAX_WIDTH_PX
    ? "off"
    : `${noteMaxWidthPx}px`;
}

function lineNumberMinWidthLabel(lineNumberMinWidthPx: number): string {
  return lineNumberMinWidthPx === DISABLED_APPLICATION_LINE_NUMBER_MIN_WIDTH_PX
    ? "off"
    : `${lineNumberMinWidthPx}px`;
}

function applicationZoomShortcutTarget(
  event: Pick<globalThis.KeyboardEvent, "key" | "code">,
  currentZoomPercent: number,
): number | null {
  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return clampApplicationZoomPercent(
      currentZoomPercent + APPLICATION_ZOOM_STEP_PERCENT,
    );
  }
  if (
    event.key === "-" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return clampApplicationZoomPercent(
      currentZoomPercent - APPLICATION_ZOOM_STEP_PERCENT,
    );
  }
  if (
    event.key === "0" ||
    event.code === "Digit0" ||
    event.code === "Numpad0"
  ) {
    return DEFAULT_APPLICATION_ZOOM_PERCENT;
  }
  return null;
}

function modeLabel(mode: string): string {
  return mode.replace("-", " ").toUpperCase();
}

function isOperableFocusTarget(
  target: Element | null,
  appRoot: HTMLElement | null,
  expectedWindowId: string | null = null,
): boolean {
  if (!(target instanceof HTMLElement) || !appRoot?.contains(target)) {
    return false;
  }
  const focusSurface = target.closest<HTMLElement>(
    "[data-memoka-focus-surface]",
  );
  if (
    expectedWindowId &&
    focusSurface?.dataset.memokaFocusSurface?.startsWith("window:")
  ) {
    return (
      focusSurface.dataset.memokaFocusSurface === `window:${expectedWindowId}`
    );
  }
  return Boolean(
    focusSurface ??
    target.closest(
      "[data-memoka-focus-surface], button, input, textarea, select, [contenteditable='true']",
    ),
  );
}
