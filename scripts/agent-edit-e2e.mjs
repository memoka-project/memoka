import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function runAgentEditing({
  sessionId,
  application,
  workspace,
  initialNoteId,
  execute,
  waitFor,
  sendActiveKey,
  invokeTauriCommand,
}) {
  assert.ok(workspace, "Requires the isolated E2E Workspace");
  const temporary = await mkdtemp(join(tmpdir(), "memoka-agent-e2e-"));
  const binary =
    process.env.MEMOKA_E2E_CLI ?? join(dirname(application), "memoka-cli");
  const cli = async (area, ...args) => {
    try {
      const { stdout, stderr } = await run(
        binary,
        [...args, "--workspace", area, "--format", "json"],
        { timeout: 35000, maxBuffer: 8 * 1024 * 1024 },
      );
      assert.equal(stderr, "");
      return JSON.parse(stdout);
    } catch (error) {
      if (error.stdout) return JSON.parse(error.stdout);
      throw error;
    }
  };
  const read = (area = workspace) =>
    cli(area, "read", "--id", initialNoteId, "--for-edit");
  const viewportScript = `const selection = getSelection();
    const anchor = selection?.anchorNode?.nodeType === 1 ? selection.anchorNode : selection?.anchorNode?.parentElement;
    return {
      activeWindow: document.activeElement?.closest('.editor-window')?.dataset.windowId,
      anchorBlock: anchor?.closest('[data-block-id]')?.dataset.blockId,
      anchorOffset: selection?.anchorOffset,
      windows: [...document.querySelectorAll('.editor-window')].map(window => ({
        id: window.dataset.windowId,
        mode: window.querySelector('.memoka-editor')?.dataset.vimMode,
        scroll: window.querySelector('.editor-scroll')?.scrollTop,
        folded: [...window.querySelectorAll('[data-section-fold-state="collapsed"]')].map(s => s.dataset.sectionId)
      }))
    }`;
  const edit = async (area, request, dry = false) => {
    const path = join(temporary, `${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(request));
    return cli(area, "edit", "--input", path, ...(dry ? ["--dry-run"] : []));
  };
  const make = (view, edits) => ({
    schema_version: 1,
    workspace_id: view.workspace_id,
    note_id: initialNoteId,
    expected_revision: view.revision,
    request_id: randomUUID(),
    edits,
  });
  const replacement = (old_text, new_text) => ({
    op: "replace_text",
    section_id: initialNoteId,
    scope: "body",
    old_text,
    new_text,
  });
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "blockId" && key !== "chunkId")
          .map(([key, value]) => [key, normalize(value)]),
      );
    return value;
  };
  try {
    const before = await read();
    assert.equal(before.representation, "edit_view", JSON.stringify(before));
    const baseline = await edit(
      workspace,
      make(before, [
        {
          op: "append_markdown",
          section_id: initialNoteId,
          markdown: "AgentAlpha 日本語😀 **強調**\n\n- [ ] AgentTask",
        },
      ]),
    );
    assert.equal(baseline.ok, true, JSON.stringify(baseline));
    await waitFor(
      sessionId,
      "return [...document.querySelectorAll('.memoka-editor')].map(e=>e.textContent)",
      (v) => v.length === 2 && v.every((s) => s.includes("AgentAlpha")),
    );
    const setFault = (fault) =>
      invokeTauriCommand(sessionId, "AGENT_FAULT", "agent_edit_test_fault", {
        fault,
      });
    // Debug-only hooks reject before/during SQL and lose the reply after SQL.
    // A release artifact can run the rest with MEMOKA_E2E_AGENT_FAULTS=0.
    const faults = process.env.MEMOKA_E2E_AGENT_FAULTS !== "0";
    if (faults) {
      for (const fault of ["before-commit", "before-sql-commit"]) {
        const base = await read();
        await setFault(fault);
        const failed = await edit(
          workspace,
          make(base, [
            {
              op: "append_markdown",
              section_id: initialNoteId,
              markdown: "MUST_NOT_COMMIT",
            },
          ]),
        );
        assert.equal(failed.ok, false, JSON.stringify(failed));
        assert.equal(failed.commit_state, "not_applied");
        assert.equal((await read()).revision, base.revision);
        assert.equal(
          await execute(
            sessionId,
            "return [...document.querySelectorAll('.memoka-editor')].some(e=>e.textContent.includes('MUST_NOT_COMMIT'))",
          ),
          false,
        );
      }
      const base = await read();
      const request = make(base, [
        {
          op: "append_markdown",
          section_id: initialNoteId,
          markdown: "response survived",
        },
      ]);
      await setFault("after-commit-response");
      const recovered = await edit(workspace, request);
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal((await edit(workspace, request)).replayed, true);
      await waitFor(
        sessionId,
        "return [...document.querySelectorAll('.memoka-editor')].map(e=>e.textContent)",
        (v) =>
          v.length === 2 && v.every((s) => s.includes("response survived")),
      );
    }
    await sendActiveKey(sessionId, "G");
    await sendActiveKey(sessionId, "A");
    for (const key of " userUndoSuffix") await sendActiveKey(sessionId, key);
    await sendActiveKey(sessionId, "\uE00C");
    const base = await read();
    const task = base.blocks.find(
      (b) =>
        b.kind === "listItem" &&
        b.checked === false &&
        b.markdown.includes("AgentTask"),
    );
    assert.ok(task, JSON.stringify(base));
    const clone = join(temporary, "standalone");
    await mkdir(join(clone, ".memoka"), { recursive: true });
    await cp(
      join(workspace, ".memoka/data-area.json"),
      join(clone, ".memoka/data-area.json"),
    );
    await run("sqlite3", [
      join(workspace, ".memoka/memoka.sqlite3"),
      `.backup '${join(clone, ".memoka/memoka.sqlite3")}'`,
    ]);
    const request = make(base, [
      replacement("AgentAlpha 日本語😀", "AgentBeta 変更😀"),
      {
        op: "set_task_checked",
        section_id: initialNoteId,
        block_id: task.block_id,
        checked: true,
      },
      {
        op: "append_markdown",
        section_id: initialNoteId,
        markdown: "> 続き *斜体*\n\n- [x] 完了",
      },
    ]);
    const preview = await edit(workspace, request, true);
    assert.equal(preview.status, "preview", JSON.stringify(preview));
    assert.equal((await read()).revision, base.revision);
    const viewportBefore = await execute(sessionId, viewportScript);
    const [gui, standalone] = await Promise.all([
      edit(workspace, request),
      edit(clone, request),
    ]);
    assert.equal(gui.ok, true, JSON.stringify(gui));
    assert.equal(standalone.ok, true, JSON.stringify(standalone));
    for (const key of [
      "revision_before",
      "revision_after",
      "applied_edits",
      "changed_block_ids",
      "changes",
    ])
      assert.deepEqual(gui[key], standalone[key], key);
    assert.deepEqual(
      normalize((await cli(workspace, "read", "--id", initialNoteId)).section),
      normalize((await cli(clone, "read", "--id", initialNoteId)).section),
    );
    await waitFor(
      sessionId,
      "return [...document.querySelectorAll('.memoka-editor')].map(e=>e.textContent)",
      (v) => v.length === 2 && v.every((s) => s.includes("AgentBeta")),
    );
    const viewportAfter = await execute(sessionId, viewportScript);
    assert.deepEqual(
      viewportAfter,
      viewportBefore,
      "external edits preserve Window focus, caret, mode, scroll and folds",
    );
    assert.equal((await edit(workspace, request)).replayed, true);
    assert.equal((await edit(clone, request)).replayed, true);
    await sendActiveKey(sessionId, "u");
    const afterUndo = await cli(workspace, "read", "--id", initialNoteId);
    assert.ok(afterUndo.markdown.includes("AgentBeta"));
    assert.ok(afterUndo.markdown.includes("- [x] AgentTask"));
    assert.ok(!afterUndo.markdown.includes("userUndoSuffix"));
    const compositionBase = await read();
    await execute(
      sessionId,
      "document.querySelector('.memoka-editor').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'あ'}));return true",
    );
    const ime = await edit(
      workspace,
      make(compositionBase, [replacement("AgentBeta", "IME_BLOCKED")]),
    );
    assert.equal(ime.ok, false);
    assert.ok(
      ["IME_ACTIVE", "EDIT_BUSY"].includes(ime.error.code),
      JSON.stringify(ime),
    );
    await execute(
      sessionId,
      "document.querySelector('.memoka-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));return true",
    );
    await sendActiveKey(sessionId, "t");
    await sendActiveKey(sessionId, "c");
    await waitFor(
      sessionId,
      "return document.querySelectorAll('.memoka-editor').length",
      (v) => v === 0,
    );
    const hidden = await read();
    const hiddenResult = await edit(
      workspace,
      make(hidden, [replacement("AgentBeta", "AgentGamma")]),
    );
    assert.equal(hiddenResult.ok, true, JSON.stringify(hiddenResult));
    assert.equal(
      await execute(
        sessionId,
        "return document.querySelectorAll('.memoka-editor').length",
      ),
      0,
    );
    await sendActiveKey(sessionId, "t");
    await sendActiveKey(sessionId, "p");
    await waitFor(
      sessionId,
      "return [...document.querySelectorAll('.memoka-editor')].map(e=>e.textContent)",
      (v) => v.length === 2 && v.every((s) => s.includes("AgentGamma")),
    );
    return {
      passed: true,
      gui_and_standalone_equal: true,
      replay: true,
      user_undo_preserved: true,
      window_views_preserved: true,
      ime_rejected: true,
      hidden_note: true,
      native_sql_faults: faults,
      revision: gui.revision_after,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
