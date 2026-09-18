import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createNoteDocument } from "../app/src/core/documents";
import { MARKDOWN_ALERT_TYPE_CATALOG } from "../app/src/core/markdown-alert";
import { alertIconMask } from "../app/src/editor/alert-icons";
import { productEditorExtensions } from "../app/src/editor/extensions";

describe("Alert icons", () => {
  it("provides a distinct SVG mask for every preset and shares aliases", () => {
    const masks = new Set<string>();
    for (const entry of MARKDOWN_ALERT_TYPE_CATALOG) {
      const mask = alertIconMask(entry.id);
      masks.add(mask);
      const svg = decodeURIComponent(
        mask.slice('url("data:image/svg+xml,'.length, -2),
      );
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(parsed.querySelector("parsererror")).toBeNull();
      expect(parsed.documentElement.namespaceURI).toBe(
        "http://www.w3.org/2000/svg",
      );
      expect(parsed.documentElement.getAttribute("viewBox")).toBe("0 0 24 24");
      for (const alias of entry.aliases.filter((value) =>
        /^[a-z]/u.test(value),
      )) {
        expect(alertIconMask(alias)).toBe(mask);
      }
    }
    expect(masks.size).toBe(MARKDOWN_ALERT_TYPE_CATALOG.length);
    expect(alertIconMask("release-status")).toBe(alertIconMask("note"));
  });

  it("updates the icon with the Alert type without adding editable content", () => {
    const note = createNoteDocument("01900000-0000-7000-8000-000000000001");
    const editor = new Editor({
      extensions: productEditorExtensions(note, { directBodyOnly: true }),
    });
    try {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "blockquote",
            attrs: { alertType: "note", alertTitle: "Custom title" },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Body" }] },
            ],
          },
        ],
      });
      const block = () => editor.view.dom.querySelector("blockquote")!;
      expect(block().style.getPropertyValue("--memoka-alert-icon")).toBe(
        alertIconMask("note"),
      );
      editor.commands.setTextSelection(2);
      editor.commands.updateAttributes("blockquote", { alertType: "warning" });
      expect(block().style.getPropertyValue("--memoka-alert-icon")).toBe(
        alertIconMask("warning"),
      );
      expect(block().getAttribute("data-memoka-alert-label")).toBe(
        "Custom title",
      );
      expect(block().textContent).toBe("Body");
      expect(block().querySelector("svg")).toBeNull();
      expect(JSON.stringify(editor.getJSON())).not.toContain("data:image");
      const html = editor.getHTML();
      editor.commands.setContent(html);
      expect(block().style.getPropertyValue("--memoka-alert-icon")).toBe(
        alertIconMask("warning"),
      );
      expect(block().textContent).toBe("Body");
      editor.commands.setTextSelection(2);
      editor.commands.updateAttributes("blockquote", { alertType: null });
      expect(block().hasAttribute("data-memoka-alert-type")).toBe(false);
      expect(block().style.getPropertyValue("--memoka-alert-icon")).toBe("");
    } finally {
      editor.destroy();
      note.doc.destroy();
    }
  });
});
