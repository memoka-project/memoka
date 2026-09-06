import {
  act,
  fireEvent,
  render,
  screen,
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
  it("does not connect or poll OAuth on opening settings and disables connect without a client", async () => {
    const cloud = cloudFixture({
      list: vi.fn(async () => ({
        configured: false,
        experimental: true,
        connections: [],
      })),
    });
    panel(cloud);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Googleへ新規接続" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByText(/Google接続は未設定です/)).toBeTruthy();
    expect(cloud.connect).not.toHaveBeenCalled();
    expect(cloud.authStatus).not.toHaveBeenCalled();
    expect(cloud.reconnect).not.toHaveBeenCalled();
  });
  it("uses existing authorization, passes a typed destination, and clears secret values before completion", async () => {
    let complete!: (value: boolean) => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const cloud = cloudFixture();
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
    const password = screen.getByLabelText("パスワード") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "パスワードを再入力",
    ) as HTMLInputElement;
    const secret = "unique-fake-repository-secret";
    fireEvent.change(password, { target: { value: secret } });
    fireEvent.change(confirmation, { target: { value: secret } });
    expect(view.container.innerHTML).not.toContain(secret);
    fireEvent.click(screen.getByRole("button", { name: "保存先を登録" }));
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
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Drive backup" })).toBeTruthy(),
    );
    expect(screen.getByRole("region", { name: "/offline/local" })).toBeTruthy();
    expect(screen.getByLabelText("追加する保存先の種類")).toBeTruthy();
    expect(cloud.reconnect).not.toHaveBeenCalled();
    expect(cloud.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "復旧用情報を表示" }));
    await waitFor(() =>
      expect(cloud.recoveryInformation).toHaveBeenCalledWith("drive"),
    );
    expect(screen.getByText(/safe-folder/)).toBeTruthy();
  });
});
