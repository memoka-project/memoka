import { describe, expect, it } from "vitest";
import {
  mergeApplicationKeyConfig,
  validateApplicationKeyConfig,
} from "../app/src/core/application-key-config";
import {
  advanceTreeInput,
  createTreeInputState,
} from "../app/src/core/tree-keymap";
import {
  advanceVimInput,
  createVimInputState,
  validateVimKeyConfig,
} from "../app/src/vim/input";

const noteContext = {
  isComposing: false,
  targetKind: "note-body",
} as const;

function key(value: string) {
  return {
    key: value,
    code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  };
}

describe("application key configuration", () => {
  it("merges partial TOML-shaped overrides over the complete defaults", () => {
    const config = mergeApplicationKeyConfig({
      leaderKey: ";",
      sharedNavigationBindings: { "cursor.logical-up": ["q"] },
      treeBindings: { "note.create_child": ["C"] },
      inlineFormatBindings: { "selection.format": ["M"] },
    });
    expect(config.leaderKey).toBe(";");
    expect(config.sharedNavigationBindings?.["cursor.logical-up"]).toEqual([
      "q",
    ]);
    expect(config.sharedNavigationBindings?.["cursor.logical-down"]).toEqual([
      "j",
    ]);
    expect(config.treeBindings?.["note.create_child"]).toEqual(["C"]);
    expect(config.treeBindings?.["note.open"]).toEqual(["Enter"]);
    expect(config.inlineFormatBindings?.["selection.format"]).toEqual(["M"]);
  });

  it("maps the configured visual-character formatting sequence", () => {
    const config = mergeApplicationKeyConfig({
      inlineFormatBindings: { "selection.format": ["fm"] },
    });
    validateVimKeyConfig(config);
    const prefix = advanceVimInput(
      createVimInputState(),
      "visual-char",
      "f",
      noteContext,
      config,
    );
    expect(prefix.action).toMatchObject({ kind: "pending" });
    expect(
      advanceVimInput(prefix.state, "visual-char", "m", noteContext, config),
    ).toMatchObject({
      resolvedCommand: "selection.format",
      action: { kind: "execute", command: "selection.format" },
    });
  });

  it("uses one configured navigation binding in Tree, Normal and Visual modes", () => {
    const config = mergeApplicationKeyConfig({
      sharedNavigationBindings: { "cursor.logical-up": ["qw"] },
    });
    validateVimKeyConfig(config);

    const treePrefix = advanceTreeInput(
      createTreeInputState(),
      key("q"),
      config,
    );
    expect(treePrefix.kind).toBe("pending");
    expect(advanceTreeInput(treePrefix.state, key("w"), config)).toMatchObject({
      kind: "execute",
      command: "cursor.logical-up",
    });
    for (const mode of ["normal", "visual-char", "visual-line"] as const) {
      const prefix = advanceVimInput(
        createVimInputState(),
        mode,
        "q",
        noteContext,
        config,
      );
      expect(prefix.action).toMatchObject({ kind: "pending" });
      expect(
        advanceVimInput(prefix.state, mode, "w", noteContext, config),
      ).toMatchObject({
        resolvedCommand: "cursor.logical-up",
        action: { kind: "execute", command: "cursor.logical-up" },
      });
    }
  });

  it("rejects unknown, duplicate and editor-conflicting configuration as a whole", () => {
    expect(() =>
      mergeApplicationKeyConfig({
        treeBindings: {
          "unknown.command": ["q"],
        } as never,
      }),
    ).toThrow("Unknown keymap command");
    expect(() =>
      validateApplicationKeyConfig(
        mergeApplicationKeyConfig({
          treeBindings: { "note.create_child": ["j"] },
        }),
      ),
    ).toThrow("Ambiguous Tree key bindings");
    expect(() =>
      validateVimKeyConfig(
        mergeApplicationKeyConfig({
          sharedNavigationBindings: { "cursor.logical-up": ["x"] },
        }),
      ),
    ).toThrow("Ambiguous normal key bindings");
    expect(() =>
      mergeApplicationKeyConfig({
        treeBindings: { "note.create_child": ["tq"] },
      }),
    ).toThrow("reserved by the application");
    expect(() =>
      validateVimKeyConfig(
        mergeApplicationKeyConfig({
          inlineFormatBindings: { "selection.format": ["c"] },
        }),
      ),
    ).toThrow("Ambiguous visual-char key bindings");
  });
});
