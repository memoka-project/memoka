import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBackupSettings } from "../app/src/components/CloudBackupSettings";
import { BackupDialog } from "../app/src/components/BackupDialog";
import type { CloudPort, CloudAuthStatus } from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

const auth: CloudAuthStatus = {
  operation_id: "operation",
  connection_id: "connection",
  phase: "waiting-browser",
  authorization_url: "http://not-rendered.invalid/",
  error: null,
};
function cloudFixture(overrides: Partial<CloudPort> = {}): CloudPort {
  return {
    list: vi.fn(async () => ({
      configured: true,
      experimental: true,
      connections: [
        {
          id: "connection",
          account_display_label: "Test Google",
          oauth_client_id: "test.apps.googleusercontent.com",
          last_verified_at: null,
          auth_state: "connected",
          bindings: [],
        },
      ],
    })),
    connect: vi.fn(async () => auth),
    reconnect: vi.fn(async () => auth),
    pickBackupParent: vi.fn(async () => auth),
    useDefaultBackupParent: vi.fn(async () => undefined),
    authStatus: vi.fn(async () => auth),
    cancelAuth: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    intents: vi.fn(async () => []),
    recoveryInformation: vi.fn(async () => ({
      provider: "google_drive",
      root_folder_id: "safe-folder",
    })),
    cancelTransfer: vi.fn(async () => undefined),
    ...overrides,
  };
}
function panel(cloud: CloudPort, save = vi.fn(async () => true)) {
  return render(
    <CloudBackupSettings
      cloud={cloud}
      save={save}
      busy={false}
      error={null}
      onConnected={vi.fn()}
    />,
  );
}
describe("Google backup settings boundary", () => {
  afterEach(() => vi.useRealTimers());
  it("remembers a picked parent only after successful authentication and can return to the default", async () => {
    vi.useFakeTimers();
    const initial = await cloudFixture().list();
    let parent: { folder_id: string; name: string; automatic: boolean } | null =
      null;
    const cloud = cloudFixture({
      list: vi.fn(async () => ({
        ...initial,
        connections: [{ ...initial.connections[0], backup_parent: parent }],
      })),
      authStatus: vi.fn(async () => {
        parent = {
          folder_id: "picked123",
          name: "My Archives",
          automatic: false,
        };
        return { ...auth, phase: "success", authorization_url: null };
      }),
      useDefaultBackupParent: vi.fn(async () => {
        parent = null;
      }),
    });
    const save = vi.fn(async () => true);
    const connected = vi.fn();
    render(
      <CloudBackupSettings
        mode="add"
        cloud={cloud}
        save={save}
        busy={false}
        error={null}
        onConnected={connected}
      />,
    );
    await act(async () => {});
    expect(screen.getByText("Memoka（自動）")).toBeTruthy();
    expect(cloud.pickBackupParent).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "既存フォルダーを選択" }),
      ),
    );
    expect(cloud.pickBackupParent).toHaveBeenCalledWith("connection");
    expect(screen.getByText("Memoka（自動）")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "保存先を登録" }).matches(":disabled"),
    ).toBe(true);
    expect(screen.getByLabelText("Google接続").hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByText(auth.authorization_url!)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByText("My Archives（選択済み）")).toBeTruthy();
    expect(connected).not.toHaveBeenCalled(); // selection alone never schedules a transfer
    expect(save).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Memoka（自動）に戻す" }),
      ),
    );
    expect(cloud.useDefaultBackupParent).toHaveBeenCalledWith("connection");
    expect(screen.getByText("Memoka（自動）")).toBeTruthy();
  });
  it("keeps the remembered parent on picker cancellation and errors", async () => {
    vi.useFakeTimers();
    const initial = await cloudFixture().list();
    const cloud = cloudFixture({
      list: vi.fn(async () => ({
        ...initial,
        connections: [
          {
            ...initial.connections[0],
            backup_parent: {
              folder_id: "oldfolder",
              name: "Previous",
              automatic: false,
            },
          },
        ],
      })),
      authStatus: vi.fn(async () => ({
        ...auth,
        phase: "cancelled",
        authorization_url: null,
      })),
      useDefaultBackupParent: vi.fn(async () => {
        throw new Error("Local save failed");
      }),
    });
    const view = render(
      <CloudBackupSettings
        mode="add"
        cloud={cloud}
        save={vi.fn()}
        busy={false}
        error={null}
        onConnected={vi.fn()}
      />,
    );
    await act(async () => {});
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "既存フォルダーを選択" }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByText("Previous（選択済み）")).toBeTruthy();
    expect(screen.getByText(/親フォルダーは変更していません/)).toBeTruthy();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Memoka（自動）に戻す" }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Local save failed",
    );
    expect(screen.getByText("Previous（選択済み）")).toBeTruthy();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "既存フォルダーを選択" }),
      ),
    );
    view.unmount();
    expect(cloud.cancelAuth).toHaveBeenCalledWith("operation");
  });
  it("shows the fixed placement when retrying both new and legacy registrations", async () => {
    const cloud = cloudFixture({
      intents: vi.fn(async () => [
        {
          id: "new",
          phase: "folder-requested",
          root_folder_id: null,
          display_name: null,
          placement: {
            folder_id: "reserved",
            parent: {
              folder_id: "fixed123",
              name: "Original Parent",
              automatic: false,
            },
          },
        },
        {
          id: "old",
          phase: "folder-requested",
          root_folder_id: null,
          display_name: null,
        },
      ]),
    });
    render(
      <CloudBackupSettings
        mode="add"
        cloud={cloud}
        save={vi.fn()}
        busy={false}
        error={null}
        onConnected={vi.fn()}
      />,
    );
    expect(await screen.findByText("Original Parent（選択済み）")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "既存フォルダーを選択" })
        .closest("fieldset")?.disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("初期化の再開"), {
      target: { value: "old" },
    });
    expect(
      screen.getByText("マイドライブ直下（旧方式での登録を再開）"),
    ).toBeTruthy();
    expect(cloud.pickBackupParent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("初期化の再開"), {
      target: { value: "" },
    });
    expect(screen.getByText("Memoka（自動）")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "既存フォルダーを選択" })
        .closest("fieldset")?.disabled,
    ).toBe(false);
  });
  it("uses the footer to return from connection management to the add form, then overview and editor", async () => {
    const cloud = cloudFixture(),
      close = vi.fn(),
      focus = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ cloud })}
        session={{ restoreFocus: focus }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "保存先を追加" }));
    fireEvent.change(screen.getByLabelText("追加する保存先の種類"), {
      target: { value: "google" },
    });
    await screen.findByText("Memoka（自動）");
    fireEvent.click(screen.getByRole("button", { name: "Google接続を管理" }));
    await screen.findByRole("heading", { name: "Google接続の管理" });
    expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "戻る" }).closest("footer"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByLabelText("追加する保存先の種類")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Google接続を管理");
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await act(async () => {});
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
  it("does not connect or poll OAuth on opening settings and disables connect without a client", async () => {
    let finishLoading!: () => void;
    const cloud = cloudFixture({
      list: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<CloudPort["list"]>>>((resolve) => {
            finishLoading = () =>
              resolve({
                configured: false,
                experimental: true,
                connections: [],
              });
          }),
      ),
    });
    panel(cloud);
    const connect = screen.getByRole("button", { name: "Googleへ新規接続" });
    // The button is disabled during loading too, so it cannot be used as a
    // signal that the asynchronous client configuration has been rendered.
    expect(connect.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Google接続は未設定です/)).toBeNull();
    expect(cloud.connect).not.toHaveBeenCalled();
    expect(cloud.authStatus).not.toHaveBeenCalled();
    expect(cloud.reconnect).not.toHaveBeenCalled();
    await act(async () => finishLoading());
    expect(await screen.findByText(/Google接続は未設定です/)).toBeTruthy();
    expect(connect.hasAttribute("disabled")).toBe(true);
    expect(cloud.connect).not.toHaveBeenCalled();
    expect(cloud.authStatus).not.toHaveBeenCalled();
    expect(cloud.reconnect).not.toHaveBeenCalled();
  });
  it("uses existing authorization, passes a typed destination, and clears secret values before completion", async () => {
    let complete!: (value: boolean) => void;
    let finishIntents!: () => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const cloud = cloudFixture({
      intents: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<CloudPort["intents"]>>>((resolve) => {
            finishIntents = () => resolve([]);
          }),
      ),
    });
    const view = panel(cloud, save);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Google Driveの保存先を追加" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Google Driveの保存先を追加" }),
    );
    // The connection list and the initialization intents load separately.
    // Wait for the form itself, not just the button that opens it; a click
    // inside its still-disabled fieldset must not submit or consume secrets.
    const register = screen.getByRole("button", { name: "保存先を登録" });
    expect(register.matches(":disabled")).toBe(true);
    fireEvent.click(register);
    expect(save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(cloud.intents).toHaveBeenCalledWith("connection"),
    );
    await act(async () => finishIntents());
    expect(register.matches(":disabled")).toBe(false);
    const password = screen.getByLabelText("パスワード") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "パスワードを再入力",
    ) as HTMLInputElement;
    const secret = "unique-fake-repository-secret";
    fireEvent.change(password, { target: { value: secret } });
    fireEvent.change(confirmation, { target: { value: secret } });
    expect(view.container.innerHTML).not.toContain(secret);
    fireEvent.click(register);
    expect(password.value).toBe("");
    expect(confirmation.value).toBe("");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "add-google-drive",
        connectionId: "connection",
        password: secret,
      }),
      "google-new",
    );
    expect(cloud.connect).not.toHaveBeenCalled();
    await act(async () => complete(false));
    fireEvent.change(password, { target: { value: secret } });
    view.unmount();
    expect(password.value).toBe("");
  });
  it("cancels an authorization when its modal is closed, including a late start response", async () => {
    let started!: (status: CloudAuthStatus) => void;
    const cloud = cloudFixture({
      connect: vi.fn(
        () =>
          new Promise<CloudAuthStatus>((resolve) => {
            started = resolve;
          }),
      ),
    });
    const view = panel(cloud);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Googleへ新規接続" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("接続の表示名"), {
      target: { value: "New connection" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Googleへ新規接続" }));
    view.unmount();
    await act(async () => started(auth));
    expect(cloud.cancelAuth).toHaveBeenCalledWith("operation");
  });
  it("polls only a user-started operation and stops after terminal status", async () => {
    vi.useFakeTimers();
    const cloud = cloudFixture({
      authStatus: vi.fn(async () => ({
        ...auth,
        phase: "success",
        authorization_url: null,
      })),
    });
    panel(cloud);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("接続の表示名"), {
      target: { value: "New connection" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Googleへ新規接続" })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(cloud.authStatus).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(cloud.authStatus).toHaveBeenCalledOnce();
    expect(screen.getByText(/Google接続を保存しました/)).toBeTruthy();
    expect(screen.queryByText(auth.authorization_url!)).toBeNull();
  });
  it("shows local and Drive locations together without testing the connection", async () => {
    const cloud = cloudFixture();
    const state = await backupFixture().status();
    const port = backupFixture({
      cloud,
      status: async () => ({
        ...state,
        config: {
          ...state.config,
          destinations: [
            {
              id: "local",
              location: { kind: "local-directory", path: "/offline/local" },
              enabled: true,
              repository_id: "l",
              retention: state.config.local_retention,
            },
            {
              id: "drive",
              location: {
                kind: "google-drive",
                connection_id: "connection",
                root_folder_id: "folder123",
                display_name: "Drive backup",
              },
              enabled: true,
              repository_id: "g",
              retention: state.config.local_retention,
            },
          ],
        },
      }),
    });
    render(
      <BackupDialog
        port={port}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const row = await screen.findByRole("row", { name: "Drive backup" });
    expect(screen.getByRole("row", { name: "/offline/local" })).toBeTruthy();
    expect(screen.queryByLabelText("追加する保存先の種類")).toBeNull();
    expect(cloud.list).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "設定" }));
    expect(cloud.reconnect).not.toHaveBeenCalled();
    expect(cloud.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "復旧用情報を表示" }));
    await waitFor(() =>
      expect(cloud.recoveryInformation).toHaveBeenCalledWith("drive"),
    );
    expect(screen.getByText(/safe-folder/)).toBeTruthy();
  });
});
