# Mission license-check — a licence check over every shipped dependency

Role: worker
Agent: airtty-license-check
Brief version: v2
Base: main @ f80912e
Branch: mission/license-check
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

A script proves that every dependency luciole, @luciole/flow and @luciole/editor ship (transitive, production only) carries a licence compatible with MIT distribution, and the attributions it needs exist.

## Scope

Owned: new `scripts/licenses.ts` and its test, a `licenses` script and a `license: "MIT"` field in root `package.json`, a `## Licences` section of `docs/DEPENDENCIES.md`, a new `THIRD_PARTY_NOTICES.md` if required.
Frozen: dependency versions.
Out of bounds: other root `package.json` scripts, `packages/*/package.json`, CI (a later release mission wires it).

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

Read installed `node_modules/**/package.json` (and `bun.lock` for the graph); classify: permissive (MIT, ISC, BSD-*, Apache-2.0, 0BSD, Unlicense, CC0, BlueOak), weak copyleft needing notice (MPL-2.0, LGPL-*), blocking (GPL, AGPL, SSPL, missing, "SEE LICENSE IN"). Known: `@resvg/resvg-wasm` is MPL-2.0 (luciole dep); `sharp` pulls libvips (LGPL) — find out whether luciole ships it or only an example does; `@anthropic-ai/claude-agent-sdk` is proprietary but only used by private `harness` and examples — the script must report it scoped as non-shipped, not fail on it. Exit non-zero only for a blocking licence in a shipped package's production tree.

## Acceptance

- `bun run licenses` exits 0 and prints a table per shipped package (paste it).
- A test proves it exits non-zero for a fixture tree with a GPL dependency.
- `docs/DEPENDENCIES.md` `## Licences` lists every non-permissive licence found and why it is acceptable.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/license-check/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
