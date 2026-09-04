import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  blockToYXml,
  createNoteDocument,
  readNotePlainText,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import { productEditorExtensions } from "../app/src/editor/extensions";
import {
  deriveEditorSectionFoldEntries,
  isPositionHiddenBySectionFold,
  revealSectionFoldsAtPosition,
  runSectionFoldCommand,
  sectionFoldCollapsedSectionIds,
} from "../app/src/editor/section-folding";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { runEditorVimCommand } from "../app/src/vim/editor-commands";
import { addSecondWindow } from "./helpers/runtime";

function paragraph(text: string) {
  return blockToYXml({
    type: "paragraph",
    blockId: createUuidV7(),
    content: [{ type: "text", text }],
  });
}

function sectionHeaderTextPosition(editor: Editor, sectionId: string): number {
  let position = -1;
  editor.state.doc.descendants((node, nodePosition) => {
    if (
      position < 0 &&
      node.type.name === "sectionHeader" &&
      node.attrs.sectionId === sectionId
    ) {
      position = nodePosition + 1;
      return false;
    }
    return position < 0;
  });
  if (position < 0) throw new Error(`Missing Section Header: ${sectionId}`);
  return position;
}

function textPosition(editor: Editor, text: string): number {
  let position = -1;
  editor.state.doc.descendants((node, nodePosition) => {
    if (position < 0 && node.isText && node.text?.includes(text)) {
      position = nodePosition + node.text.indexOf(text);
      return false;
    }
    return position < 0;
  });
  if (position < 0) throw new Error(`Missing text: ${text}`);
  return position;
}

function press(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function createNestedNote() {
  const note = createNoteDocument(
    createUuidV7(),
    [
      {
        type: "paragraph",
        blockId: createUuidV7(),
        content: [{ type: "text", text: "root body" }],
      },
    ],
    "Root",
  );
  const childId = createUuidV7();
  const grandchildId = createUuidV7();
  const siblingId = createUuidV7();
  note.doc.transact(() => {
    insertChildSection(
      note.rootSection,
      createSectionXml(
        childId,
        "Child",
        [paragraph("child body")],
        [
          createSectionXml(grandchildId, "Grandchild", [
            paragraph("grandchild body"),
          ]),
        ],
      ),
    );
    insertChildSection(
      note.rootSection,
      createSectionXml(siblingId, "Sibling", [paragraph("sibling body")]),
    );
  });
  return { note, childId, grandchildId, siblingId };
}

describe("Window-local Section folding", () => {
  it("opens, closes and recursively toggles the Section under the caret", async () => {
    const { note, childId, grandchildId, siblingId } = createNestedNote();
    const editor = new Editor({
      extensions: productEditorExtensions(note),
    });

    try {
      await Promise.resolve();
      const undoDepth = note.undoManager.undoStack.length;
      const textBefore = readNotePlainText(note);
      const entries = deriveEditorSectionFoldEntries(editor.state.doc);
      expect(entries.map(({ sectionId }) => sectionId)).toEqual([
        note.noteId,
        childId,
        grandchildId,
        siblingId,
      ]);
      expect(entries.map(({ parentSectionId }) => parentSectionId)).toEqual([
        null,
        note.noteId,
        childId,
        note.noteId,
      ]);

      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(
            editor.state.doc,
            sectionHeaderTextPosition(editor, childId),
          ),
        ),
      );
      expect(
        runSectionFoldCommand(editor.view, "close-recursive"),
      ).toMatchObject({
        handled: true,
        changed: true,
        targetSectionId: childId,
      });
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual(
        [childId, grandchildId].sort(),
      );

      runSectionFoldCommand(editor.view, "open");
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([
        grandchildId,
      ]);
      runSectionFoldCommand(editor.view, "open-recursive");
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([]);

      runSectionFoldCommand(editor.view, "toggle-recursive");
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual(
        [childId, grandchildId].sort(),
      );
      runSectionFoldCommand(editor.view, "toggle-recursive");
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([]);

      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(
            editor.state.doc,
            sectionHeaderTextPosition(editor, note.noteId),
          ),
        ),
      );
      runSectionFoldCommand(editor.view, "close");
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([
        note.noteId,
      ]);
      expect(note.undoManager.undoStack).toHaveLength(undoDepth);
      expect(readNotePlainText(note)).toBe(textBefore);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("keeps hidden content out of caret motion while retaining it in Note search", async () => {
    const { note, childId } = createNestedNote();
    const editor = new Editor({
      extensions: productEditorExtensions(note, {
        collapsedSectionIds: [childId],
      }),
    });

    try {
      await Promise.resolve();
      let childBody = textPosition(editor, "child body");
      expect(isPositionHiddenBySectionFold(editor.state, childBody)).toBe(true);
      const childHeader = sectionHeaderTextPosition(editor, childId);
      editor.view.dispatch(editor.state.tr.insertText("X", childHeader));
      childBody = textPosition(editor, "child body");
      expect(isPositionHiddenBySectionFold(editor.state, childBody)).toBe(true);
      expect(
        editor.view.dom.querySelector<HTMLElement>(
          `[data-section-id="${childId}"]`,
        )?.textContent,
      ).toBe("XChild");
      const visibleLinePositions = defaultVimBlockSemantics
        .logicalLines(editor.view)
        .map(({ blockPosition }) => blockPosition);
      expect(
        visibleLinePositions.some((position) =>
          isPositionHiddenBySectionFold(editor.state, position),
        ),
      ).toBe(false);

      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, childBody),
        ),
      );
      expect(
        isPositionHiddenBySectionFold(
          editor.state,
          editor.state.selection.head,
        ),
      ).toBe(false);
      const childEntry = deriveEditorSectionFoldEntries(editor.state.doc).find(
        ({ sectionId }) => sectionId === childId,
      )!;
      expect(editor.state.selection.head).toBeGreaterThanOrEqual(
        childEntry.headerFrom + 1,
      );
      expect(editor.state.selection.head).toBeLessThan(childEntry.headerTo);
      const textBeforeOpen = readNotePlainText(note);
      expect(
        runEditorVimCommand(editor.view, "line.open-below", "normal", null)
          .handled,
      ).toBe(false);
      expect(
        runEditorVimCommand(editor.view, "line.open-above", "normal", null)
          .handled,
      ).toBe(false);
      expect(readNotePlainText(note)).toBe(textBeforeOpen);

      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, childHeader + 1),
        ),
      );
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(readNotePlainText(note)).toBe(textBeforeOpen);
      expect(editor.state.selection.$from.parent.type.name).toBe(
        "sectionHeader",
      );

      const reveal = revealSectionFoldsAtPosition(editor.view, childBody);
      expect(reveal).toMatchObject({
        changed: true,
        targetSectionId: childId,
        collapsedSectionIds: [],
      });
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([]);
      expect(readNotePlainText(note)).toContain("child body");
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("marks closed Headers and hides only their body and child container", async () => {
    const { note, childId } = createNestedNote();
    const editor = new Editor({
      extensions: productEditorExtensions(note, {
        collapsedSectionIds: [childId],
      }),
    });
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    editor.view.dom.classList.add("memoka-editor");
    document.body.append(editor.view.dom);

    try {
      await Promise.resolve();
      expect(editor.view.dom.dataset.sectionFolding).toBe("true");
      const header = editor.view.dom.querySelector<HTMLElement>(
        `[data-section-id="${childId}"]`,
      );
      expect(header?.dataset.sectionFoldState).toBe("collapsed");
      expect(header?.getAttribute("aria-expanded")).toBe("false");
      expect(
        header?.nextElementSibling?.classList.contains("memoka-section-body"),
      ).toBe(true);
      expect(getComputedStyle(header!.nextElementSibling!).display).toBe(
        "none",
      );
      expect(
        header?.nextElementSibling?.nextElementSibling?.classList.contains(
          "memoka-section-children",
        ),
      ).toBe(true);
      expect(
        getComputedStyle(header!.nextElementSibling!.nextElementSibling!)
          .display,
      ).toBe("none");
      expect(css).toContain(
        '.memoka-section-header[data-section-fold-state="collapsed"]',
      );
      expect(css).toContain("~ .memoka-section-body");
      expect(css).toContain("~ .memoka-section-children");
    } finally {
      editor.view.dom.remove();
      editor.destroy();
      style.remove();
      note.doc.destroy();
    }
  });

  it("reapplies a retained fold when its Section is inserted again", async () => {
    const note = createNoteDocument(createUuidV7(), [], "Root");
    const childId = createUuidV7();
    const editor = new Editor({
      extensions: productEditorExtensions(note, {
        collapsedSectionIds: [childId],
      }),
    });

    try {
      await Promise.resolve();
      expect(sectionFoldCollapsedSectionIds(editor.state)).toEqual([childId]);
      expect(
        editor.view.dom.querySelector(`[data-section-id="${childId}"]`),
      ).toBeNull();

      note.doc.transact(() => {
        insertChildSection(
          note.rootSection,
          createSectionXml(childId, "Restored child", [
            paragraph("restored body"),
          ]),
        );
      });
      await Promise.resolve();

      expect(
        editor.view.dom.querySelector<HTMLElement>(
          `[data-section-id="${childId}"]`,
        )?.dataset.sectionFoldState,
      ).toBe("collapsed");
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("persists fold commands in only the active Window view", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      initialTitle: "Root",
    });
    const note = runtime.noteDocument;
    const childId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(childId, "Child", [paragraph("child body")]),
      );
    });
    await addSecondWindow(runtime);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const onNoteSearch = vi.fn();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
      onNoteSearch,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });

    try {
      first.editor.view.dispatch(
        first.editor.state.tr.setSelection(
          TextSelection.create(
            first.editor.state.doc,
            sectionHeaderTextPosition(first.editor, childId),
          ),
        ),
      );
      press(first.editor, "Escape");
      press(first.editor, "z");
      press(first.editor, "c");

      expect(runtime.windows.get("window-1")?.collapsedSectionIds).toEqual([
        childId,
      ]);
      expect(runtime.windows.get("window-2")?.collapsedSectionIds).toEqual([]);
      expect(
        firstRoot.querySelector<HTMLElement>(`[data-section-id="${childId}"]`)
          ?.dataset.sectionFoldState,
      ).toBe("collapsed");
      expect(
        secondRoot.querySelector<HTMLElement>(`[data-section-id="${childId}"]`)
          ?.dataset.sectionFoldState,
      ).not.toBe("collapsed");

      press(first.editor, "/");
      const origin = onNoteSearch.mock.calls[0]?.[0];
      if (!origin) throw new Error("Note search did not capture its origin");
      const navigation = await runtime.searchNote(
        "window-1",
        origin,
        "child body",
      );
      if (!navigation.destination) {
        throw new Error("Hidden search match had no destination");
      }
      first.adapter.applyNavigationDestination(
        navigation.destination,
        navigation.detail,
      );
      expect(runtime.windows.get("window-1")?.collapsedSectionIds).toEqual([]);
      expect(
        firstRoot.querySelector<HTMLElement>(`[data-section-id="${childId}"]`)
          ?.dataset.sectionFoldState,
      ).not.toBe("collapsed");
      await runtime.flush();
    } finally {
      first.adapter.destroy();
      second.adapter.destroy();
      runtime.destroy();
      firstRoot.remove();
      secondRoot.remove();
    }
  });
});
