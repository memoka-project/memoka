import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeActionPicker } from "../app/src/components/CodeActionPicker";

const selection = {
  blockId: "code-1",
  beforeCursor: 4,
  language: null,
};

describe("Memoka Code action picker", () => {
  it("copies from the shared SearchPane without mutating the block", async () => {
    const copy = vi.fn(async () => "copied" as const);
    const setLanguage = vi.fn();
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <CodeActionPicker
        session={{
          windowId: "window-1",
          selection,
          copy,
          setLanguage,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox", {
      name: "Code Block操作を検索",
    });
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(setLanguage).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("opens the language catalog and applies a filtered language", async () => {
    const setLanguage = vi.fn(() => ({
      changed: true as const,
      reason: "changed" as const,
      position: 4,
      language: "typescript",
    }));
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <CodeActionPicker
        session={{
          windowId: "window-1",
          selection,
          copy: vi.fn(async () => "copied" as const),
          setLanguage,
          restoreFocus,
        }}
        onClose={onClose}
        onMessage={onMessage}
      />,
    );

    const actionInput = screen.getByRole("combobox", {
      name: "Code Block操作を検索",
    });
    fireEvent.change(actionInput, { target: { value: "language" } });
    fireEvent.keyDown(actionInput, { key: "Enter" });

    const languageInput = screen.getByRole("combobox", {
      name: "Code Blockの言語を検索",
    });
    fireEvent.change(languageInput, { target: { value: "ts" } });
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("TypeScript");
    fireEvent.keyDown(languageInput, { key: "Enter" });
    expect(setLanguage).toHaveBeenCalledExactlyOnceWith("typescript");
    expect(onMessage).toHaveBeenCalledWith("code.language · TypeScript");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));
  });

  it("finds and preserves TOML even though Lowlight registers it as an alias", () => {
    const setLanguage = vi.fn(() => ({
      changed: true as const,
      reason: "changed" as const,
      position: 4,
      language: "toml",
    }));
    render(
      <CodeActionPicker
        session={{
          windowId: "window-1",
          selection,
          copy: vi.fn(async () => "copied" as const),
          setLanguage,
          restoreFocus: vi.fn(),
        }}
        onClose={vi.fn()}
        onMessage={vi.fn()}
      />,
    );

    const actionInput = screen.getByRole("combobox", {
      name: "Code Block操作を検索",
    });
    fireEvent.change(actionInput, { target: { value: "language" } });
    fireEvent.keyDown(actionInput, { key: "Enter" });

    const languageInput = screen.getByRole("combobox", {
      name: "Code Blockの言語を検索",
    });
    fireEvent.change(languageInput, { target: { value: "toml" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByRole("option", { selected: true }).textContent,
    ).toContain("TOML");
    fireEvent.keyDown(languageInput, { key: "Enter" });
    expect(setLanguage).toHaveBeenCalledExactlyOnceWith("toml");
  });
});
