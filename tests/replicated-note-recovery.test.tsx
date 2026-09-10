import * as Y from "yjs";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup as cleanupViews,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { NoteRecoveryDialog } from "../app/src/components/NoteRecoveryDialog";
import { createUuidV7 } from "../app/src/core/ids";
import {
  addNoteMetadata,
  createReplicatedNoteDocumentFromSectionSnapshot,
  createWorkspaceDocument,
  encodeProductDocument,
  loadProductDocument,
  readNotePlainText,
  type NoteDocument,
} from "../app/src/core/documents";
import {
  applyNoteRecovery,
  readNoteRecovery,
} from "../app/src/core/replicated-note-recovery";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import type { SectionSnapshot } from "../app/src/core/section-model";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanupViews();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const at = "2026-09-10T00:00:00.000Z";
function paragraph(text = "保護された本文") {
  return {
    type: "paragraph",
    attrs: { blockId: createUuidV7() },
    content: [{ type: "text", text, marks: [{ type: "bold" }] }],
  };
}
function section(title = "Section"): SectionSnapshot {
  return {
    sectionId: createUuidV7(),
    title,
    tags: [],
    children: [],
    body: [paragraph()],
  };
}
function note(snapshot = section("Root")) {
  const value = createReplicatedNoteDocumentFromSectionSnapshot(
    snapshot.sectionId,
    snapshot,
    createUuidV7(),
    { createdAt: at },
  );
  cleanups.push(() => value.doc.destroy());
  return value;
}
function fork(source: NoteDocument) {
  const value = loadProductDocument(
    "note",
    source.id,
    encodeProductDocument(source),
    [],
    createUuidV7(),
  ) as NoteDocument;
  cleanups.push(() => value.doc.destroy());
  return value;
}
async function runtime(source: NoteDocument) {
  const persistence = new MemoryPersistencePort(),
    workspace = createWorkspaceDocument(createUuidV7());
  addNoteMetadata(workspace, {
    noteId: source.noteId,
    title: "Root",
    notePosition: "a0",
    createdAt: at,
    updatedAt: at,
  });
  await persistence.commit({
    operationId: createUuidV7(),
    scope: "bootstrap",
    localStates: [],
    documents: [workspace, source].map((doc) => ({
      kind: doc.kind,
      documentId: doc.id,
      schemaVersion: doc.schemaVersion,
      baseRevision: 0,
      snapshot: encodeProductDocument(doc),
      update: null,
    })),
  });
  workspace.doc.destroy();
  const clock = () => at;
  const core = await CoreRuntime.open(persistence, { clock });
  cleanups.push(() => core.destroy());
  await core.openNote("window-1", source.noteId);
  return { core, persistence, clock };
}

describe("protected Note content recovery", () => {
  it("restores observed Section deletion without cancelling another delete and retains concurrent text", () => {
    const child = section(),
      root = section("Root"),
      a = note({ ...root, children: [child] }),
      b = fork(a);
    const id = (child.body[0] as ReturnType<typeof paragraph>).attrs.blockId;
    const inline = a.replicated!.inline(id);
    a.replicated!.delete(child.sectionId);
    const action = readNoteRecovery(a.replicated!).items[0]!.action!;
    b.replicated!.transact(() =>
      (b.replicated!.inline(id).get(0) as Y.XmlText).insert(0, "remote "),
    );
    b.replicated!.delete(child.sectionId);
    a.replicated!.applyUpdate(encodeProductDocument(b));
    applyNoteRecovery(a.replicated!, action, at);
    expect(a.replicated!.project().visible.has(child.sectionId)).toBe(false);
    applyNoteRecovery(
      a.replicated!,
      readNoteRecovery(a.replicated!).items[0]!.action!,
      at,
    );
    expect(a.replicated!.project().visible.has(child.sectionId)).toBe(true);
    expect(readNotePlainText(a)).toContain("remote 保護された本文");
    expect(a.replicated!.inline(id)).toBe(inline);
    expect(a.replicated!.undo()).toBe(true);
    expect(a.replicated!.project().visible.has(child.sectionId)).toBe(false);
    expect(a.replicated!.inlineContent(id)[0]?.text).toContain("remote");
  });

  it("recovers a hidden List with its IDs and marks, and refuses a stale type plan before mutation", () => {
    const root = section("Root"),
      list = createUuidV7(),
      item = createUuidV7(),
      body = paragraph();
    const a = note({
      ...root,
      body: [
        {
          type: "bulletList",
          attrs: { blockId: list },
          content: [
            { type: "listItem", attrs: { blockId: item }, content: [body] },
          ],
        },
      ],
    });
    const original = a.replicated!.blockSnapshot(list);
    a.replicated!.transact(() =>
      a.replicated!.attributes(list).set("type", "paragraph"),
    );
    const action = readNoteRecovery(a.replicated!).items[0]!.action!;
    expect(action.kind).toBe("restore-structure");
    const stale = fork(a);
    stale.replicated!.transact(() =>
      stale.replicated!.attributes(list).set("type", "horizontalRule"),
    );
    const before = encodeProductDocument(stale);
    expect(() =>
      applyNoteRecovery(
        stale.replicated!,
        { ...action, replicaId: stale.replicated!.replicaId },
        at,
      ),
    ).toThrow("読み直し");
    expect(encodeProductDocument(stale)).toEqual(before);
    applyNoteRecovery(a.replicated!, action, at);
    expect(a.replicated!.blockSnapshot(list)).toEqual(original);
    expect(readNoteRecovery(a.replicated!).total).toBe(0);
  });

  it("copies incompatible inline content into a new paragraph without replacing the protected shared text", () => {
    const a = note(),
      id = [...a.replicated!.entities.values()].find(
        (entity) => entity.type === "paragraph",
      )!.id;
    const inline = a.replicated!.inline(id),
      content = a.replicated!.inlineContent(id);
    a.replicated!.transact(() =>
      a.replicated!.attributes(id).set("type", "horizontalRule"),
    );
    const action = readNoteRecovery(a.replicated!).items[0]!.action!;
    expect(action.kind).toBe("copy-inline");
    const createdId = applyNoteRecovery(a.replicated!, action, at)!;
    expect(createdId).not.toBe(id);
    expect(a.replicated!.inlineContent(createdId)).toEqual(content);
    expect(a.replicated!.inline(id)).toBe(inline);
    expect(a.replicated!.type(id)).toBe("horizontalRule");
    a.replicated!.undo();
    expect(a.replicated!.project().visible.has(createdId)).toBe(false);
    expect(a.replicated!.inlineContent(id)).toEqual(content);
  });

  it("rolls back a failed owner commit and preserves the injected clock and Replica for retry", async () => {
    const child = section(),
      source = note({ ...section("Root"), children: [child] });
    source.replicated!.delete(child.sectionId);
    const { core, persistence, clock } = await runtime(source);
    const action = (await core.noteRecovery(source.noteId)).items[0]!.action!;
    const before = await persistence.loadDocument("note", source.noteId);
    await expect(
      core.recoverNoteContent(action, "before-commit"),
    ).rejects.toThrow("before-commit");
    expect(await persistence.loadDocument("note", source.noteId)).toEqual(
      before,
    );
    expect(core.noteDocument.replicated!.clock).toBe(clock);
    expect(core.noteDocument.replicated!.replicaId).toBe(action.replicaId);
    await core.recoverNoteContent(action);
    const stored = await persistence.loadDocument("note", source.noteId);
    const reopened = loadProductDocument(
      "note",
      source.noteId,
      stored.snapshot,
      stored.updates.map(({ update }) => update),
    ) as NoteDocument;
    cleanups.push(() => reopened.doc.destroy());
    expect(reopened.replicated!.project().visible.has(child.sectionId)).toBe(
      true,
    );
    expect(reopened.meta.get("updated_at")).toBe(at);
  });

  it("restores through the modal without remounting or focusing the background Editor", async () => {
    const child = section(),
      source = note({ ...section("Root"), children: [child] });
    source.replicated!.delete(child.sectionId);
    const { core } = await runtime(source);
    const host = document.createElement("div");
    document.body.append(host);
    const { editor } = core.editorForTesting("window-1", host, {
      directBodyOnly: false,
    });
    const dom = editor.view.dom;
    const view = render(
      <NoteRecoveryDialog
        runtime={core}
        session={{
          noteId: source.noteId,
          restoreFocus: () => editor.view.focus(),
        }}
        onClose={() => view.unmount()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "確認済みの削除を取り消す" }),
    );
    await screen.findByText("保護された内容はありません。");
    expect(editor.view.dom).toBe(dom);
    expect(dom.textContent).toContain(child.title);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(document.activeElement).toBe(dom));
  });

  it("opens recovery from the application command line and returns focus to its Editor", async () => {
    const { core } = await runtime(note());
    vi.spyOn(CoreRuntime, "open").mockResolvedValue(core);
    const view = render(<App backup={null} showDebugLine={false} />);
    const editor = await waitFor(() => {
      const editor = view.container.querySelector<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (!editor) throw new Error("Editor missing");
      return editor;
    });
    act(() => {
      editor.focus();
      fireEvent.keyDown(editor, { key: "Escape" });
      fireEvent.keyDown(editor, {
        key: ":",
        code: "Semicolon",
        shiftKey: true,
      });
    });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "recovery" } });
    fireEvent.keyDown(command, { key: "Enter" });
    await screen.findByRole("dialog", { name: "保護された内容を復旧" });
    expect(view.container.querySelector(".editor-window .memoka-editor")).toBe(
      editor,
    );
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("keeps the App Editor and scroll while a remotely deleted focused Section falls back to its parent", async () => {
    const child = section("Removed child"),
      parent = section("Surviving parent");
    const source = note({
      ...section("Root"),
      children: [{ ...parent, children: [child] }],
    });
    const peer = fork(source),
      { core } = await runtime(source);
    await core.focusSection("window-1", source.noteId, child.sectionId);
    vi.spyOn(CoreRuntime, "open").mockResolvedValue(core);
    const view = render(<App backup={null} showDebugLine={false} />);
    const editor = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        ".editor-window .memoka-editor",
      );
      if (!element) throw new Error("Editor missing");
      return element;
    });
    expect(editor.dataset.sectionId).toBe(child.sectionId);
    act(() => editor.focus());
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const scroll = view.container.querySelector<HTMLElement>(".editor-scroll")!;
    act(() => {
      scroll.scrollTop = 123;
      fireEvent.scroll(scroll);
    });
    await waitFor(() =>
      expect(core.windows.get("window-1")?.scrollTop).toBe(123),
    );
    const deletion = peer.replicated!.delete(child.sectionId);
    act(() =>
      core.noteDocument.replicated!.applyUpdate(encodeProductDocument(peer)),
    );
    await waitFor(() =>
      expect(core.windows.get("window-1")?.focusedSectionId).toBe(
        parent.sectionId,
      ),
    );
    expect(view.container.querySelector(".editor-window .memoka-editor")).toBe(
      editor,
    );
    expect(editor.dataset.sectionId).toBe(parent.sectionId);
    expect(editor.textContent).toContain("Surviving parent");
    expect(editor.textContent).not.toContain("Removed child");
    expect(document.activeElement).toBe(editor);
    expect(scroll.scrollTop).toBe(123);
    expect(core.windows.get("window-1")?.scrollTop).toBe(123);
    peer.replicated!.restore(deletion.operationId);
    act(() =>
      core.noteDocument.replicated!.applyUpdate(encodeProductDocument(peer)),
    );
    await waitFor(() => expect(editor.textContent).toContain("Removed child"));
    expect(editor.dataset.sectionId).toBe(parent.sectionId);
    expect(
      core.noteDocument.replicated!.sectionSnapshot(parent.sectionId)
        .children[0]?.title,
    ).toBe(child.title);
    await act(() =>
      core.focusSection("window-1", source.noteId, source.noteId),
    );
    await waitFor(() => expect(editor.dataset.sectionId).toBe(source.noteId));
    expect(view.container.querySelector(".editor-window .memoka-editor")).toBe(
      editor,
    );
  });
});
