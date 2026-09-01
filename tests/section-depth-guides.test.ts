import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Section depth guides", () => {
  it("continues a non-Root Section guide through its body and child Sections", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );
    document.head.append(style);

    const rootBody = document.createElement("div");
    rootBody.className = "memoka-section-body";
    const section = document.createElement("section");
    section.className = "memoka-section";
    const body = document.createElement("div");
    body.className = "memoka-section-body";
    const children = document.createElement("div");
    children.className = "memoka-section-children";
    section.append(body, children);
    document.body.append(rootBody, section);

    const guidedSelector =
      ".memoka-section > .memoka-section-body, .memoka-section > .memoka-section-children";
    expect(rootBody.matches(guidedSelector)).toBe(false);
    expect(body.matches(guidedSelector)).toBe(true);
    expect(children.matches(guidedSelector)).toBe(true);
    expect(style.textContent).toContain(
      "border-left: 1px solid var(--memoka-color-border-subtle)",
    );

    style.remove();
  });
});
