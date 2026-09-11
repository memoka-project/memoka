import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  SyncSettingsDialog,
  type SyncInvitation,
} from "../app/src/components/SyncSettingsDialog";
import {
  devicePhase,
  type SyncView,
  type SynchronizationPort,
} from "../app/src/platform/synchronization";
import { parseApplicationCommand } from "../app/src/core/application-command";

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock("../app/src/platform/clipboard", () => ({
  writeClipboardText: clipboard.writeText,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function view(enabled = true): SyncView {
  const member = {
    origin: { deviceId: "local", replicaId: "copy" },
    publicKey: "a".repeat(64),
    name: "Linux",
    revoked: false,
  };
  return {
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
      pendingApplyCount: 2,
      pendingApplyBytes: 2048,
      pendingSignatureCount: 3,
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
        pendingAppliedCount: 4,
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
        expiresAt: 4_102_444_800,
        approved: false,
      },
    ],
    listening: enabled ? "0.0.0.0:1234" : null,
    error: null,
  };
}

function fixture({
  enabled = true,
  candidates = [
    { interfaceName: "Wi-Fi", address: "192.168.1.5:1234" },
    { interfaceName: "VPN", address: "10.8.0.2:1234" },
  ],
  action = vi.fn(async () => ({})),
  invitation = null as SyncInvitation | null,
} = {}) {
  const currentView = view(enabled);
  const port = {
    status: vi.fn(async () => currentView),
    action,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    addressCandidates: vi.fn(async () => candidates),
  } satisfies SynchronizationPort;
  const restoreFocus = vi.fn(),
    onClose = vi.fn(),
    onReceive = vi.fn(),
    onInvitation = vi.fn();
  const initialInvitation = invitation;
  function Harness() {
    const [current, setCurrent] = useState<SyncInvitation | null>(
      initialInvitation,
    );
    return (
      <SyncSettingsDialog
        workspaceId="workspace"
        session={{ restoreFocus }}
        onClose={onClose}
        onRecovery={() => {}}
        onReceive={onReceive}
        invitation={current}
        onInvitation={(next) => {
          onInvitation(next);
          setCurrent(next);
        }}
        port={port}
      />
    );
  }
  render(<Harness />);
  return {
    port,
    view: currentView,
    restoreFocus,
    onClose,
    onReceive,
    onInvitation,
  };
}

it("opens the settings commands and enables networking through the guided first step", async () => {
  expect(parseApplicationCommand(":sync-settings")).toMatchObject({
    kind: "command",
    command: { id: "workspace.sync_settings" },
  });
  expect(parseApplicationCommand(":sync")).toMatchObject({
    kind: "command",
    command: { id: "workspace.sync" },
  });
  const { port } = fixture({ enabled: false });
  fireEvent.click(await screen.findByText("端末を追加"));
  const name = screen.getByLabelText("この端末の名前");
  expect(port.action).not.toHaveBeenCalled();
  expect(port.start).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "Laptop" } });
  fireEvent.click(screen.getByText("同期を有効にして次へ"));
  await screen.findByText("元端末で招待");
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "enable",
      name: "Laptop",
      bind: "0.0.0.0:0",
    }),
  );
});

it("labels queue direction, shows offline state, and binds approval and address changes to the reviewed key", async () => {
  const { port, view, onClose, restoreFocus } = fixture();
  await screen.findByText("未接続");
  expect(screen.getByText(/この端末で反映待ち 2件/)).toBeTruthy();
  expect(screen.getByText(/相手への送信待ち 3件/)).toBeTruthy();
  expect(screen.getByText(/相手で未反映（未受信分を含む） 4件/)).toBeTruthy();
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
  fireEvent.change(screen.getByLabelText("接続先アドレスを更新"), {
    target: { value: "10.0.0.2:1234" },
  });
  fireEvent.click(screen.getByText("同じ鍵の接続先アドレスを保存"));
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

it("offers interface candidates, creates an invitation, and copies the whole code", async () => {
  clipboard.writeText.mockResolvedValue(true);
  const action = vi.fn(async () => ({
    connectionInfo: "memoka-sync:secret",
    invitationId: "fresh-invite",
    expiresAt: 4_102_444_800,
  }));
  const { port, onInvitation } = fixture({ action });
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByText("192.168.1.5:1234（Wi-Fi）");
  expect(screen.getByText("10.8.0.2:1234（VPN）")).toBeTruthy();
  await waitFor(() =>
    expect(port.addressCandidates).toHaveBeenCalledWith("workspace"),
  );
  fireEvent.click(screen.getByLabelText("192.168.1.5:1234（Wi-Fi）"));
  fireEvent.click(screen.getByText("招待コードを作成"));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith("workspace", {
      action: "invite",
      addresses: ["192.168.1.5:1234"],
    }),
  );
  await screen.findByText("memoka-sync:secret");
  expect(onInvitation).toHaveBeenCalledWith({
    workspaceId: "workspace",
    invitationId: "fresh-invite",
    expiresAt: 4_102_444_800,
    code: "memoka-sync:secret",
  });
  fireEvent.click(screen.getByText("招待コードをコピー"));
  await screen.findByText("コピーしました");
  expect(clipboard.writeText).toHaveBeenCalledWith("memoka-sync:secret");
});

it("keeps manual entry available and reports copy failures without closing", async () => {
  clipboard.writeText.mockResolvedValue(false);
  const action = vi.fn(async () => ({
    connectionInfo: "memoka-sync:manual",
    invitationId: "manual-invite",
    expiresAt: 4_102_444_800,
  }));
  const { onClose } = fixture({
    candidates: [],
    action,
  });
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByText(/候補が見つかりませんでした。/);
  fireEvent.change(screen.getByLabelText("または手入力"), {
    target: { value: "172.16.0.8:4242" },
  });
  fireEvent.click(screen.getByText("招待コードを作成"));
  await screen.findByText("memoka-sync:manual");
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith("workspace", {
      action: "invite",
      addresses: ["172.16.0.8:4242"],
    }),
  );
  fireEvent.click(screen.getByText("招待コードをコピー"));
  await screen.findByText(/コピーできませんでした。/);
  expect(onClose).not.toHaveBeenCalled();
});

it("redisplays a still-valid in-memory invitation and opens receive from settings", async () => {
  clipboard.writeText.mockResolvedValue(true);
  const invitation: SyncInvitation = {
    workspaceId: "workspace",
    invitationId: "kept",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    code: "memoka-sync:kept",
  };
  const { onReceive, onInvitation, port } = fixture({
    invitation,
    action: vi.fn(async () => ({})),
  });
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByText("memoka-sync:kept");
  expect(port.action).not.toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ action: "invite" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "戻る" }));
  fireEvent.click(screen.getByText("通常の画面に戻る"));
  fireEvent.click(screen.getByText("別端末から受信"));
  expect(onReceive).toHaveBeenCalledOnce();
  expect(onInvitation).not.toHaveBeenCalledWith(null);
});
