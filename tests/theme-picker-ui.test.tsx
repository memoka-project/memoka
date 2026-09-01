import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemePicker } from "../app/src/components/ThemePicker";

describe("Memoka Theme picker", () => {
  it("previews keyboard selection and accepts it through the shared SearchPane", async () => {
    const onPreview = vi.fn();
    const onAccept = vi.fn(async () => {});
    render(
      <ThemePicker
        session={{ initialThemeId: "nightfox", restoreFocus: vi.fn() }}
        onPreview={onPreview}
        onAccept={onAccept}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "カラーテーマを検索",
    });
    expect(document.activeElement).toBe(input);
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith("nightfox"));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith("dayfox"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith("dayfox"));
  });

  it("filters themes and restores focus when cancelled with Ctrl-c", async () => {
    const onCancel = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <ThemePicker
        session={{ initialThemeId: "nightfox", restoreFocus }}
        onPreview={vi.fn()}
        onAccept={vi.fn(async () => {})}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "カラーテーマを検索",
    });
    fireEvent.change(input, { target: { value: "light" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});
