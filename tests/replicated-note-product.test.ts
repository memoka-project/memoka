import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  addNoteMetadata,
  applyNoteSectionDepthShift,
  createReplicatedNoteDocumentFromSectionSnapshot,
  createWorkspaceDocument,
  encodeProductDocument,
  loadProductDocument,
  planNoteSectionDepthShift,
  readNotePlainText,
  readNoteTitle,
  replaceNoteSectionTree,
  type NoteDocument,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  sectionSnapshot,
  type SectionSnapshot,
} from "../app/src/core/section-model";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { replicatedNotePluginKey } from "../app/src/editor/replicated-note-adapter";
import {
  resolveStableEditorPosition,
  saveStableEditorPosition,
} from "../app/src/core/stable-position";
import { addSecondWindow } from "./helpers/runtime";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});
function section(title: string, body = "abc"): SectionSnapshot {
  return {
    sectionId: createUuidV7(),
    title,
    tags: [],
    children: [],
    body: [
      {
        type: "paragraph",
        attrs: { blockId: createUuidV7() },
        content: [{ type: "text", text: body }],
      },
    ],
  };
}
function note(snapshot = section("Note")): NoteDocument {
  const note = createReplicatedNoteDocumentFromSectionSnapshot(
    snapshot.sectionId,
    snapshot,
    createUuidV7(),
    { createdAt: "2026-09-01T00:00:00.000Z" },
  );
  cleanup.push(() => note.doc.destroy());
  return note;
}
function fork(source: NoteDocument): NoteDocument {
  const copy = loadProductDocument(
    "note",
    source.noteId,
    encodeProductDocument(source),
    [],
    createUuidV7(),
  ) as NoteDocument;
  cleanup.push(() => copy.doc.destroy());
  return copy;
}
function element(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}
function mount(note: NoteDocument): Editor {
  const editor = new Editor({
    element: element(),
    extensions: productEditorExtensions(note),
  });
  cleanup.push(() => editor.destroy());
  return editor;
}
function position(editor: Editor, id?: string): number {
  let result = -1;
  editor.state.doc.descendants((node, offset) => {
    if (
      result < 0 &&
      (id
        ? node.attrs.blockId === id || node.attrs.sectionId === id
        : node.type.name === "paragraph")
    )
      result = offset + 1;
  });
  if (result < 0) throw new Error("Missing test position");
  return result;
}
function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}
async function runtime(source: NoteDocument) {
  const persistence = new MemoryPersistencePort(),
    workspace = createWorkspaceDocument(createUuidV7());
  addNoteMetadata(workspace, {
    noteId: source.noteId,
    notePosition: "a0",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    title: readNoteTitle(source),
  });
  await persistence.commit({
    operationId: createUuidV7(),
    scope: "bootstrap",
    documents: [workspace, source].map((doc) => ({
      kind: doc.kind,
      documentId: doc.id,
      schemaVersion: doc.schemaVersion,
      baseRevision: 0,
      snapshot: encodeProductDocument(doc),
      update: null,
    })),
    localStates: [],
  });
  workspace.doc.destroy();
  const core = await CoreRuntime.open(persistence, {
    clock: () => "2026-09-10T00:00:00.000Z",
  });
  cleanup.push(() => core.destroy());
  await core.openNote("window-1", source.noteId);
  return { core, persistence };
}

describe("normalized Note in the product Editor and Core", () => {
  it("reopens labelled internal links, including links retained in deleted blocks", async () => {
    const { core, persistence } = await runtime(note());
    const attached = core.editorForTesting("window-1", element(), {
      directBodyOnly: false,
    });
    cleanup.push(() => attached.adapter.destroy());
    const link = {
      type: "internalSectionLink",
      attrs: { targetSectionId: createUuidV7() },
      content: [{ type: "text", text: "リンク先の表示名" }],
    };
    attached.editor.commands.setTextSelection(position(attached.editor));
    attached.editor.commands.insertContent(link);
    await core.flush();
    const blockId = attached.editor.state.selection.$from.parent.attrs
      .blockId as string;
    core.noteDocument.replicated!.delete(blockId);
    await core.flush();
    const reopened = await CoreRuntime.open(persistence);
    cleanup.push(() => reopened.destroy());
    expect(
      reopened.noteDocument.replicated!.inlineContent(blockId),
    ).toContainEqual(link);
    expect(reopened.noteDocument.replicated!.project().recovery).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityId: blockId })]),
    );
  });

  it("reports received H6 corrections without rewriting shared placements or repeating the notice on text input", async () => {
    const source = note();
    let parent = source.noteId;
    for (let depth = 0; depth < 4; depth++)
      parent = source.replicated!.createEntity(
        "section",
        parent,
        "sections",
        "a0",
      );
    const moving = source.replicated!.createEntity(
      "section",
      source.noteId,
      "sections",
      "a2",
    );
    const peer = fork(source);
    source.replicated!.move(moving, parent, "sections", "a0");
    const added = peer.replicated!.createEntity(
      "section",
      moving,
      "sections",
      "a0",
    );
    const { core } = await runtime(source),
      onMessage = vi.fn();
    const adapter = core.attachEditor("window-1", element(), { onMessage });
    cleanup.push(() => adapter.destroy());
    await Promise.resolve();
    expect(onMessage).not.toHaveBeenCalled();
    core.noteDocument.replicated!.applyUpdate(encodeProductDocument(peer));
    await Promise.resolve();
    expect(core.noteDocument.replicated!.project().depthCorrections).toContain(
      added,
    );
    expect(onMessage).toHaveBeenCalledWith(
      "1件のSectionをH6以内の祖先へ表示しています。内容は保持されています。",
    );
    const count = core.noteDocument.doc.getMap("placements").size;
    adapter.editor.commands.setTextSelection(position(adapter.editor));
    adapter.editor.commands.insertContent("追記");
    await Promise.resolve();
    expect(core.noteDocument.doc.getMap("placements").size).toBe(count);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("continues the placement clock from a populated product document after restart", () => {
    const first = section("First"),
      second = section("Second"),
      root = section("Root");
    const source = note({ ...root, children: [first, second] });
    for (let index = 0; index < 6; index++)
      source.replicated!.move(
        second.sectionId,
        index % 2 ? source.noteId : first.sectionId,
        "sections",
        "a0",
      );
    const reloaded = fork(source);
    const maximum = Math.max(
      ...[...source.replicated!.placements.values()].map(
        (edge) => edge.counter,
      ),
    );
    reloaded.replicated!.move(
      first.sectionId,
      second.sectionId,
      "sections",
      "a0",
    );
    const edge = reloaded.replicated!.project().parents.get(first.sectionId)!;
    expect(edge.parentId).toBe(second.sectionId);
    expect(edge.counter).toBeGreaterThan(maximum);
    source.replicated!.applyUpdate(encodeProductDocument(reloaded));
    expect(source.replicated!.sectionSnapshot()).toEqual(
      reloaded.replicated!.sectionSnapshot(),
    );
  });
  it("undoes a large paste in one semantic delete while keeping a bounded mounted DOM", () => {
    const source = note(),
      editor = mount(source);
    source.replicated!.clearUndo();
    editor.commands.setTextSelection(position(editor));
    const before = editor.getJSON();
    editor.commands.insertContent(
      Array.from({ length: 2_000 }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "pasted" }],
      })),
    );
    expect(source.undoManager.undoStack).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll("p").length).toBeLessThanOrEqual(
      1536,
    );
    const deletes = source.replicated!.deletions.size;
    expect(editor.commands.undo()).toBe(true);
    expect(source.replicated!.deletions.size - deletes).toBe(1);
    expect(editor.getJSON()).toEqual(before);
  });
  it("mounts the normal extension set, repairs new block IDs before saving, and reopens", () => {
    const source = note(),
      editor = mount(source);
    expect(replicatedNotePluginKey.getState(editor.state)).toBeTruthy();
    editor.commands.setTextSelection(position(editor) + 1);
    expect(editor.commands.splitBlock()).toBe(true);
    editor.commands.insertContent("日本語");
    source.replicated!.validate();
    const body = source.replicated!.sectionSnapshot().body as {
      attrs: { blockId: string };
    }[];
    expect(body).toHaveLength(2);
    expect(new Set(body.map((block) => block.attrs.blockId)).size).toBe(2);
    const reloaded = fork(source);
    expect(readNotePlainText(reloaded)).toBe(readNotePlainText(source));
    expect([...reloaded.doc.share.keys()]).not.toContain("body");
  });

  it("preserves the shared inline element through a Core depth shift and concurrent text", () => {
    const first = section("First"),
      second = section("Second"),
      root = section("Root");
    const source = note({ ...root, children: [first, second] }),
      peer = fork(source),
      editor = mount(source);
    const blockId = (second.body[0] as { attrs: { blockId: string } }).attrs
      .blockId;
    const inline = source.replicated!.inline(blockId).get(0);
    editor.commands.setTextSelection(position(editor, blockId) + 1);
    const saved = saveStableEditorPosition(source, editor.view);
    const plan = planNoteSectionDepthShift(
      source,
      source.noteId,
      [second.sectionId],
      "deeper",
    );
    applyNoteSectionDepthShift(
      source,
      source.noteId,
      plan,
      "2026-09-10T00:00:00.000Z",
    );
    peer.replicated!.transact(() =>
      (peer.replicated!.inline(blockId).get(0) as Y.XmlText).insert(
        0,
        "remote ",
      ),
    );
    source.replicated!.applyUpdate(encodeProductDocument(peer));
    expect(source.replicated!.inline(blockId).get(0)).toBe(inline);
    expect(
      source.replicated!.project().parents.get(second.sectionId)?.parentId,
    ).toBe(first.sectionId);
    expect(readNotePlainText(source)).toContain("remote abc");
    expect(
      resolveStableEditorPosition(source, editor.view, saved),
    ).toMatchObject({
      source: "relative",
      position: position(editor, blockId) + 8,
    });
    expect(editor.commands.undo()).toBe(true);
    expect(
      source.replicated!.project().parents.get(second.sectionId)?.parentId,
    ).toBe(source.noteId);
    expect(readNotePlainText(source)).toContain("remote abc");
  });

  it("rejects invalid Core replacements without changing persisted bytes", () => {
    const source = note(),
      before = encodeProductDocument(source),
      invalid = sectionSnapshot(source.rootSection);
    expect(() =>
      replaceNoteSectionTree(
        source,
        { ...invalid, body: [...invalid.body, invalid.body[0]] },
        "now",
      ),
    ).toThrow();
    expect(encodeProductDocument(source)).toEqual(before);
  });

  it("retains formatted content when Core changes its display type", () => {
    const root = section("Types"),
      id = (root.body[0] as { attrs: { blockId: string } }).attrs.blockId;
    const source = note({
      ...root,
      body: [
        {
          type: "paragraph",
          attrs: { blockId: id },
          content: [
            { type: "text", text: "日本語", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    const before = source.replicated!.inlineContent(id);
    replaceNoteSectionTree(
      source,
      { ...root, body: [{ type: "horizontalRule", attrs: { blockId: id } }] },
      "now",
    );
    expect(source.replicated!.inlineContent(id)).toEqual(before);
    expect(source.replicated!.project().recovery).toContainEqual(
      expect.objectContaining({ entityId: id, reason: "incompatible-type" }),
    );
  });

  it("preserves the source timestamp when the owner saves an incoming edit", async () => {
    const { core } = await runtime(note()),
      peer = fork(core.noteDocument);
    peer.replicated!.clock = () => "2026-09-02T12:00:00.000Z";
    const id = [...peer.replicated!.entities.values()].find(
      (entry) => entry.type === "paragraph",
    )!.id;
    peer.replicated!.transact(() =>
      (peer.replicated!.inline(id).get(0) as Y.XmlText).insert(0, "remote "),
    );
    core.noteDocument.replicated!.applyUpdate(encodeProductDocument(peer));
    await core.flushDurableState();
    expect(
      core.workspaceDocument.notes
        .get(core.noteDocument.noteId)
        ?.get("updated_at"),
    ).toBe("2026-09-02T12:00:00.000Z");
  });

  it("persists through the owner queue and keeps the Section catalog unchanged for a paragraph", async () => {
    const { core, persistence } = await runtime(note());
    const { editor } = core.editorForTesting("window-1", element(), {
      directBodyOnly: false,
    });
    const before = core.snapshot().internalLinkLabelRevision;
    editor.commands.insertContentAt(position(editor), "saved ");
    await core.flushDurableState();
    expect(core.snapshot().internalLinkLabelRevision).toBe(before);
    const persisted = await persistence.loadDocument(
      "note",
      core.noteDocument.noteId,
    );
    expect(persisted.schemaVersion).toBe(7);
    const reopened = loadProductDocument(
      "note",
      persisted.documentId,
      persisted.snapshot,
      persisted.updates.map(({ update }) => update),
    ) as NoteDocument;
    cleanup.push(() => reopened.doc.destroy());
    expect(readNotePlainText(reopened)).toContain("saved abc");
    editor.commands.insertContentAt(
      position(editor, core.noteDocument.noteId),
      "title ",
    );
    await core.flushDurableState();
    expect(core.snapshot().internalLinkLabelRevision).toBeGreaterThan(before);
  });

  it("keeps two mounted Windows and Vim change/insert undo while receiving an edit", async () => {
    const { core } = await runtime(note());
    await addSecondWindow(core);
    const first = core.editorForTesting("window-1", element(), {
      directBodyOnly: false,
    });
    const second = core.editorForTesting("window-2", element(), {
      directBodyOnly: false,
    });
    const peer = fork(core.noteDocument);
    first.editor.commands.setTextSelection(position(first.editor));
    press(first.editor, "Escape");
    press(first.editor, "c");
    press(first.editor, "w");
    first.editor.commands.insertContent("X");
    first.editor.commands.insertContent("Y");
    press(first.editor, "Escape");
    const id = [...peer.replicated!.entities.values()].find(
      (entry) => entry.type === "paragraph",
    )!.id;
    peer.replicated!.transact(() =>
      (peer.replicated!.inline(id).get(0) as Y.XmlText).insert(3, " remote"),
    );
    core.noteDocument.replicated!.applyUpdate(encodeProductDocument(peer));
    const dom = second.editor.view.dom;
    press(first.editor, "u");
    expect(readNotePlainText(core.noteDocument)).toBe("abc remote");
    expect(second.editor.view.dom).toBe(dom);
    expect(first.adapter.editor).toBe(first.editor);
    expect(second.adapter.editor).toBe(second.editor);
    expect(second.editor.state.doc.textContent).toContain("abc remote");
    await core.flushDurableState();
  });

  it("defers incoming changes until composition is committed in the normal Editor", async () => {
    const source = note(),
      peer = fork(source),
      editor = mount(source);
    editor.commands.setTextSelection(position(editor));
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const id = [...peer.replicated!.entities.values()].find(
      (entry) => entry.type === "paragraph",
    )!.id;
    peer.replicated!.transact(() =>
      (peer.replicated!.inline(id).get(0) as Y.XmlText).insert(3, " remote"),
    );
    expect(source.replicated!.applyUpdate(encodeProductDocument(peer))).toBe(
      "deferred",
    );
    editor.commands.insertContent("日本語");
    expect(editor.state.doc.textContent).not.toContain("remote");
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(editor.state.doc.textContent).toContain("remote"),
    );
    expect(editor.state.doc.textContent).toContain("日本語");
  });
});
