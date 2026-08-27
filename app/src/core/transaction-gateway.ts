import * as Y from "yjs";
import {
  cloneProductDocument,
  encodeProductDocument,
  loadProductDocument,
  type ProductDocument,
} from "./documents";
import type {
  CommitFault,
  LocalStateCommit,
  PersistenceCompactionRequest,
  PersistenceCommitRequest,
  PersistenceCommitResponse,
  PersistencePort,
  TransactionScope,
} from "./persistence";

export interface TransactionLogEntry {
  operationId: string;
  scope: TransactionScope;
  status: "started" | "committed" | "deduplicated" | "rolled-back";
  documentIds: string[];
}

type ReplacementListener<T extends ProductDocument> = (document: T) => void;

export class ManagedCrdtDocument<T extends ProductDocument> {
  private listeners = new Set<ReplacementListener<T>>();

  constructor(
    private value: T,
    private persistedRevision: number,
  ) {}

  get current(): T {
    return this.value;
  }

  get revision(): number {
    return this.persistedRevision;
  }

  replace(document: T, revision: number): void {
    const previous = this.value;
    this.value = document;
    this.persistedRevision = revision;
    for (const listener of this.listeners) listener(document);
    previous.doc.destroy();
  }

  setRevision(revision: number): void {
    this.persistedRevision = revision;
  }

  subscribe(listener: ReplacementListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface TransactionOptions {
  operationId: string;
  scope: TransactionScope;
  documents: ManagedCrdtDocument<ProductDocument>[];
  localStates?: LocalStateCommit[];
  searchIndexMetadataOnlyNoteId?: string;
  fault?: CommitFault;
}

export class CoreTransactionGateway {
  readonly log: TransactionLogEntry[] = [];

  constructor(private readonly persistence: PersistencePort) {}

  async transact(
    options: TransactionOptions,
    mutate: () => void,
  ): Promise<PersistenceCommitResponse> {
    const checkpoints = options.documents.map((handle) => ({
      handle,
      revision: handle.revision,
      document: cloneProductDocument(handle.current),
      stateVector: Y.encodeStateVector(handle.current.doc),
    }));
    this.log.push({
      operationId: options.operationId,
      scope: options.scope,
      status: "started",
      documentIds: checkpoints.map(({ handle }) => handle.current.id),
    });

    try {
      mutate();
      const request: PersistenceCommitRequest = {
        operationId: options.operationId,
        scope: options.scope,
        documents: checkpoints.map(({ handle, revision, stateVector }) =>
          revision === 0
            ? {
                kind: handle.current.kind,
                documentId: handle.current.id,
                schemaVersion: handle.current.schemaVersion,
                baseRevision: 0,
                snapshot: encodeProductDocument(handle.current),
                update: null,
              }
            : {
                kind: handle.current.kind,
                documentId: handle.current.id,
                schemaVersion: handle.current.schemaVersion,
                baseRevision: revision,
                snapshot: null,
                update: Y.encodeStateAsUpdate(handle.current.doc, stateVector),
              },
        ),
        localStates: options.localStates ?? [],
        searchIndexMetadataOnlyNoteId: options.searchIndexMetadataOnlyNoteId,
        fault: options.fault,
      };
      const response = await commitWithRetry(this.persistence, request);
      applyRevisions(options.documents, response);
      this.log.push({
        operationId: options.operationId,
        scope: options.scope,
        status: response.deduplicated ? "deduplicated" : "committed",
        documentIds: checkpoints.map(({ handle }) => handle.current.id),
      });
      for (const checkpoint of checkpoints) checkpoint.document.doc.destroy();
      return response;
    } catch (error) {
      for (const checkpoint of checkpoints) {
        checkpoint.handle.replace(checkpoint.document, checkpoint.revision);
      }
      this.log.push({
        operationId: options.operationId,
        scope: options.scope,
        status: "rolled-back",
        documentIds: checkpoints.map(({ document }) => document.id),
      });
      throw error;
    }
  }

  async commitAppliedUpdate(
    handle: ManagedCrdtDocument<ProductDocument>,
    operationId: string,
    update: Uint8Array,
  ): Promise<PersistenceCommitResponse> {
    return this.persistAppliedUpdate(handle, operationId, update, true);
  }

  /**
   * Persists a narrowly recovered update on a document that has not entered
   * the runtime yet. Its persisted predecessor is intentionally invalid, so
   * the normal reload-on-failure rollback cannot reconstruct a ProductDoc.
   * The caller owns and discards the prepared handle when this method fails.
   */
  async commitAppliedRecoveryUpdate(
    handle: ManagedCrdtDocument<ProductDocument>,
    operationId: string,
    update: Uint8Array,
  ): Promise<PersistenceCommitResponse> {
    return this.persistAppliedUpdate(handle, operationId, update, false);
  }

  private async persistAppliedUpdate(
    handle: ManagedCrdtDocument<ProductDocument>,
    operationId: string,
    update: Uint8Array,
    recoverOnFailure: boolean,
  ): Promise<PersistenceCommitResponse> {
    const request: PersistenceCommitRequest = {
      operationId,
      scope: "note-doc",
      documents: [
        {
          kind: handle.current.kind,
          documentId: handle.current.id,
          schemaVersion: handle.current.schemaVersion,
          baseRevision: handle.revision,
          snapshot:
            handle.revision === 0
              ? encodeProductDocument(handle.current)
              : null,
          update: handle.revision === 0 ? null : update,
        },
      ],
      localStates: [],
    };
    this.log.push({
      operationId,
      scope: "note-doc",
      status: "started",
      documentIds: [handle.current.id],
    });
    try {
      const response = await commitWithRetry(this.persistence, request);
      applyRevisions([handle], response);
      this.log.push({
        operationId,
        scope: "note-doc",
        status: response.deduplicated ? "deduplicated" : "committed",
        documentIds: [handle.current.id],
      });
      return response;
    } catch (error) {
      try {
        if (recoverOnFailure) await this.recover(handle);
      } finally {
        this.log.push({
          operationId,
          scope: "note-doc",
          status: "rolled-back",
          documentIds: [handle.current.id],
        });
      }
      throw error;
    }
  }

  /**
   * Persists an update that is already present in one live Y.Doc together
   * with derived mutations in other documents. This is used for editor input:
   * the NoteDoc update, its timestamp, and Workspace title cache must cross the
   * SQLite transaction boundary as one Core operation.
   */
  async commitAppliedUpdateTransaction(
    handle: ManagedCrdtDocument<ProductDocument>,
    related: readonly ManagedCrdtDocument<ProductDocument>[],
    operationId: string,
    appliedUpdate: Uint8Array,
    mutateDerived: () => void,
    searchIndexMetadataOnlyNoteId?: string,
  ): Promise<PersistenceCommitResponse> {
    const documents = [handle, ...related];
    if (new Set(documents).size !== documents.length) {
      throw new Error("Applied update transaction has duplicate documents");
    }
    const stateVectors = new Map(
      documents.map((document) => [
        document,
        Y.encodeStateVector(document.current.doc),
      ]),
    );
    this.log.push({
      operationId,
      scope: "workspace-structure",
      status: "started",
      documentIds: documents.map(({ current }) => current.id),
    });
    try {
      mutateDerived();
      const request: PersistenceCommitRequest = {
        operationId,
        scope: "workspace-structure",
        documents: documents.map((document) => {
          const current = document.current;
          if (document.revision === 0) {
            return {
              kind: current.kind,
              documentId: current.id,
              schemaVersion: current.schemaVersion,
              baseRevision: 0,
              snapshot: encodeProductDocument(current),
              update: null,
            };
          }
          const derivedUpdate = Y.encodeStateAsUpdate(
            current.doc,
            stateVectors.get(document),
          );
          return {
            kind: current.kind,
            documentId: current.id,
            schemaVersion: current.schemaVersion,
            baseRevision: document.revision,
            snapshot: null,
            // The already-applied editor delta is the complete NoteDoc
            // mutation for this operation. Encoding a same-state diff here
            // would still include Yjs delete sets from later queued edits,
            // making earlier persisted updates causally depend on the future.
            update: document === handle ? appliedUpdate : derivedUpdate,
          };
        }),
        localStates: [],
        searchIndexMetadataOnlyNoteId,
      };
      const response = await commitWithRetry(this.persistence, request);
      applyRevisions(documents, response);
      this.log.push({
        operationId,
        scope: "workspace-structure",
        status: response.deduplicated ? "deduplicated" : "committed",
        documentIds: documents.map(({ current }) => current.id),
      });
      return response;
    } catch (error) {
      await Promise.all(documents.map((document) => this.recover(document)));
      this.log.push({
        operationId,
        scope: "workspace-structure",
        status: "rolled-back",
        documentIds: documents.map(({ current }) => current.id),
      });
      throw error;
    }
  }

  async compactSnapshot(
    handle: ManagedCrdtDocument<ProductDocument>,
    operationId: string,
    expectedRevision: number,
    fault?: CommitFault,
  ): Promise<PersistenceCommitResponse> {
    if (handle.revision !== expectedRevision) {
      throw new Error(
        `snapshot revision conflict for ${handle.current.id}: expected ${expectedRevision}, actual ${handle.revision}`,
      );
    }
    const request: PersistenceCompactionRequest = {
      operationId,
      kind: handle.current.kind,
      documentId: handle.current.id,
      schemaVersion: handle.current.schemaVersion,
      expectedRevision,
      fault,
    };
    this.log.push({
      operationId,
      scope: "note-doc",
      status: "started",
      documentIds: [handle.current.id],
    });
    try {
      const response = await compactWithRetry(this.persistence, request);
      applyRevisions([handle], response);
      this.log.push({
        operationId,
        scope: "note-doc",
        status: response.deduplicated ? "deduplicated" : "committed",
        documentIds: [handle.current.id],
      });
      return response;
    } catch (error) {
      // Compaction does not mutate the live Y.Doc. Recovering it here would
      // discard editor updates that are queued behind this maintenance write.
      this.log.push({
        operationId,
        scope: "note-doc",
        status: "rolled-back",
        documentIds: [handle.current.id],
      });
      throw error;
    }
  }

  async persistLocalStates(
    operationId: string,
    states: LocalStateCommit[],
    fault?: CommitFault,
  ): Promise<PersistenceCommitResponse> {
    const request: PersistenceCommitRequest = {
      operationId,
      scope: "local-ui",
      documents: [],
      localStates: states,
      fault,
    };
    this.log.push({
      operationId,
      scope: "local-ui",
      status: "started",
      documentIds: [],
    });
    try {
      const response = await commitWithRetry(this.persistence, request);
      this.log.push({
        operationId,
        scope: "local-ui",
        status: response.deduplicated ? "deduplicated" : "committed",
        documentIds: [],
      });
      return response;
    } catch (error) {
      this.log.push({
        operationId,
        scope: "local-ui",
        status: "rolled-back",
        documentIds: [],
      });
      throw error;
    }
  }

  private async recover(
    handle: ManagedCrdtDocument<ProductDocument>,
  ): Promise<void> {
    const persisted = await this.persistence.loadDocument(
      handle.current.kind,
      handle.current.id,
    );
    const recovered = loadProductDocument(
      persisted.kind,
      persisted.documentId,
      persisted.snapshot,
      persisted.updates.map(({ update }) => update),
    );
    handle.replace(recovered, persisted.revision);
  }
}

async function commitWithRetry(
  persistence: PersistencePort,
  request: PersistenceCommitRequest,
): Promise<PersistenceCommitResponse> {
  try {
    return await persistence.commit(request);
  } catch (firstError) {
    try {
      return await persistence.commit(request);
    } catch {
      throw firstError;
    }
  }
}

async function compactWithRetry(
  persistence: PersistencePort,
  request: PersistenceCompactionRequest,
): Promise<PersistenceCommitResponse> {
  try {
    return await persistence.compact(request);
  } catch (firstError) {
    try {
      return await persistence.compact(request);
    } catch {
      throw firstError;
    }
  }
}

function applyRevisions(
  handles: ManagedCrdtDocument<ProductDocument>[],
  response: PersistenceCommitResponse,
): void {
  for (const revision of response.documents) {
    const handle = handles.find(
      ({ current }) =>
        current.kind === revision.kind && current.id === revision.documentId,
    );
    if (!handle) {
      throw new Error(
        `Persistence returned an unexpected document ${revision.kind}:${revision.documentId}`,
      );
    }
    handle.setRevision(revision.revision);
  }
}
