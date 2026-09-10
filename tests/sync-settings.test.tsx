import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SyncSettingsDialog } from "../app/src/components/SyncSettingsDialog";
import {
  devicePhase,
  type SyncView,
  type SynchronizationPort,
} from "../app/src/platform/synchronization";
import { parseApplicationCommand } from "../app/src/core/application-command";

afterEach(cleanup);
function fixture(enabled = true) {
  const member = {
    origin: { deviceId: "local", replicaId: "copy" },
    publicKey: "a".repeat(64),
    name: "Linux",
    revoked: false,
  };
  const view: SyncView = {
    workspaceId: "workspace",
    attachmentTransfers: [],
    failures: [],
    config: enabled
      ? { ...member, workspaceId: "workspace", groupId: "group", paused: false }
      : null,
    local: {
      enabled,
      paused: false,
      frontier: { received: {}, applied: {} },
      pendingApplyCount: 0,
      pendingApplyBytes: 0,
      pendingSignatureCount: 0,
      pendingAttachmentCount: 1,
      pendingAttachmentBytes: 100,
      quarantinedCount: 0,
      lastAppliedAt: null,
    },
    devices: [
      {
        member: {
          ...member,
          name: "Windows",
          origin: { deviceId: "peer", replicaId: "other" },
        },
        addresses: ["192.168.1.3:1234"],
        connection: {
          connected: false,
          exchanging: false,
          checkpoint: false,
          attachments: false,
          lastContactAt: null,
          frontier: { received: {}, applied: {} },
          error: null,
        },
        pendingReceivedCount: 0,
        pendingAppliedCount: 0,
        pendingBytes: 0,
        checkpointRequired: false,
        lastAppliedAt: null,
      },
    ],
    pending: [
      {
        invitationId: "invite",
        member: { ...member, name: "New device" },
        fingerprint: "candidate key",
        expiresAt: 1900000000,
        approved: false,
      },
    ],
    listening: enabled ? "0.0.0.0:1234" : null,
    error: null,
  };
  const port = {
    status: vi.fn(async () => view),
    action: vi.fn(async () => ({})),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies SynchronizationPort;
  const restoreFocus = vi.fn(),
    onClose = vi.fn();
  render(
    <SyncSettingsDialog
      workspaceId="workspace"
      session={{ restoreFocus }}
      onClose={onClose}
      onRecovery={() => {}}
      port={port}
    />,
  );
  return { port, view, restoreFocus, onClose };
}
it("opens the settings commands and enables networking only through an explicit action", async () => {
  expect(parseApplicationCommand(":sync-settings")).toMatchObject({
    kind: "command",
    command: { id: "workspace.sync_settings" },
  });
  expect(parseApplicationCommand(":sync")).toMatchObject({
    kind: "command",
    command: { id: "workspace.sync" },
  });
  const { port } = fixture(false);
  const name = await screen.findByLabelText("この端末の名前");
  expect(port.action).not.toHaveBeenCalled();
  expect(port.start).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "Laptop" } });
  fireEvent.click(screen.getByText("同期を有効にする"));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "enable",
      name: "Laptop",
      bind: "0.0.0.0:0",
    }),
  );
});
it("shows offline state even with empty queues, and binds approval and address changes to the reviewed key", async () => {
  const { port, view, onClose, restoreFocus } = fixture();
  await screen.findByText("未接続");
  expect(devicePhase(view.devices[0], false)).toBe("未接続");
  const connected = {
    ...view.devices[0],
    connection: {
      ...view.devices[0].connection,
      connected: true,
      frontier: { received: { other: 2 }, applied: { other: 2 } },
    },
  };
  expect(devicePhase(connected, false, { received: {}, applied: {} })).toBe(
    "受信待ち",
  );
  expect(
    devicePhase(connected, false, { received: { other: 2 }, applied: {} }),
  ).toBe("受信済み・反映待ち");
  fireEvent.click(screen.getByText("この端末を承認"));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "approve",
      invitationId: "invite",
      expectedPublicKey: "a".repeat(64),
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("閉じる").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByText("端末の詳細"));
  fireEvent.change(screen.getByLabelText("接続情報を更新"), {
    target: { value: "10.0.0.2:1234" },
  });
  fireEvent.click(screen.getByText("同じ鍵のアドレスを保存"));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "addresses",
      deviceId: "peer",
      expectedPublicKey: "a".repeat(64),
      addresses: ["10.0.0.2:1234"],
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("閉じる").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  await waitFor(() => expect(restoreFocus).toHaveBeenCalledOnce());
});
