# luciole

Build terminal apps with React. Typing and scrolling stay local; the server keeps
the data and runs model calls.

luciole is a React Server Components framework for the terminal. Pages render on a
Server and reach a separate Client as a React Flight stream; the Client draws them
with [OpenTUI](https://github.com/anomalyco/opentui). Typing, scrolling and hover are
handled on the Client, without a round trip to the Server
([`tests/latency.test.tsx`](tests/latency.test.tsx) checks this under 500 ms of
simulated latency). Navigation uses TanStack Router.

> **Status: experimental.** No package is published to a registry yet, APIs change
> without notice, and the name is not final. CI runs on macOS and Linux
> ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

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
a real PTY by [`scripts/pty/forge.ts`](scripts/pty/forge.ts) and saved as
[`docs/forge-pty-frame.txt`](docs/forge-pty-frame.txt)._

## Run the example locally

Requires [Bun](https://bun.sh) 1.4.2 (the version pinned in `package.json`).

```sh
git clone https://github.com/sykar-f/luciole.git
cd luciole
bun install --frozen-lockfile
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

Other examples, run from the repository root:

| Command                     | Example                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `bun run dev`               | Notes: Markdown notebook, by mouse, SQLite on the Server     |
| `CHAT_DEMO=1 bun run chat`  | AI chat with a scripted offline model (no API key)           |
| `bun run files`             | File explorer of the current directory                       |
| `bun run mdreader`          | Markdown reader for the `.md` files of the current directory |
| `bun run mux`               | Local programs side by side, each on its own PTY             |
| `bun run studio -- -H fake` | Describe an app, watch it written and running (scripted)     |
| `bun run flow`              | A CI pipeline on a node canvas (`@luciole/flow`), run live   |

The `chat`, `agent`, `coder` and `studio` examples talk to real models or coding agents once
configured; see their READMEs in [`examples/`](examples/).

## Documentation

The detailed documentation is in French for now.

- [docs/README.fr.md](docs/README.fr.md): the full original README (starter, production
  builds, compiled binaries, SSH connections, authentication, tests, limits).
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

## License

[MIT](LICENSE). The `coder` and `studio` examples depend on `@anthropic-ai/claude-agent-sdk`, whose
license is not OSI-approved; see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).
