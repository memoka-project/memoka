import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it, vi } from "vitest";
import {
  findViewportCaretPosition,
  revealNormalLogicalLine,
} from "../app/src/vim/viewport-caret";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    image: { group: "block", atom: true },
    text: { group: "inline" },
  },
});

describe("Normal logical-line reveal", () => {
  it.each([
    [70, 130, 70, 35],
    [10, 70, 10, 0],
    [-20, 40, 0, -25],
    [70, 370, 70, 65],
    [-150, 150, 70, 15],
  ])("reveals line %s..%s with caret at %s", (top, bottom, caretTop, delta) => {
    const scroll = document.createElement("div");
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 100),
    );
    Object.defineProperty(scroll, "scrollHeight", { value: 2000 });
    Object.defineProperty(scroll, "clientHeight", { value: 100 });
    scroll.scrollTop = 500;
    const state = EditorState.create({
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("abcdef")),
      ]),
    });
    const view = {
      state,
      coordsAtPos: (pos: number) => ({
        left: 0,
        right: 10,
        top:
          pos === 1
            ? top
            : pos === 7
              ? bottom - 20
              : pos > 3
                ? caretTop + 20
                : caretTop,
        bottom:
          pos === 1
            ? top + 20
            : pos === 7
              ? bottom
              : pos > 3
                ? caretTop + 40
                : caretTop + 20,
      }),
    };
    expect(revealNormalLogicalLine(view, scroll, 3)).toBe(true);
    expect(scroll.scrollTop).toBe(500 + delta);
    expect(state.selection.from).toBe(1);
  });
});

function harness() {
  const dom = document.createElement("div");
  const viewport = new DOMRect(0, 0, 500, 100);
  const state = EditorState.create({
    doc: schema.node("doc", null, [
      schema.node("image"),
      schema.node("paragraph", null, schema.text("abcdef")),
    ]),
  });
  vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(viewport);
  const posAtCoords = vi.fn<EditorView["posAtCoords"]>(() => ({
    pos: 2,
    inside: -1,
  }));
  const caret = { cursor: 2, top: -30, left: 120, height: 20, width: 10 };
  return { view: { dom, state, posAtCoords }, viewport, caret };
}

describe("viewport caret target selection", () => {
  it("validates the normalized character, not the unnormalized wrapped-line hit", () => {
    const h = harness();
    const resolve = vi.fn((pos: number) => (pos === 2 ? 3 : pos));
    h.view.posAtCoords.mockImplementation(({ top }) => ({
      pos: top < 25 ? 2 : 4,
      inside: -1,
    }));
    const measure = (cursor: number) => ({
      ...h.caret,
      cursor,
      top: cursor === 3 ? -2 : 28,
    });
    expect(
      findViewportCaretPosition(h.view, h.viewport, h.caret, resolve, measure),
    ).toBe(4);
  });

  it("can select the frame of an image taller than the viewport", () => {
    const h = harness();
    h.view.posAtCoords.mockReturnValue({ pos: 0, inside: -1 });
    expect(
      findViewportCaretPosition(
        h.view,
        h.viewport,
        h.caret,
        (position) => position,
        (cursor) => ({ ...h.caret, cursor, top: -100, height: 900 }),
      ),
    ).toBe(0);
  });

  it("prefers a fully visible row to a partially visible large image", () => {
    const h = harness();
    h.view.posAtCoords.mockImplementation(({ top }) => ({
      pos: top < 60 ? 0 : 2,
      inside: -1,
    }));
    expect(
      findViewportCaretPosition(
        h.view,
        h.viewport,
        h.caret,
        (position) => position,
        (cursor) => ({
          ...h.caret,
          cursor,
          top: cursor === 0 ? -900 : 75,
          height: cursor === 0 ? 970 : 20,
        }),
      ),
    ).toBe(2);
  });

  it("bounds hit testing and measures each normalized candidate only once during layout gaps", () => {
    const h = harness();
    const measure = vi.fn(() => null);
    expect(
      findViewportCaretPosition(
        h.view,
        new DOMRect(0, 0, 500, 3000),
        h.caret,
        (position) => position,
        measure,
      ),
    ).toBeNull();
    expect(h.view.posAtCoords.mock.calls.length).toBeLessThanOrEqual(3 * 96);
    expect(measure).toHaveBeenCalledTimes(1);
  });
});
