# Delivery optional-test-isolation @ cde9916960c2300e75d5ac64dec7a2a5a199064b (round 1)

Status: DONE
Summary: tests/optional.test.ts builds the app under the first base directory (tmpdir(), /tmp, /var/tmp) with no ancestor whose node_modules holds an optional package, and asserts that premise (ancestor walk, then Bun.resolveSync of each package from the app root throws) before the behaviour. No skip, no retry.
Deviations from the brief: none
Verification: bun run check, bun run lint, bun run format:check → pass. TMPDIR=$PWD/.sweep/tmp bun test tests/optional.test.ts → 6 pass, 0 fail; default TMPDIR → 6 pass, 0 fail.
Tests: tests/optional.test.ts
Risks: if no candidate base is free of the packages the test throws with the list of candidates tried.
Merge notes: none
