import { describe, expect, it } from "vitest";
import {
  createNoteDocument,
  replaceNoteSectionTree,
  type NoteBlock,
} from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  createSectionMarkdownBackup,
  renderSectionMarkdown,
  restoreSectionMarkdownBackup,
  SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION,
} from "../app/src/core/section-markdown-backup";
import {
  sectionSnapshot,
  validateSectionTree,
  type SectionSnapshot,
} from "../app/src/core/section-model";

function deterministicIds() {
  let counter = 0;
  return () => {
    const seed = counter++;
    return createUuidV7(1_797_100_000_000 + seed, (bytes) => {
      bytes.fill((seed * 67) & 0xff);
      return bytes;
    });
  };
}

function blockJson(block: NoteBlock): unknown {
  const note = createNoteDocument(createUuidV7(), [block]);
  const body = sectionSnapshot(note.rootSection).body[0];
  note.doc.destroy();
  return body;
}

describe("Memoka Section Markdown backup", () => {
  it("escapes literal highlight delimiters in Section titles", () => {
    expect(renderSectionMarkdown("Literal ==title==", [])).toBe(
      "# Literal \\=\\=title\\=\\=\n\n",
    );
  });

  it("round-trips Section files, properties, structured bodies and links deterministically", () => {
    const ids = deterministicIds();
    const noteId = ids();
    const childId = ids();
    const grandchildId = ids();
    const attachmentId = ids();
    const rootParagraphId = ids();
    const formattedParagraphId = ids();
    const childParagraphId = ids();
    const imageBlockId = ids();
    const codeBlockId = ids();
    const blockquoteId = ids();
    const quoteParagraphId = ids();
    const horizontalRuleId = ids();
    const snapshot: SectionSnapshot = {
      sectionId: noteId,
      title: "Backup Root",
      emoji: "📦",
      tags: ["backup"],
      body: [
        blockJson({
          type: "paragraph",
          blockId: rootParagraphId,
          content: [
            { type: "text", text: "root body links to " },
            {
              type: "internalSectionLink",
              text: "child",
              targetSectionId: childId,
            },
          ],
        }),
        {
          type: "paragraph",
          attrs: { blockId: formattedParagraphId },
          content: [
            {
              type: "text",
              marks: [
                { type: "bold" },
                { type: "italic" },
                { type: "strike" },
                { type: "code" },
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                    class: null,
                  },
                },
                { type: "highlight" },
              ],
              text: "formatted",
            },
          ],
        },
        blockJson({
          type: "image",
          blockId: imageBlockId,
          attachmentId,
          altText: "diagram",
        }),
        blockJson({
          type: "blockquote",
          blockId: blockquoteId,
          alertType: "tip",
          alertTitle: "Backup tip",
          alertFold: "expanded",
          children: [
            {
              type: "paragraph",
              blockId: quoteParagraphId,
              content: [{ type: "text", text: "quoted backup" }],
            },
          ],
        }),
        blockJson({
          type: "horizontalRule",
          blockId: horizontalRuleId,
        }),
      ],
      children: [
        {
          sectionId: childId,
          title: "Child",
          tags: ["nested"],
          body: [
            blockJson({
              type: "paragraph",
              blockId: childParagraphId,
              content: [{ type: "text", text: "child-only body" }],
            }),
          ],
          children: [
            {
              sectionId: grandchildId,
              title: "Grandchild",
              tags: [],
              body: [
                blockJson({
                  type: "codeBlock",
                  blockId: codeBlockId,
                  language: "typescript",
                  text: "const section = true;",
                }),
              ],
              children: [],
            },
          ],
        },
      ],
    };
    const note = createNoteDocument(noteId, [], "");
    replaceNoteSectionTree(note, snapshot, "2026-08-12T00:00:00.000Z");

    const first = createSectionMarkdownBackup(note);
    const second = createSectionMarkdownBackup(note);
    expect(second).toEqual(first);
    const manifest = JSON.parse(first.manifest) as {
      schemaVersion: number;
      noteId: string;
      rootSectionId: string;
      sections: Array<{
        sectionId: string;
        parentSectionId: string | null;
        order: number;
        file: string;
      }>;
    };
    expect(manifest).toMatchObject({
      schemaVersion: SECTION_MARKDOWN_BACKUP_SCHEMA_VERSION,
      noteId,
      rootSectionId: noteId,
    });
    expect(manifest.sections).toMatchObject([
      { sectionId: noteId, parentSectionId: null, order: 0 },
      { sectionId: childId, parentSectionId: noteId, order: 0 },
      { sectionId: grandchildId, parentSectionId: childId, order: 0 },
    ]);
    const rootFile = first.files[`sections/${noteId}.md`];
    const childFile = first.files[`sections/${childId}.md`];
    expect(rootFile).toContain("# Backup Root");
    expect(rootFile).toContain(`[[${childId}|child]]`);
    expect(rootFile).toContain(
      "==[**_~~`formatted`~~_**](https://example.com)==",
    );
    expect(rootFile).toContain("> [!TIP]+ Backup tip\n> quoted backup");
    expect(rootFile).toContain("\n---\n");
    expect(rootFile).not.toContain("child-only body");
    expect(childFile).toContain("child-only body");
    expect(childFile).not.toContain("const section = true;");

    const restored = restoreSectionMarkdownBackup(first, {
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(sectionSnapshot(restored.rootSection)).toEqual(
      sectionSnapshot(note.rootSection),
    );
    expect(validateSectionTree(restored.rootSection, noteId)).toEqual({
      sectionCount: 3,
      maximumDepth: 2,
    });
    note.doc.destroy();
    restored.doc.destroy();
  });

  it("rejects incomplete file sets and a Markdown mirror changed outside Memoka", () => {
    const ids = deterministicIds();
    const note = createNoteDocument(ids(), [], "Root");
    const backup = createSectionMarkdownBackup(note);
    expect(() =>
      restoreSectionMarkdownBackup({
        ...backup,
        files: { ...backup.files, "sections/unexpected.md": "unexpected" },
      }),
    ).toThrow("files do not match");

    const file = Object.keys(backup.files)[0]!;
    expect(() =>
      restoreSectionMarkdownBackup({
        manifest: backup.manifest,
        files: {
          ...backup.files,
          [file]: `${backup.files[file]}externally edited\n`,
        },
      }),
    ).toThrow("Markdown mirror does not match");
    note.doc.destroy();
  });
});
