import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlockTypePicker } from "../app/src/components/BlockTypePicker";

describe("Memoka Block Type picker", () => {
  it("shares the search-pane interaction and accepts the best bottom result", async () => {
    const transform = vi.fn(() => ({
      changed: true as const,
      target: "paragraph" as const,
      selection: "text" as const,
    }));
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BlockTypePicker
        session={{
          windowId: "window-1",
          blockId: "block-1",
          transform,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ブロックタイプを検索",
    });
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getAllByRole("option").at(-1)?.textContent).toContain(
      "Paragraph",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(transform).toHaveBeenCalledWith("paragraph");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("filters Japanese and English aliases with whitespace AND semantics", () => {
    render(
      <BlockTypePicker
        session={{
          windowId: "window-1",
          blockId: "block-1",
          transform: vi.fn(),
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ブロックタイプを検索",
    });
    fireEvent.change(input, { target: { value: "番号 list" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Numbered List");

    fireEvent.change(input, { target: { value: "ＣＯＤＥ" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("Code Block");
  });

  it("cancels with Ctrl-c without transforming the slash Paragraph", async () => {
    const transform = vi.fn();
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BlockTypePicker
        session={{
          windowId: "window-1",
          blockId: "block-1",
          transform,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "ブロックタイプを検索" }),
      { key: "c", ctrlKey: true },
    );
    expect(transform).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("runs the Attachment action without transforming or restoring focus early", () => {
    const transform = vi.fn();
    const attach = vi.fn();
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BlockTypePicker
        session={{
          windowId: "window-1",
          blockId: "block-1",
          transform,
          attach,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ブロックタイプを検索",
    });
    fireEvent.change(input, { target: { value: "添付" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(transform).not.toHaveBeenCalled();
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it("chooses Table columns and rows with an NxN keyboard grid", async () => {
    const transform = vi.fn(() => ({
      changed: true as const,
      target: "table" as const,
      selection: "text" as const,
    }));
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BlockTypePicker
        session={{
          windowId: "window-1",
          blockId: "block-1",
          transform,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "ブロックタイプを検索",
    });
    fireEvent.change(input, { target: { value: "table" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const grid = screen.getByRole("grid", { name: "Tableサイズ" });
    await waitFor(() => expect(document.activeElement).toBe(grid));
    expect(screen.getByText("3列 × 3行")).toBeTruthy();
    fireEvent.keyDown(grid, { key: "Enter" });

    expect(transform).toHaveBeenCalledWith("table", {
      rows: 3,
      columns: 3,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});
