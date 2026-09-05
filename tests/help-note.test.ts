import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  CORE_TRANSACTION_ORIGIN,
  noteSectionCatalog,
  readNotePlainText,
  type NoteDocument,
} from "../app/src/core/documents";
import {
  MEMOKA_HELP_MARKDOWN,
  MEMOKA_HELP_TITLE,
} from "../app/src/core/help-note";
import { createUuidV7 } from "../app/src/core/ids";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import { sectionSnapshot } from "../app/src/core/section-model";

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
    expect(MEMOKA_HELP_MARKDOWN).toMatch(/^# Memoka help$/mu);
    expect(MEMOKA_HELP_MARKDOWN).toContain("## Command-lineと設定");

    const note = runtime.getNoteHandle(first.noteId).current as NoteDocument;
    expect(noteSectionCatalog(note).map(({ title }) => title)).toEqual(
      expect.arrayContaining([
        "最初に覚える",
        "Insert mode",
        "移動と編集",
        "Visual選択と文字装飾",
        "Table編集",
        "Command-lineと設定",
        "データと復旧",
      ]),
    );
    expect(collectNodeNames(note)).toEqual(
      expect.arrayContaining([
        "section",
        "blockquote",
        "bulletList",
        "table",
        "codeBlock",
      ]),
    );
    const helpText = readNotePlainText(note);
    for (const expected of [
      "通常は保存操作を行う必要がありません",
      "[count]h/j/k/l",
      "Ctrl-t",
      "BudouXの文節",
      "Visual Block",
      "Focused Section subtree",
      "Table編集",
      "既定Leaderは,です",
      "config.toml",
      "wait_for_mirror = false",
      "portable mirror",
      ":help",
    ]) {
      expect(helpText).toContain(expected);
    }
    expect(helpText).not.toContain("<code>");
    expect(helpText).not.toContain("<link");
    const helpSnapshot = sectionSnapshot(note.rootSection);
    const serializedHelp = JSON.stringify(helpSnapshot);
    expect(serializedHelp).toContain('"type":"bold"');
    expect(serializedHelp).toContain('"type":"italic"');
    expect(serializedHelp).toContain('"type":"code"');
    expect(serializedHelp).toContain('"type":"link"');
    const internalLinks = collectSerializedNodes(
      helpSnapshot,
      "internalSectionLink",
    );
    expect(internalLinks.length).toBeGreaterThanOrEqual(14);
    const sectionIds = new Set(
      noteSectionCatalog(note).map(({ sectionId }) => sectionId),
    );
    expect(
      internalLinks.every((link) => {
        const attrs = link.attrs;
        return (
          attrs !== null &&
          typeof attrs === "object" &&
          sectionIds.has(
            String((attrs as Record<string, unknown>).targetSectionId),
          )
        );
      }),
    ).toBe(true);
    const blockIds = collectBlockIds(note);
    const stableSectionIds = [...sectionIds];

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
    expect(noteSectionCatalog(note).map(({ sectionId }) => sectionId)).toEqual(
      stableSectionIds,
    );
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
    const search = await reopened.searchWorkspace("自動保存", "body");
    expect(search.results.some(({ noteId }) => noteId === created.noteId)).toBe(
      true,
    );
    const synchronized = await reopened.openHelpNote("window-1");
    expect(synchronized.noteId).toBe(created.noteId);
    expect(synchronized.created).toBe(false);
    reopened.destroy();
  });
});

function collectSerializedNodes(
  value: unknown,
  type: string,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    if (record.type === type) matches.push(record);
    pending.push(...Object.values(record));
  }
  return matches;
}

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
