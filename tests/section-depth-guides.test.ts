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

    expect(getComputedStyle(rootBody).borderLeftStyle).toBe("");
    expect(getComputedStyle(body).borderLeftStyle).toBe("solid");
    expect(getComputedStyle(children).borderLeftStyle).toBe("solid");

    style.remove();
  });
});
