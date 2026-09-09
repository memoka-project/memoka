import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it, vi } from "vitest";
import { findViewportCaretPosition } from "../app/src/vim/viewport-caret";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    image: { group: "block", atom: true },
    text: { group: "inline" },
  },
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
