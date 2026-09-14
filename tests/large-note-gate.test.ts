import { describe, expect, it } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";
import {
  NOTE_DOC_SCHEMA_VERSION,
  addNoteMetadata,
  createWorkspaceDocument,
  createReplicatedNoteDocumentFromSectionSnapshot,
  encodeProductDocument,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import { noteSearchLocationAtPosition } from "../app/src/core/note-search";
import { saveStableEditorPosition } from "../app/src/core/stable-position";
import {
  HUGE_NOTE_TARGET_BYTES,
  HUGE_NOTE_TARGET_LOGICAL_LINES,
  paragraphPasteFixture,
} from "./helpers/large-note";

const largeNoteGate =
  process.env.MEMOKA_RUN_LARGE_NOTE_GATE === "1" ? it : it.skip;

function pastePlainText(element: HTMLElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["text/plain"],
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  element.dispatchEvent(event);
  return event;
}

async function waitForLargePaste(
  action: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (action().includes("clipboard:paste:large:preparing")) {
    if (performance.now() >= deadline) {
      throw new Error(`large paste exceeded ${timeoutMs}ms`);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
  }
}

describe("Memoka opt-in 10 MiB / 100k-line gate", () => {
  largeNoteGate(
    "keeps paste, mounted DOM, ordinary input, search and restart bounded",
    async () => {
      const persistence = new MemoryPersistencePort();
      const replicated = process.env.MEMOKA_LARGE_NOTE_SCHEMA === "7";
      let replicatedNoteId: string | undefined;
      if (replicated) {
        replicatedNoteId = createUuidV7();
        const source = createReplicatedNoteDocumentFromSectionSnapshot(
          replicatedNoteId,
          {
            sectionId: replicatedNoteId,
            title: "Huge note gate",
            tags: [],
            children: [],
            body: [
              {
                type: "paragraph",
                attrs: { blockId: createUuidV7() },
                content: [],
              },
            ],
          },
          createUuidV7(),
        );
        const workspace = createWorkspaceDocument(createUuidV7());
        addNoteMetadata(workspace, {
          noteId: source.noteId,
          notePosition: "a0",
          createdAt: "",
          updatedAt: "",
          title: "Huge note gate",
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
        source.doc.destroy();
        workspace.doc.destroy();
      }
      const runtime = await CoreRuntime.open(persistence, {
        initialTitle: "Huge note gate",
        onError: (error) => {
          throw error;
        },
      });
      if (replicatedNoteId) {
        await runtime.openNote("window-1", replicatedNoteId);
        await runtime.executeCommand({
          name: "window.update_view",
          operationId: createUuidV7(),
          source: "internal",
          payload: { windowId: "window-1", update: { mode: "insert" } },
        });
      }
      const root = document.createElement("div");
      document.body.append(root);
      const messages: string[] = [];
      const attached = runtime.editorForTesting("window-1", root, {
        directBodyOnly: false,
        onMessage: (message) => messages.push(message),
      });
      let firstParagraph = -1;
      attached.editor.state.doc.descendants((node, position) => {
        if (firstParagraph < 0 && node.type.name === "paragraph") {
          firstParagraph = position + 1;
        }
        return firstParagraph < 0;
      });
      attached.editor.commands.setTextSelection(firstParagraph);
      attached.editor.commands.focus();
      const text = paragraphPasteFixture({
        paragraphCount: HUGE_NOTE_TARGET_LOGICAL_LINES,
        approximateParagraphBytes: 112,
      });
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThanOrEqual(
        HUGE_NOTE_TARGET_BYTES,
      );
      const pasteLimit = Number(
        process.env.MEMOKA_LARGE_NOTE_PASTE_LIMIT_MS ?? 30_000,
      );
      const pasteStarted = performance.now();
      expect(
        pastePlainText(attached.editor.view.dom, text).defaultPrevented,
      ).toBe(true);
      await waitForLargePaste(
        () => attached.adapter.vimSnapshot.action,
        pasteLimit,
      );
      const pasteElapsed = performance.now() - pasteStarted;
      expect(
        attached.adapter.vimSnapshot.action,
        JSON.stringify(messages),
      ).toBe("clipboard:paste:large:changed");
      expect(pasteElapsed).toBeLessThanOrEqual(pasteLimit);
      expect(runtime.noteDocument.undoManager.undoStack).toHaveLength(1);

      let paragraphCount = 0;
      let maximumChunkBlocks = 0;
      attached.editor.state.doc.descendants((node) => {
        if (node.type.name === "paragraph") paragraphCount += 1;
        if (node.type.name === "bodyChunk") {
          maximumChunkBlocks = Math.max(maximumChunkBlocks, node.childCount);
        }
        return true;
      });
      expect(paragraphCount).toBe(HUGE_NOTE_TARGET_LOGICAL_LINES);
      expect(maximumChunkBlocks).toBeLessThanOrEqual(512);
      expect(
        attached.editor.view.dom.querySelectorAll("p").length,
      ).toBeLessThanOrEqual(1_536);
      await new Promise<void>((resolve) =>
        globalThis.requestAnimationFrame(() => resolve()),
      );
      expect(
        root.querySelectorAll(".memoka-logical-line-number").length,
      ).toBeLessThanOrEqual(256);

      attached.editor.commands.setTextSelection(firstParagraph);
      const inputLimit = Number(
        process.env.MEMOKA_LARGE_NOTE_INPUT_LIMIT_MS ?? 500,
      );
      const inputDurations: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        attached.editor.commands.insertContent(String(index));
        inputDurations.push(performance.now() - started);
      }
      expect(Math.max(...inputDurations)).toBeLessThanOrEqual(inputLimit);

      let heartbeat = 0;
      const timer = globalThis.setInterval(() => {
        heartbeat += 1;
      }, 0);
      const results = await runtime.searchWorkspace(
        "performance sample",
        "body",
      );
      globalThis.clearInterval(timer);
      expect(results.results.length).toBeGreaterThan(0);
      expect(heartbeat).toBeGreaterThan(0);

      attached.editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      const searchCursor = attached.editor.state.selection.head;
      const noteSearchOrigin = {
        stable: saveStableEditorPosition(
          runtime.noteDocument,
          attached.editor.view,
          searchCursor,
        ),
        location: noteSearchLocationAtPosition(
          attached.editor.state,
          searchCursor,
        ),
      };
      const initialNoteSearch = await runtime.searchNote(
        "window-1",
        noteSearchOrigin,
        "performance sample",
      );
      if (!initialNoteSearch.destination) {
        throw new Error("large NoteDoc search did not return a destination");
      }
      attached.adapter.applyNavigationDestination(
        initialNoteSearch.destination,
        initialNoteSearch.detail,
      );
      const messagesBeforeRepeat = messages.length;
      const repeatLimit = Number(
        process.env.MEMOKA_LARGE_NOTE_SEARCH_REPEAT_LIMIT_MS ?? 100,
      );
      const repeatStarted = performance.now();
      attached.editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "N",
          code: "KeyN",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      while (
        messages.length === messagesBeforeRepeat &&
        performance.now() - repeatStarted <= repeatLimit
      ) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      const repeatElapsed = performance.now() - repeatStarted;
      expect(repeatElapsed).toBeLessThanOrEqual(repeatLimit);
      expect(messages.at(-1)).toBe(
        `/performance sample · ${initialNoteSearch.matchCount}/${initialNoteSearch.matchCount} · wrapped`,
      );

      await runtime.flush();
      attached.adapter.destroy();
      runtime.destroy();
      root.remove();
      const reopened = await CoreRuntime.open(persistence);
      expect(reopened.noteDocument.schemaVersion).toBe(
        replicated ? 7 : NOTE_DOC_SCHEMA_VERSION,
      );
      reopened.destroy();
    },
    120_000,
  );
});
