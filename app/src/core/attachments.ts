import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createUuidV7 } from "./ids";

export const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
export const MAX_ATTACHMENT_BATCH_FILES = 16;
export const MAX_ATTACHMENT_BATCH_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface AttachmentMetadata {
  readonly attachmentId: string;
  readonly sha256: string;
  readonly size: number;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly createdAt: string;
  readonly available: boolean;
  readonly previewable: boolean;
}

export interface AttachmentBatchItemInput {
  readonly attachmentId: string;
  readonly originalFilename: string;
  readonly declaredMimeType: string;
  readonly expectedSize: number;
}

export interface AttachmentBatchBeginRequest {
  readonly operationId: string;
  readonly createdAt: string;
  readonly items: readonly AttachmentBatchItemInput[];
}

export interface AttachmentBatchBeginResponse {
  readonly operationId: string;
  readonly state: "started" | "staged" | "cas_committed" | "completed";
  readonly deduplicated: boolean;
}

export interface AttachmentChunkResponse {
  readonly operationId: string;
  readonly attachmentId: string;
  readonly stagedSize: number;
  readonly complete: boolean;
  readonly deduplicated: boolean;
}

export interface AttachmentBatchResponse {
  readonly operationId: string;
  readonly deduplicated: boolean;
  readonly attachments: readonly AttachmentMetadata[];
}

export interface AttachmentNativePathItem {
  readonly attachmentId: string;
  readonly path: string;
}

export interface AttachmentClipboardFormats {
  readonly internal: string;
  readonly html: string;
  readonly markdown: string;
  readonly plain: string;
}

export interface AttachmentPort {
  beginBatch(
    request: AttachmentBatchBeginRequest,
  ): Promise<AttachmentBatchBeginResponse>;
  writeChunk(
    operationId: string,
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<AttachmentChunkResponse>;
  commitBatch(operationId: string): Promise<AttachmentBatchResponse>;
  cancelBatch(operationId: string): Promise<void>;
  importNativePaths(
    operationId: string,
    createdAt: string,
    items: readonly AttachmentNativePathItem[],
  ): Promise<AttachmentBatchResponse>;
  importClipboardImage(
    operationId: string,
    attachmentId: string,
    createdAt: string,
    originalFilename: string,
  ): Promise<AttachmentBatchResponse>;
  resolve(
    attachmentIds: readonly string[],
  ): Promise<readonly AttachmentMetadata[]>;
  previewUrl(attachmentId: string): string | null;
  open(attachmentId: string): Promise<void>;
  copyFiles(
    attachmentIds: readonly string[],
    formats: AttachmentClipboardFormats,
    publishImage?: boolean,
  ): Promise<void>;
}

interface MemoryBatch {
  readonly request: AttachmentBatchBeginRequest;
  readonly chunks: Map<string, Uint8Array>;
  response: AttachmentBatchResponse | null;
  cancelled: boolean;
}

export class MemoryAttachmentPort implements AttachmentPort {
  private readonly batches = new Map<string, MemoryBatch>();
  private readonly metadata = new Map<string, AttachmentMetadata>();
  private readonly objects = new Map<string, Uint8Array>();
  private readonly objectUrls = new Map<string, string>();

  async beginBatch(
    request: AttachmentBatchBeginRequest,
  ): Promise<AttachmentBatchBeginResponse> {
    validateAttachmentBatch(request.items);
    const existing = this.batches.get(request.operationId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw new Error("operation_id was reused with different content");
      }
      if (existing.cancelled) throw new Error("attachment batch was cancelled");
      return {
        operationId: request.operationId,
        state: existing.response ? "completed" : "started",
        deduplicated: true,
      };
    }
    this.batches.set(request.operationId, {
      request: structuredClone(request),
      chunks: new Map(
        request.items.map(({ attachmentId }) => [
          attachmentId,
          new Uint8Array(),
        ]),
      ),
      response: null,
      cancelled: false,
    });
    return {
      operationId: request.operationId,
      state: "started",
      deduplicated: false,
    };
  }

  async writeChunk(
    operationId: string,
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<AttachmentChunkResponse> {
    const batch = this.requireBatch(operationId);
    const item = batch.request.items.find(
      (candidate) => candidate.attachmentId === attachmentId,
    );
    const current = batch.chunks.get(attachmentId);
    if (!item || !current) throw new Error("unknown attachment item");
    if (offset < current.length) {
      const existing = current.slice(offset, offset + bytes.length);
      if (
        existing.length !== bytes.length ||
        !existing.every((value, index) => value === bytes[index])
      ) {
        throw new Error("attachment chunk retry does not match");
      }
      return {
        operationId,
        attachmentId,
        stagedSize: current.length,
        complete: current.length === item.expectedSize,
        deduplicated: true,
      };
    }
    if (
      offset !== current.length ||
      offset + bytes.length > item.expectedSize
    ) {
      throw new Error("invalid attachment chunk boundary");
    }
    const next = new Uint8Array(current.length + bytes.length);
    next.set(current);
    next.set(bytes, current.length);
    batch.chunks.set(attachmentId, next);
    return {
      operationId,
      attachmentId,
      stagedSize: next.length,
      complete: next.length === item.expectedSize,
      deduplicated: false,
    };
  }

  async commitBatch(operationId: string): Promise<AttachmentBatchResponse> {
    const batch = this.requireBatch(operationId);
    if (batch.response) {
      return { ...batch.response, deduplicated: true };
    }
    const attachments: AttachmentMetadata[] = [];
    for (const item of batch.request.items) {
      const bytes = batch.chunks.get(item.attachmentId);
      if (!bytes || bytes.length !== item.expectedSize) {
        throw new Error("attachment batch is not fully staged");
      }
      const sha256 = await sha256Hex(bytes);
      const mimeType = detectBrowserMime(bytes, item.declaredMimeType);
      this.objects.set(sha256, bytes.slice());
      const metadata: AttachmentMetadata = {
        attachmentId: item.attachmentId,
        sha256,
        size: item.expectedSize,
        originalFilename: item.originalFilename,
        mimeType,
        createdAt: batch.request.createdAt,
        available: true,
        previewable: isSafeRasterMime(mimeType),
      };
      this.metadata.set(item.attachmentId, metadata);
      attachments.push(metadata);
    }
    batch.response = {
      operationId,
      deduplicated: false,
      attachments,
    };
    return structuredClone(batch.response);
  }

  async cancelBatch(operationId: string): Promise<void> {
    const batch = this.requireBatch(operationId);
    if (batch.response) throw new Error("completed batch cannot be cancelled");
    batch.cancelled = true;
    batch.chunks.clear();
  }

  async importNativePaths(
    operationId: string,
    createdAt: string,
    items: readonly AttachmentNativePathItem[],
  ): Promise<AttachmentBatchResponse> {
    void operationId;
    void createdAt;
    void items;
    throw new Error(
      "native path attachment import is unavailable in browser mode",
    );
  }

  async importClipboardImage(
    operationId: string,
    attachmentId: string,
    createdAt: string,
    originalFilename: string,
  ): Promise<AttachmentBatchResponse> {
    void operationId;
    void attachmentId;
    void createdAt;
    void originalFilename;
    throw new Error("native image Clipboard is unavailable in browser mode");
  }

  async resolve(
    attachmentIds: readonly string[],
  ): Promise<readonly AttachmentMetadata[]> {
    return attachmentIds.flatMap((attachmentId) => {
      const metadata = this.metadata.get(attachmentId);
      return metadata ? [structuredClone(metadata)] : [];
    });
  }

  previewUrl(attachmentId: string): string | null {
    const metadata = this.metadata.get(attachmentId);
    if (!metadata?.previewable) return null;
    const current = this.objectUrls.get(attachmentId);
    if (current) return current;
    const bytes = this.objects.get(metadata.sha256);
    if (!bytes || typeof URL.createObjectURL !== "function") return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(
      new Blob([copy.buffer], { type: metadata.mimeType }),
    );
    this.objectUrls.set(attachmentId, url);
    return url;
  }

  async open(): Promise<void> {
    throw new Error("native attachment opener is unavailable in browser mode");
  }

  async copyFiles(
    attachmentIds: readonly string[],
    formats: AttachmentClipboardFormats,
    publishImage = false,
  ): Promise<void> {
    void attachmentIds;
    void formats;
    void publishImage;
    throw new Error("native file Clipboard is unavailable in browser mode");
  }

  private requireBatch(operationId: string): MemoryBatch {
    const batch = this.batches.get(operationId);
    if (!batch || batch.cancelled) throw new Error("unknown attachment batch");
    return batch;
  }
}

export class TauriAttachmentPort implements AttachmentPort {
  async beginBatch(
    request: AttachmentBatchBeginRequest,
  ): Promise<AttachmentBatchBeginResponse> {
    return invoke("attachment_batch_begin", { request });
  }

  async writeChunk(
    operationId: string,
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<AttachmentChunkResponse> {
    return invoke("attachment_batch_write_chunk", bytes, {
      headers: {
        "x-memoka-operation-id": operationId,
        "x-memoka-attachment-id": attachmentId,
        "x-memoka-chunk-offset": String(offset),
      },
    });
  }

  async commitBatch(operationId: string): Promise<AttachmentBatchResponse> {
    return invoke("attachment_batch_commit", { operationId });
  }

  async cancelBatch(operationId: string): Promise<void> {
    return invoke("attachment_batch_cancel", { operationId });
  }

  async importNativePaths(
    operationId: string,
    createdAt: string,
    items: readonly AttachmentNativePathItem[],
  ): Promise<AttachmentBatchResponse> {
    return invoke("attachment_import_native_paths", {
      request: { operationId, createdAt, items },
    });
  }

  async importClipboardImage(
    operationId: string,
    attachmentId: string,
    createdAt: string,
    originalFilename: string,
  ): Promise<AttachmentBatchResponse> {
    return invoke("attachment_import_clipboard_image", {
      request: { operationId, attachmentId, createdAt, originalFilename },
    });
  }

  async resolve(
    attachmentIds: readonly string[],
  ): Promise<readonly AttachmentMetadata[]> {
    return invoke("attachment_resolve", { attachmentIds });
  }

  previewUrl(attachmentId: string): string {
    return convertFileSrc(attachmentId, "memoka-attachment");
  }

  async open(attachmentId: string): Promise<void> {
    return invoke("attachment_open", { attachmentId });
  }

  async copyFiles(
    attachmentIds: readonly string[],
    formats: AttachmentClipboardFormats,
    publishImage = false,
  ): Promise<void> {
    return invoke("attachment_copy_files", {
      attachmentIds,
      formats,
      publishImage,
    });
  }
}

type AttachmentListener = (attachmentIds: readonly string[]) => void;

export class AttachmentRepository {
  private readonly metadata = new Map<string, AttachmentMetadata>();
  private readonly missing = new Set<string>();
  private readonly listeners = new Set<AttachmentListener>();

  constructor(
    readonly port: AttachmentPort,
    private readonly idFactory: () => string = createUuidV7,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  cached(attachmentId: string): AttachmentMetadata | null {
    return (
      this.metadata.get(attachmentId) ??
      (this.missing.has(attachmentId)
        ? {
            attachmentId,
            sha256: "",
            size: 0,
            originalFilename: "",
            mimeType: "application/octet-stream",
            createdAt: "",
            available: false,
            previewable: false,
          }
        : null)
    );
  }

  previewUrl(attachmentId: string): string | null {
    return this.port.previewUrl(attachmentId);
  }

  subscribe(listener: AttachmentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resolve(attachmentIds: readonly string[]): Promise<void> {
    const missing = [...new Set(attachmentIds)].filter(
      (attachmentId) => !this.metadata.has(attachmentId),
    );
    if (missing.length === 0) return;
    const resolved = await this.port.resolve(missing);
    this.remember(resolved);
    const found = new Set(resolved.map(({ attachmentId }) => attachmentId));
    for (const attachmentId of missing) {
      if (!found.has(attachmentId)) this.missing.add(attachmentId);
    }
  }

  async importFiles(
    files: readonly File[],
  ): Promise<readonly AttachmentMetadata[]> {
    const items = files.map((file) => ({
      attachmentId: this.idFactory(),
      originalFilename: file.name,
      declaredMimeType: file.type,
      expectedSize: file.size,
    }));
    validateAttachmentBatch(items);
    const operationId = this.idFactory();
    let began = false;
    try {
      await this.port.beginBatch({
        operationId,
        createdAt: this.clock(),
        items,
      });
      began = true;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex]!;
        const item = items[fileIndex]!;
        for (
          let offset = 0;
          offset < file.size;
          offset += ATTACHMENT_CHUNK_BYTES
        ) {
          const bytes = new Uint8Array(
            await file
              .slice(offset, offset + ATTACHMENT_CHUNK_BYTES)
              .arrayBuffer(),
          );
          await this.port.writeChunk(
            operationId,
            item.attachmentId,
            offset,
            bytes,
          );
        }
        if (file.size === 0) {
          await this.port.writeChunk(
            operationId,
            item.attachmentId,
            0,
            new Uint8Array(),
          );
        }
      }
      const response = await this.port.commitBatch(operationId);
      this.remember(response.attachments);
      return response.attachments;
    } catch (error) {
      if (began)
        await this.port.cancelBatch(operationId).catch(() => undefined);
      throw error;
    }
  }

  async importNativePaths(
    paths: readonly string[],
  ): Promise<readonly AttachmentMetadata[]> {
    if (paths.length === 0 || paths.length > MAX_ATTACHMENT_BATCH_FILES) {
      throw new Error(`添付は1回につき${MAX_ATTACHMENT_BATCH_FILES}件までです`);
    }
    const operationId = this.idFactory();
    try {
      const response = await this.port.importNativePaths(
        operationId,
        this.clock(),
        paths.map((path) => ({ attachmentId: this.idFactory(), path })),
      );
      this.remember(response.attachments);
      return response.attachments;
    } catch (error) {
      await this.port.cancelBatch(operationId).catch(() => undefined);
      throw error;
    }
  }

  async importClipboardImage(): Promise<AttachmentMetadata | null> {
    const operationId = this.idFactory();
    const attachmentId = this.idFactory();
    const createdAt = this.clock();
    const stamp = createdAt.replaceAll(/[^0-9]/gu, "").slice(0, 14);
    try {
      const response = await this.port.importClipboardImage(
        operationId,
        attachmentId,
        createdAt,
        `clipboard-image-${stamp}.png`,
      );
      this.remember(response.attachments);
      return response.attachments[0] ?? null;
    } catch (error) {
      await this.port.cancelBatch(operationId).catch(() => undefined);
      throw error;
    }
  }

  open(attachmentId: string): Promise<void> {
    return this.port.open(attachmentId);
  }

  copyFiles(
    attachmentIds: readonly string[],
    formats: AttachmentClipboardFormats,
    publishImage = false,
  ): Promise<void> {
    return publishImage
      ? this.port.copyFiles(attachmentIds, formats, true)
      : this.port.copyFiles(attachmentIds, formats);
  }

  private remember(entries: readonly AttachmentMetadata[]): void {
    if (entries.length === 0) return;
    for (const entry of entries) {
      this.missing.delete(entry.attachmentId);
      this.metadata.set(entry.attachmentId, entry);
    }
    const ids = entries.map(({ attachmentId }) => attachmentId);
    for (const listener of this.listeners) listener(ids);
  }
}

export function createDefaultAttachmentRepository(): AttachmentRepository {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return new AttachmentRepository(
    tauri ? new TauriAttachmentPort() : new MemoryAttachmentPort(),
  );
}

export function validateAttachmentBatch(
  items: readonly AttachmentBatchItemInput[],
): void {
  if (items.length === 0 || items.length > MAX_ATTACHMENT_BATCH_FILES) {
    throw new Error(`添付は1回につき${MAX_ATTACHMENT_BATCH_FILES}件までです`);
  }
  let total = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.expectedSize) || item.expectedSize < 0) {
      throw new Error("添付ファイルのサイズが不正です");
    }
    if (item.expectedSize > MAX_ATTACHMENT_BYTES) {
      throw new Error("添付ファイルは1件128 MiBまでです");
    }
    if (
      !item.originalFilename ||
      item.originalFilename.length > 255 ||
      item.originalFilename === "." ||
      item.originalFilename === ".." ||
      item.originalFilename.includes("/") ||
      item.originalFilename.includes("\\") ||
      hasControlCharacter(item.originalFilename)
    ) {
      throw new Error("安全でない添付ファイル名です");
    }
    total += item.expectedSize;
  }
  if (total > MAX_ATTACHMENT_BATCH_BYTES) {
    throw new Error("1回の添付は合計512 MiBまでです");
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isSafeRasterMime(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    mimeType,
  );
}

function detectBrowserMime(bytes: Uint8Array, declared: string): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const ascii = new TextDecoder().decode(bytes.slice(0, 12));
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  const normalized = declared.toLocaleLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(normalized) &&
    !isSafeRasterMime(normalized)
    ? normalized
    : "application/octet-stream";
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
