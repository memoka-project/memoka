import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const runFile = promisify(execFile);

async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(path);
    else if (entry.isFile()) bytes += (await lstat(path)).size;
  }
  return bytes;
}

function latencySummary(samples) {
  const values = [...samples].sort((a, b) => a - b);
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const at = (ratio) =>
    Math.round(values[Math.ceil(values.length * ratio) - 1] * 100) / 100;
  return { count: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

// This suite deliberately uses the real GUI save barrier, owner IPC, SQLite,
// bundled Restic and historical reader. The harness supplies a private
// Workspace and XDG directories; never run it against a user's Workspace.
export async function runNamespaceHistory({
  sessionId,
  application,
  workspace,
  initialNoteId,
  execute,
  waitFor,
  waitForElement,
  sendKeys,
  sendActiveKey,
  sendActiveChord,
  clickElement,
  windowRect,
  screenshot,
}) {
  assert.ok(workspace, "The isolated E2E Workspace is required");
  const ENTER = "\uE007";
  const ESCAPE = "\uE00C";
  const CONTROL = "\uE009";
  const cli = async (...args) => {
    const { stdout, stderr } = await runFile(
      process.env.MEMOKA_E2E_CLI ?? join(dirname(application), "memoka-cli"),
      [...args, "--workspace", workspace, "--format", "json"],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(stderr, "", "Successful reads must not leak diagnostics");
    const result = JSON.parse(stdout);
    const backupStateV3 =
      args[0] === "backup" &&
      ["status", "run", "copy", "maintain"].includes(args[1]);
    assert.equal(result.schema_version, backupStateV3 ? 3 : 1);
    return result;
  };
  const command = async (name) => {
    await sendActiveKey(sessionId, ":");
    const input = await waitForElement(
      sessionId,
      'input[aria-label="Memoka Command"]',
    );
    await sendKeys(sessionId, input, name + ENTER);
    await waitFor(
      sessionId,
      "return !document.querySelector('input[aria-label=\"Memoka Command\"]')",
      Boolean,
    );
  };
  const active = () =>
    execute(
      sessionId,
      `return { tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
        note: document.activeElement?.closest('.memoka-editor')?.dataset.noteId,
        surface: document.activeElement?.closest('[data-memoka-focus-surface]')?.dataset.memokaFocusSurface }`,
    );
  const initial = await cli("read", "--id", initialNoteId);
  // Finish the startup capture before changing the fixture. Otherwise it may
  // legitimately already contain the later text and make :backup a no-op,
  // leaving nothing for the concurrent-input measurement to overlap.
  await command("backup");
  await waitFor(
    sessionId,
    'return document.querySelector(".application-commandline")?.textContent ?? ""',
    (text) => text.includes("backup · 処理完了"),
    120_000,
  );

  const originalRect = await windowRect();
  const originalBackup = await cli("backup", "status");
  const modalLayouts = [];
  try {
    for (const size of [null, { width: 620, height: 460 }]) {
      if (size) await windowRect(size);
      for (const name of ["backup-settings"]) {
        await command(name);
        await waitForElement(sessionId, ".backup-dialog");
        await waitFor(
          sessionId,
          `const dialog = document.querySelector('.backup-dialog');
          return !!dialog && !dialog.textContent.includes('読み込み中')
            && (dialog.querySelector('input')?.matches(':enabled') ?? true);`,
          Boolean,
        );
        // A release may embed a client; source builds can intentionally omit
        // it. Merely displaying either variant must not authorize or connect.
        const googleConfigured =
          process.env.MEMOKA_E2E_GOOGLE_CONFIGURED === "1";
        await waitFor(
          sessionId,
          `const panel = document.querySelector('.backup-dialog');
          const connect = Array.from(panel?.querySelectorAll('button') ?? []).find(button => button.textContent === 'Googleへ新規接続');
          return !!connect && connect.disabled === ${!googleConfigured}
            && (${googleConfigured} || panel.textContent.includes('Google接続は未設定です'));`,
          Boolean,
        );
        const cloudUi = await execute(
          sessionId,
          `const panel = document.querySelector('.backup-dialog');
            const connect = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === 'Googleへ新規接続');
            return { disabled: connect?.disabled,
              types: Array.from(panel.querySelectorAll('select option')).map(option => option.textContent),
              tokenFields: panel.querySelectorAll('input[type=password]').length };`,
        );
        assert.equal(cloudUi.disabled, !googleConfigured);
        assert.ok(cloudUi.types.includes("Google Drive"));
        assert.ok(cloudUi.types.includes("ローカルディレクトリ"));
        assert.equal(cloudUi.tokenFields, 0);
        if (!size) {
          // Exercise the real settings IPC, not only mocked dialog forms.
          // Retention changes are configuration-only and must not capture or
          // alter the Note's epoch; the modal stays open after saving.
          for (const [index, value] of [17, 49, 31, 13].entries()) {
            const input = await waitForElement(
              sessionId,
              index === 0
                ? '.backup-dialog input[type="number"]'
                : `.backup-retention-fields label:nth-child(${index}) input`,
            );
            await clickElement(sessionId, input);
            await sendActiveChord(sessionId, CONTROL, "a");
            await sendKeys(sessionId, input, String(value));
          }
          await clickElement(
            sessionId,
            await waitForElement(
              sessionId,
              '.backup-dialog button[type="submit"]',
            ),
          );
          await waitFor(
            sessionId,
            `return document.querySelector('.backup-dialog')?.getAttribute('aria-busy') === 'false';`,
            Boolean,
          );
          const saved = await cli("backup", "status");
          assert.equal(saved.config.interval_minutes, 17);
          assert.deepEqual(saved.config.local_retention, {
            last: 49,
            daily: 31,
            monthly: 13,
          });
          assert.equal(saved.content_epoch, originalBackup.content_epoch);
          assert.equal(
            saved.status.last_local_capture_at,
            originalBackup.status.last_local_capture_at,
          );
        }
        const geometry = await execute(
          sessionId,
          `const dialog = document.querySelector('.backup-dialog');
          const rect = dialog.getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight },
            dialog: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            centeredX: Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 1,
            centeredY: Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 1,
            bounded: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            scrollable: dialog.scrollHeight > dialog.clientHeight,
            backdrop: document.elementFromPoint(2, 2)?.classList.contains('application-modal-overlay'),
            focused: dialog.contains(document.activeElement),
            controls: dialog.querySelectorAll('input:not(:disabled),button:not(:disabled)').length
          };`,
        );
        assert.ok(
          geometry.centeredX && geometry.centeredY,
          JSON.stringify(geometry),
        );
        assert.ok(geometry.bounded && geometry.backdrop && geometry.focused);
        if (size && name === "backup-settings") assert.ok(geometry.scrollable);
        modalLayouts.push({ name, ...geometry });

        // Tab must wrap within the dialog and reveal the focused control by
        // scrolling this panel, even when the complete form cannot fit.
        for (let index = 0; index <= geometry.controls; index++) {
          await sendActiveKey(sessionId, "\uE004");
          const focusGeometry = await execute(
            sessionId,
            `const dialog = document.querySelector('.backup-dialog');
              const active = document.activeElement;
              const panel = dialog.getBoundingClientRect();
              const control = active.getBoundingClientRect();
              return { visible: dialog.contains(active) && control.top >= panel.top
                && control.bottom <= panel.bottom,
                control: active.outerHTML, top: control.top, bottom: control.bottom,
                panelTop: panel.top, panelBottom: panel.bottom, scrollTop: dialog.scrollTop };`,
          );
          assert.ok(
            focusGeometry.visible,
            `Tab focus must remain visible inside the modal: ${JSON.stringify(focusGeometry)}`,
          );
        }
        assert.equal(
          await execute(
            sessionId,
            `document.querySelector('.memoka-editor').focus();
            return document.querySelector('.backup-dialog').contains(document.activeElement);`,
          ),
          true,
          "Background editors must not steal modal focus",
        );
        await execute(
          sessionId,
          "document.querySelector('.backup-dialog').scrollTop = 0; return true;",
        );
        await screenshot(`${name}${size ? "-small" : ""}.png`);
        if (size) await sendActiveChord(sessionId, CONTROL, "c");
        else await sendActiveKey(sessionId, ESCAPE);
        await waitFor(
          sessionId,
          'return !document.querySelector(".backup-dialog") && document.activeElement?.closest(".memoka-editor")?.dataset.noteId',
          (id) => id === initialNoteId,
        );
      }
    }
  } finally {
    await windowRect(originalRect);
  }

  await command("group");
  const nameInput = await waitForElement(
    sessionId,
    'input[aria-label="グループ名"]',
  );
  await sendKeys(sessionId, nameInput, "Native history group" + ENTER);
  await waitFor(
    sessionId,
    "return !document.querySelector('input[aria-label=\"グループ名\"]')",
    Boolean,
  );
  const grouped = await cli("tree");
  const group = grouped.items.find(
    (entry) => entry.title === "Native history group",
  );
  assert.ok(group, "The new group must be present in the native Namespace");
  assert.equal(group.target, null, "Groups must not create placeholder Notes");
  const original = await cli("read", "--id", initialNoteId);
  assert.equal(original.markdown, initial.markdown);
  assert.equal(
    original.source.document_revision,
    initial.source.document_revision,
    "Organizing the Namespace must not modify a Note",
  );
  assert.equal((await active()).note, initialNoteId);

  await command("tree");
  await waitForElement(sessionId, '[role="tree"][aria-label="ノートツリー"]');
  // Select through the keyboard, not hidden runtime hooks or pointer controls.
  for (const key of ["g", "g", "l", "G"]) await sendActiveKey(sessionId, key);
  await waitFor(
    sessionId,
    'return document.querySelector(\'[role="tree"]\')?.getAttribute("aria-activedescendant")',
    (id) => id === `tree-note-${group.entry_id}`,
  );
  await command("rename-group");
  const rename = await waitForElement(
    sessionId,
    'input[aria-label="グループ名"]',
  );
  await sendActiveChord(sessionId, CONTROL, "a");
  await sendKeys(sessionId, rename, "Renamed native group" + ENTER);
  await waitFor(
    sessionId,
    "return !document.querySelector('input[aria-label=\"グループ名\"]')",
    Boolean,
  );
  const renamed = await cli("tree");
  assert.equal(
    renamed.items.find((entry) => entry.entry_id === group.entry_id).title,
    "Renamed native group",
  );
  assert.equal(
    (await cli("read", "--id", initialNoteId)).source.document_revision,
    initial.source.document_revision,
  );

  await sendActiveKey(sessionId, "c");
  const noteId = await waitFor(
    sessionId,
    'return document.querySelector(".memoka-editor")?.dataset.noteId',
    (id) => !!id && id !== initialNoteId,
  );
  const editor = await waitForElement(sessionId, ".memoka-editor");
  await waitFor(
    sessionId,
    'return document.querySelector(".editor-window")?.dataset.vimMode',
    (mode) => mode === "insert",
  );
  await sendKeys(sessionId, editor, "Native child" + ENTER);
  await sendKeys(sessionId, editor, "Captured body");
  await sendActiveKey(sessionId, ESCAPE);
  const focusBeforeRead = await active();
  const child = await cli("read", "--id", noteId);
  assert.equal(child.title, "Native child");
  assert.match(child.markdown, /Captured body/);
  assert.ok(child.namespace_path.includes("Renamed native group"));
  assert.deepEqual(await active(), focusBeforeRead, "CLI must not steal focus");
  const childEntry = (await cli("tree")).items.find(
    (entry) => entry.target?.id === noteId,
  );
  assert.equal(childEntry.parent_entry_id, group.entry_id);
  assert.notEqual(childEntry.entry_id, noteId);

  await execute(
    sessionId,
    `window.__historyFrames = [];
    window.__historyFramesActive = true;
    let previous = performance.now();
    const frame = now => {
      if (!window.__historyFramesActive) return;
      if (window.__historyFrames.length < 10000) window.__historyFrames.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame); return true;`,
  );
  const captureStart = performance.now();
  await command("backup");
  // Exercise real Insert input in the other Window while the native backup
  // runs. The captured child is unchanged, so its generation can still be
  // compared exactly. Measure keydown -> next RAF, not WebDriver round trips
  // or physical display latency; never report it as an IME benchmark.
  const secondEditor = await waitForElement(
    sessionId,
    ".editor-window:nth-child(2) .memoka-editor",
  );
  await clickElement(sessionId, secondEditor);
  await sendActiveKey(sessionId, ESCAPE);
  await sendActiveKey(sessionId, "G");
  await sendActiveKey(sessionId, "A");
  await execute(
    sessionId,
    `window.__historyInputLatency = [];
    window.__historyInputProbe = event => {
      if (event.key !== 'x' || !event.target.closest('.memoka-editor')) return;
      const start = performance.now();
      const pending = !document.querySelector('.application-commandline')?.textContent?.includes('backup · 処理完了');
      requestAnimationFrame(() => window.__historyInputLatency.push({
        ms: performance.now() - start, pending
      }));
    };
    document.addEventListener('keydown', window.__historyInputProbe, true);
    return true;`,
  );
  for (let index = 0; index < 24; index++) await sendActiveKey(sessionId, "x");
  await sendActiveKey(sessionId, ESCAPE);
  await waitFor(
    sessionId,
    'return document.querySelector(".editor-window:nth-child(2) .memoka-editor")?.textContent',
    (text) => text?.includes("x".repeat(24)),
  );
  const inputSamples = await execute(
    sessionId,
    `document.removeEventListener('keydown', window.__historyInputProbe, true);
    return window.__historyInputLatency.filter(sample => sample.pending).map(sample => sample.ms);`,
  );
  // A fast incremental capture can finish while focus moves to the other
  // Window. Keep the functional test deterministic and report zero samples
  // explicitly instead of claiming a concurrent-input performance pass.
  await clickElement(sessionId, editor);
  await sendActiveKey(sessionId, "G");
  await waitFor(
    sessionId,
    'return document.querySelector(".application-commandline")?.textContent ?? ""',
    (text) => text.includes("backup · 処理完了"),
    120_000,
  );
  const captureMs = Math.round(performance.now() - captureStart);
  const frameSamples = await execute(
    sessionId,
    `window.__historyFramesActive = false;
    return window.__historyFrames;`,
  );
  const sizes = {
    liveDbBytes: (await lstat(join(workspace, ".memoka/memoka.sqlite3"))).size,
    liveWalBytes: await lstat(join(workspace, ".memoka/memoka.sqlite3-wal"))
      .then((stat) => stat.size)
      .catch((error) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      }),
    localRepositoryBytes: await treeBytes(
      join(workspace, ".memoka-backups/restic"),
    ),
  };
  await clickElement(sessionId, secondEditor);
  await sendActiveKey(sessionId, ESCAPE);
  await sendActiveKey(sessionId, "G");
  await sendActiveKey(sessionId, "A");
  await execute(
    sessionId,
    `window.__historyInputLatency = [];
    document.addEventListener('keydown', window.__historyInputProbe, true); return true;`,
  );
  for (let index = 0; index < 24; index++) await sendActiveKey(sessionId, "x");
  await sendActiveKey(sessionId, ESCAPE);
  const idleSamples = await execute(
    sessionId,
    `document.removeEventListener('keydown', window.__historyInputProbe, true);
    return window.__historyInputLatency.map(sample => sample.ms);`,
  );
  await clickElement(sessionId, editor);
  await sendActiveKey(sessionId, "G");
  const generations = await cli("history", "--id", noteId);
  assert.ok(generations.generations.length > 0);
  const generation = generations.generations[0].descriptor.generation_id;
  sizes.capturedDbBytes = generations.generations[0].descriptor.files.find(
    (file) => file.path === "state.sqlite",
  ).size;
  const historicalReadStart = performance.now();
  const historical = await cli(
    "read",
    "--id",
    noteId,
    "--generation",
    generation,
  );
  const historicalReadMs = Math.round(performance.now() - historicalReadStart);
  assert.equal(historical.markdown, child.markdown);
  assert.equal(historical.source.generation_id, generation);
  const historicalTree = await cli("tree", "--generation", generation);
  assert.equal(
    historicalTree.items.find((entry) => entry.entry_id === group.entry_id)
      .title,
    "Renamed native group",
  );

  // A later live edit must not change the already captured generation.
  await sendActiveKey(sessionId, "A");
  await sendKeys(sessionId, editor, " after capture");
  await sendActiveKey(sessionId, ESCAPE);
  const newer = await cli("read", "--id", noteId);
  assert.equal(newer.title, child.title);
  assert.match(newer.markdown, /Captured body[\s\S]*after capture/);
  assert.ok(newer.source.document_revision > child.source.document_revision);
  assert.equal(
    (await cli("read", "--id", noteId, "--generation", generation)).markdown,
    child.markdown,
  );

  const previewStart = performance.now();
  await command("history");
  const preview = await waitFor(
    sessionId,
    `return document.querySelector('[data-memoka-focus-surface="history"] .workspace-search-preview-document')?.textContent ?? ''`,
    (text) => text.includes("Captured body"),
    120_000,
  );
  const previewMs = Math.round(performance.now() - previewStart);
  assert.ok(!preview.includes("after capture"));
  const displayedDates = await execute(
    sessionId,
    `return [...document.querySelectorAll('[data-memoka-focus-surface="history"] time')]
      .map(element => element.textContent);`,
  );
  assert.ok(displayedDates.length > 0);
  for (const value of displayedDates)
    assert.match(
      value,
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \(\d+[a-z]+ ago\)$/u,
    );
  assert.equal(
    await execute(
      sessionId,
      `return document.querySelector('[data-memoka-focus-surface="history"] [contenteditable="true"]') !== null`,
    ),
    false,
  );
  const previewControl = await waitForElement(
    sessionId,
    '[data-memoka-focus-surface="history"] .workspace-search-preview-root > button',
  );
  await clickElement(sessionId, previewControl);
  assert.equal((await active()).label, "履歴日時を絞り込む");
  await sendActiveChord(sessionId, CONTROL, "c");
  await waitFor(
    sessionId,
    "return !document.querySelector('[data-memoka-focus-surface=\"history\"]')",
    Boolean,
  );
  await waitFor(
    sessionId,
    'return document.activeElement?.closest(".memoka-editor")?.dataset.noteId',
    (id) => id === noteId,
  );
  assert.equal((await cli("read", "--id", noteId)).markdown, newer.markdown);

  // Explicit backup still captures the latest Core state. Quit no longer
  // creates a backup or waits for its success; exercise that separately below.
  await command("backup");
  await waitFor(
    sessionId,
    'return document.querySelector(".application-commandline")?.textContent ?? ""',
    (text) => text.includes("backup · 処理完了"),
    120_000,
  );
  const resumedBackup = await cli("backup", "status");
  assert.equal(resumedBackup.status.local_error, null);
  const resumedHistory = await cli("history", "--id", noteId);
  const resumedGeneration =
    resumedHistory.generations[0].descriptor.generation_id;
  const resumedRead = await cli(
    "read",
    "--id",
    noteId,
    "--generation",
    resumedGeneration,
  );
  assert.equal(resumedRead.markdown, newer.markdown);
  // Explicit no-op backup still uses the verified receipt and Core barrier.
  const unchangedStart = performance.now();
  const unchanged = await cli("backup", "run");
  const unchangedBackupMs = Math.round(performance.now() - unchangedStart);
  assert.equal(unchanged.skipped, true);
  assert.equal(unchanged.reason, "already-uploaded");
  assert.equal(unchanged.local_generation, null);
  assert.equal(
    await execute(
      sessionId,
      'return !document.querySelector(".application-shutdown-progress")',
    ),
    true,
  );

  // Start another real local capture, then edit after its immutable input is
  // taken. Exit must save that edit without creating a final backup for it.
  await sendActiveKey(sessionId, "A");
  await sendKeys(sessionId, editor, " before interrupted backup");
  await sendActiveKey(sessionId, ESCAPE);
  await command("backup");
  const captureDeadline = performance.now() + 30_000;
  let captureStarted = false;
  while (performance.now() < captureDeadline) {
    if ((await cli("backup", "status")).status.phase === "saving") {
      captureStarted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(captureStarted, "Expected the real Restic capture to start");
  const exitMarker = " saved on quit without final backup";
  await sendActiveKey(sessionId, "A");
  await sendKeys(sessionId, editor, exitMarker);
  await sendActiveKey(sessionId, ESCAPE);
  await screenshot("namespace-history-tauri.png");
  await sendActiveKey(sessionId, ":");
  const quitInput = await waitForElement(
    sessionId,
    'input[aria-label="Memoka Command"]',
  );
  await sendKeys(sessionId, quitInput, "qa");
  const quitStart = performance.now();
  // Return from the synchronous script before the async save/close destroys
  // the WebDriver window; no GUI reads are performed after this dispatch.
  await execute(
    sessionId,
    `document.querySelector('input[aria-label="Memoka Command"]')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`,
  );
  let released = false;
  while (performance.now() - quitStart < 30_000) {
    try {
      // Linux native gate: read the lock already created in this private
      // Workspace. Never unlink/replace it or signal a process by PID.
      await runFile("flock", [
        "--exclusive",
        "--nonblock",
        join(workspace, ".memoka/workspace.lock"),
        "true",
      ]);
      released = true;
      break;
    } catch (error) {
      if (error.code !== 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const quitMs = Math.round(performance.now() - quitStart);
  assert.ok(
    released,
    "Quit must stop native work and release the Workspace lease",
  );
  const savedAfterQuit = await cli("read", "--id", noteId);
  assert.ok(savedAfterQuit.markdown.includes(exitMarker));
  assert.ok(
    savedAfterQuit.source.document_revision > newer.source.document_revision,
  );
  const historyAfterQuit = await cli("history", "--id", noteId);
  const lastBeforeRestart = await cli(
    "read",
    "--id",
    noteId,
    "--generation",
    historyAfterQuit.generations[0].descriptor.generation_id,
  );
  assert.ok(
    !lastBeforeRestart.markdown.includes(exitMarker),
    "Quit must not create a final capture",
  );
  // A new standalone service resumes uncaptured edits from the saved epoch.
  const restarted = await cli("backup", "run");
  assert.ok(restarted.local_generation);
  assert.equal(
    (
      await cli(
        "read",
        "--id",
        noteId,
        "--generation",
        restarted.local_generation.descriptor.generation_id,
      )
    ).markdown,
    savedAfterQuit.markdown,
  );

  return {
    modalLayouts,
    groupEntryId: group.entry_id,
    childEntryId: childEntry.entry_id,
    childNoteId: noteId,
    generation,
    generationAfterManualBackup: resumedGeneration,
    generationAfterRestart: restarted.local_generation.descriptor.generation_id,
    savedRevisionAfterQuit: savedAfterQuit.source.document_revision,
    applicationClosed: true,
    capturedRevision: child.source.document_revision,
    liveRevision: newer.source.document_revision,
    timingMs: {
      backupCycle: captureMs,
      unchangedBackupCycle: unchangedBackupMs,
      quitDuringBackup: quitMs,
      historicalRead: historicalReadMs,
      preview: previewMs,
    },
    insertKeyToNextFrameMs: latencySummary(inputSamples),
    frameIntervalsDuringBackupMs: latencySummary(frameSamples),
    idleInsertKeyToNextFrameMs: latencySummary(idleSamples),
    fixtureBytes: sizes,
    checks: [
      "centered-backup-modals-and-bounded-small-window-scrolling",
      "backup-modal-tab-cycle-and-editor-focus-restoration",
      "backup-settings-native-save-without-capture-or-modal-dismissal",
      "unconfigured-google-native-panel-and-typed-destination-chooser",
      "history-absolute-local-datetime-with-ago",
      "manual-backup-captures-latest-note",
      "qa-during-backup-saves-core-and-releases-lease-without-final-capture",
      "uncaptured-edits-survive-exit-and-are-backed-up-by-restarted-service",
      "unchanged-backup-receipt-skips-restic-and-transfer-restart",
      "group-create-and-rename-without-note-mutation",
      "child-note-placement-and-distinct-entry-id",
      "native-cli-owner-save-barrier-without-focus-change",
      "real-local-restic-capture-and-historical-namespace",
      inputSamples.length > 0
        ? "native-insert-input-in-another-window-during-backup"
        : "native-insert-input-after-backup-completed-before-sampling",
      "immutable-generation-after-live-edit",
      "read-only-gui-preview-and-ctrl-c-focus-restore",
    ],
  };
}
