import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

const pagesRoot = resolve(process.cwd(), "docs");
const pageNames = ["index.html", "privacy.html", "terms.html"];
const markdownLinks: Record<string, string> = {
  "PRIVACY.md": "./privacy.html",
  "TERMS.md": "./terms.html",
  LICENSE: "https://github.com/memoka-project/memoka/blob/main/LICENSE",
  "THIRD_PARTY_NOTICES.md":
    "https://github.com/memoka-project/memoka/blob/main/THIRD_PARTY_NOTICES.md",
  "SECURITY.md":
    "https://github.com/memoka-project/memoka/blob/main/SECURITY.md",
};

function loadPage(name: string) {
  return new DOMParser().parseFromString(
    readFileSync(resolve(pagesRoot, name), "utf8"),
    "text/html",
  );
}

const normalized = (value: string) => value.replace(/\s+/gu, "");

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly ordered?: boolean | null;
  readonly url?: string;
  readonly children?: readonly MarkdownNode[];
}

interface SemanticElement {
  readonly tag: string;
  readonly text: string;
  readonly href?: string;
}

function nodeText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(nodeText).join("") ?? "";
}

function markdownElements(node: MarkdownNode): SemanticElement[] {
  const tags: Record<string, string> = {
    paragraph: "p",
    listItem: "li",
    inlineCode: "code",
    strong: "strong",
    emphasis: "em",
    link: "a",
  };
  const descendants = node.children?.flatMap(markdownElements) ?? [];
  if (node.type === "root" || node.type === "text") return descendants;
  const tag =
    node.type === "heading"
      ? `h${node.depth}`
      : node.type === "list"
        ? node.ordered
          ? "ol"
          : "ul"
        : tags[node.type];
  if (!tag) throw new Error(`Unverified policy Markdown node: ${node.type}`);
  return [
    {
      tag,
      text: normalized(nodeText(node)),
      ...(node.type === "link" && node.url
        ? { href: markdownLinks[node.url] ?? node.url }
        : {}),
    },
    ...descendants,
  ];
}

describe("public GitHub Pages site", () => {
  it.each(pageNames)(
    "%s is readable without scripts or external resources",
    (name) => {
      const page = loadPage(name);
      expect(page.documentElement.lang).toBe("ja");
      expect(page.title).toContain("Memoka");
      expect(
        page.querySelector('meta[name="description"]')?.getAttribute("content"),
      ).toBeTruthy();
      expect(
        page.querySelector('meta[name="viewport"]')?.getAttribute("content"),
      ).toContain("width=device-width");
      expect(page.querySelectorAll("main")).toHaveLength(1);
      expect(page.querySelectorAll("h1")).toHaveLength(1);
      expect(page.querySelector("main")?.getAttribute("tabindex")).toBe("-1");
      expect(page.querySelector(".skip-link")?.getAttribute("href")).toBe(
        "#main",
      );
      expect(
        page.querySelector(
          "script, iframe, object, embed, form, base, style, [style], meta[http-equiv='refresh']",
        ),
      ).toBeNull();
      expect(
        page
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content"),
      ).toContain("default-src 'none'");
      expect(
        page.querySelector('meta[name="referrer"]')?.getAttribute("content"),
      ).toBe("no-referrer");
      expect(
        page
          .querySelector('header nav [aria-current="page"]')
          ?.getAttribute("href"),
      ).toBe(`./${name}`);
      for (const node of page.querySelectorAll("*")) {
        expect(
          node
            .getAttributeNames()
            .filter((attribute) => /^on/iu.test(attribute)),
        ).toEqual([]);
      }
      const ids = [...page.querySelectorAll("[id]")].map((node) => node.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const target of ["./privacy.html", "./terms.html"]) {
        expect(
          page.querySelector(`header nav a[href="${target}"]`),
        ).not.toBeNull();
        expect(
          page.querySelector(`footer nav a[href="${target}"]`),
        ).not.toBeNull();
      }
    },
  );

  it.each([
    "https://memoka-project.github.io/",
    "https://memoka-project.github.io/memoka/",
  ])("all site links and assets resolve under %s", (base) => {
    const root = new URL(base);
    for (const name of pageNames) {
      const page = loadPage(name);
      const pageUrl = new URL(name, root);
      for (const node of page.querySelectorAll("[href], [src]")) {
        const href = node.getAttribute("href") ?? node.getAttribute("src")!;
        const url = new URL(href, pageUrl);
        expect(url.protocol).toBe("https:");
        if (node.matches("link, img")) expect(url.origin).toBe(root.origin);
        if (url.origin !== root.origin) continue;
        expect(url.pathname.startsWith(root.pathname)).toBe(true);
        const file = decodeURIComponent(
          url.pathname.slice(root.pathname.length),
        );
        expect(existsSync(resolve(pagesRoot, file))).toBe(true);
        if (url.hash) {
          expect(
            loadPage(file).getElementById(
              decodeURIComponent(url.hash.slice(1)),
            ),
          ).not.toBeNull();
        }
      }
    }
  });

  it.each([
    ["PRIVACY.md", "privacy.html"],
    ["TERMS.md", "terms.html"],
  ])(
    "%s and %s have identical policy content, structure and links",
    (source, pageName) => {
      const sourceText = readFileSync(resolve(process.cwd(), source), "utf8");
      const tree = unified().use(remarkParse).parse(sourceText);
      const page = loadPage(pageName);
      const article = page.querySelector(
        `article[data-policy-source="${source}"]`,
      )!;
      expect(article).not.toBeNull();
      const tocLinks = [...article.querySelectorAll("[data-policy-toc] a")];
      const headings = [...article.querySelectorAll("h2")];
      expect(
        tocLinks.map((node) => [
          node.getAttribute("href"),
          normalized(node.textContent ?? ""),
        ]),
      ).toEqual(
        headings.map((node) => [
          `#${node.id}`,
          normalized(node.textContent ?? ""),
        ]),
      );
      article.querySelector("[data-policy-toc]")?.remove();
      expect(normalized(article.textContent ?? "")).toBe(
        normalized(nodeText(tree)),
      );
      const elements = [
        ...article.querySelectorAll(
          "h1, h2, h3, h4, h5, h6, p, ul, ol, li, code, strong, em, a",
        ),
      ].map((node) => ({
        tag: node.localName,
        text: normalized(node.textContent ?? ""),
        ...(node.matches("a") ? { href: node.getAttribute("href") } : {}),
      }));
      expect(elements).toEqual(markdownElements(tree));
    },
  );

  it("ships local assets, reuses the app icon and adapts to narrow or dark screens", () => {
    const styles = readFileSync(resolve(pagesRoot, "styles.css"), "utf8");
    expect(styles).not.toMatch(/@import|url\s*\(/iu);
    expect(styles).toContain("prefers-color-scheme: dark");
    expect(styles).toContain("max-width: 520px");
    expect(styles).toContain(":focus-visible");
    expect(existsSync(resolve(pagesRoot, ".nojekyll"))).toBe(true);
    const icon = readFileSync(resolve(pagesRoot, "icon.svg"), "utf8");
    const original = readFileSync(
      resolve(process.cwd(), "src-tauri/icons/memoka-icon.svg"),
      "utf8",
    );
    expect(normalized(icon)).toBe(normalized(original));
  });
});
