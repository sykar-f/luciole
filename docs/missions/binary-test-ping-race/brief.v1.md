# Mission binary-test-ping-race — the binary test's ping watch stops sleeping

Role: worker
Agent: airtty-binary-test-ping-race
Brief version: v1
Base: main @ f80912e
Branch: mission/binary-test-ping-race
Prerequisites: none
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: no

## Goal

`tests/binary.test.ts` (~303-312) passes or fails on the code only. It uses the pattern load-sensitive-tests removed from `tests/lifetime.test.ts`: `Bun.sleep(300)` standing for "the ping baseline is set", then a watch with `LUCIOLE_PING_MS: "100"`, so a loaded host can flap it.

## Scope

Owned: `tests/binary.test.ts`.
Frozen: `packages/luciole/src/connect.ts` and what the test asserts.
Out of bounds: every other file.

## Context

Never publish anything. Read how load-sensitive-tests fixed lifetime (landed on main: `git log --grep "ping through a fetch that sets no deadline"`, `docs/missions/load-sensitive-tests/`): `connect.ts` now starts reachable and reports a failing first ping, and ignores stale answers, so the sleep is no longer needed; the fake-ssh path of this test may need the Server's answers held by the test rather than timed. No retry, no skip, no timeout merely enlarged.

## Acceptance

- No `Bun.sleep` used as a synchronisation point remains in the ping part of the test (diff).
- The test passes 20 consecutive runs alongside 100 busy loops (paste command and counts).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/binary-test-ping-race/`.
