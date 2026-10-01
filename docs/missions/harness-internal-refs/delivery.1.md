# Delivery harness-internal-refs @ 4cb8156e514739951484ef3d6ae3be578facc7c4 (round 1)

Status: DONE
Summary: Six comments citing docs/CODER-HANDOFF.md or opencode-report now state their rule directly (the Anthropic OAuth rule links Anthropic's public legal page). package.json gains version 0.1.0, license MIT and an "internal, unpublished" description. A new README covers what the package is (internal, Bun-only), the modes with their Claude/Codex mappings, `full` (Codex danger-full-access + never; Claude stays in default and the host allows each tool), and environment inheritance (including the OAuth stripping for pi and opencode).
Deviations from the brief: none. The brief's file paths for codex.ts, claude.ts and opencode.ts are under src/adapters/; line numbers matched.
Verification: bun run check, bun run lint, bun run format:check all pass; grep for CODER-HANDOFF|opencode-report in packages/ is empty; the src diff holds comment lines only.
Tests: tests/coder-anthropic-guard.test.ts, tests/coder-opencode.test.ts, tests/coder-compliance.test.ts, tests/coder-detect.test.ts
Risks: the legal-page URL is cited from memory of Anthropic's public docs; worth a glance by the owner.
Merge notes: none expected; touches only packages/harness.
