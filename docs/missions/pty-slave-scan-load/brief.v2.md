# Mission pty-slave-scan-load — opening a PTY does not fail under load

Role: worker
Agent: airtty-pty-slave-scan-load
Brief version: v2
Base: main @ b469eeb
Branch: mission/pty-slave-scan-load
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: no

## Goal

Spawning a PTY through `spawnPty` never fails because the host is loaded. Today `newSlave` in `packages/luciole/src/vt/pty.ts` learns the slave's path by scanning `/dev` a fixed number of times (`SCAN_ATTEMPTS` × `SCAN_PAUSE_MS`, about 2 s since commit 6079e40) for the device a fresh `Bun.Terminal` opened, then throws "The new PTY's device path could not be found". Under load average ~440, tests/sandbox.test.ts "Bun and OpenTUI start confined, raw mode on their own terminal included" failed on it (2026-10-01). A user on a busy machine would hit the same error.

## Scope

Owned: `packages/luciole/src/vt/pty.ts` (the slave lookup), its tests.
Frozen: `spawnPty`'s public behaviour and signature; the exit cleanup client-crash-cleanup added in the same file (PTY registry, exit hook).
Out of bounds: every other module.

## Context

Never publish anything. Find a way to learn the slave path that does not race `/dev` against a time budget: e.g. ask the descriptor itself (`ttyname` through `/dev/fd/<n>` realpath or an equivalent on macOS and Linux, `ptsname` on the master if Bun exposes the master fd, `TIOCGPTN` on Linux), or, if a scan is unavoidable, wait on the event that makes the entry appear rather than a fixed number of tries. Explain in the delivery why the device can be missing from `/dev` at first (macOS and Linux), with evidence. Never fix by enlarging the budget. Bun 1.4.2 `spawnSync` can lose child exits (bun#34069): use the repo's async helpers in tests. The host is heavily loaded by other sessions: do not add parallel load beyond what your acceptance needs.

## Acceptance

- `newSlave` no longer gives up on a time budget, or the delivery proves why the remaining bound can never be reached by load alone (diff + reasoning).
- tests/sandbox.test.ts and the PTY tests pass; a test opens many PTYs in a row (e.g. 200) and finds every slave path.
- Works on macOS (here) and Linux (`bun run test:linux` or the Linux container scripts if available; say what you ran).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/pty-slave-scan-load/`.

## v2 changes

- Full brief (v1 was a proposal), approved by the user on 2026-10-01.
