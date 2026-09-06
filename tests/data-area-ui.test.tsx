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
