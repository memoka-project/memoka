import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
