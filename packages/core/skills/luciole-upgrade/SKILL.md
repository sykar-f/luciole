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
   the new core asks for (this release: `0.8.1` for all three). When `node_modules/@luciole-sh/core/node_modules/@opentui/core`
   exists, the pins fell outside that range and the app runs two renderers; `tsc` then reports
   "Types have separate declarations" on `@opentui/core` types. Set all three pins
   to the `version` of that nested copy's `package.json`, run `bun install` again, and check
   that the nested folder is gone.
   For an app that upgrades from OpenTUI 0.6.x, complete these checks before step 6:
   - Prepare web and native runtimes again with Zig 0.17.0. Rebuild the app after
     `luciole web-runtime` or `luciole native-runtime --target <target>`.
   - ScrollBox parts are facades; children belong to the box. Replace scrollbar
     `slider` and arrow access with `scrollPosition` and viewport geometry. Check
     part options, overflow clipping and whole-cell viewport padding. `getChildrenCount()`
     counts only content rows. `primaryAxis` follows the content direction.
     Check code that counts ScrollBox children or assumes its axis.
   - Check custom editor logic, workarounds and test expectations for these changes:
     Delete, Backspace, Delete Line and selection delete remove text that contains
     only zero-width characters. Select-all in an Input or Textarea with only
     those characters still creates an empty selection. A sideways wheel step
     no longer moves truncated text by one column.
   - A zero-width or zero-height node draws nothing and receives no mouse events.
     Set `flexShrink: 0` on headers above ScrollBoxes that grow. Test resize.
   - OpenTUI caches hooks at class construction. Call `refreshHooks()` after changes
     through reflection. Assign `renderBefore`, `renderAfter` and `onLifecyclePass`
     in the constructor.
   - Keep `translateX` and `translateY` within the 32-bit float range. Values
     outside that range throw `RangeError`.
   - Browser video is unavailable. Remove `VideoRenderable` from web paths.
     Prepared native builds use no `-Drequire-video`; video is unavailable without
     an FFmpeg prefix for Zig 0.17.0.
   - Key help lists the `luciole` group first, then app layers in mount order.
     Updates keep that order. Test the help line and collisions with Runtime's
     Ctrl+C and Escape. The framework layer has priority above ordinary app layers;
     Escape then lets the app handle the key. Keep focused Terminal Ctrl+C and
     `quitOnCtrlC: false` behavior.
   - Remove `nativeSceneWorkBudget`, `NativeSceneFrame.Yield`, frame-step work
     budgets and `geometryRevision` in frame requests. A custom `RenderContext`
     must supply `clock` and `onAnimationTick`.
   - Remove reads of `_textBufferSyntaxStyle`; use styles in the text buffer.
     Replace `_hasFocusedDescendant` with `hasFocusedDescendant`, and
     `contextDrawSceneText()` with `contextDrawSceneBody()`. Replace
     `defineNativeIntegration()` with a typed static `nativeIntegration`
     description and remove its `construction` field.
   - For custom native bindings, generate them again from the 0.8.1 header.
     The context ABI is version 2. Scene statistics need 224 bytes; renderer state
     needs 40 bytes. Update scene-body calls and record fields.
   - For custom Zig code, render through a Session. Remove standalone renderer
     calls and `BufferedOutput`. Update frame-step and styled-text signatures.
   - Use a one-cell character for `customBorderChars` and `drawGrid`, such as a
     space. OpenTUI rejects default-ignorable characters.
   - For the web Server, update `@sqlite.org/sqlite-wasm` to a version that satisfies
     the new peer range, which starts at `3.54.1-build1`. Rebuild apps for the new
     TanStack Router runtime ABI key.

   Read the `luciole-tui` skill's `references/opentui.md` and the installed upstream
   boundary guide for the drawing and resource ownership rules. Keep
   `react-reconciler` at 0.33.0: 0.34.0 fails the transition test because the
   OpenTUI host config has no `suspendOnActiveViewTransition`.

6. **Verify**: `bun run verify`. Fix each failure from the new docs, starting with
   `node_modules/@luciole-sh/core/docs/reference/api.md` and the Breaking entries of step 3.
7. **Refresh the agent material**, then check it:

   ```sh
   ./node_modules/.bin/luciole skills --agent <targets>
   ./node_modules/.bin/luciole skills status --agent <targets>
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

Run `./node_modules/.bin/luciole` from the installed app’s root: it uses that version and
fails if absent, without fetching a package. Outside an app, use `bunx luciole.sh@<version>`.
