import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CORE_TRANSACTION_ORIGIN,
  noteSectionCatalog,
  readNotePlainText,
  type NoteDocument,
} from "../app/src/core/documents";
import { MEMOKA_HELP_TITLE } from "../app/src/core/help-note";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter;
    counter += 1;
    return createUuidV7(1_799_107_200_000 + seed, (target) => {
      target.fill((seed * 29) & 0xff);
      return target;
    });
  };
}

const clock = () => "2027-01-05T00:00:00.000Z";

describe("managed Memoka help note", () => {
  it("creates one rich Help NoteDoc and keeps semantic block IDs stable", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
      initialTitle: MEMOKA_HELP_TITLE,
    });

    const first = await runtime.openHelpNote("window-1");
    expect(first).toMatchObject({ created: true, restored: false });
    const managed = runtime
      .snapshot()
      .notes.filter(({ systemRole }) => systemRole === "help");
    expect(managed).toHaveLength(1);
    expect(managed[0]?.title).toBe(MEMOKA_HELP_TITLE);
    expect(
      runtime
        .snapshot()
        .notes.filter(({ title }) => title === MEMOKA_HELP_TITLE),
    ).toHaveLength(2);

    const note = runtime.getNoteHandle(first.noteId).current as NoteDocument;
    expect(noteSectionCatalog(note).map(({ title }) => title)).toEqual(
      expect.arrayContaining(["最初に覚える", "移動と編集", "Command-line"]),
    );
    expect(collectNodeNames(note)).toEqual(
      expect.arrayContaining(["section", "bulletList", "table", "codeBlock"]),
    );
    const helpText = readNotePlainText(note);
    expect(helpText).toContain("最初に覚える");
    expect(helpText).toContain("[count]j/k");
    expect(helpText).toContain("左右Sidebarを閉じる");
    expect(helpText).toContain("t1〜t9 / t0");
    expect(helpText).toContain("Enter / Tabは無効");
    expect(helpText).toContain("Ctrl-t / Ctrl-d");
    expect(helpText).toContain("Root表示中はNoteDoc全体");
    expect(helpText).toContain("ステータスライン");
    expect(helpText).toContain("h/lで折り畳み");
    expect(helpText).toContain("config.toml");
    expect(helpText).toContain("wait_for_mirror = false");
    expect(helpText).toContain("既存Windowを前面へ戻します");
    expect(helpText).toContain("[count]n / N");
    expect(helpText).toContain("Focused Section subtree");
    expect(helpText).toContain("zfはcaret位置を保って1階層深く");
    expect(helpText).toContain("現在Focusから親へ1階層戻ります");
    expect(helpText).toContain("whichwrap有効時は行端から前後論理行へ移動");
    expect(helpText).toContain("全block共通で制御");
    expect(helpText).toContain(":note-width 1200");
    expect(helpText).toContain("最大1000 CSS px");
    expect(helpText).toContain("<Leader>C");
    expect(helpText).toContain("Config / Settings");
    expect(helpText).toContain("予約済み（未実装）");
    expect(helpText).toContain(",cは共通検索ペイン");
    expect(helpText).toContain("/または,s");
    expect(helpText).toContain("Image Block stub、Attachment Fileを選べます");
    expect(helpText).toContain("Attachment Fileまたは:attach");
    expect(helpText).toContain("取り消すと「/」は本文に残ります");
    expect(helpText).toContain(":help");
    const blockIds = collectBlockIds(note);

    await runtime.renameNote(first.noteId, "書き換えたHelp");
    await runtime.executeCommand({
      name: "note.replace_text",
      operationId: deterministicIds()(),
      source: "ui",
      payload: { noteId: first.noteId, text: "利用者の一時編集" },
    });
    const second = await runtime.openHelpNote("window-1");
    expect(second).toMatchObject({
      noteId: first.noteId,
      created: false,
      restored: false,
    });
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === first.noteId)
        ?.title,
    ).toBe(MEMOKA_HELP_TITLE);
    expect(readNotePlainText(note)).not.toContain("利用者の一時編集");
    expect(collectBlockIds(note)).toEqual(blockIds);
    runtime.destroy();
  });

  it("restores the managed singleton from Trash before synchronizing it", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
    });
    const created = await runtime.openHelpNote("window-1");
    await runtime.moveNoteToTrash(created.noteId);
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === created.noteId)
        ?.deletedAt,
    ).toBeTruthy();

    const restored = await runtime.openHelpNote("window-1");
    expect(restored).toMatchObject({
      noteId: created.noteId,
      created: false,
      restored: true,
    });
    expect(
      runtime.snapshot().notes.find(({ noteId }) => noteId === created.noteId)
        ?.deletedAt,
    ).toBeUndefined();
    expect(runtime.windows.get("window-1")).toMatchObject({
      noteId: created.noteId,
      mode: "normal",
    });
    runtime.destroy();
  });

  it("rejects duplicate system markers without mutating either note", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
    });
    const first = await runtime.openHelpNote("window-1");
    const second = await runtime.createNoteAtEnd("window-1", "別のノート");
    const secondMetadata = runtime.workspaceDocument.notes.get(second.noteId);
    runtime.workspaceDocument.doc.transact(() => {
      secondMetadata?.set("system_role", "help");
    }, CORE_TRANSACTION_ORIGIN);
    const before = readNotePlainText(
      runtime.getNoteHandle(first.noteId).current as NoteDocument,
    );

    await expect(runtime.openHelpNote("window-1")).rejects.toThrow(
      "管理Helpノートが複数あります",
    );
    expect(
      readNotePlainText(
        runtime.getNoteHandle(first.noteId).current as NoteDocument,
      ),
    ).toBe(before);
    runtime.destroy();
  });

  it("rolls back Help creation when the transaction cannot commit", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort(), {
      idFactory: deterministicIds(),
      clock,
    });
    const before = runtime.snapshot().applicationWindow;
    const ids = deterministicIds();
    await expect(
      runtime.executeCommand({
        name: "note.open_help",
        operationId: ids(),
        source: "ui",
        payload: {
          windowId: "window-1",
          newNoteId: ids(),
          synchronizedAt: clock(),
          fault: "before-sql-commit",
        },
      }),
    ).rejects.toThrow("before-sql-commit");
    expect(
      runtime
        .snapshot()
        .notes.filter(({ systemRole }) => systemRole === "help"),
    ).toHaveLength(0);
    expect(runtime.snapshot().applicationWindow).toEqual(before);
    runtime.destroy();
  });

  it("keeps the managed identity searchable across restart", async () => {
    const persistence = new MemoryPersistencePort();
    const runtime = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    const created = await runtime.openHelpNote("window-1");
    runtime.destroy();

    const reopened = await CoreRuntime.open(persistence, {
      idFactory: deterministicIds(),
      clock,
    });
    expect(
      reopened.snapshot().notes.find(({ systemRole }) => systemRole === "help")
        ?.noteId,
    ).toBe(created.noteId);
    const search = await reopened.searchWorkspace("操作説明", "body");
    expect(search.results.some(({ noteId }) => noteId === created.noteId)).toBe(
      true,
    );
    const synchronized = await reopened.openHelpNote("window-1");
    expect(synchronized.noteId).toBe(created.noteId);
    expect(synchronized.created).toBe(false);
    reopened.destroy();
  });
});

function collectBlockIds(note: NoteDocument): string[] {
  const output: string[] = [];
  const visit = (value: Y.XmlElement | Y.XmlText): void => {
    if (!(value instanceof Y.XmlElement)) return;
    const blockId = value.getAttribute("blockId");
    if (typeof blockId === "string") output.push(blockId);
    for (const child of value.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        visit(child);
      }
    }
  };
  for (const value of note.rootSection.toArray()) {
    if (value instanceof Y.XmlElement || value instanceof Y.XmlText) {
      visit(value);
    }
  }
  return output;
}

function collectNodeNames(note: NoteDocument): string[] {
  const output: string[] = [];
  const pending: Array<Y.XmlElement | Y.XmlText> = [note.rootSection];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (!(value instanceof Y.XmlElement)) continue;
    output.push(value.nodeName);
    for (const child of value.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
        pending.push(child);
      }
    }
  }
  return output;
}
