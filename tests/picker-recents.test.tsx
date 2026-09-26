import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandPicker } from "../app/src/components/ApplicationCommandPicker";
import { InlineFormatPicker } from "../app/src/components/InlineFormatPicker";
import { PickerRecentsProvider } from "../app/src/components/PickerRecents";
import { SymbolPicker } from "../app/src/components/SymbolPicker";
import {
  rankPickerItems,
  readPickerRecents,
  recordPickerRecent,
} from "../app/src/core/picker-recents";
import { MemoryPickerRecentsPort } from "../app/src/platform/picker-recents";
import { loadSymbolCatalog } from "../app/src/core/symbols";

function options(): string[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("shared picker recents", () => {
  it("keeps separate bounded LRU lists and stable catalog order for unseen matches", () => {
    let state = readPickerRecents({ schemaVersion: 1, recent: {} });
    state = recordPickerRecent(state, "command", "beta");
    state = recordPickerRecent(state, "command", "alpha");
    state = recordPickerRecent(state, "command", "beta");
    state = recordPickerRecent(state, "symbol", "alpha");
    expect(
      rankPickerItems(["alpha", "beta", "gamma"], "command", state, (id) => id),
    ).toEqual(["beta", "alpha", "gamma"]);
    expect(
      rankPickerItems(["alpha", "beta", "gamma"], "symbol", state, (id) => id),
    ).toEqual(["alpha", "beta", "gamma"]);
    for (let index = 0; index < 105; index += 1) {
      state = recordPickerRecent(state, "command", `item-${index}`);
    }
    expect(state.command).toHaveLength(100);
    expect(state.command?.[0]).toBe("item-104");
    expect(state.command).not.toContain("beta");
  });

  it("restores a confirmed command at the input after remount and filters before ranking", async () => {
    const port = new MemoryPickerRecentsPort();
    const onSelect = vi.fn();
    const picker = () => (
      <PickerRecentsProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus: vi.fn() }}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      </PickerRecentsProvider>
    );
    const first = render(picker());
    const input = screen.getByRole("combobox", {
      name: "Memoka Commandを検索",
    });
    fireEvent.change(input, { target: { value: "backup" } });
    const backup = screen
      .getAllByRole("option")
      .find(
        (option) => option.querySelector("strong")?.textContent === ":backup",
      );
    expect(backup).toBeDefined();
    fireEvent.click(backup!);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace.backup" }),
    );
    await waitFor(async () =>
      expect((await port.load()).command).toEqual(["workspace.backup"]),
    );
    first.unmount();

    render(picker());
    await waitFor(() => expect(options().at(-1)).toContain(":backup"));
    const secondInput = screen.getByRole("combobox", {
      name: "Memoka Commandを検索",
    });
    fireEvent.change(secondInput, { target: { value: "tree" } });
    expect(options().some((option) => option.startsWith(":tree"))).toBe(true);
    expect(options().join(" ")).not.toContain(":backup");
  });

  it("pins clear first for a partially formatted selection and last without formatting", async () => {
    const port = new MemoryPickerRecentsPort();
    await port.record("inline-format", "bold");
    await port.record("inline-format", "clear");
    const renderPicker = (hasFormatting: boolean) =>
      render(
        <PickerRecentsProvider port={port}>
          <InlineFormatPicker
            session={{
              windowId: "window-1",
              selectedText: "sample",
              existingHref: null,
              hasFormatting,
              apply: vi.fn(() => ({
                changed: false as const,
                reason: "no-op" as const,
              })),
              restoreFocus: vi.fn(),
            }}
            onClose={vi.fn()}
            onMessage={vi.fn()}
          />
        </PickerRecentsProvider>,
      );

    const formatted = renderPicker(true);
    await waitFor(() => expect(options().at(-1)).toContain("全装飾を解除"));
    const input = screen.getByRole("combobox", { name: "文字装飾を検索" });
    fireEvent.change(input, { target: { value: "bold" } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("太字");
    formatted.unmount();

    renderPicker(false);
    await waitFor(() => expect(options()[0]).toContain("全装飾を解除"));
    expect(options().at(-1)).toContain("太字");
  });

  it("ranks a recent symbol before applying the 200-result display limit", async () => {
    const catalog = await loadSymbolCatalog();
    const recent = catalog.at(-1)!;
    const port = new MemoryPickerRecentsPort();
    await port.record("symbol", recent.id);
    render(
      <PickerRecentsProvider port={port}>
        <SymbolPicker
          session={{
            windowId: "window-1",
            apply: vi.fn(() => true),
            restoreFocus: vi.fn(),
          }}
          onClose={vi.fn()}
        />
      </PickerRecentsProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")).toHaveLength(200),
    );
    await waitFor(() => expect(options().at(-1)).toContain(recent.name));
  });
});
