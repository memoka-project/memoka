import { Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import * as Y from "yjs";
import {
  SECTION_DEPTH_SHIFT_ORIGIN,
  type ProductDocument,
} from "../core/documents";
import {
  BODY_CHUNK_NODE,
  findSectionWithDepth,
  SECTION_BODY_NODE,
  SECTION_CHILDREN_NODE,
} from "../core/section-model";
import {
  resolveEditorNavigationDestination,
  sectionIdAtEditorSelection,
  type EditorNavigationDestination,
  type EditorNavigationIntent,
  type EditorNavigationRequest,
  type EditorNavigationResult,
} from "../core/editor-navigation";
import { requestImeOff } from "../core/ime-platform";
import {
  saveStableEditorPosition,
  type StableEditorPosition,
} from "../core/stable-position";
import type { ManagedCrdtDocument } from "../core/transaction-gateway";
import type { WindowViewState } from "../core/window-state";
import {
  BrowserVimClipboard,
  encodeVimClipboard,
  MARKDOWN_CLIPBOARD_MIME,
  MEMOKA_CLIPBOARD_MIME,
  type ExplicitClipboardContent,
  type ExplicitClipboardFormat,
  type PreferredClipboardFormats,
} from "../vim/clipboard";
import {
  ProductVimSession,
  type VimImeDeactivationResult,
  type VimSessionSnapshot,
} from "../vim/session";
import {
  sectionHeaderPosition,
  type SectionDepthShiftSelection,
} from "../vim/editor-commands";
import type { VimRegisterStore } from "../vim/register-store";
import type { VimRepeatStore } from "../vim/repeat";
import type { VimWindowCommand } from "../vim/input";
import type { VimApplicationCommand } from "../vim/input";
import type { ApplicationKeyConfig } from "../core/application-key-config";
import type {
  WorkspaceSearchScope,
  WorkspaceSearchTarget,
} from "../core/workspace-search";
import {
  noteSearchLocationAtPosition,
  noteSearchStatusMessage,
  type NoteSearchDirection,
  type NoteSearchNavigationStatus,
  type NoteSearchOrigin,
} from "../core/note-search";
import {
  applyEditorSectionHeadingDepth,
  productEditorExtensions,
  refreshInternalSectionLinkNodeViews,
  type InternalLinkTitleResolver,
} from "./extensions";
import {
  InternalLinkCompletion,
  type InternalLinkCompletionSnapshot,
} from "./internal-link-completion";
import type { InternalLinkCandidate } from "../core/internal-link-candidates";
import type {
  BlockTransformTarget,
  TableDimensions,
} from "../core/block-types";
import type { InlineFormatAction } from "../core/inline-formats";
import type { TableActionId } from "../core/table-actions";
import type { AttachmentRepository } from "../core/attachments";
import { createDefaultExternalLinkPort } from "../platform/external-link";
import {
  runBlockTransformCommand,
  type BlockTransformResult,
} from "../vim/block-transform";
import {
  captureInlineFormatSelection,
  externalLinkAtPosition,
  runInlineFormatCommand,
  type InlineFormatResult,
  type InlineFormatSelection,
} from "../vim/inline-format";
import {
  insertAttachmentBlocks,
  type AttachmentInsertTarget,
} from "./attachment-insert";
import type { VimRegister } from "../vim/editor-commands";
import {
  runTableAction,
  restoreVisualBlockSelection,
  type TableActionResult,
  type TableActionSelection,
} from "../vim/table-editing";

export interface BlockTypePickerRequest {
  readonly blockId: string;
}

export interface InlineFormatPickerRequest {
  readonly selectedText: string;
  readonly existingHref: string | null;
  readonly apply: (action: InlineFormatAction) => InlineFormatResult;
}

export interface TableActionPickerRequest {
  readonly selection: TableActionSelection;
  readonly apply: (action: TableActionId) => TableActionResult;
}

export interface TiptapEditorAdapterOptions {
  /** Internal unit-test harness; production windows always render a Section. */
  directBodyOnly?: boolean;
  registerStore?: VimRegisterStore;
  repeatStore?: VimRepeatStore;
  onSelectionUpdate?: (editor: Editor, activeSectionId: string | null) => void;
  onCaretSectionChange?: (sectionId: string | null) => void;
  onCaretExternalLinkChange?: (href: string | null) => void;
  getWindowState?: () => WindowViewState;
  onModeChange?: (mode: WindowViewState["mode"]) => void;
  onScrollUpdate?: (scrollTop: number) => void;
  onVimSnapshot?: (snapshot: VimSessionSnapshot) => void;
  scrollElement?: HTMLElement;
  restoreScrollOnAttach?: boolean;
  requestImeOff?: () =>
    VimImeDeactivationResult | Promise<VimImeDeactivationResult>;
  readPreferredClipboard?: () =>
    | PreferredClipboardFormats
    | null
    | Promise<PreferredClipboardFormats | null>;
  readExplicitClipboard?: (
    format: ExplicitClipboardFormat,
  ) =>
    ExplicitClipboardContent | null | Promise<ExplicitClipboardContent | null>;
  onNavigate?: (
    request: EditorNavigationRequest,
  ) => EditorNavigationResult | Promise<EditorNavigationResult>;
  onNavigationDestination?: (
    destination: EditorNavigationDestination,
    detail: string,
  ) => boolean | Promise<boolean>;
  onWorkspaceSearch?: (
    origin: StableEditorPosition,
    scope: WorkspaceSearchScope,
    target: WorkspaceSearchTarget,
  ) => void;
  onNoteSearch?: (origin: NoteSearchOrigin) => void;
  onBlockTypePicker?: (request: BlockTypePickerRequest) => void;
  onInlineFormatPicker?: (request: InlineFormatPickerRequest) => void;
  onTableActionPicker?: (request: TableActionPickerRequest) => void;
  openExternalLink?: (href: string) => void | Promise<void>;
  attachmentRepository?: AttachmentRepository;
  onMessage?: (message: string) => void;
  onNoteSearchRepeat?: (
    origin: NoteSearchOrigin,
    direction: NoteSearchDirection,
    count: number,
  ) =>
    | (EditorNavigationResult & NoteSearchNavigationStatus)
    | Promise<EditorNavigationResult & NoteSearchNavigationStatus>;
  onCommandLine?: () => void;
  onApplicationCommand?: (command: VimApplicationCommand) => void;
  onWindowCommand?: (command: VimWindowCommand) => void;
  onSectionFocus?: (
    direction: "current" | "parent",
    currentSectionId: string,
    origin: StableEditorPosition,
  ) => void;
  onSectionDepthShift?: (
    request: SectionDepthShiftSelection & {
      direction: "deeper" | "shallower";
    },
  ) => Promise<{
    changed: boolean;
    affectedSectionIds: readonly string[];
  }>;
  keyConfig?: ApplicationKeyConfig;
  getInternalLinkCandidates?: () => readonly InternalLinkCandidate[];
  resolveInternalLinkTitle?: InternalLinkTitleResolver;
  onInternalLinkCompletion?: (
    snapshot: InternalLinkCompletionSnapshot | null,
  ) => void;
  internalLinkPopupId?: string;
}

interface ApplyNavigationOptions {
  focus?: boolean;
  reveal?: boolean;
  notifySelection?: boolean;
}

type SectionDepthShiftRequest = SectionDepthShiftSelection & {
  direction: "deeper" | "shallower";
  mode: WindowViewState["mode"];
};

interface PendingSectionDepthShift {
  readonly request: SectionDepthShiftRequest;
  readonly scrollTop: number;
}

export class TiptapEditorAdapter {
  private currentEditor: Editor;
  private readonly scrollElement: HTMLElement;
  private readonly unsubscribe: () => void;
  private readonly vimSession: ProductVimSession;
  private readonly clipboard = new BrowserVimClipboard();
  private readonly readExplicitClipboard: NonNullable<
    TiptapEditorAdapterOptions["readExplicitClipboard"]
  >;
  private readonly internalLinkCompletion: InternalLinkCompletion | null;
  private navigationRevealFrame: number | null = null;
  private sectionDepthScrollFrame: number | null = null;
  private sectionDepthScrollLock: PendingSectionDepthShift | null = null;
  private pendingSectionDepthShift: PendingSectionDepthShift | null = null;
  private selectionUpdateFrame: number | null = null;
  private selectionUpdateEditor: Editor | null = null;
  private selectionUpdateSuppressed = false;
  private projectedCaretSectionId: string | null | undefined;
  private projectedCaretExternalLink: string | null | undefined;
  private scrollTimer: number | null = null;
  private viewportCaretFrame: number | null = null;
  private suppressSelectionUpdate = false;
  private observedDocument: ProductDocument | null = null;
  private boundSection: Y.XmlElement | null = null;
  private structuralRebindQueued = false;

  constructor(
    private readonly handle: ManagedCrdtDocument<ProductDocument>,
    private readonly element: HTMLElement,
    private readonly options: TiptapEditorAdapterOptions = {},
  ) {
    this.scrollElement = options.scrollElement ?? element;
    this.internalLinkCompletion = options.getInternalLinkCandidates
      ? new InternalLinkCompletion({
          popupId: options.internalLinkPopupId ?? "memoka-internal-link-picker",
          getCandidates: options.getInternalLinkCandidates,
          onUpdate: options.onInternalLinkCompletion,
        })
      : null;
    const readPreferredClipboard =
      options.readPreferredClipboard ??
      (this.clipboard.supportsNativeBridge()
        ? () => this.clipboard.readPreferred()
        : undefined);
    this.readExplicitClipboard =
      options.readExplicitClipboard ??
      ((format) => this.clipboard.readExplicit(format));
    const externalLinkPort = createDefaultExternalLinkPort();
    this.vimSession = new ProductVimSession({
      initialMode: options.getWindowState?.().mode ?? "insert",
      getRootNoteId: () => {
        const current = this.handle.current;
        return current.kind === "note" ? current.noteId : null;
      },
      registerStore: options.registerStore,
      repeatStore: options.repeatStore,
      onModeChange: (mode) => {
        if (mode !== "insert") this.internalLinkCompletion?.close();
        options.onModeChange?.(mode);
      },
      onSnapshot: options.onVimSnapshot,
      onRequestImeOff: options.requestImeOff ?? requestImeOff,
      onYank: (register) => this.writeYankToClipboard(register),
      onPasteRead: readPreferredClipboard,
      onPasteFiles: async (files) => {
        await this.importAttachmentFiles(files);
      },
      onPasteNativePaths: async (paths, put) => {
        const importedPaths = put
          ? Array.from({ length: put.count }, () => paths).flat()
          : paths;
        await this.importAttachmentPaths(
          importedPaths,
          put
            ? {
                position: put.position,
                placement: put.direction,
              }
            : {},
        );
      },
      onNavigate: options.onNavigate
        ? (intent) => this.handleNavigationIntent(intent)
        : undefined,
      onWorkspaceSearch: options.onWorkspaceSearch
        ? (cursor, scope, target) =>
            this.handleWorkspaceSearch(cursor, scope, target)
        : undefined,
      onNoteSearch: options.onNoteSearch
        ? (cursor) => this.handleNoteSearch(cursor)
        : undefined,
      onNoteSearchRepeat: options.onNoteSearchRepeat
        ? (cursor, direction, count) =>
            this.handleNoteSearchRepeat(cursor, direction, count)
        : undefined,
      onInlineFormat: () => this.requestInlineFormatPicker(),
      onTableActions: (selection) => this.requestTableActionPicker(selection),
      onOpenExternalLink:
        options.openExternalLink ?? ((href) => externalLinkPort.open(href)),
      onOpenAttachment: options.attachmentRepository
        ? (attachmentId) => options.attachmentRepository!.open(attachmentId)
        : undefined,
      onMessage: options.onMessage,
      onCommandLine: options.onCommandLine,
      onApplicationCommand: options.onApplicationCommand,
      onWindowCommand: options.onWindowCommand,
      onSectionFocus: (direction, currentSectionId) => {
        const document = this.handle.current;
        if (document.kind !== "note" || this.currentEditor.isDestroyed) return;
        options.onSectionFocus?.(
          direction,
          currentSectionId,
          saveStableEditorPosition(document, this.currentEditor.view),
        );
      },
      onSectionDepthShift: async (request) => {
        const pending: PendingSectionDepthShift = {
          request,
          scrollTop: this.scrollElement.scrollTop,
        };
        this.pendingSectionDepthShift = pending;
        this.beginSectionDepthScrollLock(pending);
        try {
          const result = await options.onSectionDepthShift?.(request);
          if (!result || this.pendingSectionDepthShift !== pending) return;
          // Yjs bindings apply the structural update asynchronously. Resolve
          // the stable Section ID against the latest editor document before
          // drawing the final post-command caret.
          await Promise.resolve();
          this.applySectionDepthShiftPosition(pending, result.changed);
        } finally {
          if (this.pendingSectionDepthShift === pending) {
            this.pendingSectionDepthShift = null;
          }
          this.finishSectionDepthScrollLock(pending);
        }
      },
      keyConfig: options.keyConfig,
      undo: () => this.currentEditor.commands.undo(),
      redo: () => this.currentEditor.commands.redo(),
    });
    this.element.addEventListener(
      "keydown",
      this.handleInternalLinkKeyDown,
      true,
    );
    this.element.addEventListener(
      "compositionstart",
      this.handleInternalLinkCompositionStart,
      true,
    );
    this.element.addEventListener(
      "compositionend",
      this.handleInternalLinkCompositionEnd,
      true,
    );
    this.scrollElement.addEventListener("scroll", this.handleScroll);
    window.addEventListener("resize", this.handleInternalLinkLayoutChange);
    this.currentEditor = this.createEditor();
    this.scheduleSelectionUpdate(this.currentEditor, false);
    this.observeDocument(handle.current);
    this.unsubscribe = handle.subscribe((document) => {
      this.observeDocument(document);
      this.recreateEditor();
    });
  }

  get editor(): Editor {
    return this.currentEditor;
  }

  get vimSnapshot(): VimSessionSnapshot {
    return this.vimSession.snapshot();
  }

  get internalLinkCompletionSnapshot(): InternalLinkCompletionSnapshot | null {
    return this.internalLinkCompletion?.snapshot ?? null;
  }

  requestInputMethodDeactivation(): void {
    this.vimSession.requestInputMethodDeactivation();
  }

  transformBlock(
    blockId: string,
    target: BlockTransformTarget,
    consumeSlash = false,
    tableDimensions?: TableDimensions,
  ): BlockTransformResult {
    if (this.currentEditor.isDestroyed) {
      return { changed: false, reason: "missing" };
    }
    const document = this.handle.current;
    if (document.kind !== "note") {
      return { changed: false, reason: "missing" };
    }
    this.vimSession.prepareExternalMutationUndoBoundary();
    const result = runBlockTransformCommand(this.currentEditor.view, {
      name: "block.transform",
      payload: { blockId, target, consumeSlash, tableDimensions },
    });
    document.undoManager.stopCapturing();
    if (result.changed && result.selection === "node") {
      const position = this.currentEditor.state.selection.from;
      this.vimSession.applyNavigationPosition(
        position,
        `block.transform:${target}:changed`,
      );
      this.vimSession.requestInputMethodDeactivation();
    }
    return result;
  }

  private requestInlineFormatPicker(): boolean {
    if (
      this.currentEditor.isDestroyed ||
      this.vimSession.snapshot().mode !== "visual-char" ||
      !this.options.onInlineFormatPicker
    ) {
      return false;
    }
    const selection = captureInlineFormatSelection(this.currentEditor.view);
    if (!selection) return false;
    this.options.onInlineFormatPicker({
      selectedText: selection.text,
      existingHref: selection.existingHref,
      apply: (action) => this.applyInlineFormat(selection, action),
    });
    return true;
  }

  private applyInlineFormat(
    selection: InlineFormatSelection,
    action: InlineFormatAction,
  ): InlineFormatResult {
    if (this.currentEditor.isDestroyed) {
      return { changed: false, reason: "missing" };
    }
    this.vimSession.prepareExternalMutationUndoBoundary();
    const result = runInlineFormatCommand(
      this.currentEditor.view,
      selection,
      action,
    );
    if (result.changed) {
      this.vimSession.completeExternalSelectionMutation(
        result.from,
        selection.from,
        "selection:format:changed",
      );
    } else if (result.reason === "no-op") {
      this.vimSession.applyNavigationPosition(
        selection.from,
        "selection:format:no-op",
      );
      this.vimSession.requestInputMethodDeactivation();
    }
    return result;
  }

  private requestTableActionPicker(selection: TableActionSelection): boolean {
    if (this.currentEditor.isDestroyed || !this.options.onTableActionPicker) {
      return false;
    }
    this.options.onTableActionPicker({
      selection,
      apply: (action) => this.applyTableAction(selection, action),
    });
    return true;
  }

  private applyTableAction(
    selection: TableActionSelection,
    action: TableActionId,
  ): TableActionResult {
    if (this.currentEditor.isDestroyed) {
      return {
        changed: false,
        reason: "missing",
        position: selection.beforeCursor,
      };
    }
    this.vimSession.prepareExternalMutationUndoBoundary();
    const result = runTableAction(this.currentEditor.view, selection, action);
    if (result.changed) {
      this.vimSession.completeExternalSelectionMutation(
        result.position,
        selection.beforeCursor,
        `table.action:${action}:changed`,
        result.repeat,
      );
    } else if (result.reason === "boundary") {
      this.vimSession.applyNavigationPosition(
        selection.beforeCursor,
        `table.action:${action}:boundary`,
      );
      this.vimSession.requestInputMethodDeactivation();
    }
    return result;
  }

  async pasteExplicitClipboard(
    format: ExplicitClipboardFormat,
    isCurrentTarget: () => boolean = () => true,
  ): Promise<"changed" | "empty" | "stale" | "unavailable"> {
    const editor = this.currentEditor;
    if (editor.isDestroyed) return "unavailable";
    const document = editor.state.doc;
    const selection = editor.state.selection;
    let clipboard: ExplicitClipboardContent | null;
    try {
      clipboard = await this.readExplicitClipboard(format);
    } catch {
      return "unavailable";
    }
    if (
      editor !== this.currentEditor ||
      editor.isDestroyed ||
      !isCurrentTarget() ||
      !editor.state.doc.eq(document) ||
      !editor.state.selection.eq(selection)
    ) {
      return "stale";
    }
    if (!clipboard || clipboard.content.length === 0) return "empty";
    return this.vimSession.pasteExplicit(editor.view, format, clipboard.content)
      ? "changed"
      : "empty";
  }

  chooseAttachmentFiles(target: AttachmentInsertTarget = {}): void {
    if (!this.options.attachmentRepository || this.currentEditor.isDestroyed) {
      this.options.onMessage?.("添付ファイル機能を利用できません");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    let settled = false;
    const dispose = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      input.remove();
    };
    const cancel = (): void => {
      dispose();
      this.currentEditor.commands.focus();
    };
    const handleWindowFocus = (): void => {
      window.setTimeout(() => {
        if (!settled && (input.files?.length ?? 0) === 0) cancel();
      }, 0);
    };
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        dispose();
        if (files.length === 0) {
          this.currentEditor.commands.focus();
          return;
        }
        void this.importAttachmentFiles(files, target);
      },
      { once: true },
    );
    input.addEventListener("cancel", cancel, { once: true });
    window.addEventListener("focus", handleWindowFocus);
    document.body.append(input);
    input.click();
  }

  async importAttachmentFiles(
    files: readonly File[],
    target: AttachmentInsertTarget = {},
  ): Promise<"changed" | "stale" | "failed"> {
    const repository = this.options.attachmentRepository;
    const editor = this.currentEditor;
    if (!repository || editor.isDestroyed) return "failed";
    const document = editor.state.doc;
    const selection = editor.state.selection;
    try {
      const attachments = await repository.importFiles(files);
      if (
        editor !== this.currentEditor ||
        editor.isDestroyed ||
        (!target.blockId &&
          (!editor.state.doc.eq(document) ||
            !editor.state.selection.eq(selection)))
      ) {
        this.options.onMessage?.(
          "添付の読み込み中に編集位置が変わったため、本文には挿入しませんでした",
        );
        return "stale";
      }
      return this.insertImportedAttachments(attachments, target);
    } catch (error) {
      this.options.onMessage?.(
        `添付ファイルを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.currentEditor.commands.focus();
      return "failed";
    }
  }

  async importAttachmentPaths(
    paths: readonly string[],
    target: AttachmentInsertTarget = {},
  ): Promise<"changed" | "stale" | "failed"> {
    const repository = this.options.attachmentRepository;
    const editor = this.currentEditor;
    if (!repository || editor.isDestroyed) return "failed";
    const document = editor.state.doc;
    const selection = editor.state.selection;
    try {
      const attachments = await repository.importNativePaths(paths);
      if (
        editor !== this.currentEditor ||
        editor.isDestroyed ||
        (!target.blockId &&
          (!editor.state.doc.eq(document) ||
            !editor.state.selection.eq(selection)))
      ) {
        this.options.onMessage?.(
          "添付の読み込み中に編集位置が変わったため、本文には挿入しませんでした",
        );
        return "stale";
      }
      return this.insertImportedAttachments(attachments, target);
    } catch (error) {
      this.options.onMessage?.(
        `添付ファイルを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.currentEditor.commands.focus();
      return "failed";
    }
  }

  importAttachmentPathsAtCoordinates(
    paths: readonly string[],
    left: number,
    top: number,
  ): Promise<"changed" | "stale" | "failed"> {
    if (this.currentEditor.isDestroyed) return Promise.resolve("failed");
    const position = this.currentEditor.view.posAtCoords({ left, top });
    return this.importAttachmentPaths(paths, {
      position: position?.pos ?? this.currentEditor.state.selection.head,
    });
  }

  setFocusSurfaceActive(active: boolean): void {
    this.vimSession.setFocusSurfaceActive(active);
  }

  captureStablePosition(): StableEditorPosition | null {
    const document = this.handle.current;
    if (document.kind !== "note" || this.currentEditor.isDestroyed) return null;
    return saveStableEditorPosition(document, this.currentEditor.view);
  }

  acceptInternalLinkCandidate(noteId: string): boolean {
    const completion = this.internalLinkCompletion;
    if (!completion || this.currentEditor.isDestroyed) return false;
    return completion.accept(this.currentEditor.view, noteId);
  }

  refreshInternalLinkCompletion(): void {
    if (!this.internalLinkCompletion || this.currentEditor.isDestroyed) return;
    const snapshot = this.vimSession.snapshot();
    this.internalLinkCompletion.refresh(
      this.currentEditor.view,
      snapshot.mode === "insert",
      snapshot.composing,
    );
  }

  refreshInternalLinkLabels(): void {
    if (this.currentEditor.isDestroyed) return;
    refreshInternalSectionLinkNodeViews(
      this.currentEditor.view,
      this.options.resolveInternalLinkTitle,
    );
  }

  applyNavigationDestination(
    destination: EditorNavigationDestination,
    detail: string,
    options: ApplyNavigationOptions = {},
  ): string | null {
    const document = this.handle.current;
    if (
      document.kind !== "note" ||
      document.noteId !== destination.noteId ||
      this.currentEditor.isDestroyed
    ) {
      return null;
    }
    const resolved = resolveEditorNavigationDestination(
      document,
      this.currentEditor.view,
      destination,
    );
    const resolvedDetail =
      resolved.source === "missing-search-fallback"
        ? `${detail}:missing-search-fallback`
        : detail;
    const previousSuppression = this.suppressSelectionUpdate;
    if (options.notifySelection === false) {
      this.suppressSelectionUpdate = true;
    }
    let applied: boolean;
    try {
      applied = this.vimSession.applyNavigationPosition(
        resolved.position,
        resolvedDetail,
        options.focus,
      );
    } finally {
      this.suppressSelectionUpdate = previousSuppression;
    }
    if (!applied) return null;
    if (options.reveal !== false) this.revealNavigationSelection();
    return resolvedDetail;
  }

  focusDocumentEdge(edge: "start" | "end", detail: string): boolean {
    if (this.currentEditor.isDestroyed) return false;
    const position =
      edge === "start" ? 0 : this.currentEditor.state.doc.content.size;
    const applied = this.vimSession.applyNavigationPosition(position, detail);
    if (!applied) return false;
    this.currentEditor.view.focus();
    this.revealNavigationSelection();
    return true;
  }

  destroy(): void {
    this.unsubscribe();
    this.observeDocument(null);
    this.internalLinkCompletion?.destroy();
    this.currentEditor.destroy();
    this.vimSession.destroy();
    this.element.removeEventListener(
      "keydown",
      this.handleInternalLinkKeyDown,
      true,
    );
    this.element.removeEventListener(
      "compositionstart",
      this.handleInternalLinkCompositionStart,
      true,
    );
    this.element.removeEventListener(
      "compositionend",
      this.handleInternalLinkCompositionEnd,
      true,
    );
    this.scrollElement.removeEventListener("scroll", this.handleScroll);
    window.removeEventListener("resize", this.handleInternalLinkLayoutChange);
    if (this.navigationRevealFrame !== null) {
      window.cancelAnimationFrame(this.navigationRevealFrame);
    }
    if (this.viewportCaretFrame !== null) {
      window.cancelAnimationFrame(this.viewportCaretFrame);
    }
    if (this.sectionDepthScrollFrame !== null) {
      window.cancelAnimationFrame(this.sectionDepthScrollFrame);
    }
    this.sectionDepthScrollLock = null;
    this.pendingSectionDepthShift = null;
    this.cancelSelectionUpdate();
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.element.replaceChildren();
  }

  private createEditor(): Editor {
    const document = this.handle.current;
    if (document.kind !== "note") {
      throw new Error("TipTap adapter can only bind a NoteDoc");
    }
    const focusedSectionId =
      this.options.getWindowState?.().focusedSectionId ?? document.noteId;
    this.boundSection =
      findSectionWithDepth(document.rootSection, focusedSectionId)?.element ??
      null;
    const editor = new Editor({
      element: this.element,
      extensions: [
        ...productEditorExtensions(document, {
          resolveInternalLinkTitle: this.options.resolveInternalLinkTitle,
          focusedSectionId: focusedSectionId,
          directBodyOnly: this.options.directBodyOnly,
          attachmentRepository: this.options.attachmentRepository,
        }),
        blockTypeSlashTrigger({
          enabled: () => {
            const snapshot = this.vimSession.snapshot();
            return (
              snapshot.mode === "insert" &&
              !snapshot.composing &&
              Boolean(this.options.onBlockTypePicker)
            );
          },
          onTrigger: (blockId) => {
            if (this.currentEditor.isDestroyed) return;
            this.options.onBlockTypePicker?.({ blockId });
          },
        }),
        this.vimSession.createExtension(),
      ],
      editorProps: {
        attributes: {
          class: "memoka-editor",
          spellcheck: "true",
          "data-note-id": document.noteId,
          "data-section-id": focusedSectionId,
        },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0 || !this.options.attachmentRepository) {
            return false;
          }
          event.preventDefault();
          const coordinates = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          void this.importAttachmentFiles(files, {
            position: coordinates?.pos ?? view.state.selection.head,
          });
          return true;
        },
      },
      onSelectionUpdate: ({ editor }) => {
        this.publishCaretExternalLink(editor);
        this.scheduleSelectionUpdate(editor, this.suppressSelectionUpdate);
      },
      onTransaction: ({ editor }) => {
        this.publishCaretExternalLink(editor);
        const snapshot = this.vimSession.snapshot();
        this.internalLinkCompletion?.refresh(
          editor.view,
          snapshot.mode === "insert",
          snapshot.composing,
        );
      },
      onFocus: ({ editor }) => {
        this.publishCaretExternalLink(editor);
        const snapshot = this.vimSession.snapshot();
        this.internalLinkCompletion?.refresh(
          editor.view,
          snapshot.mode === "insert",
          snapshot.composing,
        );
        this.scheduleSelectionUpdate(editor, false);
      },
      onBlur: () => this.internalLinkCompletion?.close(),
    });
    this.restoreWindowState(editor);
    this.vimSession.activate();
    return editor;
  }

  private insertImportedAttachments(
    attachments: readonly import("../core/attachments").AttachmentMetadata[],
    target: AttachmentInsertTarget,
  ): "changed" | "stale" | "failed" {
    const editor = this.currentEditor;
    this.vimSession.prepareExternalMutationUndoBoundary();
    const result = insertAttachmentBlocks(editor.view, attachments, target);
    if (!result.changed) {
      this.options.onMessage?.(
        result.reason === "stale"
          ? "添付先の「/」ブロックが変更されました"
          : "この位置へ添付ファイルを挿入できません",
      );
      editor.commands.focus();
      return result.reason === "stale" ? "stale" : "failed";
    }
    this.vimSession.completeExternalSelectionMutation(
      result.lastPosition,
      result.beforeCursor,
      `attachment:insert:${attachments.length}`,
    );
    this.options.onMessage?.(
      attachments.length === 1
        ? `${attachments[0]!.originalFilename} を添付しました`
        : `${attachments.length}件のファイルを添付しました`,
    );
    return "changed";
  }

  private writeYankToClipboard(register: VimRegister) {
    const attachmentIds = attachmentIdsFromRegister(register);
    if (attachmentIds.length > 0 && this.options.attachmentRepository) {
      const formats = encodeVimClipboard(
        register,
        this.currentEditor.schema,
        this.options.resolveInternalLinkTitle,
      );
      return this.options.attachmentRepository
        .copyFiles(attachmentIds, {
          internal: formats[MEMOKA_CLIPBOARD_MIME],
          html: formats["text/html"],
          markdown: formats[MARKDOWN_CLIPBOARD_MIME],
          plain: formats["text/plain"],
        })
        .then(() => "rich" as const)
        .catch(() =>
          this.clipboard.write(
            register,
            this.currentEditor.schema,
            this.options.resolveInternalLinkTitle,
          ),
        );
    }
    return this.clipboard.write(
      register,
      this.currentEditor.schema,
      this.options.resolveInternalLinkTitle,
    );
  }

  private observeDocument(document: ProductDocument | null): void {
    if (this.observedDocument) {
      this.observedDocument.doc.off(
        "afterTransaction",
        this.handleDocumentTransaction,
      );
    }
    this.observedDocument = document;
    document?.doc.on("afterTransaction", this.handleDocumentTransaction);
  }

  private readonly handleDocumentTransaction = (
    transaction: Y.Transaction,
  ): void => {
    this.holdSectionDepthScrollPosition();
    const pendingDepthShift =
      transaction.origin === SECTION_DEPTH_SHIFT_ORIGIN
        ? this.pendingSectionDepthShift
        : null;
    if (
      this.structuralRebindQueued ||
      ![...transaction.changed.keys()].some(
        (type) =>
          type instanceof Y.XmlElement &&
          type.nodeName === SECTION_CHILDREN_NODE,
      )
    ) {
      if (this.structuralRebindQueued && pendingDepthShift) {
        queueMicrotask(() => {
          this.applyPendingSectionDepthShift(pendingDepthShift);
        });
      }
      return;
    }
    this.structuralRebindQueued = true;
    queueMicrotask(() => {
      this.structuralRebindQueued = false;
      const document = this.handle.current;
      if (
        document.kind !== "note" ||
        document !== this.observedDocument ||
        this.currentEditor.isDestroyed
      ) {
        return;
      }
      const focusedSectionId =
        this.options.getWindowState?.().focusedSectionId ?? document.noteId;
      const current = findSectionWithDepth(
        document.rootSection,
        focusedSectionId,
      );
      if (current && current.element !== this.boundSection) {
        this.recreateEditor();
      } else if (current) {
        applyEditorSectionHeadingDepth(
          this.currentEditor.view.dom,
          current.depth,
        );
      }
      if (pendingDepthShift) {
        this.applyPendingSectionDepthShift(pendingDepthShift);
      }
    });
  };

  private recreateEditor(): void {
    const hadFocus = this.currentEditor.isFocused;
    this.cancelSelectionUpdate();
    this.internalLinkCompletion?.close();
    this.currentEditor.destroy();
    this.element.replaceChildren();
    this.currentEditor = this.createEditor();
    this.scheduleSelectionUpdate(this.currentEditor, false);
    if (hadFocus) this.currentEditor.commands.focus();
  }

  private restoreWindowState(editor: Editor): void {
    const state = this.options.getWindowState?.();
    if (!state) return;
    if (state.selection) {
      const maximum = editor.state.doc.content.size;
      const anchor = Math.max(0, Math.min(state.selection.anchor, maximum));
      const head = Math.max(0, Math.min(state.selection.head, maximum));
      if (
        state.mode !== "visual-block" ||
        !restoreVisualBlockSelection(editor.view, anchor, head)
      ) {
        editor.commands.setTextSelection({ from: anchor, to: head });
      }
    }
    if (this.options.restoreScrollOnAttach !== false) {
      requestAnimationFrame(() => {
        this.scrollElement.scrollTop =
          this.sectionDepthScrollLock?.scrollTop ?? state.scrollTop;
      });
    }
  }

  private cancelSelectionUpdate(): void {
    if (this.selectionUpdateFrame !== null) {
      window.cancelAnimationFrame(this.selectionUpdateFrame);
      this.selectionUpdateFrame = null;
    }
    this.selectionUpdateEditor = null;
    this.selectionUpdateSuppressed = false;
  }

  private scheduleSelectionUpdate(editor: Editor, suppressed: boolean): void {
    this.selectionUpdateEditor = editor;
    this.selectionUpdateSuppressed = suppressed;
    if (this.selectionUpdateFrame !== null) return;
    // Selection persistence is Window-local projection work. Let ProseMirror
    // and the custom caret reach the next paint first, then persist only the
    // latest selection produced in that frame through the Core Command API.
    this.selectionUpdateFrame = window.requestAnimationFrame(() => {
      this.selectionUpdateFrame = null;
      const latest = this.selectionUpdateEditor;
      const latestSuppressed = this.selectionUpdateSuppressed;
      this.selectionUpdateEditor = null;
      this.selectionUpdateSuppressed = false;
      if (
        !latest ||
        latest !== this.currentEditor ||
        latest.isDestroyed ||
        latestSuppressed
      ) {
        return;
      }
      const activeSectionId = sectionIdAtEditorSelection(latest.state);
      if (this.projectedCaretSectionId !== activeSectionId) {
        this.projectedCaretSectionId = activeSectionId;
        this.options.onCaretSectionChange?.(activeSectionId);
      }
      this.options.onSelectionUpdate?.(latest, activeSectionId);
    });
  }

  private publishCaretExternalLink(editor: Editor): void {
    if (editor !== this.currentEditor || editor.isDestroyed) return;
    const href = externalLinkAtPosition(
      editor.state.doc,
      editor.state.selection.head,
    );
    if (href === this.projectedCaretExternalLink) return;
    this.projectedCaretExternalLink = href;
    this.options.onCaretExternalLinkChange?.(href);
  }

  private revealNavigationSelection(): void {
    const editor = this.currentEditor;
    const reveal = (): void => {
      if (editor !== this.currentEditor || editor.isDestroyed) return;
      editor.view.dispatch(
        editor.view.state.tr.setMeta("addToHistory", false).scrollIntoView(),
      );
    };
    reveal();
    if (this.navigationRevealFrame !== null) {
      window.cancelAnimationFrame(this.navigationRevealFrame);
    }
    // A freshly mounted Editor restores its Window-local scrollTop on the
    // next frame. Re-run the reveal after that restoration so a cross-note
    // Jump List destination cannot be hidden by the stale viewport.
    this.navigationRevealFrame = window.requestAnimationFrame(() => {
      this.navigationRevealFrame = null;
      reveal();
    });
  }

  private applyPendingSectionDepthShift(
    pending: PendingSectionDepthShift,
  ): void {
    if (this.pendingSectionDepthShift !== pending) return;
    this.applySectionDepthShiftPosition(pending, true);
    this.holdSectionDepthScrollPosition();
  }

  private applySectionDepthShiftPosition(
    pending: PendingSectionDepthShift,
    changed: boolean,
  ): void {
    if (this.currentEditor.isDestroyed) return;
    const { request } = pending;
    const position = sectionHeaderPosition(
      this.currentEditor.view,
      request.caretSectionId,
      request.caretOffset,
    );
    if (position === null) return;
    this.vimSession.applySectionDepthShiftPosition(
      position,
      request.mode,
      `section:${request.direction}:${changed ? "changed" : "boundary"}`,
      changed && (request.mode === "normal" || request.mode === "visual-line")
        ? request.caretPosition
        : undefined,
    );
  }

  private beginSectionDepthScrollLock(pending: PendingSectionDepthShift): void {
    if (this.sectionDepthScrollFrame !== null) {
      window.cancelAnimationFrame(this.sectionDepthScrollFrame);
      this.sectionDepthScrollFrame = null;
    }
    this.sectionDepthScrollLock = pending;
    this.holdSectionDepthScrollPosition();
  }

  private holdSectionDepthScrollPosition(): void {
    const pending = this.sectionDepthScrollLock;
    if (!pending) return;
    // The browser clamps this assignment if the relayout made the scrollable
    // range shorter; keeping the requested value preserves the exact Window
    // position whenever it is still valid.
    this.scrollElement.scrollTop = pending.scrollTop;
  }

  private finishSectionDepthScrollLock(
    pending: PendingSectionDepthShift,
  ): void {
    if (this.sectionDepthScrollLock !== pending) return;
    this.holdSectionDepthScrollPosition();
    if (this.sectionDepthScrollFrame !== null) {
      window.cancelAnimationFrame(this.sectionDepthScrollFrame);
    }
    // WebKitGTK may perform focused-selection scrolling and scroll anchoring
    // after the Yjs DOM reconciliation. Keep the lock through the first paint,
    // then release it on the following frame without asking ProseMirror to
    // scroll the selection into view.
    this.sectionDepthScrollFrame = window.requestAnimationFrame(() => {
      if (this.sectionDepthScrollLock !== pending) return;
      this.holdSectionDepthScrollPosition();
      this.sectionDepthScrollFrame = window.requestAnimationFrame(() => {
        this.sectionDepthScrollFrame = null;
        if (this.sectionDepthScrollLock !== pending) return;
        this.holdSectionDepthScrollPosition();
        this.sectionDepthScrollLock = null;
      });
    });
  }

  private async handleNavigationIntent(
    intent: EditorNavigationIntent,
  ): Promise<EditorNavigationResult> {
    const editor = this.currentEditor;
    const document = this.handle.current;
    if (document.kind !== "note" || editor.isDestroyed) {
      return { handled: false, detail: `jump:${intent.kind}:stale` };
    }
    const current = saveStableEditorPosition(
      document,
      editor.view,
      intent.cursor,
    );
    const request: EditorNavigationRequest =
      intent.kind === "follow-link"
        ? { kind: intent.kind, current, target: intent.target }
        : { kind: intent.kind, current };
    const result = await this.options.onNavigate?.(request);
    if (!result) {
      return { handled: false, detail: `jump:${intent.kind}:unavailable` };
    }
    if (
      result.destination &&
      this.currentEditor === editor &&
      !editor.isDestroyed
    ) {
      if (
        await this.options.onNavigationDestination?.(
          result.destination,
          result.detail,
        )
      ) {
        return result;
      }
      const appliedDetail = this.applyNavigationDestination(
        result.destination,
        result.detail,
      );
      return appliedDetail ? { ...result, detail: appliedDetail } : result;
    }
    return result;
  }

  private handleWorkspaceSearch(
    cursor: number,
    scope: WorkspaceSearchScope,
    target: WorkspaceSearchTarget,
  ): void {
    const document = this.handle.current;
    if (
      !this.options.onWorkspaceSearch ||
      document.kind !== "note" ||
      this.currentEditor.isDestroyed
    ) {
      return;
    }
    this.options.onWorkspaceSearch(
      saveStableEditorPosition(document, this.currentEditor.view, cursor),
      scope,
      target,
    );
  }

  private noteSearchOrigin(cursor: number): NoteSearchOrigin | null {
    const document = this.handle.current;
    if (document.kind !== "note" || this.currentEditor.isDestroyed) {
      return null;
    }
    return {
      stable: saveStableEditorPosition(
        document,
        this.currentEditor.view,
        cursor,
      ),
      location: noteSearchLocationAtPosition(this.currentEditor.state, cursor),
    };
  }

  private handleNoteSearch(cursor: number): void {
    const origin = this.noteSearchOrigin(cursor);
    if (origin) this.options.onNoteSearch?.(origin);
  }

  private async handleNoteSearchRepeat(
    cursor: number,
    direction: NoteSearchDirection,
    count: number,
  ): Promise<EditorNavigationResult> {
    const editor = this.currentEditor;
    const origin = this.noteSearchOrigin(cursor);
    if (!origin || !this.options.onNoteSearchRepeat) {
      return { handled: false, detail: "search:note:unavailable" };
    }
    const result = await this.options.onNoteSearchRepeat(
      origin,
      direction,
      count,
    );
    if (
      result.destination &&
      editor === this.currentEditor &&
      !editor.isDestroyed
    ) {
      const applied = this.applyNavigationDestination(
        result.destination,
        result.detail,
      );
      if (applied) {
        const message = noteSearchStatusMessage(result);
        if (message) this.options.onMessage?.(message);
        return { ...result, detail: applied };
      }
    }
    return result;
  }

  private readonly handleScroll = (): void => {
    if (this.sectionDepthScrollLock) {
      this.holdSectionDepthScrollPosition();
      this.internalLinkCompletion?.refreshLayout();
      return;
    }
    this.internalLinkCompletion?.refreshLayout();
    this.scheduleViewportCaretClamp();
    if (!this.options.onScrollUpdate) return;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      this.options.onScrollUpdate?.(this.scrollElement.scrollTop);
    }, 100);
  };

  private scheduleViewportCaretClamp(): void {
    if (this.viewportCaretFrame !== null) return;
    this.viewportCaretFrame = window.requestAnimationFrame(() => {
      this.viewportCaretFrame = null;
      this.keepCaretInsideViewport();
    });
  }

  private keepCaretInsideViewport(): void {
    const editor = this.currentEditor;
    if (editor.isDestroyed || this.sectionDepthScrollLock) return;
    const viewport = this.scrollElement.getBoundingClientRect();
    if (viewport.height <= 0) return;
    const cursor = this.vimSession.currentCursorPosition();
    if (cursor === null) return;
    let caret: ReturnType<typeof editor.view.coordsAtPos>;
    try {
      caret = editor.view.coordsAtPos(cursor, 1);
    } catch {
      return;
    }
    const above = caret.top < viewport.top;
    const below = caret.bottom > viewport.bottom;
    if (!above && !below) return;

    const caretHeight = Math.max(1, caret.bottom - caret.top);
    const inset = Math.min(
      Math.max(1, caretHeight / 2),
      Math.max(1, viewport.height / 2),
    );
    const targetTop = above ? viewport.top + inset : viewport.bottom - inset;
    const editorRect = editor.view.dom.getBoundingClientRect();
    const minimumLeft = Math.max(viewport.left + 1, editorRect.left + 1);
    const maximumLeft = Math.min(viewport.right - 1, editorRect.right - 1);
    const sourceLeft = (caret.left + caret.right) / 2;
    const targetLeft =
      maximumLeft >= minimumLeft
        ? Math.max(minimumLeft, Math.min(maximumLeft, sourceLeft))
        : sourceLeft;
    const probes = [targetLeft, minimumLeft];
    for (const left of probes) {
      try {
        const target = editor.view.posAtCoords({ left, top: targetTop });
        if (target && this.vimSession.applyViewportCaretPosition(target.pos)) {
          return;
        }
      } catch {
        // A transient WebKit layout gap can make one probe unavailable. The
        // next scroll event retries after layout has settled.
      }
    }
  }

  private readonly handleInternalLinkKeyDown = (event: KeyboardEvent): void => {
    if (!this.internalLinkCompletion || this.currentEditor.isDestroyed) return;
    const snapshot = this.vimSession.snapshot();
    const handled = this.internalLinkCompletion.handleKeyDown(
      this.currentEditor.view,
      event,
      snapshot.mode === "insert",
      snapshot.composing,
    );
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handleInternalLinkCompositionStart = (): void => {
    this.internalLinkCompletion?.close();
  };

  private readonly handleInternalLinkCompositionEnd = (): void => {
    queueMicrotask(() => this.refreshInternalLinkCompletion());
  };

  private readonly handleInternalLinkLayoutChange = (): void => {
    this.internalLinkCompletion?.refreshLayout();
  };
}

function blockTypeSlashTrigger(options: {
  enabled: () => boolean;
  onTrigger: (blockId: string) => void;
}): Extension {
  return Extension.create({
    name: "memokaBlockTypeSlashTrigger",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handleTextInput: (view, from, to, text) => {
              if (text !== "/" || from !== to || !options.enabled()) {
                return false;
              }
              const $from = view.state.doc.resolve(from);
              if (
                !$from.parent.isTextblock ||
                $from.parent.type.name !== "paragraph" ||
                $from.parent.content.size !== 0 ||
                $from.parentOffset !== 0 ||
                $from.depth < 1 ||
                ![SECTION_BODY_NODE, BODY_CHUNK_NODE].includes(
                  $from.node($from.depth - 1).type.name,
                )
              ) {
                return false;
              }
              const blockId = $from.parent.attrs.blockId;
              if (typeof blockId !== "string" || !blockId) return false;
              queueMicrotask(() => {
                if (view.isDestroyed || !options.enabled()) return;
                let valid = false;
                view.state.doc.descendants((node, _position, parent) => {
                  if (
                    node.attrs.blockId === blockId &&
                    (parent?.type.name === SECTION_BODY_NODE ||
                      parent?.type.name === BODY_CHUNK_NODE)
                  ) {
                    valid =
                      node.type.name === "paragraph" &&
                      node.textContent === "/";
                    return false;
                  }
                  return !valid;
                });
                if (valid) options.onTrigger(blockId);
              });
              return false;
            },
          },
        }),
      ];
    },
  });
}

function attachmentIdsFromRegister(register: VimRegister): string[] {
  const slice = "slice" in register ? register.slice : undefined;
  if (!slice) return [];
  const attachmentIds = new Set<string>();
  slice.content.descendants((node) => {
    if (node.type.name !== "attachment" && node.type.name !== "image") {
      return true;
    }
    const value = node.attrs.attachmentId;
    if (typeof value !== "string" || value === "attachment:missing") {
      return false;
    }
    const attachmentId = value.startsWith("attachment:")
      ? value.slice("attachment:".length)
      : value;
    if (attachmentId) attachmentIds.add(attachmentId);
    return false;
  });
  return [...attachmentIds];
}
