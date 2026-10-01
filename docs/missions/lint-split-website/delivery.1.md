# Delivery lint-split-website @ c011b53998dcefb9a4137b7c3389c42a29b78e2c (round 1)

Status: DONE_WITH_CONCERNS
Summary: The root oxlint no longer lints `website/`: `.oxlintrc.json` ignores `website/**` and the guide overrides moved to `website/oxlint.website.json` (extends the root config; same rules, none relaxed, no new disable comment). `bun run lint` in `website/` (root alias `lint:website`) runs it with the root's oxlint binary; CI runs it right after `website/`'s install and `astro sync`, on both OSes. In a clean clone the root lint was failing on `File 'astro/tsconfigs/strict' not found` and `no-unsafe-*` in `astro.config.mjs`.
Deviations from the brief:
- New file `website/oxlint.website.json` (not in Owned): the website lint needs its own config. It is deliberately not named `.oxlintrc.json`: oxlint discovers nested configs by that name and a first attempt re-linted `website/` from the root (caught in the fresh worktree, then renamed).
- `docs/TOOLING.md` (not in Owned): one paragraph on CI described the old arrangement and became false; updated.
- The full `bun run verify` in the fresh worktree does not end green: check, lint and format:check pass, then 2 tests fail, both wall-clock tests unrelated to this diff (see Risks).
Verification:
Fresh worktree of `c011b53998dcefb9a4137b7c3389c42a29b78e2c`, `bun install --frozen-lockfile` at the root only; `website/` has no node_modules and no .astro:
```
$ bun run lint
$ oxlint --deny-warnings --ignore-pattern 'packages/desktop/src/{host/index,view/index,protocol}.ts' --ignore-pattern packages/desktop/electrobun.config.ts .
(exit 0, no diagnostics)
```
(A first attempt, with the website config named `.oxlintrc.json`, still failed here with the original errors: oxlint picked it up as a nested config. Hence the rename.)
With `website/` installed and synced (`bun install --frozen-lockfile && bunx astro sync` in `website/`):
```
$ bun run lint:website
$ bun run --cwd website lint
$ ../node_modules/.bin/oxlint --deny-warnings -c oxlint.website.json .
(exit 0, no diagnostics)
```
Checked that it really lints: a temporary `website/src/zz.ts` with `Math.max(1, 12345)` gives `eslint(no-magic-numbers)` and exit 1; without the two guide overrides, `build.astro` fails on no-magic-numbers (so the overrides are live). The root lint with `website/` installed no longer looks at it.
Full `bun run verify` in the fresh worktree (tail):
```
$ bun run check && bun run lint && bun run format:check && bun test --timeout 20000 --parallel=4 && bun run build
(check, lint, format:check: pass)
 706 pass
 3 skip
 2 fail
Ran 711 tests across 121 files. [184.58s]
error: script "verify" exited with code 1
```
Failures: tests/lifetime.test.ts "pings follow a Server going away and coming back" and tests/notes.test.tsx "a slow save is said to be slow, then unconfirmed…" (timed out in `until`, 5 s). Host load average was 60-104 (other sessions). Re-run of those two files alone: lifetime passed, notes failed again (load still ~64); on the base 6991973, notes.test.tsx passed (5 pass) once. The diff touches no code these tests reach, so I read it as load sensitivity, not as a regression, but I did not prove it; I did not rerun until green. `bun run build` was not reached because of the failed tests.
Tests: none — the change is lint configuration, package scripts, CI and a doc paragraph; no test exercises any of them (the two failures above are not tests of this change).
Risks:
- `website/` is no longer in `bun run verify` or `verify:fast` (frozen scripts); its lint is guaranteed by CI's website step only, as asked.
- The root `overrides` entries for `website/src/pages/guide/*.astro` are gone; the website config is the one place to edit them.
- tests/notes.test.tsx "slow save" (4 s save, 3.5 s timeout, 5 s `until`) and tests/lifetime.test.ts look sensitive to host load; see the spinoff in the inbox.
Merge notes: `.oxlintrc.json` (ignorePatterns, overrides), `package.json` scripts block, `.github/workflows/ci.yml` website steps, `docs/TOOLING.md` CI paragraph. No order constraint.
