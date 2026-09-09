import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CoreRuntime } from "./runtime";

export interface AgentEditIdentity {
  workspace_id: string;
  note_id: string | null;
  expected_revision: number | null;
  request_id: string;
}
export interface AgentDelivery {
  result: {
    revision_after: number;
    replayed: boolean;
    status: string;
    workspace_revision_before?: number;
    entry_id?: string;
    reindexed_entry_ids?: string[];
    section_edit?: boolean;
    deleted_section_ids?: string[];
    fallback_section_id?: string;
    sectionized_heading?: { block_id: string; section_id: string };
  };
  documents: {
    kind: "workspace" | "note";
    document_id: string;
    revision: number;
    update: number[];
  }[];
}
export const nativeAgentEdit = {
  prepare: (id: string) =>
    invoke<{ complete: boolean; delivery?: AgentDelivery }>(
      "agent_edit_prepare",
      { id },
    ),
  commit: (id: string) =>
    recoverAgentCommit(() =>
      invoke<AgentDelivery>("agent_edit_commit", { id }),
    ),
};

/** A transport failure is not a rollback. Keep the persistence barrier until
 * the retained native delivery can be published. This retries the same ticket,
 * never a new edit, and yields to the UI between attempts. A process restart
 * instead recovers from the durable document and receipt. */
export async function recoverAgentCommit(
  commit: () => Promise<AgentDelivery>,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<AgentDelivery> {
  for (;;) {
    try {
      return await commit();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code !== "AGENT_RESPONSE_LOST"
      )
        throw error;
      await pause();
    }
  }
}

/** Applying a retained Yjs update is idempotent, including after an observer
 * throws partway through publication. Do not let queued local writes persist
 * stale revisions while another Window still needs the durable update. */
export async function recoverAgentPublication(
  publish: () => void,
  isCurrent: () => boolean,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<boolean> {
  while (isCurrent()) {
    try {
      publish();
      return true;
    } catch {
      await pause();
    }
  }
  return false;
}
export async function installNativeAgentEditing(
  currentRuntime: () => CoreRuntime | null,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<{ id: string; request: AgentEditIdentity }>(
    "memoka-agent-edit",
    ({ payload }) => {
      void (async () => {
        let error: unknown = null;
        try {
          const runtime = currentRuntime();
          if (!runtime)
            throw {
              code: "EDIT_BUSY",
              message: "Workspace is not ready",
              details: null,
            };
          await runtime.applyExternalAgentEdit(
            payload.id,
            payload.request,
            () => currentRuntime() === runtime,
          );
        } catch (cause) {
          error =
            typeof cause === "object" && cause !== null && "code" in cause
              ? cause
              : {
                  code: "EDIT_BUSY",
                  message: "The editor could not complete the external edit",
                  details: null,
                };
        }
        await invoke("agent_edit_ack", { id: payload.id, error });
      })().catch(() => undefined);
    },
  );
}
