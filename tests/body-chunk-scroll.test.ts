import { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { parseMarkdownNote } from "../app/src/editor/markdown-paste";
import {
  moveVimSelectionToViewportPosition,
  runEditorVimCommand,
} from "../app/src/vim/editor-commands";

/** Layout model for the real BodyChunk NodeViews. Activating an offscreen
 * chunk adds 720px above the visible caret, as rich paragraphs take more room
 * than the static preview. No document positions or text change. */
function harness(activeHeight = 960) {
  const note = createNoteDocument(createUuidV7());
  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";
  Object.defineProperty(scroll, "clientHeight", { value: 400 });
  const root = document.createElement("div");
  scroll.append(root);
  document.body.append(scroll);
  const editor = new Editor({
    element: root,
    extensions: productEditorExtensions(note),
  });
  const markdown =
    "# Root\n\n" +
    Array.from(
      { length: 8 },
      (_, section) =>
        `## Section ${section}\n\n` +
        Array.from(
          { length: 12 },
          (_, paragraph) => `Paragraph ${section}-${paragraph}`,
        ).join("\n\n"),
    ).join("\n\n");
  editor.commands.setContent(
    parseMarkdownNote(markdown, editor.schema, note.noteId)!.root.toJSON(),
  );
  const sections: { header: HTMLElement; chunkId: string }[] = [];
  const positions = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) positions.set(node.textContent, pos + 1);
    if (
      node.type.name === "section" &&
      node.firstChild?.textContent.startsWith("Section ")
    ) {
      sections.push({
        header: editor.view.nodeDOM(pos + 1) as HTMLElement,
        chunkId: node.child(1).firstChild!.attrs.chunkId,
      });
    }
  });
  const chunk = (index: number) =>
    editor.view.dom.querySelector<HTMLElement>(
      `[data-body-chunk-id="${sections[index]!.chunkId}"]`,
    )!;
  const chunkHeight = (index: number) =>
    chunk(index).dataset.bodyChunkVirtualized === "false" ? activeHeight : 240;
  const sectionTop = (index: number) =>
    80 +
    sections
      .slice(0, index)
      .reduce((sum, _, previous) => sum + 40 + chunkHeight(previous), 0);
  const caretTop = (position: number) => {
    const text = editor.state.doc.resolve(position).parent.textContent;
    const section = /^Section (\d+)$/u.exec(text);
    if (section) return sectionTop(Number(section[1])) - scroll.scrollTop;
    const paragraph = /^Paragraph (\d+)-(\d+)$/u.exec(text);
    if (paragraph)
      return (
        sectionTop(Number(paragraph[1])) +
        40 +
        Number(paragraph[2]) * 80 -
        scroll.scrollTop
      );
    return 0;
  };
  // WebKit/Chromium have different built-in anchoring. Disable it in this
  // deterministic harness; the separate test below simulates native anchoring.
  editor.view.dom.style.overflowAnchor = "none";
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const headerIndex = sections.findIndex(({ header }) => header === this);
      if (headerIndex >= 0)
        return new DOMRect(
          0,
          sectionTop(headerIndex) - scroll.scrollTop,
          600,
          40,
        );
      const chunkIndex = sections.findIndex(
        ({ chunkId }) => chunkId === this.dataset.bodyChunkId,
      );
      if (chunkIndex >= 0)
        return new DOMRect(
          0,
          sectionTop(chunkIndex) + 40 - scroll.scrollTop,
          600,
          chunkHeight(chunkIndex),
        );
      return new DOMRect(0, 0, 600, 400);
    });
  const revealTops: number[] = [];
  editor.registerPlugin(
    new Plugin({
      props: {
        handleScrollToSelection: (view) => {
          const top = caretTop(view.state.selection.head);
          revealTops.push(top);
          if (top < 0) scroll.scrollTop += top - 5;
          else if (top + 20 > 400) scroll.scrollTop += top + 20 - 400 + 5;
          return true;
        },
      },
    }),
  );
  editor.view.focus();
  const select = (text: string) =>
    editor.commands.setTextSelection(positions.get(text)!);
  const viewportPlugin = editor.state.plugins.find(
    (plugin) => plugin.getState(editor.state)?.activeChunkIds instanceof Set,
  )!;
  const visible = (indices: number[]) =>
    editor.view.dispatch(
      editor.state.tr
        .setMeta(viewportPlugin, {
          visibleChunkIds: indices.map((index) => sections[index]!.chunkId),
        })
        .setMeta("addToHistory", false),
    );
  const destroy = () => {
    editor.destroy();
    note.doc.destroy();
    scroll.remove();
    rectSpy.mockRestore();
  };
  return {
    editor,
    note,
    scroll,
    select,
    sections,
    sectionTop,
    caretTop,
    revealTops,
    visible,
    positions,
    destroy,
  };
}

describe("BodyChunk viewport anchoring", () => {
  it("uses visible content when an observer renders chunks before wheel correction", () => {
    const h = harness();
    try {
      h.select("Paragraph 0-0");
      const target = h.positions.get("Section 5")!;
      h.scroll.scrollTop = h.sectionTop(5) - 100;
      const hit = vi
        .spyOn(h.editor.view, "posAtCoords")
        .mockReturnValue({ pos: target, inside: -1 });
      h.visible([4, 5, 6]);
      expect(h.caretTop(target)).toBe(100);
      expect(h.editor.state.selection.$head.parent.textContent).toBe(
        "Paragraph 0-0",
      );
      hit.mockRestore();
    } finally {
      h.destroy();
    }
  });

  it("anchors the visible destination, not the departed offscreen caret, during wheel correction", () => {
    const h = harness();
    try {
      h.select("Paragraph 0-0");
      h.visible([4, 5, 6]);
      const target = h.positions.get("Paragraph 5-0")!;
      h.scroll.scrollTop = h.sectionTop(5) + 40 - 30;
      expect(h.caretTop(target)).toBe(30);
      h.revealTops.length = 0;
      const before = h.editor.state.doc;
      moveVimSelectionToViewportPosition(h.editor.view, "normal", target, null);
      expect(h.editor.state.selection.head).toBe(target);
      // Chunks around the old caret become static; keep the visible paragraph
      // in place even though its absolute offset in the document decreases.
      expect(h.caretTop(target)).toBe(30);
      expect(h.revealTops).toEqual([]);
      expect(h.editor.state.doc).toBe(before);
    } finally {
      h.destroy();
    }
  });

  it.each([50, 200])(
    "keeps k from a Section title local when an earlier chunk activates (y=%i)",
    (top) => {
      const h = harness();
      try {
        h.select("Section 3");
        h.scroll.scrollTop = h.sectionTop(3) - top;
        h.revealTops.length = 0;
        const before = h.editor.state.doc;
        const undoItems = h.note.undoManager.undoStack.length;
        runEditorVimCommand(h.editor.view, "cursor.logical-up", "normal", null);
        expect(h.editor.state.selection.$head.parent.textContent).toBe(
          "Paragraph 2-11",
        );
        expect(h.revealTops).toEqual([top - 80]);
        expect(h.caretTop(h.editor.state.selection.head)).toBe(
          top === 50 ? 5 : top - 80,
        );
        expect(h.editor.state.doc).toBe(before);
        expect(h.note.undoManager.undoStack).toHaveLength(undoItems);
      } finally {
        h.destroy();
      }
    },
  );

  it("keeps j to the next Section local when a preceding chunk becomes static", () => {
    const h = harness();
    try {
      h.select("Paragraph 2-11");
      h.scroll.scrollTop = h.sectionTop(3) - 280;
      h.revealTops.length = 0;
      runEditorVimCommand(h.editor.view, "cursor.logical-down", "normal", null);
      expect(h.editor.state.selection.$head.parent.textContent).toBe(
        "Section 3",
      );
      expect(h.revealTops).toEqual([280]);
      expect(h.caretTop(h.editor.state.selection.head)).toBe(280);
    } finally {
      h.destroy();
    }
  });

  it("preserves the visible position on observer-only activation and deactivation", () => {
    const h = harness();
    try {
      h.select("Section 3");
      h.scroll.scrollTop = h.sectionTop(3) - 200;
      const position = h.editor.state.selection.head;
      h.revealTops.length = 0;
      h.visible([0]);
      expect(h.caretTop(position)).toBe(200);
      h.visible([]);
      expect(h.caretTop(position)).toBe(200);
      expect(h.editor.state.selection.head).toBe(position);
      expect(h.revealTops).toEqual([]);
    } finally {
      h.destroy();
    }
  });

  it("does not accumulate fractional-height drift during repeated j/k", () => {
    const h = harness(960.75);
    try {
      h.select("Section 3");
      h.scroll.scrollTop = Math.round(h.sectionTop(3) - 200);
      const before = h.caretTop(h.editor.state.selection.head);
      for (let i = 0; i < 12; i++) {
        runEditorVimCommand(h.editor.view, "cursor.logical-up", "normal", null);
        runEditorVimCommand(
          h.editor.view,
          "cursor.logical-down",
          "normal",
          null,
        );
        expect(h.caretTop(h.editor.state.selection.head)).toBe(before);
      }
    } finally {
      h.destroy();
    }
  });

  it("does not compensate twice when native anchoring already preserved the position", () => {
    const h = harness();
    try {
      h.select("Section 3");
      h.scroll.scrollTop = h.sectionTop(3) - 200;
      let nativeAnchor = false;
      h.editor.registerPlugin(
        new Plugin({
          view: () => ({
            update: () => {
              if (nativeAnchor) {
                h.scroll.scrollTop += 720;
                nativeAnchor = false;
              }
            },
          }),
        }),
      );
      nativeAnchor = true;
      h.visible([0]);
      expect(h.caretTop(h.editor.state.selection.head)).toBe(200);
    } finally {
      h.destroy();
    }
  });

  it("does no anchor DOM reads for movement within active chunks or ordinary typing", () => {
    const h = harness();
    try {
      h.select("Paragraph 3-1");
      const spy = vi.spyOn(h.editor.view, "nodeDOM");
      runEditorVimCommand(h.editor.view, "cursor.logical-down", "normal", null);
      h.editor.commands.insertContent("a");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      h.destroy();
    }
  });
});
