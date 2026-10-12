# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/).

## Stability

Until 1.0, the API may change in a minor release (0.x). A patch release (0.x.y) does
not break it. Each break is listed in its release under **Changed** or **Removed**,
and marked **Breaking**.

## [Unreleased]

## [0.3.0] - 2026-10-12

### Added

- Request cancellation helpers in `@luciole-sh/core/server`: `getSignal()`
  exposes the current request's `AbortSignal`, and `abortable()` lets a pending
  await stop when that signal aborts.
- `useLive` reducer mode folds streamed items into application state without
  retaining an item array. The documentation shows how to reconnect from the
  last cursor with a capped backoff.
- Upstream backend status reports with `UpstreamStatusProvider`,
  `usePublishUpstreamStatus` and `useUpstreamStatuses`. New apps show these
  reports beside the Client's connection status.
- Compiled TypeScript declarations for every public core export in the npm
  tarball. Each export has a `types` condition; TypeScript consumers need
  `moduleResolution: "Bundler"`.

### Changed

- **Breaking:** Cancelling a live response closes it immediately, without
  waiting for the generator's `finally` block. Cleanup runs in the background;
  use `getSignal()` and `abortable()` to interrupt a pending await and reach
  cleanup promptly.
- New apps handle rejected promises explicitly and enforce
  `no-floating-promises` with `ignoreVoid: false`. The documentation uses the
  same rejection-handling pattern.
- Startup timeouts in `@luciole-sh/core/test` now report elapsed time, child
  process state, captured output and the last observed Server startup stage.

### Fixed

- Shipped agent skills use the app's installed `./node_modules/.bin/luciole`
  instead of `bunx luciole`, which could fetch an unrelated npm package.
- Core compiles with `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess` and
  `noUnusedLocals`, without DOM types. Generated route trees import only the
  helpers they use.
- Built Servers bundle their JavaScript dependencies, so apps using isolated
  installs no longer need to declare `react-server-dom-webpack` themselves.
- Test Client waits draw streamed updates between polls instead of waiting
  until the wait ends to display them.
- A Server Function that returns nothing now resolves on the Client with
  `undefined`, instead of rejecting with an invalid-response error.

## [0.2.0] - 2026-10-09

### Added

- A public testing API, `@luciole-sh/core/test`, to build an app, start its Server
  and drive its Client in a test terminal. It provides frame waits with bounded
  timeouts, clicks, typing and named keys. `openClient` sets simulated latency
  and network faults, and gives each Client its own runtime by default; a shared
  `tag` opts into sharing unsaved text and routes. New apps include an example test.
- Offline Markdown documentation in `@luciole-sh/core/docs`, with an index and
  links between pages, matching the installed release.
- `luciole skills` installs versioned skills in `.agents/skills` and
  `.claude/skills`, an app-specific `AGENTS.md` block and a `CLAUDE.md` import.
  Install, status and remove commands track owned files and preserve user edits;
  dev and build warn when the installed skills are stale. The installed files
  pass a starter's formatter, and formatting the managed block does not make it
  appear edited.
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

### Changed

- **Breaking:** Server instrumentation can emit a new, non-terminal `failure`
  event when a page render fails. Consumers that exhaustively handle
  `ServerEvent` must handle this variant without treating it as the end of the
  response body.

### Fixed

- A failed Server page render now leaves a trace with its call ID, route and
  error name in the Server log. Instrumentation receives the error message in a
  failure event, shown in DevTools.
- A cancelled response body ends once in instrumentation, and cancelling a
  streaming page reaches the Flight render, including on Node.
- The restore guide uses `Input`'s `onInput`, and the hosting guide includes
  `--native-dir` when building for another target.

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

[Unreleased]: https://github.com/sykar-f/luciole/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sykar-f/luciole/releases/tag/v0.3.0
[0.2.0]: https://github.com/sykar-f/luciole/releases/tag/v0.2.0
[0.1.0]: https://github.com/sykar-f/luciole/releases/tag/v0.1.0
