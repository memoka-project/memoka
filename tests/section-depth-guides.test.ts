import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNoteDocument, type NoteBlock } from "../app/src/core/documents";
import { createUuidV7 } from "../app/src/core/ids";
import {
  createSectionXml,
  insertChildSection,
} from "../app/src/core/section-model";
import {
  bulletMarkerStyleForDepth,
  productEditorExtensions,
} from "../app/src/editor/extensions";

describe("Section depth guides", () => {
  it("cycles the six Bullet List marker shapes by nesting depth", () => {
    expect(
      Array.from({ length: 13 }, (_, index) =>
        bulletMarkerStyleForDepth(index + 1),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1]);
  });

  it("annotates nested Bullet List DOM without persisting presentation depth", async () => {
    const nestedBulletList = (depth: number): NoteBlock => ({
      type: "bulletList",
      blockId: createUuidV7(),
      children: [
        {
          type: "listItem",
          blockId: createUuidV7(),
          children: [
            {
              type: "paragraph",
              blockId: createUuidV7(),
              content: [{ type: "text", text: `Depth ${depth}` }],
            },
            ...(depth < 7 ? [nestedBulletList(depth + 1)] : []),
          ],
        },
      ],
    });
    const note = createNoteDocument(createUuidV7(), [nestedBulletList(1)]);
    const editor = new Editor({ extensions: productEditorExtensions(note) });

    try {
      await Promise.resolve();
      expect(
        [
          ...editor.view.dom.querySelectorAll<HTMLElement>(
            "ul[data-memoka-bullet-marker]",
          ),
        ].map((list) => list.dataset.memokaBulletMarker),
      ).toEqual(["1", "2", "3", "4", "5", "6", "1"]);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("continues a non-Root Section guide through its body and child Sections", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    document.head.append(style);

    const rootBody = document.createElement("div");
    rootBody.className = "memoka-section-body";
    const rootHeader = document.createElement("header");
    rootHeader.className = "memoka-section-header";
    const section = document.createElement("section");
    section.className = "memoka-section";
    const header = document.createElement("header");
    header.className = "memoka-section-header";
    const body = document.createElement("div");
    body.className = "memoka-section-body";
    const children = document.createElement("div");
    children.className = "memoka-section-children";
    section.append(header, body, children);
    document.body.append(rootHeader, rootBody, section);

    const guidedSelector =
      ".memoka-section > .memoka-section-body, .memoka-section > .memoka-section-children";
    expect(rootBody.matches(guidedSelector)).toBe(false);
    expect(body.matches(guidedSelector)).toBe(true);
    expect(children.matches(guidedSelector)).toBe(true);
    const indentedHeaderSelector = ".memoka-section > .memoka-section-header";
    expect(rootHeader.matches(indentedHeaderSelector)).toBe(false);
    expect(header.matches(indentedHeaderSelector)).toBe(true);
    expect(style.textContent).toContain(
      "border-left: 1px solid var(--memoka-color-border-subtle)",
    );
    expect(style.textContent).toContain(
      "margin-left: var(--memoka-indent-guide-offset)",
    );
    expect(style.textContent).toContain(
      "var(--memoka-indent-width) - var(--memoka-indent-guide-offset) - 1px",
    );
    expect(style.textContent).toMatch(
      /\.memoka-section\s*>\s*\.memoka-section-header\s*\{[^}]*margin-inline-start:\s*var\(--memoka-indent-width\)/su,
    );

    style.remove();
  });

  it("shows distinct subtle placeholders for empty Note and Section titles", async () => {
    const note = createNoteDocument(createUuidV7(), [], "");
    note.doc.transact(() => {
      insertChildSection(
        note.rootSection,
        createSectionXml(createUuidV7(), ""),
      );
    });
    const editor = new Editor({
      extensions: productEditorExtensions(note),
    });

    try {
      await Promise.resolve();
      expect(
        editor.view.dom.querySelector(
          '[data-note-title-placeholder="新しいノート"]',
        ),
      ).not.toBeNull();
      expect(
        editor.view.dom.querySelector(
          '[data-section-title-placeholder="無題のセクション"]',
        ),
      ).not.toBeNull();
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("shares all six cyclic heading colors with the Outline", () => {
    const css = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    for (let heading = 1; heading <= 6; heading += 1) {
      expect(css).toContain(`[data-memoka-markup-heading="${heading}"]`);
      expect(css).toContain(
        `--memoka-markup-heading-color: var(--memoka-color-markup-heading-${heading})`,
      );
    }
    expect(css).toContain(
      ".memoka-section[data-memoka-markup-heading] > .memoka-section-header",
    );
    expect(css).toContain(
      "color: var(--memoka-markup-heading-color, var(--memoka-color-text-muted))",
    );
    expect(css).toMatch(
      /\.memoka-section-header:is\([^}]*\)::before\s*\{[^}]*color:\s*var\(\s*--memoka-markup-heading-color,\s*var\(--memoka-color-text-subtle\)\s*\);[^}]*opacity:\s*0\.5;/su,
    );
  });

  it("annotates deep Editor Sections with repeating H1-H6 levels", async () => {
    const note = createNoteDocument(createUuidV7(), [], "Root");
    note.doc.transact(() => {
      let parent = note.rootSection;
      for (let depth = 1; depth <= 7; depth += 1) {
        const child = createSectionXml(createUuidV7(), `Depth ${depth}`);
        insertChildSection(parent, child);
        parent = child;
      }
    });
    const editor = new Editor({
      extensions: productEditorExtensions(note),
    });

    try {
      await Promise.resolve();
      const levels = [
        ...editor.view.dom.querySelectorAll<HTMLElement>(".memoka-section"),
      ].map((section) => section.dataset.memokaMarkupHeading);
      expect(editor.view.dom.dataset.memokaMarkupHeading).toBe("1");
      expect(levels).toEqual(["2", "3", "4", "5", "6", "1", "2"]);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });

  it("keeps absolute Note depth colors when a deep Section is focused", async () => {
    const note = createNoteDocument(createUuidV7(), [], "Root");
    const sectionIds: string[] = [];
    note.doc.transact(() => {
      let parent = note.rootSection;
      for (let depth = 1; depth <= 7; depth += 1) {
        const sectionId = createUuidV7();
        sectionIds.push(sectionId);
        const child = createSectionXml(sectionId, `Depth ${depth}`);
        insertChildSection(parent, child);
        parent = child;
      }
    });
    const editor = new Editor({
      extensions: productEditorExtensions(note, {
        focusedSectionId: sectionIds[2],
      }),
    });

    try {
      await Promise.resolve();
      expect(editor.view.dom.dataset.memokaMarkupHeading).toBe("4");
      const levels = [
        ...editor.view.dom.querySelectorAll<HTMLElement>(".memoka-section"),
      ].map((section) => section.dataset.memokaMarkupHeading);
      expect(levels).toEqual(["5", "6", "1", "2"]);
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });
});
