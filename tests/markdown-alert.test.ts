import { describe, expect, it } from "vitest";
import {
  filterMarkdownAlertTypeCatalog,
  markdownAlertLabel,
  markdownAlertMarker,
  parseMarkdownAlertMarker,
} from "../app/src/core/markdown-alert";

describe("Markdown alert syntax", () => {
  it("normalizes GitHub alerts and preserves Obsidian titles and fold markers", () => {
    expect(parseMarkdownAlertMarker("[!NOTE]")).toEqual({
      type: "note",
      title: null,
      fold: null,
    });
    expect(parseMarkdownAlertMarker("[!FAQ]-  Custom   answer ")).toEqual({
      type: "faq",
      title: "Custom answer",
      fold: "collapsed",
    });
    expect(parseMarkdownAlertMarker("[!release-status]+ Ready")).toEqual({
      type: "release-status",
      title: "Ready",
      fold: "expanded",
    });
  });

  it("serializes GitHub names canonically and accepts Obsidian custom types", () => {
    expect(markdownAlertMarker({ alertType: "warning" })).toBe("[!WARNING]");
    expect(
      markdownAlertMarker({
        alertType: "faq",
        alertTitle: "Answer",
        alertFold: "collapsed",
      }),
    ).toBe("[!faq]- Answer");
    expect(markdownAlertLabel({ alertType: "tldr" })).toBe("TL;DR");
    expect(markdownAlertLabel({ alertType: "release-status" })).toBe(
      "Release Status",
    );
  });

  it("rejects malformed or unsafe alert type names", () => {
    expect(parseMarkdownAlertMarker("[!]")).toBeNull();
    expect(parseMarkdownAlertMarker("[!note type]")).toBeNull();
    expect(parseMarkdownAlertMarker("prefix [!NOTE]")).toBeNull();
    expect(markdownAlertMarker({ alertType: 'note" onclick="bad' })).toBeNull();
  });

  it("offers canonical creation presets with Japanese and alias AND search", () => {
    expect(filterMarkdownAlertTypeCatalog("")).toHaveLength(15);
    expect(filterMarkdownAlertTypeCatalog("注意 warning")).toMatchObject([
      { id: "warning" },
    ]);
    expect(filterMarkdownAlertTypeCatalog("ＴＬＤＲ 要約")).toMatchObject([
      { id: "abstract" },
    ]);
  });
});
