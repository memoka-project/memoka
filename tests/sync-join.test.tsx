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
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("receives into the selected fresh directory and waits for reviewed approval before opening it", async () => {
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
  fireEvent.change(screen.getByLabelText("接続情報"), {
    target: { value: "private invitation" },
  });
  fireEvent.click(screen.getByText("新しい保存先・再開する保存先を選択"));
  await screen.findByText("/fresh");
  fireEvent.click(screen.getByText("受信・再開"));
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
