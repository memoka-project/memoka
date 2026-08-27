import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import type { DocumentKind } from "./documents";
import {
  toWireWorkspaceSearchIndexRebuildRequest,
  toWireWorkspaceSearchIndexReplaceRequest,
} from "./workspace-search-index";
import type {
  WorkspaceSearchIndexPort,
  WorkspaceSearchIndexQueryRequest,
  WorkspaceSearchIndexQueryResponse,
  WorkspaceSearchIndexHierarchyUpdateRequest,
  WorkspaceSearchIndexRebuildRequest,
  WorkspaceSearchIndexReplaceRequest,
} from "./workspace-search-index";

export type TransactionScope =
  "bootstrap" | "note-doc" | "workspace-structure" | "local-ui";

export type CommitFault =
  "before-commit" | "before-sql-commit" | "after-commit-response";

export interface PersistenceManifest {
  databaseSchemaVersion: number;
  activeWorkspaceId: string | null;
}

export interface DocumentCommit {
  kind: DocumentKind;
  documentId: string;
  schemaVersion: number;
  baseRevision: number;
  snapshot: Uint8Array | null;
  update: Uint8Array | null;
}

export interface LocalStateCommit {
  windowId: string;
  state: Record<string, unknown>;
}

export interface PersistenceCommitRequest {
  operationId: string;
  scope: TransactionScope;
  documents: DocumentCommit[];
  localStates: LocalStateCommit[];
  /**
   * A NoteDoc edit may advance only the workspace's rebuildable metadata
   * cache. Persistence can keep the derived search index at the new workspace
   * revision while leaving the edited Note invalidation for one-note replace.
   */
  searchIndexMetadataOnlyNoteId?: string;
  fault?: CommitFault;
}

export interface PersistenceCompactionRequest {
  operationId: string;
  kind: DocumentKind;
  documentId: string;
  schemaVersion: number;
  expectedRevision: number;
  fault?: CommitFault;
}

export interface DocumentRevision {
  kind: DocumentKind;
  documentId: string;
  revision: number;
}

export interface PersistenceCommitResponse {
  operationId: string;
  deduplicated: boolean;
  documents: DocumentRevision[];
}

export interface PersistedUpdate {
  revision: number;
  update: Uint8Array;
}

export interface PersistedDocument {
  kind: DocumentKind;
  documentId: string;
  schemaVersion: number;
  revision: number;
  snapshotRevision: number;
  snapshot: Uint8Array;
  updates: PersistedUpdate[];
}

export interface PersistedLocalState {
  windowId: string;
  state: Record<string, unknown>;
}

export interface PersistencePort {
  manifest(): Promise<PersistenceManifest>;
  commit(request: PersistenceCommitRequest): Promise<PersistenceCommitResponse>;
  compact(
    request: PersistenceCompactionRequest,
  ): Promise<PersistenceCommitResponse>;
  loadDocument(
    kind: DocumentKind,
    documentId: string,
  ): Promise<PersistedDocument>;
  loadLocalStates(): Promise<PersistedLocalState[]>;
}

interface MemoryDocument {
  kind: DocumentKind;
  documentId: string;
  schemaVersion: number;
  revision: number;
  snapshotRevision: number;
  snapshot: Uint8Array;
  updates: PersistedUpdate[];
}

interface StoredOperation {
  fingerprint: string;
  response: PersistenceCommitResponse;
}

export class MemoryPersistencePort implements PersistencePort {
  private activeWorkspaceId: string | null = null;
  private documents = new Map<string, MemoryDocument>();
  private localStates = new Map<string, PersistedLocalState>();
  private operations = new Map<string, StoredOperation>();

  async manifest(): Promise<PersistenceManifest> {
    return {
      databaseSchemaVersion: 4,
      activeWorkspaceId: this.activeWorkspaceId,
    };
  }

  async commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    validateRequest(request);
    const fingerprint = fingerprintRequest(request);
    const previous = this.operations.get(request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error("operation_id was reused with different content");
      }
      return {
        ...structuredClone(previous.response),
        deduplicated: true,
      };
    }
    if (request.fault === "before-commit") {
      throw new Error("injected persistence fault: before-commit");
    }

    const documents = cloneDocumentMap(this.documents);
    const localStates = new Map(
      [...this.localStates].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    );
    let activeWorkspaceId = this.activeWorkspaceId;
    const revisions: DocumentRevision[] = [];

    const sortedDocuments = [...request.documents].sort(compareDocuments);
    for (const input of sortedDocuments) {
      const key = documentKey(input.kind, input.documentId);
      const existing = documents.get(key);
      if (!existing) {
        if (
          input.baseRevision !== 0 ||
          !input.snapshot ||
          input.snapshot.length === 0 ||
          input.update
        ) {
          throw new Error(
            `new document ${key} requires revision 0 and one snapshot`,
          );
        }
        if (input.kind === "workspace") {
          if (activeWorkspaceId && activeWorkspaceId !== input.documentId) {
            throw new Error(
              "only one active workspace is supported in Core MVP",
            );
          }
          activeWorkspaceId = input.documentId;
        }
        documents.set(key, {
          kind: input.kind,
          documentId: input.documentId,
          schemaVersion: input.schemaVersion,
          revision: 1,
          snapshotRevision: 1,
          snapshot: input.snapshot.slice(),
          updates: [],
        });
        revisions.push({
          kind: input.kind,
          documentId: input.documentId,
          revision: 1,
        });
        continue;
      }
      if (existing.revision !== input.baseRevision) {
        throw new Error(
          `revision conflict for ${key}: expected ${input.baseRevision}, actual ${existing.revision}`,
        );
      }
      if (existing.schemaVersion !== input.schemaVersion) {
        if (
          existing.kind === "note" &&
          existing.schemaVersion === 2 &&
          input.schemaVersion === 3
        ) {
          existing.schemaVersion = 3;
        } else {
          throw new Error(`schema version mismatch for ${key}`);
        }
      }
      if (input.snapshot || !input.update || input.update.length === 0) {
        throw new Error(
          `existing document ${key} requires exactly one non-empty update`,
        );
      }
      existing.revision += 1;
      existing.updates.push({
        revision: existing.revision,
        update: input.update.slice(),
      });
      revisions.push({
        kind: input.kind,
        documentId: input.documentId,
        revision: existing.revision,
      });
    }

    for (const localState of request.localStates) {
      if (
        localState.windowId.length === 0 ||
        !localState.state ||
        typeof localState.state !== "object"
      ) {
        throw new Error("invalid window-local state");
      }
      localStates.set(localState.windowId, structuredClone(localState));
    }

    if (request.fault === "before-sql-commit") {
      throw new Error("injected persistence fault: before-sql-commit");
    }
    const response: PersistenceCommitResponse = {
      operationId: request.operationId,
      deduplicated: false,
      documents: revisions,
    };
    this.documents = documents;
    this.localStates = localStates;
    this.activeWorkspaceId = activeWorkspaceId;
    this.operations.set(request.operationId, {
      fingerprint,
      response: structuredClone(response),
    });
    if (request.fault === "after-commit-response") {
      throw new Error("injected persistence fault: after-commit-response");
    }
    return response;
  }

  async compact(
    request: PersistenceCompactionRequest,
  ): Promise<PersistenceCommitResponse> {
    validateCompactionRequest(request);
    const fingerprint = fingerprintCompactionRequest(request);
    const previous = this.operations.get(request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error("operation_id was reused with different content");
      }
      return {
        ...structuredClone(previous.response),
        deduplicated: true,
      };
    }
    if (request.fault === "before-commit") {
      throw new Error("injected persistence fault: before-commit");
    }

    const documents = cloneDocumentMap(this.documents);
    const key = documentKey(request.kind, request.documentId);
    const existing = documents.get(key);
    if (!existing) throw new Error(`unknown document: ${key}`);
    if (existing.schemaVersion !== request.schemaVersion) {
      throw new Error(`schema version mismatch for ${key}`);
    }
    if (existing.revision !== request.expectedRevision) {
      throw new Error(
        `revision conflict for ${key}: expected ${request.expectedRevision}, actual ${existing.revision}`,
      );
    }

    existing.snapshot = reconstructSnapshot(existing);
    existing.snapshotRevision = request.expectedRevision;
    existing.updates = existing.updates.filter(
      ({ revision }) => revision > request.expectedRevision,
    );

    if (request.fault === "before-sql-commit") {
      throw new Error("injected persistence fault: before-sql-commit");
    }
    const response: PersistenceCommitResponse = {
      operationId: request.operationId,
      deduplicated: false,
      documents: [
        {
          kind: request.kind,
          documentId: request.documentId,
          revision: request.expectedRevision,
        },
      ],
    };
    this.documents = documents;
    this.operations.set(request.operationId, {
      fingerprint,
      response: structuredClone(response),
    });
    if (request.fault === "after-commit-response") {
      throw new Error("injected persistence fault: after-commit-response");
    }
    return response;
  }

  async loadDocument(
    kind: DocumentKind,
    documentId: string,
  ): Promise<PersistedDocument> {
    const document = this.documents.get(documentKey(kind, documentId));
    if (!document) throw new Error(`unknown document: ${kind}:${documentId}`);
    return clonePersistedDocument(document);
  }

  async loadLocalStates(): Promise<PersistedLocalState[]> {
    return [...this.localStates.values()]
      .sort((left, right) => left.windowId.localeCompare(right.windowId))
      .map((state) => structuredClone(state));
  }
}

interface WireDocumentCommit extends Omit<
  DocumentCommit,
  "snapshot" | "update"
> {
  snapshot: number[] | null;
  update: number[] | null;
}

interface WireCommitRequest extends Omit<
  PersistenceCommitRequest,
  "documents"
> {
  documents: WireDocumentCommit[];
}

interface WirePersistedDocument extends Omit<
  PersistedDocument,
  "snapshot" | "updates"
> {
  snapshot: number[];
  updates: Array<Omit<PersistedUpdate, "update"> & { update: number[] }>;
}

export class TauriPersistencePort
  implements PersistencePort, WorkspaceSearchIndexPort
{
  async manifest(): Promise<PersistenceManifest> {
    return invoke<PersistenceManifest>("persistence_manifest");
  }

  async commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    const wire: WireCommitRequest = {
      ...request,
      documents: request.documents.map((document) => ({
        ...document,
        snapshot: document.snapshot ? [...document.snapshot] : null,
        update: document.update ? [...document.update] : null,
      })),
    };
    return invoke<PersistenceCommitResponse>("persistence_commit", {
      request: wire,
    });
  }

  async compact(
    request: PersistenceCompactionRequest,
  ): Promise<PersistenceCommitResponse> {
    return invoke<PersistenceCommitResponse>("persistence_compact", {
      request,
    });
  }

  async loadDocument(
    kind: DocumentKind,
    documentId: string,
  ): Promise<PersistedDocument> {
    const wire = await invoke<WirePersistedDocument>(
      "persistence_load_document",
      { kind, documentId },
    );
    return {
      ...wire,
      snapshot: Uint8Array.from(wire.snapshot),
      updates: wire.updates.map((update) => ({
        ...update,
        update: Uint8Array.from(update.update),
      })),
    };
  }

  async loadLocalStates(): Promise<PersistedLocalState[]> {
    return invoke<PersistedLocalState[]>("persistence_load_local_states");
  }

  async rebuildWorkspaceSearchIndex(
    request: WorkspaceSearchIndexRebuildRequest,
  ): Promise<void> {
    return invoke("workspace_search_index_rebuild", {
      request: toWireWorkspaceSearchIndexRebuildRequest(request),
    });
  }

  async replaceWorkspaceSearchIndexDocument(
    request: WorkspaceSearchIndexReplaceRequest,
  ): Promise<"updated" | "stale"> {
    return invoke<"updated" | "stale">(
      "workspace_search_index_replace_document",
      { request: toWireWorkspaceSearchIndexReplaceRequest(request) },
    );
  }

  async queryWorkspaceSearchIndex(
    request: WorkspaceSearchIndexQueryRequest,
  ): Promise<WorkspaceSearchIndexQueryResponse> {
    return invoke<WorkspaceSearchIndexQueryResponse>(
      "workspace_search_index_query",
      { request },
    );
  }

  async updateWorkspaceSearchIndexHierarchy(
    request: WorkspaceSearchIndexHierarchyUpdateRequest,
  ): Promise<"updated" | "stale"> {
    return invoke<"updated" | "stale">(
      "workspace_search_index_update_hierarchy",
      { request },
    );
  }
}

export function createDefaultPersistencePort(): PersistencePort {
  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  ) {
    return new TauriPersistencePort();
  }
  return new MemoryPersistencePort();
}

function validateRequest(request: PersistenceCommitRequest): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(request.operationId)) {
    throw new Error("operationId must be an ASCII identifier");
  }
  if (
    !["bootstrap", "note-doc", "workspace-structure", "local-ui"].includes(
      request.scope,
    )
  ) {
    throw new Error("invalid transaction scope");
  }
  if (request.searchIndexMetadataOnlyNoteId !== undefined) {
    const matchingNotes = request.documents.filter(
      ({ kind, documentId }) =>
        kind === "note" && documentId === request.searchIndexMetadataOnlyNoteId,
    );
    const workspaces = request.documents.filter(
      ({ kind }) => kind === "workspace",
    );
    if (
      request.scope !== "workspace-structure" ||
      request.documents.length !== 2 ||
      matchingNotes.length !== 1 ||
      workspaces.length !== 1
    ) {
      throw new Error(
        "search index metadata-only commit requires one Workspace and one NoteDoc",
      );
    }
  }
  for (const document of request.documents) {
    if (
      !["workspace", "note"].includes(document.kind) ||
      document.documentId.length === 0 ||
      !isSupportedDocumentSchema(
        document.kind as DocumentKind,
        document.schemaVersion,
      )
    ) {
      throw new Error("invalid document commit");
    }
  }
}

function validateCompactionRequest(
  request: PersistenceCompactionRequest,
): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(request.operationId)) {
    throw new Error("operationId must be an ASCII identifier");
  }
  if (
    !["workspace", "note"].includes(request.kind) ||
    request.documentId.length === 0 ||
    !isSupportedDocumentSchema(
      request.kind as DocumentKind,
      request.schemaVersion,
    ) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 1
  ) {
    throw new Error("invalid document compaction");
  }
}

function isSupportedDocumentSchema(
  kind: DocumentKind,
  schemaVersion: number,
): boolean {
  return kind === "workspace"
    ? schemaVersion === 2
    : schemaVersion === 2 || schemaVersion === 3;
}

function documentKey(kind: DocumentKind, documentId: string): string {
  return `${kind}:${documentId}`;
}

function compareDocuments(
  left: Pick<DocumentCommit, "kind" | "documentId">,
  right: Pick<DocumentCommit, "kind" | "documentId">,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.documentId.localeCompare(right.documentId)
  );
}

function cloneDocumentMap(
  source: Map<string, MemoryDocument>,
): Map<string, MemoryDocument> {
  return new Map(
    [...source].map(([key, document]) => [
      key,
      {
        ...document,
        snapshot: document.snapshot.slice(),
        updates: document.updates.map((update) => ({
          revision: update.revision,
          update: update.update.slice(),
        })),
      },
    ]),
  );
}

function clonePersistedDocument(document: MemoryDocument): PersistedDocument {
  return {
    ...document,
    snapshot: document.snapshot.slice(),
    updates: document.updates.map((update) => ({
      revision: update.revision,
      update: update.update.slice(),
    })),
  };
}

function reconstructSnapshot(document: MemoryDocument): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, document.snapshot);
    for (const { update } of document.updates) {
      Y.applyUpdate(doc, update);
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function fingerprintRequest(request: PersistenceCommitRequest): string {
  const documents = [...request.documents]
    .sort(compareDocuments)
    .map((document) => ({
      ...document,
      snapshot: document.snapshot ? bytesToHex(document.snapshot) : null,
      update: document.update ? bytesToHex(document.update) : null,
    }));
  const localStates = [...request.localStates].sort((left, right) =>
    left.windowId.localeCompare(right.windowId),
  );
  return JSON.stringify({
    scope: request.scope,
    documents,
    localStates,
    searchIndexMetadataOnlyNoteId:
      request.searchIndexMetadataOnlyNoteId ?? null,
  });
}

function fingerprintCompactionRequest(
  request: PersistenceCompactionRequest,
): string {
  return JSON.stringify({
    operation: "compact",
    kind: request.kind,
    documentId: request.documentId,
    schemaVersion: request.schemaVersion,
    expectedRevision: request.expectedRevision,
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
