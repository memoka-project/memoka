import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { productEditorExtensions } from "../app/src/editor/extensions";
import { runMarkdownNoteImport } from "../app/src/vim/markdown-note-import";

function withoutBodyChunks(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as { type?: unknown; content?: unknown };
  const content = Array.isArray(record.content)
    ? record.content.flatMap((child) => {
        const normalized = withoutBodyChunks(child) as {
          type?: unknown;
          content?: unknown;
        };
        return normalized?.type === "bodyChunk" &&
          Array.isArray(normalized.content)
          ? normalized.content
          : [normalized];
      })
    : record.content;
  return { ...record, ...(content === undefined ? {} : { content }) };
}

const NOTE_ID = "01900000-0000-7000-8000-000000000001";

function withNoteEditor(title: string, run: (editor: Editor) => void): void {
  const note = createNoteDocument(NOTE_ID, undefined, title);
  const editor = new Editor({ extensions: productEditorExtensions(note) });
  try {
    editor.commands.setTextSelection(1);
    run(editor);
  } finally {
    editor.destroy();
    note.doc.destroy();
  }
}

describe("Memoka whole-note Markdown import command", () => {
  it("replaces an empty Root title and body in one editor transaction", () => {
    withNoteEditor("", (editor) => {
      let transactionCount = 0;
      editor.on("transaction", () => {
        transactionCount += 1;
      });

      const result = runMarkdownNoteImport(
        editor.view,
        "# Imported\n\nRoot body with **bold**.\n\n## Child\n\nChild body.",
        NOTE_ID,
      );

      expect(result).toMatchObject({
        changed: true,
        title: "Imported",
        sectionCount: 2,
        sourceBlockCount: 0,
      });
      expect(transactionCount).toBe(1);
      expect(editor.state.selection.from).toBe("Imported".length + 1);
      expect(withoutBodyChunks(editor.state.doc.toJSON())).toMatchObject({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            attrs: { sectionId: NOTE_ID },
            content: [{ type: "text", text: "Imported" }],
          },
          {
            type: "sectionBody",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Root body with " },
                  {
                    type: "text",
                    marks: [{ type: "bold" }],
                    text: "bold",
                  },
                  { type: "text", text: "." },
                ],
              },
            ],
          },
          {
            type: "sectionChildren",
            content: [{ type: "section" }],
          },
        ],
      });
    });
  });

  it("refuses destructive or ambiguous targets", () => {
    withNoteEditor("Existing", (editor) => {
      expect(
        runMarkdownNoteImport(editor.view, "# Replacement", NOTE_ID),
      ).toEqual({ changed: false, reason: "note-not-empty" });
      expect(editor.state.doc.firstChild?.textContent).toBe("Existing");
    });

    withNoteEditor("", (editor) => {
      expect(
        runMarkdownNoteImport(editor.view, "not an ATX H1 note", NOTE_ID),
      ).toEqual({ changed: false, reason: "invalid-markdown-note" });
      expect(editor.state.doc.firstChild?.textContent).toBe("");

      expect(
        runMarkdownNoteImport(
          editor.view,
          "# Wrong focused Section",
          "01900000-0000-7000-8000-000000000002",
        ),
      ).toEqual({ changed: false, reason: "not-root-section" });

      let paragraphPosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (paragraphPosition < 0 && node.type.name === "paragraph") {
          paragraphPosition = position + 1;
        }
      });
      expect(paragraphPosition).toBeGreaterThan(0);
      editor.commands.setTextSelection(paragraphPosition);
      expect(
        runMarkdownNoteImport(editor.view, "# Wrong target", NOTE_ID),
      ).toEqual({ changed: false, reason: "not-root-title" });

      editor.commands.insertContent("existing body");
      editor.commands.setTextSelection(1);
      expect(
        runMarkdownNoteImport(editor.view, "# Replacement", NOTE_ID),
      ).toEqual({ changed: false, reason: "note-not-empty" });
    });
  });
});
