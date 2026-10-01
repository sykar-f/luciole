# Delivery community-files @ eb95586 (round 1)

Status: DONE
Summary: SECURITY.md (private reporting via GitHub advisories; PTY, sandbox, dev server in scope), CONTRIBUTING.md (setup, website install, verify, commit convention), CHANGELOG.md (Keep a Changelog, Unreleased from the README). README status block now states Bun 1.4.2 for development and CLI, flow/editor Bun-free, compiled Client without Bun (Debian and Alpine), macOS and Linux CI, Windows untested, desktop experimental macOS-arm64 unsigned, examples from the monorepo root. ci.yml: `name: MVP` → `CI`.
Deviations from the brief: none. "Experimental" line and "No package is published" kept.
Verification: bun run check (25/25), bun run lint, bun run format:check → pass. Commands cited in the new files, all present: `bun install --frozen-lockfile`, `bun run verify`, `check`, `lint`, `format:check`, `format`, `build`, `bun test`, `bun run test`, `bun run forge`; `scripts/linux-client.ts`, `docs/DESKTOP.md`, `docs/BOUNDARIES.md`, `website/` (own package.json and bun.lock).
Tests: none — documentation and a workflow name only, no code exercised
Risks: the SECURITY advisories URL assumes the repo is sykar-f/luciole (as in the README clone URL); the "sandbox" scope item is generic wording.
Merge notes: README.md status block only; ci.yml line 1 only.
