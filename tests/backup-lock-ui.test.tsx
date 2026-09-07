import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupDialog } from "../app/src/components/BackupDialog";
import { BackupLockRecovery } from "../app/src/components/BackupLockRecovery";
import type { BackupLockReport, BackupPort } from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

const locked: BackupLockReport = {
  schema_version: 3,
  repository_id: "a".repeat(64),
  unlock_attempted: false,
  locks: [
    {
      id: "b".repeat(64),
      time: "2026-09-07T00:00:00Z",
      hostname: "test-pc",
      pid: 1234,
      exclusive: false,
    },
  ],
};
const empty: BackupLockReport = {
  ...locked,
  unlock_attempted: true,
  locks: [],
};

function dialog(port: BackupPort) {
  return render(
    <BackupDialog
      port={port}
      session={{ restoreFocus: vi.fn() }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

describe("explicit stale-only backup lock recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("does not contact the repository on open, details navigation or status polling", async () => {
    vi.useFakeTimers();
    const repositoryLocks = vi.fn(async () => locked);
    dialog(backupFixture({ repositoryLocks }));
    await act(async () => {});
    fireEvent.click(
      within(screen.getByRole("row", { name: "ローカル履歴" })).getByRole(
        "button",
        { name: "進捗" },
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(repositoryLocks).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ロックを確認" }));
    });
    expect(repositoryLocks).toHaveBeenCalledExactlyOnceWith(null, false);
    expect(
      screen.getByRole("table", { name: "保存先のロック" }).textContent,
    ).toContain("test-pc / 1234");
    expect(
      screen.getByRole("table", { name: "保存先のロック" }).textContent,
    ).toMatch(/2026\/09\/07.*ago/);
    fireEvent.click(
      screen.getByRole("button", { name: "失効したロックを解除…" }),
    );
    expect(repositoryLocks).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("complementary", { name: "注意事項" }).textContent,
    ).toContain("使用中のロックの強制解除や、保存済み世代の削除は行いません");
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(repositoryLocks).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "失効ロックのみ解除する" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "失効したロックを解除…" }),
    );
    repositoryLocks.mockResolvedValueOnce(empty);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "失効ロックのみ解除する" }),
      );
    });
    expect(repositoryLocks).toHaveBeenLastCalledWith(null, true);
    expect(screen.getByRole("status").textContent).toContain(
      "バックアップを再試行できます",
    );
    expect(screen.queryByRole("table", { name: "保存先のロック" })).toBeNull();
  });

  it("keeps active locks visible after unlock without retrying or claiming backup success", async () => {
    const repositoryLocks = vi.fn(
      async (_id: string | null, repair: boolean) => ({
        ...locked,
        unlock_attempted: repair,
      }),
    );
    render(
      <BackupLockRecovery
        port={backupFixture({ repositoryLocks })}
        destinationId="drive-one"
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ロックを確認" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "失効したロックを解除…" }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "失効ロックのみ解除する" }),
      );
    });
    expect(repositoryLocks.mock.calls).toEqual([
      ["drive-one", false],
      ["drive-one", true],
    ]);
    expect(screen.getByRole("status").textContent).toContain(
      "残っているロックは解除しませんでした",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "再試行できます",
    );
  });

  it("reports a native lease conflict and disables duplicate or busy operations", async () => {
    let reject!: (reason: unknown) => void;
    const repositoryLocks = vi.fn(
      () =>
        new Promise<BackupLockReport>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const port = backupFixture({ repositoryLocks });
    const view = render(
      <BackupLockRecovery port={port} destinationId="one" disabled />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ロックを確認" }));
    expect(repositoryLocks).not.toHaveBeenCalled();
    view.rerender(
      <BackupLockRecovery port={port} destinationId="one" disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ロックを確認" }));
    fireEvent.click(screen.getByRole("button", { name: "処理中…" }));
    expect(repositoryLocks).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject({
        code: "BACKUP_BUSY",
        message: "バックアップ処理が実行中です。",
      });
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "バックアップ処理が実行中",
    );
    expect(
      screen.queryByRole("button", { name: "失効したロックを解除…" }),
    ).toBeNull();
  });

  it("never shows a previous destination's late lock report in the next destination", async () => {
    const state = await backupFixture().status();
    state.config.destinations = ["one", "two"].map((id) => ({
      id,
      location: { kind: "local-directory", path: "/backup/" + id },
      repository_id: "repo-" + id,
      enabled: true,
      retention: state.config.local_retention,
    }));
    let resolve!: (report: BackupLockReport) => void;
    const repositoryLocks = vi.fn(
      () =>
        new Promise<BackupLockReport>((done) => {
          resolve = done;
        }),
    );
    dialog(backupFixture({ status: async () => state, repositoryLocks }));
    fireEvent.click(
      within(await screen.findByRole("row", { name: "/backup/one" })).getByRole(
        "button",
        { name: "進捗" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "ロックを確認" }));
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    fireEvent.click(
      within(screen.getByRole("row", { name: "/backup/two" })).getByRole(
        "button",
        { name: "進捗" },
      ),
    );
    await act(async () => {
      resolve(locked);
    });
    expect(screen.queryByRole("table", { name: "保存先のロック" })).toBeNull();
    expect(repositoryLocks).toHaveBeenCalledExactlyOnceWith("one", false);
  });
});
