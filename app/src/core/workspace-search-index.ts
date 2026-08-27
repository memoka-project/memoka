import {
  filterWorkspaceSearchCatalog,
  normalizeWorkspaceSearchText,
  workspaceSearchTerms,
  workspaceSearchJapaneseGrams,
  type WorkspaceSearchCatalog,
  type WorkspaceSearchDocument,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
} from "./workspace-search";

export const WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION = 8;

export interface WorkspaceSearchIndexedDocument extends WorkspaceSearchDocument {
  readonly sourceRevision: number;
}

export interface WorkspaceSearchIndexRebuildRequest {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly documents: readonly WorkspaceSearchIndexedDocument[];
}

export interface WorkspaceSearchIndexReplaceRequest {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly document: WorkspaceSearchIndexedDocument;
}

export interface WorkspaceSearchIndexMetadataRevisionRequest {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly workspaceRevision: number;
  readonly noteId: string;
}

export interface WorkspaceSearchIndexHierarchyEntry {
  readonly noteId: string;
  readonly parentNoteId: string | null;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly titleJapaneseGrams: string;
}

export interface WorkspaceSearchIndexHierarchyUpdateRequest {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly workspaceRevision: number;
  readonly entries: readonly WorkspaceSearchIndexHierarchyEntry[];
}

export type WorkspaceSearchIndexStrategy =
  "all-titles" | "empty" | "trigram" | "japanese-gram" | "scan";

export interface WorkspaceSearchIndexQueryRequest {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly query: string;
  readonly scope: WorkspaceSearchScope;
  readonly normalizedQuery: string;
  readonly normalizedTerms: readonly string[];
  readonly strategy: WorkspaceSearchIndexStrategy;
  readonly matchExpression: string;
  readonly limit: number;
  readonly excludedNoteIds: readonly string[];
}

export interface WorkspaceSearchIndexHit {
  readonly resultId: string;
  readonly noteId: string;
  readonly sectionId: string;
  readonly title: string;
  readonly parentPath: string;
  readonly updatedAt: string;
  readonly kind: WorkspaceSearchResult["kind"];
  readonly text: string;
  readonly blockId: string | null;
  readonly logicalLineNumber: number | null;
  readonly sectionLineNumber: number | null;
  readonly lineIndex: number;
  readonly sourceOffset: number;
}

export interface WorkspaceSearchIndexQueryResponse {
  readonly status: "ready" | "stale";
  readonly hits: readonly WorkspaceSearchIndexHit[];
}

export interface WireWorkspaceSearchIndexBlock {
  readonly blockId: string;
  readonly kind: "body";
  readonly sectionId: string;
  readonly text: string;
  readonly normalizedText: string;
  readonly japaneseGrams: string;
  readonly logicalLineNumber: number;
  readonly sectionLineNumber: number;
  readonly lineIndex: number;
  readonly sourceOffset: number;
}

export interface WireWorkspaceSearchIndexSection {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly titleJapaneseGrams: string;
  readonly order: number;
}

export interface WireWorkspaceSearchIndexedDocument {
  readonly noteId: string;
  readonly parentNoteId: string | null;
  readonly updatedAt: string;
  readonly sourceRevision: number;
  readonly sections: readonly WireWorkspaceSearchIndexSection[];
  readonly blocks: readonly WireWorkspaceSearchIndexBlock[];
}

export interface WireWorkspaceSearchIndexRebuildRequest extends Omit<
  WorkspaceSearchIndexRebuildRequest,
  "documents"
> {
  readonly documents: readonly WireWorkspaceSearchIndexedDocument[];
}

export interface WireWorkspaceSearchIndexReplaceRequest extends Omit<
  WorkspaceSearchIndexReplaceRequest,
  "document"
> {
  readonly document: WireWorkspaceSearchIndexedDocument;
}

/**
 * Rebuildable acceleration boundary. The index is never an editable source of
 * note content; implementations only receive projections derived by Core.
 */
export interface WorkspaceSearchIndexPort {
  rebuildWorkspaceSearchIndex(
    request: WorkspaceSearchIndexRebuildRequest,
  ): Promise<void>;
  replaceWorkspaceSearchIndexDocument(
    request: WorkspaceSearchIndexReplaceRequest,
  ): Promise<"updated" | "stale">;
  queryWorkspaceSearchIndex(
    request: WorkspaceSearchIndexQueryRequest,
  ): Promise<WorkspaceSearchIndexQueryResponse>;
  updateWorkspaceSearchIndexHierarchy?(
    request: WorkspaceSearchIndexHierarchyUpdateRequest,
  ): Promise<"updated" | "stale">;
  /**
   * Mirrors the atomic persistence optimization used when a NoteDoc edit only
   * changes the Workspace's derived title/timestamp cache. Production SQLite
   * performs this compare-and-swap inside the source commit; non-SQLite
   * contract doubles can use this hook to preserve the same revision model.
   */
  advanceWorkspaceSearchIndexMetadataRevision?(
    request: WorkspaceSearchIndexMetadataRevisionRequest,
  ): Promise<void>;
}

export function supportsWorkspaceSearchIndex(
  value: unknown,
): value is WorkspaceSearchIndexPort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceSearchIndexPort>;
  return (
    typeof candidate.rebuildWorkspaceSearchIndex === "function" &&
    typeof candidate.replaceWorkspaceSearchIndexDocument === "function" &&
    typeof candidate.queryWorkspaceSearchIndex === "function"
  );
}

export function workspaceSearchIndexQuery(
  workspaceId: string,
  workspaceRevision: number,
  query: string,
  scope: WorkspaceSearchScope = "title",
  limit = 20,
  excludedNoteIds: readonly string[] = [],
): WorkspaceSearchIndexQueryRequest {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Workspace search result limit must be between 1 and 100");
  }
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeWorkspaceSearchText(trimmedQuery);
  const normalizedTerms = workspaceSearchTerms(trimmedQuery);
  const termStrategies = normalizedTerms.map((term) => {
    if (Array.from(term).length >= 3) return "trigram" as const;
    return workspaceSearchJapaneseGrams(term).split(" ").includes(term)
      ? ("japanese-gram" as const)
      : ("scan" as const);
  });
  const strategy: WorkspaceSearchIndexStrategy =
    normalizedTerms.length === 0
      ? scope === "title"
        ? "all-titles"
        : "empty"
      : termStrategies.every((candidate) => candidate === "trigram")
        ? "trigram"
        : termStrategies.every((candidate) => candidate === "japanese-gram")
          ? "japanese-gram"
          : "scan";
  return {
    schemaVersion: WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION,
    workspaceId,
    workspaceRevision,
    query: trimmedQuery,
    scope,
    normalizedQuery,
    normalizedTerms,
    strategy,
    matchExpression:
      strategy === "trigram" || strategy === "japanese-gram"
        ? normalizedTerms
            .map((term) => `"${term.replaceAll('"', '""')}"`)
            .join(" AND ")
        : normalizedQuery,
    limit,
    excludedNoteIds: [...new Set(excludedNoteIds)].sort(),
  };
}

export function toWireWorkspaceSearchIndexRebuildRequest(
  request: WorkspaceSearchIndexRebuildRequest,
): WireWorkspaceSearchIndexRebuildRequest {
  return {
    ...request,
    documents: request.documents.map(toWireWorkspaceSearchDocument),
  };
}

export function toWireWorkspaceSearchIndexReplaceRequest(
  request: WorkspaceSearchIndexReplaceRequest,
): WireWorkspaceSearchIndexReplaceRequest {
  return {
    ...request,
    document: toWireWorkspaceSearchDocument(request.document),
  };
}

/** In-memory contract double used by Core tests; production uses SQLite FTS. */
export class MemoryWorkspaceSearchIndexPort implements WorkspaceSearchIndexPort {
  private request: WorkspaceSearchIndexRebuildRequest | null = null;
  rebuildAttemptCount = 0;
  rebuildCount = 0;
  replaceCount = 0;
  hierarchyUpdateCount = 0;
  hierarchyEntryUpdateCount = 0;
  queryCount = 0;
  failRebuild: Error | null = null;
  failQuery: Error | null = null;

  async rebuildWorkspaceSearchIndex(
    request: WorkspaceSearchIndexRebuildRequest,
  ): Promise<void> {
    this.rebuildAttemptCount += 1;
    if (this.failRebuild) throw this.failRebuild;
    validateRebuildRequest(request);
    this.request = structuredClone(request);
    this.rebuildCount += 1;
  }

  async replaceWorkspaceSearchIndexDocument(
    request: WorkspaceSearchIndexReplaceRequest,
  ): Promise<"updated" | "stale"> {
    this.replaceCount += 1;
    const indexed = this.request;
    if (
      !indexed ||
      indexed.schemaVersion !== request.schemaVersion ||
      indexed.workspaceId !== request.workspaceId ||
      indexed.workspaceRevision !== request.workspaceRevision
    ) {
      return "stale";
    }
    validateRebuildRequest({
      ...indexed,
      documents: [request.document],
    });
    const documents = indexed.documents.filter(
      ({ noteId }) => noteId !== request.document.noteId,
    );
    const previousIndex = indexed.documents.findIndex(
      ({ noteId }) => noteId === request.document.noteId,
    );
    documents.splice(
      previousIndex < 0 ? documents.length : previousIndex,
      0,
      structuredClone(request.document),
    );
    this.request = {
      ...indexed,
      workspaceRevision: request.workspaceRevision,
      documents,
    };
    return "updated";
  }

  async advanceWorkspaceSearchIndexMetadataRevision(
    request: WorkspaceSearchIndexMetadataRevisionRequest,
  ): Promise<void> {
    const indexed = this.request;
    if (
      !indexed ||
      indexed.schemaVersion !== request.schemaVersion ||
      indexed.workspaceId !== request.workspaceId ||
      indexed.workspaceRevision !== request.baseRevision ||
      !indexed.documents.some(({ noteId }) => noteId === request.noteId)
    ) {
      return;
    }
    this.request = {
      ...indexed,
      workspaceRevision: request.workspaceRevision,
    };
  }

  async updateWorkspaceSearchIndexHierarchy(
    request: WorkspaceSearchIndexHierarchyUpdateRequest,
  ): Promise<"updated" | "stale"> {
    this.hierarchyUpdateCount += 1;
    this.hierarchyEntryUpdateCount += request.entries.length;
    const indexed = this.request;
    if (
      !indexed ||
      indexed.schemaVersion !== request.schemaVersion ||
      indexed.workspaceId !== request.workspaceId ||
      indexed.workspaceRevision !== request.baseRevision
    ) {
      return "stale";
    }
    const entries = new Map(
      request.entries.map((entry) => [entry.noteId, entry]),
    );
    const documents = indexed.documents.map((document) => {
      const entry = entries.get(document.noteId);
      if (!entry) return document;
      return {
        ...document,
        parentNoteId: entry.parentNoteId,
        title: entry.title,
        sections: document.sections?.map((section, index) =>
          index === 0
            ? {
                ...section,
                title: entry.title,
                parentSectionId: null,
              }
            : section,
        ),
      };
    });
    this.request = {
      ...indexed,
      workspaceRevision: request.workspaceRevision,
      documents: reprojectMemoryHierarchy(documents),
    };
    return "updated";
  }

  async queryWorkspaceSearchIndex(
    request: WorkspaceSearchIndexQueryRequest,
  ): Promise<WorkspaceSearchIndexQueryResponse> {
    if (this.failQuery) throw this.failQuery;
    this.queryCount += 1;
    const indexed = this.request;
    if (
      !indexed ||
      indexed.schemaVersion !== request.schemaVersion ||
      indexed.workspaceId !== request.workspaceId ||
      indexed.workspaceRevision !== request.workspaceRevision
    ) {
      return { status: "stale", hits: [] };
    }
    const excluded = new Set(request.excludedNoteIds);
    const catalog: WorkspaceSearchCatalog = {
      documents: indexed.documents.filter(
        ({ noteId }) => !excluded.has(noteId),
      ),
      failures: [],
    };
    return {
      status: "ready",
      hits: filterWorkspaceSearchCatalog(
        catalog,
        request.query,
        request.scope,
        request.limit,
      ).map((result) => ({
        resultId: result.resultId,
        noteId: result.noteId,
        sectionId: result.sectionId,
        title: result.title,
        parentPath: result.parentPath,
        updatedAt: result.updatedAt,
        kind: result.kind,
        text:
          result.kind === "title"
            ? ""
            : (indexed.documents
                .find(({ noteId }) => noteId === result.noteId)
                ?.blocks.find(
                  ({ logicalLineNumber }) =>
                    logicalLineNumber === result.logicalLineNumber,
                )?.text ?? ""),
        blockId: result.blockId,
        logicalLineNumber: result.logicalLineNumber,
        sectionLineNumber: result.sectionLineNumber,
        lineIndex: result.lineIndex,
        sourceOffset:
          result.kind === "title"
            ? 0
            : (indexed.documents
                .find(({ noteId }) => noteId === result.noteId)
                ?.blocks.find(
                  ({ logicalLineNumber }) =>
                    logicalLineNumber === result.logicalLineNumber,
                )?.sourceOffset ?? 0),
      })),
    };
  }

  clear(): void {
    this.request = null;
  }
}

function validateRebuildRequest(
  request: WorkspaceSearchIndexRebuildRequest,
): void {
  if (request.schemaVersion !== WORKSPACE_SEARCH_INDEX_SCHEMA_VERSION) {
    throw new Error("Unsupported Workspace search index schema");
  }
  if (!request.workspaceId || request.workspaceRevision < 1) {
    throw new Error("Workspace search index requires a persisted workspace");
  }
  for (const document of request.documents) {
    if (!document.noteId || document.sourceRevision < 1) {
      throw new Error("Workspace search index requires persisted NoteDocs");
    }
  }
}

function toWireWorkspaceSearchDocument(
  document: WorkspaceSearchIndexedDocument,
): WireWorkspaceSearchIndexedDocument {
  return {
    noteId: document.noteId,
    parentNoteId: document.parentNoteId ?? null,
    updatedAt: document.updatedAt,
    sourceRevision: document.sourceRevision,
    sections: (
      document.sections ?? [
        {
          sectionId: document.noteId,
          title: document.title,
          parentPath: document.parentPath,
          order: 0,
        },
      ]
    ).map((section, index) => {
      const title = section.title || (index === 0 ? "新しいノート" : "無題");
      return {
        sectionId: section.sectionId,
        parentSectionId: section.parentSectionId ?? null,
        title,
        normalizedTitle: normalizeWorkspaceSearchText(title),
        titleJapaneseGrams: workspaceSearchJapaneseGrams(title),
        order: section.order,
      };
    }),
    blocks: document.blocks.map((block) => ({
      blockId: block.blockId,
      kind: block.kind,
      sectionId: block.sectionId,
      text: block.text,
      logicalLineNumber: block.logicalLineNumber,
      sectionLineNumber: block.sectionLineNumber,
      lineIndex: block.lineIndex,
      sourceOffset: block.sourceOffset,
      normalizedText: normalizeWorkspaceSearchText(block.text),
      japaneseGrams: workspaceSearchJapaneseGrams(block.text),
    })),
  };
}

function reprojectMemoryHierarchy(
  documents: readonly WorkspaceSearchIndexedDocument[],
): WorkspaceSearchIndexedDocument[] {
  const nodes = new Map<
    string,
    { readonly parentId: string | null; readonly title: string }
  >();
  for (const document of documents) {
    for (const [index, section] of (document.sections ?? []).entries()) {
      nodes.set(section.sectionId, {
        parentId:
          index === 0
            ? (document.parentNoteId ?? null)
            : (section.parentSectionId ?? null),
        title: section.title || (index === 0 ? "新しいノート" : "無題"),
      });
    }
  }
  const pathFor = (sectionId: string): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let parentId = nodes.get(sectionId)?.parentId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent) break;
      parts.push(parent.title);
      parentId = parent.parentId;
    }
    return parts.length > 0 ? `/${parts.reverse().join("/")}` : "/";
  };
  return documents.map((document) => {
    const sections = (document.sections ?? []).map((section) => ({
      ...section,
      parentPath: pathFor(section.sectionId),
    }));
    return {
      ...document,
      parentPath: pathFor(document.noteId),
      sections,
    };
  });
}
