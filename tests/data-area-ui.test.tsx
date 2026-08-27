import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/src/App";
import { MemoryDataAreaPort } from "../app/src/platform/data-area";

describe("Workspace data area startup", () => {
  it("requires an explicit directory on first launch and then opens Memoka", async () => {
    const dataArea = new MemoryDataAreaPort(false, "memory://chosen-workspace");
    render(
      <App
        dataArea={dataArea}
        portableMirror={null}
        desktopWindow={null}
        showDebugLine={false}
      />,
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
});
