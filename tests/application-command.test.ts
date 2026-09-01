import { describe, expect, it } from "vitest";
import {
  applicationCommandHelp,
  parseApplicationCommand,
} from "../app/src/core/application-command";
import {
  commandLineKeySequence,
  commandLineKeymap,
} from "../app/src/core/command-line-keymap";

describe("Memoka Application Command-line", () => {
  it("parses only the documented minimal commands and aliases", () => {
    expect(parseApplicationCommand(" :tree ")).toMatchObject({
      kind: "command",
      command: { id: "utility.tree" },
    });
    expect(parseApplicationCommand("ls")).toMatchObject({
      kind: "command",
      command: { id: "workspace.search_buffers" },
    });
    expect(parseApplicationCommand("bd")).toMatchObject({
      kind: "command",
      command: { id: "buffer.close" },
    });
    expect(parseApplicationCommand("paste-markdown")).toMatchObject({
      kind: "command",
      command: { id: "editor.paste_markdown" },
    });
    expect(parseApplicationCommand("paste-html")).toMatchObject({
      kind: "command",
      command: { id: "editor.paste_html" },
    });
    expect(parseApplicationCommand("attach")).toMatchObject({
      kind: "command",
      command: { id: "editor.attach" },
    });
    expect(parseApplicationCommand("switch-workspace")).toMatchObject({
      kind: "command",
      command: { id: "workspace.switch" },
    });
    expect(parseApplicationCommand("update")).toMatchObject({
      kind: "command",
      command: { id: "application.update" },
    });
    expect(parseApplicationCommand("ver")).toMatchObject({
      kind: "command",
      command: { id: "application.version" },
    });
    expect(parseApplicationCommand("diag")).toMatchObject({
      kind: "command",
      command: { id: "application.diagnostics" },
    });
    expect(parseApplicationCommand("q")).toMatchObject({
      kind: "command",
      command: { id: "application.quit" },
    });
    expect(parseApplicationCommand(":qa")).toMatchObject({
      kind: "command",
      command: { id: "application.quit" },
    });
    expect(parseApplicationCommand("colo duskfox")).toMatchObject({
      kind: "command",
      command: { id: "application.colorscheme" },
      argument: "duskfox",
    });
    expect(parseApplicationCommand(":colorscheme")).toMatchObject({
      kind: "command",
      command: { id: "application.colorscheme" },
      argument: null,
    });
    expect(parseApplicationCommand("colorscheme duskfox extra")).toEqual({
      kind: "error",
      message: "引数は1つまで指定できます: colorscheme",
    });
    expect(parseApplicationCommand("   ")).toEqual({ kind: "empty" });
    expect(parseApplicationCommand("buffers extra")).toEqual({
      kind: "error",
      message: "引数を受け付けないCommandです: buffers",
    });
    expect(parseApplicationCommand("write")).toEqual({
      kind: "error",
      message: "未対応のCommandです: write",
    });
    expect(parseApplicationCommand("notes")).toEqual({
      kind: "error",
      message: "未対応のCommandです: notes",
    });
    expect(applicationCommandHelp()).toBe(
      ":tree · :trash · :buffers · :outline · :split · :vsplit · :close · :bdelete · :tabnew · :tabclose · :tabnext · :tabprevious · :paste-markdown · :paste-html · :attach · :switch-workspace · :update · :version · :diagnostics · :colorscheme · :quit",
    );
  });

  it("resolves execute and close keys from a declarative context", () => {
    expect(commandLineKeymap.resolve("command-line.insert", "Enter")).toBe(
      "command-line.execute",
    );
    expect(commandLineKeymap.resolve("command-line.insert", "Escape")).toBe(
      "command-line.close",
    );
    expect(commandLineKeymap.resolve("command-line.insert", "Ctrl+c")).toBe(
      "command-line.close",
    );
    expect(
      commandLineKeySequence({
        key: "c",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
      }),
    ).toBe("Ctrl+c");
  });
});
