import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { MemoryDataAreaPort } from "../app/src/platform/data-area";
import { backupFixture } from "./backup-fixture";

describe("Workspace data area startup", () => {
  it("requires an explicit directory on first launch and then opens Memoka", async () => {
    const dataArea = new MemoryDataAreaPort(false, "memory://chosen-workspace");
    render(
      <App dataArea={dataArea} desktopWindow={null} showDebugLine={false} />,
    );

    await screen.findByRole("heading", {
      name: "Workspaceデータ領域を選択してください",
    });
    fireEvent.click(screen.getByRole("button", { name: "ディレクトリを選択" }));

    await screen.findByRole("button", { name: "新しいTabPage" });
    await expect(dataArea.status()).resolves.toMatchObject({
      selected: true,
      path: "memory://chosen-workspace",
    });
  });

  it.each([undefined, "Migration changed content or identities"])(
    "shows the affected document and preserves migration diagnostics (reason=%s)",
    async (message) => {
      const documentId = "01a0753d-aca3-78d1-bd85-f08a4628dd55";
      const failure = {
        code: "MIGRATION_PREFLIGHT_FAILED",
        message:
          "移行前検査に失敗しました。元のWorkspaceを旧版で修正してから再試行してください。",
        details: {
          documents: [
            {
              code: "INVALID_DATA",
              details: null,
              document_id: documentId,
              ...(message ? { kind: "note", message } : {}),
            },
          ],
        },
      };
      const dataArea = new MemoryDataAreaPort();
      vi.spyOn(dataArea, "status").mockRejectedValue(
        `invalid input: ${JSON.stringify(failure)}`,
      );
      render(<App dataArea={dataArea} desktopWindow={null} />);

      await screen.findByRole("heading", {
        name: "ワークスペースを開けませんでした",
      });
      expect(screen.getByText(/元のWorkspaceは変更していません/)).toBeTruthy();
      const targets = screen.getByRole("list", { name: "移行できない対象" });
      expect(targets.textContent).toContain(documentId);
      expect(targets.textContent).toContain(
        message ?? "具体的な理由が記録されていません。",
      );
      expect(targets.textContent).toContain("INVALID_DATA");
      const summary = screen.getByText("技術的な詳細");
      const details = summary.closest("details")!;
      expect(details.open).toBe(false);
      fireEvent.click(summary);
      expect(details.open).toBe(true);
      expect(JSON.parse(details.querySelector("pre")!.textContent!)).toEqual(
        failure,
      );
      expect(
        screen.getByRole("button", { name: "Workspaceデータ領域を選択" }),
      ).toBeTruthy();
    },
  );

  it.each(["保存先にアクセスできません。", 'invalid input: {"code":broken'])(
    "preserves an unstructured startup error: %s",
    async (message) => {
      const dataArea = new MemoryDataAreaPort();
      vi.spyOn(dataArea, "status").mockRejectedValue(new Error(message));
      render(<App dataArea={dataArea} desktopWindow={null} />);
      await screen.findByRole("heading", {
        name: "ワークスペースを開けませんでした",
      });
      expect(screen.getByText(message).tagName).toBe("PRE");
    },
  );

  it.each([false, true])(
    "withdraws switching without stopping backup, or reaps children on explicit skip (switch=%s)",
    async (proceed) => {
      const dataArea = new MemoryDataAreaPort(true, "memory://next-workspace");
      const activate = vi.spyOn(dataArea, "activate");
      let hold = false;
      let stop!: () => void;
      let reaped!: () => void;
      const copying = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const reapGate = new Promise<void>((resolve) => {
        reaped = resolve;
      });
      const run = vi.fn(async () => {
        if (hold) await copying;
      });
      const cancel = vi.fn(async () => {
        await reapGate;
        stop();
      });
      const view = render(
        <App
          dataArea={dataArea}
          backup={backupFixture({ run, cancel })}
          desktopWindow={null}
        />,
      );
      await screen.findByRole("tree", { name: "ノートツリー" });
      await waitFor(() => expect(run).toHaveBeenCalled());
      hold = true;
      const editor =
        view.container.querySelector<HTMLElement>(".memoka-editor")!;
      editor.focus();
      fireEvent.keyDown(editor, { key: "Escape" });
      fireEvent.keyDown(editor, { key: ":" });
      const command = await screen.findByRole("textbox", {
        name: "Memoka Command",
      });
      fireEvent.change(command, { target: { value: "switch-workspace" } });
      fireEvent.keyDown(command, { key: "Enter" });
      await screen.findByRole("dialog", { name: "Workspaceを切り替え" });
      await screen.findByText(/バックアップの完了を待っています/);
      expect(editor.isConnected).toBe(true);
      expect(activate).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", {
          name: proceed
            ? /バックアップを中断して切り替え/
            : "切り替えを取り消す",
        }),
      );
      if (proceed) {
        await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(activate).not.toHaveBeenCalled();
        await act(async () => {
          reaped();
        });
      } else {
        expect(cancel).not.toHaveBeenCalled();
      }
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Workspaceを切り替え" }),
        ).toBeNull(),
      );
      expect(activate).toHaveBeenCalledTimes(proceed ? 1 : 0);
      expect((await dataArea.status()).path).toBe(
        proceed ? "memory://next-workspace" : "memory://workspace",
      );
      if (!proceed) expect(editor.isConnected).toBe(true);
      await act(async () => {
        stop();
        reaped();
      });
    },
  );
});
