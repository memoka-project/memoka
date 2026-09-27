import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandLine } from "../app/src/components/ApplicationCommandLine";
import { ApplicationCommandPicker } from "../app/src/components/ApplicationCommandPicker";
import { CommandHistoryProvider } from "../app/src/components/CommandHistory";
import {
  navigateCommandHistory,
  readCommandHistory,
  recordCommandHistory,
} from "../app/src/core/command-history";
import { MemoryCommandHistoryPort } from "../app/src/platform/command-history";
import {
  APPLICATION_COMMANDS,
  applicationCommandArgumentHelp,
  applicationCommandArgumentIsComplete,
  parseApplicationCommand,
} from "../app/src/core/application-command";

function input(): HTMLInputElement {
  return screen.getByRole("textbox", {
    name: "Memoka Command",
  }) as HTMLInputElement;
}

function pickerInput(): HTMLInputElement {
  return screen.getByRole("combobox", {
    name: "Memoka Commandを検索",
  }) as HTMLInputElement;
}

function optionText(): string[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("Command history", () => {
  it("stores full submitted text, moves exact duplicates forward, and bounds the list", () => {
    let history = readCommandHistory({
      schemaVersion: 1,
      entries: ["tree", "unknown arg", "tree", "", "\n"],
    });
    expect(history).toEqual(["tree", "unknown arg"]);
    history = recordCommandHistory(history, "  q");
    history = recordCommandHistory(history, "tree");
    expect(history).toEqual(["tree", "  q", "unknown arg"]);
    for (let index = 0; index < 205; index += 1)
      history = recordCommandHistory(history, `command-${index}`);
    expect(history).toHaveLength(200);
    expect(history[0]).toBe("command-204");
  });

  it("uses a fixed prefix for arrows, all entries for Ctrl-p/n, and restores the draft", () => {
    const history = ["note-width 1000", "tree", "note-width 900"];
    const first = navigateCommandHistory(
      history,
      "note-",
      5,
      5,
      null,
      "older",
      true,
    );
    expect(first.value).toBe("note-width 1000");
    const second = navigateCommandHistory(
      history,
      first.value,
      first.value.length,
      first.value.length,
      first.browse,
      "older",
      true,
    );
    expect(second.value).toBe("note-width 900");
    const all = navigateCommandHistory(
      history,
      first.value,
      first.value.length,
      first.value.length,
      first.browse,
      "older",
      false,
    );
    expect(all.value).toBe("tree");
    const latest = navigateCommandHistory(
      history,
      first.value,
      first.value.length,
      first.value.length,
      first.browse,
      "newer",
      true,
    );
    expect(latest.value).toBe("note-");
    expect(latest.browse).toBeNull();
  });

  it("keeps focus on Tab and lets recalled commands be edited and submitted", async () => {
    const port = new MemoryCommandHistoryPort();
    await port.record("tree");
    await port.record("note-width 900");
    const onExecute = vi.fn();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandLine
          session={{ restoreFocus: vi.fn() }}
          onExecute={onExecute}
          onGoToLine={vi.fn()}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    await act(async () => {});
    const field = input();
    fireEvent.change(field, { target: { value: "note-" } });
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "ArrowUp", isComposing: true });
    expect(field.value).toBe("note-");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("note-width 900");
    fireEvent.keyDown(field, { key: "p", ctrlKey: true });
    expect(field.value).toBe("tree");
    fireEvent.keyDown(field, { key: "n", ctrlKey: true });
    expect(field.value).toBe("note-width 900");
    fireEvent.change(field, { target: { value: "note-width 1000" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onExecute).toHaveBeenCalledWith(
      "application.note_width",
      ":note-width",
      "1000",
    );
    await waitFor(async () =>
      expect((await port.load())[0]).toBe("note-width 1000"),
    );
  });

  it("records unknown submitted input and recalls it after remount", async () => {
    const port = new MemoryCommandHistoryPort();
    const view = render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandLine
          session={{ restoreFocus: vi.fn() }}
          onExecute={vi.fn()}
          onGoToLine={vi.fn()}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    fireEvent.change(input(), { target: { value: "unknown arg" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("未対応");
    await waitFor(async () =>
      expect(await port.load()).toEqual(["unknown arg"]),
    );
    view.unmount();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandLine
          session={{ restoreFocus: vi.fn() }}
          onExecute={vi.fn()}
          onGoToLine={vi.fn()}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    await act(async () => {});
    fireEvent.keyDown(input(), { key: "p", ctrlKey: true });
    expect(input().value).toBe("unknown arg");
  });

  it("submits a numeric logical line address and records it in history", async () => {
    const port = new MemoryCommandHistoryPort();
    const onGoToLine = vi.fn();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandLine
          session={{ restoreFocus: vi.fn() }}
          onExecute={vi.fn()}
          onGoToLine={onGoToLine}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    fireEvent.change(input(), { target: { value: "12" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onGoToLine).toHaveBeenCalledWith(12);
    await waitFor(async () => expect(await port.load()).toEqual(["12"]));
    fireEvent.change(input(), { target: { value: "0" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("1以上");
    expect(onGoToLine).toHaveBeenCalledTimes(1);
  });

  it("describes and validates every optional command argument", () => {
    for (const command of APPLICATION_COMMANDS.filter(
      (candidate) => candidate.argument === "optional",
    )) {
      expect(applicationCommandArgumentHelp(command)?.syntax).toBeTruthy();
      expect(applicationCommandArgumentIsComplete(command, null)).toBe(false);
    }
    const valid = parseApplicationCommand("colorscheme duskfox");
    expect(valid.kind).toBe("command");
    if (valid.kind === "command")
      expect(
        applicationCommandArgumentIsComplete(valid.command, valid.argument),
      ).toBe(true);
    const invalid = parseApplicationCommand("zoom 101");
    expect(invalid.kind).toBe("command");
    if (invalid.kind === "command")
      expect(
        applicationCommandArgumentIsComplete(invalid.command, invalid.argument),
      ).toBe(false);
  });

  it("shows one coherent preview paragraph for commands with and without arguments", () => {
    render(
      <ApplicationCommandPicker
        session={{ restoreFocus: vi.fn() }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const field = pickerInput();
    fireEvent.change(field, { target: { value: "update" } });
    let preview = document.querySelector(".command-picker__preview-content");
    expect(preview?.querySelectorAll("p")).toHaveLength(2);
    expect(preview?.querySelector("p")?.textContent).toBe(
      "署名済みのMemoka更新を確認・適用する。",
    );
    fireEvent.change(field, { target: { value: "zoom" } });
    preview = document.querySelector(".command-picker__preview-content");
    expect(preview?.querySelectorAll("p")).toHaveLength(2);
    expect(preview?.querySelector("p")?.textContent).toBe(
      "現在のZoom倍率を確認・変更します。変更時は50〜200%の値を10刻みで指定します。",
    );
  });

  it("combines history with catalog, completes aliases, and executes complete input", async () => {
    const port = new MemoryCommandHistoryPort();
    await port.record("tree");
    await port.record("colorscheme duskfox");
    const onSelect = vi.fn();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus: vi.fn() }}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    await waitFor(() =>
      expect(
        optionText().filter((text) => text.startsWith(":tree")),
      ).toHaveLength(1),
    );
    expect(optionText().at(-1)).toContain(":colorscheme duskfox");
    const field = pickerInput();
    fireEvent.change(field, { target: { value: "colo duskfox" } });
    expect(optionText().at(-1)).toContain(":colorscheme duskfox");
    expect(screen.getByText(/theme-name/u).textContent).toContain("theme-name");
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("colorscheme duskfox");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "execute",
        command: expect.objectContaining({ id: "application.colorscheme" }),
        argument: "duskfox",
      }),
    );
    await waitFor(async () =>
      expect((await port.load())[0]).toBe("colorscheme duskfox"),
    );
  });

  it("merges aliases of the same no-argument command and keeps unknown history editable", async () => {
    const port = new MemoryCommandHistoryPort();
    await port.record("buffers");
    await port.record("ls");
    await port.record("unknown arg");
    const onSelect = vi.fn();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus: vi.fn() }}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    await waitFor(() =>
      expect(
        optionText().filter((text) => /^:(?:ls|buffers)/u.test(text)),
      ).toHaveLength(1),
    );
    expect(optionText().at(-1)).toContain(":unknown arg");
    const field = pickerInput();
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("unknown arg");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      kind: "transfer",
      value: "unknown arg",
    });
  });

  it("opens a numeric history entry as a logical line destination", async () => {
    const port = new MemoryCommandHistoryPort();
    await port.record("12");
    const onSelect = vi.fn();
    render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus: vi.fn() }}
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      </CommandHistoryProvider>,
    );
    const field = pickerInput();
    await waitFor(() =>
      expect(optionText().some((text) => text.includes(":12"))).toBe(true),
    );
    fireEvent.change(field, { target: { value: "12" } });
    expect(screen.getByRole("option").textContent).toContain("論理行へ移動");
    expect(
      screen.getByText("現在のNoteの指定した論理行へ移動します。"),
    ).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      kind: "line",
      value: "12",
      lineNumber: 12,
    });
  });

  it("keeps the selected command visible when the candidate list refreshes", async () => {
    const port = new MemoryCommandHistoryPort();
    for (let index = 0; index < 30; index += 1)
      await port.record(`unknown-${index}`);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const restoreFocus = vi.fn();
    const view = render(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus }}
          onSelect={onSelect}
          onClose={onClose}
        />
      </CommandHistoryProvider>,
    );
    await waitFor(() =>
      expect(optionText()).toHaveLength(30 + APPLICATION_COMMANDS.length),
    );
    const field = pickerInput();
    for (let index = 0; index < 5; index += 1)
      fireEvent.keyDown(field, { key: "ArrowUp" });
    const selected = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "検索結果" });
    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(selected!, "scrollIntoView", {
      configurable: true,
      value: () => {
        list.scrollTop = 420;
      },
    });
    view.rerender(
      <CommandHistoryProvider port={port}>
        <ApplicationCommandPicker
          session={{ restoreFocus }}
          onSelect={onSelect}
          onClose={onClose}
        />
      </CommandHistoryProvider>,
    );
    await act(async () => {});
    expect(selected!.getAttribute("aria-selected")).toBe("true");
    expect(list.scrollTop).toBe(420);
  });

  it("transfers an optional command without an argument and keeps Ctrl-w inside the pane", () => {
    const onSelect = vi.fn();
    render(
      <ApplicationCommandPicker
        session={{ restoreFocus: vi.fn() }}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    const field = pickerInput();
    fireEvent.change(field, { target: { value: "ui-font Noto Sans JP" } });
    fireEvent.keyDown(field, { key: "w", ctrlKey: true });
    expect(field.value).toBe("ui-font Noto Sans ");
    fireEvent.change(field, {
      target: { value: "ui-font 日本語の文章を 快適に編集する。  " },
    });
    fireEvent.keyDown(field, { key: "w", ctrlKey: true });
    expect(field.value).toBe("ui-font 日本語の文章を 快適に");
    field.setSelectionRange(8, 10);
    fireEvent.keyDown(field, { key: "w", ctrlKey: true });
    expect(field.value).toBe("ui-font 語の文章を 快適に");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "colorscheme" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      kind: "transfer",
      value: "colorscheme ",
    });
  });
});
