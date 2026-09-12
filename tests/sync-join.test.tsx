import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SyncJoinDialog } from "../app/src/components/SyncJoinDialog";
import { MemoryDataAreaPort } from "../app/src/platform/data-area";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

function encodeInvitation(addresses: string[], expiresAt: number): string {
  const invitation = { addresses, expiresAt };
  const content = Array.from(
    new TextEncoder().encode(JSON.stringify(invitation)),
  );
  const signed = JSON.stringify({ content, signature: "00" });
  return `memoka-sync:${btoa(signed).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("starts a first receive as a distinct operation and waits for reviewed approval", async () => {
  native.invoke.mockImplementation(async (command: string) =>
    command === "sync_join_start"
      ? {
          path: "/fresh",
          phase: "approval",
          name: "Laptop",
          fingerprint: "review this key",
          error: null,
        }
      : null,
  );
  const onReady = vi.fn(async () => {}),
    onClose = vi.fn();
  render(
    <SyncJoinDialog
      dataArea={new MemoryDataAreaPort(false, "/fresh")}
      onReady={onReady}
      onClose={onClose}
    />,
  );
  fireEvent.change(screen.getByLabelText("この端末の名前"), {
    target: { value: "Laptop" },
  });
  fireEvent.change(
    screen.getByLabelText(
      "ここに同期元で作成した招待コードを貼り付けてください",
    ),
    {
      target: { value: "private invitation" },
    },
  );
  fireEvent.click(screen.getByText("新しい空の保存先を選択"));
  await screen.findByText("/fresh");
  fireEvent.click(screen.getByText("受信を開始"));
  await screen.findByText("招待側の承認待ち");
  expect(native.invoke).toHaveBeenCalledWith("sync_join_start", {
    path: "/fresh",
    connectionInfo: "private invitation",
    name: "Laptop",
  });
  expect(screen.getByText("review this key")).toBeTruthy();
  expect(onReady).not.toHaveBeenCalled();
  expect(screen.queryByText("Workspaceを開く")).toBeNull();
  fireEvent.click(screen.getByText("中断して閉じる"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(native.invoke).toHaveBeenCalledWith("sync_join_stop");
});

it("opens a durably completed receive without requiring the invitation again", async () => {
  native.invoke.mockResolvedValue({
    path: "/resumed",
    phase: "ready",
    name: "Laptop",
    fingerprint: "known key",
    error: null,
  });
  const onReady = vi.fn(async () => {});
  render(
    <SyncJoinDialog
      dataArea={new MemoryDataAreaPort(false)}
      onReady={onReady}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByText("Workspaceを開く"));
  await waitFor(() => expect(onReady).toHaveBeenCalledWith("/resumed"));
  expect(native.invoke).not.toHaveBeenCalledWith(
    "sync_join_start",
    expect.anything(),
  );
});

it("explains an expired invitation in Japanese and keeps the raw code in details", async () => {
  native.invoke.mockRejectedValue({
    code: "SYNC_INVITE_EXPIRED",
    message: "Invitation expired",
  });
  render(
    <SyncJoinDialog
      dataArea={new MemoryDataAreaPort(false, "/fresh")}
      onReady={vi.fn(async () => {})}
      onClose={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("この端末の名前"), {
    target: { value: "Laptop" },
  });
  fireEvent.change(
    screen.getByLabelText(
      "ここに同期元で作成した招待コードを貼り付けてください",
    ),
    {
      target: { value: "expired invitation" },
    },
  );
  fireEvent.click(screen.getByText("新しい空の保存先を選択"));
  await screen.findByText("/fresh");
  fireEvent.click(screen.getByText("受信を開始"));
  await screen.findByText("招待コードの有効期限が切れています。");
  expect(screen.getByText("Invitation expired")).toBeTruthy();
  fireEvent.click(screen.getByText("エラーの詳細"));
  expect(screen.getByText("SYNC_INVITE_EXPIRED")).toBeTruthy();
});

it("shows the inviter address and expiry while editing the code", async () => {
  native.invoke.mockResolvedValue(null);
  render(
    <SyncJoinDialog
      dataArea={new MemoryDataAreaPort(false)}
      onReady={vi.fn(async () => {})}
      onClose={() => {}}
    />,
  );
  const code = encodeInvitation(
    ["192.168.1.5:34722", "10.8.0.2:34722"],
    Math.floor(Date.now() / 1000) + 600,
  );
  fireEvent.change(
    screen.getByLabelText(
      "ここに同期元で作成した招待コードを貼り付けてください",
    ),
    { target: { value: code } },
  );
  expect(screen.getByText("192.168.1.5:34722、10.8.0.2:34722")).toBeTruthy();
  expect(screen.getByText(/有効期限/)).toBeTruthy();
  expect(screen.queryByText("（期限切れ）")).toBeNull();
});
