import type { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import * as Y from "yjs";
import {
  CoreCommandRegistry,
  type CoreCommandEnvelope,
  type CoreCommandName,
  type CoreCommandResults,
} from "./commands";
import {
  BOOTSTRAP_ORIGIN,
  CORE_TRANSACTION_ORIGIN,
  NOTE_TIMESTAMP_ORIGIN,
  PERSISTENCE_LOAD_ORIGIN,
  SECTION_DEPTH_SHIFT_ORIGIN,
  SECTION_PARAGRAPH_CONVERSION_ORIGIN,
  addNoteMetadata,
  applyNoteSectionDepthShift,
  createNoteDocument,
  createNoteSectionFromParagraph,
  createWorkspaceDocument,
  listNoteMetadata,
  loadNoteDocumentWithSectionIdentityRecovery,
  loadProductDocument,
  moveNotesToTrash,
  noteSectionCatalog,
  noteDisplayTitle,
  planNoteSectionDepthShift,
  readNoteMetadata,
  readNoteTitle,
  readNotePlainText,
  renameRootSection,
  renameNoteMetadata,
  replaceNoteSectionTree,
  replaceFirstTextBlock,
  restoreNotesFromTrash,
  synchronizeManagedNoteMetadata,
  setSectionProperties,
  updateNotePlacements,
  type NoteMetadata,
  type NoteDocument,
  type ProductDocument,
  type SectionIdentityRepair,
  type WorkspaceDocument,
} from "./documents";
import {
  SECTION_CHILDREN_NODE,
  SECTION_HEADER_NODE,
  findChildSectionToward,
  findParentSection,
  findSectionById,
  sectionId,
  sectionTitle,
} from "./section-model";
import { createUuidV7 } from "./ids";
import {
  type CommitFault,
  type LocalStateCommit,
  type PersistedDocument,
  type PersistencePort,
} from "./persistence";
import {
  CoreTransactionGateway,
  ManagedCrdtDocument,
} from "./transaction-gateway";
import {
  validateWindowViewState,
  type WindowLocalViewState,
  type WindowViewState,
} from "./window-state";
import {
  activeEditorWindow,
  activeTab,
  adjacentTabPageId,
  closeBuffer,
  closeTabPage,
  closeWindow,
  createApplicationWindowState,
  createNoteBuffer,
  createTabPage,
  focusWindow,
  focusWindowInDirection,
  keepOnlyWindow,
  listTabWindowIds,
  migrateLegacyWindowStates,
  migrateApplicationWindowState,
  openBufferInWindow,
  removeNotesFromSidebarViews,
  splitWindow,
  switchTabPage,
  updateSidebar as updateApplicationSidebar,
  updateWindowView,
  validateApplicationWindowState,
  windowInDirection,
  type ApplicationFocusOwner,
  type ApplicationWindowState,
  type BufferState,
  type SidebarUpdateInput,
  type SplitDirection,
  type WindowFocusDirection,
} from "./application-state";
import {
  TiptapEditorAdapter,
  type TiptapEditorAdapterOptions,
} from "../editor/tiptap-adapter";
import { VimRegisterStore } from "../vim/register-store";
import { VimRepeatStore } from "../vim/repeat";
import { VimVisualSelectionStore } from "../vim/visual-history";
import {
  type EditorNavigationDestination,
  type EditorNavigationRequest,
  type EditorNavigationResult,
} from "./editor-navigation";
import { WindowJumpList } from "./jump-list";
import {
  deriveNoteSearchProjection,
  selectNoteSearchMatch,
  type NoteSearchDirection,
  type NoteSearchNavigationStatus,
  type NoteSearchOrigin,
  type NoteSearchProjection,
} from "./note-search";
import {
  deriveInternalLinkCandidates,
  deriveTrashSearchCandidates,
  type InternalLinkCandidate,
} from "./internal-link-candidates";
import {
  planNewNotePosition,
  planNoteMove,
  planNoteTrash,
  planTrashRestore,
  noteAncestorPath,
  treeMoveRequestForDirection,
  type NoteMoveRequest,
  type TreeMoveDirection,
} from "./note-tree";
import { siblingPositionSeed } from "./sibling-position";
import { type StableEditorPosition } from "./stable-position";
import {
  deriveWorkspaceSearchDocumentAsync,
  filterWorkspaceSearchCatalog,
  normalizeWorkspaceSearchText,
  type WorkspaceSearchCatalog,
  type WorkspaceSearchDocument,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSearchTarget,
  workspaceSearchResultFromIndexedEntry,
  workspaceSearchJapaneseGrams,
} from "./workspace-search";
import {
  WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
  supportsWorkspaceSearchIndex,
  workspaceSearchIndexQuery,
  type WorkspaceSearchIndexPort,
  type WorkspaceSearchIndexMetadataRevisionRequest,
  type WorkspaceSearchIndexRebuildRequest,
  type WorkspaceSearchIndexedDocument,
} from "./workspace-search-index";
import {
  createMemokaHelpSectionSnapshot,
  MEMOKA_HELP_TITLE,
} from "./help-note";

export interface CoreRuntimeOptions {
  idFactory?: () => string;
  clock?: () => string;
  initialTitle?: string;
  onError?: (error: Error) => void;
  snapshotCompactionThreshold?: number;
  snapshotCompactionByteThreshold?: number;
  workspaceSearchIndex?: WorkspaceSearchIndexPort | null;
}

export interface RuntimeSnapshot {
  workspaceId: string;
  noteId: string | null;
  title: string;
  /**
   * Stable structural/title projection for application chrome and Tree. A
   * body-only `updated_at` write does not replace this array, so typing cannot
   * retraverse a large Note Tree.
   */
  notes: readonly NoteMetadata[];
  loadedNoteIds: string[];
  applicationWindow: ApplicationWindowState;
  windows: RuntimeWindowState[];
  workspaceRevision: number;
  /** Changes only when rendered Internal Link labels may have changed. */
  internalLinkLabelRevision: number;
  noteRevision: number | null;
  noteContentRevision: number;
  persistence: "ready" | "saving" | "error";
  error: string | null;
}

export type RuntimeSearchIndexPhase =
  "unavailable" | "idle" | "waiting" | "queued" | "running" | "error";

export interface RuntimeBackgroundTaskSnapshot {
  readonly searchIndex: {
    readonly phase: RuntimeSearchIndexPhase;
    readonly detail: string | null;
    readonly pendingNoteCount: number;
    readonly pendingHierarchyCount: number;
    readonly queuedTaskCount: number;
    readonly lastTask: string | null;
    readonly lastDurationMs: number | null;
  };
}

export interface RuntimeSectionBreadcrumbEntry {
  readonly sectionId: string;
  readonly title: string;
}

export interface RuntimeWindowState extends WindowLocalViewState {
  windowId: string;
  noteId: string | null;
}

type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

interface CreateNewNoteInput {
  operationId: string;
  noteId: string;
  title: string;
  createdAt: string;
  parentNoteId: string | null;
  afterNoteId: string | null;
  windowId?: string;
  fault?: CommitFault;
}

interface PreparedManagedNote {
  readonly handle: ManagedCrdtDocument<ProductDocument>;
  readonly attachAfterCommit: boolean;
  readonly snapshotRevision: number;
  readonly updateBytesSinceSnapshot: number;
}

interface PendingSectionIdentityRepair {
  readonly handle: ManagedCrdtDocument<ProductDocument>;
  readonly repair: SectionIdentityRepair;
}

interface PendingWindowViewUpdate {
  readonly noteId: string;
  readonly update: {
    mode?: WindowViewState["mode"];
    selection?: WindowViewState["selection"];
    scrollTop?: number;
  };
  readonly activeSectionId?: string | null;
}

interface WindowNoteSearchState {
  readonly query: string;
  readonly noteId: string;
  readonly scopeSectionId: string;
  readonly document: Y.Doc;
  readonly documentVersion: number;
  readonly projection: NoteSearchProjection;
}

interface WorkspaceSearchProjectionCacheEntry {
  readonly sourceRevision: number;
  readonly title: string;
  readonly parentPath: string;
  readonly updatedAt: string;
  readonly document: WorkspaceSearchIndexedDocument;
}

export interface NoteSearchNavigationResult
  extends EditorNavigationResult, NoteSearchNavigationStatus {}

export const APPLICATION_WINDOW_LOCAL_STATE_ID = "application-window:main";

const DEFAULT_APPLICATION_WINDOW_ID = "application-window-1";
const DEFAULT_TAB_ID = "tab-1";
const WORKSPACE_SEARCH_INDEX_INPUT_DEBOUNCE_MS = 1_000;
const WINDOW_SELECTION_PERSISTENCE_DEBOUNCE_MS = 120;
const EDITOR_PERSISTENCE_NOTIFICATION_DEBOUNCE_MS = 500;
const DEFAULT_SNAPSHOT_COMPACTION_BYTE_THRESHOLD = 512 * 1024;

function groupInternalLinkCandidatesByNote(
  candidates: readonly InternalLinkCandidate[],
): Map<string, InternalLinkCandidate[]> {
  const grouped = new Map<string, InternalLinkCandidate[]>();
  for (const candidate of candidates) {
    const entries = grouped.get(candidate.noteId) ?? [];
    entries.push(candidate);
    grouped.set(candidate.noteId, entries);
  }
  return grouped;
}

export class CoreRuntime {
  readonly commands = new CoreCommandRegistry();
  readonly transactions: CoreTransactionGateway;
  readonly notes = new Map<string, ManagedCrdtDocument<ProductDocument>>();
  readonly vimRegister = new VimRegisterStore();

  private readonly notePersistence = new Map<string, NotePersistenceSession>();
  private readonly noteLoads = new Map<
    string,
    Promise<ManagedCrdtDocument<ProductDocument>>
  >();
  private readonly pendingSectionIdentityRepairs = new Map<
    string,
    PendingSectionIdentityRepair
  >();
  private readonly jumpLists = new Map<string, WindowJumpList>();
  private readonly pendingNavigations = new Map<
    string,
    { destination: EditorNavigationDestination; detail: string }
  >();
  private readonly repeatStores = new Map<string, VimRepeatStore>();
  private readonly visualSelectionStores = new Map<
    string,
    VimVisualSelectionStore
  >();
  private readonly noteSearchStates = new Map<string, WindowNoteSearchState>();
  private readonly noteSearchDocumentVersions = new WeakMap<
    Y.Doc,
    { value: number }
  >();
  private readonly changedNoteRevisions = new Map<string, number>();
  private noteContentRevision = 0;
  private sectionCatalogRevision = 0;
  private internalLinkLabelRevision = 0;
  private readonly listeners = new Set<RuntimeListener>();
  private internalLinkCandidateRevision = -1;
  private internalLinkCandidateCache: InternalLinkCandidate[] = [];
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly onError?: (error: Error) => void;
  private readonly snapshotCompactionThreshold: number;
  private readonly snapshotCompactionByteThreshold: number;
  private readonly workspaceSearchIndex: WorkspaceSearchIndexPort | null;
  private workspaceSearchIndexQueue: Promise<void> = Promise.resolve();
  private readonly pendingWorkspaceSearchIndexNoteIds = new Set<string>();
  private readonly pendingWorkspaceSearchIndexHierarchyNoteIds =
    new Set<string>();
  private pendingWorkspaceSearchIndexHierarchyBaseRevision: number | null =
    null;
  private workspaceSearchIndexQueuedTaskCount = 0;
  private workspaceSearchIndexRunningTask: string | null = null;
  private workspaceSearchIndexLastTask: string | null = null;
  private workspaceSearchIndexLastDurationMs: number | null = null;
  private readonly workspaceSearchDirtyNoteIds = new Set<string>();
  private readonly workspaceSearchProjectionCache = new Map<
    string,
    WorkspaceSearchProjectionCacheEntry
  >();
  private workspaceSearchFallbackCatalogCache: {
    readonly signature: string;
    readonly promise: Promise<WorkspaceSearchCatalog>;
  } | null = null;
  private workspaceSearchRebuildQueuedSignature: string | null = null;
  private workspaceSearchRebuildFailedSignature: string | null = null;
  private workspaceSearchIndexDocumentTimer: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;
  private workspaceSearchIndexWarning: string | null = null;
  private localStateQueue: Promise<void> = Promise.resolve();
  /**
   * Window-local projections are not part of NoteDoc durability. Merge all
   * mode/selection/scroll changes produced in one paint into one local-ui
   * Core transaction so typing cannot enqueue two SQLite commits per frame.
   */
  private readonly pendingWindowViewUpdates = new Map<
    string,
    PendingWindowViewUpdate
  >();
  /**
   * Keeps the latest paint-coalesced view update visible while its local-state
   * transaction waits behind structural Window operations. An Editor that is
   * remounted by a split must not briefly return to the last durable mode.
   */
  private readonly inFlightWindowViewUpdates = new Map<
    string,
    PendingWindowViewUpdate
  >();
  private windowViewUpdateFrame: number | null = null;
  private windowViewUpdateTimer: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;
  private editorPersistenceNotificationTimer: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;
  private persistenceStatus: RuntimeSnapshot["persistence"] = "ready";
  private lastError: string | null = null;
  private activeNoteId: string | null = null;
  private applicationWindowState: ApplicationWindowState | null = null;
  private noteMetadataProjectionCache: readonly NoteMetadata[] | null = null;
  private observedWorkspaceNotes: Y.Map<Y.Map<unknown>> | null = null;
  private unsubscribeWorkspaceReplacement: (() => void) | null = null;

  private readonly handleWorkspaceMetadataChange = (
    events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
  ): void => {
    const affectsApplicationProjection = events.some((event) =>
      [...event.changes.keys].some(([key, change]) => {
        if (key === "updated_at") return false;
        return !(
          change.action === "update" &&
          event.target instanceof Y.Map &&
          Object.is(change.oldValue, event.target.get(key))
        );
      }),
    );
    if (affectsApplicationProjection) this.noteMetadataProjectionCache = null;
  };

  private constructor(
    private readonly persistence: PersistencePort,
    readonly workspace: ManagedCrdtDocument<ProductDocument>,
    options: CoreRuntimeOptions,
  ) {
    this.transactions = new CoreTransactionGateway(persistence);
    this.idFactory = options.idFactory ?? createUuidV7;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.onError = options.onError;
    this.snapshotCompactionThreshold =
      options.snapshotCompactionThreshold ?? 128;
    this.snapshotCompactionByteThreshold =
      options.snapshotCompactionByteThreshold ??
      DEFAULT_SNAPSHOT_COMPACTION_BYTE_THRESHOLD;
    this.workspaceSearchIndex =
      options.workspaceSearchIndex === undefined
        ? supportsWorkspaceSearchIndex(persistence)
          ? persistence
          : null
        : options.workspaceSearchIndex;
    if (
      !Number.isSafeInteger(this.snapshotCompactionThreshold) ||
      this.snapshotCompactionThreshold < 1
    ) {
      throw new Error(
        "snapshotCompactionThreshold must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(this.snapshotCompactionByteThreshold) ||
      this.snapshotCompactionByteThreshold < 1
    ) {
      throw new Error(
        "snapshotCompactionByteThreshold must be a positive safe integer",
      );
    }
    this.observeWorkspaceMetadata(this.workspace.current);
    this.unsubscribeWorkspaceReplacement = this.workspace.subscribe(
      (document) => this.observeWorkspaceMetadata(document),
    );
    this.registerCommands();
  }

  static async open(
    persistence: PersistencePort,
    options: CoreRuntimeOptions = {},
  ): Promise<CoreRuntime> {
    const manifest = await persistence.manifest();
    if (manifest.databaseSchemaVersion !== 4) {
      throw new Error(
        `Unsupported persistence schema ${manifest.databaseSchemaVersion}`,
      );
    }

    if (!manifest.activeWorkspaceId) {
      return CoreRuntime.bootstrap(persistence, options);
    }

    const persistedWorkspace = await persistence.loadDocument(
      "workspace",
      manifest.activeWorkspaceId,
    );
    const workspace = new ManagedCrdtDocument<ProductDocument>(
      loadProductDocument(
        "workspace",
        manifest.activeWorkspaceId,
        persistedWorkspace.snapshot,
        persistedWorkspace.updates.map(({ update }) => update),
      ),
      persistedWorkspace.revision,
    );
    const runtime = new CoreRuntime(persistence, workspace, options);
    try {
      await runtime.loadExistingState();
      return runtime;
    } catch (error) {
      runtime.destroy();
      throw error;
    }
  }

  private static async bootstrap(
    persistence: PersistencePort,
    options: CoreRuntimeOptions,
  ): Promise<CoreRuntime> {
    const idFactory = options.idFactory ?? createUuidV7;
    const workspaceId = idFactory();
    const workspace = new ManagedCrdtDocument<ProductDocument>(
      createWorkspaceDocument(workspaceId),
      0,
    );
    const runtime = new CoreRuntime(persistence, workspace, {
      ...options,
      idFactory,
    });
    await runtime.transactions.transact(
      {
        operationId: idFactory(),
        scope: "bootstrap",
        documents: [workspace],
      },
      () => undefined,
    );
    await runtime.executeCommand({
      name: "note.create",
      operationId: idFactory(),
      source: "internal",
      payload: {
        noteId: idFactory(),
        title: options.initialTitle ?? "",
        createdAt: runtime.clock(),
        parentNoteId: null,
        afterNoteId: null,
      },
    });
    return runtime;
  }

  get workspaceDocument(): WorkspaceDocument {
    if (this.workspace.current.kind !== "workspace") {
      throw new Error("Core runtime workspace handle is invalid");
    }
    return this.workspace.current;
  }

  get noteId(): string {
    return this.requireActiveNoteId();
  }

  get noteDocument(): NoteDocument {
    const noteId = this.requireActiveNoteId();
    const handle = this.notes.get(noteId);
    if (!handle || handle.current.kind !== "note") {
      throw new Error(`Active NoteDoc is not loaded: ${noteId}`);
    }
    return handle.current;
  }

  get applicationWindow(): ApplicationWindowState {
    return structuredClone(this.requireApplicationWindowState());
  }

  get windows(): ReadonlyMap<string, RuntimeWindowState> {
    if (!this.applicationWindowState) return new Map();
    return new Map(
      Object.keys(this.applicationWindowState.windows)
        .sort((left, right) => left.localeCompare(right))
        .map((windowId) => [windowId, this.projectWindowState(windowId)]),
    );
  }

  getNoteHandle(noteId?: string): ManagedCrdtDocument<ProductDocument> {
    const resolvedNoteId = noteId ?? this.requireActiveNoteId();
    const handle = this.notes.get(resolvedNoteId);
    if (!handle || handle.current.kind !== "note") {
      throw new Error(`NoteDoc is not loaded: ${resolvedNoteId}`);
    }
    return handle;
  }

  /**
   * Derives plain text only for an explicit caller that needs it. Runtime UI
   * snapshots intentionally omit NoteDoc body projections so persistence
   * status notifications stay independent of the edited document size.
   */
  readNoteText(noteId?: string): string {
    return readNotePlainText(
      this.getNoteHandle(noteId).current as NoteDocument,
    );
  }

  portableWorkspaceSnapshot(): {
    readonly workspaceId: string;
    readonly schemaVersion: number;
    readonly revision: number;
  } {
    return {
      workspaceId: this.workspaceDocument.workspaceId,
      schemaVersion: this.workspaceDocument.schemaVersion,
      revision: this.workspace.revision,
    };
  }

  /**
   * Loads a read-only preview without turning an unopened note into a Buffer.
   * A document already owned by the runtime is borrowed; a persisted-only
   * document is transient and must be released by the caller.
   */
  async loadNotePreview(
    noteId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<{
    readonly document: NoteDocument;
    readonly revision: number;
    release(): void;
  }> {
    if (options.includeDeleted) {
      if (!readNoteMetadata(this.workspaceDocument, noteId)) {
        throw new Error(`Unknown note: ${noteId}`);
      }
    } else {
      this.requireLiveMetadata(noteId);
    }
    const loaded = this.notes.get(noteId);
    if (loaded?.current.kind === "note") {
      return {
        document: loaded.current,
        revision: loaded.revision,
        release: () => undefined,
      };
    }
    const persisted = await this.persistence.loadDocument("note", noteId);
    const prepared = await this.preparePersistedManagedNote(persisted);
    const document = prepared.handle.current;
    if (document.kind !== "note") {
      document.doc.destroy();
      throw new Error(`Search preview target is not a NoteDoc: ${noteId}`);
    }
    let released = false;
    return {
      document,
      revision: prepared.handle.revision,
      release: () => {
        if (released) return;
        released = true;
        document.doc.destroy();
      },
    };
  }

  resolveInternalLinkTitle(sectionId: string): string | null {
    for (const handle of this.notes.values()) {
      if (handle.current.kind !== "note") continue;
      const section = findSectionById(handle.current.rootSection, sectionId);
      if (section) {
        return handle.current.rootSection === section
          ? noteDisplayTitle(readNoteTitle(handle.current))
          : sectionTitle(section) || "無題";
      }
    }
    return (
      this.internalLinkCandidates().find(
        (candidate) => candidate.sectionId === sectionId,
      )?.title ?? null
    );
  }

  snapshot(): RuntimeSnapshot {
    const notes = this.applicationNoteMetadata();
    const metadata = notes.find(({ noteId }) => noteId === this.activeNoteId);
    const noteHandle = this.activeNoteId
      ? this.notes.get(this.activeNoteId)
      : undefined;
    if (this.activeNoteId && !noteHandle) {
      throw new Error(`Active NoteDoc is not loaded: ${this.activeNoteId}`);
    }
    return {
      workspaceId: this.workspaceDocument.workspaceId,
      noteId: this.activeNoteId,
      title: metadata?.title ?? "",
      notes,
      loadedNoteIds: [...this.notes.keys()].sort(),
      applicationWindow: this.applicationWindow,
      windows: [...this.windows.values()]
        .sort((left, right) => left.windowId.localeCompare(right.windowId))
        .map((state) => structuredClone(state)),
      workspaceRevision: this.workspace.revision,
      internalLinkLabelRevision: this.internalLinkLabelRevision,
      noteRevision: noteHandle?.revision ?? null,
      noteContentRevision: this.noteContentRevision,
      persistence: this.persistenceStatus,
      error: this.lastError,
    };
  }

  /**
   * Development-only observation of rebuildable background work. Reading it
   * has no side effects and does not add Runtime subscribers or UI renders.
   */
  backgroundTaskSnapshot(): RuntimeBackgroundTaskSnapshot {
    const pendingNoteCount = this.pendingWorkspaceSearchIndexNoteIds.size;
    const pendingHierarchyCount =
      this.pendingWorkspaceSearchIndexHierarchyNoteIds.size;
    const common = {
      pendingNoteCount,
      pendingHierarchyCount,
      queuedTaskCount: this.workspaceSearchIndexQueuedTaskCount,
      lastTask: this.workspaceSearchIndexLastTask,
      lastDurationMs: this.workspaceSearchIndexLastDurationMs,
    };
    if (!this.workspaceSearchIndex) {
      return {
        searchIndex: { phase: "unavailable", detail: null, ...common },
      };
    }
    if (this.workspaceSearchIndexRunningTask) {
      return {
        searchIndex: {
          phase: "running",
          detail: this.workspaceSearchIndexRunningTask,
          ...common,
        },
      };
    }
    if (this.workspaceSearchIndexQueuedTaskCount > 0) {
      return {
        searchIndex: {
          phase: "queued",
          detail: `${this.workspaceSearchIndexQueuedTaskCount}`,
          ...common,
        },
      };
    }
    if (
      pendingNoteCount > 0 ||
      this.pendingWorkspaceSearchIndexHierarchyBaseRevision !== null
    ) {
      const detail = [
        pendingNoteCount > 0 ? `notes:${pendingNoteCount}` : null,
        pendingHierarchyCount > 0 ? `hierarchy:${pendingHierarchyCount}` : null,
      ]
        .filter(Boolean)
        .join(",");
      return {
        searchIndex: { phase: "waiting", detail, ...common },
      };
    }
    if (this.workspaceSearchIndexWarning) {
      return {
        searchIndex: {
          phase: "error",
          detail: this.workspaceSearchIndexWarning,
          ...common,
        },
      };
    }
    return { searchIndex: { phase: "idle", detail: null, ...common } };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  executeCommand<Name extends CoreCommandName>(
    envelope: CoreCommandEnvelope<Name>,
  ): Promise<CoreCommandResults[Name]> {
    return this.commands.execute(envelope);
  }

  createNoteAtEnd(
    windowId: string,
    title: string,
  ): Promise<{ noteId: string }> {
    return this.executeCommand({
      name: "note.create",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId: this.idFactory(),
        title,
        createdAt: this.clock(),
        windowId,
        parentNoteId: null,
        afterNoteId: null,
      },
    });
  }

  createNoteAfter(
    windowId: string,
    afterNoteId: string,
    title: string,
  ): Promise<{ noteId: string }> {
    const sibling = this.requireLiveMetadata(afterNoteId);
    return this.executeCommand({
      name: "note.create",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId: this.idFactory(),
        title,
        parentNoteId: sibling.parentNoteId,
        afterNoteId,
        createdAt: this.clock(),
        windowId,
      },
    });
  }

  createRootNote(windowId: string): Promise<{ noteId: string }> {
    return this.executeCommand({
      name: "note.create_root",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId: this.idFactory(),
        createdAt: this.clock(),
        windowId,
      },
    });
  }

  createChildNote(
    windowId: string,
    parentNoteId: string,
  ): Promise<{ noteId: string }> {
    return this.executeCommand({
      name: "note.create_child",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId: this.idFactory(),
        parentNoteId,
        createdAt: this.clock(),
        windowId,
      },
    });
  }

  createSiblingNote(
    windowId: string,
    siblingNoteId: string,
  ): Promise<{ noteId: string }> {
    return this.executeCommand({
      name: "note.create_sibling_after",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId: this.idFactory(),
        siblingNoteId,
        createdAt: this.clock(),
        windowId,
      },
    });
  }

  openNote(
    windowId: string,
    noteId: string,
  ): Promise<{
    noteId: string;
    windowId: string;
  }> {
    return this.executeCommand({
      name: "note.open",
      operationId: this.idFactory(),
      source: "ui",
      payload: { noteId, windowId },
    });
  }

  openHelpNote(
    windowId: string,
  ): Promise<CoreCommandResults["note.open_help"]> {
    return this.executeCommand({
      name: "note.open_help",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        windowId,
        newNoteId: this.idFactory(),
        synchronizedAt: this.clock(),
      },
    });
  }

  splitEditorWindow(
    targetWindowId: string,
    direction: SplitDirection,
  ): Promise<CoreCommandResults["window.split"]> {
    const operationId = this.idFactory();
    return this.executeCommand({
      name: "window.split",
      operationId,
      source: "ui",
      payload: {
        targetWindowId,
        newWindowId: `window:${operationId}`,
        splitId: `split:${operationId}`,
        direction,
      },
    });
  }

  focusEditorWindow(
    windowId: string,
  ): Promise<CoreCommandResults["window.focus"]> {
    return this.executeCommand({
      name: "window.focus",
      operationId: this.idFactory(),
      source: "ui",
      payload: { windowId },
    });
  }

  focusEditorWindowInDirection(
    windowId: string,
    direction: WindowFocusDirection,
  ): Promise<CoreCommandResults["window.focus_direction"]> {
    return this.executeCommand({
      name: "window.focus_direction",
      operationId: this.idFactory(),
      source: "ui",
      payload: { windowId, direction },
    });
  }

  closeEditorWindow(
    windowId: string,
  ): Promise<CoreCommandResults["window.close"]> {
    return this.executeCommand({
      name: "window.close",
      operationId: this.idFactory(),
      source: "ui",
      payload: { windowId },
    });
  }

  keepOnlyEditorWindow(
    windowId: string,
  ): Promise<CoreCommandResults["window.only"]> {
    return this.executeCommand({
      name: "window.only",
      operationId: this.idFactory(),
      source: "ui",
      payload: { windowId },
    });
  }

  createEditorTab(): Promise<CoreCommandResults["tab.create"]> {
    const operationId = this.idFactory();
    return this.executeCommand({
      name: "tab.create",
      operationId,
      source: "ui",
      payload: {
        tabId: `tab:${operationId}`,
        windowId: `window:${operationId}`,
      },
    });
  }

  switchEditorTab(tabId: string): Promise<CoreCommandResults["tab.switch"]> {
    return this.executeCommand({
      name: "tab.switch",
      operationId: this.idFactory(),
      source: "ui",
      payload: { tabId },
    });
  }

  cycleEditorTab(
    direction: "next" | "previous",
  ): Promise<CoreCommandResults["tab.cycle"]> {
    return this.executeCommand({
      name: "tab.cycle",
      operationId: this.idFactory(),
      source: "ui",
      payload: { direction },
    });
  }

  closeEditorTab(tabId: string): Promise<CoreCommandResults["tab.close"]> {
    return this.executeCommand({
      name: "tab.close",
      operationId: this.idFactory(),
      source: "ui",
      payload: { tabId },
    });
  }

  closeBuffer(bufferId: string): Promise<CoreCommandResults["buffer.close"]> {
    return this.executeCommand({
      name: "buffer.close",
      operationId: this.idFactory(),
      source: "ui",
      payload: { bufferId },
    });
  }

  updateSidebar(
    update: SidebarUpdateInput,
  ): Promise<CoreCommandResults["sidebar.update"]> {
    return this.executeCommand({
      name: "sidebar.update",
      operationId: this.idFactory(),
      source: "ui",
      payload: update,
    });
  }

  renameNote(noteId: string, title: string): Promise<{ noteId: string }> {
    return this.executeCommand({
      name: "note.rename",
      operationId: this.idFactory(),
      source: "ui",
      payload: { noteId, title, updatedAt: this.clock() },
    });
  }

  reorderNote(
    noteId: string,
    direction: "up" | "down",
  ): Promise<CoreCommandResults["note.reorder"]> {
    const request = treeMoveRequestForDirection(
      listNoteMetadata(this.workspaceDocument),
      noteId,
      direction,
    );
    if (!request) return Promise.resolve({ noteId, changed: false });
    return this.moveNote(noteId, request);
  }

  moveNote(
    noteId: string,
    request: NoteMoveRequest,
  ): Promise<CoreCommandResults["note.move"]> {
    return this.executeCommand({
      name: "note.move",
      operationId: this.idFactory(),
      source: "ui",
      payload: { noteId, ...request },
    });
  }

  moveNoteInTree(
    noteId: string,
    direction: TreeMoveDirection,
  ): Promise<CoreCommandResults["note.move"]> {
    const request = treeMoveRequestForDirection(
      listNoteMetadata(this.workspaceDocument),
      noteId,
      direction,
    );
    return request
      ? this.moveNote(noteId, request)
      : Promise.resolve({ noteId, changed: false });
  }

  shiftSectionDepth(
    noteId: string,
    boundarySectionId: string,
    sectionIds: string[],
    direction: "deeper" | "shallower",
  ): Promise<CoreCommandResults["section.shift_depth"]> {
    return this.executeCommand({
      name: "section.shift_depth",
      operationId: this.idFactory(),
      source: "editor",
      payload: {
        noteId,
        boundarySectionId,
        sectionIds,
        direction,
        updatedAt: this.clock(),
      },
    });
  }

  createSectionFromParagraph(
    noteId: string,
    request: {
      boundarySectionId: string;
      sourceSectionId: string;
      paragraphBlockId: string;
      paragraphBodyIndex: number;
      title: string;
      direction: "deeper" | "shallower";
    },
  ): Promise<CoreCommandResults["section.create_from_paragraph"]> {
    return this.executeCommand({
      name: "section.create_from_paragraph",
      operationId: this.idFactory(),
      source: "editor",
      payload: {
        noteId,
        ...request,
        newSectionId: this.idFactory(),
        updatedAt: this.clock(),
      },
    });
  }

  sectionBreadcrumb(
    noteId: string,
    targetSectionId: string,
  ): RuntimeSectionBreadcrumbEntry[] {
    const handle = this.getNoteHandle(noteId);
    if (handle.current.kind !== "note") return [];
    const catalog = noteSectionCatalog(handle.current);
    const byId = new Map(catalog.map((entry) => [entry.sectionId, entry]));
    const path: RuntimeSectionBreadcrumbEntry[] = [];
    let current = byId.get(targetSectionId);
    while (current) {
      path.push({
        sectionId: current.sectionId,
        title: current.displayTitle,
      });
      current = current.parentSectionId
        ? byId.get(current.parentSectionId)
        : undefined;
    }
    return path.reverse();
  }

  focusSection(
    windowId: string,
    noteId: string,
    targetSectionId: string,
  ): Promise<CoreCommandResults["window.focus_section"]> {
    return this.executeCommand({
      name: "window.focus_section",
      operationId: this.idFactory(),
      source: "ui",
      payload: { windowId, noteId, sectionId: targetSectionId },
    });
  }

  focusParentSection(
    windowId: string,
  ): Promise<CoreCommandResults["window.focus_section"]> | null {
    const state = this.requireContentWindowState(windowId);
    const note = this.getNoteHandle(state.noteId).current as NoteDocument;
    const currentId = state.focusedSectionId ?? note.noteId;
    const parent = findParentSection(note.rootSection, currentId);
    if (!parent) return null;
    return this.focusSection(windowId, note.noteId, sectionId(parent));
  }

  moveNoteToTrash(noteId: string): Promise<{
    noteId: string;
    trashedNoteIds: string[];
    fallbackNoteId: string | null;
  }> {
    return this.executeCommand({
      name: "note.move_to_trash",
      operationId: this.idFactory(),
      source: "ui",
      payload: {
        noteId,
        deletedAt: this.clock(),
      },
    });
  }

  restoreNoteFromTrash(noteId: string): Promise<{
    noteId: string;
    restoredNoteIds: string[];
  }> {
    return this.executeCommand({
      name: "note.restore_from_trash",
      operationId: this.idFactory(),
      source: "ui",
      payload: { noteId, restoredAt: this.clock() },
    });
  }

  jumpListFor(windowId: string): WindowJumpList {
    if (!this.windows.has(windowId))
      throw new Error(`Unknown window: ${windowId}`);
    let jumpList = this.jumpLists.get(windowId);
    if (!jumpList) {
      jumpList = new WindowJumpList(windowId);
      this.jumpLists.set(windowId, jumpList);
    }
    return jumpList;
  }

  /**
   * Completes a navigation after the destination Section has been bound to an
   * Editor. A same-Section jump can reuse the current adapter, while a Section
   * focus change consumes the same pending record during the replacement
   * adapter's attach path.
   */
  applyPendingNavigation(
    windowId: string,
    adapter: TiptapEditorAdapter,
  ): string | null {
    const pending = this.pendingNavigations.get(windowId);
    const attachedNoteId = adapter.editor.view.dom.dataset.noteId;
    if (!pending || pending.destination.noteId !== attachedNoteId) return null;
    const applied = adapter.applyNavigationDestination(
      pending.destination,
      pending.detail,
    );
    if (applied) this.pendingNavigations.delete(windowId);
    return applied;
  }

  async navigateEditor(
    windowId: string,
    request: EditorNavigationRequest,
  ): Promise<EditorNavigationResult> {
    const windowState = this.windows.get(windowId);
    if (!windowState) throw new Error(`Unknown window: ${windowId}`);
    if (!this.windowDisplaysNote(windowId, request.current.noteId)) {
      return { handled: false, detail: `jump:${request.kind}:stale` };
    }

    const jumpList = this.jumpListFor(windowId);
    if (request.kind === "follow-link") {
      const target = this.resolveSectionLocation(request.target.sectionId);
      if (!target || !this.isLiveNote(target.noteId)) {
        return { handled: false, detail: "jump:gf:missing-note" };
      }
      return this.focusNavigationSection(
        windowId,
        target.noteId,
        target.sectionId,
        { kind: "section-start", ...target },
        "jump:gf:changed",
        request.current,
      );
    }

    const beforeMove = jumpList.snapshot();
    const target =
      request.kind === "back"
        ? jumpList.back(request.current, (entry) =>
            this.isLiveNote(entry.noteId),
          )
        : jumpList.forward(request.current, (entry) =>
            this.isLiveNote(entry.noteId),
          );
    if (!target) {
      return { handled: false, detail: `jump:${request.kind}:empty` };
    }
    const destination: EditorNavigationDestination = {
      kind: "stable",
      noteId: target.noteId,
      saved: target,
    };
    const detail = `jump:${request.kind}:changed`;
    const targetSectionId = target.sectionId ?? target.noteId;
    const currentFocus =
      this.requireContentWindowState(windowId).focusedSectionId ??
      windowState.noteId;
    if (
      this.windowDisplaysNote(windowId, destination.noteId) &&
      currentFocus === targetSectionId
    ) {
      return { handled: true, detail, destination };
    }
    return this.focusNavigationSection(
      windowId,
      target.noteId,
      targetSectionId,
      destination,
      detail,
      undefined,
      () => jumpList.restore(beforeMove),
    );
  }

  searchNote(
    windowId: string,
    origin: NoteSearchOrigin,
    query: string,
    count = 1,
  ): Promise<NoteSearchNavigationResult> {
    if (!query)
      return this.repeatNoteSearch(windowId, origin, "forward", count);
    return this.navigateNoteSearch(
      windowId,
      origin,
      query,
      "forward",
      count,
      true,
    );
  }

  repeatNoteSearch(
    windowId: string,
    origin: NoteSearchOrigin,
    direction: NoteSearchDirection,
    count = 1,
  ): Promise<NoteSearchNavigationResult> {
    const query = this.noteSearchStates.get(windowId)?.query;
    if (!query) {
      return Promise.resolve({
        handled: false,
        detail: "search:note:no-pattern",
        query: null,
        matchCount: 0,
        matchIndex: null,
        wrapped: false,
      });
    }
    return this.navigateNoteSearch(
      windowId,
      origin,
      query,
      direction,
      count,
      false,
    );
  }

  private async navigateNoteSearch(
    windowId: string,
    origin: NoteSearchOrigin,
    query: string,
    direction: NoteSearchDirection,
    count: number,
    replacePattern: boolean,
  ): Promise<NoteSearchNavigationResult> {
    const windowState = this.windows.get(windowId);
    if (!windowState) throw new Error(`Unknown window: ${windowId}`);
    if (!this.windowDisplaysNote(windowId, origin.stable.noteId)) {
      return {
        handled: false,
        detail: "search:note:stale",
        query,
        matchCount: 0,
        matchIndex: null,
        wrapped: false,
      };
    }
    const handle = this.getNoteHandle(origin.stable.noteId);
    const note = handle.current;
    if (note.kind !== "note") {
      return {
        handled: false,
        detail: "search:note:missing-note",
        query,
        matchCount: 0,
        matchIndex: null,
        wrapped: false,
      };
    }
    const documentVersion = this.noteSearchDocumentVersion(note.doc);
    const scopeSectionId = windowState.focusedSectionId ?? note.noteId;
    const cached = this.noteSearchStates.get(windowId);
    const projection =
      !replacePattern &&
      cached?.noteId === note.noteId &&
      cached.scopeSectionId === scopeSectionId &&
      cached.query === query &&
      cached.document === note.doc &&
      cached.documentVersion === documentVersion
        ? cached.projection
        : deriveNoteSearchProjection(note, query, scopeSectionId);
    this.noteSearchStates.set(windowId, {
      query,
      noteId: note.noteId,
      scopeSectionId,
      document: note.doc,
      documentVersion,
      projection,
    });
    const selected = selectNoteSearchMatch(
      projection,
      origin.location,
      direction,
      count,
    );
    if (!selected) {
      return {
        handled: false,
        detail: `search:note:not-found:${query}`,
        query,
        matchCount: 0,
        matchIndex: null,
        wrapped: false,
      };
    }
    const destination: EditorNavigationDestination = {
      kind: "note-search-match",
      noteId: note.noteId,
      sectionId: selected.match.sectionId,
      blockId: selected.match.blockId,
      offset: selected.match.offset,
      query,
    };
    const detail = `search:note:${direction}:${selected.index + 1}/${projection.matches.length}${selected.wrapped ? ":wrapped" : ""}`;
    const result = {
      query,
      matchCount: projection.matches.length,
      matchIndex: selected.index,
      wrapped: selected.wrapped,
    };
    this.jumpListFor(windowId).recordOrigin(origin.stable);
    return { handled: true, detail, destination, ...result };
  }

  private noteSearchDocumentVersion(document: Y.Doc): number {
    let tracker = this.noteSearchDocumentVersions.get(document);
    if (!tracker) {
      tracker = { value: 0 };
      this.noteSearchDocumentVersions.set(document, tracker);
      document.on("afterTransaction", (transaction) => {
        // y-prosemirror emits selection/plugin bookkeeping transactions with
        // no changed CRDT type. n/N must keep using the cached projection for
        // those transactions and invalidate only when NoteDoc content changed.
        if (transaction.changed.size > 0) tracker!.value += 1;
      });
    }
    return tracker.value;
  }

  async workspaceSearchCatalog(): Promise<WorkspaceSearchCatalog> {
    return this.buildWorkspaceSearchCatalog(false);
  }

  private async buildWorkspaceSearchCatalog(
    persistedOnly: boolean,
  ): Promise<WorkspaceSearchCatalog> {
    const documents: WorkspaceSearchDocument[] = [];
    const failures: WorkspaceSearchCatalog["failures"][number][] = [];
    const noteMetadata = listNoteMetadata(this.workspaceDocument);
    for (const metadata of noteMetadata) {
      if (metadata.deletedAt) continue;
      let temporary: ProductDocument | null = null;
      try {
        const loaded = persistedOnly
          ? undefined
          : this.notes.get(metadata.noteId);
        const persisted = loaded
          ? null
          : await this.persistence.loadDocument("note", metadata.noteId);
        const prepared = loaded
          ? null
          : await this.preparePersistedManagedNote(persisted!);
        const document = loaded ? loaded.current : prepared!.handle.current;
        const sourceRevision = loaded?.revision ?? prepared!.handle.revision;
        if (!loaded) temporary = document;
        if (document.kind !== "note") {
          throw new Error(`Search target is not a NoteDoc: ${metadata.noteId}`);
        }
        const projection = {
          ...(await deriveWorkspaceSearchDocumentAsync(
            document,
            metadata.title,
            noteAncestorPath(noteMetadata, metadata.noteId),
            metadata.updatedAt,
            metadata.parentNoteId,
          )),
          sourceRevision,
        };
        // Cooperative projection yields to WebKit. A live Editor or sync
        // update can advance/replace the NoteDoc while it yields; never label
        // that mixed projection with the older durable revision.
        if (
          loaded &&
          (loaded.current !== document || loaded.revision !== sourceRevision)
        ) {
          throw new Error(
            `NoteDoc changed while deriving search projection: ${metadata.noteId}`,
          );
        }
        documents.push(projection);
      } catch (error) {
        documents.push({
          noteId: metadata.noteId,
          parentNoteId: metadata.parentNoteId,
          title: metadata.title,
          parentPath: "/",
          updatedAt: metadata.updatedAt,
          blocks: [],
        });
        failures.push({
          noteId: metadata.noteId,
          title: metadata.title,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        temporary?.doc.destroy();
      }
    }
    return { documents, failures };
  }

  async searchWorkspace(
    query: string,
    scope: WorkspaceSearchScope = "title",
    limit = 20,
    target: WorkspaceSearchTarget = "workspace",
  ): Promise<WorkspaceSearchResponse> {
    const startedAt = performance.now();
    if (target !== "workspace") {
      if (scope !== "title") {
        throw new Error(`${target} search only supports note titles`);
      }
      const catalog = this.workspaceMetadataSearchCatalog(target);
      return {
        scope,
        results: filterWorkspaceSearchCatalog(catalog, query, scope, limit),
        failures: [],
        backend: "metadata",
        elapsedMs: performance.now() - startedAt,
        warning: null,
      };
    }
    // Opening ,g with an empty query must be constant-time. In particular it
    // must not drain a pending 100 MB NoteDoc projection before the user has
    // typed anything.
    if (scope === "body" && query.trim().length === 0) {
      return {
        scope,
        results: [],
        failures: [],
        backend: this.workspaceSearchIndex ? "sqlite-fts" : "crdt-fallback",
        elapsedMs: performance.now() - startedAt,
        warning: null,
      };
    }
    const index = this.workspaceSearchIndex;
    if (index) {
      if (this.pendingWorkspaceSearchIndexHierarchyNoteIds.size > 0) {
        this.enqueuePendingWorkspaceSearchIndexHierarchyUpdates();
        await this.workspaceSearchIndexQueue;
      }
      const dirtyNoteIds = [...this.workspaceSearchDirtyNoteIds].filter(
        (noteId) => this.isLiveNote(noteId) && this.notes.has(noteId),
      );
      await Promise.all(
        dirtyNoteIds.map((noteId) => this.notePersistence.get(noteId)?.flush()),
      );
      const dirtyCatalog = await this.workspaceSearchDirtyCatalog(dirtyNoteIds);
      const request = workspaceSearchIndexQuery(
        this.workspaceDocument.workspaceId,
        this.workspace.revision,
        query,
        scope,
        limit,
        dirtyNoteIds,
      );
      try {
        const indexed = await index.queryWorkspaceSearchIndex(request);
        if (indexed.status === "ready") {
          this.workspaceSearchIndexWarning = null;
          const indexedResults = indexed.hits
            .map((hit) =>
              workspaceSearchResultFromIndexedEntry(hit, query, scope),
            )
            .filter((result): result is WorkspaceSearchResult =>
              Boolean(result),
            );
          const dirtyResults = filterWorkspaceSearchCatalog(
            dirtyCatalog,
            query,
            scope,
            limit,
          );
          return {
            results: this.mergeWorkspaceSearchResults(
              indexedResults,
              dirtyResults,
              limit,
            ),
            failures: dirtyCatalog.failures,
            scope,
            backend: dirtyNoteIds.length > 0 ? "sqlite-fts+crdt" : "sqlite-fts",
            elapsedMs: performance.now() - startedAt,
            warning: null,
          };
        }
        this.queueWorkspaceSearchIndexRebuild();
      } catch (error) {
        this.workspaceSearchIndexWarning =
          error instanceof Error ? error.message : String(error);
        this.queueWorkspaceSearchIndexRebuild();
      }
    }
    if (!index) {
      // The browser/test fallback has no SQLite dirty-note contract to make a
      // live projection stable. Let the pending persistence chain settle
      // before the cooperative projection yields; otherwise the revision can
      // advance midway through a large NoteDoc scan and the coherent-snapshot
      // guard correctly discards every result.
      await Promise.all(
        [...this.notePersistence.values()].map((session) => session.flush()),
      );
    }
    return this.workspaceSearchFallback(
      await this.cachedWorkspaceSearchCatalog(),
      query,
      scope,
      limit,
      startedAt,
      this.workspaceSearchIndexWarning,
    );
  }

  private async workspaceSearchDirtyCatalog(
    noteIds: readonly string[],
  ): Promise<WorkspaceSearchCatalog> {
    const documents: WorkspaceSearchIndexedDocument[] = [];
    const failures: WorkspaceSearchCatalog["failures"][number][] = [];
    const metadata = listNoteMetadata(this.workspaceDocument);
    const byId = new Map(metadata.map((note) => [note.noteId, note]));
    for (const noteId of noteIds) {
      const noteMetadata = byId.get(noteId);
      const handle = this.notes.get(noteId);
      if (!noteMetadata || noteMetadata.deletedAt || !handle) continue;
      if (handle.current.kind !== "note") continue;
      const parentPath = noteAncestorPath(metadata, noteId);
      const cached = this.workspaceSearchProjectionCache.get(noteId);
      if (
        cached?.sourceRevision === handle.revision &&
        cached.title === noteMetadata.title &&
        cached.parentPath === parentPath &&
        cached.updatedAt === noteMetadata.updatedAt
      ) {
        documents.push(cached.document);
        continue;
      }
      try {
        const sourceRevision = handle.revision;
        const sourceDocument = handle.current;
        const document: WorkspaceSearchIndexedDocument = {
          ...(await deriveWorkspaceSearchDocumentAsync(
            sourceDocument,
            noteMetadata.title,
            parentPath,
            noteMetadata.updatedAt,
            noteMetadata.parentNoteId,
          )),
          sourceRevision,
        };
        // Projection yields cooperatively for very large NoteDocs. Do not
        // cache it under a revision that changed during those yields; this
        // response can use the coherent snapshot it derived, while the next
        // debounced query derives the new state.
        if (
          handle.current === sourceDocument &&
          handle.revision === sourceRevision
        ) {
          this.workspaceSearchProjectionCache.set(noteId, {
            sourceRevision,
            title: noteMetadata.title,
            parentPath,
            updatedAt: noteMetadata.updatedAt,
            document,
          });
        }
        documents.push(document);
      } catch (error) {
        failures.push({
          noteId,
          title: noteMetadata.title,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { documents, failures };
  }

  private cachedWorkspaceSearchCatalog(): Promise<WorkspaceSearchCatalog> {
    const signature = `${this.workspace.revision}:${this.noteContentRevision}`;
    if (this.workspaceSearchFallbackCatalogCache?.signature === signature) {
      return this.workspaceSearchFallbackCatalogCache.promise;
    }
    const promise = this.buildWorkspaceSearchCatalog(false);
    this.workspaceSearchFallbackCatalogCache = { signature, promise };
    return promise;
  }

  private mergeWorkspaceSearchResults(
    indexed: readonly WorkspaceSearchResult[],
    dirty: readonly WorkspaceSearchResult[],
    limit: number,
  ): WorkspaceSearchResult[] {
    const inputOrder = new Map<string, number>();
    const unique = new Map<string, WorkspaceSearchResult>();
    for (const result of [...indexed, ...dirty]) {
      if (unique.has(result.resultId)) continue;
      inputOrder.set(result.resultId, inputOrder.size);
      unique.set(result.resultId, result);
    }
    return [...unique.values()]
      .sort((left, right) => {
        const updated = right.updatedAt.localeCompare(left.updatedAt);
        if (updated !== 0) return updated;
        const document = left.noteId.localeCompare(right.noteId);
        if (document !== 0) return document;
        return (
          (left.logicalLineNumber ?? 0) - (right.logicalLineNumber ?? 0) ||
          (inputOrder.get(left.resultId) ?? 0) -
            (inputOrder.get(right.resultId) ?? 0)
        );
      })
      .slice(0, limit);
  }

  async navigateWorkspaceSearchResult(
    windowId: string,
    current: StableEditorPosition | null,
    result: WorkspaceSearchResult,
  ): Promise<EditorNavigationResult> {
    const windowState = this.windows.get(windowId);
    if (!windowState) throw new Error(`Unknown window: ${windowId}`);
    if (
      (current && !this.windowDisplaysNote(windowId, current.noteId)) ||
      (!current && windowState.noteId !== null)
    ) {
      return { handled: false, detail: "jump:search:stale" };
    }
    if (!this.isLiveNote(result.noteId)) {
      return { handled: false, detail: "jump:search:missing-note" };
    }
    const destination: EditorNavigationDestination = result.blockId
      ? {
          kind: "search-match",
          noteId: result.noteId,
          blockId: result.blockId,
          sectionId: result.sectionId,
          sectionLineNumber: result.sectionLineNumber ?? 1,
          offset: result.matchOffset,
          query: result.query,
        }
      : {
          kind: "section-start",
          noteId: result.noteId,
          sectionId: result.sectionId,
        };
    return this.focusNavigationSection(
      windowId,
      result.noteId,
      result.sectionId,
      destination,
      "jump:search:changed",
      current ?? undefined,
    );
  }

  async navigateOutline(
    windowId: string,
    current: StableEditorPosition,
    noteId: string,
    targetSectionId: string,
  ): Promise<EditorNavigationResult> {
    const windowState = this.windows.get(windowId);
    if (!windowState) throw new Error(`Unknown window: ${windowId}`);
    if (!this.windowDisplaysNote(windowId, current.noteId)) {
      return { handled: false, detail: "jump:outline:stale" };
    }
    if (!this.isLiveNote(noteId)) {
      return { handled: false, detail: "jump:outline:missing-note" };
    }
    const destination: EditorNavigationDestination = {
      kind: "section-start",
      noteId,
      sectionId: targetSectionId,
    };
    const handle = await this.ensureNoteLoaded(noteId);
    if (handle.current.kind !== "note") {
      return { handled: false, detail: "jump:outline:missing-note" };
    }
    if (!findSectionById(handle.current.rootSection, targetSectionId)) {
      return { handled: false, detail: "jump:outline:missing-section" };
    }
    const focusedSectionId = windowState.focusedSectionId ?? noteId;
    const focusedSection = findSectionById(
      handle.current.rootSection,
      focusedSectionId,
    );
    if (focusedSection && findSectionById(focusedSection, targetSectionId)) {
      this.jumpListFor(windowId).recordOrigin(current);
      return {
        handled: true,
        detail: "jump:outline:changed",
        destination,
      };
    }
    // An Outline target outside the current Focused Section is not mounted.
    // Return to the full NoteDoc, then apply the title destination there;
    // selecting an Outline row must never behave like `zf` on that row.
    return this.focusNavigationSection(
      windowId,
      noteId,
      noteId,
      destination,
      "jump:outline:changed",
      current,
    );
  }

  async navigateFocusedSection(
    windowId: string,
    current: StableEditorPosition,
    noteId: string,
    targetSectionId: string,
  ): Promise<EditorNavigationResult> {
    if (!this.windows.has(windowId)) {
      throw new Error(`Unknown window: ${windowId}`);
    }
    if (!this.windowDisplaysNote(windowId, current.noteId)) {
      return { handled: false, detail: "jump:section-focus:stale" };
    }
    if (!this.isLiveNote(noteId)) {
      return { handled: false, detail: "jump:section-focus:missing-note" };
    }
    return this.focusNavigationSection(
      windowId,
      noteId,
      targetSectionId,
      { kind: "section-start", noteId, sectionId: targetSectionId },
      "jump:section-focus:changed",
      current,
    );
  }

  async navigateNoteOpen(
    windowId: string,
    current: StableEditorPosition,
    noteId: string,
  ): Promise<EditorNavigationResult> {
    const windowState = this.windows.get(windowId);
    if (!windowState) throw new Error(`Unknown window: ${windowId}`);
    if (!this.windowDisplaysNote(windowId, current.noteId)) {
      return { handled: false, detail: "jump:note-open:stale" };
    }
    if (!this.isLiveNote(noteId)) {
      return { handled: false, detail: "jump:note-open:missing-note" };
    }
    const requestedBuffer = createNoteBuffer(noteId);
    const applicationWindow = this.requireApplicationWindowState();
    if (
      noteId === windowState.noteId &&
      applicationWindow.windows[windowId]?.bufferId === requestedBuffer.id
    ) {
      return { handled: true, detail: "jump:note-open:unchanged" };
    }
    const jumpList = this.jumpListFor(windowId);
    return this.openNavigationDestination(
      windowId,
      { kind: "document-start", noteId },
      "jump:note-open:changed",
      () => jumpList.recordOrigin(current),
      undefined,
    );
  }

  repeatStoreFor(windowId: string): VimRepeatStore {
    if (!this.windows.has(windowId))
      throw new Error(`Unknown window: ${windowId}`);
    let repeatStore = this.repeatStores.get(windowId);
    if (!repeatStore) {
      repeatStore = new VimRepeatStore();
      this.repeatStores.set(windowId, repeatStore);
    }
    return repeatStore;
  }

  visualSelectionStoreFor(windowId: string): VimVisualSelectionStore {
    if (!this.windows.has(windowId))
      throw new Error(`Unknown window: ${windowId}`);
    let store = this.visualSelectionStores.get(windowId);
    if (!store) {
      store = new VimVisualSelectionStore();
      this.visualSelectionStores.set(windowId, store);
    }
    return store;
  }

  attachEditor(
    windowId: string,
    element: HTMLElement,
    options: Pick<
      TiptapEditorAdapterOptions,
      | "onVimSnapshot"
      | "onCaretSectionChange"
      | "onCaretExternalLinkChange"
      | "onInternalLinkCompletion"
      | "internalLinkPopupId"
      | "onWorkspaceSearch"
      | "onNoteSearch"
      | "onBlockTypePicker"
      | "onInlineFormatPicker"
      | "onTableActionPicker"
      | "onCommandLine"
      | "onCommandPicker"
      | "onApplicationCommand"
      | "onWindowCommand"
      | "onNavigationDestination"
      | "keyConfig"
      | "readPreferredClipboard"
      | "readExplicitClipboard"
      | "requestImeOff"
      | "openExternalLink"
      | "attachmentRepository"
      | "onMessage"
      | "directBodyOnly"
      | "scrollElement"
    > = {},
  ): TiptapEditorAdapter {
    const state = this.requireContentWindowState(windowId);
    const attachedNoteId = state.noteId;
    const handle = this.getNoteHandle(state.noteId);
    const adapter = new TiptapEditorAdapter(handle, element, {
      directBodyOnly: options.directBodyOnly,
      registerStore: this.vimRegister,
      repeatStore: this.repeatStoreFor(windowId),
      visualSelectionStore: this.visualSelectionStoreFor(windowId),
      getWindowState: () => this.requireContentWindowState(windowId),
      onSelectionUpdate: (editor, activeSectionId) => {
        const selection = editor.state.selection;
        this.persistWindowUpdate(
          windowId,
          {
            selection: {
              anchor:
                selection instanceof CellSelection
                  ? selection.$anchorCell.pos
                  : selection.anchor,
              head:
                selection instanceof CellSelection
                  ? selection.$headCell.pos
                  : selection.head,
            },
          },
          attachedNoteId,
          activeSectionId,
        );
      },
      onModeChange: (mode) =>
        this.persistWindowUpdate(windowId, { mode }, attachedNoteId),
      onScrollUpdate: (scrollTop) =>
        this.persistWindowUpdate(windowId, { scrollTop }, attachedNoteId),
      onVimSnapshot: options.onVimSnapshot,
      onCaretSectionChange: options.onCaretSectionChange,
      onCaretExternalLinkChange: options.onCaretExternalLinkChange,
      requestImeOff: options.requestImeOff,
      readPreferredClipboard: options.readPreferredClipboard,
      readExplicitClipboard: options.readExplicitClipboard,
      scrollElement: options.scrollElement,
      onNavigate: (request) => this.navigateEditor(windowId, request),
      onNavigationDestination: options.onNavigationDestination,
      onWorkspaceSearch: options.onWorkspaceSearch,
      onNoteSearch: options.onNoteSearch,
      onBlockTypePicker: options.onBlockTypePicker,
      onInlineFormatPicker: options.onInlineFormatPicker,
      onTableActionPicker: options.onTableActionPicker,
      openExternalLink: options.openExternalLink,
      attachmentRepository: options.attachmentRepository,
      onMessage: options.onMessage,
      onNoteSearchRepeat: (origin, direction, count) =>
        this.repeatNoteSearch(windowId, origin, direction, count),
      onCommandLine: options.onCommandLine,
      onCommandPicker: options.onCommandPicker,
      onApplicationCommand: options.onApplicationCommand,
      onWindowCommand: options.onWindowCommand,
      onSectionFocus: (direction, currentSectionId, origin) => {
        const note = handle.current;
        if (note.kind !== "note") return;
        const currentFocusedId =
          this.requireContentWindowState(windowId).focusedSectionId ??
          note.noteId;
        const target =
          direction === "current"
            ? findChildSectionToward(
                note.rootSection,
                currentFocusedId,
                currentSectionId,
              )
            : findParentSection(note.rootSection, currentFocusedId);
        if (!target) return;
        const targetId = sectionId(target);
        void this.focusNavigationSection(
          windowId,
          note.noteId,
          targetId,
          { kind: "stable", noteId: note.noteId, saved: origin },
          "jump:section-focus:changed",
          origin,
        ).then((result) => {
          if (!result.handled) this.reportError(new Error(result.detail));
        });
      },
      onSectionDepthShift: (request) =>
        this.shiftSectionDepth(
          attachedNoteId,
          request.boundarySectionId,
          [...request.sectionIds],
          request.direction,
        ),
      onSectionFromParagraph: (request) =>
        this.createSectionFromParagraph(attachedNoteId, {
          boundarySectionId: request.boundarySectionId,
          sourceSectionId: request.sourceSectionId,
          paragraphBlockId: request.paragraphBlockId,
          paragraphBodyIndex: request.paragraphBodyIndex,
          title: request.title,
          direction: request.direction,
        }),
      keyConfig: options.keyConfig,
      getInternalLinkCandidates: () => this.internalLinkCandidates(),
      resolveInternalLinkTitle: (targetSectionId) =>
        this.resolveInternalLinkTitle(targetSectionId),
      onInternalLinkCompletion: options.onInternalLinkCompletion,
      internalLinkPopupId: options.internalLinkPopupId,
    });
    this.applyPendingNavigation(windowId, adapter);
    return adapter;
  }

  editorForTesting(
    windowId: string,
    element: HTMLElement,
    options: Pick<
      TiptapEditorAdapterOptions,
      | "onCaretSectionChange"
      | "onCaretExternalLinkChange"
      | "onInternalLinkCompletion"
      | "internalLinkPopupId"
      | "onWorkspaceSearch"
      | "onNoteSearch"
      | "onBlockTypePicker"
      | "onInlineFormatPicker"
      | "onTableActionPicker"
      | "onCommandLine"
      | "onCommandPicker"
      | "onApplicationCommand"
      | "onWindowCommand"
      | "keyConfig"
      | "readPreferredClipboard"
      | "readExplicitClipboard"
      | "requestImeOff"
      | "openExternalLink"
      | "attachmentRepository"
      | "onMessage"
      | "directBodyOnly"
      | "scrollElement"
    > = {},
  ): { adapter: TiptapEditorAdapter; editor: Editor } {
    const adapter = this.attachEditor(windowId, element, {
      ...options,
      directBodyOnly: options.directBodyOnly ?? true,
    });
    return { adapter, editor: adapter.editor };
  }

  /**
   * Drains the canonical CRDT and local-window state without waiting for
   * rebuildable projections such as the workspace search index.
   *
   * Native shutdown uses this narrower durability barrier so a large pending
   * FTS projection cannot keep the application window alive after all source
   * data is already safe on disk.
   */
  async flushDurableState(): Promise<void> {
    this.flushPendingWindowViewUpdates();
    await Promise.all(
      [...this.notePersistence.values()].map((session) => session.flush()),
    );
    await this.localStateQueue;
    this.flushEditorPersistenceNotification();
    if (this.lastError) throw new Error(this.lastError);
  }

  async flush(): Promise<void> {
    await this.flushDurableState();
    await this.flushWorkspaceSearchIndexDocuments();
    await this.workspaceSearchIndexQueue;
    if (this.lastError) throw new Error(this.lastError);
  }

  destroy(): void {
    if (this.windowViewUpdateFrame !== null) {
      cancelAnimationFrame(this.windowViewUpdateFrame);
      this.windowViewUpdateFrame = null;
    }
    if (this.windowViewUpdateTimer !== null) {
      globalThis.clearTimeout(this.windowViewUpdateTimer);
      this.windowViewUpdateTimer = null;
    }
    if (this.editorPersistenceNotificationTimer !== null) {
      globalThis.clearTimeout(this.editorPersistenceNotificationTimer);
      this.editorPersistenceNotificationTimer = null;
    }
    this.pendingWindowViewUpdates.clear();
    this.inFlightWindowViewUpdates.clear();
    if (this.workspaceSearchIndexDocumentTimer !== null) {
      globalThis.clearTimeout(this.workspaceSearchIndexDocumentTimer);
      this.workspaceSearchIndexDocumentTimer = null;
    }
    this.pendingWorkspaceSearchIndexNoteIds.clear();
    this.pendingWorkspaceSearchIndexHierarchyNoteIds.clear();
    this.pendingWorkspaceSearchIndexHierarchyBaseRevision = null;
    this.workspaceSearchDirtyNoteIds.clear();
    this.workspaceSearchProjectionCache.clear();
    this.workspaceSearchFallbackCatalogCache = null;
    this.observedWorkspaceNotes?.unobserveDeep(
      this.handleWorkspaceMetadataChange,
    );
    this.observedWorkspaceNotes = null;
    this.unsubscribeWorkspaceReplacement?.();
    this.unsubscribeWorkspaceReplacement = null;
    for (const session of this.notePersistence.values()) session.destroy();
    for (const handle of this.notes.values()) handle.current.doc.destroy();
    this.workspace.current.doc.destroy();
    this.jumpLists.clear();
    this.pendingNavigations.clear();
    this.pendingSectionIdentityRepairs.clear();
    this.repeatStores.clear();
    this.visualSelectionStores.clear();
    this.noteSearchStates.clear();
    this.listeners.clear();
  }

  private async loadExistingState(): Promise<void> {
    const metadata = listNoteMetadata(this.workspaceDocument).filter(
      ({ deletedAt }) => !deletedAt,
    );
    const liveNoteIds = new Set(metadata.map(({ noteId }) => noteId));
    const persistedStates = await this.persistence.loadLocalStates();
    const restored = this.restoreApplicationWindowState(
      persistedStates,
      liveNoteIds,
    );
    if (restored.mustPersist) {
      await this.transactions.persistLocalStates(this.idFactory(), [
        toApplicationLocalStateCommit(restored.state),
      ]);
    }
    this.applicationWindowState = restored.state;
    this.syncActiveNoteFromApplicationWindow();
    const visibleNoteIds = new Set<string>();
    for (const window of Object.values(restored.state.windows)) {
      if (window.bufferId === null) continue;
      const noteId = this.contentBufferNoteId(
        restored.state.buffers[window.bufferId],
      );
      if (noteId && liveNoteIds.has(noteId)) visibleNoteIds.add(noteId);
    }
    await Promise.all(
      [...visibleNoteIds].map((noteId) => this.ensureNoteLoaded(noteId)),
    );
    await this.primeInternalLinkCandidates();
    this.queueWorkspaceSearchIndexStartupValidation();
  }

  private restoreApplicationWindowState(
    persistedStates: Awaited<ReturnType<PersistencePort["loadLocalStates"]>>,
    liveNoteIds: ReadonlySet<string>,
  ): { state: ApplicationWindowState; mustPersist: boolean } {
    const applicationRecord = persistedStates.find(
      ({ windowId }) => windowId === APPLICATION_WINDOW_LOCAL_STATE_ID,
    );
    let state: ApplicationWindowState;
    let mustPersist = false;

    if (applicationRecord) {
      try {
        const migrated = migrateApplicationWindowState(applicationRecord.state);
        validateApplicationWindowState(migrated.state);
        state = structuredClone(migrated.state);
        mustPersist = migrated.changed;
      } catch (error) {
        this.reportRecoverableLocalStateError(error);
        state = this.createSafeApplicationWindowState();
        mustPersist = true;
      }
    } else {
      const legacyStates: WindowViewState[] = [];
      for (const persisted of persistedStates) {
        try {
          validateWindowViewState(persisted.state);
          if (persisted.windowId !== persisted.state.windowId) {
            throw new Error(
              `Legacy Window key does not match its id: ${persisted.windowId}`,
            );
          }
          if (liveNoteIds.has(persisted.state.noteId)) {
            legacyStates.push(structuredClone(persisted.state));
          }
        } catch (error) {
          this.reportRecoverableLocalStateError(error);
        }
      }
      state =
        legacyStates.length > 0
          ? migrateLegacyWindowStates({
              applicationWindowId: DEFAULT_APPLICATION_WINDOW_ID,
              tabId: DEFAULT_TAB_ID,
              windows: legacyStates,
            })
          : this.createSafeApplicationWindowState();
      mustPersist = true;
    }

    const repaired = this.repairApplicationWindowState(state, liveNoteIds);
    return {
      state: repaired.state,
      mustPersist: mustPersist || repaired.changed,
    };
  }

  private repairApplicationWindowState(
    state: ApplicationWindowState,
    liveNoteIds: ReadonlySet<string>,
  ): { state: ApplicationWindowState; changed: boolean } {
    let next = structuredClone(state);
    let changed = false;
    for (const windowId of Object.keys(next.windows)) {
      const bufferId = next.windows[windowId].bufferId;
      if (bufferId === null) continue;
      const buffer = next.buffers[bufferId];
      if (!this.isRuntimeDisplayableBuffer(buffer, liveNoteIds)) {
        next = closeBuffer(next, bufferId);
        changed = true;
      }
    }
    const usedBufferIds = new Set(
      Object.values(next.windows)
        .map(({ bufferId }) => bufferId)
        .filter((bufferId): bufferId is string => bufferId !== null),
    );
    for (const [bufferId, buffer] of Object.entries(next.buffers)) {
      if (
        !usedBufferIds.has(bufferId) &&
        !this.isLiveContentBuffer(buffer, liveNoteIds)
      ) {
        delete next.buffers[bufferId];
        changed = true;
      }
    }
    for (const tab of next.tabs) {
      const tree = tab.leftSidebar.tree;
      if (tree.selectedNoteId && !liveNoteIds.has(tree.selectedNoteId)) {
        tree.selectedNoteId = null;
        changed = true;
      }
      const collapsedNoteIds = tree.collapsedNoteIds.filter((noteId) =>
        liveNoteIds.has(noteId),
      );
      if (collapsedNoteIds.length !== tree.collapsedNoteIds.length) {
        tree.collapsedNoteIds = collapsedNoteIds;
        changed = true;
      }
      const outline = tab.rightSidebar.outline;
      if (outline.noteId && !liveNoteIds.has(outline.noteId)) {
        outline.noteId = null;
        outline.selectedSectionId = null;
        changed = true;
      }
    }
    validateApplicationWindowState(next);
    return { state: next, changed };
  }

  private registerCommands(): void {
    this.commands.register("note.create_root", (envelope) =>
      this.createNewNote({
        ...envelope.payload,
        operationId: envelope.operationId,
        title: "",
        parentNoteId: null,
        afterNoteId: null,
      }),
    );

    this.commands.register("note.create_child", (envelope) =>
      this.createNewNote({
        ...envelope.payload,
        operationId: envelope.operationId,
        title: "",
        afterNoteId: null,
      }),
    );

    this.commands.register("note.create_sibling_after", (envelope) => {
      const sibling = this.requireLiveMetadata(envelope.payload.siblingNoteId);
      return this.createNewNote({
        noteId: envelope.payload.noteId,
        title: "",
        createdAt: envelope.payload.createdAt,
        parentNoteId: sibling.parentNoteId,
        afterNoteId: sibling.noteId,
        windowId: envelope.payload.windowId,
        fault: envelope.payload.fault,
        operationId: envelope.operationId,
      });
    });

    this.commands.register("note.create", (envelope) => {
      const after = envelope.payload.afterNoteId
        ? this.requireLiveMetadata(envelope.payload.afterNoteId)
        : null;
      return this.createNewNote({
        ...envelope.payload,
        parentNoteId:
          envelope.payload.parentNoteId !== undefined
            ? envelope.payload.parentNoteId
            : (after?.parentNoteId ?? null),
        operationId: envelope.operationId,
      });
    });

    this.commands.register("note.open", (envelope) =>
      this.openNoteInWindow(envelope),
    );

    this.commands.register("note.open_help", (envelope) =>
      this.synchronizeHelpNote(envelope),
    );

    this.commands.register("note.rename", async (envelope) => {
      const { noteId, title, updatedAt, fault } = envelope.payload;
      this.requireLiveMetadata(noteId);
      const note = await this.ensureNoteLoaded(noteId);
      const workspaceBaseRevision = this.workspace.revision;
      this.setSaving();
      try {
        await this.transactions.transact(
          {
            operationId: envelope.operationId,
            scope: "workspace-structure",
            documents: [this.workspace, note],
            fault,
          },
          () => {
            if (note.current.kind !== "note") {
              throw new Error("note.rename target is not a NoteDoc");
            }
            renameRootSection(
              note.current,
              title,
              updatedAt,
              CORE_TRANSACTION_ORIGIN,
            );
            renameNoteMetadata(
              this.workspaceDocument,
              noteId,
              title,
              updatedAt,
              CORE_TRANSACTION_ORIGIN,
            );
          },
        );
        this.queueWorkspaceSearchIndexHierarchyUpdate(
          workspaceBaseRevision,
          noteId,
        );
        this.sectionCatalogRevision += 1;
        this.internalLinkLabelRevision += 1;
        this.queueWorkspaceSearchIndexDocument(noteId);
        this.setReady();
        return { noteId };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("note.reorder", (envelope) => {
      const request = treeMoveRequestForDirection(
        listNoteMetadata(this.workspaceDocument),
        envelope.payload.noteId,
        envelope.payload.direction,
      );
      return request
        ? this.moveExistingNote({
            ...envelope.payload,
            ...request,
            operationId: envelope.operationId,
          })
        : Promise.resolve({
            noteId: envelope.payload.noteId,
            changed: false,
          });
    });

    this.commands.register("note.move", (envelope) =>
      this.moveExistingNote({
        ...envelope.payload,
        operationId: envelope.operationId,
      }),
    );

    this.commands.register("section.update_properties", async (envelope) => {
      const {
        noteId,
        sectionId: targetId,
        properties,
        updatedAt,
        fault,
      } = envelope.payload;
      const handle = await this.ensureNoteLoaded(noteId);
      this.setSaving();
      try {
        await this.transactions.transact(
          {
            operationId: envelope.operationId,
            scope: "note-doc",
            documents: [handle],
            fault,
          },
          () => {
            if (handle.current.kind !== "note") {
              throw new Error("Section properties target is not a NoteDoc");
            }
            setSectionProperties(
              handle.current,
              targetId,
              properties,
              updatedAt,
              CORE_TRANSACTION_ORIGIN,
            );
          },
        );
        this.queueWorkspaceSearchIndexDocument(noteId);
        this.setReady();
        return { noteId, sectionId: targetId };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("section.shift_depth", async (envelope) => {
      const {
        noteId,
        boundarySectionId,
        sectionIds,
        direction,
        updatedAt,
        fault,
      } = envelope.payload;
      this.requireLiveMetadata(noteId);
      const handle = await this.ensureNoteLoaded(noteId);
      return this.runWithNotePersistenceLock(noteId, async () => {
        if (handle.current.kind !== "note") {
          throw new Error("Section depth target is not a NoteDoc");
        }
        const plan = planNoteSectionDepthShift(
          handle.current,
          boundarySectionId,
          sectionIds,
          direction,
        );
        if (!plan.changed) {
          return { noteId, changed: false, affectedSectionIds: [] };
        }
        this.setSaving();
        handle.current.undoManager.stopCapturing();
        const workspaceBaseRevision = this.workspace.revision;
        try {
          await this.transactions.transact(
            {
              operationId: envelope.operationId,
              scope: "workspace-structure",
              documents: [this.workspace, handle],
              searchIndexMetadataOnlyNoteId: noteId,
              fault,
            },
            () => {
              if (handle.current.kind !== "note") {
                throw new Error("Section depth target is not a NoteDoc");
              }
              applyNoteSectionDepthShift(
                handle.current,
                boundarySectionId,
                plan,
                updatedAt,
                SECTION_DEPTH_SHIFT_ORIGIN,
              );
              handle.current.undoManager.stopCapturing();
              renameNoteMetadata(
                this.workspaceDocument,
                noteId,
                readNoteTitle(handle.current),
                updatedAt,
                CORE_TRANSACTION_ORIGIN,
              );
            },
          );
          await this.advanceWorkspaceSearchIndexMetadataRevision({
            schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
            workspaceId: this.workspaceDocument.workspaceId,
            baseRevision: workspaceBaseRevision,
            workspaceRevision: this.workspace.revision,
            noteId,
          });
          if (handle.current.kind === "note") {
            handle.current.undoManager.stopCapturing();
          }
          this.changedNoteRevisions.set(noteId, handle.revision);
          this.noteContentRevision += 1;
          this.sectionCatalogRevision += 1;
          this.internalLinkLabelRevision += 1;
          this.queueWorkspaceSearchIndexDocument(noteId);
          this.setReady();
          return {
            noteId,
            changed: true,
            affectedSectionIds: [...plan.affectedSectionIds],
          };
        } catch (error) {
          this.reportError(error);
          throw error;
        }
      });
    });

    this.commands.register(
      "section.create_from_paragraph",
      async (envelope) => {
        const { noteId, updatedAt, fault, ...request } = envelope.payload;
        this.requireLiveMetadata(noteId);
        const handle = await this.ensureNoteLoaded(noteId);
        return this.runWithNotePersistenceLock(noteId, async () => {
          if (handle.current.kind !== "note") {
            throw new Error("Paragraph conversion target is not a NoteDoc");
          }
          this.setSaving();
          handle.current.undoManager.stopCapturing();
          const workspaceBaseRevision = this.workspace.revision;
          let result = {
            changed: false,
            createdSectionId: null as string | null,
          };
          try {
            await this.transactions.transact(
              {
                operationId: envelope.operationId,
                scope: "workspace-structure",
                documents: [this.workspace, handle],
                searchIndexMetadataOnlyNoteId: noteId,
                fault,
              },
              () => {
                if (handle.current.kind !== "note") {
                  throw new Error(
                    "Paragraph conversion target is not a NoteDoc",
                  );
                }
                result = createNoteSectionFromParagraph(
                  handle.current,
                  { ...request, updatedAt },
                  SECTION_PARAGRAPH_CONVERSION_ORIGIN,
                );
                handle.current.undoManager.stopCapturing();
                if (result.changed) {
                  renameNoteMetadata(
                    this.workspaceDocument,
                    noteId,
                    readNoteTitle(handle.current),
                    updatedAt,
                    CORE_TRANSACTION_ORIGIN,
                  );
                }
              },
            );
            handle.current.undoManager.stopCapturing();
            if (!result.changed) {
              this.setReady();
              return { noteId, ...result };
            }
            await this.advanceWorkspaceSearchIndexMetadataRevision({
              schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
              workspaceId: this.workspaceDocument.workspaceId,
              baseRevision: workspaceBaseRevision,
              workspaceRevision: this.workspace.revision,
              noteId,
            });
            this.changedNoteRevisions.set(noteId, handle.revision);
            this.noteContentRevision += 1;
            this.sectionCatalogRevision += 1;
            this.internalLinkLabelRevision += 1;
            this.queueWorkspaceSearchIndexDocument(noteId);
            this.setReady();
            return { noteId, ...result };
          } catch (error) {
            this.reportError(error);
            throw error;
          }
        });
      },
    );

    this.commands.register("note.move_to_trash", async (envelope) => {
      const { noteId, deletedAt, fault } = envelope.payload;
      await this.localStateQueue.catch(() => undefined);
      const metadata = listNoteMetadata(this.workspaceDocument);
      const plan = planNoteTrash(metadata, noteId);
      const trashed = new Set(plan.noteIds);
      const fallbackNoteId = plan.fallbackNoteId;
      if (fallbackNoteId) await this.ensureNoteLoaded(fallbackNoteId);
      let nextApplicationState = this.requireApplicationWindowState();
      const changedWindowIds = [...this.windows.values()]
        .filter((state) => state.noteId !== null && trashed.has(state.noteId))
        .map(({ windowId }) => windowId);
      if (fallbackNoteId) {
        for (const windowId of changedWindowIds) {
          nextApplicationState = openBufferInWindow(
            nextApplicationState,
            windowId,
            createNoteBuffer(fallbackNoteId),
            { mode: "normal", activate: false },
          );
        }
      }
      for (const [bufferId, buffer] of Object.entries(
        nextApplicationState.buffers,
      )) {
        const bufferedNoteId = this.contentBufferNoteId(buffer);
        if (bufferedNoteId && trashed.has(bufferedNoteId)) {
          nextApplicationState = closeBuffer(nextApplicationState, bufferId);
        }
      }
      nextApplicationState = removeNotesFromSidebarViews(
        nextApplicationState,
        trashed,
        fallbackNoteId,
      );
      this.setSaving();
      try {
        await this.transactions.transact(
          {
            operationId: envelope.operationId,
            scope: "workspace-structure",
            documents: [this.workspace],
            localStates: [toApplicationLocalStateCommit(nextApplicationState)],
            fault,
          },
          () =>
            moveNotesToTrash(
              this.workspaceDocument,
              plan.noteIds,
              deletedAt,
              envelope.operationId,
              CORE_TRANSACTION_ORIGIN,
            ),
        );
        this.applicationWindowState = nextApplicationState;
        this.syncActiveNoteFromApplicationWindow();
        for (const [windowId, pending] of this.pendingNavigations) {
          if (
            trashed.has(pending.destination.noteId) ||
            changedWindowIds.includes(windowId)
          ) {
            this.pendingNavigations.delete(windowId);
          }
        }
        this.queueWorkspaceSearchIndexRebuild();
        this.sectionCatalogRevision += 1;
        this.setReady();
        return {
          noteId,
          trashedNoteIds: [...plan.noteIds],
          fallbackNoteId,
        };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("note.restore_from_trash", async (envelope) => {
      const { noteId, restoredAt, fault } = envelope.payload;
      const metadata = readNoteMetadata(this.workspaceDocument, noteId);
      if (!metadata?.deletedAt)
        throw new Error(`Note is not in Trash: ${noteId}`);
      const restoredNoteIds = planTrashRestore(
        listNoteMetadata(this.workspaceDocument),
        noteId,
      );
      this.setSaving();
      try {
        await this.transactions.transact(
          {
            operationId: envelope.operationId,
            scope: "workspace-structure",
            documents: [this.workspace],
            fault,
          },
          () =>
            restoreNotesFromTrash(
              this.workspaceDocument,
              restoredNoteIds,
              restoredAt,
              CORE_TRANSACTION_ORIGIN,
            ),
        );
        this.queueWorkspaceSearchIndexRebuild();
        this.sectionCatalogRevision += 1;
        this.setReady();
        return { noteId, restoredNoteIds };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("note.replace_text", async (envelope) => {
      const handle = this.getNoteHandle(envelope.payload.noteId);
      this.setSaving();
      try {
        await this.transactions.transact(
          {
            operationId: envelope.operationId,
            scope: "note-doc",
            documents: [handle],
            fault: envelope.payload.fault,
          },
          () => {
            if (handle.current.kind !== "note") {
              throw new Error("note.replace_text target is not a NoteDoc");
            }
            replaceFirstTextBlock(
              handle.current,
              envelope.payload.text,
              CORE_TRANSACTION_ORIGIN,
            );
          },
        );
        this.changedNoteRevisions.set(envelope.payload.noteId, handle.revision);
        this.noteContentRevision += 1;
        this.queueWorkspaceSearchIndexDocument(envelope.payload.noteId);
        this.setReady();
        return { noteId: envelope.payload.noteId };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("note.commit_editor_update", async (envelope) => {
      const handle = this.getNoteHandle(envelope.payload.noteId);
      const cachedTitle = this.requireLiveMetadata(
        envelope.payload.noteId,
      ).title;
      const currentTitle =
        handle.current.kind === "note" ? readNoteTitle(handle.current) : "";
      const titleChanged = cachedTitle !== currentTitle;
      this.setEditorPersistenceStatus("saving");
      try {
        const updatedAt = this.clock();
        const workspaceBaseRevision = this.workspace.revision;
        const response = await this.transactions.commitAppliedUpdateTransaction(
          handle,
          [this.workspace],
          envelope.operationId,
          envelope.payload.update,
          () => {
            if (handle.current.kind !== "note") {
              throw new Error("Editor update target is not a NoteDoc");
            }
            renameNoteMetadata(
              this.workspaceDocument,
              envelope.payload.noteId,
              readNoteTitle(handle.current),
              updatedAt,
              CORE_TRANSACTION_ORIGIN,
            );
          },
          titleChanged ? undefined : envelope.payload.noteId,
        );
        if (titleChanged) {
          this.queueWorkspaceSearchIndexHierarchyUpdate(
            workspaceBaseRevision,
            envelope.payload.noteId,
          );
        } else {
          await this.advanceWorkspaceSearchIndexMetadataRevision({
            schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
            workspaceId: this.workspaceDocument.workspaceId,
            baseRevision: workspaceBaseRevision,
            workspaceRevision: this.workspace.revision,
            noteId: envelope.payload.noteId,
          });
        }
        this.changedNoteRevisions.set(envelope.payload.noteId, handle.revision);
        this.noteContentRevision += 1;
        if (envelope.payload.sectionCatalogChanged) {
          this.sectionCatalogRevision += 1;
          this.internalLinkLabelRevision += 1;
        }
        this.queueWorkspaceSearchIndexDocument(envelope.payload.noteId);
        this.setEditorPersistenceStatus("ready");
        return {
          noteId: envelope.payload.noteId,
          revision: response.documents[0]?.revision ?? handle.revision,
        };
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    });

    this.commands.register("note.repair_section_identity", async (envelope) => {
      if (envelope.source !== "internal") {
        throw new Error(
          "note.repair_section_identity is restricted to internal recovery",
        );
      }
      const pending = this.pendingSectionIdentityRepairs.get(
        envelope.operationId,
      );
      if (
        !pending ||
        pending.handle.current.id !== envelope.payload.noteId ||
        pending.repair.update !== envelope.payload.update ||
        pending.repair.repairedSectionIds.length !==
          envelope.payload.repairedSectionIds.length ||
        pending.repair.repairedSectionIds.some(
          (sectionId, index) =>
            sectionId !== envelope.payload.repairedSectionIds[index],
        ) ||
        pending.repair.repairedBlockIds.length !==
          envelope.payload.repairedBlockIds.length ||
        pending.repair.repairedBlockIds.some(
          (blockId, index) =>
            blockId !== envelope.payload.repairedBlockIds[index],
        )
      ) {
        throw new Error("Section identity repair was not prepared by Core");
      }
      const response = await this.transactions.commitAppliedRecoveryUpdate(
        pending.handle,
        envelope.operationId,
        envelope.payload.update,
      );
      return {
        noteId: envelope.payload.noteId,
        revision: response.documents[0]?.revision ?? pending.handle.revision,
        repairedSectionIds: [...envelope.payload.repairedSectionIds],
        repairedBlockIds: [...envelope.payload.repairedBlockIds],
      };
    });

    this.commands.register("note.migrate_schema", async (envelope) => {
      if (envelope.source !== "internal") {
        throw new Error(
          "note.migrate_schema is restricted to internal recovery",
        );
      }
      const pending = this.pendingSectionIdentityRepairs.get(
        envelope.operationId,
      );
      if (
        !pending ||
        pending.handle.current.id !== envelope.payload.noteId ||
        pending.repair.update !== envelope.payload.update ||
        pending.repair.migratedFromSchemaVersion !==
          envelope.payload.fromVersion ||
        envelope.payload.toVersion !== 3
      ) {
        throw new Error("Note schema migration was not prepared by Core");
      }
      const response = await this.transactions.commitAppliedRecoveryUpdate(
        pending.handle,
        envelope.operationId,
        envelope.payload.update,
      );
      return {
        noteId: envelope.payload.noteId,
        revision: response.documents[0]?.revision ?? pending.handle.revision,
        fromVersion: envelope.payload.fromVersion,
        toVersion: envelope.payload.toVersion,
      };
    });

    this.commands.register("note.compact_snapshot", async (envelope) => {
      const handle = this.getNoteHandle(envelope.payload.noteId);
      const response = await this.transactions.compactSnapshot(
        handle,
        envelope.operationId,
        envelope.payload.expectedRevision,
        envelope.payload.fault,
      );
      return {
        noteId: envelope.payload.noteId,
        revision: response.documents[0]?.revision ?? handle.revision,
      };
    });

    this.commands.register("window.split", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = splitWindow(current, envelope.payload);
          return {
            state: next,
            changed: true,
            result: {
              windowId: envelope.payload.newWindowId,
              splitId: envelope.payload.splitId,
            },
          };
        },
      ),
    );

    this.commands.register("window.focus", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const tab = current.tabs.find((candidate) =>
            listTabWindowIds(current, candidate.id).includes(
              envelope.payload.windowId,
            ),
          );
          if (!tab) {
            throw new Error(`Unknown window: ${envelope.payload.windowId}`);
          }
          const changed =
            current.activeTabId !== tab.id ||
            tab.activeWindowId !== envelope.payload.windowId ||
            current.focusOwner.area !== "window" ||
            current.focusOwner.windowId !== envelope.payload.windowId;
          return {
            state: changed
              ? focusWindow(current, envelope.payload.windowId)
              : current,
            changed,
            result: {
              windowId: envelope.payload.windowId,
              changed,
            },
          };
        },
      ),
    );

    this.commands.register("window.focus_direction", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const targetWindowId = windowInDirection(
            current,
            envelope.payload.windowId,
            envelope.payload.direction,
          );
          const changed = targetWindowId !== null;
          return {
            state: changed
              ? focusWindowInDirection(
                  current,
                  envelope.payload.windowId,
                  envelope.payload.direction,
                )
              : current,
            changed,
            result: {
              windowId: targetWindowId ?? envelope.payload.windowId,
              changed,
            },
          };
        },
      ),
    );

    this.commands.register("window.close", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = closeWindow(current, envelope.payload.windowId);
          return {
            state: next,
            changed: true,
            result: {
              windowId: envelope.payload.windowId,
              activeWindowId: activeEditorWindow(next).id,
            },
          };
        },
      ),
    );

    this.commands.register("window.only", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = keepOnlyWindow(current, envelope.payload.windowId);
          const closedWindowIds = Object.keys(current.windows)
            .filter((windowId) => !next.windows[windowId])
            .sort((left, right) => left.localeCompare(right));
          return {
            state: next,
            changed: next !== current,
            result: {
              windowId: envelope.payload.windowId,
              closedWindowIds,
              changed: next !== current,
            },
          };
        },
      ),
    );

    this.commands.register("tab.create", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = createTabPage(current, {
            tabId: envelope.payload.tabId,
            windowId: envelope.payload.windowId,
            bufferId: null,
          });
          return {
            state: next,
            changed: true,
            result: {
              tabId: envelope.payload.tabId,
              windowId: envelope.payload.windowId,
            },
          };
        },
      ),
    );

    this.commands.register("tab.switch", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const tab = current.tabs.find(
            (candidate) => candidate.id === envelope.payload.tabId,
          );
          if (!tab) {
            throw new Error(`Unknown tab page: ${envelope.payload.tabId}`);
          }
          const changed =
            current.activeTabId !== tab.id ||
            current.focusOwner.area !== "window" ||
            current.focusOwner.windowId !== tab.activeWindowId;
          return {
            state: changed ? switchTabPage(current, tab.id) : current,
            changed,
            result: {
              tabId: tab.id,
              windowId: tab.activeWindowId,
              changed,
            },
          };
        },
      ),
    );

    this.commands.register("tab.cycle", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const tabId = adjacentTabPageId(current, envelope.payload.direction);
          const tab = current.tabs.find((candidate) => candidate.id === tabId)!;
          const changed =
            tabId !== current.activeTabId ||
            current.focusOwner.area !== "window" ||
            current.focusOwner.windowId !== tab.activeWindowId;
          return {
            state: changed ? switchTabPage(current, tabId) : current,
            changed,
            result: { tabId, windowId: tab.activeWindowId, changed },
          };
        },
      ),
    );

    this.commands.register("tab.close", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = closeTabPage(current, envelope.payload.tabId);
          const active = activeEditorWindow(next);
          return {
            state: next,
            changed: true,
            result: {
              tabId: envelope.payload.tabId,
              activeTabId: next.activeTabId,
              activeWindowId: active.id,
            },
          };
        },
      ),
    );

    this.commands.register("buffer.close", async (envelope) => {
      let result: CoreCommandResults["buffer.close"] | undefined;
      this.localStateQueue = this.localStateQueue
        .catch(() => undefined)
        .then(async () => {
          const current = this.requireApplicationWindowState();
          const buffer = current.buffers[envelope.payload.bufferId];
          if (!buffer) {
            throw new Error(`Unknown buffer: ${envelope.payload.bufferId}`);
          }
          const emptiedWindowIds = Object.values(current.windows)
            .filter((window) => window.bufferId === envelope.payload.bufferId)
            .map(({ id }) => id)
            .sort();
          const next = closeBuffer(current, envelope.payload.bufferId);
          const noteId = this.contentBufferNoteId(buffer);
          if (noteId && this.noteLoads.has(noteId)) {
            throw new Error(`Cannot close a buffer while loading: ${noteId}`);
          }
          this.setSaving();
          try {
            if (noteId) await this.notePersistence.get(noteId)?.flush();
            await this.transactions.persistLocalStates(
              envelope.operationId,
              [toApplicationLocalStateCommit(next)],
              envelope.payload.fault,
            );
            this.applicationWindowState = next;
            for (const windowId of emptiedWindowIds) {
              this.pendingNavigations.delete(windowId);
            }
            this.syncActiveNoteFromApplicationWindow();
            result = {
              bufferId: envelope.payload.bufferId,
              noteId,
              emptiedWindowIds,
              releasedNoteDoc: false,
            };
            this.setReady();
          } catch (error) {
            this.reportError(error);
            throw error;
          }
        });
      await this.localStateQueue;
      if (!result) throw new Error("Buffer close returned no result");
      return result;
    });

    this.commands.register("sidebar.update", (envelope) =>
      this.commitApplicationWindowMutation(
        envelope.operationId,
        envelope.payload.fault,
        (current) => {
          const next = updateApplicationSidebar(current, envelope.payload);
          const currentTab = activeTab(current);
          const nextTab = activeTab(next);
          const before =
            envelope.payload.side === "left"
              ? currentTab.leftSidebar
              : currentTab.rightSidebar;
          const after =
            envelope.payload.side === "left"
              ? nextTab.leftSidebar
              : nextTab.rightSidebar;
          const changed =
            JSON.stringify(before) !== JSON.stringify(after) ||
            !sameApplicationFocusOwner(current.focusOwner, next.focusOwner);
          return {
            state: changed ? next : current,
            changed,
            result: {
              side: envelope.payload.side,
              visible: after.visible,
              utility: after.utility,
              focusOwner: structuredClone(next.focusOwner),
              changed,
            },
          };
        },
      ),
    );

    this.commands.register("window.update_view", async (envelope) => {
      await this.localStateQueue.catch(() => undefined);
      const previous = this.windows.get(envelope.payload.windowId);
      if (!previous) {
        throw new Error(`Unknown window: ${envelope.payload.windowId}`);
      }
      if (
        envelope.payload.noteId &&
        envelope.payload.noteId !== previous.noteId
      ) {
        return { windowId: previous.windowId };
      }
      const previousApplicationState = this.requireApplicationWindowState();
      let next = updateWindowView(
        previousApplicationState,
        envelope.payload.windowId,
        envelope.payload.update,
      );
      let outlineChanged = false;
      const activeSectionId = envelope.payload.activeSectionId;
      const activeWindowTab = activeTab(next);
      if (
        activeSectionId &&
        previous.noteId &&
        activeWindowTab.activeWindowId === envelope.payload.windowId
      ) {
        const before = activeWindowTab.rightSidebar.outline;
        outlineChanged =
          before.noteId !== previous.noteId ||
          before.selectedSectionId !== activeSectionId;
        if (outlineChanged) {
          next = updateApplicationSidebar(next, {
            side: "right",
            outline: {
              noteId: previous.noteId,
              selectedSectionId: activeSectionId,
            },
          });
        }
      }
      this.applicationWindowState = next;
      if (outlineChanged) this.emit();
      this.localStateQueue = this.localStateQueue
        .catch(() => undefined)
        .then(async () => {
          const setStatus = (status: "saving" | "ready"): void => {
            if (envelope.source === "editor") {
              this.setEditorPersistenceStatus(status);
            } else if (status === "saving") {
              this.setSaving();
            } else {
              this.setReady();
            }
          };
          setStatus("saving");
          try {
            await this.transactions.persistLocalStates(
              envelope.operationId,
              [toApplicationLocalStateCommit(next)],
              envelope.payload.fault,
            );
            setStatus("ready");
          } catch (error) {
            if (this.applicationWindowState === next) {
              this.applicationWindowState = previousApplicationState;
            }
            this.reportError(error);
            throw error;
          }
        });
      await this.localStateQueue;
      return { windowId: previous.windowId };
    });

    this.commands.register("window.focus_section", async (envelope) => {
      const {
        windowId,
        noteId,
        sectionId: targetId,
        selection,
        fault,
      } = envelope.payload;
      const handle = await this.ensureNoteLoaded(noteId);
      if (
        handle.current.kind !== "note" ||
        !findSectionById(handle.current.rootSection, targetId)
      ) {
        throw new Error(`Unknown Section: ${targetId}`);
      }
      return this.commitApplicationWindowMutation(
        envelope.operationId,
        fault,
        (current) => {
          const initialWindow = current.windows[windowId];
          const initialBuffer =
            initialWindow?.bufferId === null ||
            initialWindow?.bufferId === undefined
              ? null
              : current.buffers[initialWindow.bufferId];
          const opened =
            initialBuffer?.kind === "note" && initialBuffer.noteId === noteId
              ? current
              : openBufferInWindow(current, windowId, createNoteBuffer(noteId));
          const window = opened.windows[windowId];
          const effectiveCurrent = window.view.focusedSectionId ?? noteId;
          const changed =
            opened !== current ||
            effectiveCurrent !== targetId ||
            selection !== undefined;
          if (!changed) {
            return {
              state: current,
              changed: false,
              result: { windowId, sectionId: targetId },
            };
          }
          const next = structuredClone(opened);
          next.windows[windowId].view.focusedSectionId =
            targetId === noteId ? null : targetId;
          next.windows[windowId].view.selection = selection ?? null;
          next.windows[windowId].view.scrollTop = 0;
          return {
            state: next,
            changed: true,
            result: { windowId, sectionId: targetId },
          };
        },
      );
    });
  }

  private async commitApplicationWindowMutation<Result>(
    operationId: string,
    fault: CommitFault | undefined,
    planner: (state: ApplicationWindowState) => {
      state: ApplicationWindowState;
      changed: boolean;
      result: Result;
    },
  ): Promise<Result> {
    let result: Result | undefined;
    this.localStateQueue = this.localStateQueue
      .catch(() => undefined)
      .then(async () => {
        const previous = this.requireApplicationWindowState();
        const planned = planner(previous);
        validateApplicationWindowState(planned.state);
        result = planned.result;
        if (!planned.changed) return;
        this.setSaving();
        try {
          await this.transactions.persistLocalStates(
            operationId,
            [toApplicationLocalStateCommit(planned.state)],
            fault,
          );
          this.applicationWindowState = planned.state;
          this.cleanupClosedWindows(previous, planned.state);
          this.syncActiveNoteFromApplicationWindow();
          this.setReady();
        } catch (error) {
          this.reportError(error);
          throw error;
        }
      });
    await this.localStateQueue;
    if (result === undefined) {
      throw new Error("Application Window mutation returned no result");
    }
    return result;
  }

  private cleanupClosedWindows(
    previous: ApplicationWindowState,
    next: ApplicationWindowState,
  ): void {
    for (const windowId of Object.keys(previous.windows)) {
      if (next.windows[windowId]) continue;
      this.jumpLists.delete(windowId);
      this.pendingNavigations.delete(windowId);
      this.repeatStores.delete(windowId);
      this.visualSelectionStores.delete(windowId);
      this.noteSearchStates.delete(windowId);
    }
  }

  private async openNoteInWindow(
    envelope: CoreCommandEnvelope<"note.open">,
  ): Promise<{ noteId: string; windowId: string }> {
    const { noteId, windowId, fault } = envelope.payload;
    this.requireLiveMetadata(noteId);
    await this.ensureNoteLoaded(noteId);
    await this.localStateQueue.catch(() => undefined);
    const current = this.requireApplicationWindowState();
    if (!current.windows[windowId]) {
      throw new Error(`Unknown window: ${windowId}`);
    }
    const next = openBufferInWindow(
      current,
      windowId,
      createNoteBuffer(noteId),
      {
        mode: "normal",
      },
    );
    this.localStateQueue = this.localStateQueue
      .catch(() => undefined)
      .then(async () => {
        this.setSaving();
        try {
          await this.transactions.persistLocalStates(
            envelope.operationId,
            [toApplicationLocalStateCommit(next)],
            fault,
          );
          this.applicationWindowState = next;
          const pending = this.pendingNavigations.get(windowId);
          if (pending && pending.destination.noteId !== noteId) {
            this.pendingNavigations.delete(windowId);
          }
          this.syncActiveNoteFromApplicationWindow();
          this.setReady();
        } catch (error) {
          this.reportError(error);
          throw error;
        }
      });
    await this.localStateQueue;
    return { noteId, windowId };
  }

  private async synchronizeHelpNote(
    envelope: CoreCommandEnvelope<"note.open_help">,
  ): Promise<CoreCommandResults["note.open_help"]> {
    const { windowId, newNoteId, synchronizedAt, fault } = envelope.payload;
    await this.localStateQueue.catch(() => undefined);
    const currentApplicationState = this.requireApplicationWindowState();
    if (!currentApplicationState.windows[windowId]) {
      throw new Error(`Unknown window: ${windowId}`);
    }

    const metadata = listNoteMetadata(this.workspaceDocument);
    const managedNotes = metadata.filter(
      ({ systemRole }) => systemRole === "help",
    );
    if (managedNotes.length > 1) {
      throw new Error(`管理Helpノートが複数あります: ${managedNotes.length}件`);
    }
    const existingMetadata = managedNotes[0] ?? null;
    const created = existingMetadata === null;
    const noteId = existingMetadata?.noteId ?? newNoteId;
    if (
      created &&
      (this.notes.has(noteId) || this.workspaceDocument.notes.has(noteId))
    ) {
      throw new Error(`Duplicate note: ${noteId}`);
    }

    const prepared = created
      ? {
          handle: new ManagedCrdtDocument<ProductDocument>(
            createNoteDocument(noteId, undefined, MEMOKA_HELP_TITLE, {
              createdAt: synchronizedAt,
              updatedAt: synchronizedAt,
            }),
            0,
          ),
          attachAfterCommit: true,
          snapshotRevision: 0,
          updateBytesSinceSnapshot: 0,
        }
      : await this.prepareManagedNote(existingMetadata.noteId);
    if (prepared.handle.current.kind !== "note") {
      if (prepared.attachAfterCommit) prepared.handle.current.doc.destroy();
      throw new Error("Managed Help target is not a NoteDoc");
    }

    const restoredNoteIds = existingMetadata?.deletedAt
      ? [existingMetadata.noteId]
      : [];
    const noteInsertion = created
      ? planNewNotePosition(
          metadata,
          null,
          null,
          noteId,
          siblingPositionSeed(
            this.workspaceDocument.workspaceId,
            envelope.operationId,
            noteId,
          ),
        )
      : null;
    const nextApplicationState = openBufferInWindow(
      currentApplicationState,
      windowId,
      createNoteBuffer(noteId),
      { mode: "normal" },
    );

    this.setSaving();
    try {
      await this.transactions.transact(
        {
          operationId: envelope.operationId,
          scope: "workspace-structure",
          documents: [this.workspace, prepared.handle],
          localStates: [toApplicationLocalStateCommit(nextApplicationState)],
          fault,
        },
        () => {
          this.workspaceDocument.doc.transact(() => {
            if (noteInsertion) {
              addNoteMetadata(
                this.workspaceDocument,
                {
                  noteId,
                  title: MEMOKA_HELP_TITLE,
                  parentNoteId: null,
                  notePosition: noteInsertion.notePosition,
                  createdAt: synchronizedAt,
                  updatedAt: synchronizedAt,
                  systemRole: "help",
                },
                CORE_TRANSACTION_ORIGIN,
              );
              if (noteInsertion.reindexedSiblings.length > 0) {
                updateNotePlacements(
                  this.workspaceDocument,
                  noteInsertion.reindexedSiblings.map((update) => ({
                    ...update,
                    parentNoteId: null,
                  })),
                  CORE_TRANSACTION_ORIGIN,
                );
              }
            }
            if (restoredNoteIds.length > 0) {
              restoreNotesFromTrash(
                this.workspaceDocument,
                restoredNoteIds,
                synchronizedAt,
                CORE_TRANSACTION_ORIGIN,
              );
            }
            synchronizeManagedNoteMetadata(
              this.workspaceDocument,
              noteId,
              {
                title: MEMOKA_HELP_TITLE,
                updatedAt: synchronizedAt,
              },
              CORE_TRANSACTION_ORIGIN,
            );
          }, CORE_TRANSACTION_ORIGIN);
          replaceNoteSectionTree(
            prepared.handle.current as NoteDocument,
            createMemokaHelpSectionSnapshot(noteId),
            synchronizedAt,
            CORE_TRANSACTION_ORIGIN,
          );
        },
      );
      if (prepared.attachAfterCommit) {
        this.notes.set(noteId, prepared.handle);
        this.notePersistence.set(
          noteId,
          this.createNotePersistenceSession(
            noteId,
            prepared.handle,
            created ? 0 : prepared.handle.revision - prepared.snapshotRevision,
            created ? 0 : prepared.updateBytesSinceSnapshot,
          ),
        );
      }
      this.applicationWindowState = nextApplicationState;
      this.pendingNavigations.delete(windowId);
      this.syncActiveNoteFromApplicationWindow();
      this.changedNoteRevisions.set(noteId, prepared.handle.revision);
      this.noteContentRevision += 1;
      this.sectionCatalogRevision += 1;
      this.internalLinkLabelRevision += 1;
      this.queueWorkspaceSearchIndexRebuild();
      this.setReady();
      return {
        noteId,
        windowId,
        created,
        restored: restoredNoteIds.length > 0,
      };
    } catch (error) {
      if (prepared.attachAfterCommit) prepared.handle.current.doc.destroy();
      this.reportError(error);
      throw error;
    }
  }

  private async prepareManagedNote(
    noteId: string,
  ): Promise<PreparedManagedNote> {
    const existing = this.notes.get(noteId);
    if (existing) {
      return {
        handle: existing,
        attachAfterCommit: false,
        snapshotRevision: existing.revision,
        updateBytesSinceSnapshot: 0,
      };
    }
    const pending = this.noteLoads.get(noteId);
    if (pending) {
      const handle = await pending;
      return {
        handle,
        attachAfterCommit: false,
        snapshotRevision: handle.revision,
        updateBytesSinceSnapshot: 0,
      };
    }
    const persisted = await this.persistence.loadDocument("note", noteId);
    return this.preparePersistedManagedNote(persisted);
  }

  private async preparePersistedManagedNote(
    persisted: PersistedDocument,
  ): Promise<PreparedManagedNote> {
    if (persisted.kind !== "note") {
      throw new Error(
        `Expected persisted NoteDoc, received ${persisted.kind}:${persisted.documentId}`,
      );
    }
    const loaded = loadNoteDocumentWithSectionIdentityRecovery(
      persisted.documentId,
      persisted.snapshot,
      persisted.updates.map(({ update }) => update),
    );
    const handle = new ManagedCrdtDocument<ProductDocument>(
      loaded.document,
      persisted.revision,
    );
    let repairBytes = 0;
    if (loaded.repair) {
      // Persistence maintenance is not a user command. Keep its id outside the
      // injectable command-id sequence so restarting a deterministic test (or
      // replaying an external command stream) cannot reuse an old operation.
      const operationId = createUuidV7();
      this.pendingSectionIdentityRepairs.set(operationId, {
        handle,
        repair: loaded.repair,
      });
      try {
        if (loaded.repair.migratedFromSchemaVersion !== null) {
          await this.executeCommand({
            name: "note.migrate_schema",
            operationId,
            source: "internal",
            payload: {
              noteId: persisted.documentId,
              update: loaded.repair.update,
              fromVersion: loaded.repair.migratedFromSchemaVersion,
              toVersion: 3,
            },
          });
        } else {
          await this.executeCommand({
            name: "note.repair_section_identity",
            operationId,
            source: "internal",
            payload: {
              noteId: persisted.documentId,
              update: loaded.repair.update,
              repairedSectionIds: [...loaded.repair.repairedSectionIds],
              repairedBlockIds: [...loaded.repair.repairedBlockIds],
            },
          });
        }
        repairBytes = loaded.repair.update.byteLength;
      } catch (error) {
        handle.current.doc.destroy();
        throw error;
      } finally {
        this.pendingSectionIdentityRepairs.delete(operationId);
      }
    }
    return {
      handle,
      attachAfterCommit: true,
      snapshotRevision: persisted.snapshotRevision,
      updateBytesSinceSnapshot:
        persisted.updates.reduce(
          (total, { update }) => total + update.byteLength,
          0,
        ) + repairBytes,
    };
  }

  private async createNewNote(
    input: CreateNewNoteInput,
  ): Promise<{ noteId: string }> {
    const {
      operationId,
      noteId,
      title,
      createdAt,
      parentNoteId,
      afterNoteId,
      windowId,
      fault,
    } = input;
    if (this.notes.has(noteId) || this.workspaceDocument.notes.has(noteId)) {
      throw new Error(`Duplicate note: ${noteId}`);
    }
    await this.localStateQueue.catch(() => undefined);
    const insertion = planNewNotePosition(
      listNoteMetadata(this.workspaceDocument),
      parentNoteId,
      afterNoteId,
      noteId,
      siblingPositionSeed(
        this.workspaceDocument.workspaceId,
        operationId,
        noteId,
      ),
    );
    const note = new ManagedCrdtDocument<ProductDocument>(
      createNoteDocument(noteId, undefined, title, {
        createdAt,
        updatedAt: createdAt,
      }),
      0,
    );
    const nextApplicationState = this.creationApplicationWindowState(
      noteId,
      windowId,
    );
    const changedWindowIds = Object.keys(nextApplicationState.windows).filter(
      (candidateWindowId) =>
        !this.applicationWindowState ||
        this.applicationWindowState.windows[candidateWindowId]?.bufferId !==
          nextApplicationState.windows[candidateWindowId].bufferId,
    );
    this.setSaving();
    try {
      await this.transactions.transact(
        {
          operationId,
          scope: "workspace-structure",
          documents: [this.workspace, note],
          localStates: [toApplicationLocalStateCommit(nextApplicationState)],
          fault,
        },
        () => {
          addNoteMetadata(
            this.workspaceDocument,
            {
              noteId,
              title,
              parentNoteId,
              notePosition: insertion.notePosition,
              createdAt,
              updatedAt: createdAt,
            },
            CORE_TRANSACTION_ORIGIN,
          );
          if (insertion.reindexedSiblings.length > 0) {
            updateNotePlacements(
              this.workspaceDocument,
              insertion.reindexedSiblings.map((update) => ({
                ...update,
                parentNoteId,
              })),
              CORE_TRANSACTION_ORIGIN,
            );
          }
        },
      );
      this.notes.set(noteId, note);
      this.applicationWindowState = nextApplicationState;
      this.syncActiveNoteFromApplicationWindow();
      for (const changedWindowId of changedWindowIds) {
        this.pendingNavigations.delete(changedWindowId);
      }
      this.notePersistence.set(
        noteId,
        this.createNotePersistenceSession(noteId, note, 0, 0),
      );
      this.sectionCatalogRevision += 1;
      this.queueWorkspaceSearchIndexRebuild();
      this.setReady();
      return { noteId };
    } catch (error) {
      note.current.doc.destroy();
      this.reportError(error);
      throw error;
    }
  }

  private async moveExistingNote(input: {
    operationId: string;
    noteId: string;
    targetParentId: string | null;
    placement: NoteMoveRequest["placement"];
    fault?: CommitFault;
  }): Promise<{ noteId: string; changed: boolean }> {
    const plan = planNoteMove(
      listNoteMetadata(this.workspaceDocument),
      input.noteId,
      {
        targetParentId: input.targetParentId,
        placement: input.placement,
      },
      siblingPositionSeed(
        this.workspaceDocument.workspaceId,
        input.operationId,
        input.noteId,
      ),
    );
    if (!plan.changed) return { noteId: input.noteId, changed: false };
    const metadata = new Map(
      listNoteMetadata(this.workspaceDocument).map((note) => [
        note.noteId,
        note,
      ]),
    );
    const updates = [
      ...plan.reindexedSiblings.map((update) => ({
        noteId: update.noteId,
        parentNoteId: metadata.get(update.noteId)!.parentNoteId,
        notePosition: update.notePosition,
      })),
      {
        noteId: input.noteId,
        parentNoteId: plan.targetParentId,
        notePosition: plan.notePosition,
      },
    ];
    this.setSaving();
    const workspaceBaseRevision = this.workspace.revision;
    try {
      await this.transactions.transact(
        {
          operationId: input.operationId,
          scope: "workspace-structure",
          documents: [this.workspace],
          fault: input.fault,
        },
        () =>
          updateNotePlacements(
            this.workspaceDocument,
            updates,
            CORE_TRANSACTION_ORIGIN,
          ),
      );
      // Search hierarchy is normalized. A parent-changing move updates only
      // the moved Root Section's parent edge. A same-parent reorder merely
      // advances the derived index revision with an empty hierarchy update.
      // Neither path touches descendants or body rows.
      const parentChanged =
        metadata.get(input.noteId)!.parentNoteId !== plan.targetParentId;
      this.queueWorkspaceSearchIndexHierarchyUpdate(
        workspaceBaseRevision,
        parentChanged ? input.noteId : [],
      );
      this.enqueuePendingWorkspaceSearchIndexHierarchyUpdates();
      this.sectionCatalogRevision += 1;
      this.internalLinkLabelRevision += 1;
      this.setReady();
      return { noteId: input.noteId, changed: true };
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  private creationApplicationWindowState(
    noteId: string,
    windowId: string | undefined,
  ): ApplicationWindowState {
    if (!this.applicationWindowState) {
      return this.createSafeApplicationWindowState(noteId);
    }
    if (!windowId || !this.applicationWindowState.windows[windowId]) {
      throw new Error(`Unknown window: ${windowId ?? "(missing)"}`);
    }
    return openBufferInWindow(
      this.applicationWindowState,
      windowId,
      createNoteBuffer(noteId),
      { mode: "insert" },
    );
  }

  private requireLiveMetadata(noteId: string): NoteMetadata {
    const metadata = readNoteMetadata(this.workspaceDocument, noteId);
    if (!metadata) throw new Error(`Unknown note: ${noteId}`);
    if (metadata.deletedAt) throw new Error(`Note is in Trash: ${noteId}`);
    return metadata;
  }

  private workspaceSearchRebuildRequest(
    catalog: WorkspaceSearchCatalog,
    workspaceRevision = this.workspace.revision,
  ): WorkspaceSearchIndexRebuildRequest {
    const documents = catalog.documents.map((document) => {
      if (!document.sourceRevision || document.sourceRevision < 1) {
        throw new Error(
          `Workspace search projection has no persisted revision: ${document.noteId}`,
        );
      }
      return {
        ...document,
        sourceRevision: document.sourceRevision,
      } satisfies WorkspaceSearchIndexedDocument;
    });
    return {
      schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
      workspaceId: this.workspaceDocument.workspaceId,
      workspaceRevision,
      documents,
    };
  }

  private workspaceSearchFallback(
    catalog: WorkspaceSearchCatalog,
    query: string,
    scope: WorkspaceSearchScope,
    limit: number,
    startedAt: number,
    warning: string | null,
  ): WorkspaceSearchResponse {
    return {
      scope,
      results: filterWorkspaceSearchCatalog(catalog, query, scope, limit),
      failures: catalog.failures,
      backend: "crdt-fallback",
      elapsedMs: performance.now() - startedAt,
      warning,
    };
  }

  private workspaceMetadataSearchCatalog(
    target: Exclude<WorkspaceSearchTarget, "workspace">,
  ): WorkspaceSearchCatalog {
    const notes = listNoteMetadata(this.workspaceDocument);
    const candidates =
      target === "buffers"
        ? (() => {
            const bufferedNoteIds = new Set(
              Object.values(this.requireApplicationWindowState().buffers)
                .filter((buffer) => buffer.kind === "note")
                .map((buffer) => buffer.noteId),
            );
            return notes
              .filter(
                ({ noteId, deletedAt }) =>
                  !deletedAt && bufferedNoteIds.has(noteId),
              )
              .map((note) => ({
                noteId: note.noteId,
                sectionId: note.noteId,
                title: noteDisplayTitle(note.title),
                parentPath: noteAncestorPath(notes, note.noteId),
                shortId: note.noteId.slice(-8),
                updatedAt: note.updatedAt,
              }));
          })()
        : deriveTrashSearchCandidates(notes);
    return {
      documents: candidates.map((candidate) => ({
        noteId: candidate.noteId,
        title: candidate.title,
        parentPath: candidate.parentPath,
        updatedAt: candidate.updatedAt ?? "",
        blocks: [],
      })),
      failures: [],
    };
  }

  private queueWorkspaceSearchIndexRebuild(): void {
    if (!this.workspaceSearchIndex) return;
    const signature = `${this.workspace.revision}:${this.noteContentRevision}`;
    if (
      this.workspaceSearchRebuildQueuedSignature === signature ||
      this.workspaceSearchRebuildFailedSignature === signature
    ) {
      return;
    }
    this.workspaceSearchRebuildQueuedSignature = signature;
    this.workspaceSearchFallbackCatalogCache = null;
    this.queueWorkspaceSearchIndex("rebuild", async () => {
      try {
        const catalog = await this.rebuildWorkspaceSearchIndexFromSource();
        if (catalog.failures.length > 0) {
          throw new Error(
            "Workspace search rebuild skipped after NoteDoc read failure",
          );
        }
        this.workspaceSearchRebuildFailedSignature = null;
      } catch (error) {
        this.workspaceSearchRebuildFailedSignature = signature;
        throw error;
      } finally {
        if (this.workspaceSearchRebuildQueuedSignature === signature) {
          this.workspaceSearchRebuildQueuedSignature = null;
        }
      }
    });
  }

  private queueWorkspaceSearchIndexHierarchyUpdate(
    baseRevision: number,
    noteIds: string | Iterable<string> = [],
  ): void {
    if (!this.workspaceSearchIndex) return;
    for (const noteId of typeof noteIds === "string" ? [noteIds] : noteIds) {
      this.pendingWorkspaceSearchIndexHierarchyNoteIds.add(noteId);
    }
    this.pendingWorkspaceSearchIndexHierarchyBaseRevision =
      this.pendingWorkspaceSearchIndexHierarchyBaseRevision === null
        ? baseRevision
        : Math.min(
            this.pendingWorkspaceSearchIndexHierarchyBaseRevision,
            baseRevision,
          );
  }

  private enqueuePendingWorkspaceSearchIndexHierarchyUpdates(): void {
    if (
      !this.workspaceSearchIndex ||
      this.pendingWorkspaceSearchIndexHierarchyBaseRevision === null
    ) {
      return;
    }
    const baseRevision = this.pendingWorkspaceSearchIndexHierarchyBaseRevision;
    const noteIds = [...this.pendingWorkspaceSearchIndexHierarchyNoteIds];
    this.pendingWorkspaceSearchIndexHierarchyNoteIds.clear();
    this.pendingWorkspaceSearchIndexHierarchyBaseRevision = null;
    const metadata = listNoteMetadata(this.workspaceDocument);
    const byId = new Map(metadata.map((note) => [note.noteId, note]));
    const entries = noteIds
      .map((noteId) => byId.get(noteId))
      .filter((note): note is NoteMetadata => Boolean(note && !note.deletedAt))
      .map((note) => {
        const title = noteDisplayTitle(note.title);
        return {
          noteId: note.noteId,
          parentNoteId: note.parentNoteId,
          title,
          normalizedTitle: normalizeWorkspaceSearchText(title),
          titleJapaneseGrams: workspaceSearchJapaneseGrams(title),
        };
      });
    const workspaceRevision = this.workspace.revision;
    this.queueWorkspaceSearchIndex("hierarchy", async () => {
      const update =
        this.workspaceSearchIndex?.updateWorkspaceSearchIndexHierarchy;
      if (!update) {
        await this.rebuildWorkspaceSearchIndexFromSource();
        return;
      }
      const status = await update.call(this.workspaceSearchIndex, {
        schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
        workspaceId: this.workspaceDocument.workspaceId,
        baseRevision,
        workspaceRevision,
        entries,
      });
      if (status === "stale")
        await this.rebuildWorkspaceSearchIndexFromSource();
    });
  }

  private queueWorkspaceSearchIndexStartupValidation(): void {
    if (!this.workspaceSearchIndex) return;
    this.queueWorkspaceSearchIndex("validate", async () => {
      try {
        const probe =
          await this.workspaceSearchIndex!.queryWorkspaceSearchIndex(
            workspaceSearchIndexQuery(
              this.workspaceDocument.workspaceId,
              this.workspace.revision,
              "",
              "title",
              1,
            ),
          );
        if (probe.status === "ready") return;
      } catch {
        // A missing or outdated derived schema can fail before it reports
        // `stale`; rebuilding from persisted CRDT is the same recovery path.
      }
      const catalog = await this.rebuildWorkspaceSearchIndexFromSource();
      if (catalog.failures.length > 0) {
        throw new Error(
          "Workspace search rebuild skipped after NoteDoc read failure",
        );
      }
    });
  }

  private async rebuildWorkspaceSearchIndexFromSource(): Promise<WorkspaceSearchCatalog> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Loaded NoteDocs can contain optimistic editor updates. Drain their
      // persistence chains before taking the revision/state pair used by the
      // derived index. This lets a stale-index recovery borrow the live CRDT
      // instead of pulling its snapshot and entire update log back through
      // Tauri; unopened notes still use durable persisted bytes.
      await Promise.all(
        [...this.notePersistence.values()].map((session) => session.flush()),
      );
      const workspaceRevision = this.workspace.revision;
      const catalog = await this.cachedWorkspaceSearchCatalog();
      if (catalog.failures.length > 0) return catalog;
      if (this.workspace.revision !== workspaceRevision) {
        lastError = new Error(
          "Workspace changed while rebuilding the search index",
        );
        continue;
      }
      try {
        await this.workspaceSearchIndex!.rebuildWorkspaceSearchIndex(
          this.workspaceSearchRebuildRequest(catalog, workspaceRevision),
        );
        for (const document of catalog.documents) {
          const handle = this.notes.get(document.noteId);
          if (
            document.sourceRevision &&
            (!handle || handle.revision === document.sourceRevision)
          ) {
            this.workspaceSearchDirtyNoteIds.delete(document.noteId);
          }
        }
        return catalog;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private queueWorkspaceSearchIndexDocument(noteId: string): void {
    // The CRDT fallback cache is also used when no derived-index provider is
    // configured (tests and browser-only development). Invalidate it at the
    // live Y.Doc update boundary, before persistence finishes, so an immediate
    // search cannot reuse the pre-edit catalog.
    this.workspaceSearchFallbackCatalogCache = null;
    this.workspaceSearchProjectionCache.delete(noteId);
    if (!this.workspaceSearchIndex) return;
    this.workspaceSearchDirtyNoteIds.add(noteId);
    this.pendingWorkspaceSearchIndexNoteIds.add(noteId);
    if (this.workspaceSearchIndexDocumentTimer !== null) {
      globalThis.clearTimeout(this.workspaceSearchIndexDocumentTimer);
    }
    this.workspaceSearchIndexDocumentTimer = globalThis.setTimeout(() => {
      this.workspaceSearchIndexDocumentTimer = null;
      this.enqueuePendingWorkspaceSearchIndexHierarchyUpdates();
      this.enqueuePendingWorkspaceSearchIndexDocuments();
    }, WORKSPACE_SEARCH_INDEX_INPUT_DEBOUNCE_MS);
  }

  private async advanceWorkspaceSearchIndexMetadataRevision(
    request: WorkspaceSearchIndexMetadataRevisionRequest,
  ): Promise<void> {
    try {
      await this.workspaceSearchIndex?.advanceWorkspaceSearchIndexMetadataRevision?.(
        request,
      );
    } catch (error) {
      // Search is a disposable projection. A failed revision bridge leaves it
      // stale so the queued one-note refresh takes the normal rebuild path; a
      // successfully committed NoteDoc must never be reported as unsaved.
      this.workspaceSearchIndexWarning =
        error instanceof Error ? error.message : String(error);
    }
  }

  private enqueuePendingWorkspaceSearchIndexDocuments(): void {
    if (this.workspaceSearchIndexDocumentTimer !== null) {
      globalThis.clearTimeout(this.workspaceSearchIndexDocumentTimer);
      this.workspaceSearchIndexDocumentTimer = null;
    }
    if (
      !this.workspaceSearchIndex ||
      this.pendingWorkspaceSearchIndexNoteIds.size === 0
    ) {
      return;
    }
    const noteIds = [...this.pendingWorkspaceSearchIndexNoteIds];
    this.pendingWorkspaceSearchIndexNoteIds.clear();
    this.queueWorkspaceSearchIndex("note", async () => {
      for (const noteId of noteIds) {
        await this.replaceWorkspaceSearchIndexDocument(noteId);
      }
    });
  }

  private async flushWorkspaceSearchIndexDocuments(): Promise<void> {
    if (this.workspaceSearchIndexDocumentTimer !== null) {
      globalThis.clearTimeout(this.workspaceSearchIndexDocumentTimer);
      this.workspaceSearchIndexDocumentTimer = null;
    }
    while (
      this.pendingWorkspaceSearchIndexNoteIds.size > 0 ||
      this.pendingWorkspaceSearchIndexHierarchyBaseRevision !== null
    ) {
      this.enqueuePendingWorkspaceSearchIndexHierarchyUpdates();
      this.enqueuePendingWorkspaceSearchIndexDocuments();
      await this.workspaceSearchIndexQueue;
    }
  }

  private async replaceWorkspaceSearchIndexDocument(
    noteId: string,
  ): Promise<void> {
    if (!this.workspaceSearchIndex) return;
    const metadata = readNoteMetadata(this.workspaceDocument, noteId);
    if (!metadata || metadata.deletedAt) return;
    const handle = this.notes.get(noteId);
    const session = this.notePersistence.get(noteId);
    if (!handle || handle.current.kind !== "note") return;

    // The debounce runs after an editor update has been queued, but more
    // updates may have joined the same persistence chain in the meantime.
    // Wait for the chain to become stable, then derive the rebuildable index
    // synchronously from that exact durable live NoteDoc. Loading its snapshot
    // and every update from SQLite here used to serialize megabytes through
    // the Tauri bridge after each short typing pause.
    await session?.flush();
    const workspaceRevision = this.workspace.revision;
    const sourceRevision = handle.revision;
    const sourceDocument = handle.current;
    const document: WorkspaceSearchIndexedDocument = {
      ...(await deriveWorkspaceSearchDocumentAsync(
        sourceDocument,
        metadata.title,
        noteAncestorPath(
          listNoteMetadata(this.workspaceDocument),
          metadata.noteId,
        ),
        metadata.updatedAt,
        metadata.parentNoteId,
      )),
      sourceRevision,
    };
    if (
      this.workspace.revision !== workspaceRevision ||
      handle.current !== sourceDocument ||
      handle.revision !== sourceRevision
    ) {
      this.queueWorkspaceSearchIndexDocument(noteId);
      return;
    }
    const status =
      await this.workspaceSearchIndex.replaceWorkspaceSearchIndexDocument({
        schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
        workspaceId: this.workspaceDocument.workspaceId,
        workspaceRevision,
        document,
      });
    if (status === "stale") {
      this.queueWorkspaceSearchIndexRebuild();
      return;
    }
    if (
      handle.revision === sourceRevision &&
      this.workspace.revision === workspaceRevision
    ) {
      this.workspaceSearchDirtyNoteIds.delete(noteId);
    } else {
      this.queueWorkspaceSearchIndexDocument(noteId);
    }
  }

  private queueWorkspaceSearchIndex(
    task: string,
    action: () => Promise<void>,
  ): void {
    this.workspaceSearchIndexQueuedTaskCount += 1;
    this.workspaceSearchIndexQueue = this.workspaceSearchIndexQueue
      .catch(() => undefined)
      .then(async () => {
        this.workspaceSearchIndexQueuedTaskCount = Math.max(
          0,
          this.workspaceSearchIndexQueuedTaskCount - 1,
        );
        this.workspaceSearchIndexRunningTask = task;
        const startedAt = performance.now();
        try {
          await action();
          this.workspaceSearchIndexWarning = null;
        } catch (error) {
          this.workspaceSearchIndexWarning =
            error instanceof Error ? error.message : String(error);
        } finally {
          this.workspaceSearchIndexLastTask = task;
          this.workspaceSearchIndexLastDurationMs =
            performance.now() - startedAt;
          this.workspaceSearchIndexRunningTask = null;
        }
      });
  }

  private isLiveNote(noteId: string): boolean {
    const metadata = readNoteMetadata(this.workspaceDocument, noteId);
    return Boolean(metadata && !metadata.deletedAt);
  }

  private internalLinkCandidates(): readonly InternalLinkCandidate[] {
    if (this.internalLinkCandidateRevision !== this.sectionCatalogRevision) {
      const documents = new Map<string, NoteDocument>();
      for (const [noteId, handle] of this.notes) {
        if (handle.current.kind === "note")
          documents.set(noteId, handle.current);
      }
      const metadata = listNoteMetadata(this.workspaceDocument).filter(
        ({ deletedAt }) => !deletedAt,
      );
      const refreshed = deriveInternalLinkCandidates(metadata, documents);
      const refreshedByNote = groupInternalLinkCandidatesByNote(refreshed);
      const preservedByNote = groupInternalLinkCandidatesByNote(
        this.internalLinkCandidateCache,
      );
      this.internalLinkCandidateCache = metadata.flatMap(({ noteId }) =>
        documents.has(noteId)
          ? (refreshedByNote.get(noteId) ?? [])
          : (preservedByNote.get(noteId) ?? []),
      );
      this.internalLinkCandidateRevision = this.sectionCatalogRevision;
    }
    return this.internalLinkCandidateCache;
  }

  private resolveSectionLocation(
    targetSectionId: string,
  ): { noteId: string; sectionId: string } | null {
    for (const [noteId, handle] of this.notes) {
      if (
        handle.current.kind === "note" &&
        findSectionById(handle.current.rootSection, targetSectionId)
      ) {
        return { noteId, sectionId: targetSectionId };
      }
    }
    const candidate = this.internalLinkCandidates().find(
      ({ sectionId }) => sectionId === targetSectionId,
    );
    return candidate
      ? { noteId: candidate.noteId, sectionId: candidate.sectionId }
      : null;
  }

  private async primeInternalLinkCandidates(): Promise<void> {
    const candidates: InternalLinkCandidate[] = [];
    for (const metadata of listNoteMetadata(this.workspaceDocument)) {
      if (metadata.deletedAt) continue;
      let preview: Awaited<ReturnType<CoreRuntime["loadNotePreview"]>> | null =
        null;
      try {
        preview = await this.loadNotePreview(metadata.noteId);
        candidates.push(
          ...deriveInternalLinkCandidates(
            [metadata],
            new Map([[metadata.noteId, preview.document]]),
          ),
        );
      } catch {
        // A damaged or temporarily unavailable NoteDoc must not prevent the
        // remaining buffers from opening. Search reports the same read failure
        // through its explicit failure channel.
      } finally {
        preview?.release();
      }
    }
    this.internalLinkCandidateCache = candidates;
    this.internalLinkCandidateRevision = this.sectionCatalogRevision;
  }

  private async focusNavigationSection(
    windowId: string,
    noteId: string,
    targetSectionId: string,
    destination: EditorNavigationDestination,
    detail: string,
    origin?: StableEditorPosition,
    onFailure?: () => void,
  ): Promise<EditorNavigationResult> {
    const pending = { destination, detail };
    this.pendingNavigations.set(windowId, pending);
    try {
      await this.focusSection(windowId, noteId, targetSectionId);
      if (origin) this.jumpListFor(windowId).recordOrigin(origin);
      return { handled: true, detail };
    } catch (error) {
      if (this.pendingNavigations.get(windowId) === pending) {
        this.pendingNavigations.delete(windowId);
      }
      onFailure?.();
      return {
        handled: false,
        detail: `jump:open:error:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async openNavigationDestination(
    windowId: string,
    destination: EditorNavigationDestination,
    detail: string,
    afterOpen?: () => void,
    onFailure?: () => void,
  ): Promise<EditorNavigationResult> {
    const pending = { destination, detail };
    this.pendingNavigations.set(windowId, pending);
    try {
      await this.openNote(windowId, destination.noteId);
      afterOpen?.();
      return { handled: true, detail };
    } catch (error) {
      if (this.pendingNavigations.get(windowId) === pending) {
        this.pendingNavigations.delete(windowId);
      }
      onFailure?.();
      return {
        handled: false,
        detail: `jump:open:error:${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private ensureNoteLoaded(
    noteId: string,
  ): Promise<ManagedCrdtDocument<ProductDocument>> {
    const existing = this.notes.get(noteId);
    if (existing) return Promise.resolve(existing);
    const pending = this.noteLoads.get(noteId);
    if (pending) return pending;
    this.requireLiveMetadata(noteId);
    const loading = this.persistence
      .loadDocument("note", noteId)
      .then(async (persistedNote) => {
        const prepared = await this.preparePersistedManagedNote(persistedNote);
        const handle = prepared.handle;
        this.notes.set(noteId, handle);
        this.notePersistence.set(
          noteId,
          this.createNotePersistenceSession(
            noteId,
            handle,
            handle.revision - prepared.snapshotRevision,
            prepared.updateBytesSinceSnapshot,
          ),
        );
        return handle;
      })
      .finally(() => this.noteLoads.delete(noteId));
    this.noteLoads.set(noteId, loading);
    return loading;
  }

  private createSafeApplicationWindowState(
    noteId: string | null = null,
  ): ApplicationWindowState {
    return createApplicationWindowState({
      applicationWindowId: DEFAULT_APPLICATION_WINDOW_ID,
      tabId: DEFAULT_TAB_ID,
      windowId: "window-1",
      buffer: noteId ? createNoteBuffer(noteId) : null,
      mode: noteId ? "insert" : "normal",
    });
  }

  private requireApplicationWindowState(): ApplicationWindowState {
    if (!this.applicationWindowState) {
      throw new Error("Application Window state is not initialized");
    }
    return this.applicationWindowState;
  }

  private applicationNoteMetadata(): readonly NoteMetadata[] {
    if (!this.noteMetadataProjectionCache) {
      this.noteMetadataProjectionCache = Object.freeze(
        listNoteMetadata(this.workspaceDocument).map((note) =>
          Object.freeze({ ...note }),
        ),
      );
    }
    return this.noteMetadataProjectionCache;
  }

  private observeWorkspaceMetadata(document: ProductDocument): void {
    if (document.kind !== "workspace") {
      throw new Error("Core runtime workspace handle is invalid");
    }
    this.observedWorkspaceNotes?.unobserveDeep(
      this.handleWorkspaceMetadataChange,
    );
    this.observedWorkspaceNotes = document.notes;
    this.observedWorkspaceNotes.observeDeep(this.handleWorkspaceMetadataChange);
    this.noteMetadataProjectionCache = null;
  }

  private projectWindowState(windowId: string): RuntimeWindowState {
    const state = this.requireApplicationWindowState();
    const window = state.windows[windowId];
    if (!window) throw new Error(`Unknown window: ${windowId}`);
    const buffer =
      window.bufferId === null ? undefined : state.buffers[window.bufferId];
    const noteId = this.contentBufferNoteId(buffer);
    if (window.bufferId !== null && !noteId) {
      throw new Error(
        `Window ${windowId} cannot display utility buffer ${window.bufferId}`,
      );
    }
    const view = { ...structuredClone(window.view) };
    for (const projected of [
      this.inFlightWindowViewUpdates.get(windowId),
      this.pendingWindowViewUpdates.get(windowId),
    ]) {
      if (projected?.noteId === noteId) Object.assign(view, projected.update);
    }
    return {
      windowId,
      noteId,
      ...view,
    };
  }

  private requireContentWindowState(windowId: string): WindowViewState {
    const state = this.projectWindowState(windowId);
    if (state.noteId === null) {
      throw new Error(`Window has no Buffer: ${windowId}`);
    }
    return { ...state, noteId: state.noteId };
  }

  private requireActiveNoteId(): string {
    if (!this.activeNoteId) {
      throw new Error("Active Window has no Buffer");
    }
    return this.activeNoteId;
  }

  private contentBufferNoteId(buffer: BufferState | undefined): string | null {
    if (!buffer) return null;
    if (buffer.kind === "note") return buffer.noteId;
    return null;
  }

  private windowDisplaysNote(windowId: string, noteId: string): boolean {
    const state = this.requireApplicationWindowState();
    const window = state.windows[windowId];
    if (!window) return false;
    const buffer =
      window.bufferId === null ? undefined : state.buffers[window.bufferId];
    return buffer?.kind === "note" && buffer.noteId === noteId;
  }

  private isLiveContentBuffer(
    buffer: BufferState | undefined,
    liveNoteIds: ReadonlySet<string>,
  ): boolean {
    const noteId = this.contentBufferNoteId(buffer);
    return noteId !== null && liveNoteIds.has(noteId);
  }

  private isRuntimeDisplayableBuffer(
    buffer: BufferState | undefined,
    liveNoteIds: ReadonlySet<string>,
  ): boolean {
    return this.isLiveContentBuffer(buffer, liveNoteIds);
  }

  private syncActiveNoteFromApplicationWindow(): void {
    const state = this.requireApplicationWindowState();
    const window = activeEditorWindow(state);
    const buffer =
      window.bufferId === null ? undefined : state.buffers[window.bufferId];
    this.activeNoteId = this.contentBufferNoteId(buffer);
  }

  private reportRecoverableLocalStateError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.onError?.(normalized);
  }

  private runWithNotePersistenceLock<Result>(
    noteId: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const session = this.notePersistence.get(noteId);
    return session ? session.runExclusive(action) : action();
  }

  private createNotePersistenceSession(
    noteId: string,
    handle: ManagedCrdtDocument<ProductDocument>,
    updatesSinceSnapshot: number,
    updateBytesSinceSnapshot: number,
  ): NotePersistenceSession {
    return new NotePersistenceSession({
      handle,
      idFactory: this.idFactory,
      initialUpdatesSinceSnapshot: updatesSinceSnapshot,
      initialUpdateBytesSinceSnapshot: updateBytesSinceSnapshot,
      compactionThreshold: this.snapshotCompactionThreshold,
      compactionByteThreshold: this.snapshotCompactionByteThreshold,
      persistUpdate: (operationId, update, sectionCatalogChanged) =>
        this.executeCommand({
          name: "note.commit_editor_update",
          operationId,
          source: "editor",
          payload: { noteId, update, sectionCatalogChanged },
        }),
      compactSnapshot: (operationId, expectedRevision) =>
        this.executeCommand({
          name: "note.compact_snapshot",
          operationId,
          source: "internal",
          payload: { noteId, expectedRevision },
        }),
      onContentChanged: () => this.queueWorkspaceSearchIndexDocument(noteId),
      onMaintenanceError: (error) => this.onError?.(error),
    });
  }

  private persistWindowUpdate(
    windowId: string,
    update: {
      mode?: WindowViewState["mode"];
      selection?: WindowViewState["selection"];
      scrollTop?: number;
    },
    noteId: string,
    activeSectionId?: string | null,
  ): void {
    const pending = this.pendingWindowViewUpdates.get(windowId);
    const outlineChanged =
      activeSectionId !== undefined &&
      activeSectionId !== null &&
      this.activeOutlineSelectionDiffers(windowId, noteId, activeSectionId);
    this.pendingWindowViewUpdates.set(windowId, {
      noteId,
      update: {
        ...(pending?.noteId === noteId ? pending.update : {}),
        ...update,
      },
      activeSectionId:
        activeSectionId !== undefined
          ? outlineChanged
            ? activeSectionId
            : undefined
          : pending?.noteId === noteId
            ? pending.activeSectionId
            : undefined,
    });
    const urgent =
      update.mode !== undefined ||
      update.scrollTop !== undefined ||
      outlineChanged;
    if (!urgent && this.windowViewUpdateFrame === null) {
      if (this.windowViewUpdateTimer !== null) {
        globalThis.clearTimeout(this.windowViewUpdateTimer);
      }
      this.windowViewUpdateTimer = globalThis.setTimeout(() => {
        this.windowViewUpdateTimer = null;
        this.flushPendingWindowViewUpdates();
      }, WINDOW_SELECTION_PERSISTENCE_DEBOUNCE_MS);
      return;
    }
    if (this.windowViewUpdateTimer !== null) {
      globalThis.clearTimeout(this.windowViewUpdateTimer);
      this.windowViewUpdateTimer = null;
    }
    if (this.windowViewUpdateFrame !== null) return;
    this.windowViewUpdateFrame = requestAnimationFrame(() => {
      this.windowViewUpdateFrame = null;
      this.flushPendingWindowViewUpdates();
    });
  }

  private flushPendingWindowViewUpdates(): void {
    if (this.windowViewUpdateFrame !== null) {
      cancelAnimationFrame(this.windowViewUpdateFrame);
      this.windowViewUpdateFrame = null;
    }
    if (this.windowViewUpdateTimer !== null) {
      globalThis.clearTimeout(this.windowViewUpdateTimer);
      this.windowViewUpdateTimer = null;
    }
    const updates = [...this.pendingWindowViewUpdates];
    this.pendingWindowViewUpdates.clear();
    for (const [windowId, pending] of updates) {
      this.persistWindowUpdateNow(windowId, pending);
    }
  }

  private persistWindowUpdateNow(
    windowId: string,
    pending: PendingWindowViewUpdate,
  ): void {
    this.inFlightWindowViewUpdates.set(windowId, pending);
    void this.executeCommand({
      name: "window.update_view",
      operationId: this.idFactory(),
      source: "editor",
      payload: {
        windowId,
        update: pending.update,
        noteId: pending.noteId,
        activeSectionId: pending.activeSectionId,
      },
    })
      .catch((error: unknown) => this.reportError(error))
      .finally(() => {
        if (this.inFlightWindowViewUpdates.get(windowId) === pending) {
          this.inFlightWindowViewUpdates.delete(windowId);
        }
      });
  }

  private activeOutlineSelectionDiffers(
    windowId: string,
    noteId: string,
    activeSectionId: string,
  ): boolean {
    const state = this.applicationWindowState;
    if (!state) return false;
    const tab = activeTab(state);
    return (
      tab.activeWindowId === windowId &&
      (tab.rightSidebar.outline.noteId !== noteId ||
        tab.rightSidebar.outline.selectedSectionId !== activeSectionId)
    );
  }

  private setSaving(): void {
    this.persistenceStatus = "saving";
    this.lastError = null;
    this.emit();
  }

  private setReady(): void {
    this.persistenceStatus = "ready";
    this.lastError = null;
    this.emit();
  }

  private setEditorPersistenceStatus(status: "saving" | "ready"): void {
    this.persistenceStatus = status;
    this.lastError = null;
    if (this.editorPersistenceNotificationTimer !== null) {
      globalThis.clearTimeout(this.editorPersistenceNotificationTimer);
    }
    this.editorPersistenceNotificationTimer = globalThis.setTimeout(() => {
      this.editorPersistenceNotificationTimer = null;
      this.emit();
    }, EDITOR_PERSISTENCE_NOTIFICATION_DEBOUNCE_MS);
  }

  private flushEditorPersistenceNotification(): void {
    if (this.editorPersistenceNotificationTimer === null) return;
    globalThis.clearTimeout(this.editorPersistenceNotificationTimer);
    this.editorPersistenceNotificationTimer = null;
    this.emit();
  }

  private reportError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.persistenceStatus = "error";
    this.lastError = normalized.message;
    this.onError?.(normalized);
    this.emit();
  }

  private emit(): void {
    if (!this.applicationWindowState) return;
    if (this.editorPersistenceNotificationTimer !== null) {
      globalThis.clearTimeout(this.editorPersistenceNotificationTimer);
      this.editorPersistenceNotificationTimer = null;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function sameApplicationFocusOwner(
  left: ApplicationFocusOwner,
  right: ApplicationFocusOwner,
): boolean {
  return (
    left.area === right.area &&
    (left.area !== "window" ||
      (right.area === "window" && left.windowId === right.windowId))
  );
}

function transactionChangesSectionCatalog(transaction: Y.Transaction): boolean {
  for (const changedType of transaction.changed.keys()) {
    const directlyChangedChildren =
      changedType instanceof Y.XmlElement &&
      changedType.nodeName === SECTION_CHILDREN_NODE;
    let current: Y.AbstractType<Y.YEvent<Y.XmlElement>> | null = changedType;
    while (current) {
      if (
        current instanceof Y.XmlElement &&
        current.nodeName === SECTION_HEADER_NODE
      ) {
        return true;
      }
      if (
        current instanceof Y.XmlElement &&
        current.nodeName === SECTION_CHILDREN_NODE &&
        directlyChangedChildren
      ) {
        return true;
      }
      current = current.parent;
    }
  }
  return false;
}

interface NotePersistenceSessionOptions {
  handle: ManagedCrdtDocument<ProductDocument>;
  idFactory: () => string;
  initialUpdatesSinceSnapshot: number;
  initialUpdateBytesSinceSnapshot: number;
  compactionThreshold: number;
  compactionByteThreshold: number;
  persistUpdate: (
    operationId: string,
    update: Uint8Array,
    sectionCatalogChanged: boolean,
  ) => Promise<{ revision: number }>;
  compactSnapshot: (
    operationId: string,
    expectedRevision: number,
  ) => Promise<unknown>;
  onContentChanged?: () => void;
  onMaintenanceError?: (error: Error) => void;
}

class NotePersistenceSession {
  private observedDoc: Y.Doc | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;
  private readonly unsubscribeReplacement: () => void;
  private updateOrdinal: number;
  private updateBytesSinceSnapshot: number;

  constructor(private readonly options: NotePersistenceSessionOptions) {
    if (
      !Number.isSafeInteger(options.initialUpdatesSinceSnapshot) ||
      options.initialUpdatesSinceSnapshot < 0
    ) {
      throw new Error(
        "initialUpdatesSinceSnapshot must be a non-negative safe integer",
      );
    }
    this.updateOrdinal =
      options.initialUpdatesSinceSnapshot % options.compactionThreshold;
    if (
      !Number.isSafeInteger(options.initialUpdateBytesSinceSnapshot) ||
      options.initialUpdateBytesSinceSnapshot < 0
    ) {
      throw new Error(
        "initialUpdateBytesSinceSnapshot must be a non-negative safe integer",
      );
    }
    this.updateBytesSinceSnapshot = options.initialUpdateBytesSinceSnapshot;
    this.attach(options.handle.current.doc);
    this.unsubscribeReplacement = options.handle.subscribe((document) => {
      this.generation += 1;
      this.attach(document.doc);
    });
  }

  async flush(): Promise<void> {
    // An update can be appended while an earlier commit is awaiting the
    // persistence bridge. Observe the chain until its identity stops changing
    // so callers (notably the FTS projection) never consume a live state ahead
    // of the reported durable revision.
    while (true) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) break;
    }
    if (this.lastError) throw this.lastError;
  }

  /**
   * Runs a Core mutation in the same per-Note queue as observed Editor
   * updates. Updates emitted while the mutation is awaiting persistence are
   * appended behind this barrier and therefore start from its new revision.
   */
  runExclusive<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.pending
      .catch(() => undefined)
      .then(() => {
        if (this.lastError) throw this.lastError;
        return action();
      });
    // A structural-command failure is returned to its own caller. It must not
    // poison later Editor persistence, whose update handler already owns its
    // own error reporting and retry boundary.
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  destroy(): void {
    this.unsubscribeReplacement();
    if (this.observedDoc) {
      this.observedDoc.off("update", this.handleUpdate);
    }
    this.observedDoc = null;
  }

  private attach(doc: Y.Doc): void {
    if (this.observedDoc) {
      this.observedDoc.off("update", this.handleUpdate);
    }
    this.observedDoc = doc;
    doc.on("update", this.handleUpdate);
  }

  private readonly handleUpdate = (
    update: Uint8Array,
    origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    if (
      origin === CORE_TRANSACTION_ORIGIN ||
      origin === SECTION_DEPTH_SHIFT_ORIGIN ||
      origin === SECTION_PARAGRAPH_CONVERSION_ORIGIN ||
      origin === NOTE_TIMESTAMP_ORIGIN ||
      origin === PERSISTENCE_LOAD_ORIGIN ||
      origin === BOOTSTRAP_ORIGIN
    ) {
      return;
    }
    const generation = this.generation;
    this.options.onContentChanged?.();
    const operationId = this.options.idFactory();
    const ownedUpdate = update.slice();
    const sectionCatalogChanged = transactionChangesSectionCatalog(transaction);
    this.updateOrdinal += 1;
    this.updateBytesSinceSnapshot += ownedUpdate.byteLength;
    const shouldCompact =
      this.updateOrdinal >= this.options.compactionThreshold ||
      this.updateBytesSinceSnapshot >= this.options.compactionByteThreshold;
    const compactionOperationId = shouldCompact
      ? this.options.idFactory()
      : null;
    if (shouldCompact) {
      this.updateOrdinal = 0;
      this.updateBytesSinceSnapshot = 0;
    }
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.generation) return;
        try {
          const result = await this.options.persistUpdate(
            operationId,
            ownedUpdate,
            sectionCatalogChanged,
          );
          this.lastError = null;
          if (compactionOperationId) {
            try {
              await this.options.compactSnapshot(
                compactionOperationId,
                result.revision,
              );
            } catch (error) {
              const normalized =
                error instanceof Error ? error : new Error(String(error));
              this.options.onMaintenanceError?.(normalized);
            }
          }
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.lastError = normalized;
        }
      });
  };
}

function toApplicationLocalStateCommit(
  state: ApplicationWindowState,
): LocalStateCommit {
  validateApplicationWindowState(state);
  return {
    windowId: APPLICATION_WINDOW_LOCAL_STATE_ID,
    state: structuredClone(state) as unknown as Record<string, unknown>,
  };
}
