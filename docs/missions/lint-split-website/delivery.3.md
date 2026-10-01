# Delivery lint-split-website @ df551d62ed56cce361f226f64950ee4ac04bc562 (round 3)

Status: DONE
Summary: `.oxfmtrc.json` now ignores `docs/missions/**`, the archive orch land commits (agent-written Markdown, copied byte for byte), which made `bun run format:check` fail on the candidate. oxlint does not read Markdown (checked: `bun run lint` exits 0 with a badly formatted `docs/missions/x/delivery.1.md` present), so `.oxlintrc.json` and `website/oxlint.website.json` are unchanged. One commit on top of round 2.
Deviations from the brief: `.oxfmtrc.json` is outside the brief's Owned; it is the file the rework names.
Verification: before the change, a badly formatted `docs/missions/x/delivery.1.md` (`*  item`, a squeezed table) made `bun run format:check` exit 1 ("docs/missions/x/delivery.1.md … Format issues found in above 1 files"). In the fresh worktree of `df551d62ed56cce361f226f64950ee4ac04bc562` (root install only, no `website/` install) with that same file present: `bun run check` 0, `bun run lint` 0, `bun run format:check` 0 ("All matched files use the correct format"), `bun test tests/lint-config.test.ts` 3 pass / 0 fail. The scratch file was removed afterwards (tree clean).
Tests: tests/lint-config.test.ts
Risks: none beyond the archive no longer being format-checked, which is the intent.
Merge notes: `.oxfmtrc.json` ignorePatterns, one line.
Findings addressed: rework 2 (red candidate): archive ignored by oxfmt; oxlint check done, no change needed.
