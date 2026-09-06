import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { CoreRuntime } from "./runtime";
import type { SectionSnapshot } from "./section-model";

export interface NativeError {
  readonly code: string;
  readonly message: string;
}
export interface BackupState {
  readonly config: {
    schema_version: 3;
    interval_minutes: number;
    local_retention: BackupRetention;
    destinations: readonly BackupDestination[];
  };
  readonly status: {
    phase: string;
    last_local_capture_at: string | null;
    local_error: NativeError | null;
    maintenance_error: NativeError | null;
    known_missing_count: number;
    destinations: Readonly<Record<string, BackupDestinationStatus>>;
  };
}
export interface BackupRetention {
  readonly last: number;
  readonly daily: number;
  readonly monthly: number;
}
export const DEFAULT_BACKUP_RETENTION: BackupRetention = {
  last: 48,
  daily: 30,
  monthly: 12,
};
export interface BackupDestination {
  readonly id: string;
  readonly location:
    | { kind: "local-directory"; path: string }
    | {
        kind: "google-drive";
        connection_id: string;
        root_folder_id: string;
        display_name: string;
      };
  readonly repository_id: string;
  readonly enabled: boolean;
  readonly retention: BackupRetention;
}
export function backupDestinationLabel(target: BackupDestination): string {
  return target.location.kind === "local-directory"
    ? target.location.path
    : target.location.display_name;
}
export interface BackupDestinationStatus {
  readonly phase: string;
  readonly protected_capture_at: string | null;
  readonly last_copy_at: string | null;
  readonly error: NativeError | null;
  readonly maintenance_error: NativeError | null;
  readonly pending_copy_count: number;
  readonly expired_copy_count: number;
  readonly next_retry_at?: string | null;
  readonly active_generation_id?: string | null;
}
export type BackupSettingsRequest =
  | {
      kind: "add-google-drive";
      connectionId: string;
      retryIntent?: string;
      password: string;
      retention: BackupRetention;
    }
  | { kind: "local"; intervalMinutes: number; retention: BackupRetention }
  | {
      kind: "add";
      directory: string;
      password: string;
      retention: BackupRetention;
    }
  | { kind: "retention"; id: string; retention: BackupRetention }
  | { kind: "enabled"; id: string; enabled: boolean }
  | { kind: "remove"; id: string }
  | { kind: "credential"; id: string; password: string };

export function backupTransferFailures(
  state: BackupState,
): readonly { destination: BackupDestination; error: NativeError }[] {
  return state.config.destinations.flatMap((destination) => {
    const error = state.status.destinations[destination.id]?.error;
    return destination.enabled && error ? [{ destination, error }] : [];
  });
}
export function backupCopyingDestinations(
  state: BackupState,
): readonly BackupDestination[] {
  return state.config.destinations.filter(
    (destination) =>
      state.status.destinations[destination.id]?.phase === "copying",
  );
}
export interface HistoryGeneration {
  readonly descriptor: {
    generation_id: string;
    captured_at: string;
    workspace_id: string;
    document_revisions: Record<string, number>;
    known_missing: readonly string[];
  };
}
export interface HistoricalResource {
  readonly title: string;
  readonly section: SectionSnapshot;
  readonly depth: number;
  readonly markdown: string;
  readonly references: readonly {
    id: string;
    title: string | null;
    resolved: boolean;
  }[];
  readonly attachments: readonly {
    attachment_id: string;
    filename: string | null;
    available: boolean;
    mime_type: string | null;
  }[];
}
export interface BackupPort {
  status(): Promise<BackupState>;
  run(): Promise<unknown>;
  cancel(): Promise<void>;
  resume(): Promise<void>;
  maintainIdle(): Promise<unknown>;
  cloud?: CloudPort;
  scheduleCloud?(id?: string): Promise<unknown>;
  waitTransfers?(budgetMs: number): Promise<unknown>;
  settings(value: BackupSettingsRequest): Promise<void>;
  chooseAdditional(): Promise<string | null>;
  history(
    id: string | null,
  ): Promise<{ generations: readonly HistoryGeneration[] }>;
  read(id: string, generation: string): Promise<HistoricalResource>;
  tree(generation: string): Promise<readonly { id: string; title: string }[]>;
  imageUrl(id: string, generation: string): string;
  exportAttachment(
    id: string,
    generation: string,
    filename: string,
  ): Promise<void>;
}
export interface CloudConnection {
  readonly id: string;
  readonly account_display_label: string;
  readonly oauth_client_id: string;
  readonly last_verified_at: string | null;
  readonly auth_state: string;
  readonly bindings: readonly {
    workspace_id: string;
    destination_id: string;
    enabled: boolean;
  }[];
}
export interface CloudState {
  readonly configured: boolean;
  readonly experimental: boolean;
  readonly configuration_error?: NativeError | null;
  readonly connections: readonly CloudConnection[];
}
export interface CloudAuthStatus {
  readonly operation_id: string;
  readonly connection_id: string;
  readonly phase: string;
  readonly authorization_url: string | null;
  readonly error: NativeError | null;
}
export interface CloudInitIntent {
  id: string;
  phase: string;
  root_folder_id: string | null;
  display_name: string | null;
}
export interface CloudPort {
  list(): Promise<CloudState>;
  connect(name: string): Promise<CloudAuthStatus>;
  reconnect(connectionId: string): Promise<CloudAuthStatus>;
  authStatus(operationId: string): Promise<CloudAuthStatus>;
  cancelAuth(operationId: string): Promise<unknown>;
  disconnect(
    connectionId: string,
    stopDestinations?: boolean,
  ): Promise<unknown>;
  intents(connectionId: string): Promise<readonly CloudInitIntent[]>;
  recoveryInformation(destinationId: string): Promise<Record<string, string>>;
  cancelTransfer(destinationId: string): Promise<unknown>;
}
export function nativeErrorMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause)
    return String(cause.message);
  return String(cause);
}
export function createDefaultBackupPort(): BackupPort | null {
  if (!isTauri()) return null;
  const request = <T>(request: unknown): Promise<T> =>
    invoke<T>("workspace_native_query", { request });
  const cloud = <T>(request: unknown): Promise<T> =>
    invoke<T>("workspace_cloud", { request });
  return {
    status: () => request({ operation: "backup", action: { kind: "status" } }),
    run: () => request({ operation: "backup", action: { kind: "run" } }),
    cancel: () => invoke("workspace_backup_cancel"),
    resume: () => invoke("workspace_backup_resume"),
    maintainIdle: () =>
      request({ operation: "backup", action: { kind: "idle_maintain" } }),
    scheduleCloud: (id) =>
      request({
        operation: "backup",
        action: { kind: "cloud_tick", id: id ?? null },
      }),
    waitTransfers: (budgetMs) =>
      request({
        operation: "backup",
        action: { kind: "wait_transfers", budget_ms: budgetMs },
      }),
    cloud: {
      list: () => cloud({ kind: "list" }),
      connect: (name) => cloud({ kind: "connect", name }),
      reconnect: (connectionId) => cloud({ kind: "reconnect", connectionId }),
      authStatus: (operationId) => cloud({ kind: "auth-status", operationId }),
      cancelAuth: (operationId) => cloud({ kind: "cancel-auth", operationId }),
      disconnect: (connectionId, stopDestinations = false) =>
        cloud({ kind: "disconnect", connectionId, stopDestinations }),
      intents: (connectionId) => cloud({ kind: "intents", connectionId }),
      recoveryInformation: (destinationId) =>
        cloud({ kind: "recovery-information", destinationId }),
      cancelTransfer: (destinationId) =>
        cloud({ kind: "cancel-transfer", destinationId }),
    },
    settings: (request) => invoke("workspace_backup_settings", { request }),
    chooseAdditional: async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "追加バックアップ保存先の親ディレクトリ",
      });
      return typeof selected === "string" ? selected : null;
    },
    history: (id) => request({ operation: "history", id }),
    read: (id, generation) =>
      request({
        operation: "query",
        request: { command: "read", id, generation, include_trash: true },
      }),
    tree: async (generation) => {
      const notes: { id: string; title: string }[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          items: {
            title: string;
            namespace_path: readonly string[];
            target: { kind: string; id: string } | null;
          }[];
          next_cursor: string | null;
        } = await request({
          operation: "query",
          request: {
            command: "tree",
            generation,
            include_trash: true,
            limit: 1000,
            cursor,
          },
        });
        for (const item of page.items)
          if (item.target?.kind === "note")
            notes.push({
              id: item.target.id,
              title: item.namespace_path.join(" / "),
            });
        cursor = page.next_cursor;
      } while (cursor !== null);
      return notes;
    },
    imageUrl: (id, generation) =>
      convertFileSrc(`${generation}/${id}`, "memoka-history-attachment"),
    exportAttachment: async (id, generation, filename) => {
      const target = await save({
        defaultPath: filename,
        title: "履歴の添付を新しいファイルへ保存",
      });
      if (target)
        await invoke("workspace_history_attachment_export", {
          id,
          generation,
          target,
        });
    },
  };
}

/** Each run has one Core barrier, while expensive work is native/off-thread.
 * A final flush checks again after any earlier capture so edits made during
 * that capture are not accidentally treated as protected. */
export class BackupController {
  private pending: Promise<unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private cancellationEpoch = 0;
  private lastCheck = 0;
  private lastActivity = Date.now();
  private readonly recordActivity = (): void => {
    this.lastActivity = Date.now();
  };
  constructor(
    private readonly runtime: CoreRuntime,
    private readonly port: BackupPort,
    private readonly onError: (error: unknown) => void,
  ) {
    if (typeof window !== "undefined")
      for (const event of ["keydown", "pointerdown", "wheel"])
        window.addEventListener(event, this.recordActivity, {
          passive: true,
          capture: true,
        });
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(this.onError)
        .finally(() => this.schedule(60_000));
    }, delay);
  }
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const state = await this.port.status();
    if (this.stopped) return;
    await this.port.scheduleCloud?.();
    if (this.stopped) return;
    if (Date.now() - this.lastCheck >= state.config.interval_minutes * 60_000) {
      this.lastCheck = Date.now();
      await this.flush();
    }
    if (
      !this.stopped &&
      !this.pending &&
      Date.now() - this.lastActivity >= 30_000 &&
      this.runtime.backgroundTaskSnapshot().searchIndex.phase === "idle"
    ) {
      const pending = this.port.maintainIdle();
      this.pending = pending;
      try {
        await pending;
      } finally {
        if (this.pending === pending) this.pending = null;
      }
    }
  }
  run(): Promise<unknown> {
    if (this.pending) return this.pending;
    const epoch = this.cancellationEpoch;
    const assertActive = (): void => {
      if (epoch !== this.cancellationEpoch)
        throw {
          code: "CANCELLED",
          message: "バックアップをキャンセルしました",
        };
    };
    const result = (async () => {
      await this.runtime.flushDurableState();
      assertActive();
      await this.port.resume();
      assertActive();
      return this.port.run();
    })();
    this.pending = result;
    void result
      .finally(() => {
        if (this.pending === result) this.pending = null;
      })
      .catch(() => undefined);
    return result;
  }
  async flush(): Promise<void> {
    const epoch = this.cancellationEpoch;
    if (this.pending) await this.pending;
    if (epoch !== this.cancellationEpoch)
      throw { code: "CANCELLED", message: "バックアップをキャンセルしました" };
    await this.run();
  }
  pause(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.port.resume().catch(this.onError);
    this.schedule(60_000);
  }
  async cancel(): Promise<void> {
    this.pause();
    this.cancellationEpoch += 1;
    await this.port.cancel();
    await this.pending?.catch(() => undefined);
  }
  destroy(): void {
    this.pause();
    this.cancellationEpoch += 1;
    if (typeof window !== "undefined")
      for (const event of ["keydown", "pointerdown", "wheel"])
        window.removeEventListener(event, this.recordActivity, true);
  }
}
