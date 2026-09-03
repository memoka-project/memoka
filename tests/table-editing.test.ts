import type { Editor } from "@tiptap/core";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { describe, expect, it, vi } from "vitest";
import type { UndoManager } from "yjs";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { mergeApplicationKeyConfig } from "../app/src/core/application-key-config";
import type { TableActionPickerRequest } from "../app/src/editor/tiptap-adapter";
import { visualCharCursor } from "../app/src/vim/editor-commands";
import { moveVisualBlockHeadToPosition } from "../app/src/vim/table-editing";

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

function positionOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && node.isText && node.text?.includes(text)) {
      found = position + (node.text.indexOf(text) ?? 0);
    }
  });
  if (found < 0) throw new Error(`Missing fixture text: ${text}`);
  return found;
}

function currentCellText(editor: Editor): string | null {
  const selection = editor.state.selection;
  const position =
    selection instanceof CellSelection
      ? selection.$headCell.pos
      : selection.head;
  const $position = editor.state.doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const node = $position.node(depth);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      return node.textContent;
    }
  }
  return editor.state.doc.nodeAt(position)?.textContent ?? null;
}

function editorUndoManager(editor: Editor): UndoManager {
  for (const plugin of editor.state.plugins) {
    const pluginState = plugin.getState(editor.state) as
      { undoManager?: UndoManager } | undefined;
    if (pluginState?.undoManager) return pluginState.undoManager;
  }
  throw new Error("Yjs UndoManager not found");
}

function tableFixture() {
  const cell = (type: "tableHeader" | "tableCell", text: string) => ({
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : undefined,
      },
    ],
  });
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              cell("tableHeader", "H1"),
              cell("tableHeader", "H2"),
              cell("tableHeader", "H3"),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", "A1"),
              cell("tableCell", "A2"),
              cell("tableCell", "A3"),
            ],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", "B1"),
              cell("tableCell", "B2"),
              cell("tableCell", "B3"),
            ],
          },
        ],
      },
    ],
  };
}

describe("keyboard-first Table editing", () => {
  it("keeps the GFM grid unchanged when Visual Block meets a merged cell", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const fixture = tableFixture();
    const header = fixture.content[0]!.content[0]!.content;
    header[0]!.attrs = { colspan: 2, rowspan: 1, colwidth: null };
    header.splice(1, 1);
    editor.commands.setContent(fixture);
    editor.commands.setTextSelection(positionOf(editor, "H1") + 1);
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(editor.state.doc.firstChild?.child(0).child(0).attrs.colspan).toBe(
      2,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves h/l across Cells, lets word motions cross Cells, and selects rectangular Cells with Ctrl-v", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A2") + 1);
    editor.commands.focus();
    press(editor, "Escape");

    const a2Start = positionOf(editor, "A2");
    editor.commands.setTextSelection(a2Start);
    press(editor, "h");
    expect(editor.state.selection.head).toBe(positionOf(editor, "A1") + 1);
    editor.commands.setTextSelection(a2Start + 1);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "A3"));
    editor.commands.setTextSelection(a2Start + 1);
    press(editor, "w");
    expect(currentCellText(editor)).toBe("A3");
    press(editor, "b");
    expect(currentCellText(editor)).toBe("A2");

    press(editor, "j");
    expect(currentCellText(editor)).toBe("B2");
    press(editor, "k");
    expect(currentCellText(editor)).toBe("A2");
    press(editor, "Tab");
    expect(currentCellText(editor)).toBe("A3");
    press(editor, "Tab", { shiftKey: true });
    expect(currentCellText(editor)).toBe("A2");

    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    expect(adapter.vimSnapshot.mode).toBe("visual-block");
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    press(editor, "l");
    press(editor, "j");
    const selection = editor.state.selection;
    expect(selection).toBeInstanceOf(CellSelection);
    if (!(selection instanceof CellSelection)) {
      throw new Error("Visual Block did not create CellSelection");
    }
    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("Missing Table");
    const rectangle = TableMap.get(table).rectBetween(
      selection.$anchorCell.pos - 1,
      selection.$headCell.pos - 1,
    );
    expect(rectangle).toMatchObject({ top: 1, bottom: 3, left: 1, right: 3 });

    expect(
      moveVisualBlockHeadToPosition(editor.view, positionOf(editor, "B1")),
    ).toMatchObject({ handled: true });
    const viewportSelection = editor.state.selection;
    expect(viewportSelection).toBeInstanceOf(CellSelection);
    if (!(viewportSelection instanceof CellSelection)) {
      throw new Error("Viewport movement lost the Visual Block selection");
    }
    expect(
      TableMap.get(table).rectBetween(
        viewportSelection.$anchorCell.pos - 1,
        viewportSelection.$headCell.pos - 1,
      ),
    ).toMatchObject({ top: 1, bottom: 3, left: 0, right: 2 });
    expect(
      moveVisualBlockHeadToPosition(editor.view, positionOf(editor, "B3")),
    ).toMatchObject({ handled: true });

    press(editor, "y");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(adapter.vimSnapshot.register).toContain("Table 2×2");
    expect(currentCellText(editor)).toBe("A2");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves Normal h/l between Table edges and adjacent logical lines", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        tableFixture().content[0]!,
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    editor.commands.setTextSelection(positionOf(editor, "H1"));
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "h");
    expect(editor.state.selection.head).toBe(
      positionOf(editor, "before") + "before".length - 1,
    );

    editor.commands.setTextSelection(positionOf(editor, "B3") + 1);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "after"));

    editor.commands.setTextSelection(positionOf(editor, "B3") + 1);
    press(editor, "3");
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "after") + 2);

    editor.commands.setTextSelection(positionOf(editor, "H3") + 1);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "A1"));

    editor.commands.setTextSelection(positionOf(editor, "A2") + 1);
    press(editor, "2");
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "A3") + 1);

    editor.commands.setTextSelection(positionOf(editor, "H3") + 1);
    press(editor, "v");
    press(editor, "l");
    expect(adapter.vimSnapshot.mode).toBe("visual-char");
    expect(visualCharCursor(editor.view)).toBe(positionOf(editor, "A1"));

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps h/l within the current Table logical row when whichwrap is disabled", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      keyConfig: mergeApplicationKeyConfig({ whichwrap: false }),
    });
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        tableFixture().content[0]!,
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    editor.commands.focus();
    press(editor, "Escape");

    const h1Start = positionOf(editor, "H1");
    editor.commands.setTextSelection(h1Start);
    press(editor, "h");
    expect(editor.state.selection.head).toBe(h1Start);

    editor.commands.setTextSelection(positionOf(editor, "H2") + 1);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(positionOf(editor, "H3"));

    const h3End = positionOf(editor, "H3") + 1;
    editor.commands.setTextSelection(h3End);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(h3End);

    const b3End = positionOf(editor, "B3") + 1;
    editor.commands.setTextSelection(b3End);
    press(editor, "l");
    expect(editor.state.selection.head).toBe(b3End);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("includes the final character of a rightmost Table Cell in Visual Char", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    const finalCharacter = positionOf(editor, "B3") + 1;
    editor.commands.focus();
    press(editor, "Escape");
    editor.commands.setTextSelection(finalCharacter);

    press(editor, "v");
    expect(editor.state.selection.from).toBe(finalCharacter);
    expect(editor.state.selection.to).toBe(finalCharacter + 1);
    expect(
      root.querySelector(".memoka-visual-char-selected")?.textContent,
    ).toBe("3");
    press(editor, "y");
    expect(adapter.vimSnapshot.register).toBe("text: 3");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("moves j/k from a boundary Table row to the adjacent logical line", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before table" }],
        },
        tableFixture().content[0]!,
        {
          type: "paragraph",
          content: [{ type: "text", text: "after table" }],
        },
      ],
    });
    editor.commands.setTextSelection(positionOf(editor, "H2"));
    editor.commands.focus();
    press(editor, "Escape");

    press(editor, "k");
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(
      positionOf(editor, "before table"),
    );
    expect(editor.state.selection.from).toBeLessThan(
      positionOf(editor, "before table") + "before table".length,
    );

    editor.commands.setTextSelection(positionOf(editor, "B2"));
    press(editor, "j");
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(
      positionOf(editor, "after table"),
    );
    expect(editor.state.selection.from).toBeLessThan(
      positionOf(editor, "after table") + "after table".length,
    );

    editor.commands.setTextSelection(positionOf(editor, "H2"));
    press(editor, "3");
    press(editor, "j");
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(
      positionOf(editor, "after table"),
    );
    expect(editor.state.selection.from).toBeLessThan(
      positionOf(editor, "after table") + "after table".length,
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("treats an empty Cell as an h/l/w/b/e motion stop", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    const fixture = tableFixture();
    fixture.content[0]!.content[1]!.content[1]!.content[0]!.content = undefined;
    editor.commands.setContent(fixture);
    editor.commands.focus();
    press(editor, "Escape");

    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    press(editor, "w");
    expect(currentCellText(editor)).toBe("");

    editor.commands.setTextSelection(positionOf(editor, "A3"));
    press(editor, "b");
    expect(currentCellText(editor)).toBe("");

    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    press(editor, "e");
    expect(currentCellText(editor)).toBe("");

    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    press(editor, "l");
    expect(currentCellText(editor)).toBe("");
    press(editor, "l");
    expect(currentCellText(editor)).toBe("A3");
    press(editor, "h");
    expect(currentCellText(editor)).toBe("");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("restores a persisted Visual Block rectangle without collapsing it", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let attached = runtime.editorForTesting("window-1", root);
    attached.editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        tableFixture().content[0]!,
      ],
    });
    attached.editor.commands.setTextSelection(
      positionOf(attached.editor, "A1"),
    );
    attached.editor.commands.focus();
    press(attached.editor, "Escape");
    press(attached.editor, "v", { ctrlKey: true, code: "KeyV" });
    press(attached.editor, "l");
    press(attached.editor, "j");

    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 140));
    await runtime.flush();
    const persisted = runtime.windows.get("window-1");
    const selected = attached.editor.state.selection;
    if (!(selected instanceof CellSelection)) {
      throw new Error("Visual Block selection was not active before restore");
    }
    expect(persisted?.mode).toBe("visual-block");
    expect(persisted?.selection).toEqual({
      anchor: selected.$anchorCell.pos,
      head: selected.$headCell.pos,
    });

    attached.adapter.destroy();
    root.replaceChildren();
    attached = runtime.editorForTesting("window-1", root);
    expect(attached.adapter.vimSnapshot.mode).toBe("visual-block");
    const restored = attached.editor.state.selection;
    expect(restored).toBeInstanceOf(CellSelection);
    if (!(restored instanceof CellSelection)) {
      throw new Error("Visual Block selection was not restored");
    }
    let table: (typeof attached.editor.state.doc)["firstChild"] = null;
    let tableStart = -1;
    attached.editor.state.doc.descendants((node, position) => {
      if (!table && node.type.name === "table") {
        table = node;
        tableStart = position + 1;
        return false;
      }
      return !table;
    });
    if (!table || tableStart < 0) throw new Error("Missing restored Table");
    expect(
      TableMap.get(table).rectBetween(
        restored.$anchorCell.pos - tableStart,
        restored.$headCell.pos - tableStart,
      ),
    ).toMatchObject({ top: 1, bottom: 3, left: 0, right: 2 });

    attached.adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("adds a body row only from the final Cell in Insert and stops Normal Tab at the edge", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "H1"));
    editor.commands.focus();
    const insertBoundary = press(editor, "Tab", { shiftKey: true });
    expect(insertBoundary.defaultPrevented).toBe(true);
    expect(currentCellText(editor)).toBe("H1");

    editor.commands.setTextSelection(positionOf(editor, "B3") + 1);

    press(editor, "Tab");
    expect(editor.state.doc.firstChild?.childCount).toBe(4);
    expect(currentCellText(editor)).toBe("");
    press(editor, "Escape");
    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("Table fixture is empty");
    const lastCell = 1 + TableMap.get(table).positionAt(3, 2, table);
    editor.commands.setTextSelection(lastCell + 2);
    const rowCount = editor.state.doc.firstChild?.childCount;
    press(editor, "Tab");
    expect(editor.state.doc.firstChild?.childCount).toBe(rowCount);
    expect(currentCellText(editor)).toBe("");
    expect(adapter.vimSnapshot.action).toBe("table:next-cell:boundary");

    editor.commands.setTextSelection(positionOf(editor, "H1"));
    const normalBoundary = press(editor, "ISO_Left_Tab");
    expect(normalBoundary.defaultPrevented).toBe(true);
    expect(currentCellText(editor)).toBe("H1");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("pastes a Table Cell rectangle at the current Cell for both p and P", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A1"));
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    press(editor, "y");

    editor.commands.setTextSelection(positionOf(editor, "B2"));
    press(editor, "p");
    expect(editor.state.doc.firstChild?.child(2).child(1).textContent).toBe(
      "A1",
    );
    press(editor, "u");
    expect(editor.state.doc.firstChild?.child(2).child(1).textContent).toBe(
      "B2",
    );

    editor.commands.setTextSelection(positionOf(editor, "B2"));
    press(editor, "P");
    expect(editor.state.doc.firstChild?.child(2).child(1).textContent).toBe(
      "A1",
    );

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("clears a rectangle without changing the grid and repeats it with dot", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    press(editor, "l");
    press(editor, "d");

    let table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    expect(table?.child(1).textContent).toBe("A3");
    expect(table?.child(2).textContent).toBe("B1B2B3");

    editor.commands.setTextSelection(positionOf(editor, "B1"));
    press(editor, ".");
    table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    expect(table?.child(2).textContent).toBe("B3");
    expect(adapter.vimSnapshot.mode).toBe("normal");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("keeps Visual Block c plus Insert text in one Undo unit, including dot repeat", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { adapter, editor } = runtime.editorForTesting("window-1", root);
    editor.commands.setContent(tableFixture());
    editor.commands.focus();
    await runtime.flush();
    const undoManager = editorUndoManager(editor);
    undoManager.clear();
    undoManager.stopCapturing();

    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    press(editor, "Escape");
    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    press(editor, "l");
    press(editor, "c");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("X");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe("XA3");
    expect(undoManager.undoStack).toHaveLength(1);

    editor.commands.setTextSelection(positionOf(editor, "B1"));
    press(editor, ".");
    expect(adapter.vimSnapshot.mode).toBe("insert");
    editor.commands.insertContent("Y");
    press(editor, "Escape");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.child(2).textContent).toBe("YB3");
    expect(undoManager.undoStack).toHaveLength(2);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe("XA3");
    expect(editor.state.doc.firstChild?.child(2).textContent).toBe("B1B2B3");
    expect(currentCellText(editor)).toBe("B1");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("opens the shared action pane and applies row and column operations", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const requests: TableActionPickerRequest[] = [];
    const onTableActionPicker = vi.fn((next: TableActionPickerRequest) => {
      requests.push(next);
    });
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onTableActionPicker,
    });
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A2") + 1);
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, ",");
    press(editor, "a");
    expect(onTableActionPicker).toHaveBeenCalledOnce();
    const firstRequest = requests[0];
    if (!firstRequest) throw new Error("Table action request was not captured");

    expect(firstRequest.apply("row.add_after")).toMatchObject({
      changed: true,
    });
    let table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(4);
    expect(
      table
        ?.child(0)
        .content.content.every((cell) => cell.type.name === "tableHeader"),
    ).toBe(true);
    expect(
      table
        ?.child(1)
        .content.content.every((cell) => cell.type.name === "tableCell"),
    ).toBe(true);

    editor.commands.setTextSelection(positionOf(editor, "A2"));
    press(editor, ",");
    press(editor, "a");
    const secondRequest = requests[1];
    if (!secondRequest)
      throw new Error("Second Table action request was not captured");
    expect(secondRequest.apply("column.align_right")).toMatchObject({
      changed: true,
    });
    table = editor.state.doc.firstChild;
    expect(
      Array.from(
        { length: table?.childCount ?? 0 },
        (_, row) => table?.child(row).child(1).attrs.align,
      ),
    ).toEqual(["right", "right", "right", "right"]);

    editor.commands.setTextSelection(positionOf(editor, "H1"));
    press(editor, ",");
    press(editor, "a");
    const thirdRequest = requests[2];
    if (!thirdRequest)
      throw new Error("Third Table action request was not captured");
    expect(thirdRequest.apply("row.delete")).toMatchObject({ changed: true });
    table = editor.state.doc.firstChild;
    expect(table?.child(0).textContent).toBe("A1A2A3");
    expect(
      table
        ?.child(0)
        .content.content.every((cell) => cell.type.name === "tableHeader"),
    ).toBe(true);
    expect(
      table
        ?.child(1)
        .content.content.every((cell) => cell.type.name === "tableCell"),
    ).toBe(true);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("passes a Visual Line TableRow range to the shared action pane", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let request: TableActionPickerRequest | null = null;
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onTableActionPicker: (next) => {
        request = next;
      },
    });
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A2") + 1);
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "V");
    press(editor, "j");
    press(editor, ",");
    press(editor, "a");
    const opened = request as unknown as TableActionPickerRequest | null;
    if (!opened) throw new Error("Table action request was not captured");
    expect(opened.selection).toMatchObject({
      mode: "visual-line",
      rowFrom: 1,
      rowTo: 2,
      activeRow: 2,
    });

    expect(opened.apply("row.add_after")).toMatchObject({ changed: true });
    expect(editor.state.doc.firstChild?.childCount).toBe(5);
    expect(adapter.vimSnapshot.mode).toBe("normal");

    press(editor, ".");
    expect(editor.state.doc.firstChild?.childCount).toBe(7);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("adds and dot-repeats as many columns as a Visual Block selects", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let request: TableActionPickerRequest | null = null;
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onTableActionPicker: (next) => {
        request = next;
      },
    });
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A1"));
    editor.commands.focus();
    press(editor, "Escape");
    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    press(editor, "l");
    press(editor, ",");
    press(editor, "a");
    const opened = request as unknown as TableActionPickerRequest | null;
    if (!opened) throw new Error("Table action request was not captured");

    expect(opened.apply("column.add_after")).toMatchObject({
      changed: true,
      repeat: { action: "column.add_after", amount: 2 },
    });
    expect(editor.state.doc.firstChild?.child(0).childCount).toBe(5);

    press(editor, ".");
    expect(editor.state.doc.firstChild?.child(0).childCount).toBe(7);

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });

  it("deletes the whole Table when an action removes every selected column", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    let request: TableActionPickerRequest | null = null;
    const { adapter, editor } = runtime.editorForTesting("window-1", root, {
      onTableActionPicker: (next) => {
        request = next;
      },
    });
    editor.commands.setContent(tableFixture());
    editor.commands.setTextSelection(positionOf(editor, "A1") + 1);
    editor.commands.focus();
    await runtime.flush();
    const undoManager = editorUndoManager(editor);
    undoManager.clear();
    undoManager.stopCapturing();
    press(editor, "Escape");
    press(editor, "v", { ctrlKey: true, code: "KeyV" });
    press(editor, "$");
    press(editor, ",");
    press(editor, "a");
    const opened = request as unknown as TableActionPickerRequest | null;
    if (!opened) throw new Error("Table action request was not captured");

    expect(opened.apply("column.delete")).toMatchObject({ changed: true });
    await runtime.flush();
    expect(
      Array.from(
        { length: editor.state.doc.childCount },
        (_, index) => editor.state.doc.child(index).type.name,
      ),
    ).not.toContain("table");
    expect(adapter.vimSnapshot.mode).toBe("normal");
    expect(undoManager.undoStack).toHaveLength(1);

    press(editor, "u");
    await runtime.flush();
    expect(editor.state.doc.firstChild?.type.name).toBe("table");

    adapter.destroy();
    runtime.destroy();
    root.remove();
  });
});
