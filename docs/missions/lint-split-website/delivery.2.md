# Delivery lint-split-website @ 425d3733a1836300e416e07239fd8a4cc394e11c (round 2)

Status: DONE
Summary: Same arrangement as round 1 (root ignores `website/**`, website linted by `bun run lint` in `website/`, CI step after its install and sync), but `website/oxlint.website.json` is now a full copy of the root config instead of an `extends`: oxlint's `extends` keeps only the severity of inherited rules, so `no-magic-numbers`, `no-restricted-types`, `consistent-type-assertions` and `ban-ts-comment` lost their options and the correctness category was dropped. Only the overrides (the two guide pages) and the ignores differ from the root. `tests/lint-config.test.ts` guards the copy.
Deviations from the brief: as in round 1 (new `website/oxlint.website.json`, one paragraph of `docs/TOOLING.md`), plus the new test file `tests/lint-config.test.ts`, which the triage asked for.
Verification:
Fresh worktree of `425d3733a1836300e416e07239fd8a4cc394e11c` (`bun install --frozen-lockfile` at the root only, `website/` has no node_modules nor .astro): `bun run check` exit 0, `bun run lint` exit 0 (`oxlint --deny-warnings … .`, no diagnostics), `bun run format:check` exit 0, `bun test tests/lint-config.test.ts` 3 pass / 0 fail.
Here, with `website/` installed and synced: `bun run lint:website` (`oxlint --deny-warnings -c oxlint.website.json .`) exit 0, with the full options now in force; check, lint, format:check also exit 0.
`oxlint --print-config` of both configs: rules, categories, plugins and options identical; only `overrides` and `ignorePatterns` differ. The test fails against round 1's `extends` config (2 of 3 fail), so it catches the defect found in review.
The full `bun run verify` of round 1 (tail pasted in delivery.1.md) is not rerun: since then only a config copy and a test file changed, and the 2 load-sensitive failures were dismissed in the triage.
Tests: tests/lint-config.test.ts
Risks: the copy can drift from the root config only if the test is not run; it fails on any rule, option, category, plugin or typeAware difference. A rule added to the root needs no change in the website file beyond the copy the test then demands.
Merge notes: as in round 1, plus the new tests/lint-config.test.ts. `.oxlintrc.json` changes (a rule added by another mission) must be copied into `website/oxlint.website.json`.
Findings addressed:
- [major] website config lost the rules' options: full copy, effective config equal to the root's (verified with --print-config and by the test).
- [minor] no tests declared: tests/lint-config.test.ts added (inherited options, type-aware rules, guide exceptions, root ignore), runnable without website/ installed, declared above.
