# Mission client-crash-cleanup — restore the terminal and kill PTY children on any client exit

Role: worker
Agent: airtty-client-crash-cleanup
Brief version: v2
Base: main @ f80912e
Branch: mission/client-crash-cleanup
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

Whatever ends a luciole Client process (signal, uncaught exception, unhandled rejection, `process.exit`), the terminal is restored and no PTY child it spawned survives it.

## Scope

Owned: `packages/luciole/src/run.tsx`, `packages/luciole/src/vt/pty.ts`, `packages/luciole/src/serve.ts`, new tests under `tests/`.
Frozen: public exports of `luciole`; the sandbox's own cleanup (`packages/luciole/src/sandbox/**`), which already works.
Out of bounds: `packages/luciole/package.json` (another mission), everything outside the three owned files except new tests.

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

Audit findings to confirm or refute by reading and testing, not to take on faith:
1. No `uncaughtException`/`unhandledRejection` handler exists in `packages/luciole/src`; only SIGTERM/SIGINT/SIGHUP call `renderer?.destroy()` (`run.tsx` ~157-183). An exception after `createCliRenderer` may leave the terminal raw or on the alternate screen — unless OpenTUI already restores it; check OpenTUI's own handlers in `node_modules/@opentui/core` first and say what you found.
2. PTY children are spawned `detached: true` (`vt/pty.ts` ~112) and only killed on React unmount (`vt/terminal.tsx` ~132); `run.tsx`'s `stop` calls `process.exit(0)` without unmounting. Fix with a registry of live PTYs in `vt/pty.ts` killed from a `process.on("exit")` handler (sandbox/spawn.ts ~144-148 shows the pattern).
3. `serve.ts` ~72 passes `stop: () => shutdown()` while `const shutdown` is declared at ~105: hoist it.
Bun 1.4.2 `spawnSync` can lose child exits (bun#34069): use the repo's async helpers in tests.

## Acceptance

- A test spawns a Client that throws after its first render and checks the terminal reset sequences were written (or proves OpenTUI does it, cited in the delivery).
- A test spawns a Client hosting a `<Terminal>` with a long-running child, sends SIGTERM to the Client, and checks the child pid is gone within 2 s.
- `shutdown` is declared before its first use in `serve.ts` (diff).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/client-crash-cleanup/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
