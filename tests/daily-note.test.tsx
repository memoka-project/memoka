import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import { treeVisibleNamespaceNodes } from "../app/src/core/namespace";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

describe("daily Note commands", () => {
  it("creates a new hidden Note each time with the local calendar date", async () => {
    const persistence = new MemoryPersistencePort();
    let today = new Date(2026, 8, 29, 23, 59);
    let runtime = await CoreRuntime.open(persistence, {
      clock: () => today.toISOString(),
    });
    let firstId: string;
    try {
      firstId = (await runtime.createDailyNote("window-1")).noteId;
      expect(runtime.snapshot().windows[0]?.selection).toEqual({
        anchor: 11,
        head: 11,
      });
      const secondId = (await runtime.createDailyNote("window-1")).noteId;
      expect(secondId).not.toBe(firstId);
      for (const noteId of [firstId, secondId]) {
        expect(
          runtime.snapshot().notes.find((note) => note.noteId === noteId),
        ).toMatchObject({ title: "2026-09-29", treeHidden: true });
        expect(
          treeVisibleNamespaceNodes(runtime.snapshot().namespaceEntries).some(
            (entry) => entry.targetNoteId === noteId,
          ),
        ).toBe(false);
        expect(
          runtime.snapshot().allNotesRows.some((row) => row.noteId === noteId),
        ).toBe(true);
      }
      today = new Date(2026, 8, 30, 0, 1);
      const nextDay = await runtime.createDailyNote("window-1");
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === nextDay.noteId),
      ).toMatchObject({ title: "2026-09-30" });
      expect(await runtime.openDailyNote("window-1")).toMatchObject({
        noteId: nextDay.noteId,
        created: false,
      });
      await runtime.flush();
    } finally {
      runtime.destroy();
    }
    runtime = await CoreRuntime.open(persistence);
    try {
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === firstId!),
      ).toMatchObject({ title: "2026-09-29", treeHidden: true });
    } finally {
      runtime.destroy();
    }
  });

  it("opens the oldest live exact-title Note and creates one when absent", async () => {
    let minute = 0;
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      clock: () => new Date(2026, 8, 29, 9, minute++).toISOString(),
    });
    try {
      const title = "2026-09-29";
      const firstId = (await runtime.createNoteAtEnd("window-1", title)).noteId;
      const secondId = (await runtime.createDailyNote("window-1")).noteId;
      expect(secondId).not.toBe(firstId);
      const noteCount = runtime.snapshot().notes.length;
      const opened = await runtime.openDailyNote("window-1");
      expect(opened).toEqual({ noteId: firstId, title, created: false });
      expect(runtime.snapshot().windows[0]?.noteId).toBe(firstId);
      expect(runtime.snapshot().notes).toHaveLength(noteCount);

      const firstEntryId = runtime
        .snapshot()
        .notes.find((note) => note.noteId === firstId)!.entryId!;
      await runtime.trashNamespaceEntry(firstEntryId);
      expect(await runtime.openDailyNote("window-1")).toMatchObject({
        noteId: secondId,
        created: false,
      });
      const secondEntryId = runtime
        .snapshot()
        .notes.find((note) => note.noteId === secondId)!.entryId!;
      await runtime.trashNamespaceEntry(secondEntryId);
      const replacement = await runtime.openDailyNote("window-1");
      expect(replacement).toMatchObject({ title, created: true });
      expect(replacement.noteId).not.toBe(firstId);
      expect(replacement.noteId).not.toBe(secondId);
    } finally {
      runtime.destroy();
    }
  });

  it("reuses one Note for concurrent open requests", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      clock: () => new Date(2026, 8, 29, 9).toISOString(),
    });
    try {
      const [first, second] = await Promise.all([
        runtime.openDailyNote("window-1"),
        runtime.openDailyNote("window-1"),
      ]);
      expect(first).toMatchObject({ created: true });
      expect(second).toMatchObject({ noteId: first.noteId, created: false });
      expect(
        runtime.snapshot().notes.filter((note) => note.title === "2026-09-29"),
      ).toHaveLength(1);
    } finally {
      runtime.destroy();
    }
  });

  it("runs both commands from the Command-line and focuses the Note", async () => {
    const create = vi.spyOn(CoreRuntime.prototype, "createDailyNote");
    const open = vi.spyOn(CoreRuntime.prototype, "openDailyNote");
    const view = render(<App />);
    try {
      const editor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          ".editor-window .memoka-editor",
        );
        if (!element) throw new Error("Editor did not mount");
        return element;
      });
      const execute = (target: HTMLElement, commandName: string) => {
        fireEvent.keyDown(target, { key: "Escape", code: "Escape" });
        fireEvent.keyDown(target, {
          key: ":",
          code: "Semicolon",
          shiftKey: true,
        });
        const command = screen.getByRole("textbox", { name: "Memoka Command" });
        fireEvent.change(command, { target: { value: commandName } });
        fireEvent.keyDown(command, { key: "Enter" });
      };
      execute(editor, "open-daily-note");
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      const runtime = open.mock.contexts[0] as CoreRuntime;
      const first = await open.mock.results[0]!.value;
      expect(first.created).toBe(true);
      const dailyId = first.noteId;
      const dailyEditor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          `.editor-window .memoka-editor[data-note-id="${dailyId}"]`,
        );
        if (!element) throw new Error("Daily Note did not open");
        return element;
      });
      await waitFor(() => expect(document.activeElement).toBe(dailyEditor));
      expect(
        runtime.snapshot().notes.find((note) => note.noteId === dailyId),
      ).toMatchObject({ treeHidden: true });

      execute(dailyEditor, "new-daily-note");
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const secondId = (await create.mock.results[0]!.value).noteId;
      expect(secondId).not.toBe(dailyId);
      const secondEditor = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>(
          `.editor-window .memoka-editor[data-note-id="${secondId}"]`,
        );
        if (!element) throw new Error("Second Daily Note did not open");
        return element;
      });
      await waitFor(() => expect(document.activeElement).toBe(secondEditor));

      execute(secondEditor, "open-daily-note");
      await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
      expect(await open.mock.results[1]!.value).toMatchObject({
        noteId: dailyId,
        created: false,
      });
      expect(runtime.snapshot().windows[0]?.noteId).toBe(dailyId);
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("data-note-id")).toBe(
          dailyId,
        ),
      );
    } finally {
      view.unmount();
      create.mockRestore();
      open.mockRestore();
    }
  });
});
