<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="website/public/mascot/readme-light.png" />
    <img src="website/public/mascot/readme-dark.png" width="172" height="226" alt="The luciole mascot: a pixel-art firefly hugging its glowing lantern" />
  </picture>
</p>

# luciole

Build terminal apps with React. Typing and scrolling stay local; the server keeps
the data and runs model calls.

luciole is a React Server Components framework for the terminal. Pages render on a
Server and reach a separate Client as a React Flight stream; the Client draws them
with [OpenTUI](https://github.com/anomalyco/opentui). Typing, scrolling and hover are
handled on the Client, without a round trip to the Server
([`tests/latency.test.tsx`](tests/latency.test.tsx) checks this under 500 ms of
simulated latency). Navigation uses TanStack Router.

> **Status: experimental, version 0.x.** luciole is published on npm. Its documentation
> is at **<https://luciole.sh/docs/>**. Until 1.0, a minor release may break the API. Each
> break is listed in the [CHANGELOG](CHANGELOG.md) and marked **Breaking**. What is tested
> and what is not: <https://luciole.sh/status/>.

## Get started

You need [Bun](https://bun.sh) 1.4.2 or newer, on macOS or Linux.

```sh
bunx luciole.sh init my-app
cd my-app
bun install
bun run dev
```

`bun run dev` builds the Server and the Client, starts both and opens the app in your
terminal. Ctrl+C quits and restores the terminal. The same steps, explained, are in
[Getting started](https://luciole.sh/docs/getting-started/).

The two libraries install on their own: `bun add @luciole-sh/flow-graph` and
`bun add @luciole-sh/markdown-editor`.

## From a clone (contributors)

To work on luciole itself, run it from a clone:

```sh
git clone https://github.com/sykar-f/luciole.git
cd luciole
bun install --frozen-lockfile
bun packages/core/src/cli.ts init ../my-app
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the checks and the commit rules.

## What runs where

- **The `luciole` CLI and development require [Bun](https://bun.sh)** 1.4.2 or newer
  (`engines` in `packages/core/package.json`; CI runs 1.4.2). luciole uses
  `Bun.Terminal`, `Bun.serve`, `Bun.build` and `bun:sqlite`, among others.
- **`@luciole-sh/flow-graph` and `@luciole-sh/markdown-editor` have no Bun dependency.**
- **A compiled Client runs without Bun.** CI tests it in Debian and Alpine containers
  ([`scripts/linux-client.ts`](scripts/linux-client.ts)).
- **Operating systems:** CI covers macOS and Linux
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Windows is untested.
- **Desktop app:** `packages/desktop` is an experimental prototype for macOS arm64
  only. It is unsigned and not published (see [docs/DESKTOP.md](docs/DESKTOP.md)).

```text

 TERMINAL / FORGE · Connected

 ┌─ forge ────────────────────┐  acme / payments  ·  visited #1
 │ @alice · maintainer        │  #1   Conversation    Files    Checks   tab next tab · shift+tab previous
 │ Alice Martin               │  #1 Add idempotency keys to refunds
 │                            │  ⇄ merged · @alice merged feature/refund-idempotency into main · revision 1 · +43 −8
 │ [i] Inbox                  │
 │ [1] payments (2)           │  ┌─ @bob · description ──────────────────────────────────────────────┐   ┌─ merge ────────────────────────┐
 │ [2] web (1)                │  │ Refund retries currently move money twice when the first response │   │ Merged by @alice               │
 │                            │  │ is lost.                                                          │   │ Approvals: @alice              │
 │ Drafts 0/32 unsaved        │  │                                                                   │   │ Checks: ✓ ✓ ✓                  │
 │                            │  │ Change                                                            │   │ · Pull request is merged       │
 │                            │  │                                                                   │   │                                │
 │                            │  │ - refund() requires an idempotencyKey (UUID).                     │   │                                │
 │                            │  │ - The outcome is stored in the same transaction as the ledger     │   │                                │
 │                            │  │ entry.                                                            │   │                                │
 │                            │  │ - A retry with the same key returns the stored outcome.           │   │                                │
 │                            │  │                                                                   │   │                                │
 │                            │  │ Not in scope                                                      │   │                                │
 │                            │  │                                                                   │   │                                │
 │                            │  │ Partial refund aggregation stays in the settlement job.           │   │                                │
 │                            │  └───────────────────────────────────────────────────────────────────┘   │                                │
 │                            │                                                                          │                                │
 │                            │  @carol · 22 d ago                                                       │                                │
 │                            │    Does a retry with a different amount but the same key return the      │                                │
 │                            │    first outcome too?                                                    │                                │
 │                            │                                                                          │                                │
 │                            │  ✓ @alice approved revision 1 · just now                                 │                                │
 │                            │                                                                          │ [e] edit description           │
 │                            │  @alice · just now                                                       │ [c] comment                    │
 │                            │    Ship it                                                               └────────────────────────────────┘
 │                            │
 │                            │  Merged #1 into main
 │                            │
 │ i inbox · u back · ? keys  │
 └────────────────────────────┘  e edit · c comment · j scroll

 ctrl+c quit · ctrl+l sign out · ctrl+r refresh
```

_The Forge example after a merge, in a 140×40 terminal. This frame is captured from
a real PTY by [`scripts/pty/forge.ts`](scripts/pty/forge.ts)._

## Run an example

The examples are not published on npm. They live in this repository, at the git tag of
the installed release (`v<version>`).

From an installed release, the launcher asks you to trust the repository (`--yes`
accepts):

```sh
bunx luciole.sh example           # lists the examples of this release
bunx luciole.sh example notes     # Notes: cloned, installed from the lock, built and run
```

The examples are `agent`, `chat`, `coder`, `files`, `flow`, `forge`, `latency`, `mdreader`,
`mux`, `notes` and `studio`. Only `example <name>` expands to the repository: a bare
`luciole notes` is an npm package name, and `notes` there is not ours.

From a clone, run Forge, the example shown above:

```sh
bun run forge
```

`bun run forge` builds the Forge example, starts its Server and Client, and creates
`forge.sqlite` in the current directory. Sign in as `alice`, `bob` or `carol`, PIN
`forge`. Ctrl+C quits and restores the terminal. Keys and a guided tour are in
[docs/FORGE.md](docs/FORGE.md) (French).

To see the difference between local and remote work, add a simulated round trip of
500 ms to every request:

```sh
LUCIOLE_LATENCY_MS=500 bun run forge
```

Other examples, run from the root of the clone:

| Command                     | Example                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `bun run dev`               | Notes: Markdown notebook, by mouse, SQLite on the Server            |
| `CHAT_DEMO=1 bun run chat`  | AI chat with a scripted offline model (no API key)                  |
| `bun run files`             | File explorer of the current directory                              |
| `bun run mdreader`          | Markdown reader for the `.md` files of the current directory        |
| `bun run mux`               | Local programs side by side, each on its own PTY                    |
| `bun run studio -- -H fake` | Describe an app, watch it written and running (scripted)            |
| `bun run flow`              | A CI pipeline on a node canvas (`@luciole-sh/flow-graph`), run live |

The `chat`, `agent`, `coder` and `studio` examples talk to real models or coding agents once
configured; see their READMEs in [`examples/`](examples/).

## Documentation

The documentation is at **<https://luciole.sh/docs/>**, in English.

The `docs/` folder holds the maintainers' design notes. They are in French and record
why the code is the way it is:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): repository layout and runtime roles.
- [docs/API.md](docs/API.md): public API.
- [docs/BOUNDARIES.md](docs/BOUNDARIES.md): what may run on the Client and on the Server.
- [docs/ROUTER.md](docs/ROUTER.md): navigation and layouts.
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md): builds, binaries and the generic Client.
- [docs/VALIDATION.md](docs/VALIDATION.md): what is tested, and the known limits.

## Development

```sh
bun run verify    # types, lint, format, tests and build
```

Cutting a release is described in [docs/RELEASING.md](docs/RELEASING.md) (French).

## License

[MIT](LICENSE). The `coder` and `studio` examples depend on `@anthropic-ai/claude-agent-sdk`, whose
license is not OSI-approved; see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).
