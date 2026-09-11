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
  type SyncActionResult,
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

const factText = (label: string) =>
  screen.getAllByText(label)[0]!.closest("div")?.textContent ?? "";

function view(
  enabled = true,
  diagnostics = false,
  selfRevoked = false,
): SyncView {
  const member = {
    origin: { deviceId: "local", replicaId: "copy" },
    publicKey: "a".repeat(64),
    name: "Linux",
    revoked: false,
  };
  return {
    workspaceId: "workspace",
    attachmentTransfers: diagnostics
      ? [
          {
            sha256: "c".repeat(64),
            size: 20,
            received: 10,
            complete: false,
            error: "transfer failed",
          },
        ]
      : [],
    failures: diagnostics ? [["d".repeat(64), "invalid signature"]] : [],
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
      quarantinedCount: diagnostics ? 1 : 0,
      lastAppliedAt: null,
    },
    devices: [
      {
        member: { ...member, revoked: selfRevoked },
        addresses: [],
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
  diagnostics = false,
  selfRevoked = false,
  candidates = [
    { interfaceName: "Wi-Fi", address: "192.168.1.5:1234" },
    { interfaceName: "VPN", address: "10.8.0.2:1234" },
  ],
  action = vi.fn(async (): Promise<SyncActionResult | null> => null),
  invitation = null as SyncInvitation | null,
} = {}) {
  const currentView = view(enabled, diagnostics, selfRevoked);
  const port = {
    status: vi.fn(async () => currentView),
    action,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    addressCandidates: vi.fn(async () => candidates),
  } satisfies SynchronizationPort;
  const restoreFocus = vi.fn(),
    onClose = vi.fn(),
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
    onInvitation,
  };
}

it("separates status and other-device tabs without extra entries", async () => {
  fixture();
  const tabs = await screen.findByRole("tablist", {
    name: "同期設定の画面",
  });
  expect(tabs.querySelectorAll("[aria-selected='true']")).toHaveLength(1);
  expect(
    screen.getByRole("tab", { name: "状態", selected: true }),
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "他端末", selected: false }),
  ).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "設定" })).toBeNull();
  expect(screen.queryByText("別端末から受信")).toBeNull();
  expect(screen.queryByText("保護された内容を復旧")).toBeNull();
  expect(screen.queryByText(/同じユーザーの端末を/)).toBeNull();
});

it("shows self status, operations, and always-visible diagnostics on the status tab", async () => {
  const { port } = fixture({ diagnostics: true });
  await screen.findByRole("tab", { name: "状態", selected: true });
  expect(screen.getAllByText("待受中").length).toBeGreaterThan(0);
  expect(factText("待ち受けアドレス")).toContain("0.0.0.0:1234");
  expect(factText("反映待ち")).toContain("2件");
  expect(factText("添付取得待ち")).toContain("1件");
  expect(factText("検証失敗")).toContain("1件");
  expect(screen.getByText("送信待ち 3件")).toBeTruthy();
  expect(screen.getByText("検証失敗の詳細（先頭50件）")).toBeTruthy();
  expect(screen.getByText(/invalid signature/)).toBeTruthy();
  expect(screen.getByText("添付取得の詳細（先頭64件）")).toBeTruthy();
  expect(screen.getByRole("button", { name: "一時停止" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "今すぐ同期" }));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "reconnect",
    }),
  );
});

it("starts synchronization from the unconfigured status tab", async () => {
  expect(parseApplicationCommand(":sync-settings")).toMatchObject({
    kind: "command",
    command: { id: "workspace.sync_settings" },
  });
  const { port } = fixture({ enabled: false });
  expect(await screen.findByText("同期未設定")).toBeTruthy();
  fireEvent.click(screen.getByText("元端末として同期を始める"));
  fireEvent.change(screen.getByLabelText("この端末の名前"), {
    target: { value: "Laptop" },
  });
  fireEvent.click(screen.getByText("同期を有効にして次へ"));
  await screen.findByRole("heading", { name: "元端末で招待" });
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "enable",
      name: "Laptop",
      bind: "0.0.0.0:0",
    }),
  );
});

it("edits the listen address in a sub-screen and returns without closing", async () => {
  const { port, onClose } = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "変更" }));
  expect(
    (screen.getByLabelText("IPアドレスとUDPポート") as HTMLInputElement).value,
  ).toBe("0.0.0.0:1234");
  fireEvent.click(screen.getByRole("button", { name: "自動" }));
  expect(
    (screen.getByLabelText("IPアドレスとUDPポート") as HTMLInputElement).value,
  ).toBe("0.0.0.0:0");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await screen.findByRole("tablist", { name: "同期設定の画面" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "変更" }));
  fireEvent.change(screen.getByLabelText("IPアドレスとUDPポート"), {
    target: { value: "0.0.0.0:4242" },
  });
  fireEvent.click(screen.getByRole("button", { name: "変更" }));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "listen",
      bind: "0.0.0.0:4242",
    }),
  );
  await screen.findByRole("tablist", { name: "同期設定の画面" });
});

it("confirms self revocation in a sub-screen with a red action", async () => {
  const { port, onClose } = fixture();
  fireEvent.click(
    await screen.findByRole("button", { name: "この端末の登録を解除…" }),
  );
  expect(screen.getByText(/この端末を同期から削除します。/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  await screen.findByRole("tablist", { name: "同期設定の画面" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "この端末の登録を解除…" }),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await screen.findByRole("tablist", { name: "同期設定の画面" });
  fireEvent.click(
    screen.getByRole("button", { name: "この端末の登録を解除…" }),
  );
  const confirm = screen.getByRole("button", { name: "解除" });
  expect(confirm.classList.contains("sync-danger-button")).toBe(true);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "revoke",
      deviceId: "local",
      expectedPublicKey: "a".repeat(64),
    }),
  );
});

it("shows a revoked state and returns the workspace to unconfigured sync", async () => {
  const { port } = fixture({ selfRevoked: true });
  expect(await screen.findByText("登録解除済み")).toBeTruthy();
  expect(
    screen.getByText(/この端末は同期グループから解除されています。/),
  ).toBeTruthy();
  expect(screen.queryByText("一時停止")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "他端末" }));
  expect(
    screen.getByText(
      /この端末は同期グループから解除されているため、他端末を管理できません。/,
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "端末を追加" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "状態" }));
  fireEvent.click(screen.getByRole("button", { name: "同期を未設定に戻す" }));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "reset",
    }),
  );
});

it("lists other devices inline and edits their reviewed address", async () => {
  const { port, view, onClose } = fixture();
  fireEvent.click(await screen.findByRole("tab", { name: "他端末" }));
  expect(await screen.findByText("Windows")).toBeTruthy();
  expect(devicePhase(view.devices[0], false)).toBe("未接続");
  expect(screen.getByText(/相手で未反映（未受信分を含む） 4件/)).toBeTruthy();
  expect(screen.getAllByText(/192\.168\.1\.3:1234/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "変更" }));
  fireEvent.change(
    screen.getByLabelText("接続先アドレス（複数は改行区切り）"),
    {
      target: { value: "10.0.0.2:1234" },
    },
  );
  fireEvent.keyDown(screen.getByRole("dialog"), {
    key: "c",
    ctrlKey: true,
  });
  await screen.findByRole("button", { name: "端末を追加" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "変更" })[0]!);
  fireEvent.change(
    screen.getByLabelText("接続先アドレス（複数は改行区切り）"),
    {
      target: { value: "10.0.0.2:1234" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "addresses",
      deviceId: "peer",
      expectedPublicKey: "a".repeat(64),
      addresses: ["10.0.0.2:1234"],
    }),
  );
  await screen.findByRole("button", { name: "端末を追加" });
});

it("keeps approvals and peer revocation on the other-device tab", async () => {
  const { port } = fixture();
  fireEvent.click(await screen.findByRole("tab", { name: "他端末" }));
  fireEvent.click(screen.getByText("この端末を承認"));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "approve",
      invitationId: "invite",
      expectedPublicKey: "a".repeat(64),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "登録解除…" }));
  expect(screen.getByText(/「Windows」を同期から削除します。/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "解除" }));
  await waitFor(() =>
    expect(port.action).toHaveBeenCalledWith("workspace", {
      action: "revoke",
      deviceId: "peer",
      expectedPublicKey: "a".repeat(64),
    }),
  );
  await screen.findByRole("button", { name: "端末を追加" });
});

it("offers interface candidates, creates an invitation, and copies the whole code", async () => {
  clipboard.writeText.mockResolvedValue(true);
  const action = vi.fn(async () => ({
    connectionInfo: "memoka-sync:secret",
    invitationId: "fresh-invite",
    expiresAt: 4_102_444_800,
  }));
  const { port, onInvitation } = fixture({ action });
  fireEvent.click(await screen.findByRole("tab", { name: "他端末" }));
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByText("192.168.1.5:1234（Wi-Fi）");
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
  const { onClose } = fixture({ candidates: [], action });
  fireEvent.click(await screen.findByRole("tab", { name: "他端末" }));
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByText(/候補が見つかりませんでした。/);
  fireEvent.change(screen.getByLabelText("または手入力"), {
    target: { value: "172.16.0.8:4242" },
  });
  fireEvent.click(screen.getByText("招待コードを作成"));
  await screen.findByText("memoka-sync:manual");
  fireEvent.click(screen.getByText("招待コードをコピー"));
  await screen.findByText(/コピーできませんでした。/);
  expect(onClose).not.toHaveBeenCalled();
});

it("returns from the add flow with Esc and closes from the base view", async () => {
  const { onClose, restoreFocus } = fixture();
  fireEvent.click(await screen.findByRole("tab", { name: "他端末" }));
  fireEvent.click(await screen.findByText("端末を追加"));
  await screen.findByRole("heading", { name: "元端末で招待" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await screen.findByRole("tablist", { name: "同期設定の画面" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  await waitFor(() => expect(restoreFocus).toHaveBeenCalledOnce());
});
