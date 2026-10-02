# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project intends to follow [Semantic Versioning](https://semver.org/) once it is
released.

## [Unreleased]

First public preview. Nothing is published to a registry yet.

### Added

- React Server Components for the terminal: pages render on a Server and reach a
  separate Client as a React Flight stream, drawn with OpenTUI.
- Typing, scrolling and hover handled on the Client, without a round trip to the
  Server.
- Navigation with TanStack Router.
- The `luciole` CLI (Bun 1.4.2) to develop, build and run apps, including compiled
  Client binaries that run without Bun.
- `@luciole-sh/flow-graph`, a node-canvas library, and `@luciole-sh/markdown-editor`, an editor library,
  both without a Bun dependency.
- Examples run from the monorepo root: Forge, Notes, chat, files, mdreader, mux,
  studio and flow.
- An experimental, unsigned macOS arm64 desktop prototype (`packages/desktop`).
