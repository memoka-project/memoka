import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { TextSelection } from "@tiptap/pm/state";
import { sinkListItem } from "@tiptap/pm/schema-list";
import * as Y from "yjs";
import {
  ReplicatedNote,
  replicateSectionSnapshot,
} from "../app/src/core/replicated-note";
import { addColumnAfter, addRowAfter, deleteColumn } from "@tiptap/pm/tables";
import { createUuidV7 } from "../app/src/core/ids";
import { ReplicatedNoteAdapter } from "../app/src/editor/replicated-note-adapter";
import { productMarkdownImportSchema } from "../app/src/editor/extensions";

const notes: ReplicatedNote[] = [],
  views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const note of notes.splice(0)) note.destroy();
});
function fresh(): ReplicatedNote {
  const note = ReplicatedNote.create(createUuidV7(), createUuidV7(), "Title");
  notes.push(note);
  return note;
}
function fork(note: ReplicatedNote): ReplicatedNote {
  const next = ReplicatedNote.load(
    note.noteId,
    createUuidV7(),
    note.snapshot(),
  );
  notes.push(next);
  return next;
}
function editor(note: ReplicatedNote): {
  adapter: ReplicatedNoteAdapter;
  view: EditorView;
} {
  const adapter = new ReplicatedNoteAdapter(
    note,
    productMarkdownImportSchema(),
  );
  const element = document.createElement("div");
  document.body.append(element);
  const view = new EditorView(element, { state: adapter.createState() });
  views.push(view);
  return { adapter, view };
}
function position(view: EditorView, id: string): number {
  let result = -1;
  view.state.doc.descendants((node, offset) => {
    if (node.attrs.blockId === id || node.attrs.sectionId === id)
      result = offset + 1;
  });
  if (result < 0) throw new Error("Missing test block");
  return result;
}
function paragraph(
  note: ReplicatedNote,
  parent = note.noteId,
  position = "a0",
  text = "abc",
): string {
  return note.createEntity("paragraph", parent, "body", position, {
    inline: [{ type: "text", text }],
  });
}
function content(note: ReplicatedNote, id: string): string {
  return note
    .inlineContent(id)
    .map((node) => node.text ?? "")
    .join("");
}

describe("replicated per-entity Editor adapter", () => {
  it("flushes final native DOM input after compositionend without recording the pending preedit", async () => {
    const note = fresh(),
      id = paragraph(note);
    const { view, adapter } = editor(note);
    const before = note.snapshot();
    const updates: Uint8Array[] = [];
    note.doc.on("update", (update: Uint8Array) => updates.push(update));
    view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const paragraphDom = view.nodeDOM(position(view, id) - 1)! as HTMLElement;
    paragraphDom.textContent = "abcにほん";
    paragraphDom.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(note.snapshot()).toEqual(before);
    view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本" }),
    );
    paragraphDom.textContent = "abc日本";
    paragraphDom.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromComposition",
      }),
    );
    adapter.flushConfirmedComposition();
    expect(content(note, id)).toBe("abc日本");
    expect(updates).toHaveLength(1);
  });

  it("holds preedit for titles, ordinary paragraphs, list items and table cells", () => {
    const block = (type: string, content: unknown[] = []) => ({
      type,
      attrs: { blockId: createUuidV7() },
      content,
    });
    const text = () => block("paragraph", [{ type: "text", text: "abc" }]);
    const body = text(),
      list = text(),
      cell = text();
    const note = replicateSectionSnapshot(
      {
        sectionId: createUuidV7(),
        title: "Title",
        tags: [],
        children: [],
        body: [
          body,
          block("bulletList", [block("listItem", [list])]),
          block("table", [block("tableRow", [block("tableCell", [cell])])]),
        ],
      },
      createUuidV7(),
    );
    notes.push(note);
    const { view, adapter } = editor(note);
    for (const id of [
      note.noteId,
      body.attrs.blockId,
      list.attrs.blockId,
      cell.attrs.blockId,
    ]) {
      const before = note.snapshot();
      view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      view.dispatch(view.state.tr.insertText("仮", position(view, id)));
      expect(note.snapshot()).toEqual(before);
      view.dispatch(
        view.state.tr.insertText(
          "確定",
          position(view, id),
          position(view, id) + 1,
        ),
      );
      view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      adapter.flushConfirmedComposition();
      expect(content(note, id)).toMatch(/^確定/);
    }
  });

  it("keeps every preedit out of Yjs and other views, then publishes just the confirmed difference", async () => {
    const note = fresh(),
      id = paragraph(note);
    note.history.clear();
    const a = editor(note),
      b = editor(note);
    const snapshot = note.snapshot();
    const updates: Uint8Array[] = [];
    note.doc.on("update", (update: Uint8Array) => updates.push(update));
    a.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    let length = 0;
    for (const text of ["に", "にほん", "日本"]) {
      const start = position(a.view, id) + 3;
      a.view.dispatch(a.view.state.tr.insertText(text, start, start + length));
      length = text.length;
      expect(note.snapshot()).toEqual(snapshot);
      expect(b.view.state.doc.textContent).toBe("Titleabc");
      expect(updates).toHaveLength(0);
    }
    a.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates).toHaveLength(1);
    expect(content(note, id)).toBe("abc日本");
    expect(a.view.state.doc.eq(b.view.state.doc)).toBe(true);
    const peer = ReplicatedNote.load(note.noteId, createUuidV7(), snapshot);
    notes.push(peer);
    peer.applyUpdate(updates[0]!);
    expect(content(peer, id)).toBe("abc日本");
    note.undo();
    expect(content(note, id)).toBe("abc");
    note.redo();
    expect(content(note, id)).toBe("abc日本");
  });

  it("records no change for cancelled reconversion and discards unresolved preedit on departure", async () => {
    const note = fresh(),
      id = paragraph(note);
    const { view, adapter } = editor(note);
    const before = note.snapshot();
    const compose = (type: string) =>
      view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    compose("compositionstart");
    view.dispatch(
      view.state.tr.insertText(
        "仮",
        position(view, id),
        position(view, id) + 3,
      ),
    );
    view.dispatch(
      view.state.tr.insertText(
        "abc",
        position(view, id),
        position(view, id) + 1,
      ),
    );
    compose("compositionend");
    adapter.flushConfirmedComposition();
    expect(note.snapshot()).toEqual(before);
    compose("compositionstart");
    view.dispatch(view.state.tr.insertText("未確定", position(view, id)));
    adapter.discardComposition();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(note.snapshot()).toEqual(before);
    expect(view.state.doc.textContent).toBe("Titleabc");
    expect(view.composing).toBe(false);
    expect(adapter.compositionPending).toBe(false);
  });

  it("flushes a just-ended composition before a new session and ignores its old timer", async () => {
    const note = fresh(),
      id = paragraph(note);
    const { view, adapter } = editor(note);
    const compose = (type: string) =>
      view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    compose("compositionstart");
    view.dispatch(view.state.tr.insertText("確定", position(view, id)));
    compose("compositionend");
    compose("compositionstart");
    view.dispatch(view.state.tr.insertText("仮", position(view, id)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(content(note, id)).toBe("確定abc");
    expect(adapter.compositionPending).toBe(true);
    adapter.discardComposition();
    expect(content(note, id)).toBe("確定abc");
    compose("compositionstart");
    view.dispatch(view.state.tr.insertText("保存", position(view, id)));
    compose("compositionend");
    adapter.destroy();
    expect(content(note, id)).toBe("保存確定abc");
  });

  it("does not rewrite shared content or placement when BodyChunks are repartitioned", () => {
    const note = fresh();
    paragraph(note);
    paragraph(note, note.noteId, "a1");
    const { view } = editor(note),
      before = note.snapshot();
    const body = view.state.doc.child(1),
      chunk = body.firstChild!;
    const replacement = body.type.create(null, [
      chunk.type.create({ chunkId: createUuidV7() }, chunk.child(0)),
      chunk.type.create({ chunkId: createUuidV7() }, chunk.child(1)),
    ]);
    const start = view.state.doc.child(0).nodeSize;
    view.dispatch(
      view.state.tr.replaceWith(start, start + body.nodeSize, replacement),
    );
    expect(note.snapshot()).toEqual(before);
  });

  it("keeps list-item text identity when indenting during a remote edit", () => {
    const paragraphId = createUuidV7(),
      secondId = createUuidV7(),
      firstId = createUuidV7(),
      listId = createUuidV7();
    const note = replicateSectionSnapshot(
      {
        sectionId: createUuidV7(),
        title: "List",
        tags: [],
        children: [],
        body: [
          {
            type: "bulletList",
            attrs: { blockId: listId },
            content: [
              {
                type: "listItem",
                attrs: { blockId: firstId },
                content: [
                  {
                    type: "paragraph",
                    attrs: { blockId: createUuidV7() },
                    content: [{ type: "text", text: "first" }],
                  },
                ],
              },
              {
                type: "listItem",
                attrs: { blockId: secondId },
                content: [
                  {
                    type: "paragraph",
                    attrs: { blockId: paragraphId },
                    content: [{ type: "text", text: "second" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      createUuidV7(),
    );
    notes.push(note);
    const remote = fork(note),
      original = note.inline(paragraphId),
      { view } = editor(note);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view, paragraphId)),
      ),
    );
    expect(
      sinkListItem(view.state.schema.nodes.listItem!)(
        view.state,
        (transaction) => {
          const seen = new Set<string>();
          transaction.doc.descendants((node, position) => {
            const id = node.attrs.blockId;
            if (!("blockId" in node.attrs)) return;
            if (typeof id !== "string" || !id || seen.has(id))
              transaction.setNodeMarkup(position, undefined, {
                ...node.attrs,
                blockId: createUuidV7(),
              });
            else seen.add(id);
          });
          view.dispatch(transaction);
        },
      ),
    ).toBe(true);
    remote.transact(() =>
      (remote.inline(paragraphId).get(0) as Y.XmlText).insert(6, " remote"),
    );
    note.applyUpdate(remote.snapshot());
    expect(note.inline(paragraphId)).toBe(original);
    expect(view.state.doc.textContent).toBe("Listfirstsecond remote");
    const parentList = note.project().parents.get(secondId)!.parentId;
    expect(note.project().parents.get(parentList)!.parentId).toBe(firstId);
  });

  it("captures the current selection after a duplicate update made no document change", () => {
    const note = fresh(),
      id = paragraph(note),
      remote = fork(note),
      { view } = editor(note);
    note.applyUpdate(remote.snapshot());
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view, id) + 2),
      ),
    );
    remote.transact(() =>
      (remote.inline(id).get(0) as Y.XmlText).insert(0, "R"),
    );
    note.applyUpdate(remote.snapshot());
    expect(view.state.selection.head).toBe(position(view, id) + 3);
  });
  it("updates a single inline entity without scanning or rebuilding a large Note", () => {
    const note = fresh();
    const blocks: string[] = [];
    note.transact(() => {
      for (let index = 0; index < 2_000; index++)
        blocks.push(paragraph(note, note.noteId, "a0"));
    });
    note.undoManager.clear();
    const { adapter, view } = editor(note);
    const id = blocks[1_000]!;
    const at = position(view, id);
    const before = { ...adapter.work };
    view.dispatch(view.state.tr.insertText("local", at + 1));
    expect(content(note, id)).toBe("alocalbc");
    expect(adapter.work.inlineWrites - before.inlineWrites).toBe(1);
    expect(adapter.work.structuralWrites).toBe(before.structuralWrites);
    expect(adapter.work.fullRenders).toBe(before.fullRenders);
  });

  it("preserves marks and inline atoms through editing and snapshot reload", () => {
    const note = fresh(),
      id = paragraph(note);
    const { view } = editor(note);
    const start = position(view, id);
    view.dispatch(
      view.state.tr.addMark(
        start,
        start + 2,
        view.state.schema.marks.bold!.create(),
      ),
    );
    expect(note.inlineContent(id)[0]).toMatchObject({
      text: "ab",
      marks: [{ type: "bold" }],
    });
    const copy = fork(note);
    expect(copy.inlineContent(id)).toEqual(note.inlineContent(id));
  });

  it("applies a remote text delta without replacing an unrelated DOM node or moving focus", () => {
    const note = fresh(),
      id = paragraph(note),
      unrelated = paragraph(note, note.noteId, "a1", "unrelated");
    const remote = fork(note);
    const { adapter, view } = editor(note);
    const original = view.nodeDOM(position(view, unrelated) - 1);
    const start = position(view, id);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, start + 2),
      ),
    );
    view.focus();
    const focused = document.activeElement;
    remote.transact(() =>
      (remote.inline(id).get(0) as Y.XmlText).insert(0, "REMOTE"),
    );
    const before = { ...adapter.work };
    note.applyUpdate(remote.snapshot());
    expect(view.state.selection.head).toBe(start + 8);
    expect(view.nodeDOM(position(view, unrelated) - 1)).toBe(original);
    expect(document.activeElement).toBe(focused);
    expect(adapter.work.fullRenders).toBe(before.fullRenders);
    expect(adapter.work.elementRenders - before.elementRenders).toBe(1);
    expect(view.state.doc.textContent).toContain("REMOTEabc");
  });

  it("follows a caret through a remote Section move with the same inline Yjs object", () => {
    const note = fresh();
    const moving = note.createEntity("section", note.noteId, "sections", "a0", {
      inline: [{ type: "text", text: "Moving" }],
    });
    const target = note.createEntity("section", note.noteId, "sections", "a1", {
      inline: [{ type: "text", text: "Target" }],
    });
    const id = paragraph(note, moving);
    const inline = note.inline(id);
    const remote = fork(note);
    const { view } = editor(note);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view, id) + 2),
      ),
    );
    remote.move(moving, target, "sections", "a0");
    note.applyUpdate(remote.snapshot());
    expect(note.inline(id)).toBe(inline);
    expect(view.state.selection.head).toBe(position(view, id) + 2);
    expect(view.state.doc.textContent).toBe("TitleTargetMovingabc");
  });

  it("translates a ProseMirror block move into placement-only changes", () => {
    const note = fresh();
    const first = paragraph(note),
      second = paragraph(note, note.noteId, "a1", "second");
    const remote = fork(note);
    const { view } = editor(note);
    const text = note.inline(first);
    const firstStart = position(view, first) - 1,
      secondStart = position(view, second) - 1;
    const firstNode = view.state.doc.nodeAt(firstStart)!;
    const secondNode = view.state.doc.nodeAt(secondStart)!;
    view.dispatch(
      view.state.tr.replaceWith(firstStart, secondStart + secondNode.nodeSize, [
        secondNode,
        firstNode,
      ]),
    );
    remote.transact(() =>
      (remote.inline(first).get(0) as Y.XmlText).insert(1, "remote"),
    );
    note.applyUpdate(remote.snapshot());
    expect(note.inline(first)).toBe(text);
    expect(view.state.doc.textContent).toBe("Titlesecondaremotebc");
  });

  it("synchronizes two views while keeping their independent selections", () => {
    const note = fresh(),
      id = paragraph(note);
    const a = editor(note),
      b = editor(note);
    b.view.dispatch(
      b.view.state.tr.setSelection(
        TextSelection.create(b.view.state.doc, position(b.view, id) + 3),
      ),
    );
    a.view.dispatch(a.view.state.tr.insertText("A", position(a.view, id)));
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
    expect(b.view.state.selection.head).toBe(position(b.view, id) + 4);
  });

  it("does not include remote text changes in local undo", () => {
    const note = fresh(),
      id = paragraph(note);
    note.undoManager.clear();
    const remote = fork(note);
    const { view } = editor(note);
    view.dispatch(view.state.tr.insertText("LOCAL", position(view, id) + 1));
    remote.transact(() =>
      (remote.inline(id).get(0) as Y.XmlText).insert(2, "REMOTE"),
    );
    note.applyUpdate(remote.snapshot());
    note.undoManager.undo();
    expect(view.state.doc.textContent).toBe("TitleabREMOTEc");
  });

  it("commits IME text before displaying deferred remote changes", async () => {
    const note = fresh(),
      id = paragraph(note);
    const remote = fork(note);
    const { view } = editor(note);
    view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    remote.transact(() =>
      (remote.inline(id).get(0) as Y.XmlText).insert(1, "REMOTE"),
    );
    expect(note.applyUpdate(remote.snapshot())).toBe("deferred");
    view.dispatch(view.state.tr.insertText("日本語", position(view, id) + 3));
    expect(view.state.doc.textContent).toBe("Titleabc日本語");
    view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.state.doc.textContent).toBe("TitleaREMOTEbc日本語");
  });

  it("merges ProseMirror row and column additions with an edit to an existing cell", () => {
    const block = (type: string, content: unknown[] = []) => ({
      type,
      attrs: { blockId: createUuidV7() },
      content,
    });
    const first = block("paragraph", [{ type: "text", text: "first" }]);
    const table = block("table", [
      block("tableRow", [
        block("tableCell", [first]),
        block("tableCell", [
          block("paragraph", [{ type: "text", text: "second" }]),
        ]),
      ]),
    ]);
    const note = replicateSectionSnapshot(
      {
        sectionId: createUuidV7(),
        title: "Table",
        tags: [],
        children: [],
        body: [table],
      },
      createUuidV7(),
    );
    notes.push(note);
    const remote = fork(note),
      writer = fork(note);
    const a = editor(note),
      b = editor(remote);
    const assignFreshIds = (
      view: EditorView,
      transaction: import("@tiptap/pm/state").Transaction,
    ) => {
      const seen = new Set<string>();
      transaction.doc.descendants((node, position) => {
        if (!("blockId" in node.attrs)) return;
        let id = node.attrs.blockId as string | null;
        if (!id || seen.has(id)) {
          id = createUuidV7();
          transaction.setNodeMarkup(position, undefined, {
            ...node.attrs,
            blockId: id,
          });
        }
        seen.add(id);
      });
      view.dispatch(transaction);
    };
    a.view.dispatch(
      a.view.state.tr.setSelection(
        TextSelection.create(
          a.view.state.doc,
          position(a.view, first.attrs.blockId),
        ),
      ),
    );
    b.view.dispatch(
      b.view.state.tr.setSelection(
        TextSelection.create(
          b.view.state.doc,
          position(b.view, first.attrs.blockId),
        ),
      ),
    );
    expect(addRowAfter(a.view.state, (tr) => assignFreshIds(a.view, tr))).toBe(
      true,
    );
    expect(
      addColumnAfter(b.view.state, (tr) => assignFreshIds(b.view, tr)),
    ).toBe(true);
    writer.transact(() =>
      (writer.inline(first.attrs.blockId).get(0) as Y.XmlText).insert(
        5,
        " edited",
      ),
    );
    try {
      note.applyUpdate(remote.snapshot());
    } catch (error) {
      throw new Error("applying column", { cause: error });
    }
    try {
      note.applyUpdate(writer.snapshot());
    } catch (error) {
      throw new Error("applying text", { cause: error });
    }
    try {
      remote.applyUpdate(note.snapshot());
    } catch (error) {
      throw new Error("applying merged table", { cause: error });
    }
    expect(a.view.state.doc.toJSON()).toEqual(b.view.state.doc.toJSON());
    expect(a.view.state.doc.textContent).toContain("first edited");
    const result = note.blockSnapshot(table.attrs.blockId);
    expect(result.content).toHaveLength(2);
    expect(result.content![0]!.content).toHaveLength(3);
    expect(result.content![1]!.content).toHaveLength(3);
    expect(deleteColumn(a.view.state, (tr) => assignFreshIds(a.view, tr))).toBe(
      true,
    );
    note.validate();
    expect(note.project().recovery.length).toBeGreaterThan(0);
  });
});
