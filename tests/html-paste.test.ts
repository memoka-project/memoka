import { describe, expect, it } from "vitest";
import { sanitizeExternalHtml } from "../app/src/editor/html-paste";

describe("external HTML paste sanitization", () => {
  it("removes active content and unsafe attributes in a detached document", () => {
    const sanitized = sanitizeExternalHtml(
      [
        '<h2 onclick="alert(1)" style="color:red">Safe heading</h2>',
        '<script>document.body.textContent = "owned"</script>',
        '<a href="javascript:alert(1)" autofocus>Unsafe link</a>',
        '<a href="data:text/html,owned">Unsafe data link</a>',
        '<a href="https://example.com/path" target="_blank">Safe link</a>',
        '<img src="https://tracker.example/pixel" onerror="alert(1)">',
        '<svg><a xlink:href="javascript:alert(1)">SVG link</a></svg>',
        '<p contenteditable="true">Safe paragraph</p>',
        '<pre><code class="language-ts injected">const n = 1;</code></pre>',
        '<blockquote data-memoka-alert-type="warning" data-memoka-alert-title="Careful" data-memoka-alert-fold="collapsed" onclick="bad()">Alert</blockquote>',
        '<blockquote data-memoka-alert-type="bad type" data-memoka-alert-fold="hidden">Plain quote</blockquote>',
      ].join(""),
    );

    expect(sanitized).toContain("Safe heading");
    expect(sanitized).toContain("Safe paragraph");
    expect(sanitized).toContain('href="https://example.com/path"');
    expect(sanitized).toContain("const n = 1;");
    expect(sanitized).toContain('data-memoka-alert-type="warning"');
    expect(sanitized).toContain('data-memoka-alert-title="Careful"');
    expect(sanitized).toContain('data-memoka-alert-fold="collapsed"');
    expect(sanitized).not.toContain("bad type");
    expect(sanitized).not.toContain('data-memoka-alert-fold="hidden"');
    expect(sanitized).not.toMatch(
      /script|onclick|style=|javascript:|data:text|autofocus|contenteditable|target=|img|svg|tracker|injected/iu,
    );
  });
});
