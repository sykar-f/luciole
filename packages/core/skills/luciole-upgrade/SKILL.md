---
name: luciole-upgrade
description: Upgrade a luciole app to a newer luciole release — bump every @luciole-sh/* package together, adapt the code to the breaking changes, refresh the agent skills, rebuild. Use when the user asks to upgrade, update or bump luciole, or to finish an upgrade they started.
disable-model-invocation: true
---

# Upgrade a luciole app

Run every command from the app's directory. The upgrade guide is
`node_modules/@luciole-sh/core/docs/reference/releases.md`; this skill adds what it leaves out.

1. **Versions.** The installed version is `version` in
   `node_modules/@luciole-sh/core/package.json`, not the range in `package.json`. The target is
   the one the user names, else `npm view @luciole-sh/core version`.
2. **Keep the old docs.** Before installing anything, copy them aside; the install replaces
   them:

   ```sh
   cp -R node_modules/@luciole-sh/core/docs "$TMPDIR/luciole-docs-<installed>"
   ```

   When the user already installed the new version, the old one is in
   `git show HEAD:bun.lock`, and its docs are the pages under `website/src/content/docs/` at
   the tag `v<old>` of `sykar-f/luciole`.

3. **Read what changed** between the two versions: the entries marked **Breaking** in
   [CHANGELOG.md](https://github.com/sykar-f/luciole/blob/main/CHANGELOG.md), and in the notes
   of each release in between, `gh release view v<version> -R sykar-f/luciole`, when the
   network allows. The package ships no CHANGELOG. Offline, or as a complement, diff the docs after step 5:
   `diff -ru "$TMPDIR/luciole-docs-<installed>" node_modules/@luciole-sh/core/docs`.
4. **Bump every luciole package in one command**, to the same version: each `@luciole-sh/*`
   and `luciole.sh` that `package.json` lists. A patch: `bun update <packages>`. A minor
   before 1.0 (0.1.x → 0.2.0): `bun add @luciole-sh/core@^0.2.0 @luciole-sh/markdown-editor@^0.2.0`.
   Plain `bun update` never crosses a 0.x minor.
5. **Install**, then **check the renderer pins**. The app pins `@opentui/core`,
   `@opentui/keymap` and `@opentui/react` to one exact version, which must satisfy the range
   the new core asks for. When `node_modules/@luciole-sh/core/node_modules/@opentui/core`
   exists, the pins fell outside that range and the app runs two renderers; `tsc` then reports
   "Types have separate declarations" on `@opentui/core` types. Set all three pins
   to the `version` of that nested copy's `package.json`, run `bun install` again, and check
   that the nested folder is gone.
6. **Verify**: `bun run verify`. Fix each failure from the new docs, starting with
   `node_modules/@luciole-sh/core/docs/reference/api.md` and the Breaking entries of step 3.
7. **Refresh the agent material**, then check it:

   ```sh
   bunx luciole skills --agent <targets>
   bunx luciole skills status --agent <targets>
   ```

   `<targets>` lists the folders the app already has: `agents` for `.agents/skills`, `claude`
   for `.claude/skills`, both as `agents,claude`. `status` must exit 0; 3 means stale or
   missing.

8. **Rebuild** with `bun run build`, then restart a running `luciole dev`. For a hosted
   Server, follow `node_modules/@luciole-sh/core/docs/guides/host-a-server.md`.

Report to the user: the old and new version, each Breaking change and how the code now meets
it, and any file `luciole skills` left alone.

## Gotchas

- `luciole skills` without `--agent` writes both `.agents/skills` and `.claude/skills`, and
  `status` without it checks both. Name the same targets in both commands.
- A sandbox may keep `.agents/` read-only (Codex's `workspace-write` does): when
  `luciole skills` fails with `EPERM`, finish the other steps and give the user the two
  commands of step 7 to run. Hand-editing the copies leaves them "modified locally".
- `luciole skills` leaves a skill file the user edited and warns, and `status` then reads
  "modified locally" and still exits 0. List those files for the user; use `--force` only
  with their consent.
- A Client and a Server from two builds fail with a 409, "Incompatible build". Deploy the
  Server and hand out the Clients from one new build, and restart both.
- Commit `.agents/`, `.claude/`, `AGENTS.md` and `CLAUDE.md` with the upgrade: they are plain
  copies meant to be versioned.
