import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "../app/src/App";
import { BackupDialog } from "../app/src/components/BackupDialog";
import { HistoryPane } from "../app/src/components/HistoryPane";
import type { HistoricalResource } from "../app/src/core/history";
import { backupFixture } from "./backup-fixture";

describe("backup settings and read-only history", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps edited settings across status polling and never sends a mismatched password", async () => {
    vi.useFakeTimers();
    const settings = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({
          settings,
          chooseAdditional: async () => "/test-backup",
        })}
        session={{ settings: true, restoreFocus: vi.fn() }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const interval = screen.getByRole("spinbutton");
    fireEvent.change(interval, { target: { value: "23" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect((interval as HTMLInputElement).value).toBe("23");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "追加保存先を選ぶ" }));
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "temporary-secret" },
    });
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "設定を保存" }));
    expect(settings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("同じ内容で2回");
    fireEvent.change(screen.getByLabelText("パスワードを再入力"), {
      target: { value: "temporary-secret" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "設定を保存" }));
    });
    expect(settings).toHaveBeenCalledWith({
      intervalMinutes: 23,
      additionalDirectory: "/test-backup",
      password: "temporary-secret",
      detach: false,
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("focuses an enabled control while settings are still loading", () => {
    const close = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ status: () => new Promise(() => undefined) })}
        session={{ settings: true, restoreFocus: vi.fn() }}
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

  it.each([false, true])(
    "centers the backup modal in a fixed backdrop (settings: %s)",
    async (settings) => {
      const style = document.createElement("style");
      style.textContent = readFileSync(
        resolve(process.cwd(), "app/src/styles.css"),
        "utf8",
      );
      document.head.append(style);
      try {
        render(
          <BackupDialog
            port={backupFixture()}
            session={{ settings, restoreFocus: vi.fn() }}
            onClose={vi.fn()}
            onSaved={vi.fn()}
          />,
        );
        await act(async () => {});
        const dialog = screen.getByRole("dialog", {
          name: settings ? "バックアップ設定" : "バックアップ状態",
        });
        const overlay = dialog.parentElement!;
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(overlay.dataset.memokaFocusSurface).toBe("backup");
        // In particular, .focus-surface's position:relative must not put the
        // overlay back in the application's grid / command-line row.
        expect(getComputedStyle(overlay).position).toBe("fixed");
        expect(getComputedStyle(overlay).inset).toBe("0");
        expect(getComputedStyle(overlay).display).toBe("grid");
        expect(getComputedStyle(overlay).placeItems).toBe("center");
        expect(getComputedStyle(dialog).overflow).toBe("auto");
        expect(getComputedStyle(dialog).maxHeight).toBe("100%");
      } finally {
        style.remove();
      }
    },
  );

  it("traps focus and Tab within the form and does not dismiss on backdrop clicks", async () => {
    const close = vi.fn();
    render(
      <>
        <button>背後の操作</button>
        <BackupDialog
          port={backupFixture()}
          session={{ settings: true, restoreFocus: vi.fn() }}
          onClose={close}
          onSaved={vi.fn()}
        />
      </>,
    );
    const interval = screen.getByRole("spinbutton");
    await waitFor(() => expect(interval.matches(":disabled")).toBe(false));
    interval.focus();
    fireEvent.keyDown(interval, { key: "Tab", shiftKey: true });
    const last = screen.getByRole("button", { name: "閉じる" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(interval);
    const dialog = screen.getByRole("dialog");
    expect(fireEvent.mouseDown(dialog.parentElement!)).toBe(false);
    expect(document.activeElement).toBe(interval);
    expect(close).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "背後の操作" }).focus();
    expect(document.activeElement).toBe(interval);
  });

  it("keeps the modal focused when all controls are disabled during save", async () => {
    let finishSave!: () => void;
    const settings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const close = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BackupDialog
        port={backupFixture({ settings })}
        session={{ settings: true, restoreFocus }}
        onClose={close}
        onSaved={vi.fn()}
      />,
    );
    const save = screen.getByRole("button", { name: "設定を保存" });
    await waitFor(() => expect(save.matches(":disabled")).toBe(false));
    save.focus();
    fireEvent.click(save);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    for (const key of [
      { key: "Tab" },
      { key: "Tab", shiftKey: true },
      { key: "Escape" },
      { key: "c", ctrlKey: true },
    ]) {
      fireEvent.keyDown(dialog, key);
      expect(document.activeElement).toBe(dialog);
    }
    expect(close).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(close).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it.each(["backup-settings", "backup-status"])(
    "opens :%s modally and returns focus to the initiating Sidebar",
    async (commandName) => {
      const view = render(<App backup={backupFixture()} />);
      const tree = await screen.findByRole("tree", { name: "ノートツリー" });
      tree.focus();
      fireEvent.keyDown(tree, { key: ":", code: "Semicolon", shiftKey: true });
      const command = screen.getByRole("textbox", { name: "Memoka Command" });
      fireEvent.change(command, { target: { value: commandName } });
      fireEvent.keyDown(command, { key: "Enter" });
      const dialog = await screen.findByRole("dialog", {
        name:
          commandName === "backup-settings"
            ? "バックアップ設定"
            : "バックアップ状態",
      });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(
        view.container.querySelector("main")?.dataset.applicationFocus,
      ).toBe("backup");
      // Even a late key event addressed to the previous owner is intercepted.
      expect(fireEvent.keyDown(tree, { key: "a", code: "KeyA" })).toBe(false);
      expect(dialog.contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(tree));
    },
  );

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
