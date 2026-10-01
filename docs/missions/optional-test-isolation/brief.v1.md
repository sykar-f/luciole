# Mission optional-test-isolation — the optional-package test really has no package

Role: worker
Agent: airtty-optional-test-isolation
Brief version: v1
Base: main @ 84c7338
Branch: mission/optional-test-isolation
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

`tests/optional.test.ts` ("an app without the optional packages") passes wherever `TMPDIR` points. Main is red @84c7338 on its two tests: the main sweep sets `TMPDIR` inside its checkout (`.sweep/tmp`), so the "app without the optional packages" that the test builds under `tmpdir()` resolves `@resvg/resvg-wasm` and the grammar packages from the repository's `node_modules` in a parent directory: `math-run.ts` prints nothing and exits 0, and the build guard finds the packages. The master reproduced it: `TMPDIR=<worktree>/.sweep/tmp bun test tests/optional.test.ts` → 2 fail; with the default TMPDIR → 5 pass.

## Scope

Owned: `tests/optional.test.ts` (and a test helper if you need one).
Frozen: `packages/luciole/src/**` and what the tests assert.
Out of bounds: everything else.

## Context

The test's premise is that the packages are not resolvable from the app's directory; make that true by construction and checked, not assumed: place the app where no ancestor directory has a `node_modules` holding them (a directory you choose and verify, e.g. by walking its ancestors), and assert the premise before the behaviour (resolving the package from the app's root must fail), so the test fails with a clear message instead of a misleading one if the premise ever breaks. No skip, no retry.

## Acceptance

- `TMPDIR=$PWD/.sweep/tmp bun test tests/optional.test.ts` passes (create the directory first); paste the output.
- The test passes with the default TMPDIR too.
- The premise is asserted in the test (diff).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/optional-test-isolation/`.
