import * as Y from "yjs";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { assertUuidV7, createUuidV7, isUuidV7 } from "./ids";
import { yXmlTextVisibleText } from "./yxml-text";
import type { EditorHistory } from "./editor-history";
import { NOTE_RECOVERY_ORIGIN } from "./replicated-note-recovery";
import {
  ReplicatedNote,
  REPLICATED_NOTE_SCHEMA_VERSION,
  replicateSectionSnapshot,
} from "./replicated-note";
import {
  applyReplicatedSectionSnapshot,
  replaceReplicatedInline,
} from "./replicated-note-edit";
import {
  REPLICATED_WORKSPACE_SCHEMA_VERSION,
  normalizeNamespace,
  replicatedNamespace,
  type ReplicatedNamespace,
} from "./replicated-namespace";
import {
  createMainNamespace,
  listNamespaceEntries,
  namespaceEntryMap,
  namespaceNoteEntries,
  readMainNamespace,
  validateNamespace,
} from "./namespace";
import {
  compareSiblingPositions,
  isCanonicalSiblingPosition,
} from "./sibling-position";
import {
  applySectionSnapshot,
  applySectionHierarchySnapshot,
  BODY_CHUNK_NODE,
  childSections,
  createBodyChunks,
  createSectionXml,
  createSectionFromSnapshot,
  deriveSectionCatalog,
  findSectionById,
  findParentSection,
  findSectionWithDepth,
  insertChildSection,
  sectionBodyBlocks,
  planSectionDepthShift,
  sectionBody,
  sectionChildren,
  sectionId,
  sectionSnapshot,
  sectionTitle,
  updateSectionProperties,
  updateSectionTitle,
  validateSectionTree,
  validateSectionSnapshotDepth,
  replaceSectionBodySnapshot,
  SECTION_CHILDREN_NODE,
  SECTION_HEADER_NODE,
  SECTION_NODE,
  type SectionCatalogEntry,
  type SectionDepthShiftDirection,
  type SectionDepthShiftPlan,
  type SectionProperties,
  type SectionSnapshot,
} from "./section-model";

export const NOTE_DOC_SCHEMA_VERSION = 6;
export const WORKSPACE_DOC_SCHEMA_VERSION = 3;
export const NOTE_BODY_FRAGMENT = "body";
export const NOTE_SCHEMA_MIGRATION_ORIGIN = "memoka:note-schema-migration";
export const DOCUMENT_IDENTITY_REPAIR_ORIGIN =
  "memoka:document-identity-repair";

/**
 * Persisted ProseMirror nodes that own a stable block identity.
 *
 * Keep this list shared with the Editor extension so the strict load boundary
 * and newly-created/pasted content cannot drift apart.
 */
export const NOTE_BLOCK_NODE_NAMES: ReadonlySet<string> = new Set([
  "paragraph",
  "blockquote",
  "details",
  "detailsSummary",
  "detailsBody",
  "horizontalRule",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "image",
  "attachment",
  "sourceBlock",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

export type DocumentKind = "workspace" | "note";

export interface BaseCrdtDocument {
  readonly kind: DocumentKind;
  readonly id: string;
  readonly schemaVersion: number;
  readonly doc: Y.Doc;
}

export interface NoteDocument extends BaseCrdtDocument {
  readonly kind: "note";
  readonly noteId: string;
  readonly meta: Y.Map<unknown>;
  /** Legacy XML, or a read projection of the normalized Note. Never persist the projection. */
  readonly rootSection: Y.XmlElement;
  /** Compatibility handle, resolved on access after structural Undo. */
  readonly body: Y.XmlElement;
  readonly undoManager: Y.UndoManager | EditorHistory;
  readonly replicated?: ReplicatedNote;
}

export interface WorkspaceDocument extends BaseCrdtDocument {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly root: Y.Map<unknown>;
  readonly notes: Y.Map<Y.Map<unknown>>;
  readonly replicated?: ReplicatedNamespace;
}

export type ProductDocument = NoteDocument | WorkspaceDocument;

export interface NoteMetadataInput {
  noteId: string;
  entryId?: string;
  parentEntryId?: string | null;
  /** Null identifies a top-level Note. Missing legacy values load as null. */
  parentNoteId?: string | null;
  notePosition: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  trashOperationId?: string;
  systemRole?: "help";
  /** Rebuildable projection of the Root Section title. */
  title?: string;
}

export interface NoteMetadata {
  /** Query-time projection, including organizational groups. Never persisted. */
  readonly namespaceAncestors?: readonly string[];
  noteId: string;
  /** Placement projections are derived from Main Namespace, never stored on Notes. */
  entryId?: string;
  parentNoteId: string | null;
  notePosition: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  trashOperationId?: string;
  systemRole?: "help";
  /** Rebuildable Root Section title cache, never an independent SSOT. */
  title: string;
}

export interface NotePositionMetadataUpdate {
  noteId: string;
  notePosition: string;
}

export interface NotePlacementMetadataUpdate extends NotePositionMetadataUpdate {
  parentNoteId: string | null;
}

export interface TextInline {
  type: "text";
  text: string;
}

export interface InternalSectionLinkInline {
  type: "internalSectionLink";
  text: string;
  targetSectionId: string;
}

export type InlineContent = TextInline | InternalSectionLinkInline;

export interface TableBlock {
  type: "table";
  blockId: string;
  children: TableRowBlock[];
}

export interface TableRowBlock {
  type: "tableRow";
  blockId: string;
  children: TableCellBlock[];
}

export interface TableCellBlock {
  type: "tableCell" | "tableHeader";
  blockId: string;
  alignment?: "left" | "center" | "right";
  children: NoteBlock[];
}

export type NoteBlock =
  | {
      type: "details";
      blockId: string;
      open?: boolean;
      children: NoteBlock[];
    }
  | { type: "detailsSummary"; blockId: string; content: InlineContent[] }
  | { type: "detailsBody"; blockId: string; children: NoteBlock[] }
  | {
      type: "paragraph";
      blockId: string;
      content: InlineContent[];
    }
  | {
      type: "blockquote";
      blockId: string;
      alertType?: string;
      alertTitle?: string;
      alertFold?: "expanded" | "collapsed";
      children: NoteBlock[];
    }
  | {
      type: "horizontalRule";
      blockId: string;
    }
  | {
      type: "bulletList";
      blockId: string;
      children: ListItemBlock[];
    }
  | {
      type: "orderedList";
      blockId: string;
      start?: number;
      children: ListItemBlock[];
    }
  | ListItemBlock
  | {
      type: "codeBlock";
      blockId: string;
      language?: string;
      text: string;
    }
  | {
      type: "sourceBlock";
      blockId: string;
      sourceFormat: "markdown";
      text: string;
    }
  | TableBlock
  | TableRowBlock
  | TableCellBlock
  | {
      type: "image";
      blockId: string;
      attachmentId: string;
      altText: string;
      width?: number;
      alignment?: "left" | "center" | "right";
    }
  | {
      type: "attachment";
      blockId: string;
      attachmentId: string;
      label: string;
    };

export interface ListItemBlock {
  type: "listItem";
  blockId: string;
  children: NoteBlock[];
  checked?: boolean | null;
}

export const PERSISTENCE_LOAD_ORIGIN = "memoka:persistence-load";
export const EXTERNAL_AGENT_EDIT_ORIGIN = "memoka:external-agent-edit";
export const REPLICATED_PUBLICATION_ORIGIN = "memoka:replicated-publication";
export const CORE_TRANSACTION_ORIGIN = "memoka:core-transaction";
export const SECTION_DEPTH_SHIFT_ORIGIN = "memoka:section-depth-shift";
export const SECTION_PARAGRAPH_CONVERSION_ORIGIN =
  "memoka:section-paragraph-conversion";
export const BOOTSTRAP_ORIGIN = "memoka:bootstrap";
export const NOTE_TIMESTAMP_ORIGIN = "memoka:note-timestamp";
export const SECTION_IDENTITY_REPAIR_ORIGIN = "memoka:section-identity-repair";

export interface SectionIdentityRepair {
  readonly update: Uint8Array;
  readonly repairedSectionIds: readonly string[];
  readonly repairedBlockIds: readonly string[];
  readonly migratedFromSchemaVersion: number | null;
}

export interface RecoveredNoteDocumentLoad {
  readonly document: NoteDocument;
  /**
   * One already-applied maintenance update. It can include Section identity
   * recovery, a NoteDoc schema migration, or both, and must cross the Core
   * persistence boundary before the editor is exposed.
   */
  readonly repair: SectionIdentityRepair | null;
}

const noteBlockUtf8Encoder = new TextEncoder();

function approximateNoteBlockBytes(block: NoteBlock): number {
  return noteBlockUtf8Encoder.encode(JSON.stringify(block)).byteLength;
}

export function createNoteDocument(
  noteId: string,
  blocks: NoteBlock[] = [emptyParagraphBlock()],
  title = "",
  timestamps: { createdAt?: string; updatedAt?: string } = {},
  replicaId?: string,
): NoteDocument {
  assertUuidV7(noteId, "noteId");
  const doc = new Y.Doc({ guid: noteId });
  const meta = doc.getMap("meta");
  const fragment = doc.getXmlFragment(NOTE_BODY_FRAGMENT);
  let rootSection!: Y.XmlElement;
  doc.transact(() => {
    meta.set("note_id", noteId);
    meta.set("schema_version", NOTE_DOC_SCHEMA_VERSION);
    meta.set("created_at", timestamps.createdAt ?? "");
    meta.set("updated_at", timestamps.updatedAt ?? timestamps.createdAt ?? "");
    rootSection = createSectionXml(
      noteId,
      title,
      blocks.map(blockToYXml),
      [],
      {},
      blocks.map(approximateNoteBlockBytes),
    );
    fragment.insert(0, [rootSection]);
  }, BOOTSTRAP_ORIGIN);
  if (replicaId) {
    try {
      return createReplicatedNoteDocumentFromSectionSnapshot(
        noteId,
        sectionSnapshot(rootSection),
        replicaId,
        timestamps,
      );
    } finally {
      doc.destroy();
    }
  }
  return noteDocumentFromParts(noteId, doc, meta, rootSection);
}

export function createWorkspaceDocument(
  workspaceId: string,
): WorkspaceDocument {
  assertUuidV7(workspaceId, "workspaceId");
  const doc = new Y.Doc({ guid: `workspace:${workspaceId}` });
  const root = doc.getMap("workspace");
  const notes = new Y.Map<Y.Map<unknown>>();
  doc.transact(() => {
    root.set("workspace_id", workspaceId);
    root.set("schema_version", WORKSPACE_DOC_SCHEMA_VERSION);
    root.set("notes", notes);
    root.set("main_namespace", createMainNamespace());
  }, BOOTSTRAP_ORIGIN);
  return {
    kind: "workspace",
    id: workspaceId,
    workspaceId,
    schemaVersion: WORKSPACE_DOC_SCHEMA_VERSION,
    doc,
    root,
    notes,
  };
}

export function createWorkspaceDocumentFromMetadata(
  workspaceId: string,
  metadata: readonly NoteMetadata[],
): WorkspaceDocument {
  validateNoteMetadataTree(metadata);
  const workspace = createWorkspaceDocument(workspaceId);
  // Equal sibling positions used NoteID as their old tie-break. Assign sorted
  // fresh EntryIDs to sorted NoteIDs so restoring an old metadata projection
  // cannot reorder those siblings just because identities changed.
  const freshIds = metadata.map(() => createUuidV7()).sort();
  const entryIds = new Map(
    metadata
      .map((note) => note.noteId)
      .sort()
      .map((id, index) => [id, freshIds[index]!]),
  );
  workspace.doc.transact(() => {
    for (const note of metadata) {
      workspace.notes.set(note.noteId, metadataToYMap(note));
      const entryId = entryIds.get(note.noteId)!;
      readMainNamespace(workspace.root).entries.set(
        entryId,
        namespaceEntryMap({
          entryId,
          parentEntryId:
            note.parentNoteId === null
              ? null
              : entryIds.get(note.parentNoteId)!,
          position: note.notePosition,
          target: { kind: "note", id: note.noteId },
          name: null,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          deletedAt: note.deletedAt,
          trashOperationId: note.trashOperationId,
        }),
      );
    }
  }, BOOTSTRAP_ORIGIN);
  validateWorkspaceMetadata(workspace);
  return workspace;
}

/** Conversion is isolated from the original document and preserves all product IDs. */
export function createReplicatedWorkspaceDocument(
  source: WorkspaceDocument,
  replicaId: string,
): WorkspaceDocument {
  validateWorkspaceMetadata(source);
  if (source.replicated) throw new Error("Workspace is already normalized");
  const entries = listNamespaceEntries(source.root);
  const doc = new Y.Doc({ guid: `workspace:${source.workspaceId}`, gc: false });
  try {
    Y.applyUpdate(
      doc,
      Y.encodeStateAsUpdate(source.doc),
      PERSISTENCE_LOAD_ORIGIN,
    );
    normalizeNamespace(doc.getMap("workspace"), entries, replicaId);
    const candidate = workspaceDocumentFromYDoc(
      source.workspaceId,
      doc,
      replicaId,
    );
    if (
      JSON.stringify(listNamespaceEntries(candidate.root)) !==
        JSON.stringify(entries) ||
      JSON.stringify(listNoteMetadata(candidate)) !==
        JSON.stringify(listNoteMetadata(source))
    )
      throw new Error("Workspace conversion changed content or identity");
    return candidate;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function createNoteDocumentFromSectionSnapshot(
  noteId: string,
  snapshot: SectionSnapshot,
  timestamps: { createdAt?: string; updatedAt?: string } = {},
): NoteDocument {
  assertUuidV7(noteId, "noteId");
  if (snapshot.sectionId !== noteId) {
    throw new Error("Root Section ID must equal Note ID");
  }
  validateSectionSnapshotDepth(snapshot);
  const doc = new Y.Doc({ guid: noteId });
  const meta = doc.getMap("meta");
  const fragment = doc.getXmlFragment(NOTE_BODY_FRAGMENT);
  const rootSection = createSectionFromSnapshot(snapshot);
  doc.transact(() => {
    meta.set("note_id", noteId);
    meta.set("schema_version", NOTE_DOC_SCHEMA_VERSION);
    meta.set("created_at", timestamps.createdAt ?? "");
    meta.set("updated_at", timestamps.updatedAt ?? timestamps.createdAt ?? "");
    fragment.insert(0, [rootSection]);
  }, BOOTSTRAP_ORIGIN);
  return noteDocumentFromParts(noteId, doc, meta, rootSection);
}

export function loadProductDocument(
  kind: DocumentKind,
  documentId: string,
  snapshot: Uint8Array,
  updates: Uint8Array[] = [],
  replicaId = localReplicaId,
): ProductDocument {
  const doc = new Y.Doc({
    guid: kind === "workspace" ? `workspace:${documentId}` : documentId,
    gc: false,
  });
  try {
    Y.applyUpdate(doc, snapshot, PERSISTENCE_LOAD_ORIGIN);
    for (const update of updates) {
      Y.applyUpdate(doc, update, PERSISTENCE_LOAD_ORIGIN);
    }
    if (doc.store.pendingStructs || doc.store.pendingDs)
      throw new Error("Yjs update dependencies are missing");
    return kind === "workspace"
      ? workspaceDocumentFromYDoc(documentId, doc, replicaId)
      : noteDocumentFromYDoc(documentId, doc, replicaId);
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/**
 * Reconstructs a NoteDoc while preserving the normal strict load boundary.
 *
 * One pre-release editor defect could remove an integrated SectionHeader's
 * `sectionId` attribute. Valid UUIDs observed while applying the persisted
 * update history can recover that omission without inventing a new identity.
 *
 * A structural ProseMirror replacement may reuse an integrated Y.XmlElement
 * for a different logical Section while recreating the previous Section with
 * its original ID. The Yjs object reference therefore is not itself a product
 * Section identity. Valid-to-valid changes on that internal object are
 * accepted when the final Section tree is valid and unique. A missing final
 * ID is recoverable only when exactly one historical valid UUID is not already
 * claimed by the final tree. Non-empty invalid IDs, ambiguous history and
 * duplicates still fail closed. The caller must append `repair.update`
 * through a Core transaction before it exposes the document to an editor.
 */
export function loadNoteDocumentWithSectionIdentityRecovery(
  noteId: string,
  snapshot: Uint8Array,
  updates: readonly Uint8Array[] = [],
  replicaId = localReplicaId,
): RecoveredNoteDocumentLoad {
  assertUuidV7(noteId, "noteId");
  const doc = new Y.Doc({ guid: noteId, gc: false });
  const knownIds = new Map<Y.XmlElement, Set<string>>();
  const observeIdentities = (): void => {
    for (const { section, header } of rawSectionIdentityEntries(doc)) {
      const rawId = header.getAttribute("sectionId");
      if (typeof rawId !== "string" || !isUuidV7(rawId)) continue;
      const observed = knownIds.get(section) ?? new Set<string>();
      observed.add(rawId);
      knownIds.set(section, observed);
    }
  };

  try {
    Y.applyUpdate(doc, snapshot, PERSISTENCE_LOAD_ORIGIN);
    if (
      doc.getMap("meta").get("schema_version") ===
      REPLICATED_NOTE_SCHEMA_VERSION
    ) {
      for (const update of updates)
        Y.applyUpdate(doc, update, PERSISTENCE_LOAD_ORIGIN);
      return {
        document: replicatedDocumentFromYDoc(noteId, doc, replicaId),
        repair: null,
      };
    }
    observeIdentities();
    for (const update of updates) {
      Y.applyUpdate(doc, update, PERSISTENCE_LOAD_ORIGIN);
      observeIdentities();
    }

    const entries = rawSectionIdentityEntries(doc);
    const repairedSectionIds: string[] = [];
    const repairs: Array<{ header: Y.XmlElement; sectionId: string }> = [];
    const finalIds = new Set<string>();
    const missingEntries: Array<{
      section: Y.XmlElement;
      header: Y.XmlElement;
    }> = [];
    for (const { section, header } of entries) {
      const rawId = header.getAttribute("sectionId");
      if (typeof rawId === "string" && isUuidV7(rawId)) {
        if (finalIds.has(rawId)) {
          throw new Error(`Duplicate Section ID: ${rawId}`);
        }
        finalIds.add(rawId);
        continue;
      }
      const isMissing = rawId === undefined || rawId === null || rawId === "";
      if (!isMissing) {
        throw new Error(
          "Persisted Section identity is invalid and cannot be recovered from update history",
        );
      }
      missingEntries.push({ section, header });
    }

    for (const { section, header } of missingEntries) {
      const candidates = [...(knownIds.get(section) ?? [])].filter(
        (sectionId) => !finalIds.has(sectionId),
      );
      if (candidates.length !== 1) {
        throw new Error(
          "Persisted Section identity is invalid and cannot be recovered from update history",
        );
      }
      const sectionId = candidates[0]!;
      finalIds.add(sectionId);
      repairs.push({ header, sectionId });
      repairedSectionIds.push(sectionId);
    }

    const rawSchemaVersion = doc.getMap("meta").get("schema_version");
    const migratedFromSchemaVersion =
      rawSchemaVersion === 2 ||
      rawSchemaVersion === 3 ||
      rawSchemaVersion === 4 ||
      rawSchemaVersion === 5
        ? rawSchemaVersion
        : null;
    const maintenanceStateVector = Y.encodeStateVector(doc);
    if (repairs.length > 0) {
      doc.transact(() => {
        for (const { header, sectionId } of repairs) {
          header.setAttribute("sectionId", sectionId);
        }
      }, SECTION_IDENTITY_REPAIR_ORIGIN);
    }

    const document = noteDocumentFromYDoc(noteId, doc);
    const repairedBlockIds = repairPersistedBlockIdentities(document);
    const maintenanceUpdate = Y.encodeStateAsUpdate(
      doc,
      maintenanceStateVector,
    );
    const maintenanceWasApplied =
      repairs.length > 0 ||
      repairedBlockIds.length > 0 ||
      migratedFromSchemaVersion !== null;
    const repair: SectionIdentityRepair | null = maintenanceWasApplied
      ? {
          update: maintenanceUpdate,
          repairedSectionIds,
          repairedBlockIds,
          migratedFromSchemaVersion,
        }
      : null;

    return {
      document,
      repair,
    };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

function repairPersistedBlockIdentities(note: NoteDocument): string[] {
  const entries: Y.XmlElement[] = [];
  const pending = [note.rootSection];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (NOTE_BLOCK_NODE_NAMES.has(element.nodeName)) entries.push(element);
    const children = element.toArray();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child instanceof Y.XmlElement) pending.push(child);
    }
  }

  const byId = new Map<string, Y.XmlElement[]>();
  const repair = new Set<Y.XmlElement>();
  const occupied = new Set<string>();
  for (const element of entries) {
    const checked =
      element.nodeName === "listItem"
        ? element.getAttribute("checked")
        : undefined;
    if (
      checked !== undefined &&
      checked !== null &&
      typeof checked !== "boolean"
    ) {
      throw new Error("Task checked must be boolean or null");
    }
    const value = element.getAttribute("blockId");
    const blockId = typeof value === "string" ? value : "";
    if (!blockId) {
      repair.add(element);
      continue;
    }
    if (!isUuidV7(blockId)) {
      throw new Error(
        "Persisted block identity is invalid and cannot be recovered",
      );
    }
    occupied.add(blockId);
    const duplicates = byId.get(blockId) ?? [];
    duplicates.push(element);
    byId.set(blockId, duplicates);
  }
  for (const duplicates of byId.values()) {
    if (duplicates.length < 2) continue;
    // No member of a duplicate group has a defensible claim to the identity.
    // Re-identifying every member avoids making document order an identity
    // tie-breaker and makes a second load idempotent after persistence.
    for (const element of duplicates) repair.add(element);
  }
  if (repair.size === 0) return [];

  const repairedBlockIds: string[] = [];
  note.doc.transact(() => {
    for (const element of entries) {
      if (!repair.has(element)) continue;
      let blockId = createUuidV7();
      while (occupied.has(blockId)) blockId = createUuidV7();
      occupied.add(blockId);
      element.setAttribute("blockId", blockId);
      repairedBlockIds.push(blockId);
    }
  }, DOCUMENT_IDENTITY_REPAIR_ORIGIN);
  return repairedBlockIds;
}

function rawSectionIdentityEntries(
  doc: Y.Doc,
): Array<{ section: Y.XmlElement; header: Y.XmlElement }> {
  const fragment = doc.getXmlFragment(NOTE_BODY_FRAGMENT);
  if (fragment.length !== 1) return [];
  const root = fragment.get(0);
  if (!(root instanceof Y.XmlElement) || root.nodeName !== SECTION_NODE) {
    return [];
  }
  const result: Array<{ section: Y.XmlElement; header: Y.XmlElement }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const section = pending.pop()!;
    const header = section.get(0);
    if (
      header instanceof Y.XmlElement &&
      header.nodeName === SECTION_HEADER_NODE
    ) {
      result.push({ section, header });
    }
    const children = section.get(2);
    if (
      !(children instanceof Y.XmlElement) ||
      children.nodeName !== SECTION_CHILDREN_NODE
    ) {
      continue;
    }
    const values = children.toArray();
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const child = values[index];
      if (child instanceof Y.XmlElement && child.nodeName === SECTION_NODE) {
        pending.push(child);
      }
    }
  }
  return result;
}

export function cloneProductDocument(
  document: ProductDocument,
): ProductDocument {
  return loadProductDocument(
    document.kind,
    document.id,
    Y.encodeStateAsUpdate(document.doc),
    [],
    document.replicated?.replicaId,
  );
}

export function encodeProductDocument(document: ProductDocument): Uint8Array {
  return Y.encodeStateAsUpdate(document.doc);
}

export function addNoteMetadata(
  workspace: WorkspaceDocument,
  input: NoteMetadataInput,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  assertUuidV7(input.noteId, "noteId");
  if (workspace.notes.has(input.noteId)) {
    throw new Error(`Duplicate note: ${input.noteId}`);
  }
  const notePosition = input.notePosition;
  if (!notePosition) throw new Error("Note position must not be empty");
  if (!isCanonicalSiblingPosition(notePosition)) {
    throw new Error("Note position must be a canonical fractional index");
  }
  const parentNoteId = input.parentNoteId ?? null;
  const noteEntries = namespaceNoteEntries(workspace.root);
  const parentEntryId =
    input.parentEntryId !== undefined
      ? input.parentEntryId
      : parentNoteId === null
        ? null
        : noteEntries.get(parentNoteId)?.entryId;
  if (parentEntryId === undefined)
    throw new Error("Unknown parent Note placement");
  const { entries } = readMainNamespace(workspace.root);
  if (parentEntryId !== null) {
    const parent = listNamespaceEntries(workspace.root).find(
      (entry) => entry.entryId === parentEntryId && !entry.deletedAt,
    );
    if (!parent) throw new Error("Unknown live Namespace parent");
  }
  const entryId = input.entryId ?? createUuidV7();
  assertUuidV7(entryId, "entryId");
  if (entryId === input.noteId || entries.has(entryId))
    throw new Error("Duplicate Namespace entry identity");
  if (input.title !== undefined) validateTitle(input.title);
  workspace.doc.transact(() => {
    workspace.notes.set(
      input.noteId,
      metadataToYMap(input, !!workspace.replicated),
    );
    const entry = {
      entryId,
      parentEntryId,
      position: notePosition,
      target: { kind: "note" as const, id: input.noteId },
      name: null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      deletedAt: input.deletedAt,
      trashOperationId: input.trashOperationId,
    };
    if (workspace.replicated) {
      workspace.replicated.writeEntries([entry], new Set([entryId]));
      return;
    }
    entries.set(entryId, namespaceEntryMap(entry));
  }, origin);
}

export function readNoteMetadata(
  workspace: WorkspaceDocument,
  noteId: string,
): NoteMetadata | undefined {
  const value = workspace.notes.get(noteId);
  if (!value) return undefined;
  return projectNoteMetadata(noteId, value, metadataPlacementIndex(workspace));
}

function metadataPlacementIndex(workspace: WorkspaceDocument) {
  const entries = listNamespaceEntries(workspace.root);
  return {
    byNote: new Map(
      entries.flatMap((entry) =>
        entry.target ? [[entry.target.id, entry] as const] : [],
      ),
    ),
    byId: new Map(entries.map((entry) => [entry.entryId, entry])),
    titles: new Map(
      [...workspace.notes].map(([id, note]) => [
        id,
        String(note.get("title_cache") ?? ""),
      ]),
    ),
  };
}

function projectNoteMetadata(
  noteId: string,
  value: Y.Map<unknown>,
  { byNote, byId, titles }: ReturnType<typeof metadataPlacementIndex>,
): NoteMetadata {
  const entry = byNote.get(noteId);
  if (!entry) throw new Error("Note has no Namespace placement");
  let parent =
    entry.parentEntryId === null ? undefined : byId.get(entry.parentEntryId);
  const visited = new Set<string>();
  while (parent && !parent.target) {
    if (visited.has(parent.entryId))
      throw new Error("Namespace contains a cycle");
    visited.add(parent.entryId);
    parent =
      parent.parentEntryId === null
        ? undefined
        : byId.get(parent.parentEntryId);
  }
  const parentNoteId = parent?.target?.id ?? null;
  const systemRole = value.get("system_role");
  return {
    noteId,
    entryId: entry.entryId,
    get namespaceAncestors() {
      const names: string[] = [];
      let cursor =
        entry.parentEntryId === null
          ? undefined
          : byId.get(entry.parentEntryId);
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor.entryId))
          throw new Error("Namespace contains a cycle");
        seen.add(cursor.entryId);
        names.push(
          cursor.target
            ? titles.get(cursor.target.id) || "新しいノート"
            : cursor.name || "無題のグループ",
        );
        cursor =
          cursor.parentEntryId === null
            ? undefined
            : byId.get(cursor.parentEntryId);
      }
      return names.reverse();
    },
    parentNoteId,
    notePosition: entry.position,
    title: String(value.get("title_cache") ?? ""),
    createdAt: String(value.get("created_at")),
    updatedAt: String(value.get("updated_at")),
    deletedAt: entry.deletedAt,
    trashOperationId: entry.trashOperationId,
    systemRole: systemRole === "help" ? "help" : undefined,
  };
}

export function listNoteMetadata(workspace: WorkspaceDocument): NoteMetadata[] {
  const index = metadataPlacementIndex(workspace);
  return [...workspace.notes.entries()]
    .map(([noteId, value]) => projectNoteMetadata(noteId, value, index))
    .sort(
      (left, right) =>
        compareSiblingPositions(left.notePosition, right.notePosition) ||
        compareIdentifiers(left.entryId!, right.entryId!),
    );
}

export function synchronizeNoteTitleCache(
  workspace: WorkspaceDocument,
  noteId: string,
  title: string,
  updatedAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  validateTitle(title);
  const value = requireMetadata(workspace, noteId);
  if (workspace.replicated && value.get("system_role") === "help") return;
  workspace.doc.transact(() => {
    value.set("title_cache", title);
    value.set("updated_at", updatedAt);
  }, origin);
}

/** @deprecated Use a transaction that updates Root Section and its cache. */
export const renameNoteMetadata = synchronizeNoteTitleCache;

export function updateNotePlacements(
  workspace: WorkspaceDocument,
  updates: readonly NotePlacementMetadataUpdate[],
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  const current = new Map(
    listNoteMetadata(workspace).map((metadata) => [
      metadata.noteId,
      { ...metadata },
    ]),
  );
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.noteId)) {
      throw new Error(`Duplicate note placement: ${update.noteId}`);
    }
    seen.add(update.noteId);
    assertUuidV7(update.noteId, "noteId");
    if (update.parentNoteId !== null) {
      assertUuidV7(update.parentNoteId, "parentNoteId");
    }
    if (!isCanonicalSiblingPosition(update.notePosition)) {
      throw new Error("Note position must be a canonical fractional index");
    }
    const metadata = current.get(update.noteId);
    if (!metadata || metadata.deletedAt) {
      throw new Error(`Unknown live note: ${update.noteId}`);
    }
    current.set(update.noteId, {
      ...metadata,
      parentNoteId: update.parentNoteId,
      notePosition: update.notePosition,
    });
  }
  validateNoteMetadataTree([...current.values()]);
  if (workspace.replicated) {
    const noteEntries = namespaceNoteEntries(workspace.root);
    const planned = updates.map((update) => ({
      ...noteEntries.get(update.noteId)!,
      parentEntryId:
        update.parentNoteId === null
          ? null
          : noteEntries.get(update.parentNoteId)!.entryId,
      position: update.notePosition,
    }));
    workspace.doc.transact(
      () =>
        workspace.replicated!.writeEntries(
          planned,
          new Set(planned.map((entry) => entry.entryId)),
        ),
      origin,
    );
    return;
  }
  const values = updates.map((update) => ({
    value: readMainNamespace(workspace.root).entries.get(
      current.get(update.noteId)!.entryId!,
    )!,
    update,
  }));
  const noteEntries = namespaceNoteEntries(workspace.root);
  workspace.doc.transact(() => {
    for (const { value, update } of values) {
      value.set(
        "parent_entry_id",
        update.parentNoteId === null
          ? null
          : noteEntries.get(update.parentNoteId)!.entryId,
      );
      value.set("position", update.notePosition);
    }
  }, origin);
}

export function moveNotesToTrash(
  workspace: WorkspaceDocument,
  noteIds: readonly string[],
  deletedAt: string,
  trashOperationId: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (noteIds.length === 0) {
    throw new Error("Moving notes to Trash requires at least one note");
  }
  if (workspace.replicated) {
    updateReplicatedTrash(
      workspace,
      noteIds,
      deletedAt,
      trashOperationId,
      origin,
    );
    return;
  }
  const values = noteIds.map((noteId) => {
    const value = requireMetadata(workspace, noteId);
    if (value.get("deleted_at") !== null) {
      throw new Error(`Note is already in Trash: ${noteId}`);
    }
    return value;
  });
  workspace.doc.transact(() => {
    const entries = readMainNamespace(workspace.root).entries;
    const noteEntries = namespaceNoteEntries(workspace.root);
    for (const [index, value] of values.entries()) {
      value.set("deleted_at", deletedAt);
      value.set("trash_operation_id", trashOperationId);
      value.set("updated_at", deletedAt);
      const entry = entries.get(noteEntries.get(noteIds[index]!)!.entryId)!;
      entry.set("deleted_at", deletedAt);
      entry.set("trash_operation_id", trashOperationId);
    }
  }, origin);
}

export function restoreNotesFromTrash(
  workspace: WorkspaceDocument,
  noteIds: readonly string[],
  restoredAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (noteIds.length === 0) {
    throw new Error("Restoring from Trash requires at least one note");
  }
  if (workspace.replicated) {
    updateReplicatedTrash(workspace, noteIds, restoredAt, undefined, origin);
    return;
  }
  const values = noteIds.map((noteId) => {
    const value = requireMetadata(workspace, noteId);
    if (value.get("deleted_at") === null) {
      throw new Error(`Note is not in Trash: ${noteId}`);
    }
    return value;
  });
  workspace.doc.transact(() => {
    const entries = readMainNamespace(workspace.root).entries;
    const noteEntries = namespaceNoteEntries(workspace.root);
    for (const [index, value] of values.entries()) {
      value.set("deleted_at", null);
      value.set("trash_operation_id", null);
      value.set("updated_at", restoredAt);
      const entry = entries.get(noteEntries.get(noteIds[index]!)!.entryId)!;
      entry.set("deleted_at", null);
      entry.set("trash_operation_id", null);
    }
  }, origin);
}

function updateReplicatedTrash(
  workspace: WorkspaceDocument,
  noteIds: readonly string[],
  at: string,
  deletionId: string | undefined,
  origin: unknown,
): void {
  const entries = namespaceNoteEntries(workspace.root);
  const planned = noteIds.map((id) => {
    const entry = entries.get(id);
    if (!entry || !!entry.deletedAt === !!deletionId)
      throw new Error("Invalid Note Trash state");
    return {
      ...entry,
      updatedAt: at,
      deletedAt: deletionId ? at : undefined,
      trashOperationId: deletionId,
    };
  });
  workspace.doc.transact(() => {
    workspace.replicated!.writeEntries(
      planned,
      new Set(planned.map((entry) => entry.entryId)),
    );
    for (const id of noteIds)
      requireMetadata(workspace, id).set("updated_at", at);
  }, origin);
}

export function synchronizeManagedNoteMetadata(
  workspace: WorkspaceDocument,
  noteId: string,
  input: { title: string; updatedAt: string },
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  const value = requireMetadata(workspace, noteId);
  if (workspace.replicated && value.get("system_role") === "help") return;
  workspace.doc.transact(() => {
    value.set("title_cache", input.title);
    value.set("updated_at", input.updatedAt);
    value.set("system_role", "help");
  }, origin);
}

export function replaceNoteBlocks(
  note: NoteDocument,
  blocks: readonly NoteBlock[],
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      replaceNoteBlocks(projection, blocks, origin),
    );
  if (blocks.length === 0) {
    throw new Error("Root Section body requires at least one block");
  }
  note.doc.transact(() => {
    note.body.delete(0, note.body.length);
    note.body.insert(
      0,
      createBodyChunks(
        blocks.map(blockToYXml),
        blocks.map(approximateNoteBlockBytes),
      ),
    );
  }, origin);
}

export function replaceNoteSectionTree(
  note: NoteDocument,
  snapshot: SectionSnapshot,
  updatedAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (note.replicated) {
    note.replicated.transact(() => {
      applyReplicatedSectionSnapshot(note.replicated!, snapshot, origin);
      note.meta.set("updated_at", updatedAt);
    }, origin);
    return;
  }
  if (snapshot.sectionId !== note.noteId) {
    throw new Error("Root Section ID must equal Note ID");
  }
  validateSectionSnapshotDepth(snapshot);
  note.doc.transact(() => {
    applySectionSnapshot(note.rootSection, snapshot);
    note.meta.set("updated_at", updatedAt);
  }, origin);
}

export function planNoteSectionDepthShift(
  note: NoteDocument,
  boundarySectionId: string,
  targetSectionIds: readonly string[],
  direction: SectionDepthShiftDirection,
): SectionDepthShiftPlan {
  const boundary = findSectionById(note.rootSection, boundarySectionId);
  if (!boundary)
    throw new Error(`Unknown Focused Section: ${boundarySectionId}`);
  const plan = planSectionDepthShift(
    sectionSnapshot(boundary),
    targetSectionIds,
    direction,
  );
  validateSectionSnapshotDepth(
    plan.snapshot,
    findSectionWithDepth(note.rootSection, boundarySectionId)!.depth,
  );
  return plan;
}

export function applyNoteSectionDepthShift(
  note: NoteDocument,
  boundarySectionId: string,
  plan: SectionDepthShiftPlan,
  updatedAt: string,
  origin: unknown = SECTION_DEPTH_SHIFT_ORIGIN,
): void {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      applyNoteSectionDepthShift(
        projection,
        boundarySectionId,
        plan,
        updatedAt,
        origin,
      ),
    );
  if (!plan.changed) return;
  const boundary = findSectionById(note.rootSection, boundarySectionId);
  if (!boundary)
    throw new Error(`Unknown Focused Section: ${boundarySectionId}`);
  if (plan.snapshot.sectionId !== boundarySectionId) {
    throw new Error("Section depth plan does not match its Focused Section");
  }
  validateSectionSnapshotDepth(
    plan.snapshot,
    findSectionWithDepth(note.rootSection, boundarySectionId)!.depth,
  );
  note.doc.transact(() => {
    applySectionHierarchySnapshot(boundary, plan.snapshot);
    note.meta.set("updated_at", updatedAt);
  }, origin);
}

/**
 * Inserts a fully prepared Section beside a non-Root target. Focused Section
 * editors mount only the target subtree, so this parent-level edit cannot be
 * represented by a ProseMirror transaction inside that view.
 */
export function putNoteSectionSibling(
  note: NoteDocument,
  targetSectionId: string,
  snapshot: SectionSnapshot,
  direction: "after" | "before",
  origin: unknown = ySyncPluginKey,
): boolean {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      putNoteSectionSibling(
        projection,
        targetSectionId,
        snapshot,
        direction,
        origin,
      ),
    );
  const target = findSectionById(note.rootSection, targetSectionId);
  const parent = target
    ? findParentSection(note.rootSection, targetSectionId)
    : null;
  if (!target || !parent) return false;
  const targetIndex = childSections(parent).findIndex(
    (child) => sectionId(child) === targetSectionId,
  );
  if (targetIndex < 0) return false;
  validateSectionSnapshotDepth(
    snapshot,
    findSectionWithDepth(note.rootSection, targetSectionId)!.depth,
  );
  const inserted = createSectionFromSnapshot(snapshot);
  note.doc.transact(() => {
    insertChildSection(
      parent,
      inserted,
      targetIndex + (direction === "after" ? 1 : 0),
    );
  }, origin);
  return true;
}

export interface NoteSectionFromParagraphResult {
  readonly changed: boolean;
  readonly createdSectionId: string | null;
}

function snapshotBlockIdentity(value: unknown): {
  type: string;
  blockId: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    type?: unknown;
    attrs?: { blockId?: unknown };
  };
  return typeof record.type === "string" &&
    typeof record.attrs?.blockId === "string"
    ? { type: record.type, blockId: record.attrs.blockId }
    : null;
}

/**
 * Splits a Section at one direct body Paragraph and promotes that Paragraph's
 * visible text to a plain Section title. The caller supplies the flattened
 * title because only the mounted editor can resolve dynamic inline labels.
 */
export function createNoteSectionFromParagraph(
  note: NoteDocument,
  request: {
    boundarySectionId: string;
    sourceSectionId: string;
    paragraphBlockId: string;
    paragraphBodyIndex: number;
    newSectionId: string;
    title: string;
    direction: SectionDepthShiftDirection;
    updatedAt: string;
  },
  origin: unknown = SECTION_PARAGRAPH_CONVERSION_ORIGIN,
): NoteSectionFromParagraphResult {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      createNoteSectionFromParagraph(projection, request, origin),
    );
  const boundary = findSectionById(note.rootSection, request.boundarySectionId);
  if (!boundary) {
    throw new Error(`Unknown Focused Section: ${request.boundarySectionId}`);
  }
  const source = findSectionById(boundary, request.sourceSectionId);
  if (!source) {
    throw new Error(
      `Paragraph Section is outside the Focused Section: ${request.sourceSectionId}`,
    );
  }
  const sourceSnapshot = sectionSnapshot(source);
  const requestedParagraph = sourceSnapshot.body[request.paragraphBodyIndex];
  const requestedIdentity = snapshotBlockIdentity(requestedParagraph);
  const requestedIndexMatches =
    requestedIdentity?.type === "paragraph" &&
    requestedIdentity.blockId === request.paragraphBlockId;
  const matchingIndexes = sourceSnapshot.body.flatMap((value, index) => {
    const identity = snapshotBlockIdentity(value);
    return identity?.type === "paragraph" &&
      identity.blockId === request.paragraphBlockId
      ? [index]
      : [];
  });
  // Position disambiguates historical documents created while Enter could
  // copy one blockId to both halves of a split Paragraph. If the document has
  // moved since the request was captured, only a unique identity is safe.
  const paragraphIndex = requestedIndexMatches
    ? request.paragraphBodyIndex
    : matchingIndexes.length === 1
      ? matchingIndexes[0]!
      : -1;
  if (paragraphIndex < 0) {
    return { changed: false, createdSectionId: null };
  }

  const parent = findParentSection(note.rootSection, request.sourceSectionId);
  if (request.direction === "shallower" && (!parent || source === boundary)) {
    return { changed: false, createdSectionId: null };
  }
  const parentIndex = parent
    ? childSections(parent).findIndex(
        (child) => sectionId(child) === request.sourceSectionId,
      )
    : -1;
  if (request.direction === "shallower" && parentIndex < 0) {
    throw new Error("Paragraph Section parent disappeared before conversion");
  }

  const prefix = sourceSnapshot.body.slice(0, paragraphIndex);
  const suffix = sourceSnapshot.body.slice(paragraphIndex + 1);
  const movedChildren =
    request.direction === "shallower" ? sourceSnapshot.children : [];
  const createdSnapshot: SectionSnapshot = {
    sectionId: request.newSectionId,
    title: request.title,
    tags: [],
    body: suffix,
    children: movedChildren,
  };
  const sourceDepth = findSectionWithDepth(
    note.rootSection,
    request.sourceSectionId,
  )!.depth;
  validateSectionSnapshotDepth(
    createdSnapshot,
    sourceDepth + (request.direction === "deeper" ? 1 : 0),
  );
  const created = createSectionFromSnapshot(createdSnapshot);

  note.doc.transact(() => {
    replaceSectionBodySnapshot(source, prefix);
    if (request.direction === "deeper") {
      sectionChildren(source).insert(0, [created]);
    } else {
      const sourceChildren = sectionChildren(source);
      if (sourceChildren.length > 0) {
        sourceChildren.delete(0, sourceChildren.length);
      }
      sectionChildren(parent!).insert(parentIndex + 1, [created]);
    }
    note.meta.set("updated_at", request.updatedAt);
    validateSectionTree(note.rootSection, note.noteId);
  }, origin);
  return { changed: true, createdSectionId: request.newSectionId };
}

export function replaceFirstTextBlock(
  note: NoteDocument,
  text: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      replaceFirstTextBlock(projection, text, origin),
    );
  const first = findFirstEditableTextBlock(note.rootSection);
  if (!first) throw new Error("NoteDoc has no editable text block");
  let yText = first
    .toArray()
    .find((value): value is Y.XmlText => value instanceof Y.XmlText);
  note.doc.transact(() => {
    if (!yText) {
      yText = new Y.XmlText();
      first.insert(0, [yText]);
    }
    yText.delete(0, yText.length);
    if (text.length > 0) yText.insert(0, text);
  }, origin);
}

export function readNoteTitle(note: NoteDocument): string {
  if (note.replicated)
    return note.replicated
      .inlineContent(note.noteId)
      .map((node) => node.text ?? "")
      .join("");
  return sectionTitle(note.rootSection);
}

export function readNoteDisplayTitle(note: NoteDocument): string {
  return noteDisplayTitle(readNoteTitle(note));
}

export function renameRootSection(
  note: NoteDocument,
  title: string,
  updatedAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (note.replicated) {
    validateTitle(title);
    note.replicated.transact(() => {
      replaceReplicatedInline(
        note.replicated!.inline(note.noteId),
        title ? [{ type: "text", text: title }] : [],
      );
      note.meta.set("updated_at", updatedAt);
    }, origin);
    return;
  }
  note.doc.transact(() => {
    updateSectionTitle(note.rootSection, title);
    note.meta.set("updated_at", updatedAt);
  }, origin);
}

export function setSectionProperties(
  note: NoteDocument,
  targetSectionId: string,
  properties: Partial<SectionProperties>,
  updatedAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  if (note.replicated)
    return editReplicatedProjection(note, origin, (projection) =>
      setSectionProperties(
        projection,
        targetSectionId,
        properties,
        updatedAt,
        origin,
      ),
    );
  const section = findSectionById(note.rootSection, targetSectionId);
  if (!section) throw new Error(`Unknown Section: ${targetSectionId}`);
  note.doc.transact(() => {
    updateSectionProperties(section, properties);
    note.meta.set("updated_at", updatedAt);
  }, origin);
}

export function touchNoteDocument(
  note: NoteDocument,
  updatedAt: string,
  origin: unknown = NOTE_TIMESTAMP_ORIGIN,
): Uint8Array | null {
  const before = Y.encodeStateVector(note.doc);
  note.doc.transact(() => note.meta.set("updated_at", updatedAt), origin);
  const update = Y.encodeStateAsUpdate(note.doc, before);
  return update.length > 2 ? update : null;
}

export function readNoteUpdatedAt(note: NoteDocument): string {
  return String(note.meta.get("updated_at") ?? "");
}

export function noteSectionCatalog(note: NoteDocument): SectionCatalogEntry[] {
  return deriveSectionCatalog(note.noteId, note.rootSection);
}

export function readNotePlainText(note: NoteDocument): string {
  const parts: string[] = [];
  const pending = [note.rootSection];
  while (pending.length > 0) {
    const section = pending.pop()!;
    for (const child of sectionBodyBlocks(section))
      appendPlainText(child, parts);
    const catalog = deriveSectionCatalog(note.noteId, section).slice(1);
    // deriveSectionCatalog is preorder; append child titles and bodies in one
    // deterministic pass without recursive JS stack growth.
    for (const entry of catalog) {
      parts.push("\n", entry.title, "\n");
      for (const child of sectionBodyBlocks(entry.element)) {
        appendPlainText(child, parts);
      }
    }
    break;
  }
  return parts.join("").replace(/\n+$/u, "");
}

export function validateTitle(title: string): void {
  if (title.includes("\n") || title.includes("\r")) {
    throw new Error("Note title must be a single line");
  }
}

export function blockToYXml(block: NoteBlock): Y.XmlElement {
  const element = new Y.XmlElement(block.type);
  element.setAttribute("blockId", block.blockId);
  switch (block.type) {
    case "paragraph":
    case "detailsSummary":
      insertInlineContent(element, block.content);
      break;
    case "orderedList":
      element.setAttribute("start", (block.start ?? 1) as unknown as string);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "listItem":
      if (typeof block.checked === "boolean")
        element.setAttribute("checked", block.checked as unknown as string);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "bulletList":
    case "table":
    case "tableRow":
    case "detailsBody":
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "details":
      element.setAttribute("open", (block.open ?? true) as unknown as string);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "blockquote":
      if (block.alertType) element.setAttribute("alertType", block.alertType);
      if (block.alertTitle)
        element.setAttribute("alertTitle", block.alertTitle);
      if (block.alertFold) element.setAttribute("alertFold", block.alertFold);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "horizontalRule":
      break;
    case "tableCell":
    case "tableHeader":
      if (block.alignment) element.setAttribute("align", block.alignment);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "codeBlock":
    case "sourceBlock": {
      if (block.type === "codeBlock" && block.language) {
        element.setAttribute("language", block.language);
      }
      if (block.type === "sourceBlock") {
        element.setAttribute("sourceFormat", block.sourceFormat);
      }
      const text = new Y.XmlText();
      if (block.text) text.insert(0, block.text);
      element.insert(0, [text]);
      break;
    }
    case "image":
      element.setAttribute("attachmentId", block.attachmentId);
      element.setAttribute("alt", block.altText);
      if (block.width !== undefined) {
        element.setAttribute("width", block.width as unknown as string);
      }
      element.setAttribute("alignment", block.alignment ?? "center");
      break;
    case "attachment":
      element.setAttribute("attachmentId", block.attachmentId);
      element.setAttribute("label", block.label);
      break;
  }
  return element;
}

function noteDocumentFromYDoc(
  noteId: string,
  doc: Y.Doc,
  replicaId = localReplicaId,
): NoteDocument {
  assertUuidV7(noteId, "noteId");
  const meta = doc.getMap("meta");
  if (meta.get("note_id") !== noteId) {
    throw new Error("Persisted NoteDoc note_id does not match its key");
  }
  const schemaVersion = meta.get("schema_version");
  if (schemaVersion === REPLICATED_NOTE_SCHEMA_VERSION)
    return replicatedDocumentFromYDoc(noteId, doc, replicaId);
  if (schemaVersion === 2) {
    migrateNoteDocumentV2ToV3(noteId, doc, meta);
  } else if (
    schemaVersion === 3 ||
    schemaVersion === 4 ||
    schemaVersion === 5
  ) {
    doc.transact(() => {
      meta.set("schema_version", NOTE_DOC_SCHEMA_VERSION);
      meta.set("migrated_from_schema_version", schemaVersion);
      meta.set("migrated_note_id", noteId);
    }, NOTE_SCHEMA_MIGRATION_ORIGIN);
  } else if (schemaVersion !== NOTE_DOC_SCHEMA_VERSION) {
    throw new Error("Unsupported NoteDoc schema_version");
  }
  const fragment = doc.getXmlFragment(NOTE_BODY_FRAGMENT);
  if (fragment.length !== 1) {
    throw new Error("NoteDoc must contain exactly one Root Section");
  }
  const rootSection = fragment.get(0);
  if (!(rootSection instanceof Y.XmlElement)) {
    throw new Error("NoteDoc Root Section is missing");
  }
  validateSectionTree(rootSection, noteId);
  return noteDocumentFromParts(noteId, doc, meta, rootSection);
}

function migrateNoteDocumentV2ToV3(
  noteId: string,
  doc: Y.Doc,
  meta: Y.Map<unknown>,
): void {
  const fragment = doc.getXmlFragment(NOTE_BODY_FRAGMENT);
  if (fragment.length !== 1) {
    throw new Error("NoteDoc v2 migration requires one Root Section");
  }
  const root = fragment.get(0);
  if (!(root instanceof Y.XmlElement) || root.nodeName !== SECTION_NODE) {
    throw new Error("NoteDoc v2 migration Root Section is invalid");
  }
  const sections = rawSectionIdentityEntries(doc).map(({ section }) => section);
  doc.transact(() => {
    for (const section of sections) {
      const body = section.get(1);
      if (!(body instanceof Y.XmlElement) || body.nodeName !== "sectionBody") {
        throw new Error("NoteDoc v2 migration Section body is invalid");
      }
      const legacyValues = body.toArray();
      const blockByteSizes = legacyValues.map(
        (value) =>
          noteBlockUtf8Encoder.encode(JSON.stringify(value.toJSON()))
            .byteLength,
      );
      const blocks = legacyValues.map((value) => {
        if (
          !(value instanceof Y.XmlElement) ||
          value.nodeName === SECTION_NODE ||
          value.nodeName === BODY_CHUNK_NODE
        ) {
          throw new Error("NoteDoc v2 migration found an invalid body block");
        }
        return value.clone();
      });
      body.delete(0, body.length);
      const chunks = createBodyChunks(blocks, blockByteSizes);
      if (chunks.length > 0) body.insert(0, chunks);
    }
    meta.set("schema_version", NOTE_DOC_SCHEMA_VERSION);
    meta.set("migrated_from_schema_version", 2);
    meta.set("migrated_note_id", noteId);
  }, NOTE_SCHEMA_MIGRATION_ORIGIN);
}

function noteDocumentFromParts(
  noteId: string,
  doc: Y.Doc,
  meta: Y.Map<unknown>,
  rootSection: Y.XmlElement,
): NoteDocument {
  validateSectionTree(rootSection, noteId);
  const note = {
    kind: "note",
    id: noteId,
    noteId,
    schemaVersion: NOTE_DOC_SCHEMA_VERSION,
    doc,
    meta,
    rootSection,
    undoManager: new Y.UndoManager(rootSection, {
      captureTimeout: 500,
      trackedOrigins: new Set([
        ySyncPluginKey,
        SECTION_DEPTH_SHIFT_ORIGIN,
        SECTION_PARAGRAPH_CONVERSION_ORIGIN,
      ]),
    }),
  } as Omit<NoteDocument, "body">;
  return Object.defineProperty(note, "body", {
    enumerable: true,
    get: () => sectionBody(rootSection),
  }) as NoteDocument;
}

// Until Workspace enrollment supplies its durable identity, unsynchronized
// documents use one process-local replica. It is never an authentication key.
const localReplicaId = createUuidV7();

export function createReplicatedNoteDocumentFromSectionSnapshot(
  noteId: string,
  snapshot: SectionSnapshot,
  replicaId: string,
  timestamps: { createdAt?: string; updatedAt?: string } = {},
): NoteDocument {
  if (snapshot.sectionId !== noteId)
    throw new Error("Root Section ID must equal Note ID");
  const replicated = replicateSectionSnapshot(snapshot, replicaId);
  replicated.doc.transact(() => {
    replicated.meta.set("created_at", timestamps.createdAt ?? "");
    replicated.meta.set(
      "updated_at",
      timestamps.updatedAt ?? timestamps.createdAt ?? "",
    );
  }, BOOTSTRAP_ORIGIN);
  return replicatedDocumentFromModel(replicated);
}

function replicatedDocumentFromYDoc(
  noteId: string,
  doc: Y.Doc,
  replicaId: string,
): NoteDocument {
  const replicated = new ReplicatedNote(noteId, replicaId, doc);
  try {
    replicated.validate();
    return replicatedDocumentFromModel(replicated);
  } catch (error) {
    replicated.destroy();
    throw error;
  }
}

function replicatedDocumentFromModel(replicated: ReplicatedNote): NoteDocument {
  const { noteId, doc, meta } = replicated;
  for (const origin of [
    ySyncPluginKey,
    SECTION_DEPTH_SHIFT_ORIGIN,
    SECTION_PARAGRAPH_CONVERSION_ORIGIN,
    NOTE_RECOVERY_ORIGIN,
  ])
    replicated.undoManager.trackedOrigins.add(origin);
  let projection: NoteDocument | null = null;
  const invalidate = () => {
    projection?.doc.destroy();
    projection = null;
  };
  replicated.subscribe(invalidate);
  doc.on("destroy", invalidate);
  const root = () => {
    projection ??= createNoteDocumentFromSectionSnapshot(
      noteId,
      replicated.sectionSnapshot(),
    );
    return projection.rootSection;
  };
  return {
    kind: "note",
    id: noteId,
    noteId,
    schemaVersion: REPLICATED_NOTE_SCHEMA_VERSION,
    doc,
    meta,
    replicated,
    undoManager: replicated.history,
    get rootSection() {
      return root();
    },
    get body() {
      return sectionBody(root());
    },
  };
}

/** Existing Core operations execute on a disposable view, then commit a validated ID diff. */
function editReplicatedProjection<Result>(
  note: NoteDocument,
  origin: unknown,
  edit: (projection: NoteDocument) => Result,
): Result {
  const replicated = note.replicated!;
  const projection = createNoteDocumentFromSectionSnapshot(
    note.noteId,
    replicated.sectionSnapshot(),
    {
      createdAt: String(note.meta.get("created_at") ?? ""),
      updatedAt: readNoteUpdatedAt(note),
    },
  );
  try {
    const result = edit(projection);
    replicated.transact(() => {
      applyReplicatedSectionSnapshot(
        replicated,
        sectionSnapshot(projection.rootSection),
        origin,
      );
      if (readNoteUpdatedAt(projection) !== readNoteUpdatedAt(note))
        note.meta.set("updated_at", readNoteUpdatedAt(projection));
    }, origin);
    return result;
  } finally {
    projection.doc.destroy();
  }
}

function workspaceDocumentFromYDoc(
  workspaceId: string,
  doc: Y.Doc,
  replicaId = localReplicaId,
): WorkspaceDocument {
  assertUuidV7(workspaceId, "workspaceId");
  const root = doc.getMap("workspace");
  if (root.get("workspace_id") !== workspaceId) {
    throw new Error("Persisted WorkspaceMetadataDoc id does not match its key");
  }
  const schemaVersion = root.get("schema_version");
  if (
    schemaVersion !== WORKSPACE_DOC_SCHEMA_VERSION &&
    schemaVersion !== REPLICATED_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported WorkspaceMetadataDoc schema_version");
  }
  if (root.has("virtual_root_id")) {
    throw new Error("Workspace schema v2 must not persist a virtual root");
  }
  const notes = root.get("notes");
  if (!(notes instanceof Y.Map)) {
    throw new Error("WorkspaceMetadataDoc notes map is missing");
  }
  const workspace: WorkspaceDocument = {
    kind: "workspace",
    id: workspaceId,
    workspaceId,
    schemaVersion,
    doc,
    root,
    notes: notes as Y.Map<Y.Map<unknown>>,
    replicated: replicatedNamespace(root, replicaId),
  };
  validateWorkspaceMetadata(workspace);
  return workspace;
}

function metadataToYMap(
  input: NoteMetadataInput,
  normalized = false,
): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("created_at", input.createdAt);
  value.set("updated_at", input.updatedAt);
  if (!normalized) {
    value.set("deleted_at", input.deletedAt ?? null);
    value.set("trash_operation_id", input.trashOperationId ?? null);
  }
  value.set("system_role", input.systemRole ?? null);
  value.set("title_cache", input.title ?? "");
  return value;
}

function validateWorkspaceMetadata(workspace: WorkspaceDocument): void {
  const entries = listNamespaceEntries(workspace.root);
  const index = metadataPlacementIndex(workspace);
  const byNote = new Map(
    entries.flatMap((entry) =>
      entry.target ? [[entry.target.id, entry] as const] : [],
    ),
  );
  validateNamespace(
    entries,
    new Map(
      [...workspace.notes].map(([id, value]) => [
        id,
        {
          deletedAt: workspace.replicated
            ? byNote.get(id)?.deletedAt
            : nullableString(value.get("deleted_at")),
          trashOperationId: workspace.replicated
            ? byNote.get(id)?.trashOperationId
            : nullableString(value.get("trash_operation_id")),
        },
      ]),
    ),
  );
  const metadata: NoteMetadata[] = [];
  for (const [noteId, value] of workspace.notes.entries()) {
    assertUuidV7(noteId, "noteId");
    if (!(value instanceof Y.Map)) {
      throw new Error(`Workspace Note metadata is invalid: ${noteId}`);
    }
    if (
      value.has("parent_note_id") ||
      value.has("note_position") ||
      (workspace.replicated &&
        (value.has("deleted_at") || value.has("trash_operation_id")))
    )
      throw new Error("Note placement must be stored in Namespace");
    const note = projectNoteMetadata(noteId, value, index);
    if (!isCanonicalSiblingPosition(note.notePosition)) {
      throw new Error(`Note ${noteId} has an invalid note_position`);
    }
    if (note.parentNoteId !== null) {
      assertUuidV7(note.parentNoteId, "parentNoteId");
    }
    validateTitle(note.title);
    metadata.push(note);
  }
  validateNoteMetadataTree(metadata);
}

export function validateNoteMetadataTree(notes: readonly NoteMetadata[]): void {
  const byId = new Map<string, NoteMetadata>();
  for (const note of notes) {
    if (byId.has(note.noteId))
      throw new Error(`Duplicate note: ${note.noteId}`);
    byId.set(note.noteId, note);
  }
  for (const note of notes) {
    if (note.parentNoteId === null) continue;
    if (note.parentNoteId === note.noteId) {
      throw new Error(`Note tree contains a cycle at ${note.noteId}`);
    }
    const parent = byId.get(note.parentNoteId);
    if (!parent) {
      throw new Error(`Note ${note.noteId} has an unknown parent`);
    }
    if (!note.deletedAt && parent.deletedAt) {
      throw new Error(`Live note ${note.noteId} has a deleted parent`);
    }
  }
  const complete = new Set<string>();
  for (const note of notes) {
    if (complete.has(note.noteId)) continue;
    const path = new Set<string>();
    let cursor: NoteMetadata | undefined = note;
    while (cursor) {
      if (complete.has(cursor.noteId)) break;
      if (path.has(cursor.noteId)) {
        throw new Error(`Note tree contains a cycle at ${cursor.noteId}`);
      }
      path.add(cursor.noteId);
      cursor =
        cursor.parentNoteId === null
          ? undefined
          : byId.get(cursor.parentNoteId);
    }
    for (const noteId of path) complete.add(noteId);
  }
}

export function noteDisplayTitle(title: string): string {
  return title || "新しいノート";
}

function requireMetadata(
  workspace: WorkspaceDocument,
  noteId: string,
): Y.Map<unknown> {
  const value = workspace.notes.get(noteId);
  if (!value) throw new Error(`Unknown note: ${noteId}`);
  return value;
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function emptyParagraphBlock(): NoteBlock {
  return { type: "paragraph", blockId: createUuidV7(), content: [] };
}

function insertInlineContent(
  parent: Y.XmlElement,
  content: InlineContent[],
): void {
  const children = content.map((inline) => {
    if (inline.type === "text") {
      const text = new Y.XmlText();
      if (inline.text) text.insert(0, inline.text);
      return text;
    }
    const link = new Y.XmlElement("internalSectionLink");
    link.setAttribute("targetSectionId", inline.targetSectionId);
    const text = new Y.XmlText();
    if (inline.text) text.insert(0, inline.text);
    link.insert(0, [text]);
    return link;
  });
  if (children.length > 0) parent.insert(0, children);
}

function findFirstEditableTextBlock(root: Y.XmlElement): Y.XmlElement | null {
  const pending = [...sectionBodyBlocks(root)];
  while (pending.length > 0) {
    const first = pending.shift()!;
    if (["paragraph", "codeBlock", "sourceBlock"].includes(first.nodeName)) {
      return first;
    }
    pending.unshift(
      ...first
        .toArray()
        .filter(
          (value): value is Y.XmlElement => value instanceof Y.XmlElement,
        ),
    );
  }
  return null;
}

function appendPlainText(
  value: Y.XmlElement | Y.XmlText,
  parts: string[],
): void {
  if (value instanceof Y.XmlText) {
    parts.push(yXmlTextVisibleText(value));
    return;
  }
  if (value.nodeName === "attachment") {
    const label = value.getAttribute("label");
    if (typeof label === "string" && label) parts.push(label, "\n");
    return;
  }
  for (const child of value.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      appendPlainText(child, parts);
    }
  }
  if (
    ["paragraph", "detailsSummary", "codeBlock", "sourceBlock"].includes(
      value.nodeName,
    )
  ) {
    parts.push("\n");
  } else if (["listItem", "tableRow"].includes(value.nodeName)) {
    const tail = parts.at(-1);
    if (typeof tail !== "string" || !tail.endsWith("\n")) parts.push("\n");
  }
}
