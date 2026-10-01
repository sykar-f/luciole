# Delivery harness-internal-refs @ 84bf87384639a62ae0d80cebf9163cb2f79ced93 (round 2)

Status: DONE
Summary: README corrected as the three triage items required: the scripted harness refuses edits in read, asks in ask and applies in edits/full; environment inheritance lists each harness's additions (Claude Code's two variables, opencode's server credentials and OPENCODE_CONFIG_CONTENT with share disabled) and the OAuth stripping for pi and opencode; the Anthropic restriction is described as the code applies it (Anthropic models blocked, other providers usable, harness still starts).
Deviations from the brief: none.
Verification: bun run check, bun run lint, bun run format:check pass; grep for CODER-HANDOFF|opencode-report in packages/ is empty; only README.md changed since round 1.
Tests: tests/coder-anthropic-guard.test.ts, tests/coder-opencode.test.ts, tests/coder-compliance.test.ts, tests/coder-detect.test.ts
Risks: none beyond the unverified legal-page URL noted in round 1.
Merge notes: none.
Findings addressed: README:28 (fake honors modes) fixed; README:44 (opencode env overrides) fixed; README:50 (OAuth does not stop startup) fixed. Note for the master: other comments still cite docs/coder/research/*-report.md (pi, claude-code, codex), outside this brief's grep; not touched.
