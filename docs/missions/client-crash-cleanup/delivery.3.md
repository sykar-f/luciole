# Delivery client-crash-cleanup @ 8f71b366137045c400d8126d72b4fd6570ec311f (round 3)

Status: DONE
Summary: Comment-only change in vt/pty.ts: the exit cleanup is described as SIGKILL to the child's process group, then closing the PTY master, which hangs up the session leader and the foreground group; a job that left the group and ignores SIGHUP survives.
Deviations from the brief: none beyond earlier rounds.
Verification: bun run check && bun run lint && bun run format:check → pass on 8f71b366137045c400d8126d72b4fd6570ec311f.
Tests: tests/client-crash.test.ts, tests/terminal.test.tsx, tests/desktop.test.ts, tests/desktop-session.test.ts, tests/dev-supervisor.test.ts, tests/socket-timeout.test.ts, tests/lifetime.test.ts, tests/sandbox-entry.test.ts
Risks: none; no code changed. desktop and dev-supervisor time out under host load at 20 s, dismissed by the round 2 triage.
Merge notes: as round 1.
Findings addressed: pty.ts:97 — comment now states exactly the signals sent.
