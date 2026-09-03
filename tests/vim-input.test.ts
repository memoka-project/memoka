import { describe, expect, it } from "vitest";
import {
  advanceVimInput,
  createVimInputState,
  MAX_VIM_COUNT,
  resolveKey,
} from "../app/src/vim/input";

const noteContext = {
  isComposing: false,
  targetKind: "note-body" as const,
};

describe("Memoka Vim input grammar", () => {
  it("parses a Normal count while keeping a leading zero as a motion", () => {
    const three = advanceVimInput(
      createVimInputState(),
      "normal",
      "3",
      noteContext,
    );
    expect(three).toMatchObject({
      state: { pending: null, count: "3" },
      sequence: "3",
      count: 3,
      action: { kind: "pending", detail: "pending:count" },
    });
    expect(
      advanceVimInput(three.state, "normal", "w", noteContext),
    ).toMatchObject({
      state: { pending: null, count: "" },
      sequence: "3w",
      resolvedCommand: "motion.word-forward",
      count: 3,
    });

    const two = advanceVimInput(
      createVimInputState(),
      "normal",
      "2",
      noteContext,
    );
    const twenty = advanceVimInput(two.state, "normal", "0", noteContext);
    expect(twenty).toMatchObject({
      state: { count: "20" },
      sequence: "20",
      count: 20,
    });
    expect(
      advanceVimInput(twenty.state, "normal", "j", noteContext),
    ).toMatchObject({
      sequence: "20j",
      resolvedCommand: "cursor.logical-down",
      count: 20,
    });

    expect(
      advanceVimInput(createVimInputState(), "normal", "0", noteContext),
    ).toMatchObject({
      sequence: "0",
      resolvedCommand: "motion.line-start",
      count: 1,
    });
  });

  it("carries count through g and r prefixes and caps excessive counts", () => {
    const three = advanceVimInput(
      createVimInputState(),
      "normal",
      "3",
      noteContext,
    );
    const g = advanceVimInput(three.state, "normal", "g", noteContext);
    expect(g).toMatchObject({
      state: { pending: { kind: "prefix", key: "g", count: "3" } },
      sequence: "3g",
    });
    expect(advanceVimInput(g.state, "normal", "J", noteContext)).toMatchObject({
      sequence: "3gJ",
      resolvedCommand: "line.join-raw",
      count: 3,
    });

    const r = advanceVimInput(three.state, "normal", "r", noteContext);
    expect(r).toMatchObject({
      state: {
        pending: { kind: "replace-character", key: "r", count: "3" },
      },
      sequence: "3r",
    });
    expect(advanceVimInput(r.state, "normal", "語", noteContext)).toMatchObject(
      {
        sequence: "3r語",
        resolvedCommand: "replace.character",
        count: 3,
        argument: "語",
      },
    );

    let capped = createVimInputState();
    for (const key of "99999") {
      capped = advanceVimInput(capped, "normal", key, noteContext).state;
    }
    expect(capped.count).toBe(`${MAX_VIM_COUNT}`);
  });

  it("keeps a pending Operator while a modifier key is pressed", () => {
    const yank = advanceVimInput(
      createVimInputState(),
      "normal",
      "y",
      noteContext,
    );
    const shift = advanceVimInput(yank.state, "normal", "Shift", noteContext);

    expect(shift).toMatchObject({
      state: yank.state,
      resolvedCommand: null,
      action: { kind: "unmapped" },
    });
    expect(
      advanceVimInput(shift.state, "normal", "$", noteContext),
    ).toMatchObject({
      state: { pending: null, count: "" },
      resolvedCommand: "motion.line-end",
      operator: "yank",
      action: { kind: "execute", command: "motion.line-end" },
    });
  });

  it.each([
    ["2dw", "delete", "motion.word-forward", 2],
    ["d2w", "delete", "motion.word-forward", 2],
    ["2d3w", "delete", "motion.word-forward", 6],
    ["d2iw", "delete", "text-object.inner-word", 2],
    ["2d3aw", "delete", "text-object.around-word", 6],
    ["d2ap", "delete", "text-object.around-paragraph", 2],
    ["3dd", null, "line.delete", 3],
    ["d3d", null, "line.delete", 3],
  ] as const)(
    "resolves counted sequence %s",
    (keys, operator, command, count) => {
      let state = createVimInputState();
      let resolution = advanceVimInput(
        state,
        "normal",
        keys[0] as string,
        noteContext,
      );
      state = resolution.state;
      for (const key of keys.slice(1)) {
        resolution = advanceVimInput(state, "normal", key, noteContext);
        state = resolution.state;
      }
      expect(resolution).toMatchObject({
        state: { pending: null, count: "" },
        sequence: keys,
        resolvedCommand: command,
        operator,
        count,
      });
    },
  );

  it("maps line and word motions independently of an operator", () => {
    expect(resolveKey("normal", "0", noteContext)).toBe("motion.line-start");
    expect(resolveKey("normal", "$", noteContext)).toBe("motion.line-end");
    expect(resolveKey("normal", "w", noteContext)).toBe("motion.word-forward");
    expect(resolveKey("normal", "b", noteContext)).toBe("motion.word-backward");
    expect(resolveKey("normal", "e", noteContext)).toBe("motion.word-end");
  });

  it("maps viewport and document motions with their Counts", () => {
    expect(resolveKey("normal", "Ctrl+f", noteContext)).toBe(
      "cursor.page-down",
    );
    expect(resolveKey("normal", "Ctrl+b", noteContext)).toBe("cursor.page-up");
    expect(resolveKey("normal", "Ctrl+d", noteContext)).toBe(
      "cursor.half-page-down",
    );
    expect(resolveKey("normal", "Ctrl+u", noteContext)).toBe(
      "cursor.half-page-up",
    );
    expect(resolveKey("normal", "G", noteContext)).toBe("cursor.document-end");
    expect(resolveKey("visual-line", "gg", noteContext)).toBe(
      "cursor.document-start",
    );
    expect(resolveKey("visual-line", "G", noteContext)).toBe(
      "cursor.document-end",
    );
    expect(resolveKey("visual-line", "Ctrl+f", noteContext)).toBe(
      "cursor.page-down",
    );
    expect(resolveKey("visual-line", "Ctrl+u", noteContext)).toBe(
      "cursor.half-page-up",
    );

    const g = advanceVimInput(
      createVimInputState(),
      "normal",
      "g",
      noteContext,
    );
    expect(advanceVimInput(g.state, "normal", "g", noteContext)).toMatchObject({
      resolvedCommand: "cursor.document-start",
      count: 1,
      countExplicit: false,
    });

    const three = advanceVimInput(
      createVimInputState(),
      "normal",
      "3",
      noteContext,
    );
    expect(
      advanceVimInput(three.state, "normal", "G", noteContext),
    ).toMatchObject({
      resolvedCommand: "cursor.document-end",
      count: 3,
      countExplicit: true,
    });
    const countedG = advanceVimInput(three.state, "normal", "g", noteContext);
    expect(
      advanceVimInput(countedG.state, "normal", "g", noteContext),
    ).toMatchObject({
      resolvedCommand: "cursor.document-start",
      count: 3,
      countExplicit: true,
    });
  });

  it("maps Internal Link and Window-local Jump List navigation", () => {
    const g = advanceVimInput(
      createVimInputState(),
      "normal",
      "g",
      noteContext,
    );
    expect(advanceVimInput(g.state, "normal", "f", noteContext)).toMatchObject({
      resolvedCommand: "navigation.follow-link",
      sequence: "gf",
    });
    expect(resolveKey("normal", "Ctrl+o", noteContext)).toBe(
      "navigation.jump-back",
    );
    expect(resolveKey("normal", "Ctrl+i", noteContext)).toBe(
      "navigation.jump-forward",
    );
    expect(resolveKey("insert", "Ctrl+o", noteContext)).toBeNull();
  });

  it("maps current-note search and counted repeats from Normal mode", () => {
    expect(resolveKey("normal", "/", noteContext)).toBe("note.search");
    expect(resolveKey("normal", "n", noteContext)).toBe("note.search_next");
    expect(resolveKey("normal", "N", noteContext)).toBe("note.search_previous");
    expect(resolveKey("insert", "/", noteContext)).toBeNull();
    expect(resolveKey("visual-char", "n", noteContext)).toBeNull();

    const three = advanceVimInput(
      createVimInputState(),
      "normal",
      "3",
      noteContext,
    );
    expect(
      advanceVimInput(three.state, "normal", "n", noteContext),
    ).toMatchObject({
      resolvedCommand: "note.search_next",
      count: 3,
      sequence: "3n",
    });
  });

  it("maps Section promote and demote in Normal, Insert and Visual Line", () => {
    const two = advanceVimInput(
      createVimInputState(),
      "normal",
      "2",
      noteContext,
    );
    const greater = advanceVimInput(two.state, "normal", ">", noteContext);
    expect(greater).toMatchObject({
      state: { pending: { kind: "prefix", key: ">", count: "2" } },
      action: { kind: "pending", detail: "pending:section-demote" },
    });
    expect(
      advanceVimInput(greater.state, "normal", ">", noteContext),
    ).toMatchObject({
      resolvedCommand: "section.demote",
      count: 2,
      sequence: "2>>",
    });

    const less = advanceVimInput(
      createVimInputState(),
      "normal",
      "<",
      noteContext,
    );
    expect(
      advanceVimInput(less.state, "normal", "<", noteContext),
    ).toMatchObject({ resolvedCommand: "section.promote", sequence: "<<" });
    expect(resolveKey("insert", "Ctrl+t", noteContext)).toBe("section.demote");
    expect(resolveKey("insert", "Ctrl+d", noteContext)).toBe("section.promote");
    expect(resolveKey("visual-line", ">", noteContext)).toBe("section.demote");
    expect(resolveKey("visual-line", "<", noteContext)).toBe("section.promote");
    expect(resolveKey("visual-char", ">", noteContext)).toBeNull();
  });

  it("maps Ctrl-w Window commands plus g TabPage commands from Normal mode", () => {
    const windowPrefix = advanceVimInput(
      createVimInputState(),
      "normal",
      "Ctrl+w",
      noteContext,
    );
    expect(windowPrefix).toMatchObject({
      state: { pending: { kind: "prefix", key: "Ctrl+w" } },
      action: { kind: "pending", detail: "pending:window" },
    });
    expect(
      advanceVimInput(windowPrefix.state, "normal", "v", noteContext),
    ).toMatchObject({
      sequence: "Ctrl+wv",
      resolvedCommand: "window.split-vertical",
    });
    for (const [key, command] of [
      ["s", "window.split-horizontal"],
      ["h", "window.focus-left"],
      ["j", "window.focus-down"],
      ["k", "window.focus-up"],
      ["l", "window.focus-right"],
      ["c", "window.close"],
      ["o", "window.only"],
    ] as const) {
      expect(
        advanceVimInput(windowPrefix.state, "normal", key, noteContext)
          .resolvedCommand,
      ).toBe(command);
    }
    expect(
      advanceVimInput(windowPrefix.state, "normal", "Ctrl+h", noteContext)
        .resolvedCommand,
    ).toBe("window.focus-left");
    expect(
      advanceVimInput(windowPrefix.state, "normal", "Ctrl+c", noteContext)
        .resolvedCommand,
    ).toBe("window.close");
    expect(
      advanceVimInput(windowPrefix.state, "normal", "Ctrl+o", noteContext)
        .resolvedCommand,
    ).toBe("window.only");
    expect(
      advanceVimInput(windowPrefix.state, "normal", "Ctrl+s", noteContext)
        .resolvedCommand,
    ).toBe("window.split-horizontal");
    expect(
      advanceVimInput(windowPrefix.state, "normal", "Ctrl+v", noteContext)
        .resolvedCommand,
    ).toBe("window.split-vertical");
    for (const key of ["Ctrl+h", "Ctrl+j", "Ctrl+k", "Ctrl+l"] as const) {
      for (const mode of [
        "normal",
        "insert",
        "replace",
        "visual-char",
        "visual-line",
      ] as const) {
        expect(resolveKey(mode, key, noteContext)).toBeNull();
      }
    }
    const g = advanceVimInput(
      createVimInputState(),
      "normal",
      "g",
      noteContext,
    );
    expect(advanceVimInput(g.state, "normal", "t", noteContext)).toMatchObject({
      resolvedCommand: "tab.next",
    });
    expect(advanceVimInput(g.state, "normal", "T", noteContext)).toMatchObject({
      resolvedCommand: "tab.previous",
    });
    expect(
      advanceVimInput(g.state, "normal", "Shift", noteContext),
    ).toMatchObject({
      state: g.state,
      action: { kind: "unmapped" },
    });
    const tab = advanceVimInput(
      createVimInputState(),
      "normal",
      "t",
      noteContext,
    );
    expect(tab).toMatchObject({
      state: { pending: { kind: "prefix", key: "t" } },
      action: { kind: "pending", detail: "pending:tab" },
    });
    for (const [key, command] of [
      ["c", "tab.create"],
      ["n", "tab.next"],
      ["p", "tab.previous"],
      ["d", "tab.close"],
      ["1", "tab.select-1"],
      ["9", "tab.select-9"],
      ["0", "tab.select-0"],
    ] as const) {
      expect(
        advanceVimInput(tab.state, "normal", key, noteContext),
      ).toMatchObject({ resolvedCommand: command });
    }
    expect(
      advanceVimInput(createVimInputState(), "insert", "Ctrl+w", noteContext)
        .resolvedCommand,
    ).toBeNull();
  });

  it("maps the default comma Leader to application commands", () => {
    const leader = advanceVimInput(
      createVimInputState(),
      "normal",
      ",",
      noteContext,
    );
    expect(leader).toMatchObject({
      state: { pending: { kind: "prefix", key: "leader" } },
      action: { kind: "pending", detail: "pending:leader" },
    });
    expect(
      advanceVimInput(leader.state, "normal", "f", noteContext),
    ).toMatchObject({
      sequence: ",f",
      resolvedCommand: "workspace.search_title",
      action: { kind: "execute", command: "workspace.search_title" },
    });
    const bodyLeader = advanceVimInput(
      createVimInputState(),
      "normal",
      ",",
      noteContext,
    );
    expect(
      advanceVimInput(bodyLeader.state, "normal", "g", noteContext),
    ).toMatchObject({
      sequence: ",g",
      resolvedCommand: "workspace.search_body",
      action: { kind: "execute", command: "workspace.search_body" },
    });
    for (const [key, command] of [
      ["a", "context.action_picker"],
      ["t", "utility.toggle-tree"],
      ["o", "utility.toggle-outline"],
      ["b", "workspace.search_buffers"],
      ["c", "application.command_picker"],
      ["s", "note.search"],
    ] as const) {
      const utilityLeader = advanceVimInput(
        createVimInputState(),
        "normal",
        ",",
        noteContext,
      );
      expect(
        advanceVimInput(utilityLeader.state, "normal", key, noteContext),
      ).toMatchObject({
        sequence: `,${key}`,
        resolvedCommand: command,
        action: { kind: "execute", command },
      });
    }
    expect(
      advanceVimInput(createVimInputState(), "insert", ",", noteContext)
        .resolvedCommand,
    ).toBeNull();
    const visualLeader = advanceVimInput(
      createVimInputState(),
      "visual-char",
      ",",
      noteContext,
    );
    expect(
      advanceVimInput(visualLeader.state, "visual-char", "y", noteContext),
    ).toMatchObject({
      action: {
        kind: "leader-shortcut",
        resolution: { kind: "reserved", shortcut: { id: "yank" } },
      },
    });
    const unknownLeader = advanceVimInput(
      createVimInputState(),
      "normal",
      ",",
      noteContext,
    );
    expect(
      advanceVimInput(unknownLeader.state, "normal", "x", noteContext),
    ).toMatchObject({
      action: {
        kind: "leader-shortcut",
        resolution: { kind: "unmapped", key: "x" },
      },
    });
    expect(
      advanceVimInput(createVimInputState(), "normal", " ", noteContext),
    ).toMatchObject({ action: { kind: "unmapped" } });
  });

  it("resolves the semantic Leader through an injected key setting", () => {
    const config = { leaderKey: ";" } as const;
    const leader = advanceVimInput(
      createVimInputState(),
      "normal",
      ";",
      noteContext,
      config,
    );
    expect(
      advanceVimInput(leader.state, "normal", "o", noteContext, config),
    ).toMatchObject({
      sequence: ";o",
      resolvedCommand: "utility.toggle-outline",
    });
    expect(
      advanceVimInput(createVimInputState(), "normal", "g", noteContext, {
        leaderKey: "g",
      }),
    ).toMatchObject({
      state: { pending: { kind: "prefix", key: "leader" } },
    });
  });

  it("opens the Application Command-line only from Normal mode", () => {
    expect(resolveKey("normal", ":", noteContext)).toBe(
      "application.command_line",
    );
    expect(resolveKey("insert", ":", noteContext)).toBeNull();
  });

  it("maps Vim line-oriented Insert entry commands", () => {
    expect(resolveKey("normal", "I", noteContext)).toBe("insert.line-start");
    expect(resolveKey("normal", "A", noteContext)).toBe("insert.line-end");
    expect(resolveKey("normal", "o", noteContext)).toBe("line.open-below");
    expect(resolveKey("normal", "O", noteContext)).toBe("line.open-above");
  });

  it("maps D, C, S, J, gJ, x, and Replace mode", () => {
    expect(resolveKey("normal", "D", noteContext)).toBe("line.delete-to-end");
    expect(resolveKey("normal", "C", noteContext)).toBe("line.change-to-end");
    expect(resolveKey("normal", "S", noteContext)).toBe("line.change");
    expect(resolveKey("normal", "J", noteContext)).toBe("line.join");
    expect(resolveKey("normal", "gJ", noteContext)).toBe("line.join-raw");
    expect(resolveKey("normal", "x", noteContext)).toBe("character.delete");
    expect(resolveKey("normal", "R", noteContext)).toBe("mode.replace");
    expect(resolveKey("replace", "Escape", noteContext)).toBe("mode.normal");

    const prefix = advanceVimInput(
      createVimInputState(),
      "normal",
      "g",
      noteContext,
    );
    expect(
      advanceVimInput(prefix.state, "normal", "J", noteContext),
    ).toMatchObject({
      state: { pending: null },
      resolvedCommand: "line.join-raw",
      action: { kind: "execute", command: "line.join-raw" },
    });
  });

  it("maps semantic dot repeat in Normal mode only", () => {
    expect(resolveKey("normal", ".", noteContext)).toBe("edit.repeat");
    expect(resolveKey("insert", ".", noteContext)).toBeNull();
    expect(resolveKey("visual-char", ".", noteContext)).toBeNull();
  });

  it("keeps r pending until one replacement character arrives", () => {
    const pending = advanceVimInput(
      createVimInputState(),
      "normal",
      "r",
      noteContext,
    );
    expect(pending).toMatchObject({
      state: { pending: { kind: "replace-character", key: "r" } },
      action: { kind: "pending", detail: "pending:replace-character" },
    });
    expect(
      advanceVimInput(pending.state, "normal", "語", noteContext),
    ).toMatchObject({
      state: { pending: null },
      resolvedCommand: "replace.character",
      argument: "語",
      action: {
        kind: "execute",
        command: "replace.character",
        argument: "語",
      },
    });
  });

  it.each([
    ["d", "delete", "w", "motion.word-forward"],
    ["y", "yank", "e", "motion.word-end"],
    ["c", "change", "$", "motion.line-end"],
    ["d", "delete", "j", "cursor.logical-down"],
    ["y", "yank", "k", "cursor.logical-up"],
    ["c", "change", "j", "cursor.logical-down"],
  ] as const)(
    "resolves %s (%s) + %s as %s",
    (operatorKey, operator, motionKey, command) => {
      const pending = advanceVimInput(
        createVimInputState(),
        "normal",
        operatorKey,
        noteContext,
      );
      expect(
        advanceVimInput(pending.state, "normal", motionKey, noteContext),
      ).toMatchObject({
        state: { pending: null },
        operator,
        resolvedCommand: command,
        action: { kind: "execute", command },
      });
    },
  );

  it.each([
    ["d", "delete", "i", "w", "text-object.inner-word"],
    ["c", "change", "a", "w", "text-object.around-word"],
    ["y", "yank", "i", "p", "text-object.inner-paragraph"],
    ["d", "delete", "a", "p", "text-object.around-paragraph"],
  ] as const)(
    "resolves %s (%s) + %s%s as %s",
    (operatorKey, operator, prefix, objectKey, command) => {
      const operatorPending = advanceVimInput(
        createVimInputState(),
        "normal",
        operatorKey,
        noteContext,
      );
      const objectPending = advanceVimInput(
        operatorPending.state,
        "normal",
        prefix,
        noteContext,
      );
      expect(objectPending).toMatchObject({
        operator: null,
        resolvedCommand: null,
        action: {
          kind: "pending",
          detail:
            prefix === "i"
              ? "pending:text-object-inner"
              : "pending:text-object-around",
        },
      });
      expect(
        advanceVimInput(objectPending.state, "normal", objectKey, noteContext),
      ).toMatchObject({
        state: { pending: null },
        operator,
        resolvedCommand: command,
        action: { kind: "execute", command },
      });
    },
  );

  it("keeps structural operators out of non-note targets", () => {
    const sidebarContext = {
      isComposing: false,
      targetKind: "sidebar" as const,
    };
    const pending = advanceVimInput(
      createVimInputState(),
      "normal",
      "d",
      sidebarContext,
    );
    expect(
      advanceVimInput(pending.state, "normal", "w", sidebarContext),
    ).toMatchObject({
      operator: null,
      resolvedCommand: null,
      state: { pending: null },
      action: { kind: "unmapped" },
    });
    expect(resolveKey("normal", "cc", sidebarContext)).toBeNull();
    expect(resolveKey("normal", "yy", sidebarContext)).toBeNull();
    expect(resolveKey("normal", "o", sidebarContext)).toBeNull();
    expect(resolveKey("normal", "O", sidebarContext)).toBeNull();
    expect(resolveKey("normal", "x", sidebarContext)).toBeNull();

    const textObjectPending = advanceVimInput(
      pending.state,
      "normal",
      "i",
      sidebarContext,
    );
    expect(textObjectPending).toMatchObject({
      operator: null,
      resolvedCommand: null,
      state: { pending: null },
      action: { kind: "unmapped" },
    });
    expect(
      advanceVimInput(textObjectPending.state, "normal", "w", sidebarContext),
    ).toMatchObject({
      operator: null,
      resolvedCommand: "motion.word-forward",
      state: { pending: null },
      action: { kind: "execute", command: "motion.word-forward" },
    });
  });
});
