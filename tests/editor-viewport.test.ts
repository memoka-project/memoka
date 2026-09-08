import { Plugin } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { parseMarkdownNote } from "../app/src/editor/markdown-paste";
import { defaultVimBlockSemantics as semantics } from "../app/src/vim/block-semantics";

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Model a late content-visibility/chunk reflow separately from the command's
 * synchronous scrollIntoView. All document positions stay unchanged. */
async function harness() {
  const observers: ControlledResizeObserver[] = [];
  class ControlledResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.observed.add(target);
    }
    unobserve(target: Element) {
      this.observed.delete(target);
    }
    disconnect() {
      this.observed.clear();
    }
  }
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ControlledResizeObserver;
  const runtime = await CoreRuntime.open(new MemoryPersistencePort());
  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";
  const root = document.createElement("div");
  scroll.append(root);
  document.body.append(scroll);
  const { adapter, editor } = runtime.editorForTesting("window-1", root, {
    directBodyOnly: false,
    scrollElement: scroll,
    requestImeOff: () => ({ supported: true, inactive: true, detail: "test" }),
    setNormalModeImeGuardActive: () => {},
  });
  const markdown =
    "# Note\n\n" +
    Array.from(
      { length: 6 },
      (_, section) =>
        `## Section ${section}\n\n` +
        Array.from(
          { length: 5 },
          (_, line) => `Paragraph ${section}-${line}`,
        ).join("\n\n"),
    ).join("\n\n");
  editor.commands.setContent(
    parseMarkdownNote(markdown, editor.schema, runtime.noteId)!.root.toJSON(),
  );
  const lines = semantics.logicalLines(editor.view);
  const start = (index: number) => lines[index]!.cursorPositions[0]!;
  let layoutShift = 0;
  const top = (index: number) => index * 20 + layoutShift - scroll.scrollTop;
  const caretRect = (position: number) => {
    const y = top(semantics.currentLineIndex(lines, position));
    return { left: 40, right: 40, top: y, bottom: y + 18 };
  };
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 100),
  );
  vi.spyOn(editor.view.dom, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 0, 460, 800),
  );
  vi.spyOn(editor.view, "coordsAtPos").mockImplementation(caretRect);
  vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ top: y }) => ({
    pos: start(
      Math.max(
        0,
        Math.min(
          lines.length - 1,
          Math.floor((y + scroll.scrollTop - layoutShift) / 20),
        ),
      ),
    ),
    inside: -1,
  }));
  editor.registerPlugin(
    new Plugin({
      props: {
        handleScrollToSelection: (view) => {
          const caret = caretRect(view.state.selection.head);
          if (caret.top < 0) scroll.scrollTop += caret.top - 5;
          else if (caret.bottom > 100) scroll.scrollTop += caret.bottom - 95;
          return true;
        },
      },
    }),
  );
  const press = (...keys: string[]) => {
    for (const key of keys)
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
  };
  editor.view.focus();
  press("Escape", "g", "g");
  await frame(); // Finish Window-local scroll restoration and initial reveal.
  const reflow = (shift: number, notification: "scroll" | "resize") => {
    layoutShift = shift;
    if (notification === "scroll") scroll.dispatchEvent(new Event("scroll"));
    else
      for (const observer of observers) {
        if (observer.observed.has(root)) observer.callback([], observer);
      }
  };
  const expectVisible = () => {
    const caret = caretRect(editor.state.selection.head);
    expect(caret.top).toBeGreaterThanOrEqual(0);
    expect(caret.bottom).toBeLessThanOrEqual(100);
  };
  return {
    runtime,
    adapter,
    editor,
    scroll,
    lines,
    start,
    press,
    reflow,
    expectVisible,
    destroy() {
      adapter.destroy();
      runtime.destroy();
      scroll.remove();
      vi.restoreAllMocks();
      globalThis.ResizeObserver = originalResizeObserver;
    },
  };
}

describe("Editor viewport scroll intent", () => {
  it.each(["scroll", "resize"] as const)(
    "keeps G at the last logical line after a delayed layout change (%s)",
    async (notification) => {
      const h = await harness();
      try {
        const before = h.editor.state.doc;
        const note = h.runtime.getNoteHandle(h.runtime.noteId).current;
        if (note.kind !== "note") throw new Error("Expected NoteDoc");
        const undoItems = note.undoManager.undoStack.length;
        h.press("G");
        const last = h.start(h.lines.length - 1);
        expect(h.editor.state.selection.head).toBe(last);
        h.expectVisible();
        // Let the initial command reveal finish first. The later resize alone
        // must also reconcile, even if the browser emits no scroll event.
        await frame();
        h.reflow(240, notification);
        await frame();
        expect(h.editor.state.selection.head).toBe(last);
        expect(h.adapter.vimSnapshot.action).toBe(
          "cursor:document-end:changed",
        );
        h.expectVisible();
        expect(h.editor.state.doc).toBe(before);
        expect(note.undoManager.undoStack).toHaveLength(undoItems);
      } finally {
        h.destroy();
      }
    },
  );

  it("preserves gg and counted G targets when layout changes in either direction", async () => {
    const h = await harness();
    try {
      h.press("G");
      await frame();
      h.reflow(240, "resize");
      await frame();
      h.press("g", "g");
      h.reflow(0, "resize");
      await frame();
      expect(h.editor.state.selection.head).toBe(h.start(0));
      h.expectVisible();
      h.press("2", "0", "G");
      h.reflow(240, "resize");
      await frame();
      expect(h.editor.state.selection.head).toBe(h.start(19));
      h.expectVisible();
    } finally {
      h.destroy();
    }
  });

  it("uses the latest motion's caret, not a saved G destination", async () => {
    const h = await harness();
    try {
      h.press("G", "k");
      const destination = h.editor.state.selection.head;
      expect(destination).not.toBe(h.start(h.lines.length - 1));
      h.reflow(240, "resize");
      await frame();
      expect(h.editor.state.selection.head).toBe(destination);
      h.expectVisible();
    } finally {
      h.destroy();
    }
  });

  it.each(["wheel", "touchmove", "scrollbar", "PageUp"])(
    "lets %s scrolling move the caret into the viewport after G",
    async (input) => {
      const h = await harness();
      try {
        h.press("G");
        // A user scroll wins even while the command's RAF is still pending.
        const event =
          input === "scrollbar"
            ? new MouseEvent("pointerdown", { button: 0, bubbles: true })
            : input === "PageUp"
              ? new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })
              : new Event(input, { bubbles: true });
        h.scroll.dispatchEvent(event);
        h.scroll.scrollTop = 100;
        h.scroll.dispatchEvent(new Event("scroll"));
        await frame();
        expect(h.editor.state.selection.head).toBe(h.start(9));
        expect(h.scroll.scrollTop).toBe(100);
        expect(h.adapter.vimSnapshot.mode).toBe("normal");
        h.expectVisible();
        // The next command takes ownership again.
        h.press("G");
        h.reflow(240, "resize");
        await frame();
        expect(h.editor.state.selection.head).toBe(h.start(h.lines.length - 1));
        h.expectVisible();
      } finally {
        h.destroy();
      }
    },
  );
});
