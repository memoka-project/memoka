// Real-layout regression test: start Vite and WebKitWebDriver first.
// MEMOKA_WEBDRIVER=http://127.0.0.1:4459 node scripts/test-text-autospace.mjs
import assert from "node:assert/strict";

const driver = process.env.MEMOKA_WEBDRIVER ?? "http://127.0.0.1:4459";
const app = process.env.MEMOKA_TEST_APP_URL ?? "http://127.0.0.1:1421";

async function request(path, body, method = "POST") {
  const response = await fetch(`${driver}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok && !result.value?.error, JSON.stringify(result));
  return result.value;
}

const { sessionId } = await request("/session", {
  capabilities: { alwaysMatch: { browserName: "MiniBrowser" } },
});
try {
  await request(`/session/${sessionId}/url`, { url: app });
  const result = await request(`/session/${sessionId}/execute/async`, {
    args: [],
    script: `
      const done = arguments[arguments.length - 1];
      (async () => {
        const { hasTextAutospaceInlineEndBug, TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE } =
          await import('/src/editor/text-autospace.ts');
        const { CoreRuntime } = await import('/src/core/runtime.ts');
        const { MemoryPersistencePort } = await import('/src/core/persistence.ts');
        const { setJapaneseSegmentationConfiguration } = await import('/src/core/japanese-segmentation.ts');
        const { measureVimBlockCaretGeometry, measureVimInsertCaretGeometry } = await import('/src/vim/caret-geometry.ts');
        const deadline = performance.now() + 10000;
        while (!document.documentElement.hasAttribute(TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE)) {
          if (performance.now() > deadline) throw new Error('Application startup timed out');
          await new Promise(requestAnimationFrame);
        }
        const detected = hasTextAutospaceInlineEndBug(document);
        const startup = document.documentElement.getAttribute(TEXT_AUTOSPACE_INLINE_END_DATA_ATTRIBUTE);
        const runtime = await CoreRuntime.open(new MemoryPersistencePort());
        const root = document.createElement('div');
        root.style.cssText = 'position:fixed;inset:0;overflow:auto;z-index:99999';
        document.body.append(root);
        const { editor, adapter } = runtime.editorForTesting('window-1', root);
        const rows = [];
        try {
          for (const mode of ['native', 'budoux', 'fine']) {
            setJapaneseSegmentationConfiguration({ wordSegmentation: 'fine', lineBreakSegmentation: mode });
            for (const html of ['日A日', '日<strong>A</strong>日', 'ノートタイトルはEditorのRoot title']) {
              editor.commands.setContent('<p>' + html + '</p>');
              const before = JSON.stringify(editor.getJSON());
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
              const p = root.querySelector('p');
              p.style.cssText = 'font:32px sans-serif;white-space:nowrap';
              const width = () => {
                const range = document.createRange();
                range.selectNodeContents(p);
                return range.getBoundingClientRect().width;
              };
              const widgets = [...p.querySelectorAll('.memoka-text-autospace-after')];
              const corrected = width();
              const expected = widgets.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
              for (const el of widgets) el.style.display = 'none';
              const baseline = width();
              for (const el of widgets) el.style.removeProperty('display');
              const carets = [];
              const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
              for (let textNode; (textNode = walker.nextNode());) {
                for (let offset = 0; offset < textNode.length; offset++) {
                  const position = editor.view.posAtDOM(textNode, offset);
                  const range = document.createRange();
                  range.setStart(textNode, offset);
                  range.setEnd(textNode, offset + 1);
                  const rect = range.getBoundingClientRect();
                  const block = measureVimBlockCaretGeometry(editor.view, position);
                  const insert = measureVimInsertCaretGeometry(editor.view, position);
                  carets.push({ character: textNode.data[offset], block, insert,
                    expected: { left: rect.left, top: rect.top, height: rect.height, width: rect.width } });
                }
              }
              rows.push({ mode, html, count: widgets.length, added: corrected - baseline, expected,
                carets,
                unchanged: before === JSON.stringify(editor.getJSON()),
                text: p.textContent,
                breaks: p.querySelectorAll('wbr').length });
            }
          }
          return { detected, startup, rows };
        } finally {
          adapter.destroy();
          runtime.destroy();
          root.remove();
        }
      })().then(done, error => done({ error: String(error), stack: error.stack }));
    `,
  });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(
    result.detected,
    true,
    "WebKit inline-boundary bug must be detected",
  );
  assert.equal(result.startup, "broken", "Startup must enable compensation");
  for (const row of result.rows) {
    assert.equal(
      row.count,
      row.html.includes("Editor") ? 3 : 2,
      JSON.stringify(row),
    );
    assert.ok(row.unchanged, "Spacing must not change document data");
    assert.equal(row.text, row.html.replace(/<[^>]*>/gu, ""));
    assert.ok(row.expected > 0, JSON.stringify(row));
    assert.ok(Math.abs(row.added - row.expected) < 0.1, JSON.stringify(row));
    for (const caret of row.carets) {
      for (const geometry of [caret.block, caret.insert]) {
        assert.ok(geometry, JSON.stringify(caret));
        for (const key of ["left", "top", "height"]) {
          assert.ok(
            Math.abs(geometry[key] - caret.expected[key]) < 0.1,
            JSON.stringify(caret),
          );
        }
      }
      // Glyph bounds and caret advances can differ by subpixel font bearings.
      assert.ok(
        caret.block.width >= Math.max(8, caret.expected.width) - 1,
        JSON.stringify(caret),
      );
      assert.equal(caret.insert.width, 2);
    }
  }
  assert.ok(
    result.rows.some((row) => row.breaks > 0),
    "Must exercise WBR boundaries",
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        rows: result.rows.map(({ carets, ...row }) => ({
          ...row,
          checkedCarets: carets.length,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await request(`/session/${sessionId}`, undefined, "DELETE");
}
