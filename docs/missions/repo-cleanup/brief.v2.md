# Mission repo-cleanup — the public repository drops internal and obsolete material

Role: worker
Agent: airtty-repo-cleanup
Brief version: v2
Base: main @ b469eeb
Branch: mission/repo-cleanup
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: no

## Goal

Before the repository goes public, remove the internal process notes, finished experiments and agent research it accumulated, without breaking a build, a test, CI, or a reference: every comment, README or config that pointed at a removed file is rewritten to stand on its own (state the rule or fact it relied on) or repointed.

## Scope

Owned:
- Delete: `docs/HANDOFF.md`, `docs/CODER-HANDOFF.md`, `docs/COMPLEX-DEMO-HANDOFF.md`, `docs/EMBEDDING-HANDOFF.md`, `docs/LIVE-DEMOS-HANDOFF.md`, `docs/ECOSYSTEM-BUY-VS-BUILD.md`, `docs/coder/` (SPEC.md, STATUS.md, research/), `docs/streaming-markdown/` (HANDOFF.md, STATUS.md, bench/), `website/DOCS-BACKLOG.md`, and every probe under `probes/` except `probes/rsc` and `probes/rpc` (CI runs those two) — check `probes/web` like the others: delete only if nothing but comments refers to it.
- Move: `docs/studio/SPEC.md` → `examples/studio/DESIGN.md`, `docs/studio/HOSTING.md` → `examples/studio/HOSTING.md`, `docs/studio/measures/` → `examples/studio/measures/`; update every path that cites them.
- Untrack and ignore the regenerated PTY captures `docs/flow-pty-frame.txt` and `docs/forge-pty-frame.txt` (and ignore `docs/pty-frame.txt`), like `examples/chat/pty-frame.txt`; drop or replace the README links to them (`README.md` ~79-80, `examples/flow/README.md` ~75): the root README illustration becomes a fenced text block if it must stay — keep the existing frame content inline only if it is current.
- Every file that references the above: code comments (rewrite to state the rule itself, e.g. the Anthropic-subscription rule now cited from `CODER-HANDOFF.md §3.5` in tests and examples, already rewritten in packages/harness by an earlier mission), READMEs, `tsconfig.json` (`include`/`exclude` of probes), `.oxlintrc.json`, `.oxfmtrc.json`, `.gitignore`.
Frozen: behaviour of every package and example; `probes/rsc`, `probes/rpc`, `scripts/coder/*` (they regenerate test fixtures and codex types), `scripts/studio/measure.ts`, the user docs in `docs/` (`API.md`, `ARCHITECTURE.md`, `BOUNDARIES.md`, `CACHE.md`, `DEPENDENCIES.md`, `DESKTOP.md`, `DEVTOOLS.md`, `DISTRIBUTION.md`, `EMBEDDING.md`, `FORGE.md`, `ROUTER.md`, `TOOLING.md`, `VALIDATION.md`, `WEB.md`), `docs/missions/` (orch's archive; its exclusion is handled with the orch master), `website/design/`.
Out of bounds: website content (being rewritten by the owner).

## Context

Never publish anything. An inventory (consults/20261001T215646.947Z-74701-be35-consultant-repo-cleanup-claude.md in the runtime; path below) lists the references it found per file; it ran without a shell, so treat its list as a starting point and find every reference yourself with `git grep` on each removed path and basename. A file referenced only by comments may go once the comments stand alone; a file read at runtime by a test or script may not.

Inventory: /Users/sykar-f/workdir/drafts/airtty/.git/orchestra/consults/20261001T215646.947Z-74701-be35-consultant-repo-cleanup-claude.md

## Acceptance

- `git grep -nE "HANDOFF\.md|ECOSYSTEM-BUY|docs/coder|docs/streaming-markdown|docs/studio|DOCS-BACKLOG|probes/(vt-embed|devtools-tanstack|compile|sandbox|studio-server-sandbox|generic-client|inline|studio-generate|studio-preview|web)"` returns nothing (adjust the probe list to what you removed; paste the command and its empty output).
- `bun run check`, `bun run lint`, `bun run format:check` pass; `bun run probes` passes; one full `bun run verify` passes before delivery (this mission touches tsconfig and lint config), paste its tail.
- The delivery lists every deleted, moved and untracked path, and every rewritten reference.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/repo-cleanup/`.

## v2 changes

- Also delete `docs/README.fr.md` (the owner's decision) and rewrite or drop every reference to it (`README.md` ~124 at least); add it to the acceptance `git grep`.
- `docs/missions/` stays tracked and untouched by this mission: ignoring it needs a change in orch first (its archive step stages that folder explicitly).
