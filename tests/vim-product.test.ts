import type { Editor } from "@tiptap/core";
import type { UndoManager } from "yjs";
import { describe, expect, it, vi } from "vitest";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  clampVimBlockCursor,
  visualCharCursor,
} from "../app/src/vim/editor-commands";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_795_435_200_000 + seed, (target) => {
      target.fill((seed * 29) & 0xff);
      return target;
    });
  };
}

function press(
  editor: Editor,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function composition(
  editor: Editor,
  type: "compositionstart" | "compositionend",
) {
  editor.view.dom.dispatchEvent(
    new CompositionEvent(type, {
      bubbles: true,
      cancelable: true,
      data: "",
    }),
  );
}

function beforeInput(
  editor: Editor,
  data: string,
  inputType = "insertText",
): InputEvent {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function textPosition(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.isText && node.text?.includes(text)) {
      result = position + (node.text?.indexOf(text) ?? 0);
    }
  });
  if (result < 0) throw new Error(`Text not found: ${text}`);
  return result;
}

function editorUndoManager(editor: Editor): UndoManager {
  for (const plugin of editor.state.plugins) {
    const pluginState = plugin.getState(editor.state) as
      { undoManager?: UndoManager } | undefined;
    if (pluginState?.undoManager) return pluginState.undoManager;
  }
  throw new Error("Yjs UndoManager not found");
}

function renderedRelativeLineNumbers(root: HTMLElement) {
  return [
    ...root.querySelectorAll<HTMLElement>(".memoka-logical-line-number"),
  ].map((marker) => ({
    absolute: Number(marker.dataset.logicalLineNumber),
    relative: Number(marker.dataset.relativeLineNumber),
    display: Number(marker.dataset.displayLineNumber),
    current: marker.classList.contains("memoka-logical-line-number--current"),
    kind: marker.dataset.logicalLineKind,
  }));
}

function selectionAncestorBlockId(
  editor: Editor,
  nodeName: string,
): string | null {
  return ancestorBlockIdAt(editor, editor.state.selection.from, nodeName);
}

function ancestorBlockIdAt(
  editor: Editor,
  position: number,
  nodeName: string,
): string | null {
  const $position = editor.state.doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name === nodeName) {
      return typeof node.attrs.blockId === "string" ? node.attrs.blockId : null;
    }
  }
  return null;
}

describe("Memoka keyboard-only Vim golden scenario", () => {
  it("renders relative logical line numbers independently in each window", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "alpha" },
            { type: "hardBreak" },
            { type: "text", text: "beta" },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "one\ntwo" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "list item" }],
                },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "table cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "image",
          attrs: {
            src: "https://example.invalid/line-number.png",
            alt: "image block",
          },
        },
      ],
    });
    await runtime.flush();

    first.editor.commands.setTextSelection(textPosition(first.editor, "two"));
    second.editor.commands.setTextSelection(
      textPosition(second.editor, "alpha"),
    );
    press(first.editor, "Escape");

    await vi.waitFor(() => {
      expect(renderedRelativeLineNumbers(firstRoot)).toEqual([
        {
          absolute: 1,
          relative: 3,
          display: 3,
          current: false,
          kind: "text-block",
        },
        {
          absolute: 2,
          relative: 2,
          display: 2,
          current: false,
          kind: "text-block",
        },
        {
          absolute: 3,
          relative: 1,
          display: 1,
          current: false,
          kind: "code-line",
        },
        {
          absolute: 4,
          relative: 0,
          display: 4,
          current: true,
          kind: "code-line",
        },
        {
          absolute: 5,
          relative: 1,
          display: 1,
          current: false,
          kind: "text-block",
        },
        {
          absolute: 6,
          relative: 2,
          display: 2,
          current: false,
          kind: "text-block",
        },
        {
          absolute: 7,
          relative: 3,
          display: 3,
          current: false,
          kind: "block-atom",
        },
      ]);
    });
    expect(
      renderedRelativeLineNumbers(secondRoot).map(({ display }) => display),
    ).toEqual([1, 1, 2, 3, 4, 5, 6]);
    expect(firstRoot.querySelector(".memoka-logical-line-gutter")).not.toBe(
      null,
    );
    expect(
      firstRoot
        .querySelector(".memoka-editor")
        ?.querySelector(".memoka-logical-line-number"),
    ).toBeNull();

    press(first.editor, "j");
    await vi.waitFor(() => {
      expect(
        renderedRelativeLineNumbers(firstRoot).map(({ display }) => display),
      ).toEqual([4, 3, 2, 1, 5, 1, 2]);
    });
    expect(
      renderedRelativeLineNumbers(secondRoot).map(({ display }) => display),
    ).toEqual([1, 1, 2, 3, 4, 5, 6]);
    expect(first.editor.view.dom.textContent).toBe(
      first.editor.state.doc.textContent,
    );

    let imagePosition = -1;
    first.editor.state.doc.descendants((node, position) => {
      if (node.type.name === "image") imagePosition = position;
    });
    expect(imagePosition).toBeGreaterThanOrEqual(0);
    first.editor.commands.setNodeSelection(imagePosition);
    await vi.waitFor(() => {
      expect(
        renderedRelativeLineNumbers(firstRoot).map(({ display }) => display),
      ).toEqual([6, 5, 4, 3, 2, 1, 7]);
    });

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("puts the Normal block cursor on the character before the Insert caret", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "abcd" }],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "one\ntwo\n\nthree" }],
        },
      ],
    });
    editor.commands.focus();
    await runtime.flush();

    const paragraphStart = textPosition(editor, "abcd");
    editor.commands.setTextSelection(paragraphStart + 2);
    press(editor, "Escape");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(editor.state.selection.from).toBe(paragraphStart + 1);

    const exitInsertAt = (insertPosition: number) => {
      press(editor, "i");
      expect(adapter.vimSnapshot.mode).toBe("insert");
      editor.commands.setTextSelection(insertPosition);
      press(editor, "Escape");
      expect(adapter.vimSnapshot.mode).toBe("normal");
      return editor.state.selection.from;
    };

    expect(exitInsertAt(paragraphStart)).toBe(paragraphStart);
    expect(exitInsertAt(paragraphStart + "abcd".length)).toBe(
      paragraphStart + "abcd".length - 1,
    );

    const codeStart = textPosition(editor, "one");
    const secondLineStart = textPosition(editor, "two");
    const emptyLineStart = codeStart + "one\ntwo\n".length;
    expect(exitInsertAt(secondLineStart)).toBe(secondLineStart);
    expect(exitInsertAt(secondLineStart + 2)).toBe(secondLineStart + 1);
    expect(exitInsertAt(emptyLineStart)).toBe(emptyLineStart);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("hides the custom caret while its Window focus surface is inactive", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-10T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const caret = await vi.waitFor(() => {
      const candidate = [
        ...document.querySelectorAll<HTMLElement>(".memoka-vim-caret"),
      ].find((element) => element.style.display === "block");
      if (!candidate) throw new Error("Focused Window caret did not render");
      return candidate;
    });

    adapter.setFocusSurfaceActive(false);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(caret.style.display).toBe("none");

    const originalCoordsAtPos = editor.view.coordsAtPos.bind(editor.view);
    let geometryReady = false;
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation(
      (position, side) => {
        if (!geometryReady) throw new Error("selection geometry is not ready");
        return originalCoordsAtPos(position, side);
      },
    );
    window.setTimeout(() => {
      geometryReady = true;
    }, 20);
    adapter.setFocusSurfaceActive(true);
    await vi.waitFor(() => expect(caret.style.display).toBe("block"));

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps the first pending caret frame during rapid editor updates", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-12T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "rapid caret" }],
        },
      ],
    });
    editor.commands.focus();
    const cursor = textPosition(editor, "rapid caret");
    editor.commands.setTextSelection(cursor);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    await runtime.flush();

    const pendingFrames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameId += 1;
        pendingFrames.set(frameId, callback);
        return frameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        pendingFrames.delete(id);
      });

    try {
      editor.commands.insertContent("a");
      editor.commands.insertContent("b");
      editor.commands.insertContent("c");

      // Caret, gutter and selection persistence each keep their first frame;
      // the dormant Visual-line overlay schedules no work in Insert mode.
      expect(cancelFrame).not.toHaveBeenCalled();
      expect(requestFrame.mock.calls.length).toBeLessThanOrEqual(3);

      const queued = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of queued) callback(performance.now());
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("keeps logical-line gutter rendering stable during same-line typing", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-12T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: Array.from({ length: 200 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `logical line ${index}` }],
      })),
    });
    editor.commands.focus();
    editor.commands.setTextSelection(textPosition(editor, "logical line 199"));
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );

    const anchors = vi.spyOn(defaultVimBlockSemantics, "logicalLineAnchors");
    const gutter = root.querySelector<HTMLElement>(
      ".memoka-logical-line-gutter",
    );
    if (!gutter) throw new Error("Logical-line gutter was not mounted");
    const replaceChildren = vi.spyOn(gutter, "replaceChildren");
    try {
      editor.commands.insertContent("a");
      editor.commands.insertContent("b");
      editor.commands.insertContent("c");
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );

      // Same-block text edits are patched locally; the full document anchor
      // traversal is no longer needed at all during the burst.
      expect(anchors).not.toHaveBeenCalled();
      // The current logical line did not change, so measuring and recreating
      // every visible marker would be pure layout work.
      expect(replaceChildren).not.toHaveBeenCalled();
    } finally {
      anchors.mockRestore();
      replaceChildren.mockRestore();
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("keeps modes window-local and gives composition ownership of its keys", async () => {
    const persistence = new MemoryPersistencePort();
    const ids = deterministicIds();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const imeOff = deferred<{
      supported: boolean;
      inactive: boolean;
      detail: string;
    }>();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      requestImeOff: () => imeOff.promise,
    });
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.focus();

    expect(first.adapter.vimSnapshot.mode).toBe("insert");
    expect(second.adapter.vimSnapshot.mode).toBe("insert");
    expect(press(first.editor, "Escape").defaultPrevented).toBe(true);
    expect(first.adapter.vimSnapshot.mode).toBe("normal");
    expect(second.adapter.vimSnapshot.mode).toBe("insert");
    expect(first.adapter.vimSnapshot.imeOff).toBe("requesting");
    expect(second.adapter.vimSnapshot.imeOff).toBe("idle");
    imeOff.resolve({
      supported: true,
      inactive: true,
      detail: "fcitx5-inactive",
    });
    await vi.waitFor(() => {
      expect(first.adapter.vimSnapshot).toMatchObject({
        imeOff: "inactive",
        imeOffDetail: "fcitx5-inactive",
      });
    });

    composition(first.editor, "compositionstart");
    expect(
      press(first.editor, "i", { isComposing: true }).defaultPrevented,
    ).toBe(false);
    expect(first.adapter.vimSnapshot.mode).toBe("normal");
    composition(first.editor, "compositionend");
    const insert = press(first.editor, "i");
    expect({
      defaultPrevented: insert.defaultPrevented,
      ...first.adapter.vimSnapshot,
    }).toMatchObject({
      defaultPrevented: true,
      mode: "insert",
      composing: false,
    });

    const tab = press(first.editor, "Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(first.editor.isFocused).toBe(true);
    press(first.editor, "Escape");

    await runtime.flush();
    expect(runtime.windows.get("window-1")?.mode).toBe("normal");
    expect(runtime.windows.get("window-2")?.mode).toBe("insert");
    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: ids,
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const reopenedFirstRoot = document.createElement("div");
    const reopenedSecondRoot = document.createElement("div");
    document.body.append(reopenedFirstRoot, reopenedSecondRoot);
    const reopenedFirst = reopened.editorForTesting(
      "window-1",
      reopenedFirstRoot,
    );
    const reopenedSecond = reopened.editorForTesting(
      "window-2",
      reopenedSecondRoot,
    );
    expect(reopenedFirst.adapter.vimSnapshot.mode).toBe("normal");
    expect(reopenedSecond.adapter.vimSnapshot.mode).toBe("insert");
    reopenedFirst.adapter.destroy();
    reopenedSecond.adapter.destroy();
    reopened.destroy();
  });

  it.each([
    [
      "unsupported adapter",
      {
        supported: false,
        inactive: false,
        detail: "platform-adapter-not-implemented",
      },
      "unsupported",
    ],
    [
      "failed adapter",
      {
        supported: true,
        inactive: false,
        detail: "fcitx5-remote-exit:7",
      },
      "failed",
    ],
  ] as const)(
    "reports an %s result without changing the Normal transition",
    async (_label, result, expectedStatus) => {
      const runtime = await CoreRuntime.open(new MemoryPersistencePort());
      const root = document.createElement("div");
      document.body.append(root);
      const { adapter, editor } = runtime.editorForTesting("window-1", root, {
        requestImeOff: () => Promise.resolve(result),
      });
      editor.commands.focus();

      press(editor, "Escape");
      expect(adapter.vimSnapshot.mode).toBe("normal");
      expect(adapter.vimSnapshot.imeOff).toBe("requesting");
      await vi.waitFor(() => {
        expect(adapter.vimSnapshot).toMatchObject({
          imeOff: expectedStatus,
          imeOffDetail: result.detail,
        });
      });
      await runtime.flush();

      adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  );

  it("keeps the newest IME OFF result when requests settle out of order", async () => {
    const first = deferred<{
      supported: boolean;
      inactive: boolean;
      detail: string;
    }>();
    const second = deferred<{
      supported: boolean;
      inactive: boolean;
      detail: string;
    }>();
    const requestImeOff = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      requestImeOff,
    });
    editor.commands.focus();

    press(editor, "Escape");
    press(editor, "i");
    press(editor, "Escape");
    expect(requestImeOff).toHaveBeenCalledTimes(2);
    second.resolve({
      supported: true,
      inactive: false,
      detail: "newer-failure",
    });
    await vi.waitFor(() => {
      expect(adapter.vimSnapshot).toMatchObject({
        imeOff: "failed",
        imeOffDetail: "newer-failure",
      });
    });
    first.resolve({
      supported: true,
      inactive: true,
      detail: "stale-success",
    });
    await Promise.resolve();
    expect(adapter.vimSnapshot).toMatchObject({
      imeOff: "failed",
      imeOffDetail: "newer-failure",
    });
    await runtime.flush();

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("reports a rejected IME OFF request without leaving Normal mode", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      requestImeOff: () => Promise.reject(new Error("bridge unavailable")),
    });
    editor.commands.focus();

    press(editor, "Escape");
    await vi.waitFor(() => {
      expect(adapter.vimSnapshot).toMatchObject({
        mode: "normal",
        imeOff: "failed",
        imeOffDetail: "error:Error: bridge unavailable",
      });
    });
    await runtime.flush();

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("runs v, yank, P and undo as a persisted editor transaction", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);

    first.editor.commands.insertContentAt(1, "abc");
    first.editor.commands.setTextSelection(4);
    first.editor.commands.focus();
    await runtime.flush();
    press(first.editor, "Escape");
    press(first.editor, "v");
    press(first.editor, "y");
    expect(first.adapter.vimSnapshot).toMatchObject({
      mode: "normal",
      register: "text: c",
    });

    press(first.editor, "P");
    await runtime.flush();
    expect(first.editor.getText()).toBe("abcc");
    expect(second.editor.getText()).toBe("abcc");
    expect(first.editor.state.selection.from).toBe(3);

    press(first.editor, "u");
    await runtime.flush();
    expect(first.editor.getText()).toBe("abc");
    expect(second.editor.getText()).toBe("abc");
    expect(first.editor.state.selection.from).toBe(3);

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
  });

  it("shares the unnamed register across Workspace windows", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);

    first.editor.commands.insertContentAt(1, "abc");
    first.editor.commands.setTextSelection(4);
    first.editor.commands.focus();
    await runtime.flush();
    press(first.editor, "Escape");
    press(first.editor, "v");
    press(first.editor, "y");

    expect(first.adapter.vimSnapshot.register).toBe("text: c");
    expect(second.adapter.vimSnapshot.register).toBe("text: c");

    second.editor.commands.setTextSelection(1);
    second.editor.commands.focus();
    press(second.editor, "Escape");
    press(second.editor, "P");
    await runtime.flush();

    expect(first.editor.getText()).toBe("cabc");
    expect(second.editor.getText()).toBe("cabc");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("shares a structural register across Windows with fresh identities", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: ["one", "two"].map((text) => ({
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text }],
              },
            ],
          })),
        },
      ],
    });
    await runtime.flush();
    const sourceId = first.editor.state.doc.firstChild?.child(0).attrs.blockId;

    first.editor.commands.focus();
    press(first.editor, "Escape");
    first.editor.commands.setTextSelection(textPosition(first.editor, "one"));
    press(first.editor, "V");
    press(first.editor, "y");
    expect(second.adapter.vimSnapshot.register).toContain("ListItem");

    second.editor.commands.focus();
    press(second.editor, "Escape");
    second.editor.commands.setTextSelection(textPosition(second.editor, "two"));
    const undoManager = editorUndoManager(second.editor);
    undoManager.clear();
    undoManager.stopCapturing();
    press(second.editor, "p");
    await runtime.flush();

    for (const editor of [first.editor, second.editor]) {
      const list = editor.state.doc.firstChild;
      expect(
        Array.from(
          { length: list?.childCount ?? 0 },
          (_, index) => list?.child(index).textContent,
        ),
      ).toEqual(["one", "two", "one"]);
      expect(list?.child(2).attrs.blockId).not.toBe(sourceId);
    }
    expect(undoManager.undoStack).toHaveLength(1);
    press(second.editor, "u");
    await runtime.flush();
    expect(first.editor.state.doc.firstChild?.childCount).toBe(2);

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("keeps dot-repeat Window-local across an editor adapter remount", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent("<p>abc</p>");
    first.editor.commands.focus();
    press(first.editor, "Escape");
    first.editor.commands.setTextSelection(
      textPosition(first.editor, "abc") + 1,
    );
    press(first.editor, "r");
    press(first.editor, "X");
    await runtime.flush();
    expect(first.editor.getText()).toBe("aXc");

    second.editor.commands.focus();
    press(second.editor, "Escape");
    second.editor.commands.setTextSelection(textPosition(second.editor, "c"));
    press(second.editor, ".");
    expect(second.adapter.vimSnapshot.action).toBe("repeat:empty");
    expect(second.editor.getText()).toBe("aXc");

    first.adapter.destroy();
    const remounted = runtime.editorForTesting("window-1", firstRoot);
    remounted.editor.commands.focus();
    remounted.editor.commands.setTextSelection(
      textPosition(remounted.editor, "c"),
    );
    press(remounted.editor, ".");
    await runtime.flush();
    expect(remounted.editor.getText()).toBe("aXX");
    expect(remounted.adapter.vimSnapshot.action).toBe(
      "repeat:replace:character:changed",
    );

    remounted.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("moves left on the first Visual-char h and keeps the initial character selected", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);

    editor.commands.insertContentAt(1, "abc");
    const initialCursor = textPosition(editor, "abc") + 1;
    editor.commands.setTextSelection(initialCursor + 1);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "v");
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("b");

    press(editor, "h");
    expect(adapter.vimSnapshot.action).toBe("cursor:left:changed");
    expect(editor.state.selection.head).toBe(initialCursor - 1);
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("ab");

    press(editor, "l");
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("b");
    press(editor, "h");
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("ab");

    press(editor, "y");
    expect(adapter.vimSnapshot).toMatchObject({
      mode: "normal",
      register: "text: ab",
    });
    expect(editor.state.selection.from).toBe(initialCursor - 1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("composes d/y/c with word and line motions", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.insertContentAt(1, "alpha beta gamma");
    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    press(editor, "w");
    expect(editor.state.selection.from).toBe(textPosition(editor, "beta"));
    press(editor, "b");
    expect(editor.state.selection.from).toBe(textPosition(editor, "alpha"));
    press(editor, "e");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "alpha") + "alpha".length - 1,
    );
    press(editor, "0");
    expect(editor.state.selection.from).toBe(textPosition(editor, "alpha"));
    press(editor, "$");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "gamma") + "gamma".length - 1,
    );

    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    press(editor, "d");
    expect(adapter.vimSnapshot.action).toBe("pending:delete");
    press(editor, "w");
    await runtime.flush();
    expect(editor.getText()).toBe("beta gamma");
    expect(adapter.vimSnapshot.register).toBe("text: alpha");

    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta gamma");

    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    press(editor, "y");
    press(editor, "w");
    expect(editor.getText()).toBe("alpha beta gamma");
    expect(adapter.vimSnapshot.register).toBe("text: alpha");

    editor.commands.setTextSelection(textPosition(editor, "beta"));
    press(editor, "y");
    press(editor, "Shift", { shiftKey: true, code: "ShiftLeft" });
    press(editor, "$", { shiftKey: true, code: "Digit4" });
    expect(editor.getText()).toBe("alpha beta gamma");
    expect(adapter.vimSnapshot.action).toBe(
      "operator:yank:motion.line-end:changed",
    );
    expect(adapter.vimSnapshot.register).toBe("text: beta gamma");

    editor.commands.setTextSelection(
      textPosition(editor, "gamma") + "gamma".length - 1,
    );
    press(editor, "y");
    press(editor, "Shift", { shiftKey: true, code: "ShiftLeft" });
    press(editor, "$", { shiftKey: true, code: "Digit4" });
    expect(adapter.vimSnapshot.register).toBe("text: a");

    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    press(editor, "c");
    expect(adapter.vimSnapshot.action).toBe("pending:change");
    press(editor, "w");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.getText()).toBe("beta gamma");
    editor.commands.insertContent("delta ");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("delta beta gamma");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta gamma");

    adapter.destroy();
    runtime.destroy();
  });

  it("multiplies counts before and after an Operator into one edit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const words = "one two three four five six seven";
    editor.commands.setContent(`<p>${words}</p>`);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    const countedDelete = async (keys: string, expected: string) => {
      editor.commands.setContent(`<p>${words}</p>`);
      await runtime.flush();
      undoManager.clear();
      undoManager.stopCapturing();
      editor.commands.setTextSelection(textPosition(editor, "one"));
      for (const key of keys) press(editor, key);
      await runtime.flush();
      expect(editor.getText()).toBe(expected);
      expect(undoManager.undoStack).toHaveLength(1);
      press(editor, "u");
      await runtime.flush();
      expect(editor.getText()).toBe(words);
    };

    await countedDelete("2dw", "three four five six seven");
    await countedDelete("d2w", "three four five six seven");
    await countedDelete("2d3w", "seven");

    editor.commands.setContent(`<p>${words}</p>`);
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "c2w") press(editor, key);
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.getText()).toBe("three four five six seven");
    editor.commands.insertContent("replacement ");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("replacement three four five six seven");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe(words);

    editor.commands.setContent({
      type: "doc",
      content: ["one", "two", "three", "four"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "d2$") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(4);
    expect(adapter.vimSnapshot.action).toContain("count:2:boundary");
    expect(undoManager.undoStack).toHaveLength(0);

    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "d2j") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe("four");
    expect(adapter.vimSnapshot.register).toBe("block: one two three");
    expect(undoManager.undoStack).toHaveLength(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("applies counts to character, logical-line, word, and Visual motions", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: ["one two three four five", "second", "third", "fourth"].map(
        (text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        }),
      ),
    });
    editor.commands.setTextSelection(textPosition(editor, "one"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    press(editor, "3");
    expect(adapter.vimSnapshot.action).toBe("pending:count:3");
    press(editor, "w");
    expect(editor.state.selection.from).toBe(textPosition(editor, "four"));
    expect(adapter.vimSnapshot.action).toBe(
      "motion:word-forward:count:3:changed",
    );

    press(editor, "2");
    press(editor, "b");
    expect(editor.state.selection.from).toBe(textPosition(editor, "two"));

    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "4");
    press(editor, "l");
    expect(editor.state.selection.from).toBe(textPosition(editor, "two"));

    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "2");
    press(editor, "j");
    expect(editor.state.selection.from).toBe(textPosition(editor, "third"));
    press(editor, "9");
    press(editor, "k");
    expect(editor.state.selection.from).toBe(textPosition(editor, "one"));

    press(editor, "2");
    press(editor, "$");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "second") + "second".length - 1,
    );

    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "v");
    press(editor, "3");
    press(editor, "l");
    expect(adapter.vimSnapshot.mode).toBe("visual-char");
    expect(visualCharCursor(editor.view)).toBe(textPosition(editor, "one") + 3);
    expect(
      root.querySelector(".memoka-visual-char-selected")?.textContent,
    ).toBe("one ");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("uses Hard Break lines for j/k and wrapped display rows only for gj/gk", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "abcdefghijklmnop" },
            { type: "hardBreak" },
            { type: "text", text: "qrstuvwxyz" },
          ],
        },
      ],
    });
    const paragraphStart = textPosition(editor, "abcdefghijklmnop");
    const secondLogicalLine = textPosition(editor, "qrstuvwxyz");
    const previousRow = paragraphStart + 1;
    const currentRow = paragraphStart + 4;
    const currentRowStart = paragraphStart + 3;
    const currentRowEnd = paragraphStart + 5;
    const nextRow = paragraphStart + 7;
    editor.commands.setTextSelection(currentRow);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    editor.commands.setTextSelection(currentRow);

    const coordinates = vi
      .spyOn(editor.view, "coordsAtPos")
      .mockImplementation((position) => {
        const top =
          position === previousRow ? 70 : position === nextRow ? 130 : 100;
        return {
          bottom: top + 20,
          left: 80,
          right: 88,
          top,
        };
      });
    const positions = vi
      .spyOn(editor.view, "posAtCoords")
      .mockImplementation(({ left, top }) => {
        if (left < 84) {
          return {
            inside: 0,
            pos: top < 100 ? currentRowStart : currentRowEnd,
          };
        }
        return {
          inside: 0,
          pos: top < 100 ? previousRow : nextRow,
        };
      });

    press(editor, "j");
    expect(editor.state.selection.from).toBe(secondLogicalLine + 4);

    press(editor, "k");
    expect(editor.state.selection.from).toBe(currentRow);

    editor.commands.setTextSelection(secondLogicalLine + 4);
    press(editor, "0");
    expect(editor.state.selection.from).toBe(secondLogicalLine);
    press(editor, "$");
    expect(editor.state.selection.from).toBe(
      secondLogicalLine + "qrstuvwxyz".length - 1,
    );

    positions.mockClear();
    editor.commands.setTextSelection(currentRow);
    press(editor, "g");
    press(editor, "j");
    expect(positions.mock.calls[0]?.[0].left).toBe(84);
    expect(editor.state.selection.from).toBe(nextRow);

    editor.commands.setTextSelection(currentRow);
    press(editor, "g");
    press(editor, "k");
    expect(editor.state.selection.from).toBe(previousRow);

    positions.mockRestore();
    coordinates.mockRestore();
    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves by full and half editor viewports with Ctrl-f/b/d/u", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    const scroll = document.createElement("div");
    scroll.className = "editor-scroll";
    const root = document.createElement("div");
    scroll.append(root);
    document.body.append(scroll);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const lineTexts = Array.from(
      { length: 30 },
      (_, index) => `viewport-line-${index + 1}`,
    );
    editor.commands.setContent({
      type: "doc",
      content: lineTexts.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    await runtime.flush();
    const positions = lineTexts.map((text) => textPosition(editor, text));
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(400, Number(value)));
        },
      },
    });
    const viewportRect = vi
      .spyOn(scroll, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 600, 200));
    const rowIndexAt = (position: number) => {
      let result = 0;
      for (let index = 0; index < positions.length; index += 1) {
        if ((positions[index] ?? Number.POSITIVE_INFINITY) > position) break;
        result = index;
      }
      return result;
    };
    const coordinates = vi
      .spyOn(editor.view, "coordsAtPos")
      .mockImplementation((position) => {
        const top = rowIndexAt(position) * 20 - scrollTop;
        return { bottom: top + 20, left: 80, right: 88, top };
      });
    const positionsAtCoordinates = vi
      .spyOn(editor.view, "posAtCoords")
      .mockImplementation(({ top }) => {
        const index = Math.max(
          0,
          Math.min(
            positions.length - 1,
            Math.round((top + scrollTop - 10) / 20),
          ),
        );
        return { inside: 0, pos: positions[index] as number };
      });
    const control = (key: "b" | "d" | "f" | "u") => {
      press(editor, "Control", { ctrlKey: true, code: "ControlLeft" });
      press(editor, key, { ctrlKey: true, code: `Key${key.toUpperCase()}` });
    };

    editor.commands.setTextSelection(positions[2] as number);
    editor.commands.focus();
    press(editor, "Escape");
    control("f");
    expect(scrollTop).toBe(160);
    expect(editor.state.selection.from).toBe(positions[10]);
    expect(adapter.vimSnapshot.action).toBe("cursor:page-down:changed");

    control("u");
    expect(scrollTop).toBe(60);
    expect(editor.state.selection.from).toBe(positions[5]);
    expect(adapter.vimSnapshot.action).toBe("cursor:half-page-up:changed");

    control("d");
    expect(scrollTop).toBe(160);
    expect(editor.state.selection.from).toBe(positions[10]);

    control("b");
    expect(scrollTop).toBe(0);
    expect(editor.state.selection.from).toBe(positions[2]);

    editor.commands.setTextSelection(positions[2] as number);
    press(editor, "2");
    control("d");
    expect(scrollTop).toBe(200);
    expect(editor.state.selection.from).toBe(positions[12]);
    expect(adapter.vimSnapshot.action).toBe(
      "cursor:half-page-down:count:2:changed",
    );

    scroll.scrollTop = 0;
    editor.commands.setTextSelection(positions[2] as number);
    press(editor, "V");
    control("f");
    expect(adapter.vimSnapshot.action).toBe("structure:page-down:changed");
    expect(root.querySelectorAll(".memoka-visual-line-selected")).toHaveLength(
      9,
    );
    control("b");
    expect(adapter.vimSnapshot.action).toBe("structure:page-up:changed");
    expect(
      [...root.querySelectorAll(".memoka-visual-line-selected")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["viewport-line-3"]);

    positionsAtCoordinates.mockRestore();
    coordinates.mockRestore();
    viewportRect.mockRestore();
    adapter.destroy();
    runtime.destroy();
    scroll.remove();
  });

  it("moves gg/G to NoteDoc logical lines and honors an explicit Count", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "logical-one" },
            { type: "hardBreak" },
            { type: "text", text: "logical-two" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "logical-three" }],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "logical-four\nlogical-five" }],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "logical-three"));
    editor.commands.focus();
    press(editor, "Escape");
    const upperG = () => {
      press(editor, "Shift", { shiftKey: true, code: "ShiftLeft" });
      press(editor, "G", { shiftKey: true, code: "KeyG" });
    };

    upperG();
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "logical-five"),
    );
    expect(adapter.vimSnapshot.action).toBe("cursor:document-end:changed");

    press(editor, "g");
    press(editor, "g");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "logical-one"),
    );

    press(editor, "3");
    upperG();
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "logical-three"),
    );

    press(editor, "4");
    press(editor, "g");
    press(editor, "g");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "logical-four"),
    );

    press(editor, "1");
    upperG();
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "logical-one"),
    );

    press(editor, "V");
    upperG();
    expect(adapter.vimSnapshot).toMatchObject({
      mode: "visual-line",
      action: "structure:document-end:changed",
    });
    press(editor, "g");
    press(editor, "g");
    expect(adapter.vimSnapshot.action).toBe("structure:document-start:changed");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves Japanese words by Han, Hiragana, Katakana and alphanumeric runs", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const text = "漢字ひらがなカタカナーabc123_漢字";
    editor.commands.setContent(`<p>${text}</p>`);
    const start = textPosition(editor, text);
    editor.commands.setTextSelection(start);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    const runStarts = [start, start + 2, start + 6, start + 11, start + 18];
    for (const expected of runStarts.slice(1)) {
      press(editor, "w");
      expect(editor.state.selection.from).toBe(expected);
    }
    for (const expected of runStarts.slice(0, -1).reverse()) {
      press(editor, "b");
      expect(editor.state.selection.from).toBe(expected);
    }

    press(editor, "e");
    expect(editor.state.selection.from).toBe(start + 1);
    press(editor, "e");
    expect(editor.state.selection.from).toBe(start + 5);

    editor.commands.setTextSelection(start + 3);
    press(editor, "d");
    press(editor, "i");
    press(editor, "w");
    await runtime.flush();
    expect(editor.getText()).toBe("漢字カタカナーabc123_漢字");
    expect(adapter.vimSnapshot.register).toBe("text: ひらがな");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("composes d/y/c with structural j/k motions", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: ["alpha", "beta", "gamma"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    editor.commands.setTextSelection(textPosition(editor, "beta"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    press(editor, "y");
    press(editor, "k");
    expect(adapter.vimSnapshot.register).toBe("block: alpha beta");
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);

    press(editor, "d");
    press(editor, "j");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["alpha"]);
    press(editor, "u");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);

    editor.commands.setTextSelection(textPosition(editor, "beta"));
    press(editor, "c");
    press(editor, "j");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe("alpha");
    expect(editor.state.doc.child(1).textContent).toBe("");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["alpha", "replacement"]);
    press(editor, "u");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);

    adapter.destroy();
    runtime.destroy();
  });

  it("applies word text objects and keeps change plus insertion in one undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.insertContentAt(1, "alpha beta gamma");
    editor.commands.setTextSelection(textPosition(editor, "beta") + 2);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    press(editor, "d");
    press(editor, "i");
    expect(adapter.vimSnapshot.action).toBe("pending:text-object-inner");
    press(editor, "w");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha  gamma");
    expect(adapter.vimSnapshot.register).toBe("text: beta");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta gamma");

    editor.commands.setTextSelection(textPosition(editor, "beta") + 1);
    press(editor, "c");
    press(editor, "a");
    press(editor, "w");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.getText()).toBe("alpha gamma");
    editor.commands.insertContent("delta ");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha delta gamma");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta gamma");

    adapter.destroy();
    runtime.destroy();
  });

  it("counts word and paragraph text objects without crossing a Table Cell", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const paragraphContent = () => ({
      type: "doc",
      content: ["one two three", "second paragraph", "third paragraph"].map(
        (text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        }),
      ),
    });
    editor.commands.setContent(paragraphContent());
    editor.commands.setTextSelection(textPosition(editor, "one"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    undoManager.stopCapturing();
    for (const key of "d2iw") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe(" three");
    expect(adapter.vimSnapshot.register).toBe("text: one two");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(paragraphContent());

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "2dap") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe("third paragraph");
    expect(adapter.vimSnapshot.register).toContain("one two three");
    expect(adapter.vimSnapshot.register).toContain("second paragraph");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(paragraphContent());

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "d2ip") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(paragraphContent());
    expect(undoManager.undoStack).toHaveLength(0);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "one two" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "three four" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    for (const key of "d3iw") press(editor, key);
    await runtime.flush();
    const row = editor.state.doc.firstChild?.firstChild;
    expect(row?.child(0).textContent).toBe("");
    expect(row?.child(1).textContent).toBe("three four");
    expect(adapter.vimSnapshot.register).toBe("text: one two");
    expect(undoManager.undoStack).toHaveLength(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps cl, delayed c, ciw, and visual c edits in one undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const original = "alpha beta gamma";
    editor.commands.insertContentAt(1, original);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);
    const normalCaptureTimeout = undoManager.captureTimeout;

    const verifyAtomicChange = async (options: {
      cursor: () => number;
      keys: string[];
      afterDelete: string;
      insertion: string;
      afterInsert: string;
      resetCapture?: boolean;
    }) => {
      undoManager.clear();
      undoManager.stopCapturing();
      editor.commands.setTextSelection(options.cursor());
      for (const key of options.keys) press(editor, key);
      expect(adapter.vimSnapshot.mode).toBe("insert");
      expect(editor.getText()).toBe(options.afterDelete);

      // Deterministically simulate either an explicit editor capture reset or
      // a pause longer than Yjs's normal capture timeout.
      if (options.resetCapture) undoManager.stopCapturing();
      else undoManager.lastChange = 1;
      editor.commands.insertContent(options.insertion);
      press(editor, "Escape");
      await runtime.flush();

      expect(editor.getText()).toBe(options.afterInsert);
      expect(undoManager.captureTimeout).toBe(normalCaptureTimeout);
      expect(undoManager.undoStack).toHaveLength(1);
      press(editor, "u");
      await runtime.flush();
      expect(editor.getText()).toBe(original);
    };

    await verifyAtomicChange({
      cursor: () => textPosition(editor, "beta"),
      keys: ["c", "l"],
      afterDelete: "alpha eta gamma",
      insertion: "B",
      afterInsert: "alpha Beta gamma",
      resetCapture: true,
    });
    await verifyAtomicChange({
      cursor: () => textPosition(editor, "alpha"),
      keys: ["c", "w"],
      afterDelete: "beta gamma",
      insertion: "delta ",
      afterInsert: "delta beta gamma",
    });
    await verifyAtomicChange({
      cursor: () => textPosition(editor, "beta") + 2,
      keys: ["c", "i", "w"],
      afterDelete: "alpha  gamma",
      insertion: "delta",
      afterInsert: "alpha delta gamma",
    });
    await verifyAtomicChange({
      cursor: () => textPosition(editor, "beta"),
      keys: ["v", "l", "l", "l", "c"],
      afterDelete: "alpha  gamma",
      insertion: "delta",
      afterInsert: "alpha delta gamma",
    });

    adapter.destroy();
    runtime.destroy();
  });

  it("implements D, C, and S with Vim change and undo boundaries", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.insertContentAt(1, "alpha beta");
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    const prepare = () => {
      undoManager.clear();
      undoManager.stopCapturing();
      editor.commands.setTextSelection(textPosition(editor, "beta") + 1);
    };

    prepare();
    press(editor, "D");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha b");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(adapter.vimSnapshot.register).toBe("text: eta");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta");

    prepare();
    press(editor, "C");
    expect(editor.getText()).toBe("alpha b");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha bX");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta");

    prepare();
    press(editor, "S");
    expect(editor.getText()).toBe("");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("replacement");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps Table D, C, and S edits inside the current Cell", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "alpha" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "beta" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "gamma" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "body a" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "body b" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "body c" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);
    undoManager.clear();
    undoManager.stopCapturing();

    const headerRow = () => editor.state.doc.child(0).child(0);
    const bodyRow = () => editor.state.doc.child(0).child(1);
    const headerTexts = () =>
      Array.from(
        { length: headerRow().childCount },
        (_, index) => headerRow().child(index).textContent,
      );
    const headerIds = Array.from(
      { length: headerRow().childCount },
      (_, index) => headerRow().child(index).attrs.blockId,
    );
    const bodyIds = Array.from(
      { length: bodyRow().childCount },
      (_, index) => bodyRow().child(index).attrs.blockId,
    );

    editor.commands.setTextSelection(textPosition(editor, "alpha") + 2);
    press(editor, "D");
    await runtime.flush();
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(headerRow().childCount).toBe(3);
    expect(
      Array.from(
        { length: headerRow().childCount },
        (_, index) => headerRow().child(index).type.name,
      ),
    ).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(headerTexts()).toEqual(["al", "beta", "gamma"]);
    expect(
      Array.from(
        { length: headerRow().childCount },
        (_, index) => headerRow().child(index).attrs.blockId,
      ),
    ).toEqual(headerIds);
    expect(bodyRow().textContent).toBe("body abody bbody c");
    expect(selectionAncestorBlockId(editor, "tableHeader")).toBe(headerIds[0]);
    expect(adapter.vimSnapshot.register).toBe("text: pha");
    expect(undoManager.undoStack).toHaveLength(1);

    press(editor, "u");
    await runtime.flush();
    expect(headerTexts()).toEqual(["alpha", "beta", "gamma"]);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "beta") + 2);
    press(editor, "C");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(headerTexts()).toEqual(["alpha", "be", "gamma"]);
    expect(headerRow().childCount).toBe(3);
    expect(
      Array.from(
        { length: headerRow().childCount },
        (_, index) => headerRow().child(index).attrs.blockId,
      ),
    ).toEqual(headerIds);
    expect(selectionAncestorBlockId(editor, "tableHeader")).toBe(headerIds[1]);
    expect(adapter.vimSnapshot.register).toBe("text: ta");
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(headerTexts()).toEqual(["alpha", "beX", "gamma"]);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(headerTexts()).toEqual(["alpha", "beta", "gamma"]);
    expect(bodyRow().textContent).toBe("body abody bbody c");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "body b") + 2);
    press(editor, "S");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(
      Array.from(
        { length: bodyRow().childCount },
        (_, index) => bodyRow().child(index).textContent,
      ),
    ).toEqual(["body a", "", "body c"]);
    expect(
      Array.from(
        { length: bodyRow().childCount },
        (_, index) => bodyRow().child(index).attrs.blockId,
      ),
    ).toEqual(bodyIds);
    expect(selectionAncestorBlockId(editor, "tableCell")).toBe(bodyIds[1]);
    expect(adapter.vimSnapshot.register).toBe("text: body b");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(
      Array.from(
        { length: bodyRow().childCount },
        (_, index) => bodyRow().child(index).textContent,
      ),
    ).toEqual(["body a", "replacement", "body c"]);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(
      Array.from(
        { length: bodyRow().childCount },
        (_, index) => bodyRow().child(index).textContent,
      ),
    ).toEqual(["body a", "body b", "body c"]);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "body b"));
    press(editor, "S");
    press(editor, "Escape");
    await runtime.flush();
    expect(bodyRow().child(1).textContent).toBe("");
    expect(selectionAncestorBlockId(editor, "tableCell")).toBe(bodyIds[1]);

    undoManager.clear();
    undoManager.stopCapturing();
    press(editor, "C");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(selectionAncestorBlockId(editor, "tableCell")).toBe(bodyIds[1]);
    editor.commands.insertContent("from empty");
    press(editor, "Escape");
    await runtime.flush();
    expect(
      Array.from(
        { length: bodyRow().childCount },
        (_, index) => bodyRow().child(index).textContent,
      ),
    ).toEqual(["body a", "from empty", "body c"]);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(bodyRow().child(1).textContent).toBe("");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("deletes exactly the current character with x without crossing a Table Cell", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "abc" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "xy" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "next" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    editor.commands.setTextSelection(textPosition(editor, "abc") + 1);
    press(editor, "x");
    await runtime.flush();
    expect(editor.state.doc.child(0).textContent).toBe("ac");
    expect(adapter.vimSnapshot.register).toBe("text: b");
    expect(clampVimBlockCursor(editor.view, editor.state.selection.head)).toBe(
      textPosition(editor, "c"),
    );
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.child(0).textContent).toBe("abc");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "abc") + 2);
    press(editor, "x");
    await runtime.flush();
    expect(editor.state.doc.child(0).textContent).toBe("ab");
    expect(clampVimBlockCursor(editor.view, editor.state.selection.head)).toBe(
      textPosition(editor, "b"),
    );
    press(editor, "u");
    await runtime.flush();

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "xy") + 1);
    const firstCellId = editor.state.doc.child(1).child(0).child(0)
      .attrs.blockId;
    press(editor, "x");
    await runtime.flush();
    const row = editor.state.doc.child(1).child(0);
    expect(row.childCount).toBe(2);
    expect(row.child(0).textContent).toBe("x");
    expect(row.child(1).textContent).toBe("next");
    expect(selectionAncestorBlockId(editor, "tableCell")).toBe(firstCellId);
    expect(adapter.vimSnapshot.register).toBe("text: y");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.child(1).child(0).child(0).textContent).toBe("xy");
    expect(editor.state.doc.child(1).child(0).child(1).textContent).toBe(
      "next",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("makes cw consume the final word without crossing ListItem or Table Cell boundaries", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    const changeWord = (sourceText: string) => {
      editor.commands.setTextSelection(textPosition(editor, sourceText));
      press(editor, "c");
      press(editor, "w");
      expect(adapter.vimSnapshot.mode).toBe("insert");
    };

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha omega" }],
        },
      ],
    });
    changeWord("omega");
    expect(editor.state.doc.child(0).textContent).toBe("alpha ");
    press(editor, "Escape");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "alpha omega" }],
                },
              ],
            },
          ],
        },
      ],
    });
    changeWord("omega");
    expect(editor.state.doc.textContent).toBe("alpha ");
    expect(
      Array.from(
        { length: editor.state.selection.$from.depth + 1 },
        (_, depth) => editor.state.selection.$from.node(depth).type.name,
      ),
    ).toContain("listItem");
    press(editor, "Escape");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "omega" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "next cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    changeWord("omega");
    const row = editor.state.doc.child(0).child(0);
    expect(row.child(0).textContent).toBe("");
    expect(row.child(1).textContent).toBe("next cell");
    expect(
      Array.from(
        { length: editor.state.selection.$from.depth + 1 },
        (_, depth) => editor.state.selection.$from.node(depth).type.name,
      ),
    ).toContain("tableCell");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("joins paragraph and Code Block lines with J and gJ", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    const setParagraphs = async () => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "alpha" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "beta" }],
          },
        ],
      });
      await runtime.flush();
      undoManager.clear();
      editor.commands.setTextSelection(textPosition(editor, "alpha"));
    };

    await setParagraphs();
    press(editor, "J");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("alpha beta");
    expect(adapter.vimSnapshot.action).toBe("line:join:changed");
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(2);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha " }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "  beta" }],
        },
      ],
    });
    await runtime.flush();
    undoManager.clear();
    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    press(editor, "g");
    press(editor, "J");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("alpha   beta");
    expect(adapter.vimSnapshot.action).toBe("line:join-raw:changed");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "alpha " },
            { type: "hardBreak" },
            { type: "text", text: "  beta" },
          ],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "alpha"));
    press(editor, "J");
    expect(editor.state.doc.firstChild?.textContent).toBe("alpha beta");
    expect(editor.state.doc.firstChild?.childCount).toBe(1);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first item" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second item" }],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "first item"));
    press(editor, "J");
    const list = editor.state.doc.child(0);
    expect(list.type.name).toBe("bulletList");
    expect(list.childCount).toBe(1);
    expect(list.child(0).textContent).toBe("first item second item");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first " }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "  second" }],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "first"));
    press(editor, "g");
    press(editor, "J");
    expect(editor.state.doc.child(0).childCount).toBe(1);
    expect(editor.state.doc.child(0).child(0).textContent).toBe(
      "first   second",
    );

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "one \n  two" }],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "J");
    expect(editor.state.doc.child(0).textContent).toBe("one two");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "one \n  two" }],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "g");
    press(editor, "J");
    expect(editor.state.doc.child(0).textContent).toBe("one   two");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("supports one-character r and undo-grouped Replace mode R", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.insertContentAt(1, "abc");
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    editor.commands.setTextSelection(textPosition(editor, "abc") + 1);
    press(editor, "r");
    expect(adapter.vimSnapshot.action).toBe("pending:replace-character");
    press(editor, "X");
    await runtime.flush();
    expect(editor.getText()).toBe("aXc");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(editor.state.selection.from).toBe(textPosition(editor, "X"));
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("abc");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "abc") + 1);
    press(editor, "R");
    expect(adapter.vimSnapshot.mode).toBe("replace");
    await runtime.flush();
    expect(runtime.windows.get("window-1")?.mode).toBe("replace");
    const first = beforeInput(editor, "X");
    const second = beforeInput(editor, "Y");
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("aXY");
    press(editor, "Escape");
    await runtime.flush();
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(runtime.windows.get("window-1")?.mode).toBe("normal");
    expect(editor.state.selection.from).toBe(textPosition(editor, "Y"));
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("abc");
    expect(editor.state.selection.from).toBe(textPosition(editor, "abc") + 1);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "B" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "A"));
    press(editor, "R");
    beforeInput(editor, "X");
    beforeInput(editor, "Y");
    const row = editor.state.doc.child(0).child(0);
    expect(row.child(0).textContent).toBe("XY");
    expect(row.child(1).textContent).toBe("B");
    expect(
      Array.from(
        { length: editor.state.selection.$from.depth + 1 },
        (_, depth) => editor.state.selection.$from.node(depth).type.name,
      ),
    ).toContain("tableCell");
    press(editor, "Escape");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("replays immediate text and line edits with dot as separate Undo units", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent("<p>abc</p>");
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    editor.commands.setTextSelection(textPosition(editor, "abc") + 1);
    const undoManager = editorUndoManager(editor);
    undoManager.clear();

    press(editor, "r");
    press(editor, "X");
    expect(editor.getText()).toBe("aXc");
    editor.commands.setTextSelection(textPosition(editor, "c"));
    press(editor, ".");
    await runtime.flush();
    expect(editor.getText()).toBe("aXX");
    expect(adapter.vimSnapshot.action).toBe("repeat:replace:character:changed");
    expect(undoManager.undoStack).toHaveLength(2);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("aXc");

    editor.commands.setContent({
      type: "doc",
      content: ["one", "two", "three"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    editor.commands.setTextSelection(textPosition(editor, "one"));
    undoManager.clear();
    undoManager.stopCapturing();
    press(editor, "d");
    press(editor, "d");
    press(editor, ".");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["three"]);
    press(editor, "u");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["two", "three"]);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("replays structural put with fresh identities", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: ["one", "two"].map((text) => ({
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text }],
              },
            ],
          })),
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "one"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "y");
    const undoManager = editorUndoManager(editor);
    undoManager.clear();
    undoManager.stopCapturing();

    press(editor, "p");
    press(editor, ".");
    await runtime.flush();
    const list = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["one", "one", "one", "two"]);
    const blockIds = Array.from(
      { length: list?.childCount ?? 0 },
      (_, index) => list?.child(index).attrs.blockId,
    );
    expect(new Set(blockIds).size).toBe(4);
    expect(adapter.vimSnapshot.action).toBe("repeat:put:after:changed");
    expect(undoManager.undoStack).toHaveLength(2);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(3);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("applies counts to x, r, p, P, J, and gJ as one Undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent("<p>abcdef</p>");
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "abcdef"));
    press(editor, "3");
    press(editor, "x");
    await runtime.flush();
    expect(editor.getText()).toBe("def");
    expect(adapter.vimSnapshot.register).toBe("text: abc");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("abcdef");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "abcdef"));
    press(editor, "3");
    press(editor, "r");
    press(editor, "X");
    await runtime.flush();
    expect(editor.getText()).toBe("XXXdef");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "XXXdef") + 2,
    );
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("abcdef");

    undoManager.clear();
    editor.commands.setContent("<p>a b</p>");
    await runtime.flush();
    undoManager.clear();
    editor.commands.setTextSelection(textPosition(editor, "a b"));
    press(editor, "y");
    press(editor, "i");
    press(editor, "w");
    expect(adapter.vimSnapshot.register).toBe("text: a");
    editor.commands.setTextSelection(textPosition(editor, "b"));
    undoManager.stopCapturing();
    press(editor, "3");
    press(editor, "p");
    await runtime.flush();
    expect(editor.getText()).toBe("a baaa");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("a b");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "b"));
    press(editor, "3");
    press(editor, "P");
    await runtime.flush();
    expect(editor.getText()).toBe("a aaab");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("a b");

    editor.commands.setContent({
      type: "doc",
      content: ["one", "two", "three", "four"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "3");
    press(editor, "J");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["one two three", "four"]);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(4);

    editor.commands.setContent({
      type: "doc",
      content: ["one ", " two", "three", "four"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "3");
    press(editor, "g");
    press(editor, "J");
    await runtime.flush();
    expect(editor.state.doc.child(0).textContent).toBe("one  twothree");
    expect(editor.state.doc.childCount).toBe(2);
    expect(undoManager.undoStack).toHaveLength(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("restores the Visual-char selection start after change and undo", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.insertContentAt(1, "alpha beta gamma");
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    const selectionStart = textPosition(editor, "beta");
    editor.commands.setTextSelection(selectionStart);
    press(editor, "v");
    press(editor, "l");
    press(editor, "l");
    press(editor, "l");
    expect(editor.state.selection.from).toBe(selectionStart);
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("beta");

    press(editor, "c");
    editor.commands.insertContent("delta");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha delta gamma");

    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("alpha beta gamma");
    expect(editor.state.selection.from).toBe(selectionStart);

    press(editor, "r", { ctrlKey: true });
    await runtime.flush();
    expect(editor.getText()).toBe("alpha delta gamma");
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "delta") + "delta".length - 1,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("supports I, A, o, and O for text blocks and code logical lines", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "  alpha" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "omega" }],
        },
      ],
    });
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    const prepare = (position: number) => {
      undoManager.clear();
      undoManager.stopCapturing();
      editor.commands.setTextSelection(position);
    };

    prepare(textPosition(editor, "alpha") + 2);
    press(editor, "I");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.selection.from).toBe(textPosition(editor, "alpha"));
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  Xalpha\n\nomega");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  alpha\n\nomega");

    prepare(textPosition(editor, "alpha") + 1);
    press(editor, "A");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.selection.from).toBe(textPosition(editor, "alpha") + 5);
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  alphaX\n\nomega");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  alpha\n\nomega");

    const openCursor = textPosition(editor, "alpha") + 1;
    prepare(openCursor);
    press(editor, "o");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("below");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  alpha\n\nbelow\n\nomega");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  alpha\n\nomega");
    expect(editor.state.selection.from).toBe(openCursor);

    prepare(openCursor);
    press(editor, "O");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("above");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("above\n\n  alpha\n\nomega");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  alpha\n\nomega");
    expect(editor.state.selection.from).toBe(openCursor);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "  one\n    two" }],
        },
      ],
    });
    await runtime.flush();

    prepare(textPosition(editor, "two") + 1);
    press(editor, "I");
    expect(editor.state.selection.from).toBe(textPosition(editor, "two"));
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    Xtwo");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    two");

    prepare(textPosition(editor, "two") + 1);
    press(editor, "A");
    expect(editor.state.selection.from).toBe(textPosition(editor, "two") + 3);
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    twoX");
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    two");

    prepare(textPosition(editor, "two") + 1);
    press(editor, "o");
    editor.commands.insertContent("new");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    two\n    new");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    two");

    prepare(textPosition(editor, "two") + 1);
    press(editor, "O");
    editor.commands.insertContent("new");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    new\n    two");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.getText()).toBe("  one\n    two");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("opens fresh ListItem and TableRow siblings with o and O", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "one" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "two" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "one") + 1);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "o");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("new");
    press(editor, "Escape");
    await runtime.flush();
    let list = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["one", "new", "two"]);
    expect(
      new Set(
        Array.from(
          { length: list?.childCount ?? 0 },
          (_, index) => list?.child(index).attrs.blockId,
        ),
      ).size,
    ).toBe(3);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    list = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["one", "two"]);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "two"));
    press(editor, "O");
    editor.commands.insertContent("upper");
    press(editor, "Escape");
    await runtime.flush();
    list = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["one", "upper", "two"]);
    press(editor, "u");
    await runtime.flush();

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "left" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "right" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "left"));
    press(editor, "o");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("new row");
    press(editor, "Escape");
    await runtime.flush();
    let table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(2);
    expect(table?.child(0).textContent).toBe("leftright");
    expect(table?.child(1).textContent).toBe("new row");
    expect(table?.child(0).attrs.blockId).not.toBe(
      table?.child(1).attrs.blockId,
    );
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(1);
    expect(table?.firstChild?.textContent).toBe("leftright");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps cc's logical line and clears it from the line start", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "one\ntwo\nthree" }],
        },
      ],
    });
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    const changeCurrentLine = async (
      cursor: number,
      insertion: string,
      assertCleared: () => void,
      assertInserted: () => void,
      assertRestored: () => void,
    ) => {
      undoManager.clear();
      undoManager.stopCapturing();
      editor.commands.setTextSelection(cursor);
      press(editor, "c");
      press(editor, "c");
      expect(adapter.vimSnapshot.mode).toBe("insert");
      assertCleared();

      undoManager.stopCapturing();
      editor.commands.insertContent(insertion);
      press(editor, "Escape");
      await runtime.flush();
      assertInserted();
      expect(undoManager.undoStack).toHaveLength(1);

      press(editor, "u");
      await runtime.flush();
      assertRestored();
    };

    await changeCurrentLine(
      textPosition(editor, "alpha") + 2,
      "replacement",
      () => {
        expect(editor.state.doc.childCount).toBe(3);
        expect(editor.state.doc.child(0).type.name).toBe("paragraph");
        expect(editor.state.doc.child(0).textContent).toBe("");
        expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
        expect(editor.state.selection.$from.parentOffset).toBe(0);
      },
      () => expect(editor.state.doc.child(0).textContent).toBe("replacement"),
      () => expect(editor.state.doc.child(0).textContent).toBe("alpha"),
    );

    await changeCurrentLine(
      textPosition(editor, "parent") + 2,
      "replacement",
      () => {
        const item = editor.state.doc.child(1).child(0);
        expect(item.type.name).toBe("listItem");
        expect(item.childCount).toBe(2);
        expect(item.child(0).textContent).toBe("");
        expect(item.child(1).textContent).toBe("child");
        expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
        expect(editor.state.selection.$from.parentOffset).toBe(0);
      },
      () =>
        expect(editor.state.doc.child(1).child(0).textContent).toBe(
          "replacementchild",
        ),
      () =>
        expect(editor.state.doc.child(1).child(0).textContent).toBe(
          "parentchild",
        ),
    );

    await changeCurrentLine(
      textPosition(editor, "two") + 1,
      "second",
      () => {
        expect(editor.state.doc.child(2).type.name).toBe("codeBlock");
        expect(editor.state.doc.child(2).textContent).toBe("one\n\nthree");
        expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
        expect(editor.state.selection.$from.parentOffset).toBe(4);
      },
      () =>
        expect(editor.state.doc.child(2).textContent).toBe(
          "one\nsecond\nthree",
        ),
      () =>
        expect(editor.state.doc.child(2).textContent).toBe("one\ntwo\nthree"),
    );

    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(1);
    press(editor, "c");
    press(editor, "c");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).textContent).toBe("");
    expect(undoManager.undoStack).toHaveLength(0);
    undoManager.stopCapturing();
    editor.commands.insertContent("fresh");
    press(editor, "Escape");
    await runtime.flush();
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.child(0).textContent).toBe("");

    adapter.destroy();
    runtime.destroy();
  });

  it("applies counts to yy, dd, and cc over logical structural lines", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const content = () => ({
      type: "doc",
      content: ["one", "two", "three", "four", "five"].map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    });
    editor.commands.setContent(content());
    editor.commands.setTextSelection(textPosition(editor, "one"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);
    undoManager.clear();

    press(editor, "3");
    press(editor, "y");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("block: one two three");
    expect(editor.state.doc.childCount).toBe(5);

    undoManager.stopCapturing();
    press(editor, "3");
    press(editor, "d");
    press(editor, "d");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["four", "five"]);
    expect(adapter.vimSnapshot.register).toBe("block: one two three");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(content());

    editor.commands.setContent(content());
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "3");
    press(editor, "c");
    press(editor, "c");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["", "four", "five"]);
    expect(adapter.vimSnapshot.register).toBe("block: one two three");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).textContent,
      ),
    ).toEqual(["replacement", "four", "five"]);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(content());

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("always creates a fresh paragraph after a Code Block on Ctrl+Enter", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const value = 1;" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "value"));
    editor.commands.focus();
    await runtime.flush();
    const undoManager = editorUndoManager(editor);
    undoManager.clear();

    const created = press(editor, "Enter", {
      code: "Enter",
      ctrlKey: true,
    });
    await runtime.flush();
    expect(created.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(adapter.vimSnapshot.action).toBe(
      "code:exit-created-paragraph:changed",
    );
    expect(undoManager.undoStack).toHaveLength(1);
    const firstParagraphId = editor.state.doc.child(1).attrs.blockId;

    editor.commands.setTextSelection(textPosition(editor, "value"));
    const createdAgain = press(editor, "Enter", {
      code: "Enter",
      ctrlKey: true,
    });
    await runtime.flush();
    expect(createdAgain.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).textContent).toBe("");
    expect(editor.state.doc.child(1).attrs.blockId).not.toBe(firstParagraphId);
    expect(editor.state.doc.child(2).attrs.blockId).toBe(firstParagraphId);
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(1));
    expect(adapter.vimSnapshot.action).toBe(
      "code:exit-created-paragraph:changed",
    );
    expect(undoManager.undoStack).toHaveLength(2);

    press(editor, "Escape");
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).attrs.blockId).toBe(firstParagraphId);

    adapter.destroy();
    runtime.destroy();
  });

  it.each([
    {
      name: "List",
      detail: "list",
      sourceText: "list item",
      block: {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "list item" }],
              },
            ],
          },
        ],
      },
    },
    {
      name: "Numbered List",
      detail: "list",
      sourceText: "numbered item",
      block: {
        type: "orderedList",
        attrs: { start: 4 },
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "numbered item" }],
              },
            ],
          },
        ],
      },
    },
    {
      name: "Table",
      detail: "table",
      sourceText: "table cell",
      block: {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "table cell" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      name: "Blockquote",
      detail: "blockquote",
      sourceText: "quoted text",
      block: {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "quoted text" }],
          },
        ],
      },
    },
  ])(
    "moves Ctrl+Enter from a $name block to one following paragraph",
    async ({ block, detail, sourceText }) => {
      const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
        idFactory: deterministicIds(),
        clock: () => "2026-08-01T00:00:00.000Z",
      });
      const root = document.createElement("div");
      document.body.append(root);
      const { adapter, editor } = runtime.editorForTesting("window-1", root);
      editor.commands.setContent({ type: "doc", content: [block] });
      editor.commands.setTextSelection(textPosition(editor, sourceText));
      editor.commands.focus();
      await runtime.flush();
      const undoManager = editorUndoManager(editor);
      undoManager.clear();

      const created = press(editor, "Enter", {
        code: "Enter",
        ctrlKey: true,
      });
      await runtime.flush();
      expect(created.defaultPrevented).toBe(true);
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.parent).toBe(
        editor.state.doc.lastChild,
      );
      expect(adapter.vimSnapshot.action).toBe(
        `${detail}:exit-created-paragraph:changed`,
      );
      expect(undoManager.undoStack).toHaveLength(1);

      press(editor, "Escape");
      press(editor, "u");
      await runtime.flush();
      expect(editor.state.doc.childCount).toBe(1);

      editor.commands.setContent({
        type: "doc",
        content: [
          block,
          {
            type: "paragraph",
            content: [{ type: "text", text: "existing paragraph" }],
          },
        ],
      });
      await runtime.flush();
      undoManager.clear();
      editor.commands.setTextSelection(textPosition(editor, sourceText));
      press(editor, "i");

      const insertedBeforeExisting = press(editor, "Enter", {
        code: "Enter",
        ctrlKey: true,
      });
      await runtime.flush();
      expect(insertedBeforeExisting.defaultPrevented).toBe(true);
      expect(editor.state.doc.childCount).toBe(3);
      expect(editor.state.doc.child(1).type.name).toBe("paragraph");
      expect(editor.state.doc.child(1).textContent).toBe("");
      expect(editor.state.doc.child(2).textContent).toBe("existing paragraph");
      expect(editor.state.selection.$from.parent).toBe(
        editor.state.doc.child(1),
      );
      expect(adapter.vimSnapshot.action).toBe(
        `${detail}:exit-created-paragraph:changed`,
      );
      expect(undoManager.undoStack).toHaveLength(1);

      adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  );

  it("exits a nested ListItem after the complete outer list", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent item" }],
                },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "nested item" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "sibling item" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "existing paragraph" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "nested item"));
    editor.commands.focus();
    await runtime.flush();

    const event = press(editor, "Enter", {
      code: "Enter",
      ctrlKey: true,
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    const outerList = editor.state.doc.child(0);
    expect(outerList.type.name).toBe("bulletList");
    expect(outerList.childCount).toBe(2);
    expect(outerList.textContent).toBe("parent itemnested itemsibling item");
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).textContent).toBe("");
    expect(editor.state.doc.child(2).textContent).toBe("existing paragraph");
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(1));
    expect(adapter.vimSnapshot.action).toBe(
      "list:exit-created-paragraph:changed",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("exits nested Blockquotes after the complete outer quote", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-22T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "outer quote" }],
            },
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "inner quote" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "existing paragraph" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "inner quote"));
    editor.commands.focus();
    await runtime.flush();

    const event = press(editor, "Enter", {
      code: "Enter",
      ctrlKey: true,
    });
    await runtime.flush();

    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(editor.state.doc.firstChild?.child(1).type.name).toBe("blockquote");
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).textContent).toBe("");
    expect(editor.state.doc.child(2).textContent).toBe("existing paragraph");
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(1));
    expect(adapter.vimSnapshot.action).toBe(
      "blockquote:exit-created-paragraph:changed",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("treats Paragraph Hard Break segments as Visual-line units", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-02T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first" },
            { type: "hardBreak" },
            { type: "text", marks: [{ type: "bold" }], text: "second" },
            { type: "hardBreak" },
            { type: "text", text: "third" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "second"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "V");

    expect(adapter.vimSnapshot.mode).toBe("visual-line");
    expect(editor.state.selection.empty).toBe(true);
    expect(
      [...root.querySelectorAll(".memoka-visual-line-text-selected")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["second"]);
    await vi.waitFor(() => {
      expect(
        root.querySelectorAll(
          '.memoka-visual-line-overlay-row[data-vim-visual-line="hard-break-line"]',
        ),
      ).toHaveLength(1);
    });

    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    press(editor, "l");
    expect({
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }).toEqual(selectionBefore);
    press(editor, "j");
    expect(
      [...root.querySelectorAll(".memoka-visual-line-text-selected")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["second", "third"]);
    press(editor, "k");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ParagraphLine×1: second");

    press(editor, "p");
    await runtime.flush();
    let paragraph = editor.state.doc.firstChild;
    expect(paragraph?.textContent).toBe("firstsecondsecondthird");
    expect(
      paragraph?.content.content.filter(
        (node) => node.type.name === "hardBreak",
      ),
    ).toHaveLength(3);
    const copiedSecond = paragraph?.content.content.filter(
      (node) => node.isText && node.text === "second",
    );
    expect(copiedSecond).toHaveLength(2);
    expect(
      copiedSecond?.every((node) =>
        node.marks.some((mark) => mark.type.name === "bold"),
      ),
    ).toBe(true);

    press(editor, "u");
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "second"));
    press(editor, "V");
    press(editor, "d");
    await runtime.flush();
    paragraph = editor.state.doc.firstChild;
    expect(paragraph?.textContent).toBe("firstthird");
    expect(
      paragraph?.content.content.filter(
        (node) => node.type.name === "hardBreak",
      ),
    ).toHaveLength(1);

    press(editor, "u");
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "second"));
    press(editor, "V");
    press(editor, "c");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "firstreplacementthird",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("uses Hard Break logical lines for Normal yy and dd", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const paragraphContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first" },
            { type: "hardBreak" },
            { type: "text", marks: [{ type: "bold" }], text: "second" },
            { type: "hardBreak" },
            { type: "text", text: "third" },
          ],
        },
      ],
    };
    editor.commands.setContent(paragraphContent);
    editor.commands.setTextSelection(textPosition(editor, "second"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");

    press(editor, "y");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ParagraphLine×1: second");
    expect(editor.state.doc.toJSON()).toMatchObject(paragraphContent);

    const undoManager = editorUndoManager(editor);
    undoManager.clear();
    undoManager.stopCapturing();
    press(editor, "d");
    press(editor, "d");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("firstthird");
    expect(
      editor.state.doc.firstChild?.content.content.filter(
        (node) => node.type.name === "hardBreak",
      ),
    ).toHaveLength(1);
    expect(adapter.vimSnapshot.register).toBe("ParagraphLine×1: second");
    expect(undoManager.undoStack).toHaveLength(1);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.toJSON()).toMatchObject(paragraphContent);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "first"));
    press(editor, "2");
    press(editor, "y");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ParagraphLine×2: first second");
    press(editor, "2");
    press(editor, "d");
    press(editor, "d");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("third");
    expect(adapter.vimSnapshot.register).toBe("ParagraphLine×2: first second");
    expect(undoManager.undoStack).toHaveLength(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps V on a ListItem structural unit and puts a fresh-ID copy", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first item" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second item" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "first item"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "V");
    expect(editor.state.selection.empty).toBe(true);
    expect(
      [...root.querySelectorAll(".memoka-visual-line-selected")].map(
        (node) => ({
          tagName: node.tagName,
          kind: node.getAttribute("data-vim-visual-line"),
          text: node.textContent,
        }),
      ),
    ).toEqual([
      {
        tagName: "LI",
        kind: "list-item",
        text: "first item",
      },
    ]);
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    press(editor, "l");
    expect({
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }).toEqual(selectionBefore);
    expect(root.querySelectorAll(".memoka-visual-line-selected")).toHaveLength(
      1,
    );
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toContain("ListItem");
    press(editor, "p");
    await runtime.flush();

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(3);
    const ids = Array.from(
      { length: list?.childCount ?? 0 },
      (_, index) => list?.child(index).attrs.blockId,
    );
    expect(new Set(ids).size).toBe(3);
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["first item", "first item", "second item"]);

    adapter.destroy();
    runtime.destroy();
  });

  it("paints nested ListItem Visual-Line selection only through the head logical row", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent item" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child item" }],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "second child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "parent item"));
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "V");

    const selectedRows = () =>
      [...root.querySelectorAll(".memoka-visual-line-selected")].map(
        (node) => ({
          tagName: node.tagName,
          kind: node.getAttribute("data-vim-visual-line"),
          text: node.textContent,
        }),
      );
    expect(selectedRows()).toEqual([
      { tagName: "P", kind: "list-item", text: "parent item" },
    ]);

    press(editor, "j");
    expect(selectedRows()).toEqual([
      { tagName: "P", kind: "list-item", text: "parent item" },
      { tagName: "LI", kind: "list-item", text: "child item" },
    ]);
    press(editor, "k");
    expect(selectedRows()).toEqual([
      { tagName: "P", kind: "list-item", text: "parent item" },
    ]);

    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ListItem: parent item");
    press(editor, "p");
    await runtime.flush();

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(2);
    expect(list?.child(0).textContent).toBe(
      "parent itemchild itemsecond child",
    );
    expect(list?.child(1).textContent).toBe("parent item");
    expect(list?.child(1).childCount).toBe(1);

    editor.commands.setTextSelection(textPosition(editor, "parent item"));
    press(editor, "V");
    press(editor, "j");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe(
      "ListItem: parent item child item",
    );
    expect(editor.state.selection.from).toBe(
      textPosition(editor, "parent item"),
    );
    press(editor, "p");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe(
      "parent itemchild item",
    );
    expect(editor.state.doc.firstChild?.child(1).childCount).toBe(2);

    editor.commands.setTextSelection(textPosition(editor, "parent item"));
    press(editor, "y");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ListItem: parent item");

    editor.commands.setTextSelection(textPosition(editor, "child item"));
    press(editor, "V");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ListItem: child item");
    press(editor, "p");
    await runtime.flush();

    const outerListAfterNestedPut = editor.state.doc.firstChild;
    const originalParent = outerListAfterNestedPut?.child(0);
    const nestedList = originalParent?.child(1);
    expect(outerListAfterNestedPut?.childCount).toBe(3);
    expect(nestedList?.type.name).toBe("bulletList");
    expect(nestedList?.childCount).toBe(3);
    expect(
      Array.from(
        { length: nestedList?.childCount ?? 0 },
        (_, index) => nestedList?.child(index).textContent,
      ),
    ).toEqual(["child item", "child item", "second child"]);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("preserves a numbered-list container while yanking and putting a ListItem", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 4 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first numbered" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second numbered" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "first numbered"));
    editor.commands.focus();
    await runtime.flush();

    press(editor, "Escape");
    press(editor, "V");
    press(editor, "y");
    press(editor, "p");
    await runtime.flush();

    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("orderedList");
    expect(list?.attrs.start).toBe(4);
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["first numbered", "first numbered", "second numbered"]);
    const ids = Array.from(
      { length: list?.childCount ?? 0 },
      (_, index) => list?.child(index).attrs.blockId,
    );
    expect(new Set(ids).size).toBe(3);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("orderedList");
    expect(editor.state.doc.firstChild?.attrs.start).toBe(4);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("extends Visual-line and repeated structural put by count", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: ["one", "two", "three", "four"].map((text) => ({
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text }],
              },
            ],
          })),
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "one"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    press(editor, "V");
    press(editor, "2");
    press(editor, "j");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("ListItem: one two three");

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one"));
    press(editor, "2");
    press(editor, "p");
    await runtime.flush();
    const list = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual([
      "one",
      "one",
      "two",
      "three",
      "one",
      "two",
      "three",
      "two",
      "three",
      "four",
    ]);
    const ids = Array.from(
      { length: list?.childCount ?? 0 },
      (_, index) => list?.child(index).attrs.blockId,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(4);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps counted edits inside Code lines and uses logical Table rows for dd/yy", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "aa\nbb\ncc\ndd" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "aa"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    const undoManager = editorUndoManager(editor);

    undoManager.clear();
    undoManager.stopCapturing();
    press(editor, "9");
    press(editor, "x");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("\nbb\ncc\ndd");
    expect(adapter.vimSnapshot.register).toBe("text: aa");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "aa"));
    press(editor, "2");
    press(editor, "d");
    press(editor, "d");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("cc\ndd");
    expect(adapter.vimSnapshot.register).toBe("CodeLine×2: aa bb");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.textContent).toBe("aa\nbb\ncc\ndd");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "one two" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "three four" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one two"));
    press(editor, "9");
    press(editor, "x");
    await runtime.flush();
    let row = editor.state.doc.firstChild?.firstChild;
    expect(row?.child(0).textContent).toBe("");
    expect(row?.child(1).textContent).toBe("three four");
    press(editor, "u");
    await runtime.flush();

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "one two"));
    for (const key of "c3w") press(editor, key);
    expect(adapter.vimSnapshot.mode).toBe("insert");
    row = editor.state.doc.firstChild?.firstChild;
    expect(row?.child(0).textContent).toBe("");
    expect(row?.child(1).textContent).toBe("three four");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    row = editor.state.doc.firstChild?.firstChild;
    expect(row?.child(0).textContent).toBe("one two");
    expect(row?.child(1).textContent).toBe("three four");

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: ["row 1", "row 2", "row 3", "row 4"].map((text) => ({
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text }],
                  },
                ],
              },
            ],
          })),
        },
      ],
    });
    await runtime.flush();
    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "row 1"));

    for (const key of "2yy") press(editor, key);
    expect(editor.state.doc.firstChild?.childCount).toBe(4);
    expect(adapter.vimSnapshot.register).toBe("TableRow: row 1 row 2");

    for (const key of "2dd") press(editor, key);
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe("row 3");
    expect(adapter.vimSnapshot.register).toBe("TableRow: row 1 row 2");
    expect(undoManager.undoStack).toHaveLength(1);
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(4);

    undoManager.clear();
    undoManager.stopCapturing();
    editor.commands.setTextSelection(textPosition(editor, "row 1"));
    for (const keys of ["d2j", "2dap"]) {
      for (const key of keys) press(editor, key);
      await runtime.flush();
      expect(editor.state.doc.firstChild?.childCount).toBe(4);
      expect(undoManager.undoStack).toHaveLength(0);
    }

    press(editor, "V");
    press(editor, "2");
    press(editor, "j");
    press(editor, "d");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe("row 4");
    expect(adapter.vimSnapshot.register).toBe("TableRow: row 1 row 2 row 3");
    expect(undoManager.undoStack).toHaveLength(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves w and b by words within and across table cells", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "alpha beta" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "gamma delta" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "alpha") + 1);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    editor.commands.setTextSelection(textPosition(editor, "alpha"));

    press(editor, "w");
    expect(editor.state.selection.from).toBe(textPosition(editor, "beta"));
    press(editor, "w");
    expect(editor.state.selection.from).toBe(textPosition(editor, "gamma"));
    press(editor, "w");
    expect(editor.state.selection.from).toBe(textPosition(editor, "delta"));
    press(editor, "b");
    expect(editor.state.selection.from).toBe(textPosition(editor, "gamma"));
    press(editor, "b");
    expect(editor.state.selection.from).toBe(textPosition(editor, "beta"));
    press(editor, "b");
    expect(editor.state.selection.from).toBe(textPosition(editor, "alpha"));

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("treats each TableRow as one Vim logical and structural line", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "H1" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "H2" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A1" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A2" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "B1" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "B2" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "H1"));
    editor.commands.focus();
    await runtime.flush();

    press(editor, "Escape");
    press(editor, "j");
    expect(editor.state.selection.from).toBe(textPosition(editor, "A1"));
    press(editor, "k");
    expect(editor.state.selection.from).toBe(textPosition(editor, "H1"));

    editor.commands.setTextSelection(textPosition(editor, "A1"));
    press(editor, "V");
    expect(editor.state.selection.empty).toBe(true);
    expect(root.querySelectorAll(".memoka-visual-line-selected")).toHaveLength(
      1,
    );
    expect(root.querySelectorAll(".memoka-table-row-selected")).toHaveLength(1);
    const selectionBefore = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    press(editor, "l");
    expect({
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }).toEqual(selectionBefore);
    expect(root.querySelectorAll(".memoka-table-row-selected")).toHaveLength(1);
    press(editor, "j");
    expect(editor.state.selection.empty).toBe(true);
    expect(root.querySelectorAll(".memoka-table-row-selected")).toHaveLength(2);
    press(editor, "k");
    expect(root.querySelectorAll(".memoka-table-row-selected")).toHaveLength(1);
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("TableRow: A1 A2");

    press(editor, "p");
    await runtime.flush();
    let table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    expect(
      Array.from(
        { length: table?.childCount ?? 0 },
        (_, index) => table?.child(index).textContent,
      ),
    ).toEqual(["H1H2", "A1A2", "A1A2", "B1B2"]);
    const rowIds = Array.from(
      { length: table?.childCount ?? 0 },
      (_, index) => table?.child(index).attrs.blockId,
    );
    expect(new Set(rowIds).size).toBe(4);
    expect(selectionAncestorBlockId(editor, "tableRow")).toBe(rowIds[2]);
    expect(
      ancestorBlockIdAt(
        editor,
        clampVimBlockCursor(editor.view, editor.state.selection.head),
        "tableRow",
      ),
    ).toBe(rowIds[2]);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(3);

    editor.commands.setTextSelection(textPosition(editor, "A1"));
    press(editor, "P");
    await runtime.flush();
    table = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: table?.childCount ?? 0 },
        (_, index) => table?.child(index).textContent,
      ),
    ).toEqual(["H1H2", "A1A2", "A1A2", "B1B2"]);
    const upperPRowIds = Array.from(
      { length: table?.childCount ?? 0 },
      (_, index) => table?.child(index).attrs.blockId,
    );
    expect(selectionAncestorBlockId(editor, "tableRow")).toBe(upperPRowIds[1]);

    press(editor, "u");
    await runtime.flush();
    editor.commands.setTextSelection(textPosition(editor, "A1"));
    press(editor, "V");
    press(editor, "d");
    await runtime.flush();
    expect(adapter.vimSnapshot.register).toBe("TableRow: A1 A2");
    expect(
      Array.from(
        { length: editor.state.doc.firstChild?.childCount ?? 0 },
        (_, index) => editor.state.doc.firstChild?.child(index).textContent,
      ),
    ).toEqual(["H1H2", "B1B2"]);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(3);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("wraps TableRow put outside a Table and deletes a one-row Table atomically", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "only row" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "only row"));
    editor.commands.focus();
    await runtime.flush();

    press(editor, "Escape");
    press(editor, "y");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("TableRow: only row");

    editor.commands.setTextSelection(textPosition(editor, "after"));
    const beforePut = editor.getJSON();
    const sourceTableIds = new Set<string>();
    sourceTableIds.add(editor.state.doc.child(1).attrs.blockId);
    editor.state.doc.child(1).descendants((node) => {
      if (typeof node.attrs.blockId === "string") {
        sourceTableIds.add(node.attrs.blockId);
      }
    });
    press(editor, "p");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(4);
    expect(editor.state.doc.child(3).type.name).toBe("table");
    expect(editor.state.doc.child(3).childCount).toBe(1);
    expect(editor.state.doc.child(3).textContent).toBe("only row");
    const pastedTableIds: string[] = [editor.state.doc.child(3).attrs.blockId];
    editor.state.doc.child(3).descendants((node) => {
      if (typeof node.attrs.blockId === "string") {
        pastedTableIds.push(node.attrs.blockId);
      }
    });
    expect(pastedTableIds).not.toHaveLength(0);
    expect(
      pastedTableIds.every((blockId) => !sourceTableIds.has(blockId)),
    ).toBe(true);
    expect(selectionAncestorBlockId(editor, "tableRow")).toBe(
      editor.state.doc.child(3).firstChild?.attrs.blockId,
    );

    press(editor, "u");
    await runtime.flush();
    expect(editor.getJSON()).toEqual(beforePut);

    editor.commands.setTextSelection(textPosition(editor, "after"));
    press(editor, "P");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(4);
    expect(editor.state.doc.child(2).type.name).toBe("table");
    expect(editor.state.doc.child(2).textContent).toBe("only row");

    press(editor, "u");
    await runtime.flush();
    expect(editor.getJSON()).toEqual(beforePut);

    editor.commands.setTextSelection(textPosition(editor, "only row"));
    press(editor, "V");
    press(editor, "d");
    await runtime.flush();
    expect(editor.state.doc.content.toJSON()).toMatchObject([
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.child(1).type.name).toBe("table");
    expect(editor.state.doc.child(1).childCount).toBe(1);
    expect(editor.state.doc.child(1).textContent).toBe("only row");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("treats yap on a ListItem as a structural register", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "first item" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "second item" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "first item") + 2);
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "y");
    press(editor, "a");
    press(editor, "p");
    expect(adapter.vimSnapshot.register).toContain("ListItem");
    press(editor, "p");
    await runtime.flush();

    const list = editor.state.doc.firstChild;
    expect(list?.childCount).toBe(3);
    expect(
      Array.from(
        { length: list?.childCount ?? 0 },
        (_, index) => list?.child(index).textContent,
      ),
    ).toEqual(["first item", "first item", "second item"]);
    const ids = Array.from(
      { length: list?.childCount ?? 0 },
      (_, index) => list?.child(index).attrs.blockId,
    );
    expect(new Set(ids).size).toBe(3);

    adapter.destroy();
    runtime.destroy();
  });

  it("deletes a Visual-line ListItem as one undoable structure", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "remove me" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "keep me" }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(textPosition(editor, "remove me"));
    editor.commands.focus();
    await runtime.flush();
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "d");
    await runtime.flush();

    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(adapter.vimSnapshot.register).toContain("ListItem");
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(
      "keep me",
    );

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(
      "remove me",
    );

    editor.commands.setTextSelection(textPosition(editor, "remove me"));
    press(editor, "V");
    press(editor, "c");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe("");
    editor.commands.insertContent("replacement");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(
      "replacement",
    );
    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(
      "remove me",
    );

    adapter.destroy();
    runtime.destroy();
  });

  it("deletes and restores a multi-block Visual-line range", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-07-27T00:00:00.000Z",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "first block" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "second block" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "third block" }],
        },
      ],
    });
    await runtime.flush();
    const originalIds = [
      editor.state.doc.child(0).attrs.blockId,
      editor.state.doc.child(1).attrs.blockId,
    ];
    editor.commands.setTextSelection(textPosition(editor, "first block"));
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "j");

    expect(adapter.vimSnapshot.mode).toBe("visual-line");
    expect(editor.state.selection.empty).toBe(true);
    expect(
      [...root.querySelectorAll(".memoka-visual-line-selected")].map(
        (node) => ({
          tagName: node.tagName,
          kind: node.getAttribute("data-vim-visual-line"),
          text: node.textContent,
        }),
      ),
    ).toEqual([
      { tagName: "P", kind: "block", text: "first block" },
      { tagName: "P", kind: "block", text: "second block" },
    ]);
    press(editor, "d");
    await runtime.flush();

    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(adapter.vimSnapshot.register).toBe(
      "block: first block second block",
    );
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe("third block");

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(
      [editor.state.doc.child(0), editor.state.doc.child(1)].map(
        (node) => node.attrs.blockId,
      ),
    ).toEqual(originalIds);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });
});
