# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/).

## Stability

Until 1.0, the API may change in a minor release (0.x). A patch release (0.x.y) does
not break it. Each break is listed in its release under **Changed** or **Removed**,
and marked **Breaking**.

## [Unreleased]

### Added

- `useProgramStatus` in `@luciole-sh/core/client` reports working, permission waits,
  completion and errors to supporting terminals, with isolated records for embedded
  panes. Agent and coder report their turns through it.

- `syntaxStyle(styles, renderer)` in `@luciole-sh/core/client` creates a syntax
  style for one renderer.

### Changed

- **Breaking**: all three OpenTUI packages (`@opentui/core`, `@opentui/react`,
  `@opentui/keymap`) move together to 0.6.6, in native terminals, the web runtime
  and the starter. Upgrade all three app pins to 0.6.6 and rebuild both Client
  and Server: the runtime ABI changes.
- **Breaking**: native resources such as `SyntaxStyle` require an owner. Use
  `syntaxStyle(styles, renderer)` or pass `renderer.nativeScene` to the factory;
  keep resources within their renderer's lifetime. Schedule animation with
  `renderer.requestAnimationFrame()`, `createTimeline(options, renderer)` and
  `getTimelineEngine(renderer)`; OpenTUI no longer installs global animation APIs.
- **Breaking**: await `renderer.suspend()` and `renderer.resume()` around an
  external editor. After `renderer.destroy()`, await `renderer.closed` and handle
  its rejection before reusing streams or exiting. Luciole now does this on
  quit, signals and fatal setup failures. Explicit app `process.exit()` uses
  OpenTUI’s synchronous emergency restore to real stdout. Uncaught errors keep
  OpenTUI’s non-fatal behavior. Check `renderer.isDestroyed` before late native calls.
- **Breaking**: custom renderables draw through `renderSelf` or paint hooks and
  report intrinsic size with `setMeasureProvider()`. Unbuffered hooks record
  draws; use `buffered: true` for cell reads or move frame reads to a post-process
  function. Drawing coordinates and sizes must be finite integers.
- **Breaking**: removing a layout prop now restores its default, and `visible`
  set to `null` or `undefined` shows the node. Use `visible={false}` to hide it.
- Clients started inside SSH or mosh sessions now honor `TERM` and `COLORTERM`. With
  `TERM=xterm-256color` and no `COLORTERM`, colors use the 256-color palette.
  Export or forward `COLORTERM=truecolor` on the remote host for truecolor.
- **Breaking**: `markdownStyle(palette, renderer)` now requires a renderer.
  In Client components, pass the renderer returned by `useRenderer()` from
  `@opentui/react`. Syntax styles in the examples and harness are cached per renderer.

## [0.4.1] - 2026-10-16

### Added

- Pixel scroll in `@luciole-sh/markdown-editor` in the web runtime. The editor
  can stop between rows. Its scrollbar stays fixed, and a selection stays
  attached to the document as the view scrolls.

### Changed

- Pixel-scroll contract v2 keeps the frame on screen and all frames in flight
  until the host confirms what it shows. A busy host no longer causes the app
  to lose a press on the frame on screen. The app limits the frame count to
  eight and combines updates when that limit is full. Input does not wait.
  If either peer uses v1, both peers keep v1 behavior.
- Bun 1.4.1 is now the minimum for the CLI and framework, down from 1.4.2.
  A packed starter is tested on Linux at this minimum. The repository and new
  starters pin Bun 1.4.3.

### Fixed

- In the web runtime, a press just after a drag release now reaches its target,
  even before the next paint. This fix applies with or without pixel scroll.
- The web runtime now fits the terminal inside the page. The app's last row
  is no longer cut off.

## [0.4.0] - 2026-10-16

### Added

- Pixel scroll for `ScrollBox` views in the web runtime. A view can stop between
  rows, with no added inertia. Nested views pass the unused wheel delta to their
  parent at a content bound.

### Changed

- The web runtime uses pixel scroll by default. Set `pixelScroll: false` in
  `run` or `runInPage` to keep row scroll. Reduced motion, screen reader mode
  and a host without pixel scroll support also keep row scroll. Native terminals
  keep their current behavior. The `typed` event keeps its ordinary SGR format.
  The first precise wheel event over any view applies its pixel delta, without
  a prior pointer move. Only one view can hold a fraction at a time. In a view at a fraction, a Shift
  or Alt mouse down ends the fraction and does not reach the app. See
  [the web runtime details](docs/WEB.md#4-rendu-et-entrée).

### Fixed

- An interrupted first `luciole build --web` no longer leaves an incomplete
  cache that breaks later builds. Two concurrent preparations of the same web
  runtime now share the result without a cache conflict.
- Web apps that import `@luciole-sh/core/math` now start without Node built-ins.
  The optional dependency helper no longer creates a Node loader at import.
- Starters linked to a repository checkout now pin React DOM with React. This
  prevents duplicate router types that caused route type checks to fail.
- `luciole connect` now stops SSH and removes its socket directory when a signal
  ends the Client as SSH starts. The SSH process no longer stays alive after
  the Client exits.

## [0.3.2] - 2026-10-12

### Fixed

- A Server that builds a Client, such as Studio's preview, now selects the
  Client exports of core's dependencies. The Client uses TanStack Router's
  Client build even when the build process runs with `--conditions=react-server`.

## [0.3.1] - 2026-10-12

### Fixed

- Built Clients now find core's own dependencies in isolated installs. Apps no
  longer need to declare `react-server-dom-webpack`, `react-reconciler`,
  `@opentui/core` or `@opentui/react` themselves. When the installation moves,
  the Client is rebuilt with the new dependency paths.
- Builds work with `NODE_ENV=development` in the build shell, isolated installs
  included. A Client built in that environment also runs in production and no
  longer crashes on `jsxDEV`.
- Built Clients share React with their renderer when core is linked or installed
  in a separate workspace directory. The blank Client is fixed. A Server that
  builds a Client also selects React's Client exports.

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

[Unreleased]: https://github.com/sykar-f/luciole/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/sykar-f/luciole/releases/tag/v0.4.1
[0.4.0]: https://github.com/sykar-f/luciole/releases/tag/v0.4.0
[0.3.2]: https://github.com/sykar-f/luciole/releases/tag/v0.3.2
[0.3.1]: https://github.com/sykar-f/luciole/releases/tag/v0.3.1
[0.3.0]: https://github.com/sykar-f/luciole/releases/tag/v0.3.0
[0.2.0]: https://github.com/sykar-f/luciole/releases/tag/v0.2.0
[0.1.0]: https://github.com/sykar-f/luciole/releases/tag/v0.1.0
