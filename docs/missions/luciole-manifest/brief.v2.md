# Mission luciole-manifest — luciole's manifest declares what it is and ships only what it needs

Role: worker
Agent: airtty-luciole-manifest
Brief version: v2
Base: main @ f80912e
Branch: mission/luciole-manifest
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

`packages/luciole/package.json` describes a Bun-only package honestly and `bun pm pack` yields a clean tarball. The package name and `private` flag stay as they are: the npm name `luciole` is taken by an unrelated package, and the owner is choosing the published name.

## Scope

Owned: `packages/luciole/package.json`, new `packages/luciole/README.md` and `packages/luciole/LICENSE`, shebangs of `packages/luciole/src/cli.ts` and `src/luciolex.ts`.
Frozen: `name`, `private`, `version`; dependency versions (another mission rethinks the dependency set); `src/` code apart from the shebang lines.
Out of bounds: `src/commands/init.ts` and `scripts/clean-install.ts` (a later mission), `run.tsx`/`vt/pty.ts`/`serve.ts` (another mission), root `package.json`.

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

luciole publishes TypeScript sources (`bin` → `./src/cli.ts`, `exports` → `src/*.ts(x)`) and uses Bun APIs in 47 of 214 source files (Bun.Terminal, Bun.serve, Bun.build, bun:sqlite…): it is Bun-only by design, declare it. Add `engines: { bun: ">=1.4.2" }`, `files` (src without tests, `native/` only if needed at runtime — check), `repository` (`github.com/sykar-f/luciole`, directory `packages/luciole`), `license`, `"./package.json"` in `exports`, `sideEffects` (find which modules have side effects). Move `react` and `react-dom` from `dependencies` to `peerDependencies` (`@luciole/flow` and `editor` already peer React; two copies break hooks); every workspace already declares react itself. Check `#!/usr/bin/env bun` on both bins.

## Acceptance

- `bun pm pack --dry-run` in `packages/luciole` lists no test file and nothing outside `files` (paste the list).
- `react`/`react-dom` are peers; `bun install && bun run check && bun test` pass at the root.
- Both bin files start with `#!/usr/bin/env bun`.
- README covers install requirements (Bun), `luciole init`/`dev`/`build`, and links the root README.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/luciole-manifest/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
