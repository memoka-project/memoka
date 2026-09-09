import assert from "node:assert/strict";

/** Exercise real WebKit hit testing, wrapped/marked text and chunk replacement
 * in the runner's private Workspace, without touching the user's clipboard. */
export async function runViewportCaret({
  sessionId,
  execute,
  waitFor,
  sendActiveKey,
}) {
  for (const key of [":", "h", "e", "l", "p", "\uE007"])
    await sendActiveKey(sessionId, key);
  await waitFor(
    sessionId,
    `return document.querySelector('.editor-window:first-child .memoka-editor [data-section-header]')?.textContent`,
    (value) => value === "Memoka help",
  );

  const results = [];
  for (const layout of ["split", "single"]) {
    if (layout === "single") {
      await sendActiveKey(sessionId, "\uE00C");
      await execute(
        sessionId,
        `const editor = document.querySelector('.editor-window:first-child .memoka-editor');
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }));
        return true;`,
      );
      await waitFor(
        sessionId,
        `return document.querySelectorAll('.editor-window').length`,
        (value) => value === 1,
      );
    }
    for (const mode of ["normal", "insert"]) {
      for (const key of [
        "\uE00C",
        "g",
        "g",
        ...(mode === "insert" ? ["i"] : []),
      ])
        await sendActiveKey(sessionId, key);
      await execute(
        sessionId,
        `const root = document.querySelector('.editor-window:first-child');
        const editor = root.querySelector('.memoka-editor');
        const scroll = root.querySelector('.editor-scroll');
        const state = window.__MEMOKA_VIEWPORT_CARET__ = { done: false, samples: [], error: null };
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const snapshot = () => {
          const caret = [...document.querySelectorAll('.memoka-vim-caret')].find(node => getComputedStyle(node).display !== 'none');
          const rect = caret?.getBoundingClientRect();
          const viewport = scroll.getBoundingClientRect();
          return { cursor: caret?.dataset.cursor, mode: editor.dataset.vimMode, scrollTop: scroll.scrollTop,
            top: rect ? rect.top - viewport.top : null,
            bottom: rect ? rect.bottom - viewport.bottom : null,
            active: document.activeElement === editor,
            chunks: editor.querySelectorAll('[data-body-chunk-active="true"]').length };
        };
        (async () => {
          for (let index = 0; index < 64; index++) {
            const delta = (index < 32 ? 1 : -1) * (index % 10 === 9 ? 1237 : 17 + (index % 7) * 43);
            scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true }));
            scroll.scrollTop += delta;
            for (let n = 0; n < 6; n++) await frame();
            const settled = snapshot();
            for (let n = 0; n < 4; n++) await frame();
            state.samples.push({ index, delta, settled, stable: snapshot() });
          }
        })().catch(error => { state.error = String(error); }).finally(() => { state.done = true; });
        return true;`,
      );
      const result = await waitFor(
        sessionId,
        `return window.__MEMOKA_VIEWPORT_CARET__`,
        (value) => value?.done,
        45000,
      );
      assert.equal(result.error, null);
      for (const sample of result.samples) {
        const label = JSON.stringify({ layout, mode, ...sample });
        for (const caret of [sample.settled, sample.stable]) {
          assert.equal(caret.mode, mode, label);
          assert.equal(caret.active, true, label);
          assert.notEqual(caret.top, null, label);
          assert.ok(caret.top >= -0.5 && caret.bottom <= 0.5, label);
        }
        assert.equal(sample.settled.cursor, sample.stable.cursor, label);
        assert.ok(
          Math.abs(sample.settled.scrollTop - sample.stable.scrollTop) <= 1,
          label,
        );
      }
      results.push({
        layout,
        mode,
        samples: result.samples.length,
        result: "PASS",
      });
    }
  }
  return { id: "viewport-caret-tauri", results };
}
