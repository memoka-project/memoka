import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { productEditorExtensions } from "../app/src/editor/extensions";
import {
  parseMarkdownNote,
  parseMarkdownPaste,
} from "../app/src/editor/markdown-paste";
import {
  MARKDOWN_CLIPBOARD_MIME,
  readMarkdownClipboard,
} from "../app/src/vim/clipboard";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

function withEditor(run: (editor: Editor) => void): void {
  const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
  const editor = new Editor({ extensions: productEditorExtensions(note) });
  try {
    run(editor);
  } finally {
    editor.destroy();
    note.doc.destroy();
  }
}

function clipboardData(
  formats: Record<string, string>,
): Pick<DataTransfer, "getData" | "types"> {
  return {
    types: Object.keys(formats),
    getData: (type: string) => formats[type] ?? "",
  };
}

describe("Memoka explicit Markdown paste parser", () => {
  it("imports a representative Markdown document as one complete Section tree", () => {
    withEditor((editor) => {
      const noteId = "01900000-0000-7000-8000-000000000001";
      const markdown = readFileSync(
        resolve(process.cwd(), "tests/fixtures/markdown-import.md"),
        "utf8",
      );
      const parsed = parseMarkdownNote(markdown, editor.schema, noteId);

      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({
        title: "Markdown Import Fixture",
        sectionCount: 5,
        sourceBlockCount: 0,
      });
      expect(parsed?.root.firstChild?.attrs.sectionId).toBe(noteId);

      const titles: string[] = [];
      const sectionIds: string[] = [];
      const nodeNames = new Set<string>();
      const markNames = new Set<string>();
      const linkHrefs = new Set<string>();
      const codeLanguages = new Set<string>();
      parsed?.root.descendants((node) => {
        nodeNames.add(node.type.name);
        if (node.type.name === "codeBlock") {
          codeLanguages.add(String(node.attrs.language));
        }
        for (const mark of node.marks) {
          markNames.add(mark.type.name);
          if (mark.type.name === "link") {
            linkHrefs.add(String(mark.attrs.href));
          }
        }
        if (node.type.name === "sectionHeader") {
          titles.push(node.textContent);
          sectionIds.push(String(node.attrs.sectionId));
        }
      });
      expect(titles).toEqual([
        "Markdown Import Fixture",
        "Overview",
        "Nested",
        "Structured blocks",
        "Final",
      ]);
      expect(new Set(sectionIds).size).toBe(sectionIds.length);
      expect(sectionIds.every((id) => UUID_V7.test(id))).toBe(true);
      expect([...nodeNames]).toEqual(
        expect.arrayContaining([
          "bulletList",
          "orderedList",
          "codeBlock",
          "table",
          "blockquote",
          "horizontalRule",
        ]),
      );
      expect([...markNames]).toEqual(
        expect.arrayContaining(["bold", "italic", "strike", "code", "link"]),
      );
      expect([...codeLanguages]).toEqual(
        expect.arrayContaining(["text", "toml"]),
      );
      expect([...linkHrefs]).toEqual(
        expect.arrayContaining(["https://example.com/docs"]),
      );
      expect(parsed?.root.textContent).toContain("Nested section body");
    });
  });

  it("maps heading depth and preserves all supported inline marks in Section bodies", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownNote(
        [
          "# **Imported** note",
          "",
          "Root **bold**.",
          "",
          "## Child",
          "",
          "_italic_ ~~strike~~ `code` [link](https://example.com)",
          "",
          "### Grandchild",
          "",
          "deep body",
        ].join("\n"),
        editor.schema,
        "01900000-0000-7000-8000-000000000001",
      );

      expect(parsed?.title).toBe("Imported note");
      expect(withoutBodyChunks(parsed?.root.toJSON())).toMatchObject({
        type: "section",
        content: [
          {
            type: "sectionHeader",
            content: [{ type: "text", text: "Imported note" }],
          },
          {
            type: "sectionBody",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Root " },
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
            content: [
              {
                type: "section",
                content: [
                  { type: "sectionHeader" },
                  {
                    type: "sectionBody",
                    content: [
                      {
                        type: "paragraph",
                        content: [
                          {
                            type: "text",
                            marks: [{ type: "italic" }],
                            text: "italic",
                          },
                          { type: "text", text: " " },
                          {
                            type: "text",
                            marks: [{ type: "strike" }],
                            text: "strike",
                          },
                          { type: "text", text: " " },
                          {
                            type: "text",
                            marks: [{ type: "code" }],
                            text: "code",
                          },
                          { type: "text", text: " " },
                          {
                            type: "text",
                            marks: [
                              {
                                type: "link",
                                attrs: { href: "https://example.com" },
                              },
                            ],
                            text: "link",
                          },
                        ],
                      },
                    ],
                  },
                  {
                    type: "sectionChildren",
                    content: [{ type: "section" }],
                  },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  it("keeps later H1 headings in the same NoteDoc as Root child Sections", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownNote(
        "# First\n\nroot body\n\n# Second\n\nsecond body\n\n## Nested\n\nnested body",
        editor.schema,
        "01900000-0000-7000-8000-000000000001",
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.title).toBe("First");
      expect(parsed?.sectionCount).toBe(3);
      const root = parsed?.root;
      expect(root?.child(1).textContent).toBe("root body");
      const rootChildren = root?.child(2);
      expect(rootChildren?.childCount).toBe(1);
      const second = rootChildren?.firstChild;
      expect(second?.firstChild?.textContent).toBe("Second");
      expect(second?.child(1).textContent).toBe("second body");
      expect(second?.child(2).childCount).toBe(1);
      expect(second?.child(2).firstChild?.firstChild?.textContent).toBe(
        "Nested",
      );
      expect(second?.child(2).firstChild?.child(1).textContent).toBe(
        "nested body",
      );
      expect(
        parseMarkdownNote(
          "Setext title\n============",
          editor.schema,
          "01900000-0000-7000-8000-000000000001",
        ),
      ).toBeNull();
    });
  });

  it("maps supported Markdown to structured blocks with fresh identities", () => {
    withEditor((editor) => {
      const markdown = [
        "# Heading",
        "",
        "Paragraph with `code` and [site](https://example.com).",
        "",
        "- parent",
        "  - child",
        "",
        "3. ordered",
        "   - mixed child",
        "4. next",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "![diagram](attachment:sha256-example)",
      ].join("\n");
      const parsed = parseMarkdownPaste(markdown, editor.schema);

      expect(parsed).not.toBeNull();
      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "paragraph",
          content: [{ type: "text", text: "# Heading" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Paragraph with " },
            {
              type: "text",
              marks: [{ type: "code" }],
              text: "code",
            },
            { type: "text", text: " and " },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com" },
                },
              ],
              text: "site",
            },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "parent" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "ordered" }],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "mixed child" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "next" }],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const value = 1;" }],
        },
        {
          type: "image",
          attrs: {
            src: "attachment:sha256-example",
            attachmentId: "sha256-example",
            alt: "diagram",
          },
        },
      ]);

      const identities: unknown[] = [];
      parsed?.slice.content.forEach((node) => {
        node.descendants((child) => {
          if (child.isBlock && child.type.name !== "doc") {
            identities.push(child.attrs.blockId);
            if (child.type.name === "heading") {
              identities.push(child.attrs.headingId);
            }
          }
        });
        if (node.isBlock) {
          identities.push(node.attrs.blockId);
          if (node.type.name === "heading") {
            identities.push(node.attrs.headingId);
          }
        }
      });
      expect(identities.length).toBeGreaterThan(5);
      expect(identities.every((value) => UUID_V7.test(String(value)))).toBe(
        true,
      );
    });
  });

  it("round-trips a narrowed image width from the portable Markdown form", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        '<img src="attachment:sha256-example" alt="diagram &amp; notes" width="45%">',
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.firstChild?.toJSON()).toMatchObject({
        type: "image",
        attrs: {
          src: "attachment:sha256-example",
          attachmentId: "sha256-example",
          alt: "diagram & notes",
          width: 45,
        },
      });
      expect(
        parseMarkdownPaste(
          '<img src="javascript:alert(1)" alt="unsafe" width="45%">',
          editor.schema,
        )?.slice.content.firstChild?.type.name,
      ).toBe("sourceBlock");
    });
  });

  it("keeps unsupported or unsafe regions losslessly inside Source Blocks", () => {
    withEditor((editor) => {
      const markdown = [
        "# Supported",
        "",
        "[unsafe](javascript:alert)",
        "",
        "- [ ] unsupported task",
        "",
        "```ts",
        "const unfinished = true;",
      ].join("\n");
      const parsed = parseMarkdownPaste(markdown, editor.schema);
      const json = parsed?.slice.content.toJSON();

      expect(parsed?.sourceBlockCount).toBe(3);
      expect(json).toMatchObject([
        {
          type: "paragraph",
          content: [{ type: "text", text: "# Supported" }],
        },
        {
          type: "sourceBlock",
          content: [{ type: "text", text: "[unsafe](javascript:alert)" }],
        },
        {
          type: "sourceBlock",
          content: [{ type: "text", text: "- [ ] unsupported task" }],
        },
        {
          type: "sourceBlock",
          content: [
            {
              type: "text",
              text: "```ts\nconst unfinished = true;",
            },
          ],
        },
      ]);
    });
  });

  it("imports nested blockquotes and thematic breaks as native blocks", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        [
          "> **quoted** continuation",
          ">",
          "> - parent",
          ">   - child",
          ">",
          "> > nested quote",
          "",
          "---",
          "",
          "after",
        ].join("\n"),
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.nodeNames).toEqual(
        expect.arrayContaining([
          "blockquote",
          "bulletList",
          "listItem",
          "horizontalRule",
        ]),
      );
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  marks: [{ type: "bold" }],
                  text: "quoted",
                },
                { type: "text", text: " continuation" },
              ],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "parent" }],
                    },
                    { type: "bulletList" },
                  ],
                },
              ],
            },
            {
              type: "blockquote",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "nested quote" }],
                },
              ],
            },
          ],
        },
        { type: "horizontalRule" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ]);

      const identities: unknown[] = [];
      parsed?.slice.content.forEach((node) => {
        identities.push(node.attrs.blockId);
        node.descendants((child) => {
          if (!child.isText && child.type.name !== "hardBreak") {
            identities.push(child.attrs.blockId);
          }
        });
      });
      expect(identities.length).toBeGreaterThan(8);
      expect(identities.every((value) => UUID_V7.test(String(value)))).toBe(
        true,
      );
    });
  });

  it("keeps closed YAML frontmatter as a Source Block instead of a rule", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        "---\ntitle: Imported\n---\n\nbody",
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(1);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "sourceBlock",
          content: [{ type: "text", text: "---\ntitle: Imported\n---" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "body" }],
        },
      ]);
    });
  });

  it("parses composable GFM marks and normalizes safe external links", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        "**_~~`code`~~_** [relative](/guide) [bare](example.com/docs)",
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [
                { type: "bold" },
                { type: "italic" },
                { type: "strike" },
                { type: "code" },
              ],
              text: "code",
            },
            { type: "text", text: " " },
            {
              type: "text",
              marks: [{ type: "link", attrs: { href: "/guide" } }],
              text: "relative",
            },
            { type: "text", text: " " },
            {
              type: "text",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com/docs" },
                },
              ],
              text: "bare",
            },
          ],
        },
      ]);
    });
  });

  it("imports Obsidian highlights without treating code or escaped delimiters as marks", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        [
          "==plain== **==bold==** ==[linked](https://example.com)== ==`code`==",
          "",
          "`==literal code==` \\=\\=literal\\=\\=",
          "",
          "[[01900000-0000-7000-8000-0000000000aa|literal == link]]",
        ].join("\n"),
        editor.schema,
      );
      const textMarks = new Map<string, string[]>();
      parsed?.slice.content.forEach((node) => {
        node.descendants((child) => {
          if (child.isText) {
            textMarks.set(
              child.text ?? "",
              child.marks.map(({ type }) => type.name).sort(),
            );
          }
        });
      });

      expect(textMarks.get("plain")).toEqual(["highlight"]);
      expect(textMarks.get("bold")).toEqual(["bold", "highlight"]);
      expect(textMarks.get("linked")).toEqual(["highlight", "link"]);
      expect(textMarks.get("code")).toEqual(["code", "highlight"]);
      expect(textMarks.get("==literal code==")).toEqual(["code"]);
      expect(
        [...textMarks].find(([text]) => text.includes("==literal=="))?.[1],
      ).toEqual([]);
      const internalLink = parsed?.slice.content.lastChild?.firstChild;
      expect(internalLink?.type.name).toBe("internalSectionLink");
      expect(internalLink?.textContent).toBe("literal == link");
    });
  });

  it("removes highlight delimiters from an imported Note title", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownNote(
        "# ==Highlighted title==\n\nBody with ==highlight==.",
        editor.schema,
        "01900000-0000-7000-8000-000000000001",
      );

      expect(parsed?.title).toBe("Highlighted title");
      const bodyMarks: string[] = [];
      parsed?.root.child(1).descendants((node) => {
        if (node.isText)
          bodyMarks.push(...node.marks.map(({ type }) => type.name));
      });
      expect(bodyMarks).toContain("highlight");

      const literal = parseMarkdownNote(
        "# `==literal title==`\n\nbody",
        editor.schema,
        "01900000-0000-7000-8000-000000000001",
      );
      expect(literal?.title).toBe("==literal title==");

      const escaped = parseMarkdownNote(
        "# Literal \\=\\=title\\=\\=\n\nbody",
        editor.schema,
        "01900000-0000-7000-8000-000000000001",
      );
      expect(escaped?.title).toBe("Literal ==title==");
    });
  });

  it("imports GitHub and Obsidian alert markers as typed blockquotes", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        [
          "> [!NOTE]",
          "> GitHub note",
          "",
          "> [!warning] Custom warning",
          "> **Watch this.**",
          "",
          "> [!faq]- Folded answer",
          "> - first",
          "> - second",
          "",
          "> [!release-status]+ Custom type",
          "> nested body",
          "",
          "> [!tip] Title only",
        ].join("\n"),
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "blockquote",
          attrs: {
            alertType: "note",
            alertTitle: null,
            alertFold: null,
          },
          content: [{ type: "paragraph", content: [{ text: "GitHub note" }] }],
        },
        {
          type: "blockquote",
          attrs: {
            alertType: "warning",
            alertTitle: "Custom warning",
            alertFold: null,
          },
          content: [{ type: "paragraph" }],
        },
        {
          type: "blockquote",
          attrs: {
            alertType: "faq",
            alertTitle: "Folded answer",
            alertFold: "collapsed",
          },
          content: [{ type: "bulletList" }],
        },
        {
          type: "blockquote",
          attrs: {
            alertType: "release-status",
            alertTitle: "Custom type",
            alertFold: "expanded",
          },
          content: [{ type: "paragraph", content: [{ text: "nested body" }] }],
        },
        {
          type: "blockquote",
          attrs: {
            alertType: "tip",
            alertTitle: "Title only",
            alertFold: null,
          },
          content: [{ type: "paragraph" }],
        },
      ]);
    });
  });

  it("does not silently merge list kinds at the same indentation", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        "1. ordered\n- separate bullet without a blank",
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(1);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "sourceBlock",
          attrs: { sourceFormat: "markdown" },
          content: [
            {
              type: "text",
              text: "1. ordered\n- separate bullet without a blank",
            },
          ],
        },
      ]);
    });
  });

  it("keeps indented Markdown continuation lines in the current list item", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        [
          "1. NOTESから長いノートを開き、Sectionと直接本文を確認する。",
          "   Section Headerと本文の組として表示される。",
          "   Focus対象のSubtreeだけが編集画面にあることも確認する。",
          "2. Section Header上でEnterを押す。",
          "   `Enter`ではtitle後半を先頭Paragraphへ移動する。",
          "10. 長いSectionの末尾へ移動する。",
          "    続けて子SectionへFocusできる。",
          "",
          "- tauri:e2eを実行する。",
          "  driverUrlを指定して再実行する。",
          "- 結果を記録する。",
        ].join("\n"),
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "NOTESから長いノートを開き、Sectionと直接本文を確認する。 Section Headerと本文の組として表示される。 Focus対象のSubtreeだけが編集画面にあることも確認する。",
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Section Header上でEnterを押す。 ",
                    },
                    {
                      type: "text",
                      marks: [{ type: "code" }],
                      text: "Enter",
                    },
                    {
                      type: "text",
                      text: "ではtitle後半を先頭Paragraphへ移動する。",
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "長いSectionの末尾へ移動する。 続けて子SectionへFocusできる。",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "tauri:e2eを実行する。 driverUrlを指定して再実行する。",
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "結果を記録する。" }],
                },
              ],
            },
          ],
        },
      ]);
    });
  });

  it("ends a list before an unindented paragraph without a blank line", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        "- list item\n  continued text\nparagraph after list",
        editor.schema,
      );

      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "list item continued text" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "paragraph after list" }],
        },
      ]);
    });
  });

  it("only consumes an explicit Markdown MIME without competing HTML", () => {
    withEditor((editor) => {
      expect(
        readMarkdownClipboard(
          clipboardData({ "text/plain": "# literal" }),
          editor.schema,
        ),
      ).toBeNull();
      expect(
        readMarkdownClipboard(
          clipboardData({
            [MARKDOWN_CLIPBOARD_MIME]: "# Markdown",
            "text/html": "<h1>HTML wins</h1>",
          }),
          editor.schema,
        ),
      ).toBeNull();
      expect(
        readMarkdownClipboard(
          clipboardData({
            [MARKDOWN_CLIPBOARD_MIME]: "# Markdown",
            "text/plain": "# Markdown",
          }),
          editor.schema,
        ),
      ).toMatchObject({
        kind: "structure",
        structureKind: "block",
        nodeNames: ["paragraph"],
      });
    });
  });

  it("parses a GFM table with alignment, escaped pipes and hard breaks", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        [
          "| left | code | note |",
          "| :--- | ---: | :---: |",
          "| a\\|b | `x|y` | first<br>second |",
          "",
        ].join("\r\n"),
        editor.schema,
      );
      expect(parsed?.sourceBlockCount).toBe(0);
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { align: "left" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "left" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  attrs: { align: "right" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "code" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  attrs: { align: "center" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "note" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "a|b" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          marks: [{ type: "code" }],
                          text: "x|y",
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        { type: "text", text: "first" },
                        { type: "hardBreak" },
                        { type: "text", text: "second" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
      expect(parsed?.text).toBe(
        "| left | code | note |\n| :--- | ---: | :---: |\n| a\\|b | `x|y` | first<br>second |\n",
      );
      const table = parsed?.slice.content.firstChild;
      const identities: unknown[] = [];
      table?.descendants((node) => {
        if (!node.isText && node.type.name !== "hardBreak") {
          identities.push(node.attrs.blockId);
        }
      });
      if (table) identities.push(table.attrs.blockId);
      expect(identities.length).toBeGreaterThan(8);
      expect(identities.every((value) => UUID_V7.test(String(value)))).toBe(
        true,
      );
    });
  });

  it("keeps escaped block markers and inline punctuation as paragraph text", () => {
    withEditor((editor) => {
      const parsed = parseMarkdownPaste(
        "\\# literal \\*stars\\*\n\n\\- item-shaped",
        editor.schema,
      );
      expect(parsed?.slice.content.toJSON()).toMatchObject([
        {
          type: "paragraph",
          content: [{ type: "text", text: "# literal *stars*" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "- item-shaped" }],
        },
      ]);
    });
  });
});
