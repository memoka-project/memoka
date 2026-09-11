import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../app/src/App";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryDataAreaPort } from "../app/src/platform/data-area";
import { backupFixture } from "./backup-fixture";
import type { BackupPort } from "../app/src/core/history";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: native.invoke,
}));
vi.mock("../app/src/platform/synchronization", async (original) => ({
  ...(await original<typeof import("../app/src/platform/synchronization")>()),
  synchronizationAvailable: () => true,
  watchSynchronization: () => () => {},
}));
beforeEach(() => {
  let view: unknown = null;
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "sync_join_start")
      view = {
        path: args.path,
        phase: "ready",
        name: args.name,
        fingerprint: "reviewed key",
        error: null,
      };
    if (command === "sync_join_stop") view = null;
    return view;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  native.invoke.mockReset();
});

async function openNewWorkspace(
  dataArea = new MemoryDataAreaPort(true, "memory://new-workspace"),
  backup: BackupPort | null = null,
) {
  const activate = vi.spyOn(dataArea, "activate");
  const view = render(
    <App dataArea={dataArea} backup={backup} desktopWindow={null} />,
  );
  await screen.findByRole("tree", { name: "ノートツリー" });
  const editor = view.container.querySelector<HTMLElement>(".memoka-editor")!;
  editor.focus();
  fireEvent.keyDown(editor, { key: "Escape" });
  fireEvent.keyDown(editor, { key: ":" });
  const command = await screen.findByRole("textbox", {
    name: "Memoka Command",
  });
  fireEvent.change(command, { target: { value: "new-workspace" } });
  fireEvent.keyDown(command, { key: "Enter" });
  await screen.findByRole("dialog", { name: "新しいWorkspace" });
  return { dataArea, activate, editor };
}

async function prepareReceive() {
  fireEvent.click(screen.getByRole("button", { name: "別端末から受信" }));
  await screen.findByRole("dialog", { name: "別端末から受信" });
  fireEvent.click(screen.getByRole("button", { name: "初めて受信" }));
  fireEvent.change(screen.getByLabelText("この端末の名前"), {
    target: { value: "Laptop" },
  });
  fireEvent.change(screen.getByLabelText("招待コード"), {
    target: { value: "invitation" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "新しい空の保存先を選択" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "受信を開始" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "受信を開始" }));
  await screen.findByRole("button", { name: "Workspaceを開く" });
}

it("opens receive from an existing Workspace and returns focus through both dialogs without switching", async () => {
  const { activate, editor } = await openNewWorkspace();
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
    true,
  );
  expect(native.invoke).not.toHaveBeenCalledWith(
    "sync_join_start",
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "別端末から受信" }));
  const receiving = await screen.findByRole("dialog", {
    name: "別端末から受信",
  });
  expect(receiving.contains(document.activeElement)).toBe(true);
  expect(editor.isConnected).toBe(true);
  fireEvent.keyDown(receiving, { key: "Escape" });
  const creating = await screen.findByRole("dialog", {
    name: "新しいWorkspace",
  });
  expect(creating.contains(document.activeElement)).toBe(true);
  expect(native.invoke).toHaveBeenCalledWith("sync_join_stop");
  fireEvent.keyDown(creating, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(activate).not.toHaveBeenCalled();
});

it("rejects an existing destination without switching or losing the current editor", async () => {
  const { dataArea, activate, editor } = await openNewWorkspace(
    new MemoryDataAreaPort(),
  );
  fireEvent.click(screen.getByRole("button", { name: "空のWorkspaceを作成" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "空のディレクトリ",
  );
  expect(activate).not.toHaveBeenCalled();
  expect((await dataArea.status()).path).toBe("memory://workspace");
  expect(editor.isConnected).toBe(true);
});

it.each(["create", "receive"])(
  "waits for durable local saves before switching after %s",
  async (method) => {
    const { dataArea, activate, editor } = await openNewWorkspace();
    const prepare = vi.spyOn(dataArea, "prepareNew");
    if (method === "receive") await prepareReceive();
    expect(activate).not.toHaveBeenCalled();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = CoreRuntime.prototype.flushDurableState;
    let saved = false;
    const flush = vi
      .spyOn(CoreRuntime.prototype, "flushDurableState")
      .mockImplementation(async function (this: CoreRuntime) {
        await gate;
        await save.call(this);
        saved = true;
      });
    const originalActivate = MemoryDataAreaPort.prototype.activate;
    activate.mockImplementation(async (path) => {
      expect(saved).toBe(true);
      return originalActivate.call(dataArea, path);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: method === "create" ? "空のWorkspaceを作成" : "Workspaceを開く",
      }),
    );
    await screen.findByRole("dialog", { name: "Workspaceを切り替え" });
    await waitFor(() => expect(flush).toHaveBeenCalled());
    expect(activate).not.toHaveBeenCalled();
    expect(editor.isConnected).toBe(true);
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith("memory://new-workspace"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await dataArea.status()).path).toBe("memory://new-workspace");
    expect(prepare).toHaveBeenCalledTimes(method === "create" ? 1 : 0);
    if (method === "receive")
      expect(native.invoke).toHaveBeenCalledWith("sync_join_stop");
  },
);

it.each(["create", "receive"])(
  "keeps the original Workspace when the backup wait after %s is cancelled",
  async (method) => {
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      if (hold) await gate;
    });
    const cancel = vi.fn(async () => {});
    const { dataArea, activate, editor } = await openNewWorkspace(
      new MemoryDataAreaPort(true, "memory://new-workspace"),
      backupFixture({ run, cancel }),
    );
    await waitFor(() => expect(run).toHaveBeenCalled());
    if (method === "receive") await prepareReceive();
    hold = true;
    fireEvent.click(
      screen.getByRole("button", {
        name: method === "create" ? "空のWorkspaceを作成" : "Workspaceを開く",
      }),
    );
    await screen.findByText(/バックアップの完了を待っています/);
    expect(editor.isConnected).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "切り替えを取り消す" }));
    const resumed = await screen.findByRole("dialog", {
      name: method === "create" ? "新しいWorkspace" : "別端末から受信",
    });
    expect(resumed.contains(document.activeElement)).toBe(true);
    expect((await dataArea.status()).path).toBe("memory://workspace");
    expect(activate).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    if (method === "receive") {
      await screen.findByRole("button", { name: "Workspaceを開く" });
      expect(native.invoke).not.toHaveBeenCalledWith("sync_join_stop");
    }
    await act(async () => {
      release();
    });
  },
);
