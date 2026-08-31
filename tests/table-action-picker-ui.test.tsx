import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableActionPicker } from "../app/src/components/TableActionPicker";

const selection = {
  tableBlockId: "table-1",
  tablePosition: 1,
  rowFrom: 1,
  rowTo: 2,
  columnFrom: 0,
  columnTo: 1,
  activeRow: 1,
  activeColumn: 0,
  beforeCursor: 5,
  mode: "visual-block" as const,
};

describe("Memoka Table action picker", () => {
  it("uses the shared SearchPane and applies the best bottom action", async () => {
    const apply = vi.fn(() => ({
      changed: true as const,
      reason: "changed" as const,
      position: 6,
    }));
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <TableActionPicker
        session={{
          windowId: "window-1",
          selection,
          apply,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Table操作を検索" });
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(15);
    expect(screen.getByText("対象: 2行 × 2列")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apply).toHaveBeenCalledWith("row.add_after");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("filters Japanese and English aliases with whitespace AND semantics", () => {
    render(
      <TableActionPicker
        session={{
          windowId: "window-1",
          selection,
          apply: vi.fn(),
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Table操作を検索" });
    fireEvent.change(input, { target: { value: "列 center" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("列を中央揃え");
  });

  it("keeps an unsupported operation open and cancels without mutation", async () => {
    const apply = vi.fn(() => ({
      changed: false as const,
      reason: "unsupported" as const,
      position: 5,
    }));
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <TableActionPicker
        session={{
          windowId: "window-1",
          selection,
          apply,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Table操作を検索" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText("結合セルを含むTableにはこの操作を適用できません"),
    ).toBeTruthy();

    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});
