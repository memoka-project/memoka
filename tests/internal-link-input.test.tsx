import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InternalLinkPicker } from "../app/src/components/InternalLinkPicker";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import type { InternalLinkCompletionSnapshot } from "../app/src/editor/internal-link-completion";
import { addSecondWindow } from "./helpers/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_796_100_000_000 + seed, (target) => {
      target.fill((seed * 43) & 0xff);
      return target;
    });
  };
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

function firstNode(editor: Editor, typeName: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  editor.state.doc.descendants((node) => {
    if (!found && node.type.name === typeName) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

async function settle(runtime: CoreRuntime): Promise<void> {
  await runtime.flush();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await runtime.flush();
}

describe("Memoka Internal Link input", () => {
  it("scans only the bounded trigger suffix in a long paragraph", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-12T00:00:00.000Z",
      initialTitle: "入力元",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onInternalLinkCompletion: () => undefined,
    });
    const prefix = "長".repeat(10_000);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: `${prefix}[[入力` }],
        },
      ],
    });
    editor.view.focus();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const resolved = editor.state.selection.$from;
    const parentOffset = resolved.parentOffset;
    const textBetween = vi.spyOn(resolved.parent, "textBetween");

    try {
      adapter.refreshInternalLinkCompletion();

      expect(adapter.internalLinkCompletionSnapshot?.query).toBe("入力");
      expect(textBetween).toHaveBeenCalledTimes(1);
      const [from, to] = textBetween.mock.calls[0] ?? [];
      expect(to).toBe(parentOffset);
      expect(Number(to) - Number(from)).toBeLessThanOrEqual(202);
      expect(from).toBeGreaterThan(0);
    } finally {
      textBetween.mockRestore();
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("filters `[[` by title and inserts a persisted structured inline node", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
      initialTitle: "入力元",
    });
    await addSecondWindow(runtime);
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-2", "日本語ガイド");
    const otherTarget = await runtime.createNoteAtEnd(
      "window-2",
      "日本語ミーティング",
    );
    await runtime.openNote("window-2", sourceNoteId);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const updates: Array<InternalLinkCompletionSnapshot | null> = [];
    const first = runtime.editorForTesting("window-1", firstRoot, {
      internalLinkPopupId: "test-link-picker",
      onInternalLinkCompletion: (snapshot) => updates.push(snapshot),
    });
    const second = runtime.editorForTesting("window-2", secondRoot);

    first.editor.view.focus();
    first.editor.commands.setTextSelection(1);
    first.editor.commands.insertContent("[[日本");
    const completion = first.adapter.internalLinkCompletionSnapshot;
    expect(completion).toMatchObject({
      popupId: "test-link-picker",
      query: "日本",
      selectedIndex: 0,
      candidates: [
        { noteId: target.noteId, title: "日本語ガイド" },
        { noteId: otherTarget.noteId, title: "日本語ミーティング" },
      ],
    });
    expect(first.editor.view.dom.getAttribute("aria-expanded")).toBe("true");

    expect(press(first.editor, "ArrowDown").defaultPrevented).toBe(true);
    expect(first.adapter.internalLinkCompletionSnapshot?.selectedIndex).toBe(1);
    expect(
      press(first.editor, "p", { ctrlKey: true, code: "KeyP" })
        .defaultPrevented,
    ).toBe(true);
    expect(first.adapter.internalLinkCompletionSnapshot?.selectedIndex).toBe(0);

    const enter = press(first.editor, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    const link = firstNode(first.editor, "internalSectionLink");
    expect(link?.attrs).toMatchObject({
      targetSectionId: target.noteId,
    });
    expect(link?.textContent).toBe("日本語ガイド");
    expect(first.editor.getText()).not.toContain("[[");
    expect(first.editor.state.selection.$from.parent.type.name).toBe(
      "paragraph",
    );
    expect(first.adapter.internalLinkCompletionSnapshot).toBeNull();
    expect(first.editor.view.dom.getAttribute("aria-expanded")).toBe("false");
    expect(
      firstNode(second.editor, "internalSectionLink")?.attrs,
    ).toMatchObject({
      targetSectionId: target.noteId,
    });

    await settle(runtime);
    expect(runtime.commands.log).toContainEqual(
      expect.objectContaining({
        name: "note.commit_editor_update",
        source: "editor",
        status: "committed",
      }),
    );
    expect(first.editor.commands.undo()).toBe(true);
    expect(firstNode(first.editor, "internalSectionLink")).toBeNull();
    expect(first.editor.commands.redo()).toBe(true);
    expect(firstNode(first.editor, "internalSectionLink")?.attrs).toMatchObject(
      {
        targetSectionId: target.noteId,
      },
    );
    expect(updates.at(-1)).toBeNull();

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("renders the current note title in every view without mutating the link text", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
      initialTitle: "入力元",
    });
    await addSecondWindow(runtime);
    const sourceNoteId = runtime.noteId;
    const target = await runtime.createNoteAtEnd("window-2", "変更前");
    await runtime.openNote("window-2", sourceNoteId);
    const firstRoot = document.createElement("div");
    const secondRoot = document.createElement("div");
    document.body.append(firstRoot, secondRoot);
    const first = runtime.editorForTesting("window-1", firstRoot);
    const second = runtime.editorForTesting("window-2", secondRoot);
    first.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "internalSectionLink",
              attrs: {
                targetSectionId: target.noteId,
              },
              content: [{ type: "text", text: "作成時の表示" }],
            },
          ],
        },
      ],
    });
    await settle(runtime);
    const noteRevision = runtime.getNoteHandle(sourceNoteId).revision;
    const firstLink = firstRoot.querySelector<HTMLElement>(
      "[data-internal-section-id]",
    );
    const secondLink = secondRoot.querySelector<HTMLElement>(
      "[data-internal-section-id]",
    );
    expect(firstLink?.textContent).toBe("変更前");
    expect(secondLink?.textContent).toBe("変更前");

    await runtime.renameNote(target.noteId, "変更後");
    first.adapter.refreshInternalLinkLabels();
    second.adapter.refreshInternalLinkLabels();

    expect(firstLink?.textContent).toBe("変更後");
    expect(secondLink?.textContent).toBe("変更後");
    expect(firstLink?.contentEditable).toBe("false");
    expect(firstNode(first.editor, "internalSectionLink")?.textContent).toBe(
      "作成時の表示",
    );
    expect(runtime.getNoteHandle(sourceNoteId).revision).toBe(noteRevision);

    first.adapter.destroy();
    second.adapter.destroy();
    runtime.destroy();
    firstRoot.remove();
    secondRoot.remove();
  });

  it("keeps an unmatched trigger literal, and uses the first Escape only to close", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
      initialTitle: "入力元",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onInternalLinkCompletion: () => undefined,
    });
    editor.view.focus();
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("[[存在しない");
    expect(adapter.internalLinkCompletionSnapshot?.candidates).toEqual([]);
    const before = editor.state.doc;

    expect(press(editor, "Enter").defaultPrevented).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(press(editor, "Escape").defaultPrevented).toBe(true);
    expect(adapter.internalLinkCompletionSnapshot).toBeNull();
    expect(adapter.vimSnapshot.mode).toBe("insert");
    expect(editor.getText()).toContain("[[存在しない");

    expect(press(editor, "Escape").defaultPrevented).toBe(true);
    expect(adapter.vimSnapshot.mode).toBe("normal");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("accepts the selected Section with Tab", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
      initialTitle: "リンク先",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onInternalLinkCompletion: () => undefined,
    });
    editor.view.focus();
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("[[リンク");

    expect(press(editor, "Tab").defaultPrevented).toBe(true);
    expect(firstNode(editor, "internalSectionLink")?.attrs).toMatchObject({
      targetSectionId: runtime.noteId,
    });

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it.each(["codeBlock", "sourceBlock"] as const)(
    "does not start completion inside %s",
    async (type) => {
      const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
        idFactory: deterministicIds(),
        clock: () => "2026-08-03T00:00:00.000Z",
        initialTitle: "入力元",
      });
      const root = document.createElement("div");
      document.body.append(root);
      const { adapter, editor } = runtime.editorForTesting("window-1", root, {
        onInternalLinkCompletion: () => undefined,
      });
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type,
            attrs: type === "sourceBlock" ? { sourceFormat: "markdown" } : {},
            content: [{ type: "text", text: "[[入力" }],
          },
        ],
      });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.view.focus();
      adapter.refreshInternalLinkCompletion();

      expect(adapter.internalLinkCompletionSnapshot).toBeNull();

      adapter.destroy();
      runtime.destroy();
      root.remove();
    },
  );

  it("does not consume IME confirmation while composition is active", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock: () => "2026-08-03T00:00:00.000Z",
      initialTitle: "日本語ノート",
    });
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onInternalLinkCompletion: () => undefined,
    });
    editor.view.focus();
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("[[日本");
    expect(adapter.internalLinkCompletionSnapshot).not.toBeNull();

    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(adapter.internalLinkCompletionSnapshot).toBeNull();
    const enter = press(editor, "Enter", { isComposing: true });
    expect(enter.defaultPrevented).toBe(false);
    expect(firstNode(editor, "internalSectionLink")).toBeNull();

    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(adapter.internalLinkCompletionSnapshot).not.toBeNull();

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });
});

describe("Internal Link picker UI", () => {
  it("shows path/ID disambiguation and accepts a mouse selection without focus transfer", () => {
    const onSelect = vi.fn();
    const completion: InternalLinkCompletionSnapshot = {
      popupId: "picker-window-1",
      query: "メモ",
      from: 1,
      to: 5,
      selectedIndex: 1,
      anchor: { left: 12, top: 24 },
      candidates: [
        {
          noteId: "note-a",
          sectionId: "section-a",
          title: "メモ",
          parentPath: "仕事",
          shortId: "0000000a",
        },
        {
          noteId: "note-b",
          sectionId: "section-b",
          title: "メモ",
          parentPath: "個人",
          shortId: "0000000b",
        },
      ],
    };
    render(<InternalLinkPicker completion={completion} onSelect={onSelect} />);

    expect(
      screen.getByRole("listbox", { name: "内部リンク候補" }),
    ).toBeTruthy();
    expect(screen.getByText("個人 · 0000000b")).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(options[0]);
    expect(onSelect).toHaveBeenCalledWith("section-a");
  });
});
