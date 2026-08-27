import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import type { CoreRuntime } from "./runtime";
import type { AttachmentMetadata } from "./attachments";
import {
  renderSectionMarkdown,
  type SectionMarkdownFileData,
  type SectionMarkdownRenderOptions,
} from "./section-markdown-backup";
import { sectionSnapshotAsync, type SectionSnapshot } from "./section-model";
import {
  createPortablePathProjection,
  portableFileComponent,
} from "./portable-paths";
import { createUuidV7 } from "./ids";
import {
  createNoteDocumentFromSectionSnapshot,
  createWorkspaceDocumentFromMetadata,
} from "./documents";

export const PORTABLE_MIRROR_SCHEMA_VERSION = 1;
const PORTABLE_MIRROR_CHUNK_BYTES = 4 * 1024 * 1024;

export type PortableMirrorFileKind = "markdown" | "document" | "attachment";

export interface PortableMirrorFileManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly kind: PortableMirrorFileKind;
}

export interface PortableMirrorDocumentEntry {
  readonly kind: "workspace" | "note";
  readonly documentId: string;
  readonly schemaVersion: number;
  readonly sourceRevision: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PortableMirrorAttachmentEntry {
  readonly attachmentId: string;
  readonly sha256: string;
  readonly size: number;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly createdAt: string;
  readonly path: string;
}

export interface PortableMirrorManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly workspaceId: string;
  readonly notes: readonly {
    readonly noteId: string;
    readonly parentNoteId: string | null;
    readonly deletedAt: string | null;
    readonly markdownPath: string;
    readonly sections: readonly {
      readonly sectionId: string;
      readonly markdownPath: string;
    }[];
  }[];
  readonly documents: readonly PortableMirrorDocumentEntry[];
  readonly attachments: readonly PortableMirrorAttachmentEntry[];
  readonly files: readonly PortableMirrorFileManifestEntry[];
}

interface PortableMirrorUpload {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly sourceAttachmentId?: string;
  readonly entry: PortableMirrorFileManifestEntry;
}

export interface PortableMirrorPublication {
  readonly manifest: PortableMirrorManifest;
  readonly uploads: readonly PortableMirrorUpload[];
}

export interface PortableMirrorBuildOptions {
  readonly signal?: AbortSignal;
  readonly budgetMilliseconds?: number;
  readonly yieldControl?: () => Promise<void>;
}

export interface PortableMirrorPublishOptions {
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: PortableMirrorPublishPhase) => void;
}

export type PortableMirrorPublishPhase = "staging" | "uploading" | "committing";

export type PortableMirrorActivityPhase =
  | "off"
  | "idle"
  | "waiting"
  | "flushing"
  | "preparing"
  | PortableMirrorPublishPhase
  | "error";

export interface PortableMirrorActivitySnapshot {
  readonly phase: PortableMirrorActivityPhase;
  readonly dirty: boolean;
  readonly lastResult: "published" | "cancelled" | "error" | null;
  readonly lastDurationMs: number | null;
}

interface PortableMirrorBeginRequest {
  readonly operationId: string;
  readonly manifest: string;
  readonly items: readonly {
    readonly path: string;
    readonly expectedSize: number;
    readonly sha256: string;
    readonly sourceAttachmentId?: string;
  }[];
}

export interface PortableMirrorPort {
  listAttachments(): Promise<readonly AttachmentMetadata[]>;
  publish(
    publication: PortableMirrorPublication,
    options?: PortableMirrorPublishOptions,
  ): Promise<void>;
}

export async function createPortableMirrorPublication(
  runtime: CoreRuntime,
  attachments: readonly AttachmentMetadata[],
  generatedAt = new Date().toISOString(),
  options: PortableMirrorBuildOptions = {},
): Promise<PortableMirrorPublication> {
  const scheduler = new PortableMirrorScheduler(options);
  const runtimeSnapshot = runtime.snapshot();
  const noteSources: Array<{
    metadata: (typeof runtimeSnapshot.notes)[number];
    rootSection: SectionSnapshot;
    schemaVersion: number;
    revision: number;
  }> = [];
  for (const metadata of runtimeSnapshot.notes) {
    const preview = await runtime.loadNotePreview(metadata.noteId, {
      includeDeleted: true,
    });
    try {
      const rootSection = await sectionSnapshotAsync(
        preview.document.rootSection,
        {
          signal: options.signal,
          checkpoint: () => scheduler.checkpoint(),
        },
      );
      noteSources.push({
        metadata: { ...metadata, title: rootSection.title },
        rootSection,
        schemaVersion: preview.document.schemaVersion,
        revision: preview.revision,
      });
    } finally {
      preview.release();
    }
    await scheduler.checkpoint(true);
  }

  const projection = await createPortablePathProjection(noteSources, {
    checkpoint: () => scheduler.checkpoint(),
  });
  const projectedByNote = new Map(
    projection.notes.map((note) => [note.noteId, note]),
  );
  const attachmentPaths = await allocateAttachmentPaths(attachments);
  const uploads: PortableMirrorUpload[] = [];
  const documents: PortableMirrorDocumentEntry[] = [];

  const sourceWorkspace = runtime.portableWorkspaceSnapshot();
  const baselineWorkspace = createWorkspaceDocumentFromMetadata(
    sourceWorkspace.workspaceId,
    noteSources.map(({ metadata }) => metadata),
  );
  const workspace = {
    ...sourceWorkspace,
    bytes: Y.encodeStateAsUpdate(baselineWorkspace.doc),
  };
  baselineWorkspace.doc.destroy();
  const workspaceUpload = await byteUpload(
    "memoka-recovery/workspace.yjs",
    workspace.bytes,
    "document",
  );
  uploads.push(workspaceUpload);
  documents.push({
    kind: "workspace",
    documentId: workspace.workspaceId,
    schemaVersion: workspace.schemaVersion,
    sourceRevision: workspace.revision,
    path: workspaceUpload.entry.path,
    sha256: workspaceUpload.entry.sha256,
    size: workspaceUpload.entry.size,
  });
  await scheduler.checkpoint(true);

  for (const source of noteSources) {
    const projected = projectedByNote.get(source.metadata.noteId);
    if (!projected)
      throw new Error(`Missing projected Note: ${source.metadata.noteId}`);
    const snapshots = flattenSections(source.rootSection);
    const relationships = sectionRelationships(source.rootSection);
    const rootFile = encodePortableSection(
      snapshots.get(source.metadata.noteId)!,
      relationships.get(source.metadata.noteId)!,
      projected.markdownPath,
      source.metadata.noteId,
      projection.markdownPathBySectionId,
      attachmentPaths,
    );
    uploads.push(
      await textUpload(projected.markdownPath, rootFile, "markdown"),
    );
    await scheduler.checkpoint();
    for (const sectionPath of projected.sections) {
      const snapshot = snapshots.get(sectionPath.sectionId);
      const relationship = relationships.get(sectionPath.sectionId);
      if (!snapshot || !relationship) {
        throw new Error(`Missing projected Section: ${sectionPath.sectionId}`);
      }
      uploads.push(
        await textUpload(
          sectionPath.markdownPath,
          encodePortableSection(
            snapshot,
            relationship,
            sectionPath.markdownPath,
            source.metadata.noteId,
            projection.markdownPathBySectionId,
            attachmentPaths,
          ),
          "markdown",
        ),
      );
      await scheduler.checkpoint();
    }
    await scheduler.checkpoint(true);
    const baselineNote = createNoteDocumentFromSectionSnapshot(
      source.metadata.noteId,
      source.rootSection,
      {
        createdAt: source.metadata.createdAt,
        updatedAt: source.metadata.updatedAt,
      },
    );
    const recoveryUpload = await byteUpload(
      projected.recoveryPath,
      Y.encodeStateAsUpdate(baselineNote.doc),
      "document",
    );
    baselineNote.doc.destroy();
    uploads.push(recoveryUpload);
    documents.push({
      kind: "note",
      documentId: source.metadata.noteId,
      schemaVersion: source.schemaVersion,
      sourceRevision: source.revision,
      path: recoveryUpload.entry.path,
      sha256: recoveryUpload.entry.sha256,
      size: recoveryUpload.entry.size,
    });
    await scheduler.checkpoint(true);
  }

  const attachmentEntries: PortableMirrorAttachmentEntry[] = [];
  for (const attachment of attachments) {
    if (!attachment.available) {
      throw new Error(
        `Attachment CAS object is unavailable: ${attachment.attachmentId}`,
      );
    }
    const path = attachmentPaths.get(attachment.attachmentId)!;
    const entry: PortableMirrorFileManifestEntry = {
      path,
      sha256: attachment.sha256,
      size: attachment.size,
      kind: "attachment",
    };
    uploads.push({
      path,
      sourceAttachmentId: attachment.attachmentId,
      entry,
    });
    attachmentEntries.push({
      attachmentId: attachment.attachmentId,
      sha256: attachment.sha256,
      size: attachment.size,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      createdAt: attachment.createdAt,
      path,
    });
    await scheduler.checkpoint();
  }

  const manifest: PortableMirrorManifest = {
    schemaVersion: PORTABLE_MIRROR_SCHEMA_VERSION,
    generatedAt,
    workspaceId: runtimeSnapshot.workspaceId,
    notes: runtimeSnapshot.notes.map((metadata) => {
      const projected = projectedByNote.get(metadata.noteId)!;
      return {
        noteId: metadata.noteId,
        parentNoteId: metadata.parentNoteId,
        deletedAt: metadata.deletedAt ?? null,
        markdownPath: projected.markdownPath,
        sections: projected.sections.map((section) => ({ ...section })),
      };
    }),
    documents,
    attachments: attachmentEntries,
    files: uploads.map(({ entry }) => entry),
  };
  await scheduler.checkpoint();
  return { manifest, uploads };
}

function encodePortableSection(
  snapshot: SectionSnapshot,
  relationship: { parentSectionId: string | null; order: number },
  currentPath: string,
  noteId: string,
  sectionPaths: ReadonlyMap<string, string>,
  attachmentPaths: ReadonlyMap<string, string>,
): string {
  const data: SectionMarkdownFileData = {
    sectionId: snapshot.sectionId,
    noteId,
    parentSectionId: relationship.parentSectionId,
    order: relationship.order,
    title: snapshot.title,
    emoji: snapshot.emoji,
    tags: [...snapshot.tags],
    body: [...snapshot.body],
  };
  const options: SectionMarkdownRenderOptions = {
    resolveInternalLink: (targetSectionId) => {
      const target = sectionPaths.get(targetSectionId);
      return target
        ? portableMarkdownDestination(relativePortablePath(currentPath, target))
        : targetSectionId;
    },
    resolveAttachment: (attachmentId) => {
      const target = attachmentPaths.get(attachmentId);
      return target
        ? portableMarkdownDestination(relativePortablePath(currentPath, target))
        : `attachment:${attachmentId}`;
    },
  };
  const fields: Array<[string, unknown]> = [
    ["memoka_portable_mirror", PORTABLE_MIRROR_SCHEMA_VERSION],
    ["section_id", data.sectionId],
    ["note_id", data.noteId],
    ["parent_section_id", data.parentSectionId],
    ["order", data.order],
    ["title", data.title],
    ["emoji", data.emoji ?? null],
    ["tags", data.tags],
  ];
  const frontmatter = fields
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n${renderSectionMarkdown(data.title, data.body, options)}`;
}

function flattenSections(root: SectionSnapshot): Map<string, SectionSnapshot> {
  const result = new Map<string, SectionSnapshot>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    result.set(current.sectionId, current);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      pending.push(current.children[index]!);
    }
  }
  return result;
}

function sectionRelationships(
  root: SectionSnapshot,
): Map<string, { parentSectionId: string | null; order: number }> {
  const result = new Map<
    string,
    { parentSectionId: string | null; order: number }
  >([[root.sectionId, { parentSectionId: null, order: 0 }]]);
  const pending = [root];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    parent.children.forEach((child, order) => {
      result.set(child.sectionId, {
        parentSectionId: parent.sectionId,
        order,
      });
      pending.push(child);
    });
  }
  return result;
}

async function allocateAttachmentPaths(
  attachments: readonly AttachmentMetadata[],
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [...attachments].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.attachmentId.localeCompare(right.attachmentId),
  );
  for (const attachment of ordered) {
    let ordinal = 1;
    let filename = await portableFileComponent(
      attachment.originalFilename || "添付ファイル",
      ordinal,
    );
    while (used.has(filename.normalize("NFC").toLocaleLowerCase("en-US"))) {
      ordinal += 1;
      filename = await portableFileComponent(
        attachment.originalFilename || "添付ファイル",
        ordinal,
      );
    }
    used.add(filename.normalize("NFC").toLocaleLowerCase("en-US"));
    result.set(attachment.attachmentId, `memoka-attachments/${filename}`);
  }
  return result;
}

function relativePortablePath(fromFile: string, targetFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const target = targetFile.split("/");
  let shared = 0;
  while (shared < from.length && from[shared] === target[shared]) shared += 1;
  const relative = [
    ...Array.from({ length: from.length - shared }, () => ".."),
    ...target.slice(shared),
  ].join("/");
  return relative || target[target.length - 1]!;
}

function portableMarkdownDestination(path: string): string {
  return path
    .split("/")
    .map((component) =>
      component === ".."
        ? component
        : encodeURIComponent(component).replace(
            /[!'()*]/gu,
            (character) =>
              `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join("/");
}

async function textUpload(
  path: string,
  source: string,
  kind: PortableMirrorFileKind,
): Promise<PortableMirrorUpload> {
  return byteUpload(path, new TextEncoder().encode(source), kind);
}

async function byteUpload(
  path: string,
  bytes: Uint8Array,
  kind: PortableMirrorFileKind,
): Promise<PortableMirrorUpload> {
  const sha256 = await sha256Hex(bytes);
  return {
    path,
    bytes,
    entry: { path, sha256, size: bytes.byteLength, kind },
  };
}

class TauriPortableMirrorPort implements PortableMirrorPort {
  listAttachments(): Promise<readonly AttachmentMetadata[]> {
    return invoke("portable_mirror_list_attachments");
  }

  async publish(
    publication: PortableMirrorPublication,
    options: PortableMirrorPublishOptions = {},
  ): Promise<void> {
    throwIfMirrorAborted(options.signal);
    options.onPhase?.("staging");
    const operationId = createUuidV7();
    const request: PortableMirrorBeginRequest = {
      operationId,
      manifest: `${JSON.stringify(publication.manifest, null, 2)}\n`,
      items: publication.uploads.map(({ entry, sourceAttachmentId }) => ({
        path: entry.path,
        expectedSize: entry.size,
        sha256: entry.sha256,
        ...(sourceAttachmentId ? { sourceAttachmentId } : {}),
      })),
    };
    await invoke("portable_mirror_begin", { request });
    try {
      options.onPhase?.("uploading");
      for (let index = 0; index < publication.uploads.length; index += 1) {
        throwIfMirrorAborted(options.signal);
        const upload = publication.uploads[index]!;
        if (!upload.bytes) continue;
        if (upload.bytes.byteLength === 0) {
          await writeMirrorChunk(operationId, index, 0, upload.bytes);
          continue;
        }
        for (
          let offset = 0;
          offset < upload.bytes.byteLength;
          offset += PORTABLE_MIRROR_CHUNK_BYTES
        ) {
          await writeMirrorChunk(
            operationId,
            index,
            offset,
            upload.bytes.slice(offset, offset + PORTABLE_MIRROR_CHUNK_BYTES),
          );
          throwIfMirrorAborted(options.signal);
          await yieldToBrowser();
        }
      }
      throwIfMirrorAborted(options.signal);
      options.onPhase?.("committing");
      await invoke("portable_mirror_commit", { operationId });
    } catch (error) {
      await invoke("portable_mirror_cancel", { operationId }).catch(
        () => undefined,
      );
      throw error;
    }
  }
}

async function writeMirrorChunk(
  operationId: string,
  itemIndex: number,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  await invoke("portable_mirror_write_chunk", bytes, {
    headers: {
      "x-memoka-operation-id": operationId,
      "x-memoka-item-index": String(itemIndex),
      "x-memoka-chunk-offset": String(offset),
    },
  });
}

export function createDefaultPortableMirrorPort(): PortableMirrorPort | null {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return tauri ? new TauriPortableMirrorPort() : null;
}

export class PortableMirrorController {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private publishing: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private dirty = true;
  private disposed = false;
  private signature = "";
  private activityPhase: PortableMirrorActivityPhase = "idle";
  private activityLastResult: PortableMirrorActivitySnapshot["lastResult"] =
    null;
  private activityLastDurationMs: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: CoreRuntime,
    private readonly port: PortableMirrorPort,
    private readonly onError: (error: Error) => void,
    private readonly idleMilliseconds = 10_000,
  ) {
    this.unsubscribe = runtime.subscribe((snapshot) => {
      const signature = `${snapshot.workspaceRevision}:${snapshot.noteContentRevision}`;
      if (signature === this.signature) return;
      this.signature = signature;
      this.dirty = true;
      this.activeAbort?.abort();
      this.schedule();
    });
  }

  async flush(): Promise<void> {
    while (!this.disposed && (this.dirty || this.publishing)) {
      this.clearTimer();
      await this.publishDirty(false);
    }
  }

  destroy(): void {
    this.disposed = true;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.unsubscribe();
    this.clearTimer();
    this.activityPhase = "off";
  }

  activitySnapshot(): PortableMirrorActivitySnapshot {
    return {
      phase: this.activityPhase,
      dirty: this.dirty,
      lastResult: this.activityLastResult,
      lastDurationMs: this.activityLastDurationMs,
    };
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    if (!this.publishing) this.activityPhase = "waiting";
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.publishDirty().catch((error: unknown) =>
        this.onError(error instanceof Error ? error : new Error(String(error))),
      );
    }, this.idleMilliseconds);
  }

  private clearTimer(): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private async publishDirty(scheduleIfDirty = true): Promise<void> {
    if (this.publishing) {
      await this.publishing;
      return;
    }
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    const abort = new AbortController();
    this.activeAbort = abort;
    const startedAt = performance.now();
    this.activityPhase = "flushing";
    this.publishing = (async () => {
      await this.runtime.flush();
      throwIfMirrorAborted(abort.signal);
      this.activityPhase = "preparing";
      const sourceSignature = this.signature;
      const attachments = await this.port.listAttachments();
      throwIfMirrorAborted(abort.signal);
      const publication = await createPortableMirrorPublication(
        this.runtime,
        attachments,
        undefined,
        { signal: abort.signal },
      );
      if (this.signature !== sourceSignature) {
        this.dirty = true;
        return;
      }
      await this.port.publish(publication, {
        signal: abort.signal,
        onPhase: (phase) => {
          if (this.activeAbort === abort) this.activityPhase = phase;
        },
      });
      if (this.signature !== sourceSignature) this.dirty = true;
    })();
    try {
      await this.publishing;
      this.activityLastResult = this.dirty ? "cancelled" : "published";
    } catch (error) {
      this.dirty = true;
      if (isMirrorAbort(error)) {
        this.activityLastResult = "cancelled";
        this.activityPhase = this.disposed ? "off" : "waiting";
        return;
      }
      this.activityLastResult = "error";
      this.activityPhase = "error";
      throw error;
    } finally {
      this.activityLastDurationMs = performance.now() - startedAt;
      if (this.activeAbort === abort) this.activeAbort = null;
      this.publishing = null;
    }
    if (scheduleIfDirty && this.dirty && !this.disposed) {
      this.schedule();
    } else if (!this.dirty && !this.disposed) {
      this.activityPhase = "idle";
    }
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  let source: ArrayBuffer;
  if (bytes.buffer instanceof ArrayBuffer) {
    source =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
  } else {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    source = copy.buffer;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function yieldToBrowser(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

class PortableMirrorScheduler {
  private lastYield = performance.now();
  private readonly budgetMilliseconds: number;

  constructor(private readonly options: PortableMirrorBuildOptions) {
    this.budgetMilliseconds = Math.max(0, options.budgetMilliseconds ?? 8);
  }

  async checkpoint(force = false): Promise<void> {
    throwIfMirrorAborted(this.options.signal);
    if (
      !force &&
      performance.now() - this.lastYield < this.budgetMilliseconds
    ) {
      return;
    }
    await (this.options.yieldControl ?? yieldToBrowser)();
    this.lastYield = performance.now();
    throwIfMirrorAborted(this.options.signal);
  }
}

function throwIfMirrorAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Portable mirror preparation was cancelled");
  error.name = "AbortError";
  throw error;
}

function isMirrorAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
