# Mission flow-editor-pack — @luciole/flow and @luciole/editor pack into working tarballs

Role: worker
Agent: airtty-flow-editor-pack
Brief version: v1
Base: main @ 6991973
Branch: mission/flow-editor-pack
Prerequisites: none
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: no

## Goal

`@luciole/flow` and `@luciole/editor` produce tarballs a consumer can install and import, under Bun and under Node, with types. Today their `exports` point to `./dist/index.js` / `./dist/index.d.ts` but nothing builds `dist` at pack time (only a `build` script, no `prepack`), and `editor` depends on `marked: "catalog:"`, which only `bun publish`/`bun pm pack` resolves (npm would ship it verbatim and the package would not install). Neither package uses any Bun API in `src/`, so they should work under Node.

## Scope

Owned: `packages/flow/package.json`, `packages/editor/package.json`, `packages/{flow,editor}/scripts/build.ts`, `packages/{flow,editor}/README.md` and `LICENSE` (create if missing), a new `scripts/pack-check.ts` and its test.
Frozen: the public API of both packages (`src/` exports); `"private": true` stays for now (a later release mission flips it).
Out of bounds: the root `package.json` (another mission edits it; run your script with `bun scripts/pack-check.ts`), `packages/luciole`, CI workflows (a later release mission wires the check into CI).

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

`scripts/pack-check.ts` takes package directories as arguments; for each it runs `bun pm pack` into a temp dir and fails unless: the tarball's `package.json` has no `workspace:` or `catalog:` spec; every target in `exports`, `types`, `main` and `bin` exists in the tarball; the tarball holds no tests, no `src/**/*.test.*` and nothing outside `files`. Then it installs the tarball (plus peers) in a temp project and imports every export once under `node` and once under `bun`. A later mission reuses this script for `luciole` and wires it into CI, so keep its CLI simple and documented in its header comment.

## Acceptance

- `bun scripts/pack-check.ts packages/flow packages/editor` exits 0 (paste output); it fails (exit ≠ 0) on a fixture with a `catalog:` dependency, covered by a test you declare.
- Both `package.json` have `prepack` building `dist`, `files`, `engines` (node and bun), `license`, `repository`, `sideEffects`.
- Both packages have a README (install, minimal example, peers) and a LICENSE (copy of the root MIT LICENSE).

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/flow-editor-pack/`.
