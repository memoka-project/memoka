import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CoreRuntime } from "../app/src/core/runtime";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import {
  nativeAgentEdit,
  type AgentDelivery,
} from "../app/src/core/native-agent-edit";
import { blockToYXml } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  childSections,
  createSectionXml,
  findSectionById,
  insertChildSection,
  sectionChildren,
  sectionBody,
  sectionBodyChunks,
  sectionBodyBlocks,
  sectionHeader,
  sectionId,
} from "../app/src/core/section-model";
import { addSecondWindow } from "./helpers/runtime";

function position(
  editor: Editor,
  predicate: (node: ProseMirrorNode) => boolean,
): number {
  let result = -1;
  editor.state.doc.descendants((node, pos) => {
    if (result < 0 && predicate(node)) result = pos + 1;
  });
  if (result < 0) throw new Error("Missing test node");
  return result;
}
function add(parent: Y.XmlElement, title: string, body: string) {
  const id = createUuidV7();
  const blockId = createUuidV7();
  insertChildSection(
    parent,
    createSectionXml(id, title, [
      blockToYXml({
        type: "paragraph",
        blockId,
        content: [{ type: "text", text: body }],
      }),
    ]),
  );
  return { id, blockId };
}
async function settle(runtime: CoreRuntime) {
  await new Promise((r) => setTimeout(r, 45));
  await runtime.flush();
}

describe("external Section structure publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves moved body carets, a focused Section, folds and scroll across split Windows, then repairs a deleted Focus", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      initialTitle: "Root",
    });
    let a!: ReturnType<typeof add>,
      b!: ReturnType<typeof add>,
      c!: ReturnType<typeof add>;
    const tailId = createUuidV7();
    runtime.noteDocument.doc.transact(() => {
      a = add(runtime.noteDocument.rootSection, "A", "A body");
      sectionBodyChunks(
        findSectionById(runtime.noteDocument.rootSection, a.id)!,
      )[0]!.push([
        blockToYXml({
          type: "paragraph",
          blockId: tailId,
          content: [{ type: "text", text: "Moved tail😀" }],
        }),
      ]);
      b = add(runtime.noteDocument.rootSection, "B", "B body");
      c = add(
        findSectionById(runtime.noteDocument.rootSection, a.id)!,
        "C",
        "C body😀",
      );
    });
    await runtime.flush();
    await addSecondWindow(runtime);
    await runtime.executeCommand({
      name: "window.focus_section",
      operationId: createUuidV7(),
      source: "internal",
      payload: {
        windowId: "window-2",
        noteId: runtime.noteId,
        sectionId: a.id,
      },
    });
    for (const windowId of ["window-1", "window-2"])
      await runtime.executeCommand({
        name: "window.update_view",
        operationId: createUuidV7(),
        source: "internal",
        payload: {
          windowId,
          update: {
            mode: "normal",
            collapsedSectionIds: windowId === "window-2" ? [c.id] : [],
          },
        },
      });
    const roots = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    roots.forEach((root) => document.body.append(root));
    const one = runtime.attachEditor("window-1", roots[0]);
    const two = runtime.attachEditor("window-2", roots[1]);
    const prepare = vi
      .spyOn(nativeAgentEdit, "prepare")
      .mockResolvedValue({ complete: false });
    const commit = vi.spyOn(nativeAgentEdit, "commit");
    const edit = async (
      change: (root: Y.XmlElement) => void,
      result: Partial<AgentDelivery["result"]> = {},
    ) => {
      await settle(runtime);
      const note = runtime.noteDocument;
      const base = runtime.getNoteHandle().revision;
      const staged = new Y.Doc();
      Y.applyUpdate(staged, Y.encodeStateAsUpdate(note.doc));
      const vector = Y.encodeStateVector(staged);
      staged.transact(() =>
        change(staged.getXmlFragment("body").get(0) as Y.XmlElement),
      );
      const update = Y.encodeStateAsUpdate(staged, vector);
      commit.mockImplementationOnce(async () => {
        await persistence.commit({
          operationId: createUuidV7(),
          scope: "workspace-structure",
          documents: [
            {
              kind: "note",
              documentId: note.noteId,
              schemaVersion: 6,
              baseRevision: base,
              update,
              snapshot: null,
            },
          ],
          localStates: [],
        });
        return {
          result: {
            revision_after: base + 1,
            replayed: false,
            status: "applied",
            section_edit: true,
            ...result,
          },
          documents: [
            {
              kind: "note",
              document_id: note.noteId,
              revision: base + 1,
              update: [...update],
            },
          ],
        };
      });
      await runtime.applyExternalAgentEdit(
        "ticket",
        {
          workspace_id: runtime.workspaceDocument.workspaceId,
          note_id: note.noteId,
          expected_revision: base,
          request_id: createUuidV7(),
        },
        () => true,
      );
      await settle(runtime);
      staged.destroy();
    };
    try {
      await settle(runtime);
      one.editor.commands.setTextSelection(
        position(one.editor, (n) => n.attrs.blockId === c.blockId) + 3,
      );
      two.editor.commands.setTextSelection(
        position(two.editor, (n) => n.attrs.blockId === a.blockId) + 2,
      );
      two.editor.view.focus();
      await settle(runtime);
      const beforeOne = one.editor;
      const beforeTwo = two.editor;
      const focus = runtime.snapshot().applicationWindow.activeTabId;
      roots[0].scrollTop = 80;
      roots[1].scrollTop = 40;
      await edit((root) => {
        const source = findSectionById(root, a.id)!;
        const clone = source.clone();
        const children = sectionChildren(root);
        children.delete(
          childSections(root).findIndex((s) => sectionId(s) === a.id),
          1,
        );
        sectionChildren(findSectionById(root, b.id)!).insert(0, [clone]);
      });
      expect(one.editor).toBe(beforeOne);
      expect(two.editor).not.toBe(beforeTwo);
      expect(one.editor.state.selection.$head.parent.attrs.blockId).toBe(
        c.blockId,
      );
      expect(one.editor.state.selection.$head.parentOffset).toBe(3);
      expect(two.editor.state.selection.$head.parent.attrs.blockId).toBe(
        a.blockId,
      );
      expect(two.editor.state.selection.$head.parentOffset).toBe(2);
      expect(two.editor.isFocused).toBe(true);
      expect(runtime.windows.get("window-2")?.focusedSectionId).toBe(a.id);
      expect(runtime.windows.get("window-2")?.collapsedSectionIds).toEqual([
        c.id,
      ]);
      expect(runtime.snapshot().applicationWindow.activeTabId).toBe(focus);
      expect(roots.map((root) => root.scrollTop)).toEqual([80, 40]);
      expect(runtime.resolveInternalLinkTitle(a.id)).toBe("A");
      await edit((root) => {
        const header = sectionHeader(findSectionById(root, a.id)!);
        header.delete(0, header.length);
        header.insert(0, [new Y.XmlText("改名したA")]);
      });
      expect(runtime.resolveInternalLinkTitle(a.id)).toBe("改名したA");
      expect(one.editor.state.selection.$head.parent.attrs.blockId).toBe(
        c.blockId,
      );
      expect(two.editor.state.selection.$head.parent.attrs.blockId).toBe(
        a.blockId,
      );
      // Converting a heading rehomes its following Body, not existing children.
      // Restore a caret in that Body and one in the consumed heading independently.
      one.editor.commands.setTextSelection(
        position(one.editor, (n) => n.attrs.blockId === tailId) + 3,
      );
      const sectionizedId = createUuidV7();
      const priorScroll = roots.map((root) => root.scrollTop);
      await edit(
        (root) => {
          const source = findSectionById(root, a.id)!;
          const trailing = sectionBodyBlocks(source)
            .slice(1)
            .map((block) => block.clone());
          sectionChildren(source).insert(0, [
            createSectionXml(sectionizedId, "A body", trailing),
          ]);
          const body = sectionBody(source);
          body.delete(0, body.length);
        },
        {
          sectionized_heading: {
            block_id: a.blockId,
            section_id: sectionizedId,
          },
        },
      );
      expect(one.editor.state.selection.$head.parent.attrs.blockId).toBe(
        tailId,
      );
      expect(one.editor.state.selection.$head.parentOffset).toBe(3);
      expect(two.editor.state.selection.$head.parent.attrs.sectionId).toBe(
        sectionizedId,
      );
      expect(two.editor.state.selection.$head.parentOffset).toBe(2);
      expect(two.editor.isFocused).toBe(true);
      expect(runtime.windows.get("window-2")?.focusedSectionId).toBe(a.id);
      expect(runtime.windows.get("window-2")?.collapsedSectionIds).toEqual([
        c.id,
      ]);
      expect(roots.map((root) => root.scrollTop)).toEqual(priorScroll);
      expect(runtime.resolveInternalLinkTitle(sectionizedId)).toBe("A body");
      await edit(
        (root) => {
          sectionChildren(findSectionById(root, b.id)!).delete(0, 1);
        },
        {
          deleted_section_ids: [a.id, c.id, sectionizedId],
          fallback_section_id: b.id,
        },
      );
      expect(runtime.windows.get("window-2")?.focusedSectionId).toBe(b.id);
      expect(runtime.windows.get("window-2")?.collapsedSectionIds).toEqual([]);
      expect(two.editor.state.doc.firstChild?.attrs.sectionId).toBe(b.id);
      expect(two.editor.state.selection.$head.parent.attrs.sectionId).toBe(
        b.id,
      );
      expect(one.editor.state.selection.$head.parent.attrs.sectionId).toBe(
        b.id,
      );
      expect(two.editor.isFocused).toBe(true);
      expect(runtime.resolveInternalLinkTitle(a.id)).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(4);
    } finally {
      one.destroy();
      two.destroy();
      runtime.destroy();
      roots.forEach((root) => root.remove());
    }
  });
});
