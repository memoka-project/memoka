// Start `corepack pnpm dev --port 5199` and `WebKitWebDriver --port=4449`.
// Uses a fresh MiniBrowser automation session, never the desktop Workspace.
import assert from "node:assert/strict";

const endpoint = process.env.MEMOKA_SYMBOL_WEBDRIVER ?? "http://127.0.0.1:4449";
const url = process.env.MEMOKA_SYMBOL_URL ?? "http://127.0.0.1:5199";
async function request(path, body, method = "POST") {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(JSON.stringify(value));
  return value;
}
const { sessionId } = await request("/session", {
  capabilities: { alwaysMatch: { browserName: "MiniBrowser" } },
});
const base = `/session/${sessionId}`;
const execute = (script) =>
  request(`${base}/execute/sync`, { script, args: [] });
async function waitFor(script, predicate = Boolean) {
  for (let index = 0; index < 200; index += 1) {
    const value = await execute(script);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${script}`);
}
async function send(value) {
  const element = await request(`${base}/element/active`, undefined, "GET");
  await request(
    `${base}/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/value`,
    { text: value },
  );
}
const ctrl = (key) => send(`\uE009${key}\uE000`);

try {
  await request(`${base}/url`, { url });
  await waitFor("return document.querySelector('.memoka-editor')");
  // Ensure this standalone browser's initial empty editor owns focus.
  await execute(
    "document.querySelector('.memoka-editor').focus(); return true",
  );
  await send("\uE00C"); // Escape
  await send("i");
  await send("A");
  await ctrl("e");
  await waitFor(
    "return document.activeElement?.getAttribute('aria-label') === '絵文字・アイコンを検索'",
  );
  await send("smile");
  await ctrl("3");
  await waitFor(
    "return document.querySelector('.symbol-picker__filters [aria-pressed=true]')?.textContent",
    (value) => value?.includes("Lucide"),
  );
  await send("\uE007"); // Enter
  await waitFor(
    "return !document.querySelector('[data-memoka-focus-surface=symbol-picker]')",
  );
  await send("B");
  const text = await execute(
    "return document.querySelector('.memoka-editor').textContent",
  );
  assert.ok(text.includes("A:lucide-face-slightly-smiling:B"), text);
  await send("\uE012"); // Left from after B to icon end
  await send("\uE012"); // Left across icon
  await send("x");
  const afterLeft = await execute(
    "return document.querySelector('.memoka-editor').textContent",
  );
  assert.ok(afterLeft.includes("Ax:lucide-face-slightly-smiling:B"), afterLeft);
  await send("\uE014"); // Right across icon
  await send("\uE003"); // Backspace deletes whole token
  assert.ok(
    (
      await execute(
        "return document.querySelector('.memoka-editor').textContent",
      )
    ).includes("AxB"),
  );
  await send("\uE00C");
  await send("u");
  await waitFor(
    "return document.querySelector('.memoka-editor .memoka-symbol-icon')",
  );
  // Native click must place the Normal caret at the visible icon, not its hidden text.
  const icon = await request(`${base}/element`, {
    using: "css selector",
    value: ".memoka-editor .memoka-symbol-icon",
  });
  await request(
    `${base}/element/${icon["element-6066-11e4-a52e-4f735466cecf"]}/click`,
    {},
  );
  const geometry = await waitFor(
    `const icon = document.querySelector('.memoka-editor .memoka-symbol-icon');
    const caret = [...document.querySelectorAll('.memoka-vim-caret')].find(node => getComputedStyle(node).display !== 'none');
    if (!icon || !caret) return null;
    const a=icon.getBoundingClientRect(), b=caret.getBoundingClientRect();
    return { icon: {left:a.left,top:a.top,width:a.width,height:a.height}, caret:{left:b.left,top:b.top,width:b.width,height:b.height}, cursor:caret.dataset.cursor, from:icon.dataset.symbolFrom };`,
    (value) => value?.cursor === value?.from,
  );
  assert.ok(
    Math.abs(geometry.icon.left - geometry.caret.left) < 2,
    JSON.stringify(geometry),
  );
  assert.ok(
    geometry.caret.width >= geometry.icon.width - 2,
    JSON.stringify(geometry),
  );
  await send("i");
  await ctrl("e");
  await waitFor(
    "return document.querySelector('[data-memoka-focus-surface=symbol-picker]')",
  );
  await send("\uE00C");
  await waitFor(
    "return document.activeElement?.classList.contains('memoka-editor')",
  );
  assert.equal(
    await execute(
      "return document.querySelector('.memoka-editor').dataset.vimMode",
    ),
    "insert",
  );
  // Directly authored adjacent tokens, mixed CJK and wrapped body text.
  await send("\uE00C");
  await send("G");
  await send("i");
  await send(
    "日本語:lucide-smile::lucide-check:本文本文本文本文本文本文本文本文本文本文",
  );
  await waitFor(
    "return document.querySelectorAll('.memoka-section-body .memoka-symbol-icon').length",
    (value) => value === 2,
  );
  assert.ok(
    (
      await execute(
        "return document.querySelector('.memoka-section-body').textContent",
      )
    ).includes("日本語:lucide-smile::lucide-check:本文"),
  );
  await send("\uE00C");
  await send("0");
  await send("lll");
  const iconCursor = await waitFor(
    `const icon = document.querySelector('.memoka-section-body .memoka-symbol-icon');
    const caret = document.querySelector('.memoka-vim-caret');
    return { from:icon?.dataset.symbolFrom, cursor:caret?.dataset.cursor };`,
    (value) => value.from === value.cursor,
  );
  assert.equal(iconCursor.from, iconCursor.cursor);
  await send("x");
  assert.ok(
    (
      await execute(
        "return document.querySelector('.memoka-section-body').textContent",
      )
    ).includes("日本語:lucide-check:本文"),
  );
  await send("u");
  await waitFor(
    "return document.querySelectorAll('.memoka-section-body .memoka-symbol-icon').length",
    (value) => value === 2,
  );
  const wrapped =
    await execute(`const paragraph = document.querySelector('.memoka-section-body p');
    paragraph.style.width = '120px';
    const icons = [...paragraph.querySelectorAll('.memoka-symbol-icon')].map(icon => { const r=icon.getBoundingClientRect(); return { width:r.width, height:r.height }; });
    return { height:paragraph.getBoundingClientRect().height, icons };`);
  assert.ok(
    wrapped.height > wrapped.icons[0].height * 2,
    JSON.stringify(wrapped),
  );
  for (const icon of wrapped.icons)
    assert.ok(Math.abs(icon.width - icon.height) < 1, JSON.stringify(wrapped));
  const spacing =
    await execute(`const paragraph = document.querySelector('.memoka-section-body p');
    paragraph.style.width = '1000px';
    const icons = [...paragraph.querySelectorAll('.memoka-symbol-icon')].map(icon => icon.getBoundingClientRect());
    const gaps = [...paragraph.querySelectorAll('.memoka-symbol-space')].map(gap => gap.getBoundingClientRect().width);
    return { gaps, between: icons[1].left-icons[0].right };`);
  assert.equal(spacing.gaps.length, 3);
  assert.ok(
    spacing.gaps.every((width) => width > 0),
    JSON.stringify(spacing),
  );
  assert.ok(
    Math.abs(spacing.between - spacing.gaps[1]) < 0.5,
    JSON.stringify(spacing),
  );
  await send("A");
  // WebKitWebDriver's key synthesis drops supplementary-plane characters.
  // Exercise the browser's native text insertion path for the emoji sequence.
  await execute(
    "return document.execCommand('insertText', false, '😀👨‍👩‍👧‍👦:lucide-check:Z')",
  );
  await waitFor(
    "return document.querySelectorAll('.memoka-section-body .memoka-symbol-space').length",
    (value) => value === 7,
  ).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await execute("return JSON.stringify({text:document.querySelector('.memoka-section-body')?.textContent, gaps:document.querySelectorAll('.memoka-section-body .memoka-symbol-space').length, mode:document.querySelector('.memoka-editor')?.dataset.vimMode})")}`,
    );
  });
  assert.ok(
    (
      await execute(
        "return document.querySelector('.memoka-section-body').textContent",
      )
    ).endsWith("😀👨‍👩‍👧‍👦:lucide-check:Z"),
  );
  await execute("return document.execCommand('insertText', false, '❤️日1️⃣日')");
  await waitFor(
    "return document.querySelectorAll('.memoka-section-body .memoka-symbol-space').length",
    (value) => value === 11,
  );
  assert.equal(
    await execute(
      "return document.querySelectorAll('.memoka-section-body .memoka-text-autospace-after').length",
    ),
    0,
  );
  await waitFor(
    "return document.querySelector('.application-tab-title .memoka-symbol-icon')",
  ).catch(async (error) => {
    throw new Error(
      `${error.message}: ${await execute("return JSON.stringify({tab:document.querySelector('.application-tab-title').textContent, title:document.querySelector('[data-section-header]').textContent})")}`,
    );
  });
  console.log(
    JSON.stringify({
      result: "PASS",
      browser: "WebKitGTK",
      tests: [
        "Ctrl-e",
        "Ctrl-3",
        "native insertion",
        "arrow movement",
        "atomic Backspace",
        "Undo",
        "click/caret geometry",
        "cancel/focus",
        "typed adjacent icons",
        "CJK wrapping",
        "title/tab rendering",
        "single-gap emoji/icon spacing",
      ],
    }),
  );
} finally {
  await request(base, undefined, "DELETE");
}
