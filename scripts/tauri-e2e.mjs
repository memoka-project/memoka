import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const webdriver = process.env.MEMOKA_WEBDRIVER ?? "http://127.0.0.1:4447";
const application = process.env.MEMOKA_TAURI_APP;
const evidenceDirectory =
  process.env.MEMOKA_EVIDENCE_DIR ?? "evidence/generated";
const e2eDataHome = process.env.MEMOKA_E2E_DATA_HOME;
const e2eWorkspace = process.env.MEMOKA_E2E_WORKSPACE;
const searchOnly = process.env.MEMOKA_E2E_SEARCH_ONLY === "1";
const utilitiesOnly = process.env.MEMOKA_E2E_UTILITIES_ONLY === "1";
const sidebarFocusOnly = process.env.MEMOKA_E2E_SIDEBAR_FOCUS_ONLY === "1";
const windowChromeOnly = process.env.MEMOKA_E2E_WINDOW_CHROME_ONLY === "1";
const attachmentOnly = process.env.MEMOKA_E2E_ATTACHMENT_ONLY === "1";
const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const ENTER = "\uE007";
const ESCAPE = "\uE00C";
const CONTROL = "\uE009";
const NULL_KEY = "\uE000";
const HIGH_LOAD_PARAGRAPH_BYTES = 1024;
const HIGH_LOAD_PARAGRAPH_COUNT = 1000;
const HIGH_LOAD_WARMUP_COUNT = 5;
const HIGH_LOAD_SAMPLE_COUNT = 1026;
const HIGH_LOAD_BURST_SAMPLE_COUNT = 40;
const HIGH_LOAD_BURST_MAX_DRAIN_MS = 5_000;
const SNAPSHOT_COMPACTION_THRESHOLD = 128;
const UTILITY_SWITCH_WARMUP_COUNT = 5;
const UTILITY_SWITCH_SAMPLE_COUNT = 30;
const wordMotionFixture = "Memoka漢字ひらがなカタカナーabc123";
const wordRunStarts = [0, 6, 8, 12, 17, 24];
const insertedText = `${wordMotionFixture}-${Date.now()}`;

if (!application) throw new Error("MEMOKA_TAURI_APP is required");
mkdirSync(evidenceDirectory, { recursive: true });

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio) =>
    sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(sorted.at(-1) ?? 0),
  };
}

function inspectFcitxRemote() {
  if (process.platform !== "linux") {
    return {
      expected: false,
      result: "NOT_RUN",
      reason: "not Linux",
    };
  }
  try {
    execFileSync("fcitx5-remote", ["--check"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      expected: true,
      result: "RUNNING",
    };
  } catch (error) {
    return {
      expected: false,
      result: "NOT_RUNNING_OR_UNAVAILABLE",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectWaylandClipboard() {
  if (
    process.platform !== "linux" ||
    process.env.XDG_SESSION_TYPE !== "wayland"
  ) {
    return {
      tool: "wl-paste",
      result: "NOT_RUN",
      reason: "not a Linux Wayland session",
    };
  }
  try {
    const availableTypes = execFileSync("wl-paste", ["--list-types"], {
      encoding: "utf8",
      timeout: 5_000,
    })
      .split("\n")
      .map((type) => type.trim())
      .filter(Boolean)
      .sort();
    const typeFor = (expected) =>
      expected === "text/plain"
        ? availableTypes.find((type) => type.startsWith("text/plain"))
        : availableTypes.find((type) => type === expected);
    const expectedTypes = [
      "application/x-memoka-structured-blocks+json",
      "text/html",
      "text/markdown",
      "text/plain",
    ];
    const resolvedTypes = Object.fromEntries(
      expectedTypes.map((type) => [type, typeFor(type) ?? null]),
    );
    const missingTypes = expectedTypes.filter((type) => !resolvedTypes[type]);
    const content = Object.fromEntries(
      Object.entries(resolvedTypes)
        .filter((entry) => entry[1] !== null)
        .map(([expected, actual]) => [
          expected,
          execFileSync("wl-paste", ["--no-newline", "--type", String(actual)], {
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: 1_000_000,
          }),
        ]),
    );
    const gnomeFileContent = availableTypes.includes(
      "x-special/gnome-copied-files",
    )
      ? execFileSync(
          "wl-paste",
          ["--no-newline", "--type", "x-special/gnome-copied-files"],
          {
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: 1_000_000,
          },
        )
      : null;
    return {
      tool: "wl-paste",
      result: missingTypes.length === 0 ? "FOUR_MIME_PASS" : "MIME_MISMATCH",
      availableTypes,
      resolvedTypes,
      missingTypes,
      content,
      gnomeFileContent,
    };
  } catch (error) {
    return {
      tool: "wl-paste",
      result: "NOT_RUN",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function retrieveWaylandPortalClipboardFiles() {
  if (
    process.platform !== "linux" ||
    process.env.XDG_SESSION_TYPE !== "wayland"
  ) {
    return {
      tool: "xdg-desktop-portal FileTransfer",
      result: "NOT_RUN",
      reason: "not a Linux Wayland session",
    };
  }
  try {
    const key = execFileSync(
      "wl-paste",
      ["--no-newline", "--type", "application/vnd.portal.filetransfer"],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1_000_000,
      },
    );
    const retrieved = execFileSync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.portal.Documents",
        "--object-path",
        "/org/freedesktop/portal/documents",
        "--method",
        "org.freedesktop.portal.FileTransfer.RetrieveFiles",
        key,
        "{}",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1_000_000,
      },
    ).trim();
    return {
      tool: "xdg-desktop-portal FileTransfer",
      result: "RETRIEVED",
      keyLength: key.length,
      retrieved,
    };
  } catch (error) {
    return {
      tool: "xdg-desktop-portal FileTransfer",
      result: "ERROR",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectWaylandFileTransferPortal() {
  if (
    process.platform !== "linux" ||
    process.env.XDG_SESSION_TYPE !== "wayland"
  ) {
    return {
      available: false,
      result: "NOT_RUN",
      reason: "not a Linux Wayland session",
    };
  }
  try {
    execFileSync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.portal.Documents",
        "--object-path",
        "/org/freedesktop/portal/documents",
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.portal.FileTransfer",
        "version",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1_000_000,
      },
    );
    return { available: true, result: "AVAILABLE" };
  } catch (error) {
    return {
      available: false,
      result: "UNAVAILABLE",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForWaylandClipboardKind(kind, structureKind = null) {
  const deadline = performance.now() + 5_000;
  let clipboard = inspectWaylandClipboard();
  while (performance.now() < deadline) {
    if (clipboard.result !== "FOUR_MIME_PASS") return clipboard;
    try {
      const payload = JSON.parse(
        clipboard.content["application/x-memoka-structured-blocks+json"] ??
          "null",
      );
      if (
        payload?.kind === kind &&
        (structureKind === null || payload.structureKind === structureKind)
      ) {
        return clipboard;
      }
    } catch {
      // Retry while the asynchronous Clipboard write is still settling.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    clipboard = inspectWaylandClipboard();
  }
  throw new Error(
    `Wayland Clipboard did not expose Memoka ${[kind, structureKind]
      .filter(Boolean)
      .join("/")}: ${JSON.stringify(clipboard)}`,
  );
}

async function writeWaylandClipboard(type, content) {
  if (
    process.platform !== "linux" ||
    process.env.XDG_SESSION_TYPE !== "wayland"
  ) {
    return {
      tool: "wl-copy",
      result: "NOT_RUN",
      reason: "not a Linux Wayland session",
    };
  }
  try {
    const owner = spawn("wl-copy", ["--foreground", "--type", type, content], {
      detached: true,
      stdio: "ignore",
    });
    owner.unref();
    const deadline = performance.now() + 5_000;
    let availableTypes = [];
    let observedContent = null;
    while (performance.now() < deadline) {
      availableTypes = execFileSync("wl-paste", ["--list-types"], {
        encoding: "utf8",
        timeout: 1_000,
      })
        .split("\n")
        .map((availableType) => availableType.trim())
        .filter(Boolean);
      const ownsExpectedType =
        type === "text/plain"
          ? availableTypes.some((availableType) =>
              availableType.startsWith("text/plain"),
            ) && !availableTypes.includes("text/markdown")
          : availableTypes.includes(type);
      if (ownsExpectedType) {
        try {
          observedContent = execFileSync(
            "wl-paste",
            ["--no-newline", "--type", type],
            {
              encoding: "utf8",
              timeout: 1_000,
              maxBuffer: 1_000_000,
            },
          );
        } catch {
          observedContent = null;
        }
        if (observedContent === content) {
          return {
            tool: "wl-copy",
            result: "WRITTEN",
            type,
            content,
            availableTypes,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      tool: "wl-copy",
      result: "ERROR",
      type,
      reason: "timed out waiting for Wayland Clipboard ownership",
      availableTypes,
      observedContent,
    };
  } catch (error) {
    return {
      tool: "wl-copy",
      result: "ERROR",
      type,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readPersistedHighLoad(noteId) {
  if (!e2eWorkspace) {
    throw new Error("MEMOKA_E2E_WORKSPACE is required");
  }
  if (!/^[0-9a-f-]{36}$/.test(noteId)) {
    throw new Error(`Unexpected note ID: ${noteId}`);
  }
  const database = join(e2eWorkspace, ".memoka", "memoka.sqlite3");
  const rows = JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-json",
        database,
        `SELECT
           d.revision,
           d.snapshot_revision,
           length(d.snapshot) AS snapshot_bytes,
           count(u.revision) AS update_count,
           coalesce(sum(length(u.update_blob)), 0) AS update_bytes
         FROM documents AS d
         LEFT JOIN document_updates AS u
           ON u.kind = d.kind AND u.document_id = d.document_id
         WHERE d.kind = 'note' AND d.document_id = '${noteId}'
         GROUP BY d.kind, d.document_id`,
      ],
      { encoding: "utf8" },
    ),
  );
  if (rows.length !== 1) {
    throw new Error(
      `Expected one persisted NoteDoc row, received: ${JSON.stringify(rows)}`,
    );
  }
  const row = rows[0];
  return {
    revision: Number(row.revision),
    snapshotRevision: Number(row.snapshot_revision),
    snapshotBytes: Number(row.snapshot_bytes),
    incrementalUpdateCount: Number(row.update_count),
    incrementalUpdateBytes: Number(row.update_bytes),
  };
}

function inspectPersistedHighLoad(noteId, expected) {
  const result = readPersistedHighLoad(noteId);
  if (
    result.revision !== expected.revision ||
    result.snapshotRevision !== expected.snapshotRevision ||
    result.incrementalUpdateCount !== expected.incrementalUpdateCount
  ) {
    throw new Error(
      `Unexpected persisted compaction state: ${JSON.stringify({
        result,
        expected,
      })}`,
    );
  }
  return result;
}

async function request(path, options = {}) {
  const response = await fetch(`${webdriver}${path}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) {
    throw new Error(`${path}: ${JSON.stringify(result)}`);
  }
  return result.value;
}

async function execute(sessionId, script) {
  return request(`/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: { script, args: [] },
  });
}

async function invokeTauriCommand(sessionId, resultKey, command, args) {
  const slot = `__MEMOKA_TAURI_${resultKey}`;
  await execute(
    sessionId,
    `window[${JSON.stringify(slot)}] = {
       state: 'pending',
       value: null,
       reason: null
     };
     const invoke = window.__TAURI_INTERNALS__?.invoke;
     if (typeof invoke !== 'function') {
       window[${JSON.stringify(slot)}].state = 'unavailable';
       return true;
     }
     invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
       .then((value) => {
         window[${JSON.stringify(slot)}] = {
           state: 'fulfilled',
           value: value ?? null,
           reason: null
         };
       })
       .catch((error) => {
         window[${JSON.stringify(slot)}] = {
           state: 'rejected',
           value: null,
           reason: String(error)
         };
       });
     return true`,
  );
  const result = await waitFor(
    sessionId,
    `return window[${JSON.stringify(slot)}]`,
    (value) => value?.state !== "pending",
    30_000,
  );
  if (result.state !== "fulfilled") {
    throw new Error(
      `${command} failed through Tauri IPC: ${JSON.stringify(result)}`,
    );
  }
  return result.value;
}

async function waitFor(sessionId, script, predicate, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  let value;
  while (performance.now() < deadline) {
    value = await execute(sessionId, script);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${script}; last value: ${JSON.stringify(value)}`,
  );
}

async function createSession() {
  const value = await request("/session", {
    method: "POST",
    body: {
      capabilities: {
        alwaysMatch: {
          "tauri:options": { application },
        },
      },
    },
  });
  const initialEditorCount = await waitFor(
    value.sessionId,
    "return document.querySelectorAll('.memoka-editor').length",
    (count) => count >= 1,
    30_000,
  );
  if (initialEditorCount === 1) {
    const firstEditor = await findElement(
      value.sessionId,
      ".editor-window:first-child .memoka-editor",
    );
    await sendKeys(value.sessionId, firstEditor, ESCAPE);
    // Keep Control depressed across the prefix boundary. WebDriver's NULL key
    // is surfaced by WebKit as an unidentified keydown and would cancel the
    // pending Vim prefix before the following key arrives.
    await sendKeys(value.sessionId, firstEditor, `${CONTROL}w`);
    await waitFor(
      value.sessionId,
      `return document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? ''`,
      (action) => action === "pending:window",
    );
    await sendKeys(value.sessionId, firstEditor, `v${NULL_KEY}`);
    await waitFor(
      value.sessionId,
      `return {
         editorCount: document.querySelectorAll('.memoka-editor').length,
         action: document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
         message: document.querySelector(
           '.application-commandline--idle span:last-child'
         )?.textContent ?? ''
       }`,
      ({ editorCount }) => editorCount === 2,
      30_000,
    );
  } else if (initialEditorCount !== 2) {
    throw new Error(`Unexpected initial Window count: ${initialEditorCount}`);
  }
  const secondEditor = await findElement(
    value.sessionId,
    ".editor-window:nth-child(2) .memoka-editor",
  );
  const secondMode = await execute(
    value.sessionId,
    `return document.querySelector('.editor-window:nth-child(2)')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
  );
  if (secondMode !== "INSERT") {
    await sendKeys(value.sessionId, secondEditor, "i");
  }
  await waitFor(
    value.sessionId,
    `return document.querySelector('.editor-window:nth-child(2)')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
    (mode) => mode === "INSERT",
    30_000,
  );
  return value.sessionId;
}

async function closeSession(sessionId) {
  await request(`/session/${sessionId}`, { method: "DELETE" });
}

async function findElement(sessionId, selector) {
  const found = await request(`/session/${sessionId}/element`, {
    method: "POST",
    body: { using: "css selector", value: selector },
  });
  return found[W3C_ELEMENT];
}

async function waitForElement(sessionId, selector, timeoutMs = 30_000) {
  await waitFor(
    sessionId,
    `return Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    Boolean,
    timeoutMs,
  );
  return findElement(sessionId, selector);
}

async function sendKeys(sessionId, elementId, text) {
  await request(`/session/${sessionId}/element/${elementId}/value`, {
    method: "POST",
    body: { text, value: [...text] },
  });
}

async function clickElement(sessionId, elementId) {
  await request(`/session/${sessionId}/element/${elementId}/click`, {
    method: "POST",
    body: {},
  });
}

async function runApplicationWindowChrome(sessionId) {
  const initial = await waitFor(
    sessionId,
    `return (() => {
       const bar = document.querySelector('.application-tab-bar');
       const controls = document.querySelector('.application-window-controls');
       const minimize = document.querySelector('[aria-label="Memokaを最小化"]');
       const maximize = document.querySelector('[aria-label="Memokaを最大化"]');
       const close = document.querySelector('[aria-label="Memokaを閉じる"]');
       const create = document.querySelector('[aria-label="新しいTabPage"]');
       const drag = document.querySelector('.application-window-drag-region');
       if (!bar || !controls || !minimize || !maximize || !close || !create || !drag) {
         return null;
       }
       const rect = (element) => {
         const value = element.getBoundingClientRect();
         return {
           left: value.left,
           right: value.right,
           top: value.top,
           bottom: value.bottom,
           width: value.width,
           height: value.height
         };
       };
       return {
         bar: rect(bar),
         controls: rect(controls),
         minimize: rect(minimize),
         maximize: rect(maximize),
         close: rect(close),
         create: rect(create),
         drag: rect(drag),
         labels: [...controls.querySelectorAll('button')].map(
           (button) => button.getAttribute('aria-label') ?? ''
         )
       };
     })()`,
    Boolean,
  );
  if (
    initial.labels.join("|") !==
      "Memokaを最小化|Memokaを最大化|Memokaを閉じる" ||
    Math.abs(initial.close.right - initial.bar.right) > 1 ||
    initial.minimize.left - initial.create.right < 91.5 ||
    initial.drag.width < 91.5 ||
    initial.minimize.left >= initial.maximize.left ||
    initial.maximize.left >= initial.close.left
  ) {
    throw new Error(
      `Application window chrome layout is invalid: ${JSON.stringify(initial)}`,
    );
  }

  const initialTabCount = await execute(
    sessionId,
    "return document.querySelectorAll('.application-tab').length",
  );
  const create = await findElement(sessionId, '[aria-label="新しいTabPage"]');
  const addedTabCount = 16;
  for (let index = 0; index < addedTabCount; index += 1) {
    await clickElement(sessionId, create);
  }
  const crowded = await waitFor(
    sessionId,
    `return (() => {
       const tabs = document.querySelectorAll('.application-tab');
       const list = document.querySelector('.application-tab-list');
       const create = document.querySelector('[aria-label="新しいTabPage"]');
       const drag = document.querySelector('.application-window-drag-region');
       const minimize = document.querySelector('[aria-label="Memokaを最小化"]');
       if (
         tabs.length < ${initialTabCount + addedTabCount} ||
         !list || !create || !drag || !minimize
       ) {
         return null;
       }
       const rect = (element) => {
         const value = element.getBoundingClientRect();
         return {
           left: value.left,
           right: value.right,
           width: value.width
         };
       };
       return {
         tabCount: tabs.length,
         tabNumbers: document.querySelectorAll('.application-tab-index').length,
         tabsFit: [...tabs].every((tab) => {
           const tabRect = tab.getBoundingClientRect();
           const listRect = list.getBoundingClientRect();
           return (
             tabRect.width > 0 &&
             tabRect.left >= listRect.left - 0.5 &&
             tabRect.right <= listRect.right + 0.5
           );
         }),
         listClientWidth: list.clientWidth,
         listScrollWidth: list.scrollWidth,
         listScrollLeft: list.scrollLeft,
         create: rect(create),
         drag: rect(drag),
         minimize: rect(minimize)
       };
     })()`,
    Boolean,
  );
  if (
    crowded.tabNumbers !== 0 ||
    !crowded.tabsFit ||
    crowded.listScrollWidth > crowded.listClientWidth + 1 ||
    crowded.listScrollLeft !== 0 ||
    crowded.minimize.left - crowded.create.right < 91.5 ||
    crowded.drag.width < 91.5
  ) {
    throw new Error(
      `Application tabs did not shrink inside the window chrome: ${JSON.stringify(crowded)}`,
    );
  }

  const maximize = await findElement(
    sessionId,
    '[aria-label="Memokaを最大化"]',
  );
  await clickElement(sessionId, maximize);
  const maximized = await waitFor(
    sessionId,
    `return Boolean(document.querySelector('[aria-label="Memokaを元に戻す"]'))`,
    Boolean,
  );
  const restore = await findElement(
    sessionId,
    '[aria-label="Memokaを元に戻す"]',
  );
  await clickElement(sessionId, restore);
  const restored = await waitFor(
    sessionId,
    `return Boolean(document.querySelector('[aria-label="Memokaを最大化"]'))`,
    Boolean,
  );
  return { initial, crowded, maximized, restored };
}

async function sendActiveKey(sessionId, value) {
  await request(`/session/${sessionId}/actions`, {
    method: "POST",
    body: {
      actions: [
        {
          type: "key",
          id: "memoka-active-keyboard",
          actions: [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ],
        },
      ],
    },
  });
  await request(`/session/${sessionId}/actions`, {
    method: "DELETE",
    body: {},
  });
}

async function sendActiveChord(sessionId, modifier, value) {
  await request(`/session/${sessionId}/actions`, {
    method: "POST",
    body: {
      actions: [
        {
          type: "key",
          id: "memoka-active-keyboard",
          actions: [
            { type: "keyDown", value: modifier },
            { type: "keyDown", value },
            { type: "keyUp", value },
            { type: "keyUp", value: modifier },
          ],
        },
      ],
    },
  });
  await request(`/session/${sessionId}/actions`, {
    method: "DELETE",
    body: {},
  });
}

async function focusElement(sessionId, selector) {
  const elementId = await waitForElement(sessionId, selector);
  await clickElement(sessionId, elementId);
  return waitFor(
    sessionId,
    `return document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
    Boolean,
  );
}

async function armOsPasteEventProbe(sessionId) {
  await execute(
    sessionId,
    `const editor = document.querySelector(
       '.editor-window:first-child .memoka-editor'
     );
     window.__MEMOKA_OS_PASTE_EVENT__ = null;
     editor.addEventListener(
       'paste',
       (event) => {
         const types = [...(event.clipboardData?.types ?? [])];
         const data = Object.fromEntries(
           types.map((type) => {
             try {
               return [type, event.clipboardData?.getData(type) ?? ''];
             } catch (error) {
               return [type, String(error)];
             }
           })
         );
         const result = {
           types,
           data,
           defaultPrevented: event.defaultPrevented,
           navigatorRead: {
             state:
               typeof navigator.clipboard?.read === 'function'
                 ? 'pending'
                 : 'unavailable',
             items: [],
             reason: null
           }
         };
         window.__MEMOKA_OS_PASTE_EVENT__ = result;
         if (typeof navigator.clipboard?.read === 'function') {
           navigator.clipboard.read()
             .then(async (items) => {
               const decoded = [];
               for (const item of items) {
                 const itemData = {};
                 for (const type of item.types) {
                   try {
                     itemData[type] =
                       await (await item.getType(type)).text();
                   } catch (error) {
                     itemData[type] = String(error);
                   }
                 }
                 decoded.push({ types: [...item.types], data: itemData });
               }
               result.navigatorRead = {
                 state: 'fulfilled',
                 items: decoded,
                 reason: null
               };
             })
             .catch((error) => {
               result.navigatorRead = {
                 state: 'rejected',
                 items: [],
                 reason: String(error)
               };
             });
         }
         queueMicrotask(() => {
           result.defaultPrevented = event.defaultPrevented;
         });
       },
       { capture: true, once: true }
     );
     return true`,
  );
}

async function inspectNavigatorClipboard(sessionId) {
  await execute(
    sessionId,
    `window.__MEMOKA_NAVIGATOR_CLIPBOARD_READ__ = {
       state: 'pending',
       items: [],
       reason: null
     };
     if (typeof navigator.clipboard?.read !== 'function') {
       window.__MEMOKA_NAVIGATOR_CLIPBOARD_READ__.state = 'unavailable';
       return true;
     }
     navigator.clipboard.read()
       .then(async (items) => {
         const decoded = [];
         for (const item of items) {
           const data = {};
           for (const type of item.types) {
             try {
               data[type] = await (await item.getType(type)).text();
             } catch (error) {
               data[type] = String(error);
             }
           }
           decoded.push({ types: [...item.types], data });
         }
         window.__MEMOKA_NAVIGATOR_CLIPBOARD_READ__ = {
           state: 'fulfilled',
           items: decoded,
           reason: null
         };
       })
       .catch((error) => {
         window.__MEMOKA_NAVIGATOR_CLIPBOARD_READ__ = {
           state: 'rejected',
           items: [],
           reason: String(error)
         };
       });
     return true`,
  );
  return waitFor(
    sessionId,
    "return window.__MEMOKA_NAVIGATOR_CLIPBOARD_READ__",
    (value) => value?.state !== "pending",
    5_000,
  );
}

async function inspectNativePreferredClipboard(sessionId) {
  await execute(
    sessionId,
    `window.__MEMOKA_NATIVE_CLIPBOARD_READ__ = {
       state: 'pending',
       value: null,
       reason: null
     };
     const invoke = window.__TAURI_INTERNALS__?.invoke;
     if (typeof invoke !== 'function') {
       window.__MEMOKA_NATIVE_CLIPBOARD_READ__.state = 'unavailable';
       return true;
     }
     invoke('clipboard_read_preferred')
       .then((value) => {
         window.__MEMOKA_NATIVE_CLIPBOARD_READ__ = {
           state: 'fulfilled',
           value,
           reason: null
         };
       })
       .catch((error) => {
         window.__MEMOKA_NATIVE_CLIPBOARD_READ__ = {
           state: 'rejected',
           value: null,
           reason: String(error)
         };
       });
     return true`,
  );
  return waitFor(
    sessionId,
    "return window.__MEMOKA_NATIVE_CLIPBOARD_READ__",
    (value) => value?.state !== "pending",
    10_000,
  );
}

async function runOsClipboardPasteProbes(
  sessionId,
  editorId,
  originalTexts,
  systemClipboard,
) {
  if (systemClipboard.result !== "FOUR_MIME_PASS") {
    return {
      result: "NOT_RUN",
      reason: "rich Wayland Clipboard was not externally observable",
    };
  }
  const internalNavigatorRead = await inspectNavigatorClipboard(sessionId);
  const internalNativeRead = await inspectNativePreferredClipboard(sessionId);
  const currentRevision = () =>
    execute(
      sessionId,
      `return Number(
        document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
          0
      )`,
    );
  const waitForOriginal = (minimumRevision) =>
    waitFor(
      sessionId,
      `return {
         revision: Number(
           document.querySelector('[data-note-revision]')
             ?.dataset.noteRevision ?? 0
         ),
         persistence:
           document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
         modes: [...document.querySelectorAll('.editor-window')].map((editor) => editor.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''),
         text: [...document.querySelectorAll('.memoka-editor')].map(
           (editor) => editor.textContent
         )
       }`,
      (value) =>
        value?.revision > minimumRevision &&
        value.persistence === "ready" &&
        value.modes?.[0] === "NORMAL" &&
        value.text?.length === originalTexts.length &&
        value.text.every((text, index) => text === originalTexts[index]),
      30_000,
    );
  const waitForGestureClipboardRead = () =>
    waitFor(
      sessionId,
      "return window.__MEMOKA_OS_PASTE_EVENT__?.navigatorRead ?? null",
      (value) => value !== null && value.state !== "pending",
      5_000,
    );

  const internalPayload = JSON.parse(
    systemClipboard.content["application/x-memoka-structured-blocks+json"],
  );
  const internalPayloadKind = internalPayload.kind;
  const expectedInternalAction = `clipboard:paste:${internalPayloadKind}:changed`;
  const internalBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "i");
  await armOsPasteEventProbe(sessionId);
  await sendKeys(sessionId, editorId, `${CONTROL}v${NULL_KEY}`);
  const internalPaste = await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       action:
         document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
       pasteEvent: window.__MEMOKA_OS_PASTE_EVENT__,
       text: [...document.querySelectorAll('.memoka-editor')].map(
         (editor) => editor.textContent
       )
    }`,
    (value) =>
      value?.persistence === "ready" &&
      value.action === expectedInternalAction &&
      value.pasteEvent !== null &&
      value.text?.length === originalTexts.length &&
      value.text[0] === value.text[1] &&
      value.text[0] !== originalTexts[0],
    30_000,
  );
  const expectedInternalTextLength =
    originalTexts[0].length + internalPayload.text.length;
  if (internalPaste.text[0].length !== expectedInternalTextLength) {
    throw new Error(
      `Internal Clipboard paste changed text unexpectedly: ${JSON.stringify({
        expectedInternalTextLength,
        internalPaste,
      })}`,
    );
  }
  internalPaste.beforeRevision = internalBeforeRevision;
  internalPaste.gestureNavigatorRead = await waitForGestureClipboardRead();
  const internalTransport =
    internalPaste.action === expectedInternalAction
      ? internalPaste.pasteEvent.data[
          "application/x-memoka-structured-blocks+json"
        ]
        ? "WEBKIT_INTERNAL_MIME_PASS"
        : "TAURI_NATIVE_INTERNAL_MIME_PASS"
      : internalPaste.pasteEvent.data[
            "application/x-memoka-structured-blocks+json"
          ]
        ? "INTERNAL_MIME_NOT_HANDLED"
        : internalPaste.pasteEvent.data["text/html"]
          ? "EMPTY_INTERNAL_MIME_HTML_FALLBACK_PASS"
          : "PLAIN_TEXT_FALLBACK_PASS";
  if (
    !["WEBKIT_INTERNAL_MIME_PASS", "TAURI_NATIVE_INTERNAL_MIME_PASS"].includes(
      internalTransport,
    )
  ) {
    throw new Error(
      `Internal Clipboard MIME did not round-trip structurally: ${JSON.stringify(
        { nativeRead: internalNativeRead, paste: internalPaste },
      )}`,
    );
  }
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "u");
  const internalUndo = await waitForOriginal(internalPaste.revision);

  const internalLinkTarget = "0198f61c-7b2a-7000-8000-000000000001";
  const markdown = [
    "# OS Markdown",
    "",
    `Visual paragraph [[${internalLinkTarget}|内部リンク]]`,
    "",
    "- parent",
    "  - child",
    "",
    "3. numbered",
    "4. next",
    "",
    "| key | value |",
    "| :--- | ---: |",
    "| alpha | 1 |",
    "",
    "```ts",
    "const n = 1;",
    "```",
  ].join("\n");
  const markdownWrite = await writeWaylandClipboard("text/markdown", markdown);
  if (markdownWrite.result !== "WRITTEN") {
    throw new Error(
      `Cannot stage Wayland Markdown paste: ${JSON.stringify(markdownWrite)}`,
    );
  }
  const markdownNavigatorRead = await inspectNavigatorClipboard(sessionId);
  const markdownBeforeRevision = await currentRevision();
  const navigatorClipboardCapabilities = await execute(
    sessionId,
    `return {
       read: typeof navigator.clipboard?.read,
       readText: typeof navigator.clipboard?.readText,
       write: typeof navigator.clipboard?.write,
       writeText: typeof navigator.clipboard?.writeText,
       clipboardItemSupports:
         typeof globalThis.ClipboardItem?.supports
     }`,
  );
  await sendKeys(sessionId, editorId, "i");
  await sendKeys(sessionId, editorId, `${CONTROL}a${NULL_KEY}`);
  await armOsPasteEventProbe(sessionId);
  await sendKeys(sessionId, editorId, `${CONTROL}v${NULL_KEY}`);
  const markdownPaste = await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       action:
         document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
       pasteEvent: window.__MEMOKA_OS_PASTE_EVENT__,
       structures: [...document.querySelectorAll('.memoka-editor')].map(
         (editor) => ({
           sectionHeaders: editor.querySelectorAll(
             '[data-section-header]'
           ).length,
           bulletLists: editor.querySelectorAll('ul').length,
           orderedLists: editor.querySelectorAll('ol').length,
           nestedLists: editor.querySelectorAll('ul ul').length,
           tables: editor.querySelectorAll('table').length,
           tableRows: editor.querySelectorAll('table tr').length,
           codeBlocks: editor.querySelectorAll(
             '[data-section-body] > [data-body-chunk] > pre'
           ).length,
           internalSectionLinks: editor.querySelectorAll(
             '[data-internal-section-id]'
           ).length,
           paragraphs: editor.querySelectorAll(
             '[data-section-body] > [data-body-chunk] > p'
           ).length,
           html: editor.innerHTML,
           text: editor.textContent
         })
       )
     }`,
    (value) =>
      value?.revision > markdownBeforeRevision &&
      value.persistence === "ready" &&
      value.action === "clipboard:paste:markdown:changed" &&
      value.pasteEvent !== null &&
      value.structures?.length === 2 &&
      value.structures.every(
        (structure) =>
          structure.sectionHeaders === 1 &&
          structure.paragraphs === 1 &&
          structure.bulletLists === 2 &&
          structure.orderedLists === 1 &&
          structure.nestedLists === 1 &&
          structure.tables === 1 &&
          structure.tableRows === 2 &&
          structure.codeBlocks === 1 &&
          structure.internalSectionLinks === 1,
      ),
    30_000,
  );
  markdownPaste.gestureNavigatorRead = await waitForGestureClipboardRead();
  const markdownWasStructured =
    markdownPaste.action === "clipboard:paste:markdown:changed" &&
    markdownPaste.structures.every(
      (structure) =>
        structure.sectionHeaders === 1 &&
        structure.paragraphs === 1 &&
        structure.bulletLists === 2 &&
        structure.orderedLists === 1 &&
        structure.nestedLists === 1 &&
        structure.tables === 1 &&
        structure.tableRows === 2 &&
        structure.codeBlocks === 1 &&
        structure.internalSectionLinks === 1 &&
        structure.text.includes("OS Markdown") &&
        structure.text.includes("Visual paragraph") &&
        structure.text.includes("parent") &&
        structure.text.includes("child") &&
        structure.text.includes("numbered") &&
        structure.text.includes("next") &&
        structure.text.includes("key") &&
        structure.text.includes("alpha") &&
        structure.text.includes("const n = 1;"),
    );
  const markdownTransport = markdownWasStructured
    ? markdownPaste.pasteEvent.types.includes("text/markdown")
      ? "WEBKIT_MARKDOWN_MIME_PASS"
      : "TAURI_NATIVE_MARKDOWN_MIME_PASS"
    : "UNEXPECTED_MARKDOWN_PASTE";
  if (markdownTransport === "UNEXPECTED_MARKDOWN_PASTE") {
    throw new Error(
      `Unexpected Markdown Clipboard result: ${JSON.stringify({
        navigatorClipboardCapabilities,
        markdownPaste,
      })}`,
    );
  }

  const visualLineStateScript = `const editors = [
    ...document.querySelectorAll('.memoka-editor')
  ];
  const activeEditor = editors[0] ?? null;
  const inactiveEditor = editors[1] ?? null;
  const selected = activeEditor?.querySelector(
    '.memoka-visual-line-selected'
  ) ?? null;
  const selectedRect = selected?.getBoundingClientRect() ?? null;
  const selectedStyle = selected ? getComputedStyle(selected) : null;
  const nativeSelection = window.getSelection();
  return {
    mode:
      document.querySelector('.editor-window:first-child')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
    activeSelectedCount:
      activeEditor?.querySelectorAll('.memoka-visual-line-selected').length ??
      0,
    inactiveSelectedCount:
      inactiveEditor?.querySelectorAll('.memoka-visual-line-selected').length ??
      0,
    tagName: selected?.tagName ?? null,
    kind: selected?.dataset.vimVisualLine ?? null,
    nodeName: selected?.dataset.vimNodeName ?? null,
    blockId: selected?.dataset.blockId ?? null,
    text: selected?.textContent ?? '',
    backgroundColor: selectedStyle?.backgroundColor ?? null,
    boxShadow: selectedStyle?.boxShadow ?? null,
    width: selectedRect?.width ?? null,
    height: selectedRect?.height ?? null,
    nativeSelectionCollapsed: nativeSelection?.isCollapsed ?? null,
    nativeSelectionText: nativeSelection?.toString() ?? ''
  }`;
  const probeVisualLine = async ({
    selector,
    tagName,
    kind,
    text,
    excludedText,
    screenshotName,
  }) => {
    const elementId = await findElement(sessionId, selector);
    await clickElement(sessionId, elementId);
    await sendKeys(sessionId, editorId, ESCAPE);
    await sendKeys(sessionId, editorId, "V");
    const selected = await waitFor(
      sessionId,
      visualLineStateScript,
      (value) =>
        value?.mode === "VISUAL LINE" &&
        value.activeSelectedCount === 1 &&
        value.inactiveSelectedCount === 0 &&
        value.tagName === tagName &&
        value.kind === kind &&
        value.text.includes(text) &&
        (!excludedText || !value.text.includes(excludedText)) &&
        value.backgroundColor === "rgb(41, 61, 84)" &&
        value.boxShadow !== "none" &&
        value.width > 100 &&
        value.height > 0 &&
        value.nativeSelectionCollapsed === true &&
        value.nativeSelectionText === "",
      30_000,
    );
    await sendKeys(sessionId, editorId, "l");
    const afterRight = await waitFor(
      sessionId,
      visualLineStateScript,
      (value) =>
        value?.mode === "VISUAL LINE" &&
        value.activeSelectedCount === 1 &&
        value.inactiveSelectedCount === 0 &&
        value.blockId === selected.blockId &&
        value.tagName === tagName &&
        value.kind === kind &&
        value.nativeSelectionCollapsed === true,
      30_000,
    );
    await screenshot(sessionId, screenshotName);
    await sendKeys(sessionId, editorId, ESCAPE);
    await waitFor(
      sessionId,
      visualLineStateScript,
      (value) =>
        value?.mode === "NORMAL" &&
        value.activeSelectedCount === 0 &&
        value.inactiveSelectedCount === 0,
      30_000,
    );
    return { selected, afterRight };
  };
  const blockVisualLine = {
    heading: await probeVisualLine({
      selector:
        ".editor-window:first-child .memoka-editor [data-section-header]",
      tagName: "HEADER",
      kind: "block",
      text: "OS Markdown",
      screenshotName: "vim-heading-visual-line.png",
    }),
    paragraph: await probeVisualLine({
      selector:
        ".editor-window:first-child .memoka-editor [data-section-body] > [data-body-chunk] > p",
      tagName: "P",
      kind: "block",
      text: "Visual paragraph",
      screenshotName: "vim-paragraph-visual-line.png",
    }),
    listItem: await probeVisualLine({
      selector:
        ".editor-window:first-child .memoka-editor [data-section-body] > [data-body-chunk] > ul > li:first-child > p",
      tagName: "P",
      kind: "list-item",
      text: "parent",
      excludedText: "child",
      screenshotName: "vim-list-item-visual-line.png",
    }),
  };

  const internalLinkId = await findElement(
    sessionId,
    ".editor-window:first-child [data-internal-section-id]",
  );
  await clickElement(sessionId, internalLinkId);
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "$");
  await sendKeys(sessionId, editorId, "a");
  const internalLinkAppend = await waitFor(
    sessionId,
    `const selection = window.getSelection();
     const anchorElement =
       selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
         ? selection.anchorNode
         : selection?.anchorNode?.parentElement;
     return {
       mode:
         document.querySelector('.editor-window:first-child')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
       insideInternalLink:
         anchorElement instanceof Element &&
         anchorElement.closest('[data-internal-section-id]') !== null,
       paragraphText:
         anchorElement instanceof Element
           ? (anchorElement.closest('p')?.textContent ?? null)
           : null
     }`,
    (value) =>
      value?.mode === "INSERT" &&
      value.insideInternalLink === false &&
      value.paragraphText === "Visual paragraph 内部リンク",
    30_000,
  );
  const internalLinkEnterBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, ENTER);
  const internalLinkEnter = await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       structures: [...document.querySelectorAll('.memoka-editor')].map(
         (editor) => {
           const paragraphs = [...editor.querySelectorAll(
             '[data-section-body] > [data-body-chunk] > p'
           )];
           const links = [...editor.querySelectorAll(
             '[data-internal-section-id]'
           )];
           return {
             paragraphTexts: paragraphs.map(
               (paragraph) => paragraph.textContent ?? ''
             ),
             internalLinkCount: links.length,
             targetSectionId:
               links[0]?.getAttribute('data-internal-section-id') ?? null
           };
         }
       )
     }`,
    (value) =>
      value?.revision > internalLinkEnterBeforeRevision &&
      value.persistence === "ready" &&
      value.structures?.length === 2 &&
      value.structures.every(
        (structure) =>
          structure.paragraphTexts.length === 2 &&
          structure.paragraphTexts[0] === "Visual paragraph 内部リンク" &&
          structure.paragraphTexts[1] === "" &&
          structure.internalLinkCount === 1 &&
          structure.targetSectionId === internalLinkTarget,
      ),
    30_000,
  );
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "u");
  const internalLinkUndo = await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       paragraphCounts: [...document.querySelectorAll('.memoka-editor')].map(
         (editor) => editor.querySelectorAll(
           '[data-section-body] > [data-body-chunk] > p'
         ).length
       )
     }`,
    (value) =>
      value?.revision > internalLinkEnter.revision &&
      value.persistence === "ready" &&
      value.paragraphCounts?.length === 2 &&
      value.paragraphCounts.every((count) => count === 1),
    30_000,
  );
  const internalLinkAppendEnter = {
    result: "PASS",
    append: internalLinkAppend,
    enter: internalLinkEnter,
    undo: internalLinkUndo,
  };

  const tableStateScript = `return {
    revision: Number(
      document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
    ),
    persistence:
      document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
    mode:
      document.querySelector('.editor-window:first-child')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
    action:
      document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
    register:
      document.querySelector('.editor-window:first-child')?.dataset.vimRegister ?? '',
    clipboard:
      document.querySelector('.editor-window:first-child')?.dataset
        .clipboardStatus ?? '',
    selectionText: window.getSelection()?.toString() ?? '',
    tables: [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => {
        const windowRect = editor
          .closest('.editor-window')
          ?.getBoundingClientRect();
        const viewport = editor.closest('.editor-viewport');
        const viewportRect = viewport?.getBoundingClientRect();
        const scroll = editor.closest('.editor-scroll');
        const scrollRect = scroll?.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();
        const tableRect = editor.querySelector('table')?.getBoundingClientRect();
        const rows = [...editor.querySelectorAll('table tr')];
        const active = editor.contains(document.activeElement);
        const visibleCaret = active
          ? [...document.querySelectorAll('.memoka-vim-caret')].find(
              (caret) => getComputedStyle(caret).display !== 'none'
            )
          : null;
        const caretRect = visibleCaret?.getBoundingClientRect();
        const caretRow = caretRect
          ? rows.find((row) => {
              const rowRect = row.getBoundingClientRect();
              return (
                caretRect.left >= rowRect.left &&
                caretRect.left <= rowRect.right &&
                caretRect.top >= rowRect.top &&
                caretRect.top < rowRect.bottom
              );
            })
          : null;
        const domSelection = window.getSelection();
        const selectionElement =
          domSelection?.anchorNode?.nodeType === Node.ELEMENT_NODE
            ? domSelection.anchorNode
            : domSelection?.anchorNode?.parentElement;
        return {
          tableCount: editor.querySelectorAll('table').length,
          selectedCellCount: editor.querySelectorAll('.selectedCell').length,
          selectedRowCount: editor.querySelectorAll(
            '.memoka-table-row-selected'
          ).length,
          windowLeft: windowRect?.left ?? null,
          windowRight: windowRect?.right ?? null,
          viewportLeft: viewportRect?.left ?? null,
          viewportRight: viewportRect?.right ?? null,
          viewportClientWidth: viewport?.clientWidth ?? null,
          viewportScrollWidth: viewport?.scrollWidth ?? null,
          scrollLeft: scrollRect?.left ?? null,
          scrollRight: scrollRect?.right ?? null,
          scrollClientWidth: scroll?.clientWidth ?? null,
          scrollWidth: scroll?.scrollWidth ?? null,
          scrollOverflowX: scroll ? getComputedStyle(scroll).overflowX : null,
          editorLeft: editorRect.left,
          editorRight: editorRect.right,
          tableLeft: tableRect?.left ?? null,
          tableRight: tableRect?.right ?? null,
          caretCursor: visibleCaret?.dataset.cursor ?? null,
          caretRowId: caretRow?.dataset.blockId ?? null,
          selectionRowId:
            active && selectionElement instanceof Element
              ? (selectionElement.closest('tr')?.dataset.blockId ?? null)
              : null,
          rowIds: rows.map(
            (row) => row.dataset.blockId ?? ''
          ),
          rowTexts: rows.map(
            (row) => row.textContent ?? ''
          )
        };
      }
    )
  }`;
  const waitForTableRows = (rowCount, minimumRevision, activeRowIndex) =>
    waitFor(
      sessionId,
      tableStateScript,
      (value) =>
        value?.revision > minimumRevision &&
        value.persistence === "ready" &&
        value.tables?.length === 2 &&
        value.tables.every(
          (table) =>
            table.rowIds.length === rowCount &&
            table.rowTexts.length === rowCount,
        ) &&
        (activeRowIndex === undefined ||
          (value.tables[0]?.selectionRowId ===
            value.tables[0]?.rowIds[activeRowIndex] &&
            value.tables[0]?.caretRowId ===
              value.tables[0]?.rowIds[activeRowIndex])),
      30_000,
    );

  const tableBefore = await execute(sessionId, tableStateScript);
  const sourceRowId = tableBefore.tables?.[0]?.rowIds?.[1];
  if (
    !sourceRowId ||
    !tableBefore.tables.every(
      (table) =>
        table.rowIds.length === 2 &&
        table.rowTexts.join("|") === "keyvalue|alpha1",
    )
  ) {
    throw new Error(
      `Table fixture was not ready for Vim operations: ${JSON.stringify(
        tableBefore,
      )}`,
    );
  }
  const tableCellId = await findElement(
    sessionId,
    ".editor-window:first-child table tr:nth-child(2) td:first-child p",
  );
  await clickElement(sessionId, tableCellId);
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "V");
  const tableVisualLine = await waitFor(
    sessionId,
    tableStateScript,
    (value) =>
      value?.mode === "VISUAL LINE" &&
      value.persistence === "ready" &&
      value.tables?.[0]?.selectedCellCount === 0 &&
      value.tables?.[0]?.selectedRowCount === 1 &&
      value.tables?.[1]?.selectedCellCount === 0 &&
      value.tables?.[1]?.selectedRowCount === 0 &&
      value.tables.every(
        (table) =>
          table.rowIds.length === 2 &&
          table.viewportLeft >= table.windowLeft &&
          table.viewportRight <= table.windowRight &&
          table.scrollLeft >= table.windowLeft &&
          table.scrollRight <= table.windowRight &&
          table.scrollOverflowX !== "visible" &&
          table.editorLeft >= table.windowLeft &&
          table.editorRight <= table.windowRight &&
          table.tableLeft >= table.editorLeft &&
          table.tableRight <= table.editorRight,
      ),
    30_000,
  );
  await screenshot(sessionId, "vim-table-visual-line.png");

  await sendKeys(sessionId, editorId, "y");
  const tableClipboard = await waitForWaylandClipboardKind(
    "structure",
    "table-row",
  );
  const tablePayload = JSON.parse(
    tableClipboard.content["application/x-memoka-structured-blocks+json"],
  );
  const tableMarkdown =
    tableClipboard.content["text/markdown"]?.replace(/\r\n/gu, "\n") ?? "";
  if (
    tablePayload.schemaVersion !== 6 ||
    tablePayload.structureKind !== "table-row" ||
    !tableClipboard.content["text/html"]?.startsWith("<table><tbody><tr") ||
    !tableMarkdown.includes("| alpha | 1 |") ||
    !tableMarkdown.includes("| :--- | ---: |") ||
    tableClipboard.content["text/plain"]?.replace(/\r\n/gu, "\n") !==
      tableMarkdown
  ) {
    throw new Error(
      `TableRow Clipboard formats were not structural: ${JSON.stringify(
        tableClipboard,
      )}`,
    );
  }
  const tableYank = await waitFor(
    sessionId,
    tableStateScript,
    (value) =>
      value?.mode === "NORMAL" &&
      value.clipboard === "rich" &&
      value.register.includes("TableRow: alpha 1"),
  );

  const pBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "p");
  const pPut = await waitForTableRows(3, pBeforeRevision, 2);
  if (
    !pPut.tables.every(
      (table) =>
        table.rowIds[1] === sourceRowId &&
        table.rowIds[2] !== sourceRowId &&
        table.rowTexts.join("|") === "keyvalue|alpha1|alpha1",
    ) ||
    pPut.tables[0]?.selectionRowId !== pPut.tables[0]?.rowIds[2] ||
    pPut.tables[0]?.caretRowId !== pPut.tables[0]?.rowIds[2]
  ) {
    throw new Error(
      `TableRow p was not after the row: ${JSON.stringify(pPut)}`,
    );
  }
  await screenshot(sessionId, "vim-table-after-put.png");
  await sendKeys(sessionId, editorId, "u");
  const pUndo = await waitForTableRows(2, pPut.revision, 1);
  if (
    pUndo.tables[0]?.selectionRowId !== sourceRowId ||
    pUndo.tables[0]?.caretRowId !== sourceRowId
  ) {
    throw new Error(
      `TableRow p Undo did not restore the source cursor: ${JSON.stringify(
        pUndo,
      )}`,
    );
  }

  const upperPBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "P");
  const upperPPut = await waitForTableRows(3, upperPBeforeRevision, 1);
  if (
    !upperPPut.tables.every(
      (table) =>
        table.rowIds[1] !== sourceRowId &&
        table.rowIds[2] === sourceRowId &&
        table.rowTexts.join("|") === "keyvalue|alpha1|alpha1",
    ) ||
    upperPPut.tables[0]?.selectionRowId !== upperPPut.tables[0]?.rowIds[1] ||
    upperPPut.tables[0]?.caretRowId !== upperPPut.tables[0]?.rowIds[1]
  ) {
    throw new Error(
      `TableRow P was not before the row: ${JSON.stringify(upperPPut)}`,
    );
  }
  await sendKeys(sessionId, editorId, "u");
  const upperPUndo = await waitForTableRows(2, upperPPut.revision, 1);
  if (
    upperPUndo.tables[0]?.selectionRowId !== sourceRowId ||
    upperPUndo.tables[0]?.caretRowId !== sourceRowId
  ) {
    throw new Error(
      `TableRow P Undo did not restore the source cursor: ${JSON.stringify(
        upperPUndo,
      )}`,
    );
  }

  const osPasteBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "i");
  await armOsPasteEventProbe(sessionId);
  await sendKeys(sessionId, editorId, `${CONTROL}v${NULL_KEY}`);
  const tableOsPaste = await waitFor(
    sessionId,
    `const state = (() => { ${tableStateScript} })();
     return {
       ...state,
       pasteEvent: window.__MEMOKA_OS_PASTE_EVENT__
     }`,
    (value) =>
      value?.revision > osPasteBeforeRevision &&
      value.persistence === "ready" &&
      value.action === "clipboard:paste:structure:changed" &&
      value.pasteEvent !== null &&
      value.tables?.every(
        (table) =>
          table.rowIds.length === 3 &&
          table.rowTexts.join("|") === "keyvalue|alpha1|alpha1",
      ),
    30_000,
  );
  tableOsPaste.gestureNavigatorRead = await waitForGestureClipboardRead();
  const tableOsPasteTransport = tableOsPaste.pasteEvent.types.includes(
    "application/x-memoka-structured-blocks+json",
  )
    ? "WEBKIT_TABLE_ROW_MIME_PASS"
    : "TAURI_NATIVE_TABLE_ROW_MIME_PASS";
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "u");
  const tableOsPasteUndo = await waitForTableRows(2, tableOsPaste.revision);

  const outsideParagraphId = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor [data-section-body] > [data-body-chunk] > p",
  );
  await clickElement(sessionId, outsideParagraphId);
  await sendKeys(sessionId, editorId, ESCAPE);
  const outsidePutBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "p");
  const outsidePut = await waitForTableRows(3, outsidePutBeforeRevision, 0);
  if (
    !outsidePut.tables.every(
      (table) =>
        table.tableCount === 2 &&
        table.rowIds[0] !== sourceRowId &&
        table.rowIds[2] === sourceRowId &&
        table.rowTexts.join("|") === "alpha1|keyvalue|alpha1",
    )
  ) {
    throw new Error(
      `TableRow p outside a Table did not create a new Table: ${JSON.stringify(
        outsidePut,
      )}`,
    );
  }
  await sendKeys(sessionId, editorId, "u");
  const outsidePutUndo = await waitForTableRows(2, outsidePut.revision);
  if (!outsidePutUndo.tables.every((table) => table.tableCount === 1)) {
    throw new Error(
      `TableRow outside-Table put Undo did not remove the new Table: ${JSON.stringify(
        outsidePutUndo,
      )}`,
    );
  }

  const tableRowVim = {
    result: "PASS",
    sourceRowId,
    visualLine: tableVisualLine,
    yank: tableYank,
    clipboard: tableClipboard,
    p: { put: pPut, undo: pUndo },
    upperP: { put: upperPPut, undo: upperPUndo },
    osPaste: {
      transport: tableOsPasteTransport,
      paste: tableOsPaste,
      undo: tableOsPasteUndo,
    },
    outsideTable: {
      put: outsidePut,
      undo: outsidePutUndo,
    },
  };

  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "u");
  const markdownUndo = await waitForOriginal(markdownPaste.revision);

  const plainWrite = await writeWaylandClipboard("text/plain", "# literal");
  if (plainWrite.result !== "WRITTEN") {
    throw new Error(
      `Cannot stage Wayland plain-text paste: ${JSON.stringify(plainWrite)}`,
    );
  }
  const plainBeforeRevision = await currentRevision();
  await sendKeys(sessionId, editorId, "i");
  await sendKeys(sessionId, editorId, `${CONTROL}a${NULL_KEY}`);
  await armOsPasteEventProbe(sessionId);
  await sendKeys(sessionId, editorId, `${CONTROL}v${NULL_KEY}`);
  const plainPaste = await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       action:
         document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
       pasteEvent: window.__MEMOKA_OS_PASTE_EVENT__,
       structures: [...document.querySelectorAll('.memoka-editor')].map(
         (editor) => ({
           sectionHeaders: editor.querySelectorAll(
             '[data-section-header]'
           ).length,
           paragraphs: editor.querySelectorAll(
             '[data-section-body] > [data-body-chunk] > p'
           ).length,
           text: editor.textContent
         })
       )
     }`,
    (value) =>
      value?.revision > plainBeforeRevision &&
      value.persistence === "ready" &&
      value.action === "clipboard:paste:plain:changed" &&
      value.pasteEvent !== null &&
      value.structures?.length === 2 &&
      value.structures.every(
        (structure) =>
          structure.sectionHeaders === 1 && structure.text === "# literal",
      ),
    30_000,
  );
  plainPaste.gestureNavigatorRead = await waitForGestureClipboardRead();
  await sendKeys(sessionId, editorId, ESCAPE);
  await sendKeys(sessionId, editorId, "u");
  const plainUndo = await waitForOriginal(plainPaste.revision);

  return {
    result: "PASS",
    internalRoundTrip: {
      transport: internalTransport,
      source: systemClipboard.content,
      payloadKind: internalPayloadKind,
      navigatorRead: internalNavigatorRead,
      nativeRead: internalNativeRead,
      paste: internalPaste,
      undo: internalUndo,
    },
    externalMarkdown: {
      transport: markdownTransport,
      navigatorClipboardCapabilities,
      navigatorRead: markdownNavigatorRead,
      write: markdownWrite,
      paste: markdownPaste,
      blockVisualLine,
      internalLinkAppendEnter,
      tableRowVim,
      undo: markdownUndo,
    },
    externalPlainText: {
      write: plainWrite,
      paste: plainPaste,
      undo: plainUndo,
    },
  };
}

async function screenshot(sessionId, filename) {
  const encoded = await request(`/session/${sessionId}/screenshot`);
  writeFileSync(
    `${evidenceDirectory}/${filename}`,
    Buffer.from(encoded, "base64"),
  );
}

async function measureHighLoadKeys(sessionId, count) {
  for (let index = 0; index < count; index += 1) {
    await sendActiveKey(sessionId, "z");
    await waitFor(
      sessionId,
      "return window.__MEMOKA_P1_PERF__.timings.length",
      (length) => length >= index + 1,
    );
  }
  return execute(sessionId, "return window.__MEMOKA_P1_PERF__.timings.slice()");
}

async function runHighLoadPerformance(sessionId) {
  const selector = ".editor-window:nth-child(2) .memoka-editor";
  await waitForElement(sessionId, selector);
  const before = await execute(
    sessionId,
    `return {
       noteId: document.querySelector('.memoka-editor')?.dataset.noteId ?? '',
       noteRevision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       modes: [...document.querySelectorAll('.editor-window')].map((editor) => editor.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''),
       viewport: {
         width: innerWidth,
         height: innerHeight,
         devicePixelRatio
       },
       userAgent: navigator.userAgent,
       platform: navigator.platform
     }`,
  );
  if (before.modes?.[1] !== "INSERT" || before.noteRevision < 1) {
    throw new Error(`High-load editor is not ready: ${JSON.stringify(before)}`);
  }

  // Re-focus after the readiness probe because a persistence snapshot can
  // replace the TipTap view without changing its visible Window or mode.
  await focusElement(sessionId, selector);
  await sendActiveChord(sessionId, CONTROL, "a");
  await execute(
    sessionId,
    `const editor = document.querySelector(${JSON.stringify(selector)});
     const paragraph = 'x'.repeat(${HIGH_LOAD_PARAGRAPH_BYTES});
     const markdown = Array.from(
       { length: ${HIGH_LOAD_PARAGRAPH_COUNT} },
       () => paragraph
     ).join('\\n\\n');
     const result = {
       startedAt: performance.now(),
       completed: false,
       defaultPrevented: false,
       loadMs: null
     };
     window.__MEMOKA_P1_PERF__ = {
       result,
       timings: [],
       observer: null,
       onKeyDown: null
     };
     const observer = new MutationObserver(() => {
       observer.disconnect();
       requestAnimationFrame(() => {
         result.loadMs = performance.now() - result.startedAt;
         result.defaultPrevented = event.defaultPrevented;
         result.completed = true;
       });
     });
     observer.observe(editor, {
       subtree: true,
       childList: true,
       characterData: true
     });
     const event = new Event('paste', {
       bubbles: true,
       cancelable: true
     });
     Object.defineProperty(event, 'clipboardData', {
       value: {
         types: ['text/markdown', 'text/plain'],
         getData: (type) => type === 'text/markdown' ? markdown : markdown
       }
     });
     editor.dispatchEvent(event);
     return true`,
  );
  const fixture = await waitFor(
    sessionId,
    `const perf = window.__MEMOKA_P1_PERF__?.result;
     const editors = [...document.querySelectorAll('.memoka-editor')];
     return {
       completed: perf?.completed ?? false,
       defaultPrevented: perf?.defaultPrevented ?? false,
       loadMs: perf?.loadMs ?? null,
       textBlockCounts: editors.map((editor) => {
         const headers = editor.querySelectorAll('[data-section-header]').length;
         const activeParagraphs = editor.querySelectorAll(
           '[data-section-body] > [data-body-chunk] > p'
         ).length;
         const staticLines = [...editor.querySelectorAll(
           '[data-section-body] > .memoka-body-chunk--static'
         )].reduce(
           (total, chunk) => total + Number.parseInt(
             chunk.style.getPropertyValue('--memoka-body-chunk-rows') || '0',
             10
           ),
           0
         );
         return headers + activeParagraphs + staticLines;
       }),
       textLengths: editors.map((editor) => {
         const activeTextLength = [...editor.querySelectorAll(
           '[data-section-header], [data-section-body] > [data-body-chunk] > p'
         )].reduce((total, block) => total + block.textContent.length, 0);
         const staticTextLength = [...editor.querySelectorAll(
           '[data-section-body] > .memoka-body-chunk--static .memoka-body-chunk__static-content'
         )].reduce(
           (total, preview) => total + preview.textContent.replaceAll('\\n', '').length,
           0
         );
         return activeTextLength + staticTextLength;
       })
     }`,
    (value) =>
      value?.completed === true &&
      value.defaultPrevented === true &&
      value.textBlockCounts?.every(
        (count) => count === HIGH_LOAD_PARAGRAPH_COUNT,
      ) &&
      value.textLengths?.every(
        (length) =>
          length === HIGH_LOAD_PARAGRAPH_BYTES * HIGH_LOAD_PARAGRAPH_COUNT,
      ),
    30_000,
  );
  await waitFor(
    sessionId,
    `return {
       revision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
     }`,
    (value) =>
      value?.revision >= before.noteRevision + 1 &&
      value.persistence === "ready",
    30_000,
  );
  const postPasteStorage = readPersistedHighLoad(before.noteId);

  const wrappedCaretProbe = `const selection = window.getSelection();
    const visibleCarets = [...document.querySelectorAll('.memoka-vim-caret')]
      .filter((caret) => getComputedStyle(caret).display !== 'none');
    const caretRect = visibleCarets[0]?.getBoundingClientRect() ?? null;
    const editorScroll = document.querySelector(
      '.editor-window:nth-child(2) .editor-scroll'
    );
    const selectionRect =
      selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    return {
      mode:
        document.querySelector('.editor-window:nth-child(2)')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
      action:
        document.querySelector('.editor-window:nth-child(2)')?.dataset.vimAction ?? '',
      selectionCollapsed: selection?.isCollapsed ?? false,
      scrollTop: editorScroll?.scrollTop ?? 0,
      caretCount: visibleCarets.length,
      caret: caretRect
        ? {
            cursor: Number(visibleCarets[0].dataset.cursor ?? -1),
            left: caretRect.left,
            top: caretRect.top,
            width: caretRect.width,
            height: caretRect.height
          }
        : null,
      selection: selectionRect
        ? {
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height
          }
        : null
  }`;
  await focusElement(sessionId, selector);
  await sendActiveKey(sessionId, ESCAPE);
  await sendActiveKey(sessionId, "$");
  const wrappedDisplayEnd = await waitFor(
    sessionId,
    wrappedCaretProbe,
    (value) =>
      value?.mode === "NORMAL" &&
      ["motion:line-end:changed", "motion:line-end:boundary"].includes(
        value.action,
      ) &&
      value.selectionCollapsed === true &&
      value.caretCount === 1 &&
      value.caret?.cursor >= 0 &&
      value.selection?.height > 0,
  );
  await sendActiveKey(sessionId, "g");
  await sendActiveKey(sessionId, "k");
  const wrappedDisplayBefore = await waitFor(
    sessionId,
    wrappedCaretProbe,
    (value) =>
      value?.mode === "NORMAL" &&
      value.action === "cursor:display-up:changed" &&
      value.selectionCollapsed === true &&
      value.caretCount === 1 &&
      value.caret?.cursor < wrappedDisplayEnd.caret.cursor &&
      (value.caret.top < wrappedDisplayEnd.caret.top - 2 ||
        value.scrollTop < wrappedDisplayEnd.scrollTop - 2) &&
      Math.abs(value.caret.top - value.selection?.top) <= 1 &&
      Math.abs(value.caret.height - value.selection?.height) <= 1,
  );
  const wrappedLogicalLineGutter = await waitFor(
    sessionId,
    `const root = document.querySelector(
       '.editor-window:nth-child(2) .editor-root'
     );
     const editor = root?.querySelector('.memoka-editor');
     const gutter = root?.querySelector('.memoka-logical-line-gutter');
     const markers = [...(gutter?.querySelectorAll(
       '.memoka-logical-line-number'
     ) ?? [])];
     const current = markers.find((marker) =>
       marker.classList.contains('memoka-logical-line-number--current')
     );
     const sameBlock = current
       ? markers.filter(
           (marker) =>
             marker.dataset.logicalLineBlockPosition ===
             current.dataset.logicalLineBlockPosition
         )
       : [];
     const markerRights = sameBlock.map(
       (marker) => marker.getBoundingClientRect().right
     );
     const markerTops = sameBlock.map(
       (marker) => marker.getBoundingClientRect().top
     );
     const gutterRect = gutter?.getBoundingClientRect() ?? null;
     const editorRect = editor?.getBoundingClientRect() ?? null;
     return {
       markerCount: markers.length,
       currentCount: markers.filter((marker) =>
         marker.classList.contains('memoka-logical-line-number--current')
       ).length,
       currentAbsolute: current?.dataset.logicalLineNumber ?? null,
       currentDisplay: current?.dataset.displayLineNumber ?? null,
       currentText: current?.textContent ?? null,
       currentLineInBlock:
         current?.dataset.logicalLineIndexInBlock ?? null,
       sameBlockRows: sameBlock.length,
       verticallyDistinctRows: new Set(markerTops.map(Math.round)).size,
       rightAligned:
         markerRights.length > 0 &&
         Math.max(...markerRights) - Math.min(...markerRights) <= 1,
       gutterOutsideEditor: Boolean(gutter && editor && !editor.contains(gutter)),
       gutterAlignedLeft: Boolean(
         gutterRect &&
           editorRect &&
           Math.abs(gutterRect.left - editorRect.left) <= 1 &&
           gutterRect.width >= 40
       )
     }`,
    (value) =>
      value?.markerCount >= 1 &&
      value.currentCount === 1 &&
      value.currentAbsolute === value.currentDisplay &&
      value.currentAbsolute === value.currentText &&
      value.currentLineInBlock === "0" &&
      value.sameBlockRows === 1 &&
      value.verticallyDistinctRows === 1 &&
      value.rightAligned === true &&
      value.gutterOutsideEditor === true &&
      value.gutterAlignedLeft === true,
  );
  await sendActiveKey(sessionId, "g");
  await sendActiveKey(sessionId, "j");
  const wrappedDisplayMotion = await waitFor(
    sessionId,
    wrappedCaretProbe,
    (value) =>
      value?.mode === "NORMAL" &&
      value.action === "cursor:display-down:changed" &&
      value.selectionCollapsed === true &&
      value.caretCount === 1 &&
      value.caret?.cursor > wrappedDisplayBefore.caret.cursor &&
      (value.caret.top > wrappedDisplayBefore.caret.top + 2 ||
        value.scrollTop > wrappedDisplayBefore.scrollTop + 2) &&
      Math.abs(value.caret.top - value.selection?.top) <= 1 &&
      Math.abs(value.caret.height - value.selection?.height) <= 1,
  );
  await screenshot(sessionId, "vim-wrapped-gj-caret.png");
  await sendActiveKey(sessionId, "g");
  await sendActiveKey(sessionId, "k");
  const wrappedReturnProbe = `const selection = window.getSelection();
    const editor = document.querySelector(
      '.editor-window:nth-child(2) .memoka-editor'
    );
    const visibleCarets = [...document.querySelectorAll('.memoka-vim-caret')]
      .filter((caret) => getComputedStyle(caret).display !== 'none');
    const caret = visibleCarets[0] ?? null;
    const editorScroll = document.querySelector(
      '.editor-window:nth-child(2) .editor-scroll'
    );
    return {
      mode:
        document.querySelector('.editor-window:nth-child(2)')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
      action:
        document.querySelector('.editor-window:nth-child(2)')?.dataset.vimAction ?? '',
      selectionCollapsed: selection?.isCollapsed ?? false,
      selectionInsideEditor:
        Boolean(selection?.anchorNode && editor?.contains(selection.anchorNode)),
      scrollTop: editorScroll?.scrollTop ?? 0,
      caretCount: visibleCarets.length,
      caret: caret
        ? {
            cursor: Number(caret.dataset.cursor ?? -1),
            left: Number.parseFloat(caret.style.left),
            top: Number.parseFloat(caret.style.top),
            width: Number.parseFloat(caret.style.width),
            height: Number.parseFloat(caret.style.height)
          }
        : null
    }`;
  const wrappedDisplayReturn = await waitFor(
    sessionId,
    wrappedReturnProbe,
    (value) =>
      value?.mode === "NORMAL" &&
      value.action === "cursor:display-up:changed" &&
      value.selectionCollapsed === true &&
      value.selectionInsideEditor === true &&
      value.caretCount === 1 &&
      value.caret?.cursor === wrappedDisplayBefore.caret.cursor &&
      Math.abs(
        value.caret.top +
          value.scrollTop -
          (wrappedDisplayBefore.caret.top + wrappedDisplayBefore.scrollTop),
      ) <= 1 &&
      Math.abs(value.caret.height - wrappedDisplayBefore.caret.height) <= 1,
  );
  await sendActiveKey(sessionId, "i");
  await waitFor(
    sessionId,
    `return document.querySelector('.editor-window:nth-child(2)')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
    (mode) => mode === "INSERT",
  );

  await execute(
    sessionId,
    `const editor = document.querySelector(${JSON.stringify(selector)});
     const perf = window.__MEMOKA_P1_PERF__;
     let startedAt = null;
     perf.timings.length = 0;
     perf.onKeyDown = () => {
       startedAt = performance.now();
     };
     perf.observer = new MutationObserver(() => {
       if (startedAt === null) return;
       const started = startedAt;
       startedAt = null;
       requestAnimationFrame(() => {
         perf.timings.push(performance.now() - started);
       });
     });
     editor.addEventListener('keydown', perf.onKeyDown, true);
     perf.observer.observe(editor, {
       subtree: true,
       childList: true,
       characterData: true
     });
     return true`,
  );
  const warmup = await measureHighLoadKeys(sessionId, HIGH_LOAD_WARMUP_COUNT);
  await execute(
    sessionId,
    "window.__MEMOKA_P1_PERF__.timings.length = 0; return true",
  );
  const samples = await measureHighLoadKeys(sessionId, HIGH_LOAD_SAMPLE_COUNT);
  const expectedRevision =
    before.noteRevision + 1 + HIGH_LOAD_WARMUP_COUNT + HIGH_LOAD_SAMPLE_COUNT;
  const after = await waitFor(
    sessionId,
    `return {
       noteRevision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ??
           0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       textBlockCounts: [...document.querySelectorAll('.memoka-editor')]
         .map((editor) => {
           const activeBlocks = editor.querySelectorAll(
             '[data-section-header], [data-section-body] > [data-body-chunk] > p'
           ).length;
           const staticBlocks = [...editor.querySelectorAll(
             '[data-section-body] > .memoka-body-chunk--static'
           )].reduce(
             (total, chunk) => total + Number.parseInt(
               chunk.style.getPropertyValue('--memoka-body-chunk-rows') || '0',
               10
             ),
             0
           );
           return activeBlocks + staticBlocks;
         }),
       textLengths: [...document.querySelectorAll('.memoka-editor')]
         .map((editor) => {
           const activeTextLength = [...editor.querySelectorAll(
             '[data-section-header], [data-section-body] > [data-body-chunk] > p'
           )].reduce((total, block) => total + block.textContent.length, 0);
           const staticTextLength = [...editor.querySelectorAll(
             '[data-section-body] > .memoka-body-chunk--static .memoka-body-chunk__static-content'
           )].reduce(
             (total, preview) => total + preview.textContent.replaceAll('\\n', '').length,
             0
           );
           return activeTextLength + staticTextLength;
         })
     }`,
    (value) =>
      value?.noteRevision >= expectedRevision && value.persistence === "ready",
    60_000,
  );
  await execute(
    sessionId,
    `const editor = document.querySelector(${JSON.stringify(selector)});
     const perf = window.__MEMOKA_P1_PERF__;
     editor.removeEventListener('keydown', perf.onKeyDown, true);
     perf.observer.disconnect();
     return true`,
  );

  const updatesBeforeMeasuredInput =
    postPasteStorage.incrementalUpdateCount + HIGH_LOAD_WARMUP_COUNT;
  const remaining =
    SNAPSHOT_COMPACTION_THRESHOLD -
    (updatesBeforeMeasuredInput % SNAPSHOT_COMPACTION_THRESHOLD);
  const firstCompactionSample =
    remaining <= HIGH_LOAD_SAMPLE_COUNT ? remaining : null;
  const compactionSamples = [];
  if (firstCompactionSample !== null) {
    for (
      let oneBased = firstCompactionSample;
      oneBased <= HIGH_LOAD_SAMPLE_COUNT;
      oneBased += SNAPSHOT_COMPACTION_THRESHOLD
    ) {
      compactionSamples.push({
        oneBased,
        durationMs: round(samples[oneBased - 1] ?? 0),
      });
    }
  }
  const summary = summarize(samples);
  const compactionSummary = summarize(
    compactionSamples.map(({ durationMs }) => durationMs),
  );
  if (
    samples.length !== HIGH_LOAD_SAMPLE_COUNT ||
    summary.p95_ms > 50 ||
    compactionSamples.length < 2 ||
    compactionSummary.p95_ms > 50 ||
    after.textBlockCounts?.some(
      (count) => count !== HIGH_LOAD_PARAGRAPH_COUNT,
    ) ||
    after.textLengths?.some(
      (length) =>
        length !==
        HIGH_LOAD_PARAGRAPH_BYTES * HIGH_LOAD_PARAGRAPH_COUNT +
          HIGH_LOAD_WARMUP_COUNT +
          HIGH_LOAD_SAMPLE_COUNT,
    )
  ) {
    throw new Error(
      `High-load performance gate failed: ${JSON.stringify({
        fixture,
        summary,
        compactionSummary,
        after,
      })}`,
    );
  }
  const burst = await execute(
    sessionId,
    `return new Promise((resolve) => {
       const editor = document.querySelector(${JSON.stringify(selector)});
       const app = document.querySelector('.app-shell');
       const initialRevision = Number(app?.dataset.noteRevision ?? 0);
       const targetRevision = initialRevision + ${HIGH_LOAD_BURST_SAMPLE_COUNT};
       const frameSamples = [];
       let mutationCount = 0;
       let runtimeSnapshotCount = 0;
       let longTaskCount = 0;
       let lastFrame = performance.now();
       let frame = null;
       const tick = (now) => {
         frameSamples.push(now - lastFrame);
         lastFrame = now;
         if (
           performance.now() - burstStartedAt <=
           ${HIGH_LOAD_BURST_MAX_DRAIN_MS}
         ) {
           frame = requestAnimationFrame(tick);
         }
       };
       const mutationObserver = new MutationObserver((records) => {
         mutationCount += records.length;
         runtimeSnapshotCount += records.filter(
           (record) =>
             record.type === 'attributes' &&
             record.attributeName === 'data-note-revision'
         ).length;
       });
       mutationObserver.observe(document.body, {
         subtree: true,
         childList: true,
         characterData: true,
         attributes: true,
         attributeFilter: ['data-note-revision']
       });
       const longTaskObserver =
         typeof PerformanceObserver === 'function'
           ? new PerformanceObserver((list) => {
               longTaskCount += list.getEntries().length;
             })
           : null;
       try {
         longTaskObserver?.observe({ type: 'longtask', buffered: false });
       } catch {}
       const burstStartedAt = performance.now();
       frame = requestAnimationFrame(tick);
       for (let index = 0; index < ${HIGH_LOAD_BURST_SAMPLE_COUNT}; index += 1) {
         const event = new InputEvent('beforeinput', {
           bubbles: true,
           cancelable: true,
           data: 'q',
           inputType: 'insertText'
         });
         editor.dispatchEvent(event);
         if (!event.defaultPrevented) document.execCommand('insertText', false, 'q');
       }
       const inputDispatchMs = performance.now() - burstStartedAt;
       const poll = () => {
         const revision = Number(app?.dataset.noteRevision ?? 0);
         const persistence = app?.dataset.persistenceState ?? '';
         const drainMs = performance.now() - burstStartedAt;
         if (
           (revision >= targetRevision && persistence === 'ready') ||
           drainMs > ${HIGH_LOAD_BURST_MAX_DRAIN_MS}
         ) {
           if (frame !== null) cancelAnimationFrame(frame);
           mutationObserver.disconnect();
           longTaskObserver?.disconnect();
           resolve({
             sampleCount: ${HIGH_LOAD_BURST_SAMPLE_COUNT},
             initialRevision,
             targetRevision,
             revision,
             persistence,
             inputDispatchMs,
             drainMs,
             mutationCount,
             runtimeSnapshotCount,
             longTaskCount,
             frameSamples
           });
           return;
         }
         setTimeout(poll, 16);
       };
       poll();
     })`,
  );
  burst.frameSummary = summarize(burst.frameSamples);
  delete burst.frameSamples;
  if (
    burst.revision < burst.targetRevision ||
    burst.persistence !== "ready" ||
    burst.drainMs > HIGH_LOAD_BURST_MAX_DRAIN_MS ||
    burst.runtimeSnapshotCount > 4
  ) {
    throw new Error(`High-load burst gate failed: ${JSON.stringify(burst)}`);
  }
  const afterBurst = await execute(
    sessionId,
    `return {
       noteRevision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       textBlockCounts: [...document.querySelectorAll('.memoka-editor')]
         .map((editor) => {
           const activeBlocks = editor.querySelectorAll(
             '[data-section-header], [data-section-body] > [data-body-chunk] > p'
           ).length;
           const staticBlocks = [...editor.querySelectorAll(
             '[data-section-body] > .memoka-body-chunk--static'
           )].reduce(
             (total, chunk) => total + Number.parseInt(
               chunk.style.getPropertyValue('--memoka-body-chunk-rows') || '0',
               10
             ),
             0
           );
           return activeBlocks + staticBlocks;
         }),
       textLengths: [...document.querySelectorAll('.memoka-editor')]
         .map((editor) => {
           const activeTextLength = [...editor.querySelectorAll(
             '[data-section-header], [data-section-body] > [data-body-chunk] > p'
           )].reduce((total, block) => total + block.textContent.length, 0);
           const staticTextLength = [...editor.querySelectorAll(
             '[data-section-body] > .memoka-body-chunk--static .memoka-body-chunk__static-content'
           )].reduce(
             (total, preview) => total + preview.textContent.replaceAll('\\n', '').length,
             0
           );
           return activeTextLength + staticTextLength;
         })
     }`,
  );
  return {
    fixture: {
      paragraphBytes: HIGH_LOAD_PARAGRAPH_BYTES,
      sourceParagraphCount: HIGH_LOAD_PARAGRAPH_COUNT,
      mountedTextBlockCount: HIGH_LOAD_PARAGRAPH_COUNT,
      textBytes: HIGH_LOAD_PARAGRAPH_BYTES * HIGH_LOAD_PARAGRAPH_COUNT,
      viewCount: 2,
      explicitClipboardMime: "text/markdown",
      bulkPasteToNextPaintMs: round(fixture.loadMs),
    },
    warmup: summarize(warmup),
    inputToNextPaint: summary,
    wrappedDisplayMotion: {
      result: "PASS",
      gutter: wrappedLogicalLineGutter,
      end: wrappedDisplayEnd,
      before: wrappedDisplayBefore,
      after: wrappedDisplayMotion,
      returned: wrappedDisplayReturn,
    },
    snapshotCompaction: {
      thresholdUpdates: SNAPSHOT_COMPACTION_THRESHOLD,
      targetP95Ms: 50,
      inputToNextPaint: compactionSummary,
      samples: compactionSamples,
    },
    continuousInputBurst: burst,
    before,
    after: afterBurst,
  };
}

async function runSidebarFocusNavigation(sessionId) {
  const sendWindowCommand = async (element, suffix) => {
    // Keep Control depressed across WebDriver calls. Both Editor and Sidebar
    // normalize supported Ctrl-w Ctrl-{suffix} input to Vim's sequence.
    await sendKeys(sessionId, element, `${CONTROL}w`);
    await sendKeys(sessionId, element, `${suffix}${NULL_KEY}`);
  };
  const focusSnapshot = `return {
     applicationFocus:
       document.querySelector('.app-shell')?.dataset.applicationFocus ?? '',
     activeEditor: Boolean(document.activeElement?.matches?.('.memoka-editor')),
     activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
     activeClass: document.activeElement?.className ?? '',
     activeWindowId:
       document.activeElement?.closest?.('.editor-window')?.dataset.windowId ?? '',
     commandMessage: document.querySelector(
       '.application-commandline--idle span:last-child'
     )?.textContent ?? '',
     windowAction: document.querySelector('.editor-window.focus-surface--focused')?.dataset.vimAction ?? '',
     windowCount: document.querySelectorAll('.editor-window').length,
     notesVisible: Boolean(document.querySelector('[aria-label="ノート一覧"]')),
     outlineVisible: Boolean(document.querySelector(
       '[aria-label="Sectionアウトライン"]'
     )),
     focusedSurfaces: [...document.querySelectorAll(
       '.focus-surface--focused'
     )].map((surface) => surface.dataset.memokaFocusSurface ?? ''),
     events: (window.__MEMOKA_SIDEBAR_FOCUS_KEYS__ ?? []).slice(-24)
   }`;
  const pointerFocusSnapshot = `return {
     activeWindowId:
       document.activeElement?.closest?.('.editor-window')?.dataset.windowId ?? '',
     focusedWindowId:
       document.querySelector('.editor-window.focus-surface--focused')?.dataset.windowId ?? '',
     visibleCarets: [...document.querySelectorAll('.memoka-vim-caret')]
       .filter((caret) => getComputedStyle(caret).display !== 'none')
       .map((caret) => {
         const caretRect = caret.getBoundingClientRect();
         const centerX = (caretRect.left + caretRect.right) / 2;
         const centerY = (caretRect.top + caretRect.bottom) / 2;
         return {
           left: caretRect.left,
           top: caretRect.top,
           windowId: [...document.querySelectorAll('.editor-window')]
             .find((windowRoot) => {
               const rect = windowRoot.getBoundingClientRect();
               return centerX >= rect.left && centerX < rect.right &&
                 centerY >= rect.top && centerY < rect.bottom;
             })?.dataset.windowId ?? ''
         };
       })
   }`;
  await execute(
    sessionId,
    `window.__MEMOKA_SIDEBAR_FOCUS_KEYS__ = [];
     if (!window.__MEMOKA_SIDEBAR_FOCUS_PROBE__) {
       window.__MEMOKA_SIDEBAR_FOCUS_PROBE__ = true;
       for (const type of ['keydown', 'keyup']) {
         for (const capture of [true, false]) {
           window.addEventListener(
             type,
             (event) => {
               window.__MEMOKA_SIDEBAR_FOCUS_KEYS__.push({
                 phase: capture ? 'capture' : 'bubble',
                 type,
                 key: event.key,
                 code: event.code,
                 ctrlKey: event.ctrlKey,
                 isComposing: event.isComposing,
                 defaultPrevented: event.defaultPrevented,
                 targetLabel:
                   event.target?.getAttribute?.('aria-label') ?? '',
                 activeLabel:
                   document.activeElement?.getAttribute('aria-label') ?? '',
                 activeClass: document.activeElement?.className ?? ''
               });
             },
             { capture }
           );
         }
       }
     }
     return true`,
  );

  const secondEditor = await findElement(
    sessionId,
    ".editor-window:nth-child(2) .memoka-editor",
  );
  await clickElement(sessionId, secondEditor);
  await sendActiveKey(sessionId, ESCAPE);
  const firstEditor = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await clickElement(sessionId, firstEditor);
  await sendActiveKey(sessionId, ESCAPE);
  const blankPointerBefore = await waitFor(
    sessionId,
    pointerFocusSnapshot,
    (value) =>
      value?.activeWindowId &&
      value.activeWindowId === value.focusedWindowId &&
      value.visibleCarets?.length === 1 &&
      value.visibleCarets[0]?.windowId === value.activeWindowId,
  );
  await execute(
    sessionId,
    `const editor = document.querySelector(
       '.editor-window:nth-child(2) .memoka-editor'
     );
     const previousEditor = document.querySelector(
       '.editor-window:first-child .memoka-editor'
     );
     const staleCaret = document.createElement('span');
     staleCaret.className = 'memoka-vim-caret';
     staleCaret.dataset.e2eStaleCaret = 'true';
     staleCaret.style.display = 'block';
     document.body.append(staleCaret);
     window.__MEMOKA_BLANK_WINDOW_MOUSEDOWN__ = null;
     window.__MEMOKA_BLANK_WINDOW_FOCUS_BOUNCE__ = null;
     editor?.addEventListener(
       'mousedown',
       () => {
         window.__MEMOKA_BLANK_WINDOW_MOUSEDOWN__ = {
           activeWindowId:
             document.activeElement?.closest?.('.editor-window')?.dataset.windowId ?? '',
           targetWindowId: editor.closest('.editor-window')?.dataset.windowId ?? '',
           visibleCaretCount: [...document.querySelectorAll('.memoka-vim-caret')]
             .filter((caret) => getComputedStyle(caret).display !== 'none').length
         };
       },
       { once: true }
     );
     return true`,
  );
  await clickElement(sessionId, secondEditor);
  const blankPointerDuring = await waitFor(
    sessionId,
    "return window.__MEMOKA_BLANK_WINDOW_MOUSEDOWN__",
    (value) => value !== null,
  );
  if (
    blankPointerDuring.activeWindowId !== blankPointerDuring.targetWindowId ||
    blankPointerDuring.visibleCaretCount !== 0
  ) {
    throw new Error(
      `Blank Window mousedown did not synchronously transfer focus and clear the old caret: ${JSON.stringify(
        blankPointerDuring,
      )}`,
    );
  }
  const blankPointerCommitted = await waitFor(
    sessionId,
    pointerFocusSnapshot,
    (value) =>
      value?.activeWindowId &&
      value.activeWindowId !== blankPointerBefore.activeWindowId &&
      value.activeWindowId === value.focusedWindowId &&
      value.visibleCarets?.length === 1 &&
      value.visibleCarets[0]?.windowId === value.activeWindowId,
  );
  await execute(
    sessionId,
    `const previousEditor = document.querySelector(
       '.editor-window:first-child .memoka-editor'
     );
     previousEditor?.addEventListener(
       'focus',
       () => {
         window.__MEMOKA_BLANK_WINDOW_FOCUS_BOUNCE__ = {
           activeWindowId:
             document.activeElement?.closest?.('.editor-window')?.dataset.windowId ?? '',
           previousWindowId:
             previousEditor?.closest('.editor-window')?.dataset.windowId ?? ''
         };
       },
       { once: true, capture: true }
     );
     previousEditor?.focus({ preventScroll: true });
     return true`,
  );
  const blankPointerBounce = await waitFor(
    sessionId,
    "return window.__MEMOKA_BLANK_WINDOW_FOCUS_BOUNCE__",
    (value) =>
      value?.activeWindowId && value.activeWindowId === value.previousWindowId,
  );
  const blankPointerAfter = await waitFor(
    sessionId,
    pointerFocusSnapshot,
    (value) =>
      value?.activeWindowId &&
      value.activeWindowId !== blankPointerBefore.activeWindowId &&
      value.activeWindowId === value.focusedWindowId &&
      value.visibleCarets?.length === 1 &&
      value.visibleCarets[0]?.windowId === value.activeWindowId,
  );
  await sendActiveKey(sessionId, "i");
  const blankPointerKeyboard = await waitFor(
    sessionId,
    `return {
       activeWindowId:
         document.activeElement?.closest?.('.editor-window')?.dataset.windowId ?? '',
       focusedWindowId:
         document.querySelector('.editor-window.focus-surface--focused')?.dataset.windowId ?? '',
       modes: [...document.querySelectorAll('.editor-window')].map((windowRoot) => ({
         windowId: windowRoot.dataset.windowId ?? '',
         mode: windowRoot.dataset.vimMode ?? ''
       }))
     }`,
    (value) =>
      value?.activeWindowId &&
      value.activeWindowId === value.focusedWindowId &&
      value.modes?.find((mode) => mode.windowId === value.activeWindowId)
        ?.mode === "insert" &&
      value.modes?.find(
        (mode) => mode.windowId === blankPointerBefore.activeWindowId,
      )?.mode === "normal",
  );
  await sendActiveKey(sessionId, ESCAPE);
  await execute(
    sessionId,
    `document.querySelector('[data-e2e-stale-caret]')?.remove(); return true`,
  );

  const notes = await findElement(sessionId, '[aria-label="ノート一覧"]');
  await execute(
    sessionId,
    `const notes = document.querySelector('[aria-label="ノート一覧"]');
     notes?.focus();
     return true`,
  );
  const directCtrlBefore = await execute(
    sessionId,
    `const notes = document.querySelector('[aria-label="ノート一覧"]');
     const selected = notes?.querySelector('[role="option"][aria-selected="true"]');
     return {
       activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
       activeClass: document.activeElement?.className ?? '',
       activeEditor: Boolean(document.activeElement?.matches?.('.memoka-editor')),
       selectedId: selected?.id ?? null,
       events: (window.__MEMOKA_SIDEBAR_FOCUS_KEYS__ ?? []).slice(-12)
     }`,
  );
  await sendKeys(sessionId, notes, `${CONTROL}l${NULL_KEY}`);
  const directCtrlAfter = await execute(
    sessionId,
    `const notes = document.querySelector('[aria-label="ノート一覧"]');
     const selected = notes?.querySelector('[role="option"][aria-selected="true"]');
     return {
       activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
       activeClass: document.activeElement?.className ?? '',
       activeEditor: Boolean(document.activeElement?.matches?.('.memoka-editor')),
       selectedId: selected?.id ?? null,
       events: (window.__MEMOKA_SIDEBAR_FOCUS_KEYS__ ?? []).slice(-12)
     }`,
  );
  if (
    directCtrlAfter.activeLabel !== "ノート一覧" ||
    directCtrlAfter.selectedId !== directCtrlBefore.selectedId
  ) {
    throw new Error(
      `Direct Ctrl-l unexpectedly moved focus or changed NOTES: ${JSON.stringify(
        {
          directCtrlBefore,
          directCtrlAfter,
        },
      )}`,
    );
  }
  await sendWindowCommand(notes, "l");
  const notesToWindow = await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true,
  );

  const moveWindowToSidebar = async (direction, activeLabel) => {
    const steps = [];
    const windowCount = await execute(
      sessionId,
      "return document.querySelectorAll('.editor-window').length",
    );
    for (let index = 0; index <= windowCount; index += 1) {
      const before = await execute(sessionId, focusSnapshot);
      const editor = await findElement(
        sessionId,
        ".memoka-editor.ProseMirror-focused",
      );
      await sendKeys(sessionId, editor, ESCAPE);
      await sendWindowCommand(editor, direction);
      const after = await waitFor(
        sessionId,
        focusSnapshot,
        (value) =>
          value?.activeLabel === activeLabel ||
          (value?.activeEditor &&
            value.activeWindowId &&
            value.activeWindowId !== before.activeWindowId),
      );
      steps.push(after);
      if (after.activeLabel === activeLabel) return steps;
    }
    throw new Error(
      `Window Ctrl-w ${direction} did not focus ${activeLabel}: ${JSON.stringify(
        steps,
      )}`,
    );
  };

  const windowToNotes = await moveWindowToSidebar("h", "ノート一覧");

  await sendKeys(sessionId, notes, ",o");
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeLabel === "Sectionアウトライン" && value.outlineVisible,
  );
  const outline = await findElement(
    sessionId,
    '[aria-label="Sectionアウトライン"]',
  );
  const outlineOverflow = await execute(
    sessionId,
    `return (() => {
       const app = document.querySelector('.app-shell');
       const tabBar = document.querySelector('.application-tab-bar');
       const workspace = document.querySelector('.application-workspace');
       const outline = document.querySelector('.workspace-outline');
       const list = document.querySelector('[aria-label="Sectionアウトライン"]');
       const row = list?.querySelector('[role="treeitem"]');
       const statusline = outline?.querySelector('.utility-statusline');
       const commandline = document.querySelector('.application-commandline');
       if (!app || !tabBar || !workspace || !outline || !list || !row ||
           !statusline || !commandline) return null;
       const clones = [];
       for (let index = 0; index < 96; index += 1) {
         const clone = row.cloneNode(true);
         clone.removeAttribute('id');
         clone.classList.remove('outline-row--selected');
         clone.setAttribute('aria-selected', 'false');
         clone.querySelector('.outline-title').textContent =
           'Overflow fixture ' + String(index + 1);
         list.append(clone);
         clones.push(clone);
       }
       const rect = (element) => {
         const value = element.getBoundingClientRect();
         return {
           top: value.top,
           bottom: value.bottom,
           height: value.height
         };
       };
       const before = {
         viewportHeight: window.innerHeight,
         documentClientHeight: document.documentElement.clientHeight,
         documentScrollHeight: document.documentElement.scrollHeight,
         app: rect(app),
         tabBar: rect(tabBar),
         workspace: rect(workspace),
         outline: rect(outline),
         list: rect(list),
         statusline: rect(statusline),
         commandline: rect(commandline),
         listClientHeight: list.clientHeight,
         listScrollHeight: list.scrollHeight
       };
       list.scrollTop = list.scrollHeight;
       const listScrollTop = list.scrollTop;
       for (const clone of clones) clone.remove();
       list.scrollTop = 0;
       return { ...before, listScrollTop };
     })()`,
  );
  if (
    !outlineOverflow ||
    outlineOverflow.listScrollHeight <= outlineOverflow.listClientHeight ||
    outlineOverflow.listScrollTop <= 0 ||
    outlineOverflow.documentScrollHeight >
      outlineOverflow.documentClientHeight + 1 ||
    outlineOverflow.app.bottom > outlineOverflow.viewportHeight + 1 ||
    outlineOverflow.tabBar.top < -1 ||
    outlineOverflow.tabBar.bottom > outlineOverflow.viewportHeight + 1 ||
    outlineOverflow.list.bottom > outlineOverflow.statusline.top + 1 ||
    outlineOverflow.statusline.bottom > outlineOverflow.workspace.bottom + 1 ||
    outlineOverflow.commandline.bottom > outlineOverflow.viewportHeight + 1
  ) {
    throw new Error(
      `Outline overflow escaped its Sidebar: ${JSON.stringify(outlineOverflow)}`,
    );
  }
  await sendWindowCommand(outline, "h");
  const outlineToWindow = await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true,
  );
  const windowToOutline = await moveWindowToSidebar("l", "Sectionアウトライン");
  await sendKeys(sessionId, outline, ",o");
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true && !value.outlineVisible,
  );

  await execute(
    sessionId,
    `document.querySelector('[aria-label="ノート一覧"]')?.focus(); return true`,
  );
  const sidebarOnlyBefore = await execute(sessionId, focusSnapshot);
  await sendWindowCommand(notes, "o");
  const sidebarOnlyAfter = await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeLabel === "ノート一覧" &&
      value.notesVisible &&
      value.windowCount === sidebarOnlyBefore.windowCount,
  );
  await sendWindowCommand(notes, "c");
  const sidebarClose = await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true && !value.notesVisible,
  );

  let editor = await findElement(
    sessionId,
    ".memoka-editor.ProseMirror-focused",
  );
  await sendKeys(sessionId, editor, `${ESCAPE},n`);
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeLabel === "ノート一覧" && value.notesVisible,
  );
  const reopenedNotes = await findElement(
    sessionId,
    '[aria-label="ノート一覧"]',
  );
  await sendWindowCommand(reopenedNotes, "l");
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true && value.notesVisible,
  );
  editor = await findElement(sessionId, ".memoka-editor.ProseMirror-focused");
  await sendKeys(sessionId, editor, `${ESCAPE},o`);
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeLabel === "Sectionアウトライン" && value.outlineVisible,
  );
  const reopenedOutline = await findElement(
    sessionId,
    '[aria-label="Sectionアウトライン"]',
  );
  await sendWindowCommand(reopenedOutline, "h");
  const beforeWindowOnly = await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeEditor === true &&
      value.windowCount > 1 &&
      value.notesVisible &&
      value.outlineVisible,
  );
  editor = await findElement(sessionId, ".memoka-editor.ProseMirror-focused");
  await sendKeys(sessionId, editor, ESCAPE);
  await sendWindowCommand(editor, "o");
  const afterWindowOnly = await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeEditor === true &&
      value.activeWindowId === beforeWindowOnly.activeWindowId &&
      value.windowCount === 1 &&
      !value.notesVisible &&
      !value.outlineVisible,
  );

  // Restore the two-Window fixture expected by the utility benchmark that
  // continues after this focused probe, then return focus to the kept Window.
  editor = await findElement(sessionId, ".memoka-editor.ProseMirror-focused");
  await sendWindowCommand(editor, "v");
  const splitRestored = await waitFor(
    sessionId,
    focusSnapshot,
    (value) => value?.activeEditor === true && value.windowCount === 2,
  );
  const splitEditor = await findElement(
    sessionId,
    ".memoka-editor.ProseMirror-focused",
  );
  await sendKeys(sessionId, splitEditor, ESCAPE);
  await sendWindowCommand(splitEditor, "h");
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeEditor === true &&
      value.activeWindowId === beforeWindowOnly.activeWindowId &&
      value.windowCount === 2 &&
      !value.notesVisible,
  );
  const restoredEditor = await findElement(
    sessionId,
    ".memoka-editor.ProseMirror-focused",
  );
  await sendKeys(sessionId, restoredEditor, `${ESCAPE},n`);
  await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeLabel === "ノート一覧" && value.notesVisible === true,
  );
  const restoredNotes = await findElement(
    sessionId,
    '[aria-label="ノート一覧"]',
  );
  await sendWindowCommand(restoredNotes, "l");
  const fixtureRestored = await waitFor(
    sessionId,
    focusSnapshot,
    (value) =>
      value?.activeEditor === true &&
      value.activeWindowId === beforeWindowOnly.activeWindowId &&
      value.windowCount === 2 &&
      value.notesVisible,
  );

  const compactFocusSnapshot = (snapshot) => ({
    activeLabel: snapshot.activeLabel,
    activeEditor: snapshot.activeEditor,
    activeWindowId: snapshot.activeWindowId,
    commandMessage: snapshot.commandMessage,
  });
  return {
    result: "TAURI_SIDEBAR_FOCUS_PASS",
    blankWindowPointer: {
      before: blankPointerBefore,
      during: blankPointerDuring,
      committed: blankPointerCommitted,
      bounce: blankPointerBounce,
      after: blankPointerAfter,
      keyboard: blankPointerKeyboard,
    },
    directCtrlAliasDisabled: {
      before: directCtrlBefore,
      after: directCtrlAfter,
    },
    notesToWindow: compactFocusSnapshot(notesToWindow),
    windowToNotes: windowToNotes.map(compactFocusSnapshot),
    outlineToWindow: compactFocusSnapshot(outlineToWindow),
    windowToOutline: windowToOutline.map(compactFocusSnapshot),
    outlineOverflow,
    sidebarWindowCommands: {
      onlyBefore: compactFocusSnapshot(sidebarOnlyBefore),
      onlyAfter: compactFocusSnapshot(sidebarOnlyAfter),
      close: compactFocusSnapshot(sidebarClose),
    },
    windowOnly: {
      before: compactFocusSnapshot(beforeWindowOnly),
      after: compactFocusSnapshot(afterWindowOnly),
      splitRestored: compactFocusSnapshot(splitRestored),
      fixtureRestored: compactFocusSnapshot(fixtureRestored),
    },
  };
}

async function runManagedHelpChrome(sessionId) {
  const openHelp = async () => {
    const editor = await findElement(
      sessionId,
      ".memoka-editor.ProseMirror-focused",
    );
    await sendKeys(sessionId, editor, ESCAPE);
    await sendKeys(sessionId, editor, ":");
    await waitFor(
      sessionId,
      `return Boolean(document.querySelector(
        'input[aria-label="Memoka Command"]'
      ))`,
      (visible) => visible === true,
    );
    const input = await findElement(
      sessionId,
      'input[aria-label="Memoka Command"]',
    );
    await sendKeys(sessionId, input, `help${ENTER}`);
  };
  const chromeSnapshot = `const app = document.querySelector('.app-shell');
    const windowRoot = document.querySelector(
      '.editor-window.focus-surface--focused'
    );
    const editor = windowRoot?.querySelector('.memoka-editor');
    const activeTab = document.querySelector('.application-tab--active');
    return {
      applicationFocus: app?.dataset.applicationFocus ?? '',
      body: editor?.textContent ?? '',
      codeBlocks: editor?.querySelectorAll('pre').length ?? 0,
      debugLine: Boolean(document.querySelector('.debug-line')),
      focusedSurfaces: [...document.querySelectorAll(
        '.focus-surface--focused'
      )].map((surface) => surface.dataset.memokaFocusSurface ?? ''),
      helpMessage: document.querySelector(
        '.application-commandline--idle span:last-child'
      )?.textContent ?? '',
      legacyChrome: Boolean(document.querySelector(
        '.topbar, .persistence-state, .window-label, .sidebar-header, .sidebar-help'
      )),
      lists: editor?.querySelectorAll('ul, ol').length ?? 0,
      mode: windowRoot?.querySelector('.window-mode')?.textContent ?? '',
      noteId: windowRoot?.dataset.noteId ?? '',
      persistence: app?.dataset.persistenceState ?? '',
      tables: editor?.querySelectorAll('table').length ?? 0,
      tabBoxShadow: activeTab ? getComputedStyle(activeTab).boxShadow : '',
      title: windowRoot?.querySelector('.window-title')?.textContent ?? '',
      windowStatus: windowRoot?.querySelector('.window-statusline')?.textContent ?? ''
    }`;

  await openHelp();
  const created = await waitFor(
    sessionId,
    chromeSnapshot,
    (value) =>
      value?.title === "Memoka help" &&
      value.mode === "NORMAL" &&
      value.body.includes("最初に覚える") &&
      value.body.includes("Command-line") &&
      value.tables >= 2 &&
      value.lists >= 2 &&
      value.codeBlocks >= 1 &&
      value.persistence === "ready" &&
      value.focusedSurfaces?.length === 1 &&
      value.focusedSurfaces[0]?.startsWith("window:") &&
      value.applicationFocus === value.focusedSurfaces[0] &&
      value.tabBoxShadow === "none" &&
      value.debugLine === false &&
      value.legacyChrome === false &&
      !value.windowStatus.includes("CLIP") &&
      !value.windowStatus.includes("window-") &&
      value.helpMessage.includes("Memoka helpを作成しました"),
    30_000,
  );

  await openHelp();
  const synchronized = await waitFor(
    sessionId,
    chromeSnapshot,
    (value) =>
      value?.noteId === created.noteId &&
      value.persistence === "ready" &&
      value.helpMessage.includes("Memoka helpを同期しました"),
    30_000,
  );
  return {
    result: "TAURI_MANAGED_HELP_CHROME_PASS",
    created,
    synchronized,
  };
}

async function runUtilityNavigationBenchmark(sessionId, initialNoteId) {
  const sidebarFocusNavigation = await runSidebarFocusNavigation(sessionId);
  const windowNotesBefore = await execute(
    sessionId,
    `return [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.dataset.noteId
    )`,
  );
  const untouchedWindowId = await execute(
    sessionId,
    `return document.querySelectorAll('.editor-window')[1]?.dataset.windowId ?? null`,
  );
  const notes = await findElement(sessionId, '[aria-label="ノート一覧"]');
  await execute(
    sessionId,
    `document.querySelector('[aria-label="ノート一覧"]')?.focus(); return true`,
  );
  await sendKeys(sessionId, notes, "A");
  const titleInput = await findElement(
    sessionId,
    'input[aria-label="ノートタイトル"]',
  );
  await sendKeys(sessionId, titleInput, `Utility target${ENTER}`);
  await waitFor(
    sessionId,
    `return {
       titles: [...document.querySelectorAll('.notes-title')].map(
         (title) => title.textContent ?? ''
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
     }`,
    (value) =>
      value?.titles?.includes("Utility target") &&
      value.persistence === "ready",
    30_000,
  );
  const notesAfterCreate = await findElement(
    sessionId,
    '[aria-label="ノート一覧"]',
  );
  await sendKeys(sessionId, notesAfterCreate, ENTER);
  const created = await waitFor(
    sessionId,
    `return {
       noteId: document.querySelector(
         '.editor-window:first-child .memoka-editor'
       )?.dataset.noteId ?? '',
       titles: [...document.querySelectorAll('.notes-title')].map(
         (title) => title.textContent ?? ''
       ),
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
     }`,
    (value) =>
      value?.noteId &&
      value.noteId !== initialNoteId &&
      value.titles?.includes("Utility target") &&
      value.persistence === "ready",
    30_000,
  );

  const durations = [];
  const total = UTILITY_SWITCH_WARMUP_COUNT + UTILITY_SWITCH_SAMPLE_COUNT;
  for (let index = 0; index < total; index += 1) {
    const targetNoteId = index % 2 === 0 ? initialNoteId : created.noteId;
    const targetTitle = index % 2 === 0 ? "新しいノート" : "Utility target";
    const currentEditor = await findElement(
      sessionId,
      ".editor-window:first-child .memoka-editor",
    );
    await sendKeys(sessionId, currentEditor, ESCAPE);
    await sendKeys(sessionId, currentEditor, ":");
    const commandInput = await waitForElement(
      sessionId,
      'input[aria-label="Memoka Command"]',
    );
    await clickElement(sessionId, commandInput);
    await sendKeys(sessionId, commandInput, "buffers");
    await waitFor(
      sessionId,
      `return document.querySelector('input[aria-label="Memoka Command"]')?.value ?? ''`,
      (value) => value === "buffers",
    );
    await sendKeys(sessionId, commandInput, ENTER);
    const bufferSearchReady = await waitFor(
      sessionId,
      `return {
         available: Boolean(document.querySelector('[data-search-target="buffers"]')),
         message: document.querySelector(
           '.application-commandline--idle span:last-child'
         )?.textContent ?? '',
         activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
         focusedWindowId: document.querySelector(
           '.editor-window.focus-surface--focused'
         )?.dataset.windowId ?? '',
         editorWindowIds: [...document.querySelectorAll('.memoka-editor')].map(
           (editor) => editor.closest('.editor-window')?.dataset.windowId ?? ''
         )
       }`,
      (value) =>
        value?.available ||
        value?.message?.includes(
          "検索対象Windowの現在位置を取得できませんでした",
        ),
    );
    if (!bufferSearchReady.available) {
      throw new Error(
        `Buffer search did not open: ${JSON.stringify(bufferSearchReady)}`,
      );
    }
    const bufferSearch = await waitForElement(
      sessionId,
      '[data-search-target="buffers"] input[aria-label="ワークスペースを検索"]',
    );
    await sendKeys(sessionId, bufferSearch, targetTitle);
    const selected = await waitFor(
      sessionId,
      `return {
         currentNoteId: document.querySelector(
           '.editor-window:first-child .memoka-editor'
         )?.dataset.noteId ?? '',
         count: document.querySelectorAll(
           '[data-search-target="buffers"] [role="option"]'
         ).length,
         selectedTitle: document.querySelector(
           '[data-search-target="buffers"] [aria-selected="true"] .workspace-search-note-title'
         )?.textContent ?? ''
       }`,
      (value) => value?.count === 1 && value.selectedTitle === targetTitle,
    );
    await execute(
      sessionId,
      `const input = document.querySelector(
         '[data-search-target="buffers"] input[aria-label="ワークスペースを検索"]'
       );
       const state = {
         beforeNoteId: ${JSON.stringify(selected.currentNoteId)},
         targetNoteId: ${JSON.stringify(targetNoteId)},
         startedAt: null,
         durationMs: null,
         error: null,
         activeEditor: false,
         persistence: null
       };
       window.__MEMOKA_UTILITY_SWITCH__ = state;
       const onKeyDown = (event) => {
           if (event.key !== 'Enter' && event.code !== 'Enter') return;
           window.removeEventListener('keydown', onKeyDown, true);
           state.startedAt = performance.now();
           const inspect = () => {
             const editor = document.querySelector(
               '.editor-window:first-child .memoka-editor'
             );
             state.activeEditor = Boolean(
               editor && editor.contains(document.activeElement)
             );
             state.persistence =
               document.querySelector('.app-shell')?.dataset.persistenceState ?? '';
             if (
               editor?.dataset.noteId === state.targetNoteId &&
               state.activeEditor &&
               state.persistence === 'ready'
             ) {
               state.durationMs = performance.now() - state.startedAt;
               return;
             }
             if (performance.now() - state.startedAt > 5_000) {
               state.error = 'timed out waiting for warm buffer switch';
               return;
             }
             requestAnimationFrame(inspect);
           };
           requestAnimationFrame(inspect);
         };
       window.addEventListener('keydown', onKeyDown, true);
       return { ...state }`,
    );
    await sendKeys(sessionId, bufferSearch, ENTER);
    const measurement = await waitFor(
      sessionId,
      "return window.__MEMOKA_UTILITY_SWITCH__",
      (value) => typeof value?.durationMs === "number" || value?.error,
      10_000,
    );
    if (measurement.error) throw new Error(measurement.error);
    durations.push(round(measurement.durationMs));
  }

  const warmup = summarize(durations.slice(0, UTILITY_SWITCH_WARMUP_COUNT));
  const measured = summarize(durations.slice(UTILITY_SWITCH_WARMUP_COUNT));
  const beforeJump = await execute(
    sessionId,
    `return document.querySelector(
      '.editor-window:first-child .memoka-editor'
    )?.dataset.noteId ?? ''`,
  );
  const editorBeforeJump = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(sessionId, editorBeforeJump, `${CONTROL}o${NULL_KEY}`);
  const jumpBack = await waitFor(
    sessionId,
    `return {
       noteId: document.querySelector(
         '.editor-window:first-child .memoka-editor'
       )?.dataset.noteId ?? '',
       activeEditor: document.querySelector(
         '.editor-window:first-child .memoka-editor'
       )?.contains(document.activeElement) ?? false
     }`,
    (value) =>
      value?.noteId && value.noteId !== beforeJump && value.activeEditor,
  );
  const windowNotesAfter = await execute(
    sessionId,
    `return [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.dataset.noteId
    )`,
  );
  const visibleSectionCount = 2;
  const outlineEntryCount = 1;
  const outlineEditor = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(sessionId, outlineEditor, "G");
  await sendKeys(sessionId, outlineEditor, "o");
  await sendKeys(
    sessionId,
    outlineEditor,
    `# Section outline target${ENTER}Section body${ESCAPE}`,
  );
  const editorViewportState = `const windowRoot = document.querySelector(
     '.editor-window:first-child'
   );
   const editor = windowRoot?.querySelector('.memoka-editor') ?? null;
   const scroll = windowRoot?.querySelector('.editor-scroll') ?? null;
   const caret = [...document.querySelectorAll('.memoka-vim-caret')]
     .find((candidate) => getComputedStyle(candidate).display !== 'none') ?? null;
   const viewport = scroll?.getBoundingClientRect() ?? null;
   const caretRect = caret?.getBoundingClientRect() ?? null;
   return {
     action: windowRoot?.dataset.vimAction ?? '',
     activeEditor: Boolean(editor?.contains(document.activeElement)),
     focusedWindow: windowRoot?.classList.contains('focus-surface--focused') ?? false,
     caretCursor: caret?.dataset.cursor ?? null,
     caretFullyVisible: Boolean(
       viewport && caretRect &&
       caretRect.top >= viewport.top && caretRect.bottom <= viewport.bottom
     ),
     sectionCount:
       editor?.querySelectorAll('[data-section-header]').length ?? 0,
     sectionTitles: [...(editor?.querySelectorAll('[data-section-header]') ?? [])]
       .map((header) => header.textContent ?? ''),
     noteId: editor?.dataset.noteId ?? '',
     persistence:
       document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
     scrollTop: scroll?.scrollTop ?? 0
   }`;
  const outlineOrigin = await waitFor(
    sessionId,
    editorViewportState,
    (value) =>
      value?.sectionCount === visibleSectionCount &&
      value.sectionTitles?.includes("Section outline target") &&
      value.persistence === "ready" &&
      value.focusedWindow &&
      value.caretFullyVisible,
    30_000,
  );
  await sendKeys(sessionId, outlineEditor, ":");
  const outlineCommand = await waitForElement(
    sessionId,
    'input[aria-label="Memoka Command"]',
  );
  await sendKeys(sessionId, outlineCommand, `outline${ENTER}`);
  const outline = await waitForElement(
    sessionId,
    '[aria-label="Sectionアウトライン"]',
  );
  await waitFor(
    sessionId,
    `return {
       activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
       count: document.querySelectorAll(
         '[aria-label="Sectionアウトライン"] [role="treeitem"]'
       ).length
    }`,
    (value) =>
      value?.activeLabel === "Sectionアウトライン" &&
      value.count === outlineEntryCount,
  );
  await sendKeys(sessionId, outline, ENTER);
  const outlineJump = await waitFor(
    sessionId,
    editorViewportState,
    (value) =>
      value?.activeEditor &&
      value.sectionCount === 1 &&
      value.sectionTitles?.[0] === "Section outline target" &&
      value.caretFullyVisible &&
      value.noteId === outlineOrigin.noteId,
  );
  const focusedSectionEditor = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(sessionId, focusedSectionEditor, `${CONTROL}o${NULL_KEY}`);
  const outlineJumpBack = await waitFor(
    sessionId,
    editorViewportState,
    (value) =>
      value?.action === "jump:back:changed" &&
      value.activeEditor &&
      value.sectionCount === visibleSectionCount &&
      value.caretCursor === outlineOrigin.caretCursor &&
      value.caretFullyVisible,
  );
  const crossTargetNoteId =
    outlineJumpBack.noteId === initialNoteId ? created.noteId : initialNoteId;
  const crossTargetTitle =
    crossTargetNoteId === created.noteId ? "Utility target" : "新しいノート";
  const outlineJumpBackEditor = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(sessionId, outlineJumpBackEditor, ":");
  const crossNoteCommand = await waitForElement(
    sessionId,
    'input[aria-label="Memoka Command"]',
  );
  await clickElement(sessionId, crossNoteCommand);
  await sendKeys(sessionId, crossNoteCommand, "buffers");
  await waitFor(
    sessionId,
    `return document.querySelector('input[aria-label="Memoka Command"]')?.value ?? ''`,
    (value) => value === "buffers",
  );
  await sendKeys(sessionId, crossNoteCommand, ENTER);
  const crossNoteBuffers = await waitForElement(
    sessionId,
    '[data-search-target="buffers"] input[aria-label="ワークスペースを検索"]',
  );
  await sendKeys(sessionId, crossNoteBuffers, crossTargetTitle);
  await waitFor(
    sessionId,
    `return {
       count: document.querySelectorAll(
         '[data-search-target="buffers"] [role="option"]'
       ).length,
       currentNoteId: document.querySelector(
         '.editor-window:first-child .memoka-editor'
       )?.dataset.noteId ?? '',
       selectedTitle: document.querySelector(
         '[data-search-target="buffers"] [aria-selected="true"] .workspace-search-note-title'
       )?.textContent ?? ''
     }`,
    (value) => value?.count === 1 && value.selectedTitle === crossTargetTitle,
  );
  await sendKeys(sessionId, crossNoteBuffers, ENTER);
  const crossNoteOpen = await waitFor(
    sessionId,
    editorViewportState,
    (value) => value?.noteId === crossTargetNoteId && value.activeEditor,
  );
  const crossNoteEditor = await findElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(sessionId, crossNoteEditor, `${CONTROL}o${NULL_KEY}`);
  const crossNoteJumpBack = await waitFor(
    sessionId,
    editorViewportState,
    (value) =>
      value?.action === "jump:back:changed" &&
      value.noteId === outlineJumpBack.noteId &&
      value.activeEditor &&
      value.sectionCount === visibleSectionCount &&
      value.caretCursor === outlineOrigin.caretCursor &&
      value.caretFullyVisible,
  );
  if (
    measured.count !== UTILITY_SWITCH_SAMPLE_COUNT ||
    measured.p95_ms > 50 ||
    windowNotesAfter[1] !== windowNotesBefore[1]
  ) {
    throw new Error(
      `Warm buffer switch gate failed: ${JSON.stringify({
        warmup,
        measured,
        windowNotesBefore,
        windowNotesAfter,
      })}`,
    );
  }
  return {
    targetP95Ms: 50,
    result: "VM_REFERENCE_WARM_BUFFER_SWITCH_PASS",
    fixture: {
      loadedNoteCount: 2,
      targetWindow: "window-1",
      untouchedWindow: untouchedWindowId,
      alternatingNoteIds: [initialNoteId, created.noteId],
      warmupCount: UTILITY_SWITCH_WARMUP_COUNT,
      sampleCount: UTILITY_SWITCH_SAMPLE_COUNT,
    },
    warmup,
    warmBufferSwitch: measured,
    sidebarFocusNavigation,
    jumpBack,
    sectionOutline: {
      visibleSectionCount,
      outlineEntryCount,
      origin: outlineOrigin,
      outlineJump,
      jumpBack: outlineJumpBack,
      crossNoteOpen,
      crossNoteJumpBack,
    },
    windowIsolation: {
      before: windowNotesBefore,
      after: windowNotesAfter,
      unchanged: windowNotesAfter[1] === windowNotesBefore[1],
    },
  };
}

async function runAttachmentLifecycle(sessionId) {
  if (!e2eDataHome) {
    throw new Error("MEMOKA_E2E_DATA_HOME is required");
  }
  const fixtureDirectory = join(e2eDataHome, "memoka-attachment-e2e");
  mkdirSync(fixtureDirectory, { recursive: true });
  const imagePath = join(fixtureDirectory, "pixel.png");
  const documentPath = join(fixtureDirectory, "manual.txt");
  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(documentPath, "Memoka attachment lifecycle\n", "utf8");

  const operationId = "01990000-0000-7000-8000-000000000001";
  const imageId = "01990000-0000-7000-8000-000000000002";
  const documentId = "01990000-0000-7000-8000-000000000003";
  const imported = await invokeTauriCommand(
    sessionId,
    "ATTACHMENT_IMPORT",
    "attachment_import_native_paths",
    {
      request: {
        operationId,
        createdAt: "2026-08-22T00:00:00.000Z",
        items: [
          { attachmentId: imageId, path: imagePath },
          { attachmentId: documentId, path: documentPath },
        ],
      },
    },
  );
  if (
    imported?.operationId !== operationId ||
    imported.attachments?.length !== 2 ||
    imported.attachments[0]?.attachmentId !== imageId ||
    imported.attachments[0]?.previewable !== true ||
    imported.attachments[1]?.attachmentId !== documentId ||
    imported.attachments[1]?.previewable !== false
  ) {
    throw new Error(
      `Native attachment import returned an invalid batch: ${JSON.stringify(imported)}`,
    );
  }

  const resolved = await invokeTauriCommand(
    sessionId,
    "ATTACHMENT_RESOLVE",
    "attachment_resolve",
    { attachmentIds: [imageId, documentId] },
  );
  if (
    resolved?.length !== 2 ||
    resolved.some((attachment) => attachment.available !== true)
  ) {
    throw new Error(
      `Imported attachments were not resolvable: ${JSON.stringify(resolved)}`,
    );
  }

  const editor = await waitForElement(
    sessionId,
    ".editor-window:first-child .memoka-editor",
  );
  await clickElement(sessionId, editor);
  await sendKeys(sessionId, editor, ESCAPE);
  await sendKeys(sessionId, editor, "G");
  await sendKeys(sessionId, editor, "i");
  const beforeRevision = await execute(
    sessionId,
    `return Number(
      document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
    )`,
  );
  const markdown = [
    `![pixel](${`attachment:${imageId}`})`,
    "",
    `[manual.txt](${`attachment:${documentId}`})`,
  ].join("\n");
  const pasteDispatch = await execute(
    sessionId,
    `const editor = document.querySelector(
       '.editor-window:first-child .memoka-editor'
     );
     if (!editor) return { dispatched: false, reason: 'missing editor' };
     editor.focus();
     const clipboardData = {
       types: ['text/markdown'],
       files: [],
       getData(type) {
         return type === 'text/markdown' ? ${JSON.stringify(markdown)} : '';
       }
     };
     const event = new Event('paste', {
       bubbles: true,
       cancelable: true
     });
     Object.defineProperty(event, 'clipboardData', { value: clipboardData });
     return {
       dispatched: true,
       defaultPrevented: !editor.dispatchEvent(event)
     }`,
  );
  if (!pasteDispatch?.dispatched || !pasteDispatch.defaultPrevented) {
    throw new Error(
      `Attachment Markdown paste was not handled: ${JSON.stringify(pasteDispatch)}`,
    );
  }

  const visible = await waitFor(
    sessionId,
    `return (() => {
       const root = document.querySelector('.editor-window:first-child');
       const image = root?.querySelector(
         '.memoka-image-node img[data-attachment-id=${JSON.stringify(imageId)}]'
       );
       const file = root?.querySelector(
         '.memoka-attachment-card[data-attachment-id=${JSON.stringify(documentId)}]'
       );
       return {
         imageAvailable:
           image?.dataset.attachmentState === 'available' &&
           image.complete === true &&
           image.naturalWidth === 1,
         imageAlt: image?.getAttribute('alt') ?? '',
         fileAvailable: file?.dataset.attachmentState === 'available',
         fileText: file?.textContent ?? '',
         sourceOrder:
           Boolean(image && file) &&
           Boolean(image.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING)
       };
     })()`,
    (value) =>
      value?.imageAvailable === true &&
      value.imageAlt === "pixel" &&
      value.fileAvailable === true &&
      value.fileText.includes("manual.txt") &&
      value.sourceOrder === true,
    30_000,
  );
  const attachmentCard = await findElement(
    sessionId,
    `.editor-window:first-child .memoka-attachment-card[data-attachment-id="${documentId}"]`,
  );
  await clickElement(sessionId, attachmentCard);
  await sendKeys(sessionId, editor, ESCAPE);
  await sendKeys(sessionId, editor, "yy");
  await waitFor(
    sessionId,
    `return document.querySelector('.editor-window:first-child')?.dataset
      .clipboardStatus ?? ''`,
    (status) => status === "rich",
  );
  const richFileClipboard = await inspectNativePreferredClipboard(sessionId);
  if (
    richFileClipboard?.state !== "fulfilled" ||
    !richFileClipboard.value?.internal?.includes(documentId) ||
    !richFileClipboard.value?.markdown?.includes(
      `[manual.txt](attachment:${documentId})`,
    ) ||
    richFileClipboard.value?.filePaths?.length !== 1 ||
    !richFileClipboard.value.filePaths[0]?.endsWith("/manual.txt")
  ) {
    throw new Error(
      `Attachment yank did not expose rich and file targets: ${JSON.stringify(richFileClipboard)}`,
    );
  }
  const waylandFileClipboard = inspectWaylandClipboard();
  const portalAvailability = inspectWaylandFileTransferPortal();
  if (waylandFileClipboard.result === "FOUR_MIME_PASS") {
    const requiredFileTypes = ["text/uri-list", "x-special/gnome-copied-files"];
    if (portalAvailability.available) {
      requiredFileTypes.push(
        "application/vnd.portal.filetransfer",
        "application/vnd.portal.files",
      );
    }
    const missingFileTypes = requiredFileTypes.filter(
      (type) => !waylandFileClipboard.availableTypes.includes(type),
    );
    if (missingFileTypes.length > 0) {
      throw new Error(
        `Attachment yank omitted Wayland file targets: ${JSON.stringify({
          missingFileTypes,
          waylandFileClipboard,
        })}`,
      );
    }
    if (
      !waylandFileClipboard.gnomeFileContent?.startsWith("copy\nfile://") ||
      waylandFileClipboard.gnomeFileContent.endsWith("\n") ||
      waylandFileClipboard.gnomeFileContent.split("\n").length !== 2
    ) {
      throw new Error(
        `Attachment yank exposed invalid Nautilus Clipboard data: ${JSON.stringify(
          waylandFileClipboard.gnomeFileContent,
        )}`,
      );
    }
  }
  const portalFileTransfer = portalAvailability.available
    ? retrieveWaylandPortalClipboardFiles()
    : {
        tool: "xdg-desktop-portal FileTransfer",
        result: "NOT_RUN",
        reason: portalAvailability.reason ?? "FileTransfer Portal unavailable",
      };
  if (
    portalFileTransfer.result !== "NOT_RUN" &&
    (portalFileTransfer.result !== "RETRIEVED" ||
      !portalFileTransfer.retrieved.includes("/manual.txt"))
  ) {
    throw new Error(
      `Attachment yank did not resolve through FileTransfer Portal: ${JSON.stringify(portalFileTransfer)}`,
    );
  }
  const committed = await waitFor(
    sessionId,
    `return {
       persistence:
         document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
       noteRevision: Number(
         document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
       )
     }`,
    (value) =>
      value?.persistence === "ready" && value.noteRevision > beforeRevision,
    30_000,
  );
  await sendKeys(sessionId, editor, ESCAPE);
  return {
    operationId,
    attachmentIds: [imageId, documentId],
    imported,
    resolved,
    visible,
    richFileClipboard,
    waylandFileClipboard,
    portalAvailability,
    portalFileTransfer,
    committed,
  };
}

const firstSession = await createSession();
const initial = await execute(
  firstSession,
  `return {
    noteId: document.querySelector('.memoka-editor')?.dataset.noteId,
    text: [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.textContent
    ),
    revisions: [
      document.querySelector('.app-shell')?.dataset.workspaceRevision ?? '',
      document.querySelector('.app-shell')?.dataset.noteRevision ?? ''
    ].join('/')
  }`,
);
const firstEditor = await findElement(
  firstSession,
  ".editor-window:first-child .memoka-editor",
);
await clickElement(firstSession, firstEditor);
await sendActiveKey(firstSession, ESCAPE);
await waitFor(
  firstSession,
  `return document.querySelector('.editor-window:first-child')?.dataset
    .vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
  (value) => value === "NORMAL",
);

if (windowChromeOnly) {
  const windowChrome = await runApplicationWindowChrome(firstSession);
  await screenshot(firstSession, "window-application-window-chrome.png");
  const windowChromeResult = {
    id: "window-application-window-chrome-tauri",
    generatedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    application,
    passed: true,
    windowChrome,
  };
  writeFileSync(
    `${evidenceDirectory}/window-application-window-chrome-tauri.json`,
    `${JSON.stringify(windowChromeResult, null, 2)}\n`,
  );
  await closeSession(firstSession);
  process.stdout.write(`${JSON.stringify(windowChromeResult, null, 2)}\n`);
  process.exit(0);
}

if (sidebarFocusOnly) {
  const sidebarFocusNavigation = await runSidebarFocusNavigation(firstSession);
  const managedHelpChrome = await runManagedHelpChrome(firstSession);
  const sidebarFocusResult = {
    id: "utilities-sidebar-focus-tauri",
    generatedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    application,
    passed: true,
    sidebarFocusNavigation,
    managedHelpChrome,
  };
  writeFileSync(
    `${evidenceDirectory}/utilities-sidebar-focus-tauri.json`,
    `${JSON.stringify(sidebarFocusResult, null, 2)}\n`,
  );
  await closeSession(firstSession);
  process.stdout.write(`${JSON.stringify(sidebarFocusResult, null, 2)}\n`);
  process.exit(0);
}

if (attachmentOnly) {
  const attachmentLifecycle = await runAttachmentLifecycle(firstSession);
  await screenshot(firstSession, "attachment-attachments-before-restart.png");
  await closeSession(firstSession);

  const restartSession = await createSession();
  const [imageId, documentId] = attachmentLifecycle.attachmentIds;
  const restored = await waitFor(
    restartSession,
    `return (() => {
       const root = document.querySelector('.editor-window:first-child');
       const image = root?.querySelector(
         '.memoka-image-node img[data-attachment-id=${JSON.stringify(imageId)}]'
       );
       const file = root?.querySelector(
         '.memoka-attachment-card[data-attachment-id=${JSON.stringify(documentId)}]'
       );
       return {
         imageAvailable:
           image?.dataset.attachmentState === 'available' &&
           image.complete === true &&
           image.naturalWidth === 1,
         fileAvailable: file?.dataset.attachmentState === 'available',
         fileText: file?.textContent ?? '',
         persistence:
           document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
       };
     })()`,
    (value) =>
      value?.imageAvailable === true &&
      value.fileAvailable === true &&
      value.fileText.includes("manual.txt") &&
      value.persistence === "ready",
    30_000,
  );
  const resolvedAfterRestart = await invokeTauriCommand(
    restartSession,
    "ATTACHMENT_RESOLVE_AFTER_RESTART",
    "attachment_resolve",
    { attachmentIds: attachmentLifecycle.attachmentIds },
  );
  if (
    resolvedAfterRestart?.length !== 2 ||
    resolvedAfterRestart.some((attachment) => attachment.available !== true)
  ) {
    throw new Error(
      `Attachments did not survive restart: ${JSON.stringify(resolvedAfterRestart)}`,
    );
  }
  await screenshot(restartSession, "attachment-attachments-after-restart.png");
  await closeSession(restartSession);
  const attachmentResult = {
    id: "attachment-attachment-tauri",
    generatedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    application,
    passed: true,
    attachmentLifecycle,
    restored,
    resolvedAfterRestart,
  };
  writeFileSync(
    `${evidenceDirectory}/attachment-attachment-tauri.json`,
    `${JSON.stringify(attachmentResult, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(attachmentResult, null, 2)}\n`);
  process.exit(0);
}

const searchOriginEditor = await waitForElement(
  firstSession,
  ".editor-window:first-child .memoka-editor",
);
await sendKeys(firstSession, searchOriginEditor, ",f");
const searchInput = await waitForElement(
  firstSession,
  'input[aria-label="ワークスペースを検索"]',
);
await sendKeys(firstSession, searchInput, "新しい");
const workspaceSearch = await waitFor(
  firstSession,
  `return {
     count:
       document.querySelector('.workspace-search-count')?.textContent ?? '',
     backend:
       document.querySelector('.workspace-search-overlay')?.dataset
         .searchBackend ?? '',
     diagnostic:
       document.querySelector('.workspace-search-overlay')?.dataset
         .searchDiagnostic ?? '',
     options: [...document.querySelectorAll(
       '.workspace-search-row[role="option"]'
     )].map((option) => option.textContent ?? ''),
     title:
       document.querySelector('.workspace-search-note-title')?.textContent ?? '',
     hierarchy:
       document.querySelector('.workspace-search-title-hierarchy')?.textContent ?? '',
     previewDocument:
       document.querySelector('.workspace-search-preview-document') !== null,
     previewHeading:
       document.querySelector('.workspace-search-preview-heading') !== null,
     activeLabel: document.activeElement?.getAttribute('aria-label') ?? ''
   }`,
  (value) =>
    value?.count.includes("1 results") &&
    value.backend === "sqlite-fts" &&
    value.options?.some((option) => option.includes("新しいノート")) &&
    value.title.includes("新しいノート") &&
    value.hierarchy === "/" &&
    value.previewDocument === true &&
    value.previewHeading === false &&
    value.activeLabel === "ワークスペースを検索",
  30_000,
);
await sendKeys(firstSession, searchInput, ESCAPE);
await waitFor(
  firstSession,
  "return document.querySelector('.workspace-search-overlay') === null",
  (closed) => closed === true,
);

if (searchOnly) {
  const bodyQuery = "本文検索試験";
  const bodyEditor = await waitForElement(
    firstSession,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(firstSession, bodyEditor, "G");
  await sendKeys(firstSession, bodyEditor, "i");
  await sendKeys(firstSession, bodyEditor, bodyQuery);
  await waitFor(
    firstSession,
    "return document.querySelector('.memoka-editor')?.textContent ?? ''",
    (text) => text.includes(bodyQuery),
  );
  await waitFor(
    firstSession,
    `return Number(
      document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
    )`,
    (revision) => revision >= 2,
  );
  await sendKeys(firstSession, bodyEditor, ESCAPE);
  await waitFor(
    firstSession,
    `return document.querySelector('.editor-window:first-child')?.dataset
      .vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
    (value) => value === "NORMAL",
  );
  await sendKeys(firstSession, bodyEditor, ",g");
  const bodySearchInput = await waitForElement(
    firstSession,
    'input[aria-label="ワークスペースを検索"]',
  );
  await sendKeys(firstSession, bodySearchInput, bodyQuery);
  const bodySearch = await waitFor(
    firstSession,
    `return {
       scope:
         document.querySelector('.workspace-search-overlay')?.dataset
           .searchScope ?? '',
       backend:
         document.querySelector('.workspace-search-overlay')?.dataset
           .searchBackend ?? '',
       option:
         document.querySelector('.workspace-search-row[role="option"]')
           ?.textContent ?? '',
       optionMatch:
         document.querySelector('.workspace-search-match')?.textContent ?? '',
       lineNumberAfterTitle:
         document.querySelector(
           '.workspace-search-row .workspace-search-note-title'
         )?.nextElementSibling?.classList.contains(
           'workspace-search-line-number'
         ) ?? false,
       previewMatch:
         document.querySelector('.workspace-search-preview-match')
           ?.textContent ?? '',
       activeLabel: document.activeElement?.getAttribute('aria-label') ?? ''
     }`,
    (value) =>
      value?.scope === "body" &&
      ["sqlite-fts", "sqlite-fts+crdt"].includes(value.backend) &&
      value.option.includes("L1") &&
      value.lineNumberAfterTitle === true &&
      value.optionMatch === bodyQuery &&
      value.previewMatch === bodyQuery &&
      value.activeLabel === "ワークスペースを検索",
    30_000,
  );
  await sendKeys(firstSession, bodySearchInput, `${CONTROL}c${NULL_KEY}`);
  await waitFor(
    firstSession,
    "return document.querySelector('.workspace-search-overlay') === null",
    (closed) => closed === true,
  );
  const blockEditor = await waitForElement(
    firstSession,
    ".editor-window:first-child .memoka-editor",
  );
  await sendKeys(firstSession, blockEditor, "G");
  await sendKeys(firstSession, blockEditor, "o");
  await sendKeys(firstSession, blockEditor, "/");
  const blockPickerInput = await waitForElement(
    firstSession,
    'input[aria-label="ブロックタイプを検索"]',
  );
  const blockPickerOpened = await waitFor(
    firstSession,
    `return {
       target:
         document.querySelector('.block-type-picker')?.dataset.searchTarget ?? '',
       count:
         document.querySelector('.block-type-picker .workspace-search-count')
           ?.textContent ?? '',
       options: [...document.querySelectorAll(
         '.block-type-picker [role="option"]'
       )].map((option) => option.textContent ?? ''),
       selected:
         document.querySelector(
           '.block-type-picker [role="option"][aria-selected="true"]'
         )?.textContent ?? '',
       blockId: document.querySelector('.block-type-picker')?.dataset.blockId ?? '',
       activeLabel: document.activeElement?.getAttribute('aria-label') ?? ''
     }`,
    (value) =>
      value?.target === "block-type" &&
      value.count === "8 types" &&
      value.options?.length === 8 &&
      value.selected.includes("Paragraph") &&
      value.blockId.length > 0 &&
      value.activeLabel === "ブロックタイプを検索",
  );
  const blockTargetSelector = `[data-block-id="${blockPickerOpened.blockId}"]`;
  await sendKeys(firstSession, blockPickerInput, ESCAPE);
  const blockPickerCancelled = await waitFor(
    firstSession,
    `return {
       closed: document.querySelector('.block-type-picker') === null,
       mode:
         document.querySelector('.editor-window:first-child')?.dataset
           .vimMode ?? '',
       paragraph:
         document.querySelector(${JSON.stringify(blockTargetSelector)})
           ?.textContent ?? '',
       activeEditor:
         document.activeElement?.classList.contains('memoka-editor') ?? false
     }`,
    (value) =>
      value?.closed === true &&
      value.mode === "insert" &&
      value.paragraph === "/" &&
      value.activeEditor === true,
  );
  await sendKeys(firstSession, blockEditor, "\uE003/");
  const reopenedBlockPickerInput = await waitForElement(
    firstSession,
    'input[aria-label="ブロックタイプを検索"]',
  );
  await sendKeys(firstSession, reopenedBlockPickerInput, "code");
  await waitFor(
    firstSession,
    `return [...document.querySelectorAll(
       '.block-type-picker [role="option"]'
     )].map((option) => option.textContent ?? '')`,
    (options) => options?.length === 1 && options[0]?.includes("Code Block"),
  );
  await sendKeys(firstSession, reopenedBlockPickerInput, ENTER);
  const blockTransform = await waitFor(
    firstSession,
    `return {
       closed: document.querySelector('.block-type-picker') === null,
       mode:
         document.querySelector('.editor-window:first-child')?.dataset
           .vimMode ?? '',
       targetTag: document.querySelector(${JSON.stringify(
         blockTargetSelector,
       )})?.tagName ?? '',
       activeEditor:
         document.activeElement?.classList.contains('memoka-editor') ?? false
     }`,
    (value) =>
      value?.closed === true &&
      value.mode === "insert" &&
      value.targetTag === "PRE" &&
      value.activeEditor === true,
  );
  await sendKeys(firstSession, blockEditor, ESCAPE);
  await waitFor(
    firstSession,
    `return document.querySelector('.editor-window:first-child')?.dataset
      .vimMode ?? ''`,
    (mode) => mode === "normal",
  );
  await sendKeys(firstSession, blockEditor, "u");
  const blockTransformUndo = await waitFor(
    firstSession,
    `return {
       action:
         document.querySelector('.editor-window:first-child')?.dataset
           .vimAction ?? '',
       targetTag: document.querySelector(${JSON.stringify(
         blockTargetSelector,
       )})?.tagName ?? '',
       targetText: document.querySelector(${JSON.stringify(
         blockTargetSelector,
       )})?.textContent ?? ''
     }`,
    (value) => value?.targetTag === "P" && value.targetText === "/",
  );
  await sendKeys(firstSession, blockEditor, `${CONTROL}r${NULL_KEY}`);
  const blockTransformRedo = await waitFor(
    firstSession,
    `return document.querySelector(${JSON.stringify(
      blockTargetSelector,
    )})?.tagName ?? ''`,
    (tagName) => tagName === "PRE",
  );
  const searchResult = {
    id: "utilities-workspace-search-tauri",
    generatedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceTreeDirtyAtMeasurement:
      execFileSync(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ".",
          ":(exclude)evidence/**",
        ],
        { encoding: "utf8" },
      ).trim().length > 0,
    application,
    passed: true,
    query: "新しい",
    bodyQuery,
    backend: bodySearch.backend,
    workspaceSearch,
    bodySearch,
    blockTypePicker: {
      opened: blockPickerOpened,
      cancelled: blockPickerCancelled,
      transformed: blockTransform,
      undo: blockTransformUndo,
      redoTargetTag: blockTransformRedo,
    },
  };
  writeFileSync(
    `${evidenceDirectory}/utilities-workspace-search-tauri.json`,
    `${JSON.stringify(searchResult, null, 2)}\n`,
  );
  await closeSession(firstSession);
  process.stdout.write(`${JSON.stringify(searchResult, null, 2)}\n`);
  process.exit(0);
}

if (utilitiesOnly) {
  const utilityNavigation = await runUtilityNavigationBenchmark(
    firstSession,
    initial.noteId,
  );
  const utilityResult = {
    id: "utilities-application-utilities-tauri",
    generatedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sourceTreeDirtyAtMeasurement:
      execFileSync(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ".",
          ":(exclude)evidence/**",
        ],
        { encoding: "utf8" },
      ).trim().length > 0,
    application,
    passed: true,
    utilityNavigation,
  };
  writeFileSync(
    `${evidenceDirectory}/utilities-application-utilities-tauri.json`,
    `${JSON.stringify(utilityResult, null, 2)}\n`,
  );
  await closeSession(firstSession);
  process.stdout.write(`${JSON.stringify(utilityResult, null, 2)}\n`);
  process.exit(0);
}

// A Section document starts with the root Header followed by its direct Body.
// Keep this persistence/Vim fixture in the Body instead of rewriting the note
// title, whose text is now the title SSOT.
await sendKeys(firstSession, firstEditor, "G");
await sendKeys(firstSession, firstEditor, "i");
await sendKeys(firstSession, firstEditor, insertedText);
const synchronized = await waitFor(
  firstSession,
  `return [...document.querySelectorAll('.memoka-editor')].map(
    (editor) => editor.textContent
  )`,
  (texts) =>
    Array.isArray(texts) &&
    texts.length === 2 &&
    texts.every((text) => text.includes(insertedText)),
);
const committedRevision = await waitFor(
  firstSession,
  `return Number(
    document.querySelector('[data-note-revision]')?.dataset.noteRevision ?? 0
  )`,
  (revision) => revision >= 2,
);
await screenshot(firstSession, "restart-before-restart.png");
await closeSession(firstSession);

const secondSession = await createSession();
const restored = await waitFor(
  secondSession,
  `return {
    noteId: document.querySelector('.memoka-editor')?.dataset.noteId,
    text: [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.textContent
    ),
    revisions: [
      document.querySelector('.app-shell')?.dataset.workspaceRevision ?? '',
      document.querySelector('.app-shell')?.dataset.noteRevision ?? ''
    ].join('/')
  }`,
  (value) =>
    value?.noteId === initial.noteId &&
    value.text?.length === 2 &&
    value.text.every((text) => text.includes(insertedText)),
  30_000,
);
await screenshot(secondSession, "restart-after-restart.png");

const restoredEditor = await findElement(
  secondSession,
  ".editor-window:first-child .memoka-editor",
);
const fcitxRemote = inspectFcitxRemote();
await sendKeys(secondSession, restoredEditor, ESCAPE);
const normalMode = await waitFor(
  secondSession,
  `return document.querySelector('.editor-window:first-child')?.dataset
    .vimMode?.replace('-', ' ').toUpperCase() ?? ''`,
  (value) => value === "NORMAL",
);
const relativeLogicalLineNumbers = await waitFor(
  secondSession,
  `return [...document.querySelectorAll('.editor-root')].map((root) => {
    const editor = root.querySelector('.memoka-editor');
    const gutter = root.querySelector('.memoka-logical-line-gutter');
    const markers = [...root.querySelectorAll(
      '.memoka-logical-line-number'
    )];
    const current = markers.filter((marker) =>
      marker.classList.contains('memoka-logical-line-number--current')
    );
    const gutterRect = gutter?.getBoundingClientRect() ?? null;
    const editorRect = editor?.getBoundingClientRect() ?? null;
    return {
      count: markers.length,
      currentCount: current.length,
      currentRelative: current[0]?.dataset.relativeLineNumber ?? null,
      currentAbsolute: current[0]?.dataset.logicalLineNumber ?? null,
      currentDisplay: current[0]?.dataset.displayLineNumber ?? null,
      currentText: current[0]?.textContent ?? null,
      gutterOutsideEditor: Boolean(gutter && editor && !editor.contains(gutter)),
      markerInsideGutter: Boolean(current[0] && gutter?.contains(current[0])),
      gutterAlignedLeft: Boolean(
        gutterRect &&
          editorRect &&
          Math.abs(gutterRect.left - editorRect.left) <= 1 &&
          gutterRect.width >= 40
      ),
      text: editor?.textContent ?? ''
    };
  })`,
  (value) =>
    value?.length === restored.text.length &&
    value.every(
      (editor, index) =>
        editor.count > 0 &&
        editor.currentCount === 1 &&
        editor.currentRelative === "0" &&
        editor.currentDisplay === editor.currentAbsolute &&
        editor.currentText === editor.currentAbsolute &&
        editor.gutterOutsideEditor === true &&
        editor.markerInsideGutter === true &&
        editor.gutterAlignedLeft === true &&
        editor.text === restored.text[index],
    ),
);
const imeOff = await waitFor(
  secondSession,
  `return {
    statuses: [...document.querySelectorAll('[data-ime-off-status]')]
      .map((status) => status.dataset.imeOffStatus ?? ''),
    details: [...document.querySelectorAll('[data-ime-off-status]')]
      .map((status) => status.dataset.imeOffDetail ?? '')
  }`,
  (value) =>
    value?.statuses?.length === 2 &&
    !["idle", "requesting"].includes(value.statuses[0]) &&
    value.statuses[1] === "idle",
);
if (fcitxRemote.expected && imeOff.statuses[0] !== "inactive") {
  throw new Error(
    `Fcitx IME OFF request failed: ${JSON.stringify({
      fcitxRemote,
      imeOff,
    })}`,
  );
}
const wordCursorProbe = `const editor = document.querySelector(
    '.editor-window:first-child .memoka-editor'
  );
  const selection = window.getSelection();
  let offset = null;
  if (
    editor &&
    selection?.rangeCount &&
    selection.anchorNode &&
    editor.contains(selection.anchorNode)
  ) {
    const anchorElement =
      selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
    const textblock = anchorElement?.closest(
      'p, h1, h2, h3, h4, h5, h6, pre'
    );
    const prefix = document.createRange();
    prefix.selectNodeContents(textblock ?? editor);
    prefix.setEnd(selection.anchorNode, selection.anchorOffset);
    offset = prefix.toString().length;
  }
  return {
    mode:
      document.querySelector('.editor-window:first-child')?.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? '',
    action:
      document.querySelector('.editor-window:first-child')?.dataset.vimAction ?? '',
    offset
  }`;
await sendKeys(secondSession, restoredEditor, "0");
await sendKeys(secondSession, restoredEditor, "3");
const pendingCount = await waitFor(
  secondSession,
  wordCursorProbe,
  (value) =>
    value?.mode === "NORMAL" &&
    value.action === "pending:count:3" &&
    value.offset === wordRunStarts[0],
);
await sendKeys(secondSession, restoredEditor, "w");
const countedWordForward = await waitFor(
  secondSession,
  wordCursorProbe,
  (value) =>
    value?.mode === "NORMAL" &&
    value.action === "motion:word-forward:count:3:changed" &&
    value.offset === wordRunStarts[3],
);
await sendKeys(secondSession, restoredEditor, "0");
const japaneseWordForward = [];
for (const expectedOffset of wordRunStarts.slice(1)) {
  await sendKeys(secondSession, restoredEditor, "w");
  japaneseWordForward.push(
    await waitFor(
      secondSession,
      wordCursorProbe,
      (value) =>
        value?.mode === "NORMAL" &&
        value.action === "motion:word-forward:changed" &&
        value.offset === expectedOffset,
    ),
  );
}
const japaneseWordBackward = [];
for (const expectedOffset of wordRunStarts.slice(0, -1).reverse()) {
  await sendKeys(secondSession, restoredEditor, "b");
  japaneseWordBackward.push(
    await waitFor(
      secondSession,
      wordCursorProbe,
      (value) =>
        value?.mode === "NORMAL" &&
        value.action === "motion:word-backward:changed" &&
        value.offset === expectedOffset,
    ),
  );
}
await sendKeys(secondSession, restoredEditor, "$");
await waitFor(
  secondSession,
  wordCursorProbe,
  (value) =>
    value?.mode === "NORMAL" && value.offset === insertedText.length - 1,
);
const japaneseWordMotion = {
  result: "PASS",
  fixture: wordMotionFixture,
  runStarts: wordRunStarts,
  pendingCount,
  countedForward: countedWordForward,
  forward: japaneseWordForward,
  backward: japaneseWordBackward,
};
await sendKeys(secondSession, restoredEditor, "v");
const visualCharInitial = await waitFor(
  secondSession,
  `return {
    mode: document.querySelector('.editor-window:first-child')?.dataset
      .vimMode?.replace('-', ' ').toUpperCase() ?? '',
    selectionText: window.getSelection()?.toString() ?? '',
    caretCursor: Number(
      document.querySelector(
        '.memoka-vim-caret[data-mode="visual-char"]'
      )?.dataset.cursor ?? -1
    )
  }`,
  (value) =>
    value?.mode === "VISUAL CHAR" &&
    Array.from(value.selectionText ?? "").length === 1 &&
    value.caretCursor >= 0,
);
await sendKeys(secondSession, restoredEditor, "h");
const visualCharAfterLeft = await waitFor(
  secondSession,
  `return {
    mode: document.querySelector('.editor-window:first-child')?.dataset
      .vimMode?.replace('-', ' ').toUpperCase() ?? '',
    selectionText: window.getSelection()?.toString() ?? '',
    caretCursor: Number(
      document.querySelector(
        '.memoka-vim-caret[data-mode="visual-char"]'
      )?.dataset.cursor ?? -1
    )
  }`,
  (value) =>
    value?.mode === "VISUAL CHAR" &&
    Array.from(value.selectionText ?? "").length === 2 &&
    value.caretCursor === visualCharInitial.caretCursor - 1,
);
await sendKeys(secondSession, restoredEditor, "y");
const clipboardWrite = await waitFor(
  secondSession,
  `return {
    mode: document.querySelector('.editor-window:first-child')?.dataset
      .vimMode?.replace('-', ' ').toUpperCase() ?? '',
    statuses: [...document.querySelectorAll('[data-clipboard-status]')]
      .map((status) => status.dataset.clipboardStatus ?? '')
  }`,
  (value) =>
    value?.mode === "NORMAL" &&
    ["rich", "plain-text", "unavailable"].includes(value.statuses?.[0]) &&
    value.statuses?.[1] === "idle",
);
await sendKeys(secondSession, restoredEditor, "P");
const afterPut = await waitFor(
  secondSession,
  `return [...document.querySelectorAll('.memoka-editor')].map(
    (editor) => editor.textContent
  )`,
  (texts) =>
    Array.isArray(texts) &&
    texts.length === 2 &&
    texts[0] === texts[1] &&
    texts[0] !== restored.text[0],
);
await sendKeys(secondSession, restoredEditor, "u");
const afterUndo = await waitFor(
  secondSession,
  `return {
    modes: [...document.querySelectorAll('.editor-window')]
      .map((editor) =>
        editor.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''
      ),
    text: [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.textContent
    ),
    caret: [...document.querySelectorAll('.memoka-vim-caret')]
      .find((caret) => getComputedStyle(caret).display !== 'none')?.dataset
      .cursor ?? null
  }`,
  (value) =>
    value?.modes?.[0] === "NORMAL" &&
    value.text?.length === 2 &&
    value.text.every((text) => text === restored.text[0]),
);
await sendKeys(secondSession, restoredEditor, "V");
await sendKeys(secondSession, restoredEditor, "y");
const structuralClipboardWrite = await waitFor(
  secondSession,
  `return {
    mode: document.querySelector('.editor-window:first-child')?.dataset
      .vimMode?.replace('-', ' ').toUpperCase() ?? '',
    status: document.querySelector('.editor-window:first-child')?.dataset
      .clipboardStatus ?? ''
  }`,
  (value) =>
    value?.mode === "NORMAL" &&
    ["rich", "plain-text", "unavailable"].includes(value.status),
);
const structuralClipboardVisibility = await waitFor(
  secondSession,
  `const windowRoot = document.querySelector('.editor-window:first-child');
   const statusline = windowRoot?.querySelector('.window-statusline');
   return windowRoot
     ? {
         status: windowRoot.dataset.clipboardStatus ?? '',
         statuslineText: statusline?.textContent ?? ''
       }
     : null`,
  (value) =>
    ["rich", "plain-text", "unavailable"].includes(value?.status) &&
    !value.statuslineText.includes("CLIP"),
);
const systemClipboard = await waitForWaylandClipboardKind("structure");
if (systemClipboard.result === "MIME_MISMATCH") {
  throw new Error(
    `System Clipboard MIME gate failed: ${JSON.stringify(systemClipboard)}`,
  );
}
const osClipboardPaste = await runOsClipboardPasteProbes(
  secondSession,
  restoredEditor,
  restored.text,
  systemClipboard,
);
const vimCommitted = await waitFor(
  secondSession,
  `return {
    persistence: document.querySelector('.app-shell')?.dataset.persistenceState ?? '',
    revisions: [
      document.querySelector('.app-shell')?.dataset.workspaceRevision ?? '',
      document.querySelector('.app-shell')?.dataset.noteRevision ?? ''
    ].join('/')
  }`,
  (value) => value?.persistence === "ready",
);
await screenshot(secondSession, "vim-vim-after-undo.png");
await closeSession(secondSession);

const thirdSession = await createSession();
const vimRestored = await waitFor(
  thirdSession,
  `return {
    modes: [...document.querySelectorAll('.editor-window')]
      .map((editor) =>
        editor.dataset.vimMode?.replace('-', ' ').toUpperCase() ?? ''
      ),
    text: [...document.querySelectorAll('.memoka-editor')].map(
      (editor) => editor.textContent
    ),
    persistence: document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
  }`,
  (value) =>
    value?.modes?.[0] === "NORMAL" &&
    value.text?.length === 2 &&
    value.text.every((text) => text === restored.text[0]) &&
    value.persistence === "ready",
  30_000,
);
await screenshot(thirdSession, "vim-vim-after-restart.png");
const highLoad = await runHighLoadPerformance(thirdSession);
await screenshot(thirdSession, "vim-high-load.png");
await closeSession(thirdSession);
const compactionSamples = highLoad.snapshotCompaction.samples;
const lastCompactionSample = compactionSamples.at(-1)?.oneBased;
if (compactionSamples.length < 2 || lastCompactionSample === undefined) {
  throw new Error("High-load input did not cross the compaction boundary");
}
const highLoadStorage = inspectPersistedHighLoad(highLoad.before.noteId, {
  revision: highLoad.after.noteRevision,
  snapshotRevision:
    highLoad.before.noteRevision +
    1 +
    HIGH_LOAD_WARMUP_COUNT +
    lastCompactionSample,
  incrementalUpdateCount:
    HIGH_LOAD_SAMPLE_COUNT -
    lastCompactionSample +
    HIGH_LOAD_BURST_SAMPLE_COUNT,
});

const highLoadRestartStartedAt = performance.now();
const fourthSession = await createSession();
const highLoadRestored = await waitFor(
  fourthSession,
  `return {
    textBlockCounts: [...document.querySelectorAll('.memoka-editor')]
      .map((editor) => {
        const activeBlocks = editor.querySelectorAll(
          '[data-section-header], [data-section-body] > [data-body-chunk] > p'
        ).length;
        const staticBlocks = [...editor.querySelectorAll(
          '[data-section-body] > .memoka-body-chunk--static'
        )].reduce(
          (total, chunk) => total + Number.parseInt(
            chunk.style.getPropertyValue('--memoka-body-chunk-rows') || '0',
            10
          ),
          0
        );
        return activeBlocks + staticBlocks;
      }),
    textLengths: [...document.querySelectorAll('.memoka-editor')]
      .map((editor) => {
        const activeTextLength = [...editor.querySelectorAll(
          '[data-section-header], [data-section-body] > [data-body-chunk] > p'
        )].reduce((total, block) => total + block.textContent.length, 0);
        const staticTextLength = [...editor.querySelectorAll(
          '[data-section-body] > .memoka-body-chunk--static .memoka-body-chunk__static-content'
        )].reduce(
          (total, preview) => total + preview.textContent.replaceAll('\\n', '').length,
          0
        );
        return activeTextLength + staticTextLength;
      }),
    persistence:
      document.querySelector('.app-shell')?.dataset.persistenceState ?? ''
  }`,
  (value) =>
    value?.textBlockCounts?.every(
      (count) => count === HIGH_LOAD_PARAGRAPH_COUNT,
    ) &&
    value.textLengths?.every(
      (length) =>
        length ===
        HIGH_LOAD_PARAGRAPH_BYTES * HIGH_LOAD_PARAGRAPH_COUNT +
          HIGH_LOAD_WARMUP_COUNT +
          HIGH_LOAD_SAMPLE_COUNT +
          HIGH_LOAD_BURST_SAMPLE_COUNT,
    ) &&
    value.persistence === "ready",
  30_000,
);
const highLoadRestartToReadyMs = performance.now() - highLoadRestartStartedAt;
await closeSession(fourthSession);

const result = {
  id: "restart",
  generatedAt: new Date().toISOString(),
  application,
  passed: true,
  insertedText,
  initial,
  synchronized,
  committedRevision,
  restored,
};
writeFileSync(
  `${evidenceDirectory}/restart-tauri.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
const vimResult = {
  id: "vim-vim-golden",
  generatedAt: new Date().toISOString(),
  application,
  passed: true,
  sequence: [
    "Escape",
    "0",
    "3w",
    "0",
    "w/b script runs",
    "$",
    "v",
    "h",
    "y",
    "P",
    "u",
  ],
  normalMode,
  relativeLogicalLineNumbers,
  imeOff: {
    fcitxRemote,
    ...imeOff,
  },
  japaneseWordMotion,
  clipboardWrite,
  visualCharInitial,
  visualCharAfterLeft,
  structuralClipboardWrite,
  structuralClipboardVisibility,
  systemClipboard,
  osClipboardPaste,
  beforePut: restored.text,
  afterPut,
  afterUndo,
  vimCommitted,
  vimRestored,
};
writeFileSync(
  `${evidenceDirectory}/vim-vim-tauri.json`,
  `${JSON.stringify(vimResult, null, 2)}\n`,
);
const performanceResult = {
  id: "vim-high-load-input",
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceTreeDirtyAtMeasurement:
    execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude)evidence/**",
      ],
      { encoding: "utf8" },
    ).trim().length > 0,
  application,
  build: "Tauri release / Wry WebKit",
  measurement:
    "WebDriver keydown capture to the first editor mutation's following animation frame",
  environment: {
    classification: "development VM reference; not native acceptance",
    platform: process.platform,
    architecture: process.arch,
    kernelRelease: release(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    xdgSessionType: process.env.XDG_SESSION_TYPE ?? "",
    ...highLoad.before,
  },
  targetHighLoadP95Ms: 50,
  result: "VM_REFERENCE_INPUT_GATE_PASS",
  ...highLoad,
  persistedCompaction: highLoadStorage,
  restart: {
    processStartToTwoEditorsReadyMs: round(highLoadRestartToReadyMs),
    restored: highLoadRestored,
  },
  nativeAcceptance: "NOT RUN",
};
writeFileSync(
  `${evidenceDirectory}/vim-performance.json`,
  `${JSON.stringify(performanceResult, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(vimResult, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(performanceResult, null, 2)}\n`);
