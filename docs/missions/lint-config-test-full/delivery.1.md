# Delivery lint-config-test-full @ 7f7334f (round 1)

Status: DONE
Summary: The parity test parsed both `--print-config` outputs with a Zod object that strips unknown keys, so only `typeAware` survived. The schema now uses loose objects and the first test compares the whole config minus `overrides`, `ignorePatterns` and `$schema`. The guide-override assertion is unchanged. The test still needs only the root's oxlint binary.
Deviations from the brief: none
Verification: `bun run check`, `bun run lint`, `bun run format:check` all pass. Drift proof: adding `"typeCheck": true` to `options` in `website/oxlint.website.json` only makes "website/ is linted by exactly the root's rules, options included" fail (diff shows `+ "typeCheck": true`); the file was restored afterwards. On the unchanged configs, 3 pass / 0 fail.
Tests: tests/lint-config.test.ts
Risks: a future oxlint version printing a new key that legitimately differs between the two configs would need adding to `DIFFERS_BY_DESIGN`.
Merge notes: only tests/lint-config.test.ts changed.
