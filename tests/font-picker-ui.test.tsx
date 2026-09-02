import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FontPicker } from "../app/src/components/FontPicker";
import { DEFAULT_APPLICATION_FONT_FAMILY } from "../app/src/core/application-appearance";

describe("Memoka Font picker", () => {
  it("previews and accepts an arbitrary font-family through SearchPane", async () => {
    const onPreview = vi.fn();
    const onAccept = vi.fn(async () => {});
    render(
      <FontPicker
        session={{
          initialFontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
          restoreFocus: vi.fn(),
        }}
        onPreview={onPreview}
        onAccept={onAccept}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "フォント名またはfont-familyを入力",
    });
    expect(document.activeElement).toBe(input);
    await waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        DEFAULT_APPLICATION_FONT_FAMILY,
      ),
    );

    fireEvent.change(input, {
      target: { value: "Noto Sans CJK JP, sans-serif" },
    });
    await waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        "Noto Sans CJK JP, sans-serif",
      ),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith("Noto Sans CJK JP, sans-serif"),
    );
  });

  it("restores focus and cancels with Ctrl-c", async () => {
    const onCancel = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <FontPicker
        session={{
          initialFontFamily: DEFAULT_APPLICATION_FONT_FAMILY,
          restoreFocus,
        }}
        onPreview={vi.fn()}
        onAccept={vi.fn(async () => {})}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "フォント名またはfont-familyを入力",
    });
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });
});
