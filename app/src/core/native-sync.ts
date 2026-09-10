import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CoreRuntime } from "./runtime";

export interface SyncFrontier {
  received: Record<string, number>;
  applied: Record<string, number>;
}
export interface SyncDelivery {
  localHelpNoteIds: string[];
  workspaceId: string;
  groupId: string;
  affectedNoteIds: string[];
  documents: {
    kind: "workspace" | "note";
    documentId: string;
    revision: number;
    update: string;
  }[];
  frontier: SyncFrontier;
  workspaceRevisionBefore: number | null;
}
export interface SyncPreparation {
  id: string;
  workspaceId: string;
  groupId: string;
  affectedNoteIds: string[];
  documents: {
    kind: "workspace" | "note";
    documentId: string;
    baseRevision: number;
  }[];
  delivery: SyncDelivery | null;
}
export interface SyncPublicationPort {
  prepare(): Promise<SyncPreparation | null>;
  commit(id: string): Promise<SyncDelivery>;
  cancel(id: string): Promise<void>;
  ack(id: string): Promise<void>;
}

export const nativeSyncPublication: SyncPublicationPort = {
  prepare: () => invoke("sync_prepare"),
  commit: (id) => invoke("sync_commit", { id }),
  cancel: (id) => invoke("sync_cancel", { id }),
  ack: (id) => invoke("sync_ack", { id }),
};

export function syncErrorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

/** Keep the save barrier on an ambiguous response: the native side retains the
 * committed delivery until ack. Retrying this ticket cannot create a new edit. */
export async function recoverSyncCommit(
  port: SyncPublicationPort,
  id: string,
  pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
): Promise<SyncDelivery> {
  for (;;) {
    try {
      return await port.commit(id);
    } catch (error) {
      const code = syncErrorCode(error);
      if (code !== null && code !== "SYNC_RESPONSE_LOST") throw error;
      await pause();
    }
  }
}

export function decodeSyncUpdate(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Events and retries share one pump. A composition only postpones publication;
 * received bytes are already safe in the native inbox. No network wait is part
 * of this loop or the local shutdown durability barrier. */
export async function installNativeSynchronization(
  currentRuntime: () => CoreRuntime | null,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  let stopped = false;
  let running = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = () => {
    requested = true;
    if (running || stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, 0);
  };
  const pump = async () => {
    if (stopped || running) return;
    const runtime = currentRuntime();
    if (!runtime) return;
    running = true;
    requested = false;
    let retry = false;
    try {
      const result = await runtime.applyNextSynchronization(
        nativeSyncPublication,
        () => currentRuntime() === runtime,
      );
      retry = result !== "idle";
    } catch (error) {
      // Durable errors appear in synchronization status. Transient owner/IPC
      // failures retry without dismissing or refocusing the current Editor.
      retry = !["SYNC_DISABLED", "SYNC_GROUP", "SYNC_REVOKED"].includes(
        syncErrorCode(error) ?? "",
      );
    } finally {
      running = false;
      if (!stopped && (requested || retry)) {
        timer = setTimeout(() => {
          timer = null;
          void pump();
        }, 250);
      }
    }
  };
  const unlisten = await listen("memoka-sync-pending", request);
  request();
  return () => {
    stopped = true;
    unlisten();
    if (timer !== null) clearTimeout(timer);
  };
}
