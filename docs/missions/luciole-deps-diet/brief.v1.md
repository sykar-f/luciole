# Mission luciole-deps-diet — luciole installs only what an app uses

Role: worker
Agent: airtty-luciole-deps-diet
Brief version: v1
Base: main @ 6991973
Branch: mission/luciole-deps-diet
Prerequisites: luciole-manifest
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: no

## Goal

Installing luciole no longer pulls every optional feature, and its dependency ranges let a consumer deduplicate. Today `packages/luciole/package.json` has ~34 exact-pinned runtime dependencies: `typescript` 7 and `@typescript/typescript6`, 16 tree-sitter grammars, `mathjax-full`, `@sqlite.org/sqlite-wasm`, `@resvg/resvg-wasm`, xterm packages.

## Scope

Owned: `packages/luciole/package.json` dependency fields, the modules that load optional dependencies (start from `src/grammars.ts`, `src/math.ts`, `src/cache/**`, `src/web/**`; find the others by grep), their tests, `docs/DEPENDENCIES.md`.
Frozen: public API of luciole; behaviour when the optional dependency is installed.
Out of bounds: `run.tsx`, `vt/pty.ts`, `serve.ts`, `commands/init.ts`, `scripts/clean-install.ts`.

## Context

Never publish anything (a `--dry-run` is fine). For each dependency, find where it is imported and classify: needed by every app (stays a dependency, caret range), needed by the CLI's build/check only (say why `typescript` must be runtime, or move it), optional feature (grammars beyond a core set, math, web, sqlite cache: `optionalDependencies` or optional `peerDependencies` with `peerDependenciesMeta`, loaded by dynamic `import()` with a clear error naming the package to install). Keep the repo's catalog for internal pins; published ranges use `^`. Record each decision and its reason in `docs/DEPENDENCIES.md`.

## Acceptance

- A table in the delivery: each dependency, class, before → after, reason.
- A test proves a missing optional dependency produces an error naming the package to install, not a crash.
- `bun install && bun run check && bun test` pass at the root; `bun pm pack --dry-run` in `packages/luciole` still passes.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/luciole-deps-diet/`.
