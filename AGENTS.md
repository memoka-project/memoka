# AGENTS.md

This file applies to the entire repository. It is intended to give a new coding-agent session enough project context to make safe, consistent changes without rediscovering the basic workflow.

## Project overview

Memoka is a Vim-oriented desktop note application.

- `app/src/` contains the TypeScript and React application.
- `app/src/core/` contains application state, persistence, document, and runtime logic.
- `app/src/components/` contains React UI components.
- `app/src/editor/` contains the Tiptap/ProseMirror editor integration.
- `app/src/vim/` contains Vim input grammar, motions, operators, and editor commands.
- `src-tauri/` contains the Rust/Tauri desktop integration.
- `tests/` contains the Vitest product and unit tests.
- `doc/specification/` contains the normative behavior specifications.
- `doc/help.md` is the user-facing help source.

Before changing behavior, find the existing implementation, its tests, and the relevant specification. Prefer extending established abstractions over adding a parallel implementation.

## Branch workflow

- Perform normal development, fixes, documentation updates, and commits on the `develop` branch.
- Do not make ordinary development commits directly on `main`.
- Before editing, check both the current branch and the working tree. Preserve all pre-existing user changes.
- If the repository is on `main`, move to `develop` before starting development when it is safe to do so. If local changes make that unsafe, report the situation instead of discarding or overwriting them.
- Merge `develop` into `main` only as part of an explicitly requested release.
- Do not push branches, create tags, publish artifacts, or perform a release unless the user explicitly requests it.

## Tooling

- Use the package manager pinned in `package.json`: `corepack pnpm`.
- The supported development Node.js line is Node.js 24 LTS.
- Install dependencies with:

  ```bash
  corepack pnpm install --frozen-lockfile
  ```

- Run the web development server with:

  ```bash
  corepack pnpm dev
  ```

- Run the Tauri development application with:

  ```bash
  corepack pnpm tauri:dev
  ```

Do not replace pnpm with npm or yarn, and do not rewrite the lockfile unless dependency changes require it.

## Implementation guidelines

- Keep changes scoped to the requested behavior. Avoid unrelated refactors in the same change.
- Preserve existing public behavior unless the request or specification intentionally changes it.
- Follow the terminology already used by the project, including `Note`, `Section`, `Tree`, `Window`, `TabPage`, `Buffer`, `word`, and `WORD` where applicable.
- Treat structured editor content as ProseMirror/Tiptap structure rather than plain text. Reuse the existing block semantics, stable-position, selection, and transaction helpers.
- Keep Vim input parsing separate from editor command execution. New Vim operations generally require input bindings, command handling, product tests, and specification updates.
- Keep Window-local and TabPage-local state local unless the existing model explicitly makes it Workspace-wide.
- Preserve stable IDs and undo boundaries when editing document structures.
- Do not silently weaken error handling, persistence guarantees, accessibility attributes, keyboard behavior, or focus management.
- Use the existing formatter and lint rules; do not manually restyle unrelated files.

## Tests and validation

Add or update tests for every behavior change. Prefer a focused regression test that demonstrates the user-visible behavior, including relevant keyboard, focus, persistence, undo, or restart boundaries.

During development, run the narrowest relevant tests first. For example:

```bash
corepack pnpm vitest run tests/workspace-tree.test.tsx
corepack pnpm vitest run tests/vim-input.test.ts tests/vim-product.test.ts
```

Before handing off a completed change, normally run:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm spec:check
corepack pnpm test
```

Also run `git diff --check` to catch whitespace errors.

Use validation proportional to the change:

- Documentation-only changes require formatting/specification checks as applicable.
- TypeScript or React changes require relevant tests, lint, and type checking.
- Rust changes require relevant Cargo tests or checks in addition to the TypeScript checks they affect.
- Release preparation should use the repository's full `corepack pnpm verify` workflow and the release documentation/scripts.

Do not claim a check passed unless it was actually run. If a required check cannot run because of the environment, state that clearly.

## Specifications and help

Behavioral documentation is part of the implementation.

- Update the relevant file under `doc/specification/` when behavior or architecture changes.
- Update `doc/help.md` when a user-visible command, key binding, interaction, setting, or workflow changes.
- Keep tests, specifications, and help text consistent with the implementation.
- Run `corepack pnpm spec:check` after changing specification links or structure.

Do not document aspirational behavior as implemented behavior. If implementation and documentation disagree, determine which one reflects the requested product behavior and update the other side deliberately.

## Git and commits

- Inspect `git status` and the relevant diff before editing and before committing.
- Never discard, reset, overwrite, or include unrelated user changes.
- Do not create a commit unless the user explicitly asks for one.
- When asked to commit, include only the completed task and use a concise Conventional Commit message, such as `feat: ...`, `fix: ...`, `docs: ...`, or `test: ...`.
- After committing, report the commit hash and confirm whether the working tree is clean.

## Release policy

A release is a separate, explicitly requested operation. For a release:

1. Confirm that the intended release changes are complete on `develop`.
2. Run the full release-relevant validation and repository release scripts.
3. Merge `develop` into `main`.
4. Create tags, build artifacts, publish, or push only within the scope explicitly authorized by the user.
5. Report exactly what was merged, tagged, built, and published, including any step that could not be completed.

Do not infer release authorization from a version change, a successful build, or a request to commit ordinary development work.
