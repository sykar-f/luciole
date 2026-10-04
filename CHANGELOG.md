# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/).

## Stability

Until 1.0, the API may change in a minor release (0.x). A patch release (0.x.y) does
not break it. Each break is listed in its release under **Changed** or **Removed**,
and marked **Breaking**.

## [Unreleased]

## [0.1.0] - 2026-10-04

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

[Unreleased]: https://github.com/sykar-f/luciole/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sykar-f/luciole/releases/tag/v0.1.0
