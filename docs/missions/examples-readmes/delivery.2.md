# Delivery examples-readmes @ ac83a4a938a81499739c5ba998737b7e90d39d36 (round 2)

Status: DONE
Summary: every fix of triage 1 applied. Verification commands in agent/chat/files now use root scripts (bun run check / lint / format:check); coder's CODER_CWD presented as a suggested value; notes NOTES_DELAY_MS limited to saveNote; forge's post-login screen is the Inbox (app/(app)/page.tsx InboxPage); studio lists git as a prerequisite; forge and notes web tests list Chrome (CHROME=) and, for notes, Zig (ZIG=).
Deviations from the brief: none.
Verification: bun run format:check pass after oxfmt on the READMEs (docs only; check/lint unaffected since round 1).
Tests: none — documentation only
Risks: none beyond round 1.
Merge notes: only examples/*/README.md.
Findings addressed: all six `fix` items above; the two dismissed ones need nothing.

## Timed-out PTY tests (for the master to carve)

Both pass/fail on unmodified main code (this mission changes READMEs only).
- `bun run test:pty:coder`: round 1, run alone, host load average ~550: `error: the screen never showed "scripted demo is ready"` (driver.ts:356 waitFor), screen blank. Re-run at load ~450: passes (all keys true). Load-sensitive timeout.
- `bun run test:pty:studio`: fails in both runs (load ~550 and ~450): `error: the screen never showed "Revision r1 built and running."` at scripts/pty/driver.ts:356. The screen at failure shows the header "studio · demo · powered by scripted demo · r1 ✓" and the right pane "r1 · sandbox … Hello from studio / Count: 1 (press + to increment)": the revision is built and running, but the awaited message never appears in the conversation pane. Raw logs: scratchpad r2-studio.log of this session. Not a load-only failure: consistent across two runs.
- `bun run test:pty:files` fails with Module not found .luciole/server/index.js if `build --app examples/files` was not run first; passes after it (documented in files/README.md).
