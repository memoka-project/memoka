import { describe, expect, it } from "vitest";
import { DeclarativeKeymap } from "../app/src/core/keymap";
import { searchKeySequence, searchKeymap } from "../app/src/core/search-keymap";

type Context = "note.normal" | "notes.normal" | "search.insert";
type Command = "cursor.down" | "notes.next" | "search.insert-text";

describe("Memoka declarative keymap", () => {
  it("resolves the same sequence independently for each context", () => {
    const keymap = new DeclarativeKeymap<Context, Command>(
      [
        { context: "note.normal", sequence: "j", command: "cursor.down" },
        { context: "notes.normal", sequence: "j", command: "notes.next" },
        {
          context: "search.insert",
          sequence: "j",
          command: "search.insert-text",
        },
      ],
      ["cursor.down", "notes.next", "search.insert-text"],
    );

    expect(keymap.resolve("note.normal", "j")).toBe("cursor.down");
    expect(keymap.resolve("notes.normal", "j")).toBe("notes.next");
    expect(keymap.resolve("search.insert", "j")).toBe("search.insert-text");
    expect(keymap.resolve("note.normal", "k")).toBeNull();
  });

  it("rejects ambiguous and empty declarations at startup", () => {
    expect(
      () =>
        new DeclarativeKeymap<Context, Command>(
          [
            { context: "note.normal", sequence: "j", command: "cursor.down" },
            { context: "note.normal", sequence: "j", command: "notes.next" },
          ],
          ["cursor.down", "notes.next", "search.insert-text"],
        ),
    ).toThrow("Duplicate key binding: note.normal:j");
    expect(
      () =>
        new DeclarativeKeymap<Context, Command>(
          [{ context: "note.normal", sequence: "", command: "cursor.down" }],
          ["cursor.down", "notes.next", "search.insert-text"],
        ),
    ).toThrow("Key binding sequence must not be empty");
    expect(
      () =>
        new DeclarativeKeymap<Context, Command>(
          [{ context: "note.normal", sequence: "j", command: "notes.next" }],
          ["cursor.down"],
        ),
    ).toThrow("Unknown keymap command: notes.next");
  });

  it("does not expose its internal declarations for mutation", () => {
    const source = [
      {
        context: "note.normal" as const,
        sequence: "j",
        command: "cursor.down" as const,
      },
    ];
    const keymap = new DeclarativeKeymap<Context, Command>(source, [
      "cursor.down",
      "notes.next",
      "search.insert-text",
    ]);
    source[0].sequence = "k";
    const reported = keymap.bindings();
    (reported[0] as { sequence: string }).sequence = "l";

    expect(keymap.resolve("note.normal", "j")).toBe("cursor.down");
    expect(keymap.resolve("note.normal", "k")).toBeNull();
    expect(keymap.resolve("note.normal", "l")).toBeNull();
  });

  it("uses the shared declarative resolver for Workspace search controls", () => {
    expect(searchKeymap.resolve("search.insert", "ArrowDown")).toBe(
      "search.select_next",
    );
    expect(searchKeymap.resolve("search.insert", "Ctrl+p")).toBe(
      "search.select_previous",
    );
    expect(searchKeymap.resolve("search.insert", "Enter")).toBe(
      "search.accept",
    );
    expect(searchKeymap.resolve("search.insert", "Escape")).toBe(
      "search.close",
    );
    expect(searchKeymap.resolve("search.insert", "r")).toBeNull();
    expect(searchKeymap.resolve("search.trash", "r")).toBe("search.restore");
    expect(searchKeymap.resolve("search.trash", "Enter")).toBe("search.ignore");
    expect(searchKeymap.resolve("search.trash", "Tab")).toBe("search.ignore");
    expect(searchKeymap.resolve("search.trash", "Ctrl+c")).toBe("search.close");
    expect(
      searchKeySequence({
        key: "N",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
      }),
    ).toBe("Ctrl+n");
    expect(
      searchKeySequence({
        key: "Enter",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
      }),
    ).toBeNull();
  });
});
