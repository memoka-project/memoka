import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InlineFormatPicker } from "../app/src/components/InlineFormatPicker";

describe("Memoka Inline Format picker", () => {
  it("shares SearchPane filtering and applies the best bottom style", async () => {
    const apply = vi.fn(() => ({
      changed: true as const,
      from: 1,
      action: { kind: "apply" as const, format: "italic" as const },
    }));
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <InlineFormatPicker
        session={{
          windowId: "window-1",
          selectedText: "sample",
          existingHref: null,
          apply,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "文字装飾を検索" });
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(7);
    fireEvent.change(input, { target: { value: "斜体 italic" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apply).toHaveBeenCalledWith({ kind: "apply", format: "italic" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("applies Highlight from the Visual-char format catalog", () => {
    const apply = vi.fn((action) => ({
      changed: true as const,
      from: 1,
      action,
    }));
    render(
      <InlineFormatPicker
        session={{
          windowId: "window-1",
          selectedText: "重要",
          existingHref: null,
          apply,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
        onMessage={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "文字装飾を検索" });
    fireEvent.change(input, { target: { value: "蛍光ペン" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("重要").closest("mark")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apply).toHaveBeenCalledWith({
      kind: "apply",
      format: "highlight",
    });
  });

  it("collects and normalizes an external URL in a second pane", () => {
    const apply = vi.fn((action) => ({
      changed: true as const,
      from: 1,
      action,
    }));
    render(
      <InlineFormatPicker
        session={{
          windowId: "window-1",
          selectedText: "website",
          existingHref: null,
          apply,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
        onMessage={vi.fn()}
      />,
    );
    const catalog = screen.getByRole("combobox", { name: "文字装飾を検索" });
    fireEvent.change(catalog, { target: { value: "link" } });
    fireEvent.keyDown(catalog, { key: "Enter" });

    const url = screen.getByRole("combobox", { name: "外部リンクURL" });
    fireEvent.change(url, { target: { value: "example.com/docs" } });
    expect(screen.getByRole("option").textContent).toContain(
      "https://example.com/docs",
    );
    fireEvent.keyDown(url, { key: "Enter" });
    expect(apply).toHaveBeenCalledWith({
      kind: "link",
      href: "https://example.com/docs",
    });
  });

  it("keeps an invalid URL open and cancels without mutation", async () => {
    const apply = vi.fn();
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <InlineFormatPicker
        session={{
          windowId: "window-1",
          selectedText: "website",
          existingHref: null,
          apply,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );
    const catalog = screen.getByRole("combobox", { name: "文字装飾を検索" });
    fireEvent.change(catalog, { target: { value: "link" } });
    fireEvent.keyDown(catalog, { key: "Enter" });
    const url = screen.getByRole("combobox", { name: "外部リンクURL" });
    fireEvent.change(url, { target: { value: "javascript:alert(1)" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/http、https、mailto、tel/u)).toBeTruthy();
    fireEvent.keyDown(url, { key: "c", ctrlKey: true });
    expect(apply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});
