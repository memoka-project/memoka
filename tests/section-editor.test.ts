import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection } from "@tiptap/pm/state";
import type { UndoManager } from "yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  blockToYXml,
  CORE_TRANSACTION_ORIGIN,
  readNoteTitle,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  MemoryPersistencePort,
  type PersistenceCommitRequest,
  type PersistenceCommitResponse,
} from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { isWebKitGtkRuntime } from "../app/src/editor/section-title-composition";
import {
  childSections,
  createBodyChunks,
  createSectionXml,
  findSectionById,
  insertChildSection,
  sectionBody,
  sectionId,
  sectionSnapshot,
  sectionTitle,
} from "../app/src/core/section-model";
import { addSecondWindow } from "./helpers/runtime";
import { registerFromMarkdown } from "../app/src/vim/clipboard";
import { pasteVimRegisterAtSelection } from "../app/src/vim/editor-commands";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter++;
    return createUuidV7(1_797_200_000_000 + seed, (bytes) => {
      bytes.fill((seed * 71) & 0xff);
      return bytes;
    });
  };
}

function rootElement(): HTMLDivElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function positionOf(
  editor: Editor,
  nodeName: string,
  predicate: (node: ProseMirrorNode) => boolean = () => true,
): number {
  let result = -1;
  editor.state.doc.descendants((node, position) => {
    if (result < 0 && node.type.name === nodeName && predicate(node)) {
      result = position + 1;
    }
  });
  if (result < 0) throw new Error(`Missing editor node: ${nodeName}`);
  return result;
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
  type: "compositionstart" | "compositionupdate" | "compositionend",
  data = "",
): void {
  editor.view.dom.dispatchEvent(
    new CompositionEvent(type, {
      bubbles: true,
      cancelable: true,
      data,
    }),
  );
}

interface InputTargetRange {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
}

function input(
  editor: Editor,
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null,
  targetRanges: readonly InputTargetRange[] = [],
): InputEvent {
  const event = new InputEvent(type, {
    bubbles: true,
    cancelable: type === "beforeinput",
    data,
    inputType,
    isComposing: true,
  });
  Object.defineProperty(event, "getTargetRanges", {
    configurable: true,
    value: () => targetRanges,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

function emulateWebKitGtkNavigator(): () => void {
  const properties = {
    platform: "Linux x86_64",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/60.5 Safari/605.1.15",
  } as const;
  const previous = Object.entries(properties).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, name);
    Object.defineProperty(navigator, name, {
      configurable: true,
      value,
    });
    return [name, descriptor] as const;
  });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(navigator, name, descriptor);
      else Reflect.deleteProperty(navigator, name);
    }
  };
}

function editorUndoManager(editor: Editor): UndoManager {
  for (const plugin of editor.state.plugins) {
    const pluginState = plugin.getState(editor.state) as
      { undoManager?: UndoManager } | undefined;
    if (pluginState?.undoManager) return pluginState.undoManager;
  }
  throw new Error("Yjs UndoManager not found");
}

async function settle(runtime: CoreRuntime): Promise<void> {
  await runtime.flush();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await runtime.flush();
}

function addChild(runtime: CoreRuntime, title: string, text: string): string {
  const note = runtime.noteDocument;
  const childId = createUuidV7();
  note.doc.transact(() => {
    insertChildSection(
      note.rootSection,
      createSectionXml(childId, title, [
        blockToYXml({
          type: "paragraph",
          blockId: createUuidV7(),
          content: text ? [{ type: "text", text }] : [],
        }),
      ]),
    );
  }, CORE_TRANSACTION_ORIGIN);
  return childId;
}

function addChildSection(
  parent: Y.XmlElement,
  title: string,
  children: readonly Y.XmlElement[] = [],
): string {
  const childId = createUuidV7();
  insertChildSection(
    parent,
    createSectionXml(
      childId,
      title,
      [
        blockToYXml({
          type: "paragraph",
          blockId: createUuidV7(),
          content: [{ type: "text", text: `${title} body` }],
        }),
      ],
      children,
    ),
  );
  return childId;
}

class PausedWorkspaceCommitPort extends MemoryPersistencePort {
  private armed = false;
  private held: (() => void) | null = null;
  private release: (() => void) | null = null;

  pauseNextWorkspaceCommit(): Promise<void> {
    this.armed = true;
    return new Promise((resolve) => {
      this.held = resolve;
    });
  }

  releaseWorkspaceCommit(): void {
    this.release?.();
    this.release = null;
  }

  override async commit(
    request: PersistenceCommitRequest,
  ): Promise<PersistenceCommitResponse> {
    if (this.armed && request.scope === "workspace-structure") {
      this.armed = false;
      const held = this.held;
      this.held = null;
      held?.();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return super.commit(request);
  }
}

describe("Memoka Section editor semantics", () => {
  it("round-trips a direct body paragraph with dd and p", async () => {
    const errors: Error[] = [];
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      onError: (error) => errors.push(error),
    });
    const note = runtime.noteDocument;
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "first paragraph" }],
          }),
          blockToYXml({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "second paragraph" }],
          }),
        ]),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.textContent === "first paragraph",
      ),
    );
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "d");
    press(editor, "d");
    expect(editor.getText()).not.toContain("first paragraph");
    expect(adapter.vimSnapshot.register).toContain("first paragraph");
    expect(editor.state.selection.head).toBeLessThan(
      editor.state.doc.content.size,
    );
    expect(editor.state.selection.$from.parent.textContent).toBe(
      "second paragraph",
    );
    const paste = press(editor, "p");
    expect(paste.defaultPrevented).toBe(true);
    expect(editor.getText()).toContain("first paragraph");
    await settle(runtime);

    expect(errors).toEqual([]);
    expect(sectionId(note.rootSection)).toBe(note.noteId);
    expect(
      sectionBody(note.rootSection)
        .toArray()
        .map((block) => (block instanceof Y.XmlElement ? block.toString() : ""))
        .join("\n"),
    ).toContain("first paragraph");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("puts a deleted sole body paragraph back inside the empty Section Body", async () => {
    const errors: Error[] = [];
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      onError: (error) => errors.push(error),
    });
    const note = runtime.noteDocument;
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "only paragraph" }],
          }),
        ]),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(positionOf(editor, "paragraph"));
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "d");
    press(editor, "d");
    expect(editor.state.doc.child(1).childCount).toBe(0);
    expect(press(editor, "p").defaultPrevented).toBe(true);
    await settle(runtime);

    expect(errors).toEqual([]);
    expect(editor.state.doc.child(1).childCount).toBe(1);
    expect(editor.state.doc.child(1).firstChild?.firstChild?.textContent).toBe(
      "only paragraph",
    );
    expect(editor.state.doc.child(0).attrs.sectionId).toBe(note.noteId);
    expect(sectionId(note.rootSection)).toBe(note.noteId);
    expect(sectionBody(note.rootSection).length).toBe(1);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("demotes a Section with >> as one undoable Core transaction", async () => {
    const persistence = new PausedWorkspaceCommitPort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-08-12T12:00:00.000Z",
    });
    const note = runtime.noteDocument;
    let aId = "";
    let bId = "";
    let xId = "";
    let cId = "";
    note.doc.transact(() => {
      aId = addChildSection(note.rootSection, "A");
      const x = createSectionXml((xId = createUuidV7()), "X", [
        blockToYXml({
          type: "paragraph",
          blockId: createUuidV7(),
          content: [{ type: "text", text: "X body" }],
        }),
      ]);
      bId = addChildSection(note.rootSection, "B", [x]);
      cId = addChildSection(note.rootSection, "C");
    }, CORE_TRANSACTION_ORIGIN);
    await settle(runtime);
    const root = rootElement();
    const scroll = document.createElement("div");
    scroll.scrollTop = 240;
    scroll.append(root);
    document.body.append(scroll);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
      scrollElement: scroll,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "sectionHeader",
        (node) => node.attrs.sectionId === bId,
      ),
    );
    editor.commands.focus();
    press(editor, "Escape");
    const beforeCursor = editor.state.selection.head;
    const commitHeld = persistence.pauseNextWorkspaceCommit();
    expect(
      press(editor, ">", { code: "Period", shiftKey: true }).defaultPrevented,
    ).toBe(true);
    expect(
      press(editor, ">", { code: "Period", shiftKey: true }).defaultPrevented,
    ).toBe(true);
    await commitHeld;

    try {
      expect(editor.state.selection.head).toBe(
        positionOf(
          editor,
          "sectionHeader",
          (node) => node.attrs.sectionId === bId,
        ),
      );
      // Model WebKitGTK's focused-selection scroll while the durable Core
      // transaction is still pending. It must be corrected before a frame can
      // expose the bottom-of-note position.
      scroll.scrollTop = 999;
      scroll.dispatchEvent(new Event("scroll"));
      expect(scroll.scrollTop).toBe(240);
    } finally {
      persistence.releaseWorkspaceCommit();
    }
    await settle(runtime);

    expect(scroll.scrollTop).toBe(240);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    expect(scroll.scrollTop).toBe(240);

    expect(childSections(note.rootSection).map(sectionId)).not.toContain(bId);
    const a = findSectionById(note.rootSection, aId)!;
    expect(childSections(a).map(sectionId)).toEqual([bId, xId]);
    expect(editorUndoManager(editor).undoStack).toHaveLength(1);

    expect(press(editor, "u", { code: "KeyU" }).defaultPrevented).toBe(true);
    await settle(runtime);
    expect(editor.state.selection.head).toBe(beforeCursor);
    expect(childSections(note.rootSection).map(sectionId)).toEqual([
      aId,
      bId,
      cId,
    ]);
    expect(
      childSections(findSectionById(note.rootSection, bId)!).map(sectionId),
    ).toEqual([xId]);
    expect(note.body).toBe(sectionBody(note.rootSection));
    adapter.destroy();
    runtime.destroy();
    scroll.remove();
  });

  it("shifts Section headers from Insert and Visual Line while preserving mode rules", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-08-12T12:10:00.000Z",
    });
    const note = runtime.noteDocument;
    let aId = "";
    let bId = "";
    let cId = "";
    note.doc.transact(() => {
      aId = addChildSection(note.rootSection, "A");
      bId = addChildSection(note.rootSection, "B");
      cId = addChildSection(note.rootSection, "C");
    }, CORE_TRANSACTION_ORIGIN);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const headerPosition = (targetId: string): number =>
      positionOf(
        editor,
        "sectionHeader",
        (node) => node.attrs.sectionId === targetId,
      );

    editor.commands.setTextSelection(headerPosition(bId) + 1);
    editor.commands.focus();
    expect(
      press(editor, "t", { code: "KeyT", ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    await settle(runtime);
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.selection.$from.parent.attrs.sectionId).toBe(bId);
    expect(
      childSections(findSectionById(note.rootSection, aId)!).map(sectionId),
    ).toEqual([bId]);

    press(editor, "Escape");
    expect(
      press(editor, "V", { code: "KeyV", shiftKey: true }).defaultPrevented,
    ).toBe(true);
    expect(press(editor, "j", { code: "KeyJ" }).defaultPrevented).toBe(true);
    expect(
      press(editor, "<", { code: "Comma", shiftKey: true }).defaultPrevented,
    ).toBe(true);
    await settle(runtime);
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(childSections(note.rootSection).map(sectionId)).toEqual([
      aId,
      bId,
      cId,
    ]);

    const bodyPosition = positionOf(
      editor,
      "paragraph",
      (node) => node.textContent === "A body",
    );
    editor.commands.setTextSelection(bodyPosition);
    press(editor, "V", { code: "KeyV", shiftKey: true });
    expect(
      press(editor, ">", { code: "Period", shiftKey: true }).defaultPrevented,
    ).toBe(true);
    await settle(runtime);
    expect(adapter.vimSnapshot.mode).toBe("visual-line");
    expect(childSections(note.rootSection).map(sectionId)).toEqual([
      aId,
      bId,
      cId,
    ]);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("turns a direct body Paragraph into a child Section and restores it with the opposite key", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-03T12:00:00.000Z",
    });
    const note = runtime.noteDocument;
    const firstId = createUuidV7();
    const sourceId = createUuidV7();
    const suffixId = createUuidV7();
    const existingChildId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: firstId,
            content: [{ type: "text", text: "before" }],
          }),
          blockToYXml({
            type: "paragraph",
            blockId: sourceId,
            content: [
              {
                type: "text",
                text: "styled ",
                marks: [{ type: "bold" }],
              } as never,
              {
                type: "internalSectionLink",
                targetSectionId: existingChildId,
                text: "stale title",
              },
            ],
          }),
          blockToYXml({
            type: "paragraph",
            blockId: suffixId,
            content: [{ type: "text", text: "following body" }],
          }),
        ]),
      );
      insertChildSection(
        note.rootSection,
        createSectionXml(existingChildId, "Existing"),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const before = sectionSnapshot(note.rootSection);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === sourceId,
      ) + 6,
    );
    editor.commands.focus();

    expect(
      press(editor, "t", { code: "KeyT", ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    await settle(runtime);
    const converted = sectionSnapshot(note.rootSection);
    expect(converted.body.map((value) => JSON.stringify(value))).toEqual([
      JSON.stringify(before.body[0]),
    ]);
    expect(converted.children.map(({ sectionId: id }) => id)).toEqual([
      expect.not.stringMatching(existingChildId),
      existingChildId,
    ]);
    const created = converted.children[0]!;
    expect(created.title).toBe("styled Existing");
    expect(created.body).toEqual([before.body[2]]);
    expect(JSON.stringify(created)).not.toContain('"bold"');
    expect(JSON.stringify(created)).not.toContain("internalSectionLink");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.state.selection.$from.parent.attrs.sectionId).toBe(
      created.sectionId,
    );
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "sectionHeader",
        (node) => node.attrs.sectionId === created.sectionId,
      ) + created.title.length,
    );

    expect(
      press(editor, "d", { code: "KeyD", ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection)).toEqual(before);
    expect(editor.state.selection.$from.parent.attrs.blockId).toBe(sourceId);
    expect(editor.state.selection.$from.parentOffset).toBe(6);
    expect(adapter.vimSnapshot.mode).toBe("insert");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("converts the second Paragraph created by Enter instead of its predecessor", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-04T11:00:00.000Z",
    });
    const note = runtime.noteDocument;
    const originalBlockId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: originalBlockId,
            content: [{ type: "text", text: "P1P2" }],
          }),
        ]),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === originalBlockId,
      ) + 2,
    );
    editor.commands.focus();
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    await settle(runtime);

    const paragraphs: Array<{ id: string; text: string; position: number }> =
      [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph") {
        paragraphs.push({
          id: String(node.attrs.blockId ?? ""),
          text: node.textContent,
          position: position + 1,
        });
      }
      return true;
    });
    expect(paragraphs.map(({ text }) => text)).toEqual(["P1", "P2"]);
    expect(new Set(paragraphs.map(({ id }) => id)).size).toBe(2);

    editor.commands.setTextSelection(paragraphs[1]!.position + 2);
    press(editor, "t", { code: "KeyT", ctrlKey: true });
    await settle(runtime);
    const converted = sectionSnapshot(note.rootSection);
    expect(JSON.stringify(converted.body)).toContain("P1");
    expect(JSON.stringify(converted.body)).not.toContain("P2");
    expect(converted.children[0]?.title).toBe("P2");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("turns a direct body Paragraph into a child Section with Normal >>", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-04T13:10:00.000Z",
    });
    const note = runtime.noteDocument;
    const firstBlockId = createUuidV7();
    const targetBlockId = createUuidV7();
    const suffixBlockId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: firstBlockId,
            content: [{ type: "text", text: "P1" }],
          }),
          blockToYXml({
            type: "paragraph",
            blockId: targetBlockId,
            content: [{ type: "text", text: "P2" }],
          }),
          blockToYXml({
            type: "paragraph",
            blockId: suffixBlockId,
            content: [{ type: "text", text: "P3" }],
          }),
        ]),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const before = sectionSnapshot(note.rootSection);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === targetBlockId,
      ) + 1,
    );
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, ">", { code: "Period", shiftKey: true });
    press(editor, ">", { code: "Period", shiftKey: true });
    await settle(runtime);

    const converted = sectionSnapshot(note.rootSection);
    expect(JSON.stringify(converted.body)).toContain("P1");
    expect(JSON.stringify(converted.body)).not.toContain("P2");
    expect(converted.children[0]?.title).toBe("P2");
    expect(JSON.stringify(converted.children[0]?.body)).toContain("P3");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(editor.state.selection.$from.parent.attrs.sectionId).toBe(
      converted.children[0]?.sectionId,
    );

    press(editor, "u", { code: "KeyU" });
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection)).toEqual(before);
    expect(editor.state.selection.$from.parent.attrs.blockId).toBe(
      targetBlockId,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("turns a nested direct body Paragraph into a sibling Section with Normal <<", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-04T13:20:00.000Z",
    });
    const note = runtime.noteDocument;
    const sourceSectionId = createUuidV7();
    const targetBlockId = createUuidV7();
    const existingChildId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(
          sourceSectionId,
          "Source",
          [
            blockToYXml({
              type: "paragraph",
              blockId: createUuidV7(),
              content: [{ type: "text", text: "P1" }],
            }),
            blockToYXml({
              type: "paragraph",
              blockId: targetBlockId,
              content: [{ type: "text", text: "P2" }],
            }),
            blockToYXml({
              type: "paragraph",
              blockId: createUuidV7(),
              content: [{ type: "text", text: "P3" }],
            }),
          ],
          [createSectionXml(existingChildId, "Existing child")],
        ),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const before = sectionSnapshot(note.rootSection);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === targetBlockId,
      ) + 1,
    );
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "<", { code: "Comma", shiftKey: true });
    press(editor, "<", { code: "Comma", shiftKey: true });
    await settle(runtime);

    const converted = sectionSnapshot(note.rootSection);
    expect(converted.children).toHaveLength(2);
    expect(converted.children[0]?.sectionId).toBe(sourceSectionId);
    expect(JSON.stringify(converted.children[0]?.body)).toContain("P1");
    expect(converted.children[0]?.children).toEqual([]);
    expect(converted.children[1]?.title).toBe("P2");
    expect(JSON.stringify(converted.children[1]?.body)).toContain("P3");
    expect(converted.children[1]?.children[0]?.sectionId).toBe(existingChildId);
    expect(adapter.vimSnapshot.mode).toBe("normal");

    press(editor, "u", { code: "KeyU" });
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection)).toEqual(before);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("creates a sibling Section on Ctrl-d while preserving preorder and can restore it", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-03T12:10:00.000Z",
    });
    const note = runtime.noteDocument;
    const sourceBlockId = createUuidV7();
    const childId = createUuidV7();
    const sourceSectionId = createUuidV7();
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(
          sourceSectionId,
          "Source",
          [
            blockToYXml({
              type: "paragraph",
              blockId: createUuidV7(),
              content: [{ type: "text", text: "before" }],
            }),
            blockToYXml({
              type: "paragraph",
              blockId: sourceBlockId,
              content: [{ type: "text", text: "new sibling" }],
            }),
            blockToYXml({
              type: "paragraph",
              blockId: createUuidV7(),
              content: [{ type: "text", text: "following" }],
            }),
          ],
          [createSectionXml(childId, "Existing child")],
        ),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const before = sectionSnapshot(note.rootSection);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === sourceBlockId,
      ) + 3,
    );
    editor.commands.focus();

    press(editor, "d", { code: "KeyD", ctrlKey: true });
    await settle(runtime);
    const converted = sectionSnapshot(note.rootSection);
    expect(converted.children).toHaveLength(2);
    expect(converted.children[0]!.sectionId).toBe(sourceSectionId);
    expect(converted.children[0]!.children).toEqual([]);
    expect(converted.children[1]!.title).toBe("new sibling");
    expect(converted.children[1]!.children[0]!.sectionId).toBe(childId);
    expect(JSON.stringify(converted.children[1]!.body)).toContain("following");

    press(editor, "t", { code: "KeyT", ctrlKey: true });
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection)).toEqual(before);
    expect(editor.state.selection.$from.parent.attrs.blockId).toBe(
      sourceBlockId,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("serializes Editor input behind an in-flight Paragraph conversion without losing Undo", async () => {
    const persistence = new PausedWorkspaceCommitPort();
    const errors: Error[] = [];
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-09-04T12:00:00.000Z",
      onError: (error) => errors.push(error),
    });
    const note = runtime.noteDocument;
    const paragraphBlockId = createUuidV7();
    note.doc.transact(() => {
      note.body.delete(0, note.body.length);
      note.body.insert(
        0,
        createBodyChunks([
          blockToYXml({
            type: "paragraph",
            blockId: paragraphBlockId,
            content: [{ type: "text", text: "section title" }],
          }),
        ]),
      );
    }, CORE_TRANSACTION_ORIGIN);
    const before = sectionSnapshot(note.rootSection);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "paragraph",
        (node) => node.attrs.blockId === paragraphBlockId,
      ) + "section title".length,
    );
    editor.commands.focus();

    const commitHeld = persistence.pauseNextWorkspaceCommit();
    press(editor, "t", { code: "KeyT", ctrlKey: true });
    await commitHeld;
    expect(sectionSnapshot(note.rootSection).children[0]?.title).toBe(
      "section title",
    );

    // WebKit may deliver the next edit while the async Core commit is still
    // crossing the Tauri persistence boundary.
    editor.commands.insertContent("!");
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    persistence.releaseWorkspaceCommit();
    await settle(runtime);

    expect(errors).toEqual([]);
    expect(editorUndoManager(editor).undoStack).toHaveLength(2);
    press(editor, "d", { code: "KeyD", ctrlKey: true });
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection).children).toHaveLength(1);
    expect(editor.state.doc.textContent).toContain("!");
    press(editor, "Escape");
    press(editor, "u", { code: "KeyU" });
    await settle(runtime);
    press(editor, "u", { code: "KeyU" });
    await settle(runtime);
    expect(sectionSnapshot(note.rootSection)).toEqual(before);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("uses a Normal count for following Section headers instead of intervening body rows", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-08-12T12:20:00.000Z",
    });
    const note = runtime.noteDocument;
    let aId = "";
    let bId = "";
    let cId = "";
    note.doc.transact(() => {
      aId = addChildSection(note.rootSection, "A");
      bId = addChildSection(note.rootSection, "B");
      cId = addChildSection(note.rootSection, "C");
    }, CORE_TRANSACTION_ORIGIN);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(
      positionOf(
        editor,
        "sectionHeader",
        (node) => node.attrs.sectionId === bId,
      ),
    );
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "2", { code: "Digit2" });
    press(editor, ">", { code: "Period", shiftKey: true });
    press(editor, ">", { code: "Period", shiftKey: true });
    await settle(runtime);

    expect(childSections(note.rootSection).map(sectionId)).toEqual([aId]);
    expect(
      childSections(findSectionById(note.rootSection, aId)!).map(sectionId),
    ).toEqual([bId, cId]);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("rebinds another Window focused on a Section moved by depth editing", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
      clock: () => "2026-08-12T12:30:00.000Z",
    });
    await addSecondWindow(runtime);
    const note = runtime.noteDocument;
    let aId = "";
    let bId = "";
    note.doc.transact(() => {
      aId = addChildSection(note.rootSection, "A");
      bId = addChildSection(note.rootSection, "B");
    }, CORE_TRANSACTION_ORIGIN);
    await runtime.focusSection("window-2", note.noteId, bId);
    const firstRoot = rootElement();
    const secondRoot = rootElement();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    expect(second.editor.view.dom.dataset.memokaMarkupHeading).toBe("2");
    first.editor.commands.setTextSelection(
      positionOf(
        first.editor,
        "sectionHeader",
        (node) => node.attrs.sectionId === bId,
      ),
    );
    first.editor.commands.focus();
    press(first.editor, "Escape");
    press(first.editor, ">", { code: "Period", shiftKey: true });
    press(first.editor, ">", { code: "Period", shiftKey: true });
    await settle(runtime);

    expect(second.adapter.editor.view.dom.dataset.sectionId).toBe(bId);
    expect(second.adapter.editor.view.dom.dataset.memokaMarkupHeading).toBe(
      "3",
    );
    expect(second.adapter.editor.getText()).toContain("B body");
    second.adapter.editor.commands.setTextSelection(
      positionOf(second.adapter.editor, "paragraph"),
    );
    second.adapter.editor.commands.insertContent("edited ");
    await settle(runtime);
    expect(
      sectionBody(findSectionById(note.rootSection, bId)!).toString(),
    ).toContain("edited B body");
    expect(
      childSections(findSectionById(note.rootSection, aId)!).map(sectionId),
    ).toEqual([bId]);

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });
  it("turns exact keyboard '# ' at a direct-body paragraph into a child Section", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const paragraph = positionOf(editor, "paragraph");
    editor.commands.setTextSelection(paragraph);
    editor.commands.insertContent("#");
    const insertion = editor.state.selection.from;
    let handled = false;
    editor.view.someProp("handleTextInput", (handler) => {
      if (
        handler(editor.view, insertion, insertion, " ", () =>
          editor.state.tr.insertText(" ", insertion),
        )
      ) {
        handled = true;
        return true;
      }
      return false;
    });
    expect(handled).toBe(true);
    expect(editor.state.doc.child(1).type.name).toBe("sectionBody");
    expect(editor.state.doc.child(1).childCount).toBe(0);
    expect(editor.state.doc.child(2).type.name).toBe("sectionChildren");
    expect(editor.state.doc.child(2).childCount).toBe(1);
    const child = editor.state.doc.child(2).child(0);
    expect(child.type.name).toBe("section");
    expect(child.child(0).textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("sectionHeader");
    editor.commands.insertContent("New Section");
    await settle(runtime);

    const persistedChild = childSections(runtime.noteDocument.rootSection)[0]!;
    expect(sectionTitle(persistedChild)).toBe("New Section");
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === runtime.noteId)
        ?.title,
    ).toBe("Root");
    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps existing child Section identities when '# ' creates a sibling", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    const existingChildId = addChild(runtime, "Existing", "existing body");
    const existingChild = findSectionById(
      runtime.noteDocument.rootSection,
      existingChildId,
    );
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const paragraph = positionOf(editor, "paragraph");
    editor.commands.setTextSelection(paragraph);
    editor.commands.insertContent("#");
    const insertion = editor.state.selection.from;
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, insertion, insertion, " ", () =>
        editor.state.tr.insertText(" ", insertion),
      ),
    );
    await settle(runtime);

    expect(childSections(runtime.noteDocument.rootSection)).toHaveLength(2);
    expect(
      findSectionById(runtime.noteDocument.rootSection, existingChildId),
    ).toBe(existingChild);
    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("splits a Section title into its title and first body paragraph on Enter as one Undo unit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "TitleSuffix",
    });
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(1 + "Title".length);
    editor.commands.focus();
    const enter = press(editor, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    await settle(runtime);
    expect(readNoteTitle(runtime.noteDocument)).toBe("Title");
    expect(editor.state.doc.child(1).firstChild?.textContent).toBe("Suffix");
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === runtime.noteId)
        ?.title,
    ).toBe("Title");

    expect(editor.commands.undo()).toBe(true);
    await settle(runtime);
    expect(readNoteTitle(runtime.noteDocument)).toBe("TitleSuffix");
    expect(editor.state.doc.child(1).firstChild?.textContent).toBe("");
    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("lets an active IME confirmation reach ProseMirror without splitting the Section title", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "",
    });
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    editor.commands.setTextSelection(positionOf(editor, "sectionHeader"));
    editor.commands.focus();
    let bubbled = false;
    root.addEventListener("keydown", () => {
      bubbled = true;
    });

    composition(editor, "compositionstart");
    const confirm = press(editor, "Enter", { isComposing: false });
    expect(confirm.defaultPrevented).toBe(false);
    expect(bubbled).toBe(true);
    editor.commands.insertContent("日本語");
    composition(editor, "compositionend", "日本語");
    await settle(runtime);

    expect(readNoteTitle(runtime.noteDocument)).toBe("日本語");
    expect(editor.state.doc.child(1).firstChild?.textContent).toBe("");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("recognizes WebKitGTK without treating Linux Chromium as affected", () => {
    expect(
      isWebKitGtkRuntime({
        platform: "Linux x86_64",
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/60.5 Safari/605.1.15",
      }),
    ).toBe(true);
    expect(
      isWebKitGtkRuntime({
        platform: "Linux x86_64",
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      }),
    ).toBe(false);
  });

  it("keeps WebKitGTK composition in a Section title through confirmation", async () => {
    const restoreNavigator = emulateWebKitGtkNavigator();
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "",
    });
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    try {
      editor.commands.setTextSelection(positionOf(editor, "sectionHeader"));
      editor.commands.focus();

      composition(editor, "compositionstart");
      editor.commands.insertContent("日本語");
      const beforeActiveEnter = editor.state.doc;
      let activeEnterTransactions = 0;
      editor.on("transaction", () => {
        activeEnterTransactions += 1;
      });
      const activeConfirmationEnter = press(editor, "Enter", {
        isComposing: false,
      });
      expect(activeConfirmationEnter.defaultPrevented).toBe(false);
      expect(activeEnterTransactions).toBe(0);
      expect(editor.state.doc).toBe(beforeActiveEnter);

      const header = root.querySelector<HTMLElement>(
        "header[data-section-header]",
      );
      const provisional = Array.from(header?.childNodes ?? []).find(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE && node.textContent === "日本語",
      );
      expect(header).not.toBeNull();
      expect(provisional).toBeDefined();
      if (!header || !provisional) throw new Error("Missing provisional title");

      input(editor, "beforeinput", "deleteCompositionText", null, [
        {
          startContainer: provisional,
          startOffset: 0,
          endContainer: provisional,
          endOffset: provisional.length,
        },
      ]);
      const sentinel = provisional.previousSibling;
      expect(sentinel?.textContent).toBe("\u200b");
      if (!(sentinel instanceof Text)) throw new Error("Missing IME sentinel");

      // Model WebKit's destructive half of composition confirmation. The
      // browser may merge its text nodes, but the Header remains mounted and
      // the input handler still removes the marker from the merged node.
      provisional.data = sentinel.data;
      sentinel.remove();
      expect(header.textContent).toBe("\u200b");
      expect(header.isConnected).toBe(true);
      input(editor, "input", "deleteCompositionText", null);
      expect(header.textContent).toBe("");
      expect(header.isConnected).toBe(true);

      // WebKit's following insertFromComposition targets that same Header.
      header.append(document.createTextNode("日本語"));
      input(editor, "beforeinput", "insertFromComposition", "日本語");
      input(editor, "input", "insertFromComposition", "日本語");
      composition(editor, "compositionend", "日本語");
      const beforeConfirmation = editor.state.doc;
      let transactions = 0;
      editor.on("transaction", () => {
        transactions += 1;
      });

      const confirmationEnter = press(editor, "Enter", {
        isComposing: false,
      });

      expect(confirmationEnter.defaultPrevented).toBe(true);
      expect(transactions).toBe(0);
      expect(editor.state.doc).toBe(beforeConfirmation);
      expect(readNoteTitle(runtime.noteDocument)).toBe("日本語");
      expect(editor.state.selection.$from.parent.type.name).toBe(
        "sectionHeader",
      );
      expect(editor.state.doc.child(1).firstChild?.textContent).toBe("");

      // jsdom identifies itself as Safari, whose built-in ProseMirror guard
      // has its own 500 ms window. After that test-environment-only window,
      // the intentional next Enter proves Memoka's guard was one-shot.
      await new Promise((resolve) => window.setTimeout(resolve, 510));
      const intentionalEnter = press(editor, "Enter");
      expect(intentionalEnter.defaultPrevented).toBe(true);
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    } finally {
      adapter.destroy();
      runtime.destroy();
      root.remove();
      restoreNavigator();
    }
  });

  it("preserves the mounted Section identity when a rich paste replaces its content", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    await addSecondWindow(runtime);
    const firstRoot = rootElement();
    const secondRoot = rootElement();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    const register = registerFromMarkdown(
      "# Replacement\n\nDirect body",
      first.editor.schema,
    );
    expect(register).not.toBeNull();
    first.editor.view.dispatch(
      first.editor.state.tr.setSelection(
        new AllSelection(first.editor.state.doc),
      ),
    );
    expect(pasteVimRegisterAtSelection(first.editor.view, register!)).toBe(
      true,
    );
    await settle(runtime);

    expect(first.editor.state.doc.firstChild?.attrs.sectionId).toBe(
      runtime.noteId,
    );
    expect(second.editor.state.doc.firstChild?.attrs.sectionId).toBe(
      runtime.noteId,
    );
    expect(sectionId(runtime.noteDocument.rootSection)).toBe(runtime.noteId);
    expect(second.editor.getText()).toBe(first.editor.getText());

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("restores a surviving child Section's ID when node markup drops the attribute", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    const childId = createUuidV7();
    runtime.noteDocument.doc.transact(() => {
      insertChildSection(
        runtime.noteDocument.rootSection,
        createSectionXml(childId, "Stable child", [
          blockToYXml({
            type: "paragraph",
            blockId: createUuidV7(),
            content: [{ type: "text", text: "body" }],
          }),
        ]),
      );
    }, Symbol("persist-child-fixture"));
    await settle(runtime);
    const root = rootElement();
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    let headerPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (
        headerPosition < 0 &&
        node.type.name === "sectionHeader" &&
        node.attrs.sectionId === childId
      ) {
        headerPosition = position;
      }
    });
    expect(headerPosition).toBeGreaterThan(0);
    const header = editor.state.doc.nodeAt(headerPosition)!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(headerPosition, undefined, {
        ...header.attrs,
        sectionId: null,
      }),
    );
    expect(editor.state.doc.nodeAt(headerPosition)?.attrs.sectionId).toBe(
      childId,
    );
    expect(
      sectionId(findSectionById(runtime.noteDocument.rootSection, childId)!),
    ).toBe(childId);
    await settle(runtime);

    const noteId = runtime.noteId;
    adapter.destroy();
    runtime.destroy();
    root.remove();
    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
    });
    expect(
      sectionId(findSectionById(reopened.noteDocument.rootSection, childId)!),
    ).toBe(childId);
    expect(reopened.noteId).toBe(noteId);
    reopened.destroy();
  });

  it("mounts only each Window's focused subtree while sharing content and Undo", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    await addSecondWindow(runtime);
    const firstSectionId = addChild(runtime, "First", "first body");
    const secondSectionId = addChild(runtime, "Second", "second body");
    const undoBefore = runtime.noteDocument.undoManager.undoStack.length;
    await runtime.focusSection("window-1", runtime.noteId, firstSectionId);
    await runtime.focusSection("window-2", runtime.noteId, secondSectionId);
    expect(runtime.noteDocument.undoManager.undoStack).toHaveLength(undoBefore);

    const firstRoot = rootElement();
    const secondRoot = rootElement();
    const first = runtime.editorForTesting("window-1", firstRoot, {
      directBodyOnly: false,
    });
    const second = runtime.editorForTesting("window-2", secondRoot, {
      directBodyOnly: false,
    });
    expect(first.editor.view.dom.dataset.sectionId).toBe(firstSectionId);
    expect(second.editor.view.dom.dataset.sectionId).toBe(secondSectionId);
    expect(first.editor.getText()).toContain("first body");
    expect(first.editor.getText()).not.toContain("second body");
    expect(second.editor.getText()).toContain("second body");
    expect(second.editor.getText()).not.toContain("first body");

    const firstParagraph = positionOf(first.editor, "paragraph");
    first.editor.commands.insertContentAt(firstParagraph, "edited ");
    await settle(runtime);
    const firstSection = findSectionById(
      runtime.noteDocument.rootSection,
      firstSectionId,
    );
    expect(firstSection).not.toBeNull();
    expect(sectionBody(firstSection!).toString()).toContain(
      "edited first body",
    );
    expect(second.editor.getText()).not.toContain("edited");
    expect(second.editor.commands.undo()).toBe(true);
    await settle(runtime);
    expect(sectionBody(firstSection!).toString()).not.toContain("edited");

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("copies a Visual-line Section subtree with fresh IDs and moves a cut subtree across NoteDocs", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Source note",
    });
    const sourceNoteId = runtime.noteId;
    const childId = addChild(runtime, "Movable", "payload");
    const root = rootElement();
    const source = runtime.editorForTesting("window-1", root, {
      directBodyOnly: false,
    });
    const childHeader = positionOf(
      source.editor,
      "sectionHeader",
      (node) => node.attrs.sectionId === childId,
    );
    source.editor.commands.setTextSelection(childHeader);
    source.editor.commands.focus();
    press(source.editor, "Escape");
    press(source.editor, "V", { shiftKey: true });
    press(source.editor, "y");
    expect(runtime.vimRegister.read(source.editor.schema)).toMatchObject({
      kind: "section",
      transfer: "copy",
      sourceNoteId,
      sectionIds: [childId],
    });
    press(source.editor, "P", { shiftKey: true });
    await settle(runtime);
    const copiedIds = childSections(runtime.noteDocument.rootSection).map(
      sectionId,
    );
    expect(copiedIds).toHaveLength(2);
    expect(copiedIds).toContain(childId);
    expect(new Set(copiedIds).size).toBe(2);

    const originalHeader = positionOf(
      source.editor,
      "sectionHeader",
      (node) => node.attrs.sectionId === childId,
    );
    source.editor.commands.setTextSelection(originalHeader);
    press(source.editor, "V", { shiftKey: true });
    press(source.editor, "d");
    await settle(runtime);
    expect(runtime.vimRegister.read(source.editor.schema)).toMatchObject({
      kind: "section",
      transfer: "cut",
      sectionIds: [childId],
    });
    expect(
      findSectionById(runtime.noteDocument.rootSection, childId),
    ).toBeNull();

    const target = await runtime.createNoteAtEnd("window-1", "Target note");
    source.adapter.destroy();
    root.remove();
    const targetRoot = rootElement();
    const targetEditor = runtime.editorForTesting("window-1", targetRoot, {
      directBodyOnly: false,
    });
    targetEditor.editor.commands.focus();
    press(targetEditor.editor, "Escape");
    press(targetEditor.editor, "p");
    await settle(runtime);
    expect(runtime.vimRegister.read(targetEditor.editor.schema)).toBeNull();
    const targetDocument = runtime.getNoteHandle(target.noteId).current;
    const sourceDocument = runtime.getNoteHandle(sourceNoteId).current;
    if (targetDocument.kind !== "note" || sourceDocument.kind !== "note") {
      throw new Error("Expected source and target NoteDocs");
    }
    const targetSection = findSectionById(targetDocument.rootSection, childId);
    expect(targetSection).not.toBeNull();
    expect(sectionTitle(targetSection!)).toBe("Movable");
    expect(sectionBody(targetSection!).toString()).toContain("payload");
    expect(findSectionById(sourceDocument.rootSection, childId)).toBeNull();

    targetEditor.adapter.destroy();
    runtime.destroy();
    targetRoot.remove();
  });

  it("puts a yanked Section-and-body selection beside a Focused Section", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      initialTitle: "Root",
    });
    const sourceId = addChild(runtime, "Source", "source body");
    const targetId = addChild(runtime, "Target", "target body");
    const fullRoot = rootElement();
    const full = runtime.editorForTesting("window-1", fullRoot, {
      directBodyOnly: false,
    });
    const sourceHeader = positionOf(
      full.editor,
      "sectionHeader",
      (node) => node.attrs.sectionId === sourceId,
    );
    full.editor.commands.setTextSelection(sourceHeader);
    full.editor.commands.focus();
    press(full.editor, "Escape");
    press(full.editor, "V", { shiftKey: true });
    press(full.editor, "j");
    press(full.editor, "y");
    expect(runtime.vimRegister.read(full.editor.schema)).toMatchObject({
      kind: "section",
      transfer: "copy",
      sectionIds: [sourceId],
    });
    const fullTargetHeader = positionOf(
      full.editor,
      "sectionHeader",
      (node) => node.attrs.sectionId === targetId,
    );
    full.editor.commands.setTextSelection(fullTargetHeader);
    press(full.editor, "P", { shiftKey: true });
    await settle(runtime);
    expect(
      childSections(runtime.noteDocument.rootSection).map(sectionTitle),
    ).toEqual(["Source", "Source", "Target"]);
    expect(
      childSections(
        findSectionById(runtime.noteDocument.rootSection, targetId)!,
      ),
    ).toHaveLength(0);
    press(full.editor, "u");
    await settle(runtime);
    expect(
      childSections(runtime.noteDocument.rootSection).map(sectionTitle),
    ).toEqual(["Source", "Target"]);
    full.adapter.destroy();
    fullRoot.remove();

    await runtime.focusSection("window-1", runtime.noteId, targetId);
    const focusedRoot = rootElement();
    const focused = runtime.editorForTesting("window-1", focusedRoot, {
      directBodyOnly: false,
    });
    const targetHeader = positionOf(
      focused.editor,
      "sectionHeader",
      (node) => node.attrs.sectionId === targetId,
    );
    focused.editor.commands.setTextSelection(targetHeader);
    focused.editor.commands.focus();
    press(focused.editor, "Escape");
    press(focused.editor, "P", { shiftKey: true });
    await settle(runtime);

    const rootChildren = childSections(runtime.noteDocument.rootSection);
    expect(rootChildren.map(sectionTitle)).toEqual([
      "Source",
      "Source",
      "Target",
    ]);
    const target = findSectionById(runtime.noteDocument.rootSection, targetId);
    expect(target).not.toBeNull();
    expect(childSections(target!)).toHaveLength(0);
    expect(new Set(rootChildren.map(sectionId)).size).toBe(3);

    press(focused.editor, "u");
    await settle(runtime);
    expect(
      childSections(runtime.noteDocument.rootSection).map(sectionTitle),
    ).toEqual(["Source", "Target"]);

    focused.adapter.destroy();
    runtime.destroy();
    focusedRoot.remove();
  });
});
