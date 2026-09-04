import * as Y from "yjs";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { assertUuidV7, createUuidV7, isUuidV7 } from "./ids";
import { yXmlTextVisibleText } from "./yxml-text";
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

export const NOTE_DOC_SCHEMA_VERSION = 3;
export const WORKSPACE_DOC_SCHEMA_VERSION = 2;
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
  /** The sole root of the persisted NoteDoc. Its Section ID equals noteId. */
  readonly rootSection: Y.XmlElement;
  /** Compatibility handle, resolved on access after structural Undo. */
  readonly body: Y.XmlElement;
  readonly undoManager: Y.UndoManager;
}

export interface WorkspaceDocument extends BaseCrdtDocument {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly root: Y.Map<unknown>;
  readonly notes: Y.Map<Y.Map<unknown>>;
}

export type ProductDocument = NoteDocument | WorkspaceDocument;

export interface NoteMetadataInput {
  noteId: string;
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
  noteId: string;
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
      type: "paragraph";
      blockId: string;
      content: InlineContent[];
    }
  | {
      type: "blockquote";
      blockId: string;
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
}

export const PERSISTENCE_LOAD_ORIGIN = "memoka:persistence-load";
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
  workspace.doc.transact(() => {
    for (const note of metadata) {
      workspace.notes.set(
        note.noteId,
        metadataToYMap(note, note.parentNoteId, note.notePosition),
      );
    }
  }, BOOTSTRAP_ORIGIN);
  validateWorkspaceMetadata(workspace);
  return workspace;
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
): ProductDocument {
  const doc = new Y.Doc({
    guid: kind === "workspace" ? `workspace:${documentId}` : documentId,
  });
  Y.applyUpdate(doc, snapshot, PERSISTENCE_LOAD_ORIGIN);
  for (const update of updates) {
    Y.applyUpdate(doc, update, PERSISTENCE_LOAD_ORIGIN);
  }
  return kind === "workspace"
    ? workspaceDocumentFromYDoc(documentId, doc)
    : noteDocumentFromYDoc(documentId, doc);
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
): RecoveredNoteDocumentLoad {
  assertUuidV7(noteId, "noteId");
  const doc = new Y.Doc({ guid: noteId });
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
      rawSchemaVersion === 2 ? rawSchemaVersion : null;
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
  validateParentReference(workspace, input.noteId, parentNoteId);
  if (input.title !== undefined) validateTitle(input.title);
  workspace.doc.transact(() => {
    workspace.notes.set(
      input.noteId,
      metadataToYMap(input, parentNoteId, notePosition),
    );
  }, origin);
}

export function readNoteMetadata(
  workspace: WorkspaceDocument,
  noteId: string,
): NoteMetadata | undefined {
  const value = workspace.notes.get(noteId);
  if (!value) return undefined;
  const notePosition = String(value.get("note_position"));
  const rawParentNoteId = value.get("parent_note_id");
  const parentNoteId =
    rawParentNoteId === null || rawParentNoteId === undefined
      ? null
      : String(rawParentNoteId);
  const systemRole = value.get("system_role");
  return {
    noteId,
    parentNoteId,
    notePosition,
    title: String(value.get("title_cache") ?? ""),
    createdAt: String(value.get("created_at")),
    updatedAt: String(value.get("updated_at")),
    deletedAt: nullableString(value.get("deleted_at")),
    trashOperationId: nullableString(value.get("trash_operation_id")),
    systemRole: systemRole === "help" ? "help" : undefined,
  };
}

export function listNoteMetadata(workspace: WorkspaceDocument): NoteMetadata[] {
  return [...workspace.notes.keys()]
    .map((noteId) => readNoteMetadata(workspace, noteId))
    .filter((metadata): metadata is NoteMetadata => metadata !== undefined)
    .sort(
      (left, right) =>
        compareSiblingPositions(left.notePosition, right.notePosition) ||
        compareIdentifiers(left.noteId, right.noteId),
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
  const values = updates.map((update) => ({
    value: requireMetadata(workspace, update.noteId),
    update,
  }));
  workspace.doc.transact(() => {
    for (const { value, update } of values) {
      value.set("parent_note_id", update.parentNoteId);
      value.set("note_position", update.notePosition);
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
  const values = noteIds.map((noteId) => {
    const value = requireMetadata(workspace, noteId);
    if (value.get("deleted_at") !== null) {
      throw new Error(`Note is already in Trash: ${noteId}`);
    }
    return value;
  });
  workspace.doc.transact(() => {
    for (const value of values) {
      value.set("deleted_at", deletedAt);
      value.set("trash_operation_id", trashOperationId);
      value.set("updated_at", deletedAt);
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
  const values = noteIds.map((noteId) => {
    const value = requireMetadata(workspace, noteId);
    if (value.get("deleted_at") === null) {
      throw new Error(`Note is not in Trash: ${noteId}`);
    }
    return value;
  });
  workspace.doc.transact(() => {
    for (const value of values) {
      value.set("deleted_at", null);
      value.set("trash_operation_id", null);
      value.set("updated_at", restoredAt);
    }
  }, origin);
}

export function synchronizeManagedNoteMetadata(
  workspace: WorkspaceDocument,
  noteId: string,
  input: { title: string; updatedAt: string },
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
  const value = requireMetadata(workspace, noteId);
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
  if (snapshot.sectionId !== note.noteId) {
    throw new Error("Root Section ID must equal Note ID");
  }
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
  return planSectionDepthShift(
    sectionSnapshot(boundary),
    targetSectionIds,
    direction,
  );
}

export function applyNoteSectionDepthShift(
  note: NoteDocument,
  boundarySectionId: string,
  plan: SectionDepthShiftPlan,
  updatedAt: string,
  origin: unknown = SECTION_DEPTH_SHIFT_ORIGIN,
): void {
  if (!plan.changed) return;
  const boundary = findSectionById(note.rootSection, boundarySectionId);
  if (!boundary)
    throw new Error(`Unknown Focused Section: ${boundarySectionId}`);
  if (plan.snapshot.sectionId !== boundarySectionId) {
    throw new Error("Section depth plan does not match its Focused Section");
  }
  note.doc.transact(() => {
    applySectionHierarchySnapshot(boundary, plan.snapshot);
    note.meta.set("updated_at", updatedAt);
  }, origin);
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
  const created = createSectionFromSnapshot({
    sectionId: request.newSectionId,
    title: request.title,
    tags: [],
    body: suffix,
    children: movedChildren,
  });

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
  return sectionTitle(note.rootSection);
}

export function readNoteDisplayTitle(note: NoteDocument): string {
  return noteDisplayTitle(sectionTitle(note.rootSection));
}

export function renameRootSection(
  note: NoteDocument,
  title: string,
  updatedAt: string,
  origin: unknown = CORE_TRANSACTION_ORIGIN,
): void {
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
      insertInlineContent(element, block.content);
      break;
    case "orderedList":
      element.setAttribute("start", (block.start ?? 1) as unknown as string);
      element.insert(0, block.children.map(blockToYXml));
      break;
    case "bulletList":
    case "listItem":
    case "blockquote":
    case "table":
    case "tableRow":
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

function noteDocumentFromYDoc(noteId: string, doc: Y.Doc): NoteDocument {
  assertUuidV7(noteId, "noteId");
  const meta = doc.getMap("meta");
  if (meta.get("note_id") !== noteId) {
    throw new Error("Persisted NoteDoc note_id does not match its key");
  }
  const schemaVersion = meta.get("schema_version");
  if (schemaVersion === 2) {
    migrateNoteDocumentV2ToV3(noteId, doc, meta);
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

function workspaceDocumentFromYDoc(
  workspaceId: string,
  doc: Y.Doc,
): WorkspaceDocument {
  assertUuidV7(workspaceId, "workspaceId");
  const root = doc.getMap("workspace");
  if (root.get("workspace_id") !== workspaceId) {
    throw new Error("Persisted WorkspaceMetadataDoc id does not match its key");
  }
  if (root.get("schema_version") !== WORKSPACE_DOC_SCHEMA_VERSION) {
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
    schemaVersion: WORKSPACE_DOC_SCHEMA_VERSION,
    doc,
    root,
    notes: notes as Y.Map<Y.Map<unknown>>,
  };
  validateWorkspaceMetadata(workspace);
  return workspace;
}

function metadataToYMap(
  input: NoteMetadataInput,
  parentNoteId: string | null,
  notePosition: string,
): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("parent_note_id", parentNoteId);
  value.set("note_position", notePosition);
  value.set("created_at", input.createdAt);
  value.set("updated_at", input.updatedAt);
  value.set("deleted_at", input.deletedAt ?? null);
  value.set("trash_operation_id", input.trashOperationId ?? null);
  value.set("system_role", input.systemRole ?? null);
  value.set("title_cache", input.title ?? "");
  return value;
}

function validateWorkspaceMetadata(workspace: WorkspaceDocument): void {
  const metadata: NoteMetadata[] = [];
  for (const [noteId, value] of workspace.notes.entries()) {
    assertUuidV7(noteId, "noteId");
    if (!(value instanceof Y.Map)) {
      throw new Error(`Workspace Note metadata is invalid: ${noteId}`);
    }
    const note = readNoteMetadata(workspace, noteId)!;
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

function validateParentReference(
  workspace: WorkspaceDocument,
  noteId: string,
  parentNoteId: string | null,
): void {
  if (parentNoteId === null) return;
  assertUuidV7(parentNoteId, "parentNoteId");
  if (parentNoteId === noteId) {
    throw new Error("A note cannot be its own parent");
  }
  const parent = readNoteMetadata(workspace, parentNoteId);
  if (!parent || parent.deletedAt) {
    throw new Error(`Unknown live parent: ${parentNoteId}`);
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
  if (["paragraph", "codeBlock", "sourceBlock"].includes(value.nodeName)) {
    parts.push("\n");
  } else if (["listItem", "tableRow"].includes(value.nodeName)) {
    const tail = parts.at(-1);
    if (typeof tail !== "string" || !tail.endsWith("\n")) parts.push("\n");
  }
}
