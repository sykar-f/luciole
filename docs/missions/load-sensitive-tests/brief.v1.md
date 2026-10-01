# Mission load-sensitive-tests — two wall-clock tests stop depending on host load

Role: worker
Agent: airtty-load-sensitive-tests
Brief version: v1
Base: main @ 6991973
Branch: mission/load-sensitive-tests
Prerequisites: none
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

`tests/notes.test.tsx` ("a slow save is said to be slow, then unconfirmed…") and `tests/lifetime.test.ts` ("pings follow a Server going away and coming back") pass or fail on the code only, never on host load. Both failed in a full `bun run verify` of a fresh worktree under load average 60-104 (notes failed again alone; it passed once on base 6991973). A test that passes and fails on the same code is a defect: the main sweep runs the full suite after every merge and would go red on them.

## Scope

Owned: `tests/notes.test.tsx`, `tests/lifetime.test.ts`, `tests/helpers.ts` (`until`), and, only if the root cause is there, the production code those tests drive (say which and why in the delivery).
Frozen: what each test asserts (the behaviour: slow save reported as slow then unconfirmed; pings following a Server that leaves and returns).
Out of bounds: every other test; `.oxlintrc.json`, `package.json`, CI (another mission).

## Context

The audit of the failing runs: notes waits on real clocks (a 4 s save against a 3.5 s timeout and a 5 s `until`); lifetime sleeps 300 ms before stopping the Server. Find the root cause first (which wait loses its race under load, and why), then remove the dependency on wall-clock margins: inject or fake the clock, wait on the event instead of a duration, or derive every deadline from one another so their order holds under any slowdown. Never fix by retrying, skipping, or just widening timeouts. Bun 1.4.2 `spawnSync` can lose child exits (bun#34069): use the repo's async helpers.

## Acceptance

- The delivery names the root cause of each failure, with the line that races.
- Under artificial load (e.g. `stress`-like busy loops on every core, or `bun test --parallel=16` of the whole suite alongside), each test file passes 20 runs in a row: paste the command and counts.
- No timeout in the two tests was only enlarged (diff).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/load-sensitive-tests/`.
