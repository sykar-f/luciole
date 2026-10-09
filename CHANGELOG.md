# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/).

## Stability

Until 1.0, the API may change in a minor release (0.x). A patch release (0.x.y) does
not break it. Each break is listed in its release under **Changed** or **Removed**,
and marked **Breaking**.

## [Unreleased]

## [0.2.0] - 2026-10-09

### Added

- A public testing API, `@luciole-sh/core/test`, to build an app, start its Server
  and drive its Client in a test terminal. It provides frame waits with bounded
  timeouts, clicks, typing, named keys and simulated latency and network faults.
  New apps include an example test.
- Offline Markdown documentation in `@luciole-sh/core/docs`, with an index and
  links between pages, matching the installed release.
- `luciole skills` installs versioned skills in `.agents/skills` and
  `.claude/skills`, an app-specific `AGENTS.md` block and a `CLAUDE.md` import.
  Install, status and remove commands track owned files and preserve user edits;
  dev and build warn when the installed skills are stale.
- Six skills for coding agents: `luciole-app` for screens, routing, Server
  Functions, caching and sign-in; `luciole-tui` for native widgets, focus,
  clickable controls, menus and concise layouts; `luciole-test` for test levels,
  network failures and restore; `luciole-debug` for Client/Server diagnostics;
  `luciole-ship` for builds and deployment; and `luciole-upgrade` for moving an
  app to a newer release.
- New apps created by `luciole init`, `bunx luciole.sh init` or
  `bunx @luciole-sh/create` include the agent material by default. The standalone
  `@luciole-sh/create` scaffolder accepts `--no-skills` to opt out.
- An upstream-libraries reference explaining which OpenTUI, TanStack Router and
  TanStack Form APIs apply to luciole apps, including native widgets, typed
  Router hooks and browser-only limits.

### Fixed

- A failed Server page render now leaves a trace with its call ID, route and
  error name in the Server log. Instrumentation receives the error message in a
  failure event, shown in DevTools.
- A cancelled response body ends once in instrumentation, and cancelling a
  streaming page reaches the Flight render, including on Node.
- Each `openClient` test Client has its own runtime by default, so unsaved text
  and routes cannot leak into another Client. A shared `tag` opts into sharing.
  `press("return")` and the other documented key names send keys rather than
  typing their names.
- The testing guide now puts network conditions on `openClient`, where they
  take effect. The restore guide uses `Input`'s `onInput`, and the hosting guide
  includes `--native-dir` when building for another target.
- Installing agent material produces files that pass a starter's formatter;
  formatting the managed block does not make it appear edited.

## [0.1.0] - 2026-10-06

First public release, on npm. Five packages share this version: `luciole.sh`,
`@luciole-sh/core`, `@luciole-sh/create`, `@luciole-sh/flow-graph` and
`@luciole-sh/markdown-editor`. The documentation is at <https://luciole.sh/docs/>.

### Added

- React Server Components for the terminal: pages render on a Server and reach a
  separate Client as a React Flight stream, drawn with OpenTUI.
- Typing, scrolling and hover handled on the Client, without a round trip to the
  Server.
- Navigation with TanStack Router.
- `bunx luciole.sh init my-app` creates an app. `bunx @luciole-sh/create my-app` does
  the same.
- The `luciole` CLI (Bun 1.4.2 or newer) to develop, build and run apps, including compiled
  Client binaries that run without Bun.
- `@luciole-sh/flow-graph`, a node-canvas library, and `@luciole-sh/markdown-editor`, an editor library,
  both without a Bun dependency.
- Examples, not published on npm: `luciole example <name>` runs them from git, at the
  tag of the release. They also run from a clone. They are Forge, Notes, chat, files,
  mdreader, mux, studio and flow.
- An experimental, unsigned macOS arm64 desktop prototype (`packages/desktop`). It is
  not published.

### Known limits

- CI covers macOS and Linux. Windows is untested.
- macOS notarization is implemented but has never run end to end.
- No multi-user load test and no public TLS proxy test. See
  <https://luciole.sh/status/>.

[Unreleased]: https://github.com/sykar-f/luciole/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sykar-f/luciole/releases/tag/v0.2.0
[0.1.0]: https://github.com/sykar-f/luciole/releases/tag/v0.1.0
