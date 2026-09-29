import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RegisterPicker } from "../app/src/components/RegisterPicker";

describe("Vim register picker", () => {
  it("orders the visible list from the bottom as unnamed, clipboard, named, then numbered", () => {
    render(
      <RegisterPicker
        session={{
          select: vi.fn(),
          restoreFocus: vi.fn(),
          read: async () => null,
        }}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen
        .getAllByRole("option")
        .map((item) => item.querySelector("strong")?.textContent)
        .reverse(),
    ).toEqual([
      '""',
      '"+',
      '"*',
      '"_',
      ...[..."abcdefghijklmnopqrstuvwxyz"].map((name) => `"${name}`),
      ...Array.from({ length: 10 }, (_, index) => `"${index}`),
    ]);
  });

  it("shows register content and arms the selected register", async () => {
    const select = vi.fn();
    const restoreFocus = vi.fn();
    const onClose = vi.fn();
    render(
      <RegisterPicker
        session={{
          select,
          restoreFocus,
          read: async (name) => (name === "a" ? "saved text" : null),
        }}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Vimレジスタを検索" });
    fireEvent.change(input, { target: { value: "a" } });
    const named = screen
      .getAllByRole("option")
      .find((item) => item.querySelector("strong")?.textContent === '"a');
    expect(named).toBeDefined();
    fireEvent.click(named!);
    await waitFor(() => expect(screen.getByText("saved text")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("a");
    expect(onClose).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });
});
