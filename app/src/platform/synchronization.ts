import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SyncFrontier } from "../core/native-sync";

export interface SyncFailure {
  code: string;
  message: string;
}
export interface SyncMember {
  origin: { deviceId: string; replicaId: string };
  publicKey: string;
  name: string;
  revoked: boolean;
}
export interface SyncDevice {
  member: SyncMember;
  addresses: string[];
  connection: {
    connected: boolean;
    exchanging: boolean;
    checkpoint: boolean;
    attachments: boolean;
    lastContactAt: string | null;
    frontier: SyncFrontier;
    error: SyncFailure | null;
  };
  pendingReceivedCount: number;
  pendingAppliedCount: number;
  pendingBytes: number;
  checkpointRequired: boolean;
  lastAppliedAt: string | null;
}
export interface SyncView {
  workspaceId: string | null;
  attachmentTransfers: {
    sha256: string;
    size: number;
    received: number;
    complete: boolean;
    error: string | null;
  }[];
  failures: [string, string][];
  config:
    | ({
        workspaceId: string;
        groupId: string;
        publicKey: string;
        paused: boolean;
      } & Pick<SyncMember, "origin">)
    | null;
  local: {
    enabled: boolean;
    paused: boolean;
    frontier: SyncFrontier;
    pendingApplyCount: number;
    pendingApplyBytes: number;
    pendingSignatureCount: number;
    pendingAttachmentCount: number;
    pendingAttachmentBytes: number;
    quarantinedCount: number;
    lastAppliedAt: string | null;
  };
  devices: SyncDevice[];
  pending: {
    invitationId: string;
    member: SyncMember;
    fingerprint: string;
    expiresAt: number;
    approved: boolean;
  }[];
  listening: string | null;
  error: SyncFailure | null;
}
export interface SyncAddressCandidate {
  interfaceName: string;
  address: string;
}
export interface SyncActionResult {
  connectionInfo?: string;
  invitationId?: string;
  expiresAt?: number;
}
export type SyncAction =
  | { action: "enable"; name: string; bind: string }
  | { action: "pause"; paused: boolean }
  | { action: "invite"; addresses: string[] }
  | { action: "approve"; invitationId: string; expectedPublicKey: string }
  | { action: "reject"; invitationId: string }
  | { action: "revoke"; deviceId: string; expectedPublicKey: string }
  | {
      action: "addresses";
      deviceId: string;
      expectedPublicKey: string;
      addresses: string[];
    }
  | { action: "listen"; bind: string }
  | { action: "reconnect" }
  | { action: "reset" }
  | { action: "retryAttachment"; sha256: string };
export interface SynchronizationPort {
  status(): Promise<SyncView>;
  start(workspaceId: string): Promise<void>;
  stop(workspaceId: string): Promise<void>;
  addressCandidates(workspaceId: string): Promise<SyncAddressCandidate[]>;
  action(
    workspaceId: string,
    action: SyncAction,
  ): Promise<SyncActionResult | null>;
}
export const nativeSynchronization: SynchronizationPort = {
  status: () => invoke("sync_status"),
  start: (workspaceId) => invoke("sync_start", { workspaceId }),
  stop: (workspaceId) => invoke("sync_stop", { workspaceId }),
  addressCandidates: (workspaceId) =>
    invoke("sync_address_candidates", { workspaceId }),
  action: (workspaceId, action) =>
    invoke("sync_action", { workspaceId, action }),
};
export function synchronizationAvailable(): boolean {
  return isTauri();
}
export function synchronizationError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause)
    return String(cause.message);
  return String(cause);
}
export function devicePhase(
  device: SyncDevice,
  paused: boolean,
  local?: SyncFrontier,
): string {
  if (device.member.revoked) return "登録解除済み";
  if (paused) return "一時停止";
  if (!device.connection.connected) return "未接続";
  if (device.connection.checkpoint) return "文書を受信中";
  if (device.connection.attachments) return "添付を取得中";
  if (local) {
    const remote = Object.entries(device.connection.frontier.applied);
    if (
      remote.some(
        ([replica, sequence]) => (local.received[replica] ?? 0) < sequence,
      )
    )
      return "受信待ち";
    if (
      remote.some(
        ([replica, sequence]) => (local.applied[replica] ?? 0) < sequence,
      )
    )
      return "受信済み・反映待ち";
  }
  if (device.pendingReceivedCount || device.checkpointRequired)
    return "送信待ち";
  if (device.pendingAppliedCount) return "受信済み・反映待ち";
  return "接続済み・本文の反映を確認";
}

// Serialize lifecycle IPC, including development remounts. An older cleanup
// cannot stop the controller started by the next Workspace effect.
let lifecycle = Promise.resolve();
export function watchSynchronization(
  workspaceId: string,
  update: (view: SyncView) => void,
  failed: (message: string) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const view = await nativeSynchronization.status();
      if (!stopped && (!view.config || view.config.workspaceId === workspaceId))
        update(view);
    } catch (cause) {
      if (!stopped) failed(synchronizationError(cause));
    } finally {
      if (!stopped) timer = setTimeout(() => void read(), 1000);
    }
  };
  lifecycle = lifecycle
    .catch(() => undefined)
    .then(async () => {
      if (stopped) return;
      try {
        await nativeSynchronization.start(workspaceId);
      } catch (cause) {
        if (!stopped) failed(synchronizationError(cause));
      }
    });
  void lifecycle.then(() => {
    if (!stopped) void read();
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => nativeSynchronization.stop(workspaceId));
  };
}
