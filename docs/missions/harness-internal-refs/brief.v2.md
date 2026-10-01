# Mission harness-internal-refs — harness comments stand on their own in a public repo

Role: worker
Agent: airtty-harness-internal-refs
Brief version: v2
Base: main @ f80912e
Branch: mission/harness-internal-refs
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

`packages/harness` stays an internal package (not published), but its code will be read publicly: no comment may rely on an internal handoff document to justify a rule, and its manifest is complete.

## Scope

Owned: comments in `packages/harness/src/**` (no behaviour change), `packages/harness/package.json` (add `version`, `license: MIT`, a description that says internal), `packages/harness/README.md` (create: what it is, that it is internal and Bun-only, its modes).
Frozen: all harness behaviour and exports; `"private": true`.
Out of bounds: `docs/` (whether internal docs stay public is the owner's decision), examples (another mission).

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

Six comments in `packages/` cite `docs/CODER-HANDOFF.md` or `opencode-report` (e.g. `anthropic-guard.ts:9` cites `CODER-HANDOFF.md §3.5`, `:95` cites `opencode-report §4`; also in `opencode.ts`, `opencode-schema.ts`, `detect.ts`). Rewrite each to state the rule and its reason directly (for the Anthropic OAuth rule, link Anthropic's public terms). The README documents that mode `full` maps to Codex `danger-full-access` with approval `never` (`codex.ts:94`) and what it maps to on Claude (`claude.ts` ~62-76, `MODE_TO_CLAUDE`), and that the child process inherits the full environment (`session.ts:246`, `opencode.ts` ~166).

## Acceptance

- `grep -rnE "CODER-HANDOFF|opencode-report" packages/` returns nothing.
- `git diff` of `packages/harness/src` touches comments only.
- `packages/harness/package.json` has `version` and `license`; README exists and covers modes, `full`, and env inheritance.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/harness-internal-refs/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
