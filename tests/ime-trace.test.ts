import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryPersistencePort } from "../app/src/core/persistence";
import { CoreRuntime } from "../app/src/core/runtime";

const source = readFileSync(
  resolve(process.cwd(), "scripts/trace-editor-ime.js"),
  "utf8",
);

interface Trace {
  read(): { dropped: number; records: Array<{ event: string }> };
  stop(): ReturnType<Trace["read"]>;
}

describe("opt-in editor IME trace", () => {
  it("observes native input and transactions without changing the document or recording text", async () => {
    const runtime = await CoreRuntime.open(new MemoryPersistencePort());
    const root = document.createElement("div");
    document.body.append(root);
    const { editor, adapter } = runtime.editorForTesting("window-1", root);
    const host = window as unknown as { memokaImeTrace: Trace };
    try {
      editor.commands.setContent("<p>private-note-text</p>");
      editor.view.focus();
      const before = editor.state;
      window.eval(source);
      const input = new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "非公開の日本語",
        isComposing: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(input);
      await Promise.resolve();
      expect(input.defaultPrevented).toBe(false);
      expect(editor.state).toBe(before);
      editor.view.dispatch(editor.state.tr.insertText("confidential"));
      const result = host.memokaImeTrace.read();
      expect(result.records.map(({ event }) => event)).toContain("transaction");
      expect(result.records.map(({ event }) => event)).toContain(
        "beforeinput:after",
      );
      const serialized = JSON.stringify(result);
      for (const sensitive of [
        "private-note-text",
        "非公開の日本語",
        "confidential",
        runtime.noteDocument.noteId,
      ]) {
        expect(serialized).not.toContain(sensitive);
      }
      host.memokaImeTrace.stop();
      editor.view.dom.dispatchEvent(input);
      editor.view.dispatch(editor.state.tr.insertText("after-stop"));
      await Promise.resolve();
      expect(host.memokaImeTrace.read()).toEqual(result);
    } finally {
      host.memokaImeTrace?.stop();
      adapter.destroy();
      runtime.destroy();
      root.remove();
    }
  });

  it("caps records and safely replaces an earlier trace", async () => {
    const root = document.createElement("div");
    root.className = "memoka-editor";
    document.body.append(root);
    const host = window as unknown as { memokaImeTrace: Trace };
    try {
      window.eval(source);
      const previous = host.memokaImeTrace;
      window.eval(source);
      const previousResult = previous.read();
      for (let index = 0; index < 450; index++) {
        root.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: "secret" }),
        );
      }
      await Promise.resolve();
      const result = host.memokaImeTrace.stop();
      expect(result.records).toHaveLength(800);
      expect(result.dropped).toBeGreaterThan(0);
      expect(previous.read()).toEqual(previousResult);
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      host.memokaImeTrace?.stop();
      root.remove();
    }
  });
});
