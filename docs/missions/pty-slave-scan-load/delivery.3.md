# Delivery pty-slave-scan-load @ ee749ce (round 3)

Status: DONE_WITH_CONCERNS
Summary: tests/pty-slave.test.ts no longer holds 200 PTYs at once: 200 opened in a row, each hung up (and awaited) before the next; distinctness checked on 8 held together. pty.ts unchanged since round 2.
Deviations from the brief: none. Linux not run (no Docker here), left to CI Ubuntu per triage 1.
Verification: bun run check (25/25), lint, format:check green; the declared files run together in one bun run test (--parallel=4): 28 pass, 0 fail, sandbox test included.
Tests: tests/pty-slave.test.ts, tests/sandbox.test.ts, tests/client-crash.test.ts, tests/dev-supervisor.test.ts
Risks: Linux path unverified locally.
Merge notes: tests/pty-slave.test.ts only.
Findings addressed: sandbox test starved of PTYs by the new test: at most 8 PTYs open at once now.
