import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "../app/src/App";
import { BackupDialog } from "../app/src/components/BackupDialog";
import { HistoryPane } from "../app/src/components/HistoryPane";
import {
  DEFAULT_BACKUP_RETENTION,
  type HistoricalResource,
  type BackupDestination,
} from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

const destination = (id: string, enabled = true): BackupDestination => ({
  id,
  path: "/backup/" + id,
  repository_id: "repo-" + id,
  enabled,
  retention: { ...DEFAULT_BACKUP_RETENTION },
});

describe("backup settings and read-only history", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps drafts across polling, saves local settings without closing, and rejects mismatched passwords", async () => {
    vi.useFakeTimers();
    const settings = vi.fn(async () => undefined);
    const close = vi.fn();
    const saved = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({
          settings,
          chooseAdditional: async () => "/test-backup",
        })}
        session={{ restoreFocus: vi.fn() }}
        onClose={close}
        onSaved={saved}
      />,
    );
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("自動保存間隔（分）"), {
      target: { value: "23" },
    });
    fireEvent.change(screen.getByLabelText("直近（世代）"), {
      target: { value: "72" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      (screen.getByLabelText("直近（世代）") as HTMLInputElement).value,
    ).toBe("72");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "ローカル設定を保存" }),
      );
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "local",
      intervalMinutes: 23,
      retention: { last: 72, daily: 30, monthly: 12 },
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存先を追加" }));
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "temporary-secret" },
    });
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "mismatch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存先を登録" }));
    expect(settings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("同じ内容で2回");
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "temporary-secret" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存先を登録" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "add",
      directory: "/test-backup",
      password: "temporary-secret",
      retention: DEFAULT_BACKUP_RETENTION,
    });
    expect(screen.queryByLabelText("パスワード")).toBeNull();
    expect(saved).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByText(/Workspace内の履歴には/)).toBeNull();
  });

  it("edits independent targets, preserves drafts, and keeps failed/offline targets visible", async () => {
    let state = await backupFixture().status();
    state = {
      ...state,
      config: {
        ...state.config,
        destinations: [
          destination("one"),
          destination("two", false),
          destination("three"),
        ],
      },
      status: {
        ...state.status,
        destinations: {
          two: {
            phase: "disabled",
            protected_capture_at: "2026-09-01T00:00:00Z",
            last_copy_at: null,
            error: { code: "OFFLINE", message: "Target offline" },
            maintenance_error: null,
            pending_copy_count: 2,
            expired_copy_count: 1,
          },
        },
      },
    };
    const settings = vi.fn(
      async (
        request: Parameters<ReturnType<typeof backupFixture>["settings"]>[0],
      ) => {
        if (request.kind === "enabled")
          state = {
            ...state,
            config: {
              ...state.config,
              destinations: state.config.destinations.map((target) =>
                target.id === request.id
                  ? { ...target, enabled: request.enabled }
                  : target,
              ),
            },
          };
        if (request.kind === "remove")
          state = {
            ...state,
            config: {
              ...state.config,
              destinations: state.config.destinations.filter(
                (target) => target.id !== request.id,
              ),
            },
          };
      },
    );
    render(
      <BackupDialog
        port={backupFixture({ status: async () => state, settings })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const one = within(
      await screen.findByRole("region", { name: "/backup/one" }),
    );
    const two = within(screen.getByRole("region", { name: "/backup/two" }));
    fireEvent.change(one.getByLabelText("日次（世代）"), {
      target: { value: "0" },
    });
    expect(one.getByText(/次回の整理/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(two.getByRole("checkbox", { name: "有効" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "enabled",
      id: "two",
      enabled: true,
    });
    expect((one.getByLabelText("日次（世代）") as HTMLInputElement).value).toBe(
      "0",
    );
    expect(two.getByText(/Target offline/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(one.getByRole("button", { name: "保持設定を保存" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "retention",
      id: "one",
      retention: { last: 48, daily: 0, monthly: 12 },
    });
    fireEvent.click(
      two.getByRole("button", { name: "既存パスワードを再登録" }),
    );
    fireEvent.change(two.getByLabelText("パスワード"), {
      target: { value: "target-two-secret" },
    });
    fireEvent.change(two.getByLabelText("パスワードを再入力"), {
      target: { value: "target-two-secret" },
    });
    await act(async () => {
      fireEvent.click(two.getByRole("button", { name: "パスワードを再登録" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "credential",
      id: "two",
      password: "target-two-secret",
    });
    const three = within(screen.getByRole("region", { name: "/backup/three" }));
    fireEvent.click(three.getByRole("button", { name: "保存先を解除" }));
    expect(three.getByText(/保存済みバックアップは削除しません/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(three.getByRole("button", { name: "登録を解除する" }));
    });
    expect(screen.queryByRole("region", { name: "/backup/three" })).toBeNull();
    expect(screen.getByRole("region", { name: "/backup/one" })).toBeTruthy();
  });

  it("does not mistake a failed status refresh for a failed committed Add", async () => {
    const state = await backupFixture().status();
    let committed = false;
    const settings = vi.fn(async () => {
      committed = true;
    });
    render(
      <BackupDialog
        port={backupFixture({
          settings,
          status: async () => {
            if (committed) throw new Error("status unavailable");
            return state;
          },
          chooseAdditional: async () => "/new",
        })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存先を追加" }));
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "secret" },
    });
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "secret" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存先を登録" }));
    });
    expect(screen.queryByRole("region", { name: "新しい保存先" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("status unavailable");
    expect(settings).toHaveBeenCalledOnce();
  });

  it("focuses Close while loading", () => {
    const close = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ status: () => new Promise(() => undefined) })}
        session={{ restoreFocus: vi.fn() }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "閉じる" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c", ctrlKey: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it("centers the scroll-bounded modal and traps focus", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    document.head.append(style);
    try {
      const close = vi.fn();
      render(
        <>
          <button>背後の操作</button>
          <BackupDialog
            port={backupFixture()}
            session={{ restoreFocus: vi.fn() }}
            onClose={close}
            onSaved={vi.fn()}
          />
        </>,
      );
      await act(async () => {});
      const dialog = screen.getByRole("dialog", { name: "バックアップ設定" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      const overlay = dialog.parentElement!;
      expect(getComputedStyle(overlay).position).toBe("fixed");
      expect(getComputedStyle(overlay).inset).toBe("0");
      expect(getComputedStyle(overlay).placeItems).toBe("center");
      expect(getComputedStyle(dialog).overflow).toBe("auto");
      expect(getComputedStyle(dialog).maxHeight).toBe("100%");
      const interval = screen.getByLabelText("自動保存間隔（分）");
      interval.focus();
      fireEvent.keyDown(interval, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "閉じる" }),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
      expect(document.activeElement).toBe(interval);
      screen.getByRole("button", { name: "背後の操作" }).focus();
      expect(document.activeElement).toBe(interval);
      fireEvent.mouseDown(overlay);
      expect(close).not.toHaveBeenCalled();
    } finally {
      style.remove();
    }
  });

  it("keeps a keyboard target during save and restores focus only when closed", async () => {
    let finish!: () => void;
    const settings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn(),
      restoreFocus = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ settings })}
        session={{ restoreFocus }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    const save = await screen.findByRole("button", {
      name: "ローカル設定を保存",
    });
    save.focus();
    fireEvent.click(save);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    for (const event of [
      { key: "Tab" },
      { key: "Tab", shiftKey: true },
      { key: "Escape" },
      { key: "c", ctrlKey: true },
    ]) {
      fireEvent.keyDown(dialog, event);
      expect(document.activeElement).toBe(dialog);
    }
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => {});
    expect(close).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("opens :backup-settings modally from Sidebar and restores it", async () => {
    const view = render(<App backup={backupFixture()} />);
    const tree = await screen.findByRole("tree", { name: "ノートツリー" });
    tree.focus();
    fireEvent.keyDown(tree, { key: ":", code: "Semicolon", shiftKey: true });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "backup-settings" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", {
      name: "バックアップ設定",
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(view.container.querySelector("main")?.dataset.applicationFocus).toBe(
      "backup",
    );
    expect(fireEvent.keyDown(tree, { key: "a", code: "KeyA" })).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(tree));
  });

  it("reads linked sections in the selected generation without opening a live editor", async () => {
    const generation = "01a30000-0000-7000-8000-000000000077";
    const initialId = "01a30000-0000-7000-8000-000000000002";
    const targetId = "01a30000-0000-7000-8000-000000000003";
    const resource = (id: string): HistoricalResource => ({
      title: id === initialId ? "過去のノート" : "過去のリンク先",
      depth: 0,
      markdown: "",
      section: {
        sectionId: id,
        title: id === initialId ? "過去のノート" : "過去のリンク先",
        tags: [],
        children: [],
        body: [
          {
            type: "paragraph",
            content: [
              id === initialId
                ? {
                    type: "internalSectionLink",
                    attrs: { targetSectionId: targetId },
                  }
                : { type: "text", text: "この世代の本文" },
            ],
          },
        ],
      },
      references: [{ id: targetId, resolved: true, title: "過去のリンク先" }],
      attachments: [],
    });
    const read = vi.fn(async (id: string) => resource(id));
    const close = vi.fn();
    const view = render(
      <HistoryPane
        port={backupFixture({
          read,
          history: async () => ({
            generations: [
              {
                descriptor: {
                  generation_id: generation,
                  captured_at: "2026-09-06T00:00:00Z",
                  workspace_id: "workspace",
                  document_revisions: {},
                  known_missing: [],
                },
              },
            ],
          }),
        })}
        session={{ id: initialId, restoreFocus: vi.fn() }}
        onClose={close}
      />,
    );
    const link = await screen.findByRole("button", { name: "過去のリンク先" });
    link.focus();
    fireEvent.click(link);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "履歴日時を絞り込む" }),
    );
    await screen.findByText("この世代の本文");
    expect(read.mock.calls).toEqual([
      [initialId, generation],
      [targetId, generation],
    ]);
    expect(view.container.querySelector("[contenteditable=true]")).toBeNull();
    const previewButton = screen.getByRole("button", {
      name: "この世代のノート一覧",
    });
    previewButton.focus();
    fireEvent.click(previewButton);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "履歴日時を絞り込む" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c", ctrlKey: true });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
