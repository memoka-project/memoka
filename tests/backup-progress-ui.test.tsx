import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupDialog } from "../app/src/components/BackupDialog";
import { BackupTransferProgress } from "../app/src/components/BackupTransferProgress";
import type { BackupTransferProgress as Progress } from "../app/src/core/history";
import {
  backupErrorCount,
  backupTransferFailures,
} from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

const progress = (): Progress => ({
  running: true,
  stage: "target-verification",
  started_at: "2026-09-06T12:00:00Z",
  last_progress_at: "2026-09-06T12:01:00Z",
  elapsed_ms: 75_000,
  stage_elapsed_ms: 15_000,
  generation_captured_at: "2026-09-06T06:00:00Z",
  completed_generations: 3,
  total_generations: 4,
  operation: "file-list",
  operations_completed: 12,
  operation_counts: { descriptor: 2, "file-list": 1 },
  transport_bytes: 1048576,
  bytes_per_second: 2048,
  transport_errors: 0,
});

describe("backup transfer diagnostics", () => {
  afterEach(() => vi.useRealTimers());
  it("shows automatic stale-lock recovery separately from successful transfer or verification", () => {
    render(
      <BackupTransferProgress
        value={{
          ...progress(),
          stage: "lock-recovery",
          operation: "unlock",
          operation_counts: { unlock: 1 },
        }}
      />,
    );
    expect(screen.getByText("失効ロックの自動確認・解除")).toBeTruthy();
    expect(screen.getAllByText("失効ロックの確認・解除")).toHaveLength(2);
    expect(screen.getByText("3 / 4 世代")).toBeTruthy();
    expect(screen.queryByText("処理完了")).toBeNull();
  });
  it("keeps failed maintenance visible without treating a protected generation as a failed transfer", async () => {
    const base = await backupFixture().status();
    const error = {
      code: "REPOSITORY_LOCKED",
      message: "保存先のロックを取得できません",
      details: { exit_code: 11, operation: "forget" },
    };
    const value: Progress = {
      ...progress(),
      running: false,
      stage: "maintaining",
      total_generations: 0,
      operation: null,
      failed_operation: "forget",
    };
    const state = {
      ...base,
      config: {
        ...base.config,
        destinations: [
          {
            id: "drive",
            enabled: true,
            location: {
              kind: "google-drive" as const,
              connection_id: "connection",
              root_folder_id: "folder",
              display_name: "Test backup",
            },
            repository_id: "repository",
            retention: { last: 48, daily: 30, monthly: 12 },
          },
        ],
      },
      status: {
        ...base.status,
        destinations: {
          drive: {
            phase: "error",
            protected_capture_at: "2026-09-06T12:00:00Z",
            last_copy_at: "2026-09-06T12:01:00Z",
            error: null,
            maintenance_error: error,
            pending_copy_count: 0,
            expired_copy_count: 0,
            progress: value,
          },
        },
      },
    };
    expect(backupErrorCount(state)).toBe(1);
    expect(backupTransferFailures(state)).toEqual([]);
    render(
      <BackupDialog
        port={backupFixture({ status: async () => state })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(
      within(await screen.findByRole("row", { name: "Test backup" })).getByRole(
        "button",
        { name: "進捗" },
      ),
    );
    expect(screen.getByText("失敗・中断した処理")).toBeTruthy();
    expect(screen.getByText("保持世代の選定・整理")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "保持整理のエラー（保護済み世代は維持）",
    );
    expect(
      backupErrorCount({
        ...state,
        config: {
          ...state.config,
          destinations: state.config.destinations.map((t) => ({
            ...t,
            enabled: false,
          })),
        },
      }),
    ).toBe(0);
  });
  it("distinguishes verification from uploading and labels measured bytes honestly", () => {
    render(<BackupTransferProgress value={progress()} />);
    const region = within(screen.getByRole("region", { name: "転送の詳細" }));
    expect(region.getByText("転送した世代を検証")).toBeTruthy();
    expect(region.getAllByText("ファイル一覧の検証")).toHaveLength(2);
    expect(region.getByText("3 / 4 世代")).toBeTruthy();
    expect(region.getByText("1分15秒（現在の工程: 15秒）")).toBeTruthy();
    expect(region.getByText("1.0 MiB · 2.0 KiB/s")).toBeTruthy();
    expect(region.getByText("ファイル通信量（読み書き合計）")).toBeTruthy();
    expect(region.queryByText(/ノート数ではなく履歴の世代数/)).toBeNull();
    expect(region.getByRole("progressbar").getAttribute("value")).toBe("3");
    expect(region.getAllByText(/2026\/09\/06.*ago/).length).toBeGreaterThan(0);
  });
  it("does not invent a rate, ETA or progress percentage when no stats are available", () => {
    render(
      <BackupTransferProgress
        value={{
          ...progress(),
          stage: "connecting",
          total_generations: 0,
          operation: null,
          transport_bytes: null,
          bytes_per_second: null,
        }}
      />,
    );
    expect(screen.getByText("未計測")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/KiB\/s/)).toBeNull();
  });
  it("shows uploaded but unverified generations without labelling them protected", async () => {
    const base = await backupFixture().status();
    const state = {
      ...base,
      config: {
        ...base.config,
        destinations: [
          {
            id: "drive",
            enabled: true,
            location: {
              kind: "google-drive" as const,
              connection_id: "connection",
              root_folder_id: "folder",
              display_name: "Test backup",
            },
            repository_id: "repository",
            retention: { last: 48, daily: 30, monthly: 12 },
          },
        ],
      },
      status: {
        ...base.status,
        destinations: {
          drive: {
            phase: "verification-pending",
            protected_capture_at: null,
            last_copy_at: "2026-09-06T12:00:00Z",
            error: null,
            maintenance_error: null,
            verification_error: {
              code: "TEMPORARY",
              message: "検証を再試行します",
            },
            pending_copy_count: 0,
            expired_copy_count: 0,
            pending_verification_count: 2,
          },
        },
      },
    };
    expect(backupErrorCount(state)).toBe(1);
    expect(backupTransferFailures(state)).toEqual([]);
    render(
      <BackupDialog
        port={backupFixture({ status: async () => state })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(
      within(await screen.findByRole("row", { name: "Test backup" })).getByRole(
        "button",
        { name: "進捗" },
      ),
    );
    expect(
      within(screen.getByRole("tabpanel")).getByText("未検証"),
    ).toBeTruthy();
    expect(screen.getByText("2 世代")).toBeTruthy();
    expect(
      within(screen.getByRole("tabpanel")).getAllByText("転送済み・検証待ち"),
    ).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain(
      "未検証の世代は保護済みに含みません",
    );
  });
  it("refreshes native progress without losing the settings draft or closing the dialog", async () => {
    vi.useFakeTimers();
    let value = progress();
    const base = await backupFixture().status();
    const port = backupFixture({
      status: async () => ({
        ...base,
        config: {
          ...base.config,
          destinations: [
            {
              id: "drive",
              enabled: true,
              location: {
                kind: "google-drive",
                connection_id: "connection",
                root_folder_id: "folder",
                display_name: "Test backup",
              },
              repository_id: "repository",
              retention: { last: 48, daily: 30, monthly: 12 },
            },
          ],
        },
        status: {
          ...base.status,
          destinations: {
            drive: {
              phase: value.running ? "copying" : "idle",
              protected_capture_at: null,
              last_copy_at: null,
              error: null,
              maintenance_error: null,
              pending_copy_count:
                value.total_generations - value.completed_generations,
              expired_copy_count: 0,
              progress: value,
            },
          },
        },
      }),
    });
    const close = vi.fn();
    render(
      <BackupDialog
        port={port}
        session={{ restoreFocus: vi.fn() }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    await act(async () => {});
    fireEvent.click(
      within(screen.getByRole("row", { name: "Test backup" })).getByRole(
        "button",
        { name: "設定" },
      ),
    );
    fireEvent.change(screen.getByLabelText("直近（世代）"), {
      target: { value: "23" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "進捗" }));
    expect(screen.getByText("3 / 4 世代")).toBeTruthy();
    value = {
      ...value,
      running: false,
      stage: "complete",
      completed_generations: 4,
      operation: null,
      bytes_per_second: null,
      elapsed_ms: 100_000,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("4 / 4 世代")).toBeTruthy();
    expect(screen.getByText("処理完了")).toBeTruthy();
    expect(screen.getByText("1分40秒")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "設定" }));
    expect(
      (screen.getByLabelText("直近（世代）") as HTMLInputElement).value,
    ).toBe("23");
    expect(close).not.toHaveBeenCalled();
  });
});
