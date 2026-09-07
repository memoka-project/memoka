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
  type BackupSettingsRequest,
} from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

const destination = (id: string, enabled = true): BackupDestination => ({
  id,
  location: { kind: "local-directory", path: "/backup/" + id },
  repository_id: "repo-" + id,
  enabled,
  retention: { ...DEFAULT_BACKUP_RETENTION },
});

async function details(name = "ローカル履歴", tab = "設定") {
  const row = await screen.findByRole("row", { name });
  fireEvent.click(within(row).getByRole("button", { name: tab }));
}
async function addLocal() {
  fireEvent.click(screen.getByRole("button", { name: "保存先を追加" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "ディレクトリを選択" }));
  });
}
describe("backup settings and read-only history", () => {
  afterEach(() => vi.useRealTimers());

  it("opens an overview without forms or remote work, with counts and a single notice area", async () => {
    const base = await backupFixture().status();
    const run = vi.fn(),
      scheduleCloud = vi.fn(),
      settings = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({
          run,
          scheduleCloud,
          settings,
          status: async () => ({
            ...base,
            config: {
              ...base.config,
              destinations: [destination("one"), destination("two", false)],
            },
            status: {
              ...base.status,
              generation_counts: { verified: 10, transferred: 10, target: 10 },
              destinations: {
                one: {
                  phase: "verification-pending",
                  protected_capture_at: "2026-09-01T00:00:00Z",
                  last_copy_at: null,
                  error: null,
                  maintenance_error: null,
                  pending_copy_count: 1,
                  expired_copy_count: 0,
                  pending_verification_count: 2,
                  generation_counts: {
                    verified: 7,
                    transferred: 9,
                    target: 10,
                  },
                },
              },
            },
          }),
        })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const table = await screen.findByRole("table", {
      name: "バックアップ保存先",
    });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("7 / 9 / 10")).toBeTruthy();
    expect(within(table).getByText("10 / 10 / 10")).toBeTruthy();
    expect(within(table).getByText("無効")).toBeTruthy();
    expect(within(table).getByText(/2026\/09\/01.*ago/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(
      screen.getAllByRole("complementary", { name: "注意事項" }),
    ).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(scheduleCloud).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });

  it("keeps a draft across polling and tabs, saves without closing, then registers a destination", async () => {
    vi.useFakeTimers();
    let state = await backupFixture().status();
    const settings = vi.fn(async (request: BackupSettingsRequest) => {
      if (request.kind === "add")
        state = {
          ...state,
          config: { ...state.config, destinations: [destination("new")] },
        };
    });
    const close = vi.fn(),
      saved = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({
          settings,
          status: async () => state,
          chooseAdditional: async () => "/test-backup",
        })}
        session={{ restoreFocus: vi.fn() }}
        onClose={close}
        onSaved={saved}
      />,
    );
    await act(async () => {});
    fireEvent.click(
      within(screen.getByRole("row", { name: "ローカル履歴" })).getByRole(
        "button",
        { name: "設定" },
      ),
    );
    fireEvent.change(screen.getByLabelText("自動保存間隔（分）"), {
      target: { value: "23" },
    });
    fireEvent.change(screen.getByLabelText("直近（世代）"), {
      target: { value: "72" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "進捗" }));
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.click(screen.getByRole("tab", { name: "設定" }));
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
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement?.getAttribute("data-backup-focus")).toBe(
      "local-history:settings",
    );
    await addLocal();
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
    expect(document.activeElement?.getAttribute("data-backup-focus")).toBe(
      "new:settings",
    );
    expect(saved).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("edits independent targets and keeps disabled errors visible without mixing settings", async () => {
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
            protected_capture_at: null,
            last_copy_at: null,
            error: { code: "OFFLINE", message: "Target offline" },
            maintenance_error: null,
            pending_copy_count: 2,
            expired_copy_count: 1,
          },
        },
      },
    };
    const settings = vi.fn(async (request: BackupSettingsRequest) => {
      if (request.kind === "enabled")
        state = {
          ...state,
          config: {
            ...state.config,
            destinations: state.config.destinations.map((t) =>
              t.id === request.id ? { ...t, enabled: request.enabled } : t,
            ),
          },
        };
      if (request.kind === "remove")
        state = {
          ...state,
          config: {
            ...state.config,
            destinations: state.config.destinations.filter(
              (t) => t.id !== request.id,
            ),
          },
        };
    });
    render(
      <BackupDialog
        port={backupFixture({ settings, status: async () => state })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await details("/backup/one");
    fireEvent.change(screen.getByLabelText("日次（世代）"), {
      target: { value: "0" },
    });
    expect(
      within(screen.getByRole("complementary", { name: "注意事項" })).getByText(
        /次回の整理/,
      ),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保持設定を保存" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "retention",
      id: "one",
      retention: { last: 48, daily: 0, monthly: 12 },
    });
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    await details("/backup/two", "進捗");
    expect(screen.getByRole("alert").textContent).toContain(
      "停止前のエラー: Target offline",
    );
    fireEvent.click(screen.getByRole("tab", { name: "設定" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "有効" }));
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "enabled",
      id: "two",
      enabled: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "既存パスワードを再登録" }),
    );
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "target-two-secret" },
    });
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "target-two-secret" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "パスワードを再登録" }),
      );
    });
    expect(settings).toHaveBeenLastCalledWith({
      kind: "credential",
      id: "two",
      password: "target-two-secret",
    });
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    await details("/backup/three");
    fireEvent.click(screen.getByRole("button", { name: "保存先を解除" }));
    expect(
      within(screen.getByRole("complementary", { name: "注意事項" })).getByText(
        /この保存先の登録を解除/,
      ),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "登録を解除する" }));
    });
    expect(screen.queryByRole("row", { name: "/backup/three" })).toBeNull();
    expect(screen.getByRole("row", { name: "/backup/one" })).toBeTruthy();
  });

  it("does not mark an unsaved retention draft as saved when toggling the destination", async () => {
    let state = await backupFixture().status();
    state = {
      ...state,
      config: { ...state.config, destinations: [destination("one")] },
    };
    const settings = vi.fn(async (request: BackupSettingsRequest) => {
      if (request.kind === "enabled")
        state = {
          ...state,
          config: {
            ...state.config,
            destinations: [destination("one", request.enabled)],
          },
        };
    });
    render(
      <BackupDialog
        port={backupFixture({ settings, status: async () => state })}
        session={{ restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await details("/backup/one");
    fireEvent.change(screen.getByLabelText("直近（世代）"), {
      target: { value: "72" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "有効" }));
    });
    expect(settings).toHaveBeenCalledExactlyOnceWith({
      kind: "enabled",
      id: "one",
      enabled: false,
    });
    expect(
      (screen.getByLabelText("直近（世代）") as HTMLInputElement).value,
    ).toBe("72");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByText("未保存の入力を破棄しますか？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "破棄して戻る" }));
    expect(
      within(screen.getByRole("row", { name: "/backup/one" })).getByText(
        "無効",
      ),
    ).toBeTruthy();
  });

  it("confirms abandoning a draft and clears passwords when leaving the detail", async () => {
    const close = vi.fn(),
      restoreFocus = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ chooseAdditional: async () => "/new" })}
        session={{ restoreFocus }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    await screen.findByRole("row", { name: "ローカル履歴" });
    await addLocal();
    const password = screen.getByLabelText("パスワード") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "sensitive-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText("未保存の入力を破棄しますか？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }));
    expect(password.value).toBe("sensitive-draft");
    fireEvent.keyDown(password, { key: "c", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "破棄して戻る" }));
    expect(password.value).toBe("");
    expect(screen.queryByLabelText("パスワード")).toBeNull();
    expect(restoreFocus).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => {});
    expect(close).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
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
    await screen.findByRole("row", { name: "ローカル履歴" });
    await addLocal();
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

  it("keeps loading and save focus inside the modal and closes only from the overview", async () => {
    let finish!: () => void;
    const settings = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      close = vi.fn(),
      restoreFocus = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ settings })}
        session={{ restoreFocus }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    await details();
    fireEvent.click(screen.getByRole("button", { name: "ローカル設定を保存" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    for (const event of [
      { key: "Tab" },
      { key: "Tab", shiftKey: true },
      { key: "Escape" },
      { key: "c", ctrlKey: true },
    ]) {
      fireEvent.keyDown(dialog, event);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("table")).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(async () => {});
    expect(close).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("centers the bounded modal, traps focus, and skips hidden forms and collapsed notes", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    document.head.append(style);
    try {
      render(
        <>
          <button>背後の操作</button>
          <BackupDialog
            port={backupFixture()}
            session={{ restoreFocus: vi.fn() }}
            onClose={vi.fn()}
            onSaved={vi.fn()}
          />
        </>,
      );
      await screen.findByRole("row", { name: "ローカル履歴" });
      const dialog = screen.getByRole("dialog"),
        overlay = dialog.parentElement!;
      expect(getComputedStyle(overlay).placeItems).toBe("center");
      expect(getComputedStyle(dialog).overflow).toBe("hidden");
      expect(
        getComputedStyle(dialog.querySelector(".backup-dialog-body")!).overflow,
      ).toBe("auto");
      expect(getComputedStyle(dialog).maxHeight).toBe("100%");
      await details();
      fireEvent.click(screen.getByRole("tab", { name: "進捗" }));
      expect(screen.queryByRole("button", { name: "閉じる" })).toBeNull();
      expect(dialog.querySelector(".backup-dialog-header button")).toBeNull();
      const first = screen.getByRole("tab", { name: "進捗" });
      first.focus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "戻る" }),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
      expect(document.activeElement).toBe(first);
      for (let i = 0; i < 10; i++) {
        fireEvent.keyDown(document.activeElement!, { key: "Tab" });
        expect(document.activeElement?.closest("[hidden]")).toBeNull();
      }
      const previous = document.activeElement;
      screen.getByRole("button", { name: "背後の操作" }).focus();
      expect(document.activeElement).toBe(previous);
    } finally {
      style.remove();
    }
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
