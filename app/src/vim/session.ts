import { Extension } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Selection,
} from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import type { UndoManager } from "yjs";
import { sanitizeExternalHtml } from "../editor/html-paste";
import {
  internalSectionLinkAtPosition,
  sectionIdAtEditorSelection,
  type EditorNavigationIntent,
  type EditorNavigationResult,
} from "../core/editor-navigation";
import {
  beginVisualChar,
  beginVisualLine,
  clampVimBlockCursor,
  moveVimSelectionToViewportPosition,
  pasteVimRegisterAtSelection,
  runEditorEnterInsertFromHorizontalRule,
  runEditorExitBlock,
  runEditorInsertBoundaryDelete,
  runEditorInsertEnter,
  runEditorReplaceCharacter,
  runEditorReplaceText,
  runEditorTab,
  runEditorVimCommand,
  runEditorVimOperator,
  runVisualLineCommand,
  sectionDepthShiftSelection,
  visualCharCursor,
  vimBlockCursorBeforeInsertCaret,
  vimRegisterLabel,
  type EditorVimResult,
  type VimEditorView,
  type VimRegister,
  type VimVisualLineState,
  type SectionDepthShiftSelection,
} from "./editor-commands";
import {
  measureVimBlockCaretGeometry,
  measureVimInsertCaretGeometry,
} from "./caret-geometry";
import {
  createVisualCharDecorations,
  createVisualLineDecorations,
} from "./decorations";
import {
  beginVisualBlock,
  captureTableActionSelection,
  createVisualBlockDecorations,
  moveVisualBlockHeadToPosition,
  restoreVisualBlockSelection,
  repeatTableAction,
  runVisualBlockCommand,
  selectVisualBlockRectangle,
  visualBlockCursor,
  visualBlockDimensions,
  type TableActionSelection,
} from "./table-editing";
import type { TableActionRepeat } from "../core/table-actions";
import { VimLogicalLineGutter } from "./logical-line-gutter";
import { VimVisualLineOverlay } from "./visual-line-overlay";
import {
  MARKDOWN_CLIPBOARD_MIME,
  MEMOKA_CLIPBOARD_MIME,
  TSV_CLIPBOARD_MIME,
  decodeVimClipboard,
  readInternalClipboard,
  readMarkdownClipboard,
  registerFromMarkdown,
  registerFromTabularClipboard,
  type PreferredClipboardFormats,
  type VimClipboardWriteResult,
} from "./clipboard";
import {
  advanceVimInput,
  createVimInputState,
  isVimApplicationCommand,
  isVimWindowCommand,
  type VimApplicationCommand,
  type VimCommand,
  type VimInputState,
  type VimMode,
  type VimOperator,
  type VimWindowCommand,
} from "./input";
import type { ApplicationKeyConfig } from "../core/application-key-config";
import {
  leaderShortcutForCommand,
  leaderShortcutMessage,
} from "../core/leader-shortcuts";
import type {
  WorkspaceSearchScope,
  WorkspaceSearchTarget,
} from "../core/workspace-search";
import type { NoteSearchDirection } from "../core/note-search";
import { normalizeExternalLink } from "../core/external-links";
import { VimRegisterStore } from "./register-store";
import {
  createVimRepeatDescriptor,
  replayVimRepeat,
  VimRepeatStore,
} from "./repeat";
import { externalLinkAtPosition } from "./inline-format";
import { runMarkdownNoteImport } from "./markdown-note-import";
import { createUuidV7 } from "../core/ids";
import { isLargePlainTextPaste } from "../editor/large-paste-protocol";
import { prepareLargePlainTextPaste } from "../editor/large-plain-text-paste";

export interface VimSessionSnapshot {
  mode: VimMode;
  composing: boolean;
  action: string;
  register: string;
  clipboard: "idle" | "writing" | VimClipboardWriteResult;
  imeOff: VimImeOffStatus;
  imeOffDetail: string;
}

export type VimImeOffStatus =
  "idle" | "requesting" | "inactive" | "unsupported" | "failed";

export interface VimImeDeactivationResult {
  supported: boolean;
  inactive: boolean;
  detail: string;
}

export interface VimNativeFilePutRequest {
  readonly direction: "after" | "before";
  readonly position: number;
  readonly count: number;
}

export interface ProductVimSessionOptions {
  initialMode: VimMode;
  /** The persisted Note ID; a Focused child Section never matches this ID. */
  getRootNoteId?: () => string | null;
  registerStore?: VimRegisterStore;
  repeatStore?: VimRepeatStore;
  onModeChange?: (mode: VimMode) => void;
  onSnapshot?: (snapshot: VimSessionSnapshot) => void;
  onRequestImeOff?: () =>
    VimImeDeactivationResult | Promise<VimImeDeactivationResult>;
  onYank?: (
    register: VimRegister,
  ) => VimClipboardWriteResult | Promise<VimClipboardWriteResult>;
  onPasteRead?: () =>
    | PreferredClipboardFormats
    | null
    | Promise<PreferredClipboardFormats | null>;
  onPasteFiles?: (files: readonly File[]) => void | Promise<void>;
  onPasteNativePaths?: (
    paths: readonly string[],
    put?: VimNativeFilePutRequest,
  ) => void | Promise<void>;
  onNavigate?: (
    intent: EditorNavigationIntent,
  ) => EditorNavigationResult | Promise<EditorNavigationResult>;
  onWorkspaceSearch?: (
    cursor: number,
    scope: WorkspaceSearchScope,
    target: WorkspaceSearchTarget,
  ) => void;
  onNoteSearch?: (cursor: number) => void;
  onNoteSearchRepeat?: (
    cursor: number,
    direction: NoteSearchDirection,
    count: number,
  ) => EditorNavigationResult | Promise<EditorNavigationResult>;
  onInlineFormat?: () => boolean;
  onTableActions?: (selection: TableActionSelection) => boolean;
  onOpenExternalLink?: (href: string) => void | Promise<void>;
  onOpenAttachment?: (attachmentId: string) => void | Promise<void>;
  onMessage?: (message: string) => void;
  onCommandLine?: () => void;
  onCommandPicker?: () => void;
  onApplicationCommand?: (command: VimApplicationCommand) => void;
  onWindowCommand?: (command: VimWindowCommand) => void;
  onSectionFocus?: (
    direction: "current" | "parent",
    currentSectionId: string,
  ) => void;
  onSectionDepthShift?: (
    request: SectionDepthShiftSelection & {
      direction: "deeper" | "shallower";
      mode: VimMode;
    },
  ) =>
    | { changed: boolean; affectedSectionIds: readonly string[] }
    | void
    | Promise<{
        changed: boolean;
        affectedSectionIds: readonly string[];
      } | void>;
  keyConfig?: ApplicationKeyConfig;
  undo?: () => boolean;
  redo?: () => boolean;
}

interface CursorHistoryEntry {
  beforeCursor: number;
  afterCursor: number;
}

function recordVimCursorHistory(
  manager: UndoManager,
  beforeCursor: number,
  afterCursor: number,
): void {
  manager.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
    beforeCursor,
    afterCursor,
  } satisfies CursorHistoryEntry);
}

interface PasteFallback {
  html: string;
  plain: string;
}

interface ChangeUndoCapture {
  manager: UndoManager;
  captureTimeout: number;
  undoStackDepth: number;
  beforeCursor: number;
  beforeTransaction: () => void;
}

const cursorHistoryKey = Symbol("memoka-cursor-history");

export class ProductVimSession {
  private mode: VimMode;
  private composing = false;
  private action = "ready";
  private readonly registerStore: VimRegisterStore;
  private readonly unsubscribeRegister: () => void;
  private readonly repeatStore: VimRepeatStore;
  private clipboard: VimSessionSnapshot["clipboard"] = "idle";
  private clipboardWriteGeneration = 0;
  private clipboardReadGeneration = 0;
  private navigationGeneration = 0;
  private navigationInFlight = false;
  private imeOff: VimImeOffStatus = "idle";
  private imeOffDetail = "not-requested";
  private imeRequestGeneration = 0;
  private visualLine: VimVisualLineState | null = null;
  private input: VimInputState = createVimInputState();
  private view: EditorView | null = null;
  private caret: HTMLSpanElement | null = null;
  private gutter: VimLogicalLineGutter | null = null;
  private visualLineOverlay: VimVisualLineOverlay | null = null;
  private refreshFrame: number | null = null;
  private focusRefreshTimer: number | null = null;
  private changeUndoCapture: ChangeUndoCapture | null = null;
  private focusSurfaceActive = true;
  private normalPutClipboardDirty = true;
  private normalPutClipboardReadInFlight = false;
  private externalFileClipboardPaths: readonly string[] | null = null;
  private largePlainTextPasteAbort: AbortController | null = null;

  constructor(private readonly options: ProductVimSessionOptions) {
    this.mode = options.initialMode;
    this.registerStore = options.registerStore ?? new VimRegisterStore();
    this.repeatStore = options.repeatStore ?? new VimRepeatStore();
    this.unsubscribeRegister = this.registerStore.subscribe(() => {
      this.clipboardReadGeneration += 1;
      this.normalPutClipboardDirty = false;
      this.normalPutClipboardReadInFlight = false;
      this.externalFileClipboardPaths = null;
      this.emit();
    });
  }

  snapshot(): VimSessionSnapshot {
    return {
      mode: this.mode,
      composing: this.composing,
      action: this.action,
      register: vimRegisterLabel(this.registerStore.read()),
      clipboard: this.clipboard,
      imeOff: this.imeOff,
      imeOffDetail: this.imeOffDetail,
    };
  }

  requestInputMethodDeactivation(): void {
    this.requestImeOff();
  }

  pasteExplicit(
    view: EditorView,
    format: "markdown" | "html",
    content: string,
  ): boolean {
    if (this.composing || view.isDestroyed || content.length === 0) {
      this.action = `clipboard:paste:${format}:empty`;
      this.emit();
      return false;
    }
    if (format === "markdown") {
      if (this.pasteMarkdownNote(view, content, "markdown")) return true;
      const register = registerFromMarkdown(content, view.state.schema);
      if (register) {
        return this.pasteClipboardRegister(view, register, "markdown");
      }
    } else {
      const html = sanitizeExternalHtml(content);
      if (
        html &&
        this.pasteClipboardFallback(view, "html", { html, plain: "" })
      ) {
        return true;
      }
    }
    this.action = `clipboard:paste:${format}:empty`;
    this.emit();
    this.scheduleCaretRefresh(view);
    return false;
  }

  createExtension(): Extension {
    const createPlugin = () => {
      const pluginKey = new PluginKey("memokaVim");
      const lineNumberCursor = (state: EditorState): number =>
        this.mode === "visual-line" && this.visualLine
          ? this.visualLine.cursor
          : this.mode === "visual-block"
            ? visualBlockCursor({ state })
            : this.mode === "visual-char"
              ? visualCharCursor({ state })
              : state.selection instanceof NodeSelection
                ? state.selection.from
                : state.selection.head;

      return new Plugin({
        key: pluginKey,
        props: {
          decorations: (state) =>
            this.mode === "visual-char"
              ? createVisualCharDecorations(state)
              : this.mode === "visual-line" && this.visualLine
                ? createVisualLineDecorations(state, this.visualLine)
                : this.mode === "visual-block"
                  ? createVisualBlockDecorations(state)
                  : null,
          handleClick: (view, position, event) =>
            this.handleClick(view, position, event),
          handleDOMEvents: {
            click: (_view, event) => {
              const target = event.target;
              if (
                target instanceof Element &&
                target.closest("a[href]") !== null
              ) {
                event.preventDefault();
              }
              return false;
            },
            compositionstart: (view) => {
              this.setComposing(true);
              this.scheduleCaretRefresh(view);
              return false;
            },
            compositionend: (view) => {
              this.setComposing(false);
              this.scheduleCaretRefresh(view);
              return false;
            },
            beforeinput: (view, event) =>
              this.handleBeforeInput(view, event as InputEvent),
            paste: (view, event) =>
              this.handlePaste(view, event as ClipboardEvent),
            input: (view, event) => {
              const input = event as InputEvent;
              if (signalsComposition(input)) this.setComposing(true);
              this.scheduleCaretRefresh(view);
              return false;
            },
          },
        },
        view: (view) => {
          this.bind(view);
          const gutter = new VimLogicalLineGutter(
            view,
            lineNumberCursor(view.state),
          );
          const visualLineOverlay = new VimVisualLineOverlay(
            view,
            this.mode === "visual-line" ? this.visualLine : null,
          );
          this.gutter = gutter;
          this.visualLineOverlay = visualLineOverlay;
          return {
            update: (next, previous) => {
              gutter.update(next, previous, lineNumberCursor(next.state));
              visualLineOverlay.update(
                next,
                this.mode === "visual-line" ? this.visualLine : null,
              );
              this.scheduleCaretRefresh(next);
            },
            destroy: () => {
              gutter.destroy();
              visualLineOverlay.destroy();
              if (this.gutter === gutter) this.gutter = null;
              if (this.visualLineOverlay === visualLineOverlay) {
                this.visualLineOverlay = null;
              }
              this.unbind(view);
            },
          };
        },
      });
    };
    return Extension.create({
      name: "memokaVim",
      priority: 2_000,
      addProseMirrorPlugins: () => [createPlugin()],
    });
  }

  activate(): void {
    if (!this.view) return;
    applyNativeCaretMode(this.view.dom, this.mode);
    if (this.mode === "visual-block") {
      const selection = this.view.state.selection;
      const restored =
        selection instanceof CellSelection
          ? restoreVisualBlockSelection(
              this.view,
              selection.$anchorCell.pos,
              selection.$headCell.pos,
            )
          : beginVisualBlock(this.view);
      if (!restored) {
        this.mode = "normal";
        applyNativeCaretMode(this.view.dom, "normal");
        applyModeSelection(this.view, "normal", undefined, false);
        this.options.onModeChange?.("normal");
      }
    } else if (this.mode !== "insert") {
      applyModeSelection(this.view, this.mode, undefined, false);
    }
    this.scheduleCaretRefresh(this.view);
    this.emit();
  }

  setFocusSurfaceActive(active: boolean): void {
    if (this.focusSurfaceActive === active) return;
    this.focusSurfaceActive = active;
    if (!active) {
      this.clearFocusCaretRefresh();
      this.hideCaret();
      return;
    }
    if (this.view) this.scheduleFocusCaretRefresh(this.view);
  }

  destroy(): void {
    this.largePlainTextPasteAbort?.abort();
    this.largePlainTextPasteAbort = null;
    this.clipboardWriteGeneration += 1;
    this.clipboardReadGeneration += 1;
    this.navigationGeneration += 1;
    this.navigationInFlight = false;
    this.imeRequestGeneration += 1;
    this.unsubscribeRegister();
    this.unbind(this.view);
    this.gutter?.destroy();
    this.gutter = null;
    this.visualLineOverlay?.destroy();
    this.visualLineOverlay = null;
    if (this.refreshFrame !== null) {
      cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }
    this.caret?.remove();
    this.caret = null;
  }

  private bind(view: EditorView): void {
    if (this.view && this.view !== view) this.unbind(this.view);
    this.view = view;
    applyNativeCaretMode(view.dom, this.mode);
    view.dom.addEventListener("focus", this.handleFocus);
    view.dom.addEventListener("blur", this.handleBlur);
    view.dom.addEventListener("keydown", this.handleNativeKeyDown, true);
    view.dom.addEventListener(
      "compositionstart",
      this.handleCompositionStart,
      true,
    );
    view.dom.addEventListener(
      "compositionend",
      this.handleCompositionEnd,
      true,
    );
    document.addEventListener("selectionchange", this.handleLayoutChange);
    window.addEventListener("resize", this.handleLayoutChange);
    window.addEventListener("scroll", this.handleLayoutChange, true);
    window.addEventListener("focus", this.handleWindowFocus);
    this.scheduleCaretRefresh(view);
  }

  private unbind(view: EditorView | null): void {
    if (!view) return;
    this.clearFocusCaretRefresh();
    if (this.view === view) this.finishChangeUndoCapture();
    view.dom.removeEventListener("focus", this.handleFocus);
    view.dom.removeEventListener("blur", this.handleBlur);
    view.dom.removeEventListener("keydown", this.handleNativeKeyDown, true);
    view.dom.removeEventListener(
      "compositionstart",
      this.handleCompositionStart,
      true,
    );
    view.dom.removeEventListener(
      "compositionend",
      this.handleCompositionEnd,
      true,
    );
    document.removeEventListener("selectionchange", this.handleLayoutChange);
    window.removeEventListener("resize", this.handleLayoutChange);
    window.removeEventListener("scroll", this.handleLayoutChange, true);
    window.removeEventListener("focus", this.handleWindowFocus);
    delete view.dom.dataset.vimMode;
    view.dom.style.removeProperty("caret-color");
    if (this.view === view) {
      this.clipboardReadGeneration += 1;
      this.view = null;
    }
    this.hideCaret();
  }

  private readonly handleLayoutChange = (): void => {
    if (this.view) {
      this.scheduleCaretRefresh(this.view);
      this.gutter?.refreshCursor(
        this.mode === "visual-line" && this.visualLine
          ? this.visualLine.cursor
          : this.mode === "visual-block"
            ? visualBlockCursor({ state: this.view.state })
            : this.mode === "visual-char"
              ? visualCharCursor({ state: this.view.state })
              : this.view.state.selection instanceof NodeSelection
                ? this.view.state.selection.from
                : this.view.state.selection.head,
      );
      this.visualLineOverlay?.refreshLayout();
    }
  };

  private readonly handleFocus = (): void => {
    hideRenderedVimCarets();
    this.handleLayoutChange();
    if (this.view) this.schedulePostFocusCaretRefresh(this.view);
  };

  private readonly handleBlur = (): void => {
    // The custom Vim caret lives under document.body, outside the Window DOM.
    // Hide it synchronously so a newly focused Window never leaves the old
    // Window's caret visible until the next animation frame.
    this.clearFocusCaretRefresh();
    this.hideCaret();
    this.handleLayoutChange();
  };

  private readonly handleWindowFocus = (): void => {
    this.clipboardReadGeneration += 1;
    this.normalPutClipboardDirty = true;
    this.normalPutClipboardReadInFlight = false;
    this.externalFileClipboardPaths = null;
  };

  private readonly handleNativeKeyDown = (event: KeyboardEvent): void => {
    if (this.view && this.handleKeyDown(this.view, event)) {
      event.stopImmediatePropagation();
    }
  };

  private readonly handleCompositionStart = (): void => {
    this.setComposing(true);
  };

  private readonly handleCompositionEnd = (): void => {
    this.setComposing(false);
  };

  private handleBeforeInput(view: EditorView, input: InputEvent): boolean {
    if (this.largePlainTextPasteAbort) {
      input.preventDefault();
      return true;
    }
    if (signalsComposition(input)) this.setComposing(true);
    if (
      this.mode === "replace" &&
      !this.composing &&
      input.inputType === "insertText" &&
      input.data
    ) {
      input.preventDefault();
      if (!this.changeUndoCapture) {
        const undoManager = findUndoManager(view);
        undoManager?.stopCapturing();
        this.beginChangeUndoCapture(
          undoManager,
          undoManager?.undoStack.length ?? 0,
          selectionCursor(view),
        );
      }
      const result = runEditorReplaceText(view, input.data);
      this.action = `${result.detail}:${result.handled ? "changed" : "boundary"}`;
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }
    if (this.mode !== "insert" && mutatesDocument(input.inputType)) {
      input.preventDefault();
      this.action = `blocked:${input.inputType}`;
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }
    return false;
  }

  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    if (this.mode !== "insert" || this.composing || !event.clipboardData) {
      return false;
    }
    const internalRegister = readInternalClipboard(
      event.clipboardData,
      view.state.schema,
    );
    if (internalRegister) {
      this.clipboardReadGeneration += 1;
      const handled = this.pasteClipboardRegister(
        view,
        internalRegister,
        "internal",
      );
      if (handled) event.preventDefault();
      return handled;
    }

    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0 && this.options.onPasteFiles) {
      this.clipboardReadGeneration += 1;
      event.preventDefault();
      this.action = "attachment:paste:importing";
      this.emit();
      void Promise.resolve(this.options.onPasteFiles(files)).catch((error) => {
        this.options.onMessage?.(
          `添付ファイルを貼り付けられませんでした: ${String(error)}`,
        );
      });
      return true;
    }

    const markdown = readMarkdownClipboardSource(event.clipboardData);
    if (markdown && this.pasteMarkdownNote(view, markdown, "markdown")) {
      this.clipboardReadGeneration += 1;
      event.preventDefault();
      return true;
    }

    const fallback = readPasteFallback(event.clipboardData);
    const tabularRegister = registerFromTabularClipboard(
      {
        html: fallback.html,
        tsv: event.clipboardData.getData(TSV_CLIPBOARD_MIME) || null,
        markdown: markdown || null,
        plain: fallback.plain,
      },
      view.state.schema,
    );
    if (tabularRegister) {
      this.clipboardReadGeneration += 1;
      const handled = this.pasteClipboardRegister(
        view,
        tabularRegister,
        "internal",
      );
      if (handled) event.preventDefault();
      return handled;
    }

    const markdownRegister = readMarkdownClipboard(
      event.clipboardData,
      view.state.schema,
    );
    if (markdownRegister) {
      this.clipboardReadGeneration += 1;
      const handled = this.pasteClipboardRegister(
        view,
        markdownRegister,
        "markdown",
      );
      if (handled) event.preventDefault();
      return handled;
    }

    if (
      !this.options.onPasteRead ||
      !shouldReadPreferredClipboard(event.clipboardData)
    ) {
      if (
        fallback.plain &&
        this.pasteMarkdownNote(view, fallback.plain, "plain")
      ) {
        this.clipboardReadGeneration += 1;
        event.preventDefault();
        return true;
      }
      if (fallback.plain && isLargePlainTextPaste(fallback.plain)) {
        event.preventDefault();
        return this.beginLargePlainTextPaste(view, fallback.plain);
      }
      return false;
    }

    const generation = ++this.clipboardReadGeneration;
    const document = view.state.doc;
    const selection = view.state.selection;
    event.preventDefault();
    this.action = "clipboard:paste:reading";
    this.emit();

    let pending:
      | PreferredClipboardFormats
      | null
      | Promise<PreferredClipboardFormats | null>;
    try {
      pending = this.options.onPasteRead();
    } catch {
      this.finishPreferredClipboardPaste(
        generation,
        view,
        document,
        selection,
        fallback,
        null,
      );
      return true;
    }
    void Promise.resolve(pending).then(
      (formats) =>
        this.finishPreferredClipboardPaste(
          generation,
          view,
          document,
          selection,
          fallback,
          formats,
        ),
      () =>
        this.finishPreferredClipboardPaste(
          generation,
          view,
          document,
          selection,
          fallback,
          null,
        ),
    );
    return true;
  }

  private finishPreferredClipboardPaste(
    generation: number,
    view: EditorView,
    document: ProseMirrorNode,
    selection: Selection,
    fallback: PasteFallback,
    formats: PreferredClipboardFormats | null,
  ): void {
    if (
      generation !== this.clipboardReadGeneration ||
      view !== this.view ||
      view.isDestroyed
    ) {
      return;
    }
    if (
      this.mode !== "insert" ||
      this.composing ||
      !view.state.doc.eq(document) ||
      !view.state.selection.eq(selection)
    ) {
      this.action = "clipboard:paste:stale";
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }

    const internalRegister = formats?.internal
      ? decodeVimClipboard(formats.internal, view.state.schema)
      : null;
    if (
      internalRegister &&
      this.pasteClipboardRegister(view, internalRegister, "internal")
    ) {
      return;
    }
    if (formats?.filePaths?.length && this.options.onPasteNativePaths) {
      this.action = "attachment:paste-native:importing";
      this.emit();
      void Promise.resolve(
        this.options.onPasteNativePaths(formats.filePaths),
      ).catch((error) => {
        this.options.onMessage?.(
          `添付ファイルを貼り付けられませんでした: ${String(error)}`,
        );
      });
      return;
    }
    const resolvedFallback: PasteFallback = {
      html: formats?.html || fallback.html,
      plain: formats?.plain || fallback.plain,
    };
    if (
      formats?.markdown &&
      this.pasteMarkdownNote(view, formats.markdown, "markdown")
    ) {
      return;
    }
    if (
      resolvedFallback.plain &&
      this.pasteMarkdownNote(view, resolvedFallback.plain, "plain")
    ) {
      return;
    }
    const tabularRegister = formats
      ? registerFromTabularClipboard(
          { ...formats, plain: resolvedFallback.plain },
          view.state.schema,
        )
      : null;
    if (
      tabularRegister &&
      this.pasteClipboardRegister(view, tabularRegister, "internal")
    ) {
      return;
    }
    if (
      resolvedFallback.html &&
      this.pasteClipboardFallback(view, "html", resolvedFallback)
    ) {
      return;
    }

    const markdownRegister = formats?.markdown
      ? registerFromMarkdown(formats.markdown, view.state.schema)
      : null;
    if (
      markdownRegister &&
      this.pasteClipboardRegister(view, markdownRegister, "markdown")
    ) {
      return;
    }
    if (
      resolvedFallback.plain &&
      this.pasteClipboardFallback(view, "plain", resolvedFallback)
    ) {
      return;
    }

    this.action = "clipboard:paste:empty";
    this.emit();
    this.scheduleCaretRefresh(view);
  }

  private pasteMarkdownNote(
    view: EditorView,
    markdown: string,
    source: "markdown" | "plain",
  ): boolean {
    const undoManager = findUndoManager(view);
    const standaloneUndo = this.shouldCreateStandaloneUndoUnit(undoManager);
    const result = runMarkdownNoteImport(
      view,
      markdown,
      this.options.getRootNoteId?.() ?? null,
      {
        beforeDispatch: () => {
          if (standaloneUndo) undoManager?.stopCapturing();
        },
      },
    );
    if (!result.changed) return false;
    if (standaloneUndo) undoManager?.stopCapturing();
    this.action = `clipboard:paste:markdown-note:${source}:changed`;
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  private pasteClipboardRegister(
    view: EditorView,
    register: VimRegister,
    source: "internal" | "markdown",
  ): boolean {
    const undoManager = findUndoManager(view);
    const standaloneUndo = this.shouldCreateStandaloneUndoUnit(undoManager);
    if (standaloneUndo) undoManager?.stopCapturing();
    const handled = pasteVimRegisterAtSelection(view, register);
    if (standaloneUndo) undoManager?.stopCapturing();
    if (!handled) return false;
    this.action =
      source === "internal"
        ? `clipboard:paste:${register.kind}:changed`
        : "clipboard:paste:markdown:changed";
    this.registerStore.set(register);
    this.scheduleCaretRefresh(view);
    return true;
  }

  private beginLargePlainTextPaste(view: EditorView, text: string): boolean {
    this.largePlainTextPasteAbort?.abort();
    const abort = new AbortController();
    this.largePlainTextPasteAbort = abort;
    const generation = ++this.clipboardReadGeneration;
    const document = view.state.doc;
    const selection = view.state.selection;
    this.action = "clipboard:paste:large:preparing:0%";
    this.emit();

    void prepareLargePlainTextPaste(text, {
      signal: abort.signal,
      onProgress: (processed, total) => {
        if (this.largePlainTextPasteAbort !== abort || total <= 0) return;
        const percent = Math.min(100, Math.floor((processed / total) * 100));
        this.action = `clipboard:paste:large:preparing:${percent}%`;
        this.emit();
      },
    })
      .then(
        (blocks) => {
          if (
            this.largePlainTextPasteAbort !== abort ||
            generation !== this.clipboardReadGeneration ||
            view !== this.view ||
            view.isDestroyed ||
            this.mode !== "insert" ||
            this.composing ||
            !view.state.doc.eq(document) ||
            !view.state.selection.eq(selection)
          ) {
            if (this.largePlainTextPasteAbort === abort) {
              this.action = "clipboard:paste:large:stale";
            }
            return;
          }
          const undoManager = findUndoManager(view);
          const standaloneUndo =
            this.shouldCreateStandaloneUndoUnit(undoManager);
          if (standaloneUndo) undoManager?.stopCapturing();
          const changed = this.applyLargePlainTextPaste(view, text, blocks);
          if (standaloneUndo) undoManager?.stopCapturing();
          this.action = changed
            ? "clipboard:paste:large:changed"
            : "clipboard:paste:large:empty";
          this.scheduleCaretRefresh(view);
        },
        (error: unknown) => {
          if (this.largePlainTextPasteAbort !== abort) return;
          this.action =
            error instanceof DOMException && error.name === "AbortError"
              ? "clipboard:paste:large:cancelled"
              : "clipboard:paste:large:failed";
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            this.options.onMessage?.(
              `大きなテキストを貼り付けられませんでした: ${String(error)}`,
            );
          }
        },
      )
      .finally(() => {
        if (this.largePlainTextPasteAbort === abort) {
          this.largePlainTextPasteAbort = null;
          this.emit();
        }
      });
    return true;
  }

  private applyLargePlainTextPaste(
    view: EditorView,
    text: string,
    blocks: readonly string[],
  ): boolean {
    if (view.state.selection.$from.parent.type.spec.code) {
      const normalized = text.replace(/\r\n?/gu, "\n");
      if (normalized.length === 0) return false;
      view.dispatch(view.state.tr.insertText(normalized).scrollIntoView());
      return true;
    }
    const paragraph = view.state.schema.nodes.paragraph;
    if (!paragraph || blocks.length === 0) return false;
    const marks = view.state.selection.$from.marks();
    const nodes = blocks.map((block) =>
      paragraph.create(
        { blockId: createUuidV7() },
        block.length > 0 ? view.state.schema.text(block, marks) : null,
      ),
    );
    const transaction = view.state.tr
      .replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0))
      .scrollIntoView();
    if (!transaction.docChanged) return false;
    view.dispatch(transaction);
    return true;
  }

  private cancelLargePlainTextPaste(): void {
    const pending = this.largePlainTextPasteAbort;
    if (!pending) return;
    this.largePlainTextPasteAbort = null;
    this.clipboardReadGeneration += 1;
    pending.abort();
    this.action = "clipboard:paste:large:cancelled";
    this.emit();
  }

  private pasteClipboardFallback(
    view: EditorView,
    type: "html" | "plain",
    fallback: PasteFallback,
  ): boolean {
    if (type === "plain" && isLargePlainTextPaste(fallback.plain)) {
      return this.beginLargePlainTextPaste(view, fallback.plain);
    }
    const undoManager = findUndoManager(view);
    const standaloneUndo = this.shouldCreateStandaloneUndoUnit(undoManager);
    if (standaloneUndo) undoManager?.stopCapturing();
    const syntheticEvent = new Event("paste") as ClipboardEvent;
    const handled =
      type === "html"
        ? view.pasteHTML(fallback.html, syntheticEvent)
        : view.pasteText(fallback.plain, syntheticEvent);
    if (standaloneUndo) undoManager?.stopCapturing();
    if (!handled) return false;
    this.action = `clipboard:paste:${type}:changed`;
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  private handleClick(
    view: EditorView,
    position: number,
    event: MouseEvent,
  ): boolean {
    if (this.mode !== "normal" || this.composing || event.button !== 0) {
      return false;
    }
    const before = view.state.selection;
    applyModeSelection(view, "normal", position);
    this.action = `cursor:click:${before.eq(view.state.selection) ? "boundary" : "changed"}`;
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  private handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (this.largePlainTextPasteAbort) {
      event.preventDefault();
      if (
        event.key === "Escape" ||
        (event.ctrlKey && event.key.toLowerCase() === "c")
      ) {
        this.cancelLargePlainTextPaste();
      }
      return true;
    }
    const isComposing = event.isComposing || this.composing;
    if (
      !isComposing &&
      this.mode === "insert" &&
      event.ctrlKey &&
      event.key === "Enter"
    ) {
      const undoManager = findUndoManager(view);
      const standaloneUndo = this.shouldCreateStandaloneUndoUnit(undoManager);
      if (standaloneUndo) undoManager?.stopCapturing();
      const result = runEditorExitBlock(view);
      if (result.handled) {
        event.preventDefault();
        if (standaloneUndo) undoManager?.stopCapturing();
        this.action = `${result.detail}:changed`;
        this.emit();
        this.scheduleCaretRefresh(view);
        return true;
      }
    }
    if (
      !isComposing &&
      this.mode === "insert" &&
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const result = runEditorInsertEnter(view, event.shiftKey);
      if (result.handled) {
        event.preventDefault();
        this.action = `${result.detail}:changed`;
        this.emit();
        this.scheduleCaretRefresh(view);
        return true;
      }
    }
    if (
      !isComposing &&
      this.mode === "insert" &&
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const result = runEditorInsertBoundaryDelete(
        view,
        event.key === "Backspace" ? "backward" : "forward",
      );
      if (result.handled || result.preventDefault) {
        event.preventDefault();
        this.action = `${result.detail}:${result.handled ? "changed" : "boundary"}`;
        this.emit();
        this.scheduleCaretRefresh(view);
        return true;
      }
    }
    if (!isComposing && isTabKey(event) && this.mode === "insert") {
      event.preventDefault();
      const result = runEditorTab(view, isReverseTab(event));
      view.focus();
      this.action = `${result.detail}:${result.handled ? "changed" : "boundary"}`;
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }
    if (!isComposing && isTabKey(event) && this.mode !== "normal") {
      event.preventDefault();
      view.focus();
      this.action = "tab:focus-kept:boundary";
      this.emit();
      return true;
    }

    const resolution = advanceVimInput(
      this.input,
      this.mode,
      eventSequence(event),
      {
        isComposing,
        targetKind: "note-body",
      },
      this.options.keyConfig,
    );
    this.input = resolution.state;

    if (resolution.action.kind === "pending") {
      event.preventDefault();
      this.action =
        resolution.action.detail === "pending:count"
          ? `pending:count:${resolution.count}`
          : resolution.action.detail;
      this.emit();
      return true;
    }

    if (resolution.action.kind === "leader-shortcut") {
      event.preventDefault();
      if (resolution.action.resolution) {
        this.options.onMessage?.(
          leaderShortcutMessage(
            resolution.action.resolution,
            this.options.keyConfig?.leaderKey ?? ",",
          ),
        );
        this.action = `leader:${resolution.action.resolution.kind}`;
      } else {
        this.action = "leader:cancelled";
      }
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    const command = resolution.resolvedCommand;
    if (command?.startsWith("mode.")) {
      event.preventDefault();
      if (command === "mode.insert" || command === "mode.append") {
        const horizontalRule = runEditorEnterInsertFromHorizontalRule(
          view,
          command === "mode.insert" ? "before" : "after",
        );
        if (!horizontalRule.handled && command === "mode.append") {
          runEditorVimCommand(
            view,
            "cursor.right",
            "insert",
            this.registerStore.read(view.state.schema),
          );
        }
        this.changeMode(view, "insert");
      } else if (command === "mode.replace") {
        const undoManager = findUndoManager(view);
        undoManager?.stopCapturing();
        this.beginChangeUndoCapture(
          undoManager,
          undoManager?.undoStack.length ?? 0,
          selectionCursor(view),
        );
        this.changeMode(view, "replace");
      } else if (command === "mode.visual-block") {
        if (beginVisualBlock(view)) {
          this.changeMode(view, "visual-block");
        } else {
          this.action = "mode:visual-block:table-only";
          this.emit();
          this.scheduleCaretRefresh(view);
        }
      } else {
        this.changeMode(view, modeForCommand(command));
      }
      return true;
    }

    if (command === "history.undo" || command === "history.redo") {
      event.preventDefault();
      this.runHistory(view, command === "history.undo" ? "undo" : "redo");
      return true;
    }

    if (command === "edit.repeat") {
      event.preventDefault();
      this.runRepeat(view, resolution.count, resolution.countExplicit ?? false);
      return true;
    }

    if (command && isVimWindowCommand(command)) {
      event.preventDefault();
      this.options.onWindowCommand?.(command);
      this.action = this.options.onWindowCommand
        ? `${command}:requested`
        : `${command}:unavailable`;
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command && isVimApplicationCommand(command)) {
      event.preventDefault();
      this.options.onApplicationCommand?.(command);
      this.action = this.options.onApplicationCommand
        ? `${command}:requested`
        : `${command}:unavailable`;
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (
      command === "section.focus-current" ||
      command === "section.focus-parent"
    ) {
      event.preventDefault();
      const currentSectionId = sectionIdAtEditorSelection(view.state);
      if (currentSectionId) {
        this.options.onSectionFocus?.(
          command === "section.focus-current" ? "current" : "parent",
          currentSectionId,
        );
      }
      this.action = this.options.onSectionFocus
        ? `${command}:requested`
        : `${command}:unavailable`;
      this.emit();
      return true;
    }

    if (command === "section.demote" || command === "section.promote") {
      event.preventDefault();
      const request = sectionDepthShiftSelection(
        view,
        this.mode,
        resolution.count,
        this.mode === "visual-line" ? this.visualLine : null,
      );
      if (!request) {
        this.action = `${command}:boundary`;
        this.emit();
        this.scheduleCaretRefresh(view);
        return true;
      }
      const requestMode = this.mode;
      if (this.mode === "visual-line") {
        this.changeMode(view, "normal");
      }
      const pending = this.options.onSectionDepthShift?.({
        ...request,
        direction: command === "section.demote" ? "deeper" : "shallower",
        mode: requestMode,
      });
      this.action = this.options.onSectionDepthShift
        ? `${command}:requested`
        : `${command}:unavailable`;
      this.emit();
      if (pending && typeof (pending as Promise<unknown>).then === "function") {
        void Promise.resolve(pending).catch(() => undefined);
      }
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "selection.format") {
      event.preventDefault();
      const opened = this.options.onInlineFormat?.() ?? false;
      this.action = opened
        ? "selection:format:open"
        : "selection:format:unavailable";
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "context.action_picker") {
      event.preventDefault();
      const selection = captureTableActionSelection(
        view,
        this.mode,
        this.visualLine,
      );
      const opened = selection
        ? (this.options.onTableActions?.(selection) ?? false)
        : false;
      this.action = opened ? "table:actions:open" : "table:actions:unavailable";
      if (!opened) {
        const shortcut = leaderShortcutForCommand("context.action_picker");
        this.options.onMessage?.(
          `${this.options.keyConfig?.leaderKey ?? ","}${shortcut.key} · ${shortcut.label} · 利用可能な操作がありません`,
        );
      }
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "navigation.open-external-link") {
      event.preventDefault();
      this.openExternalLink(view);
      return true;
    }

    if (
      command === "navigation.follow-link" ||
      command === "navigation.jump-back" ||
      command === "navigation.jump-forward"
    ) {
      event.preventDefault();
      this.runNavigation(view, command);
      return true;
    }

    if (command === "note.search") {
      event.preventDefault();
      this.options.onNoteSearch?.(selectionCursor(view));
      this.action = this.options.onNoteSearch
        ? "search:note:open"
        : "search:note:unavailable";
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "note.search_next" || command === "note.search_previous") {
      event.preventDefault();
      this.startNoteSearchRepeat(
        view,
        command === "note.search_next" ? "forward" : "backward",
        resolution.count,
      );
      return true;
    }

    if (
      command === "workspace.search_title" ||
      command === "workspace.search_body" ||
      command === "workspace.search_buffers"
    ) {
      event.preventDefault();
      const scope = command === "workspace.search_body" ? "body" : "title";
      const target =
        command === "workspace.search_buffers" ? "buffers" : "workspace";
      this.options.onWorkspaceSearch?.(selectionCursor(view), scope, target);
      this.action = this.options.onWorkspaceSearch
        ? `search:${target}:${scope}:open`
        : "search:workspace:unavailable";
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "application.command_line") {
      event.preventDefault();
      this.options.onCommandLine?.();
      this.action = this.options.onCommandLine
        ? "command-line:open"
        : "command-line:unavailable";
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (command === "application.command_picker") {
      event.preventDefault();
      this.options.onCommandPicker?.();
      this.action = this.options.onCommandPicker
        ? "command-picker:open"
        : "command-picker:unavailable";
      this.emit();
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (
      this.mode === "normal" &&
      (command === "put.after" || command === "put.before")
    ) {
      event.preventDefault();
      this.runNormalPut(
        view,
        command,
        resolution.count,
        resolution.countExplicit ?? false,
      );
      return true;
    }

    if (command) {
      event.preventDefault();
      const currentRegister = this.registerStore.read(view.state.schema);
      const undoManager = findUndoManager(view);
      const cursorBeforeCommand =
        this.mode === "visual-char"
          ? view.state.selection.from
          : this.mode === "visual-block"
            ? visualBlockCursor(view)
            : selectionCursor(view);
      const isolateUndo = isolatesUndoUnit(command, resolution.operator);
      const continuesIntoInsert = changesIntoInsert(
        command,
        resolution.operator,
      );
      const undoStackDepth = undoManager?.undoStack.length ?? 0;
      const tableRectangle =
        this.mode === "visual-block" ? visualBlockDimensions(view) : null;
      if (isolateUndo) undoManager?.stopCapturing();
      const putCheckpoint =
        command === "put.after" || command === "put.before"
          ? {
              cursor: selectionCursor(view),
              manager: undoManager,
            }
          : null;
      const result = resolution.operator
        ? runEditorVimOperator(
            view,
            resolution.operator,
            command,
            resolution.count,
          )
        : command === "replace.character" && resolution.argument
          ? runEditorReplaceCharacter(
              view,
              resolution.argument,
              resolution.count,
            )
          : this.mode === "visual-line" && this.visualLine
            ? runVisualLineCommand(
                view,
                command,
                this.visualLine,
                currentRegister,
                resolution.count,
                resolution.countExplicit,
              )
            : this.mode === "visual-block"
              ? runVisualBlockCommand(
                  view,
                  command,
                  currentRegister,
                  resolution.count,
                )
              : runEditorVimCommand(
                  view,
                  command,
                  this.mode,
                  currentRegister,
                  resolution.count,
                  resolution.countExplicit,
                  this.options.keyConfig,
                );
      const repeatDescriptor = result.handled
        ? createVimRepeatDescriptor({
            mode: this.mode,
            command,
            operator: resolution.operator,
            count: resolution.count,
            countExplicit: resolution.countExplicit ?? false,
            argument: resolution.argument,
            tableRectangle: tableRectangle ?? undefined,
          })
        : null;
      if (result.handled && putCheckpoint) {
        putCheckpoint.manager?.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
          beforeCursor: putCheckpoint.cursor,
          afterCursor: selectionCursor(view),
        } satisfies CursorHistoryEntry);
      }
      if (
        result.handled &&
        tableRectangle &&
        !continuesIntoInsert &&
        (command === "selection.delete" || command === "selection.paste")
      ) {
        undoManager?.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
          beforeCursor: cursorBeforeCommand,
          afterCursor: selectionCursor(view),
        } satisfies CursorHistoryEntry);
      }
      putCheckpoint?.manager?.stopCapturing();
      if (result.visualLine) this.visualLine = result.visualLine;
      const clipboardRegister =
        result.handled &&
        result.register &&
        (resolution.operator === "yank" ||
          command === "line.yank" ||
          command === "selection.yank")
          ? result.register
          : null;
      if (
        result.handled &&
        continuesIntoInsert &&
        result.nextMode === "insert"
      ) {
        this.beginChangeUndoCapture(
          undoManager,
          undoStackDepth,
          cursorBeforeCommand,
        );
      }
      if (result.nextMode) this.changeMode(view, result.nextMode);
      else if (result.visualLine) this.refreshVisualLineDecorations(view);
      if (isolateUndo && !continuesIntoInsert) undoManager?.stopCapturing();
      if (repeatDescriptor) this.repeatStore.record(repeatDescriptor);
      this.action = `${result.detail}${resolution.count > 1 ? `:count:${resolution.count}` : ""}:${result.handled ? "changed" : "boundary"}`;
      if (result.consumeRegister) this.registerStore.clear();
      else if (result.register !== undefined)
        this.registerStore.set(result.register);
      else this.emit();
      if (clipboardRegister) this.writeClipboard(clipboardRegister);
      this.scheduleCaretRefresh(view);
      return true;
    }

    if (!isComposing && suppressUnmappedEditingKey(this.mode, event)) {
      event.preventDefault();
      this.action = `blocked:key:${event.key}`;
      this.emit();
      return true;
    }

    this.scheduleCaretRefresh(view);
    return false;
  }

  private runNormalPut(
    view: EditorView,
    command: "put.after" | "put.before",
    count: number,
    countExplicit: boolean,
  ): void {
    if (
      this.externalFileClipboardPaths?.length &&
      this.options.onPasteNativePaths
    ) {
      this.putNativeClipboardFiles(
        view,
        command,
        count,
        this.externalFileClipboardPaths,
      );
      return;
    }
    if (
      this.normalPutClipboardReadInFlight ||
      (this.normalPutClipboardDirty &&
        this.options.onPasteRead &&
        this.options.onPasteNativePaths)
    ) {
      if (!this.normalPutClipboardReadInFlight) {
        this.readClipboardForNormalPut(view, command, count, countExplicit);
      } else {
        this.action = "clipboard:put:reading";
        this.emit();
      }
      return;
    }
    this.putWorkspaceRegister(view, command, count, countExplicit);
  }

  private readClipboardForNormalPut(
    view: EditorView,
    command: "put.after" | "put.before",
    count: number,
    countExplicit: boolean,
  ): void {
    const reader = this.options.onPasteRead;
    if (!reader) {
      this.putWorkspaceRegister(view, command, count, countExplicit);
      return;
    }
    const generation = ++this.clipboardReadGeneration;
    const document = view.state.doc;
    const selection = view.state.selection;
    this.normalPutClipboardDirty = false;
    this.normalPutClipboardReadInFlight = true;
    this.action = "clipboard:put:reading";
    this.emit();

    let pending:
      | PreferredClipboardFormats
      | null
      | Promise<PreferredClipboardFormats | null>;
    try {
      pending = reader();
    } catch {
      pending = null;
    }
    void Promise.resolve(pending).then(
      (formats) =>
        this.finishClipboardReadForNormalPut(
          generation,
          view,
          document,
          selection,
          command,
          count,
          countExplicit,
          formats,
        ),
      () =>
        this.finishClipboardReadForNormalPut(
          generation,
          view,
          document,
          selection,
          command,
          count,
          countExplicit,
          null,
        ),
    );
  }

  private finishClipboardReadForNormalPut(
    generation: number,
    view: EditorView,
    document: ProseMirrorNode,
    selection: Selection,
    command: "put.after" | "put.before",
    count: number,
    countExplicit: boolean,
    formats: PreferredClipboardFormats | null,
  ): void {
    if (
      generation !== this.clipboardReadGeneration ||
      view !== this.view ||
      view.isDestroyed
    ) {
      return;
    }
    this.normalPutClipboardReadInFlight = false;
    if (
      this.mode !== "normal" ||
      this.composing ||
      !view.state.doc.eq(document) ||
      !view.state.selection.eq(selection)
    ) {
      this.normalPutClipboardDirty = true;
      this.action = "clipboard:put:stale";
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }

    const internalRegister = formats?.internal
      ? decodeVimClipboard(formats.internal, view.state.schema)
      : null;
    if (internalRegister) {
      this.registerStore.set(internalRegister);
      this.putWorkspaceRegister(view, command, count, countExplicit);
      return;
    }
    if (formats?.filePaths?.length && this.options.onPasteNativePaths) {
      this.externalFileClipboardPaths = [...formats.filePaths];
      this.putNativeClipboardFiles(
        view,
        command,
        count,
        this.externalFileClipboardPaths,
      );
      return;
    }
    const tabularRegister = formats
      ? registerFromTabularClipboard(formats, view.state.schema)
      : null;
    if (tabularRegister) {
      this.registerStore.set(tabularRegister);
      this.putWorkspaceRegister(view, command, count, countExplicit);
      return;
    }
    this.externalFileClipboardPaths = null;
    this.putWorkspaceRegister(view, command, count, countExplicit);
  }

  private putNativeClipboardFiles(
    view: EditorView,
    command: "put.after" | "put.before",
    count: number,
    paths: readonly string[],
  ): void {
    const paste = this.options.onPasteNativePaths;
    if (!paste) return;
    const direction = command === "put.after" ? "after" : "before";
    this.action = `attachment:put-native:${direction}:importing`;
    this.emit();
    let pending: void | Promise<void>;
    try {
      pending = paste(paths, {
        direction,
        position: selectionCursor(view),
        count,
      });
    } catch (error) {
      this.options.onMessage?.(
        `添付ファイルを貼り付けられませんでした: ${String(error)}`,
      );
      return;
    }
    void Promise.resolve(pending).catch((error) => {
      this.options.onMessage?.(
        `添付ファイルを貼り付けられませんでした: ${String(error)}`,
      );
    });
    this.scheduleCaretRefresh(view);
  }

  private putWorkspaceRegister(
    view: EditorView,
    command: "put.after" | "put.before",
    count: number,
    countExplicit: boolean,
  ): void {
    const register = this.registerStore.read(view.state.schema);
    const undoManager = findUndoManager(view);
    const cursorBeforeCommand = selectionCursor(view);
    undoManager?.stopCapturing();
    const result = runEditorVimCommand(
      view,
      command,
      this.mode,
      register,
      count,
      countExplicit,
    );
    const repeatDescriptor = result.handled
      ? createVimRepeatDescriptor({
          mode: this.mode,
          command,
          operator: null,
          count,
          countExplicit,
        })
      : null;
    if (result.handled) {
      undoManager?.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
        beforeCursor: cursorBeforeCommand,
        afterCursor: selectionCursor(view),
      } satisfies CursorHistoryEntry);
    }
    undoManager?.stopCapturing();
    if (repeatDescriptor) this.repeatStore.record(repeatDescriptor);
    this.action = `${result.detail}${count > 1 ? `:count:${count}` : ""}:${result.handled ? "changed" : "boundary"}`;
    if (result.consumeRegister) this.registerStore.clear();
    else if (result.register !== undefined)
      this.registerStore.set(result.register);
    else this.emit();
    this.scheduleCaretRefresh(view);
  }

  private runRepeat(
    view: EditorView,
    count: number,
    countExplicit: boolean,
  ): void {
    const descriptor = this.repeatStore.read();
    if (!descriptor) {
      this.action = "repeat:empty";
      this.emit();
      return;
    }
    const undoManager = findUndoManager(view);
    undoManager?.stopCapturing();
    const undoStackDepth = undoManager?.undoStack.length ?? 0;
    const cursorBefore = selectionCursor(view);
    const continuesIntoInsert = changesIntoInsert(
      descriptor.command,
      descriptor.operator,
    );
    const result: EditorVimResult = descriptor.tableAction
      ? (() => {
          const tableResult = repeatTableAction(
            view,
            descriptor.tableAction,
            countExplicit ? count : 1,
          );
          return {
            handled: tableResult.changed,
            detail: `table:action:${descriptor.tableAction.action}`,
          };
        })()
      : descriptor.tableRectangle
        ? selectVisualBlockRectangle(
            view,
            descriptor.tableRectangle.width,
            descriptor.tableRectangle.height,
          )
          ? runVisualBlockCommand(
              view,
              descriptor.command,
              this.registerStore.read(view.state.schema),
              countExplicit ? count : descriptor.count,
            )
          : { handled: false, detail: "table:visual-block:repeat" }
        : replayVimRepeat(
            view,
            descriptor,
            this.registerStore.read(view.state.schema),
            count,
            countExplicit,
            this.options.keyConfig,
          );
    if (
      result.handled &&
      !continuesIntoInsert &&
      (descriptor.command === "put.after" ||
        descriptor.command === "put.before" ||
        (descriptor.tableRectangle &&
          (descriptor.command === "selection.delete" ||
            descriptor.command === "selection.paste")) ||
        descriptor.tableAction)
    ) {
      undoManager?.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
        beforeCursor: cursorBefore,
        afterCursor: selectionCursor(view),
      } satisfies CursorHistoryEntry);
    }
    if (result.handled && continuesIntoInsert && result.nextMode === "insert") {
      this.beginChangeUndoCapture(undoManager, undoStackDepth, cursorBefore);
    }
    if (!continuesIntoInsert) undoManager?.stopCapturing();
    if (result.nextMode) this.changeMode(view, result.nextMode);
    this.action = `repeat:${result.detail}${countExplicit && count > 1 ? `:count:${count}` : ""}:${result.handled ? "changed" : "boundary"}`;
    if (result.register !== undefined) this.registerStore.set(result.register);
    else this.emit();
    this.scheduleCaretRefresh(view);
  }

  applyNavigationPosition(
    position: number,
    detail: string,
    focus = true,
  ): boolean {
    const view = this.view;
    if (!view || view.isDestroyed) return false;
    const previousMode = this.mode;
    this.finishChangeUndoCapture();
    this.clipboardReadGeneration += 1;
    this.mode = "normal";
    this.input = createVimInputState();
    this.visualLine = null;
    applyNativeCaretMode(view.dom, "normal");
    applyModeSelection(view, "normal", position, focus);
    this.refreshVisualLineDecorations(view);
    this.action = detail;
    if (previousMode !== "normal") this.options.onModeChange?.("normal");
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  currentCursorPosition(): number | null {
    const view = this.view;
    if (!view || view.isDestroyed) return null;
    return this.mode === "visual-line" && this.visualLine
      ? this.visualLine.cursor
      : this.mode === "visual-block"
        ? visualBlockCursor(view)
        : visualCursor(view, this.mode);
  }

  prepareExternalMutationUndoBoundary(): void {
    const view = this.view;
    if (!view || view.isDestroyed) return;
    // Commands such as o/O and c keep their structural edit and subsequent
    // Insert input in one Vim change until Esc. A picker-confirmed mutation is
    // a separate command, so finish that capture before its Yjs transaction.
    this.finishChangeUndoCapture();
    findUndoManager(view)?.stopCapturing();
  }

  completeExternalSelectionMutation(
    position: number,
    beforeCursor: number,
    detail: string,
    repeat?: TableActionRepeat,
  ): boolean {
    const view = this.view;
    if (!view || view.isDestroyed) return false;
    const applied = this.applySectionDepthShiftPosition(
      position,
      "normal",
      detail,
      beforeCursor,
    );
    findUndoManager(view)?.stopCapturing();
    if (applied && repeat) {
      this.repeatStore.record({
        command: "context.action_picker",
        operator: null,
        count: 1,
        countExplicit: false,
        tableAction: repeat,
      });
    }
    if (applied) this.requestImeOff();
    return applied;
  }

  applyViewportCaretPosition(position: number): boolean {
    const view = this.view;
    if (!view || view.isDestroyed) return false;
    const result =
      this.mode === "visual-block"
        ? moveVisualBlockHeadToPosition(view, position)
        : moveVimSelectionToViewportPosition(
            view,
            this.mode,
            position,
            this.visualLine,
          );
    if (!result.handled) return false;
    if (result.visualLine) this.visualLine = result.visualLine;
    this.input = createVimInputState();
    this.refreshVisualLineDecorations(view);
    this.action = `${result.detail}:changed`;
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  applySectionDepthShiftPosition(
    position: number,
    mode: VimMode,
    detail: string,
    beforeCursor?: number,
  ): boolean {
    const view = this.view;
    if (!view || view.isDestroyed) return false;
    const previousMode = this.mode;
    this.mode = mode === "visual-line" ? "normal" : mode;
    this.input = createVimInputState();
    this.visualLine = null;
    applyNativeCaretMode(view.dom, this.mode);
    applyModeSelection(view, this.mode, position);
    const manager = findUndoManager(view);
    if (beforeCursor !== undefined && manager) {
      recordVimCursorHistory(manager, beforeCursor, position);
    }
    this.refreshVisualLineDecorations(view);
    this.action = detail;
    if (previousMode !== this.mode) this.options.onModeChange?.(this.mode);
    this.emit();
    this.scheduleCaretRefresh(view);
    return true;
  }

  private runNavigation(
    view: EditorView,
    command:
      | "navigation.follow-link"
      | "navigation.jump-back"
      | "navigation.jump-forward",
  ): void {
    const cursor = selectionCursor(view);
    if (command === "navigation.follow-link") {
      const target = internalSectionLinkAtPosition(view.state, cursor);
      if (!target) {
        this.action = "jump:gf:boundary";
        this.emit();
        this.scheduleCaretRefresh(view);
        return;
      }
      this.startNavigation(view, {
        kind: "follow-link",
        cursor,
        target,
      });
      return;
    }
    this.startNavigation(view, {
      kind: command === "navigation.jump-back" ? "back" : "forward",
      cursor,
    });
  }

  private openExternalLink(view: EditorView): void {
    const attachmentId = attachmentIdAtPosition(
      view.state.doc,
      selectionCursor(view),
    );
    if (attachmentId) {
      const opener = this.options.onOpenAttachment;
      if (!opener) {
        this.action = "attachment:gx:opener-unavailable";
        this.options.onMessage?.("gx · 添付ファイルopenerを利用できません");
        this.emit();
        return;
      }
      this.action = "attachment:gx:opening";
      this.emit();
      void Promise.resolve(opener(attachmentId)).then(
        () => {
          if (view !== this.view || view.isDestroyed) return;
          this.action = "attachment:gx:opened";
          this.options.onMessage?.("gx · 添付ファイルを開きました");
          this.emit();
          this.scheduleCaretRefresh(view);
        },
        (error) => {
          if (view !== this.view || view.isDestroyed) return;
          this.action = `attachment:gx:error:${String(error)}`;
          this.options.onMessage?.(
            `gx · 添付ファイルを開けませんでした: ${String(error)}`,
          );
          this.emit();
          this.scheduleCaretRefresh(view);
        },
      );
      return;
    }
    const href = externalLinkAtPosition(view.state.doc, selectionCursor(view));
    if (!href) {
      this.action = "link:gx:boundary";
      this.options.onMessage?.("gx · キャレット位置に外部リンクがありません");
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }
    const normalized = normalizeExternalLink(href);
    if (!normalized.valid) {
      this.action = "link:gx:unsafe";
      this.options.onMessage?.("gx · 安全でないURLは開けません");
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }
    if (normalized.kind === "relative") {
      this.action = "link:gx:relative-base-unavailable";
      this.options.onMessage?.(
        "gx · 相対URLを解決する基準ディレクトリはまだありません",
      );
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }
    const opener = this.options.onOpenExternalLink;
    if (!opener) {
      this.action = "link:gx:opener-unavailable";
      this.options.onMessage?.("gx · URL openerを利用できません");
      this.emit();
      this.scheduleCaretRefresh(view);
      return;
    }
    this.action = "link:gx:opening";
    this.emit();
    let pending: void | Promise<void>;
    try {
      pending = opener(normalized.href);
    } catch (error) {
      this.action = `link:gx:error:${String(error)}`;
      this.options.onMessage?.(`gx · URLを開けませんでした: ${String(error)}`);
      this.emit();
      return;
    }
    void Promise.resolve(pending).then(
      () => {
        if (view !== this.view || view.isDestroyed) return;
        this.action = "link:gx:opened";
        this.options.onMessage?.(`gx · ${normalized.href} を開きました`);
        this.emit();
        this.scheduleCaretRefresh(view);
      },
      (error) => {
        if (view !== this.view || view.isDestroyed) return;
        this.action = `link:gx:error:${String(error)}`;
        this.options.onMessage?.(
          `gx · URLを開けませんでした: ${String(error)}`,
        );
        this.emit();
        this.scheduleCaretRefresh(view);
      },
    );
    this.scheduleCaretRefresh(view);
  }

  private startNoteSearchRepeat(
    view: EditorView,
    direction: NoteSearchDirection,
    count: number,
  ): void {
    if (this.navigationInFlight) {
      this.action = "search:note:busy";
      this.emit();
      return;
    }
    const search = this.options.onNoteSearchRepeat;
    if (!search) {
      this.action = "search:note:unavailable";
      this.emit();
      return;
    }
    const generation = ++this.navigationGeneration;
    this.navigationInFlight = true;
    this.action = `search:note:${direction}:pending`;
    this.emit();
    let pending: EditorNavigationResult | Promise<EditorNavigationResult>;
    try {
      pending = search(selectionCursor(view), direction, count);
    } catch (error) {
      this.finishNavigation(generation, view, {
        handled: false,
        detail: `search:note:${direction}:error:${String(error)}`,
      });
      return;
    }
    void Promise.resolve(pending).then(
      (result) => this.finishNavigation(generation, view, result),
      (error) =>
        this.finishNavigation(generation, view, {
          handled: false,
          detail: `search:note:${direction}:error:${String(error)}`,
        }),
    );
  }

  private startNavigation(
    view: EditorView,
    intent: EditorNavigationIntent,
  ): void {
    if (this.navigationInFlight) {
      this.action = "jump:busy";
      this.emit();
      return;
    }
    const navigate = this.options.onNavigate;
    if (!navigate) {
      this.action = `jump:${intent.kind}:unavailable`;
      this.emit();
      return;
    }
    const generation = ++this.navigationGeneration;
    this.navigationInFlight = true;
    this.action = `jump:${intent.kind}:pending`;
    this.emit();
    let pending: EditorNavigationResult | Promise<EditorNavigationResult>;
    try {
      pending = navigate(intent);
    } catch (error) {
      this.finishNavigation(generation, view, {
        handled: false,
        detail: `jump:${intent.kind}:error:${String(error)}`,
      });
      return;
    }
    void Promise.resolve(pending).then(
      (result) => this.finishNavigation(generation, view, result),
      (error) =>
        this.finishNavigation(generation, view, {
          handled: false,
          detail: `jump:${intent.kind}:error:${String(error)}`,
        }),
    );
  }

  private finishNavigation(
    generation: number,
    view: EditorView,
    result: EditorNavigationResult,
  ): void {
    if (generation !== this.navigationGeneration) {
      return;
    }
    this.navigationInFlight = false;
    if (view !== this.view || view.isDestroyed) return;
    this.action = result.detail;
    this.emit();
    this.scheduleCaretRefresh(view);
  }

  private changeMode(view: EditorView, nextMode: VimMode): void {
    const previousMode = this.mode;
    const visualBlockExitCursor =
      previousMode === "visual-block" ? visualBlockCursor(view) : undefined;
    const insertExitCursor =
      (previousMode === "insert" || previousMode === "replace") &&
      nextMode === "normal"
        ? vimBlockCursorBeforeInsertCaret(view)
        : undefined;
    if (
      (previousMode === "insert" || previousMode === "replace") &&
      nextMode !== previousMode
    ) {
      const undoManager = findUndoManager(view);
      const capturedManager = this.changeUndoCapture?.manager ?? null;
      this.finishChangeUndoCapture(insertExitCursor);
      if (undoManager !== capturedManager) undoManager?.stopCapturing();
    }
    this.clipboardReadGeneration += 1;
    this.mode = nextMode;
    this.input = createVimInputState();
    applyNativeCaretMode(view.dom, nextMode);

    if (nextMode === "visual-line") {
      this.visualLine = beginVisualLine(view);
      this.refreshVisualLineDecorations(view);
    } else if (nextMode === "visual-block") {
      this.visualLine = null;
      if (!(view.state.selection instanceof TextSelection)) {
        view.focus();
      } else if (!beginVisualBlock(view)) {
        this.mode = "normal";
        applyNativeCaretMode(view.dom, "normal");
        applyModeSelection(view, "normal", view.state.selection.head);
        nextMode = "normal";
      }
    } else {
      const cursor =
        insertExitCursor ?? visualBlockExitCursor ?? this.visualLine?.cursor;
      this.visualLine = null;
      applyModeSelection(view, nextMode, cursor);
    }

    this.action = `mode:${nextMode}`;
    if (nextMode === "normal") this.requestImeOff();
    if (previousMode !== nextMode) this.options.onModeChange?.(nextMode);
    this.emit();
    this.scheduleCaretRefresh(view);
  }

  private beginChangeUndoCapture(
    manager: UndoManager | null,
    undoStackDepth: number,
    beforeCursor: number,
  ): void {
    this.finishChangeUndoCapture();
    if (!manager) return;
    const capture: ChangeUndoCapture = {
      manager,
      captureTimeout: manager.captureTimeout,
      undoStackDepth,
      beforeCursor,
      beforeTransaction: () => {
        if (
          this.changeUndoCapture === capture &&
          manager.undoStack.length > capture.undoStackDepth
        ) {
          manager.lastChange = Date.now();
        }
      },
    };
    this.changeUndoCapture = capture;
    // Vim treats deletion plus every Insert mutation up to Esc as one change,
    // even when the user pauses longer than Yjs's normal capture timeout.
    manager.captureTimeout = Number.POSITIVE_INFINITY;
    // y-prosemirror may explicitly reset capture between native DOM changes.
    // Re-arm only after this change session has created its own undo item, so
    // changing an already-empty line cannot merge with older history.
    manager.doc.on("beforeTransaction", capture.beforeTransaction);
  }

  private finishChangeUndoCapture(afterCursor?: number): void {
    const capture = this.changeUndoCapture;
    if (!capture) return;
    this.changeUndoCapture = null;
    capture.manager.doc.off("beforeTransaction", capture.beforeTransaction);
    capture.manager.captureTimeout = capture.captureTimeout;
    if (
      afterCursor !== undefined &&
      capture.manager.undoStack.length > capture.undoStackDepth
    ) {
      capture.manager.undoStack.at(-1)?.meta.set(cursorHistoryKey, {
        beforeCursor: capture.beforeCursor,
        afterCursor,
      } satisfies CursorHistoryEntry);
    }
    capture.manager.stopCapturing();
  }

  private shouldCreateStandaloneUndoUnit(manager: UndoManager | null): boolean {
    return manager !== this.changeUndoCapture?.manager;
  }

  private refreshVisualLineDecorations(view: EditorView): void {
    view.dispatch(view.state.tr.setMeta("addToHistory", false));
  }

  private runHistory(view: EditorView, kind: "undo" | "redo"): void {
    const manager = findUndoManager(view);
    const stack = kind === "undo" ? manager?.undoStack : manager?.redoStack;
    const checkpoint = stack?.at(-1)?.meta.get(cursorHistoryKey) as
      CursorHistoryEntry | undefined;
    const changed =
      kind === "undo"
        ? (this.options.undo?.() ?? false)
        : (this.options.redo?.() ?? false);
    if (changed && checkpoint) {
      const destination =
        kind === "undo" ? manager?.redoStack : manager?.undoStack;
      destination?.at(-1)?.meta.set(cursorHistoryKey, checkpoint);
      if (this.mode === "normal") {
        applyModeSelection(
          view,
          "normal",
          kind === "undo" ? checkpoint.beforeCursor : checkpoint.afterCursor,
        );
      }
    }
    this.action = `${kind}:${changed ? "changed" : "empty"}`;
    view.focus();
    this.emit();
    this.scheduleCaretRefresh(view);
  }

  private setComposing(value: boolean): void {
    if (this.composing === value) return;
    this.composing = value;
    if (value) {
      this.clipboardReadGeneration += 1;
      this.input = createVimInputState();
    }
    this.emit();
  }

  private requestImeOff(): void {
    const requester = this.options.onRequestImeOff;
    const generation = ++this.imeRequestGeneration;
    if (!requester) {
      this.imeOff = "unsupported";
      this.imeOffDetail = "platform-adapter-unavailable";
      return;
    }

    this.imeOff = "requesting";
    this.imeOffDetail = "requesting";
    let pending: VimImeDeactivationResult | Promise<VimImeDeactivationResult>;
    try {
      pending = requester();
    } catch (error) {
      this.finishImeOff(generation, null, error);
      return;
    }
    void Promise.resolve(pending).then(
      (result) => this.finishImeOff(generation, result),
      (error) => this.finishImeOff(generation, null, error),
    );
  }

  private finishImeOff(
    generation: number,
    result: VimImeDeactivationResult | null,
    error?: unknown,
  ): void {
    if (generation !== this.imeRequestGeneration) return;
    if (!result) {
      this.imeOff = "failed";
      this.imeOffDetail = `error:${String(error)}`;
    } else if (result.inactive) {
      this.imeOff = "inactive";
      this.imeOffDetail = result.detail;
    } else if (!result.supported) {
      this.imeOff = "unsupported";
      this.imeOffDetail = result.detail;
    } else {
      this.imeOff = "failed";
      this.imeOffDetail = result.detail;
    }
    this.emit();
  }

  private writeClipboard(register: VimRegister): void {
    const writer = this.options.onYank;
    if (!writer) return;
    const generation = ++this.clipboardWriteGeneration;
    this.clipboard = "writing";
    this.emit();
    let pending: VimClipboardWriteResult | Promise<VimClipboardWriteResult>;
    try {
      pending = writer(register);
    } catch {
      this.setClipboardWriteResult(generation, "unavailable");
      return;
    }
    void Promise.resolve(pending).then(
      (result) => this.setClipboardWriteResult(generation, result),
      () => this.setClipboardWriteResult(generation, "unavailable"),
    );
  }

  private setClipboardWriteResult(
    generation: number,
    result: VimClipboardWriteResult,
  ): void {
    if (generation !== this.clipboardWriteGeneration) return;
    this.clipboard = result;
    this.emit();
  }

  private emit(): void {
    this.options.onSnapshot?.(this.snapshot());
  }

  private scheduleCaretRefresh(view: EditorView): void {
    this.view = view;
    // Keep the earliest pending frame. Replacing it on every transaction can
    // starve the body-level caret while key repeat or IME keeps producing
    // updates faster than the display refresh rate. The callback deliberately
    // reads this.view so it still paints the latest Editor state.
    if (this.refreshFrame !== null) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = null;
      const current = this.view;
      if (current) this.refreshCaret(current);
      else this.hideCaret();
    });
  }

  private scheduleFocusCaretRefresh(view: EditorView): void {
    this.scheduleCaretRefresh(view);
    this.schedulePostFocusCaretRefresh(view);
  }

  private schedulePostFocusCaretRefresh(view: EditorView): void {
    this.clearFocusCaretRefresh();
    // ProseMirror synchronizes the DOM selection shortly after focus. On
    // WebKitGTK the first animation frame can precede that synchronization,
    // so measure once more after its delayed selection update has settled.
    this.focusRefreshTimer = window.setTimeout(() => {
      this.focusRefreshTimer = null;
      if (
        view !== this.view ||
        view.isDestroyed ||
        !view.hasFocus() ||
        !this.focusSurfaceActive
      ) {
        return;
      }
      this.scheduleCaretRefresh(view);
    }, 32);
  }

  private clearFocusCaretRefresh(): void {
    if (this.focusRefreshTimer === null) return;
    window.clearTimeout(this.focusRefreshTimer);
    this.focusRefreshTimer = null;
  }

  private refreshCaret(view: EditorView): void {
    if (
      view !== this.view ||
      view.isDestroyed ||
      !view.hasFocus() ||
      !this.focusSurfaceActive
    ) {
      this.hideCaret();
      return;
    }
    applyNativeCaretMode(view.dom, this.mode);
    const geometry =
      this.mode === "insert"
        ? measureVimInsertCaretGeometry(view, view.state.selection.head)
        : measureVimBlockCaretGeometry(
            view,
            this.mode === "visual-line" && this.visualLine
              ? this.visualLine.cursor
              : visualCursor(view, this.mode),
          );
    if (!geometry) {
      this.hideCaret();
      return;
    }
    const caret = this.caret ?? this.createCaret();
    hideRenderedVimCarets(caret);
    const caretNodeName = view.state.doc.nodeAt(geometry.cursor)?.type.name;
    caret.className =
      this.mode === "insert"
        ? "memoka-vim-caret memoka-vim-caret--insert"
        : `memoka-vim-caret memoka-vim-caret--block memoka-vim-caret--${this.mode}${
            caretNodeName === "horizontalRule"
              ? " memoka-vim-caret--horizontal-rule"
              : ""
          }`;
    caret.dataset.mode = this.mode;
    caret.dataset.cursor = String(geometry.cursor);
    if (caretNodeName) {
      caret.dataset.nodeName = caretNodeName;
    } else {
      delete caret.dataset.nodeName;
    }
    Object.assign(caret.style, {
      display: "block",
      left: `${geometry.left}px`,
      top: `${geometry.top}px`,
      width: `${geometry.width}px`,
      height: `${geometry.height}px`,
    });
  }

  private createCaret(): HTMLSpanElement {
    const caret = document.createElement("span");
    caret.setAttribute("aria-hidden", "true");
    document.body.append(caret);
    this.caret = caret;
    return caret;
  }

  private hideCaret(): void {
    if (this.caret) this.caret.style.display = "none";
  }
}

function hideRenderedVimCarets(active: HTMLElement | null = null): void {
  for (const caret of document.querySelectorAll<HTMLElement>(
    ".memoka-vim-caret",
  )) {
    if (caret !== active) caret.style.display = "none";
  }
}

function shouldReadPreferredClipboard(
  data: Pick<DataTransfer, "types">,
): boolean {
  const types = Array.from(data.types);
  // WebKitGTK can expose an entirely empty DataTransfer for a large external
  // plain-text Clipboard even though GTK still offers the payload. With a
  // native reader installed, treat that as a filtered-format case rather
  // than concluding that the Clipboard is empty.
  if (types.length === 0) return true;
  return types.some(
    (type) =>
      type === MEMOKA_CLIPBOARD_MIME ||
      type === MARKDOWN_CLIPBOARD_MIME ||
      type === "text/html" ||
      type === TSV_CLIPBOARD_MIME ||
      type === "text/plain" ||
      type.startsWith("text/plain;") ||
      type === "Files" ||
      type === "text/uri-list" ||
      type === "x-special/gnome-copied-files",
  );
}

function attachmentIdAtPosition(
  doc: ProseMirrorNode,
  position: number,
): string | null {
  const bounded = Math.max(0, Math.min(position, doc.content.size));
  const $position = doc.resolve(bounded);
  const candidates = [$position.nodeAfter, $position.nodeBefore];
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    candidates.push($position.node(depth));
  }
  for (const node of candidates) {
    if (
      !node ||
      (node.type.name !== "attachment" && node.type.name !== "image")
    ) {
      continue;
    }
    const attachmentId = node.attrs.attachmentId;
    if (
      typeof attachmentId === "string" &&
      attachmentId !== "attachment:missing" &&
      attachmentId.length > 0
    ) {
      return attachmentId.startsWith("attachment:")
        ? attachmentId.slice("attachment:".length)
        : attachmentId;
    }
  }
  return null;
}

function readMarkdownClipboardSource(
  data: Pick<DataTransfer, "getData" | "types">,
): string {
  return Array.from(data.types).includes(MARKDOWN_CLIPBOARD_MIME)
    ? data.getData(MARKDOWN_CLIPBOARD_MIME)
    : "";
}

function readPasteFallback(
  data: Pick<DataTransfer, "getData" | "types">,
): PasteFallback {
  const types = Array.from(data.types);
  const plainType = types.find(
    (type) => type === "text/plain" || type.startsWith("text/plain;"),
  );
  return {
    html: types.includes("text/html") ? data.getData("text/html") : "",
    plain: plainType ? data.getData(plainType) : "",
  };
}

function modeForCommand(command: VimCommand): VimMode {
  switch (command) {
    case "mode.insert":
    case "mode.append":
      return "insert";
    case "mode.replace":
      return "replace";
    case "mode.visual-char":
      return "visual-char";
    case "mode.visual-line":
      return "visual-line";
    case "mode.visual-block":
      return "visual-block";
    default:
      return "normal";
  }
}

function isolatesUndoUnit(
  command: VimCommand,
  operator: VimOperator | null,
): boolean {
  return (
    operator === "delete" ||
    operator === "change" ||
    [
      "line.delete",
      "line.change",
      "line.delete-to-end",
      "line.change-to-end",
      "line.join",
      "line.join-raw",
      "character.delete",
      "replace.character",
      "line.open-below",
      "line.open-above",
      "selection.delete",
      "selection.change",
      "selection.paste",
      "put.after",
      "put.before",
    ].includes(command)
  );
}

function changesIntoInsert(
  command: VimCommand,
  operator: VimOperator | null,
): boolean {
  return (
    operator === "change" ||
    command === "line.change" ||
    command === "line.change-to-end" ||
    command === "selection.change" ||
    command === "line.open-below" ||
    command === "line.open-above"
  );
}

function eventSequence(event: KeyboardEvent): string {
  if (isTabKey(event)) return isReverseTab(event) ? "Shift+Tab" : "Tab";
  const eventKey = event.key.toLowerCase();
  const codeKey = event.code.match(/^Key([A-Z])$/u)?.[1]?.toLowerCase();
  const key = codeKey ?? eventKey;
  if (
    event.ctrlKey &&
    [
      "b",
      "d",
      "f",
      "h",
      "i",
      "j",
      "k",
      "l",
      "o",
      "r",
      "t",
      "u",
      "v",
      "w",
    ].includes(key)
  ) {
    return `Ctrl+${key}`;
  }
  return event.key;
}

function isTabKey(event: KeyboardEvent): boolean {
  // WebKitGTK may expose Shift-Tab using the XKB keysym name instead of the
  // DOM-standard `Tab`. Treat both spellings as the same editor key so the
  // browser never moves focus out of a boundary Table Cell.
  return (
    event.key === "Tab" || event.key === "ISO_Left_Tab" || event.code === "Tab"
  );
}

function isReverseTab(event: KeyboardEvent): boolean {
  return event.shiftKey || event.key === "ISO_Left_Tab";
}

function suppressUnmappedEditingKey(
  mode: VimMode,
  event: KeyboardEvent,
): boolean {
  if (mode === "insert" || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (mode === "replace" && event.key.length === 1) return false;
  return (
    event.key.length === 1 ||
    ["Backspace", "Delete", "Enter"].includes(event.key)
  );
}

function mutatesDocument(inputType: string | null): boolean {
  if (!inputType) return false;
  return (
    inputType.startsWith("insert") ||
    inputType.startsWith("delete") ||
    inputType === "historyUndo" ||
    inputType === "historyRedo"
  );
}

function signalsComposition(input: InputEvent): boolean {
  return input.isComposing || input.inputType?.includes("Composition") === true;
}

function selectionCursor(view: VimEditorView): number {
  return view.state.selection instanceof NodeSelection
    ? view.state.selection.from
    : view.state.selection.head;
}

function applyNativeCaretMode(root: HTMLElement, mode: VimMode): void {
  root.dataset.vimMode = mode;
  root.style.caretColor = "transparent";
}

function applyModeSelection(
  view: EditorView,
  mode: VimMode,
  cursorOverride?: number,
  focus = true,
): void {
  const { state } = view;
  const current = cursorOverride ?? state.selection.from;
  if (mode === "visual-char") {
    beginVisualChar(view, current, focus);
    return;
  }
  if (mode === "visual-block") {
    if (!beginVisualBlock(view))
      applyModeSelection(view, "normal", current, focus);
    return;
  }
  if (mode === "normal") {
    const bounded = Math.max(0, Math.min(current, state.doc.content.size));
    const cursor = clampVimBlockCursor(view, bounded);
    const cursorNode = state.doc.nodeAt(cursor);
    const selection =
      cursorNode?.isBlock &&
      (cursorNode.isAtom || cursorNode.isLeaf) &&
      NodeSelection.isSelectable(cursorNode)
        ? NodeSelection.create(state.doc, cursor)
        : TextSelection.create(state.doc, cursor);
    view.dispatch(state.tr.setSelection(selection));
    if (focus) view.focus();
    return;
  }

  let containingBlock: { from: number; to: number } | null = null;
  let lastTextBlock: { from: number; to: number } | null = null;
  state.doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    const block = {
      from: position + 1,
      to: position + 1 + node.content.size,
    };
    lastTextBlock = block;
    if (current >= block.from && current <= block.to) containingBlock = block;
  });
  const block = containingBlock ?? lastTextBlock ?? { from: 0, to: 0 };
  const cursor = Math.max(block.from, Math.min(current, block.to));
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, cursor)));
  if (focus) view.focus();
}

function findUndoManager(view: EditorView): UndoManager | null {
  for (const plugin of view.state.plugins) {
    const pluginState = plugin.getState(view.state) as
      { undoManager?: UndoManager } | undefined;
    if (pluginState?.undoManager) return pluginState.undoManager;
  }
  return null;
}

function visualCursor(view: EditorView, mode: VimMode): number {
  let cursor =
    mode === "visual-block"
      ? visualBlockCursor(view)
      : mode === "visual-char"
        ? visualCharCursor(view)
        : view.state.selection instanceof NodeSelection
          ? view.state.selection.from
          : view.state.selection.head;
  if (mode === "normal") cursor = clampVimBlockCursor(view, cursor);
  return cursor;
}
