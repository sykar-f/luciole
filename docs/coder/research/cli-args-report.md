# airtty: first-class app CLI arguments and multiple Servers per project

Repo: `/Users/sykar-f/workdir/drafts/airtty` (HEAD `01c8558`). This was a read-only study; nothing in the repo was modified.
Target consumer: `examples/coder`, launched as `coder --harness claude|codex|pi|opencode [--cwd DIR] [--model M] [--mode read|ask|edits|full] [--resume [ID]] [--effort E]`, with several instances running in the same project at once.
Companion to `/private/tmp/claude-501/research/airtty-report.md`.

---

## 0. TL;DR

**A. App arguments**

- **Declaration.** Apps declare arguments in **`app/args.ts`**. It default-exports `defineArgs({ options: z.object({...}) })` from a new entry **`airtty/args`**. The schema is plain Zod 4. More generally, it can be any Standard Schema that also implements **Standard JSON Schema**, which zod 4.6.5 already does. I verified that `schema["~standard"].jsonSchema.input()` exists in the repo's zod.
- **Parsing.** The framework owns a small parser (~300 LOC, **no new dependency**). It reads the JSON Schema to build the flag grammar and help text, and runs `~standard.validate` to get typed, validated values.
- **Where it runs.** Every entry point parses the same way:
  - `airtty dev [--app d] -- <app args>`
  - `airtty ./app <app args>`
  - the compiled binary (`coder <app args>`, `coder serve … -- <app args>`)
  - `--on host`
- **Framework flags.** `--url --on --target --grace --yes --help -h --version`, plus the `serve` subcommand, are **reserved names**. The build refuses an app that declares one of them.
- **Transport and access.** The raw app argv and the invocation cwd reach the Server through the env var `AIRTTY_ARGS`. For ssh, they go on stdin instead: never on a command line, where `ps` would expose them. The Server re-parses them with the same code, because it is the authority. Server code reads them typed through `args.get()` on the definition. There is also `getArgs()`/`getLaunch()` in `airtty/server`.
- **Help and version.** `--help` is generated, with the app options first and the runtime options second. `--version` shows the package version.
- **Library choice.** No library is adopted. The comparison table is in §2. **cleye 2.7** (native Standard Schema flags) is the runner-up if we would rather buy. **Optique 1.3** is the upgrade path if we need completions or complex grammar.

**B. Multiple sessions**

- **Current behaviour.** The Server's identity is `sha256(sessionKey)[:16]`, which gives a socket in `$XDG_RUNTIME_DIR/airtty` or `/tmp/airtty-<uid>`. Session keys are `local:<dir>` for a path, `local:<name>` for a binary (**cwd ignored**), `git:<repo>` and `ssh:<host>/<name>`. A second launch attaches to the first launch's Server, with its env, argv (none today) and cwd.
- **New manifest option.** `package.json` gets `"airtty": { "server": "shared" | "per-directory" | "per-launch" }`. The default is `shared`, which keeps today's behaviour.
- **Args are part of the key in every mode.** An args fingerprint always joins the key. As a result, **one Server process has exactly one argument set**, so `args` can be a process-level constant.
- **`per-launch`** (for coder) gives each launch its own Server. The key is `…!<launchId>`.
  - Crash recovery keeps working: the launcher *claims* the dead Client's orphan session file, reusing `session.ts`'s atomic-rename takeover. That gives back the launch id, and so reattaches the still-in-grace Server with its agent still running.
  - `useLive`, reconnection, ssh and binaries need no protocol change.
- **Prerequisite fix.** Concurrent launches of one app race on `.airtty/` (the build swaps directories with rename). Builds need a lock, plus a skip when the buildId is unchanged. This is already computable before bundling.
- **Rejected alternative.** A multi-tenant "launch scope" inside one shared Server is rejected for v1: process-global state, cwd and env, and crash blast radius. It is kept as a later `getLaunch()`-based option.

---

## 1. How it works today (evidence)

### 1.1 The airtty CLI parses by hand, in four places
| Where | How | Behaviour with unknown args |
|---|---|---|
| `packages/airtty/src/cli.ts` | `args.indexOf(key)`: `option(key, fallback)` and `optional(key)` | ignored (`dev`, `build`, …) |
| `src/commands/dev.ts` | uses only `directory` (`--app`) | **silently ignored**. The Server is spawned with `{...process.env, PORT}`, the Client with `--url` |
| `src/launcher/index.ts` `builtArgs()` | pairs loop, `--url`, `--grace` | throws `A built app takes --url <url> and --grace <duration>` |
| `src/commands/launch.ts` | strips `--yes`, forwards the rest | installed/npm targets forward the rest to the binary verbatim (`runForeground`) |
| `src/launcher/binary.ts` `flags()` | known/valued lists | throws `Unknown argument X`. Its `--help` prints the runtime usage only |
| `src/connect.ts` `serverUrl()` | `argv.indexOf("--url")` in the Client | – |

There is no argument library in the repo. Framework dependencies are exact pins (`packages/airtty/package.json` equals the root catalog). The policy lives in `docs/DEPENDENCIES.md`: stable only, a table row per addition, and `bun audit --json` must return `{}`. The Client bundle uses `zod/mini` for size; Server, build and tests use classic zod.

### 1.2 How Servers are shared
| Piece | File | Fact |
|---|---|---|
| Session key | `launcher/index.ts` (path: `local:<abs dir>`, git: `git:<repo>[/<dir>]`), `launcher/binary.ts` (`local:<name>`, `ssh:<dest>/<name>`), `generic/launch.ts` (`local:airtty-browser`) | The **cwd, env and args are not part of the key**. A binary started in project A and in project B shares one Server, which runs in A's cwd |
| Identity | `launcher/managed.ts` `serverId = sha256(key)[:16]`, `serverSocket = <runtimeDir>/<id>.sock` | runtimeDir is `$XDG_RUNTIME_DIR/airtty`, else `/tmp/airtty-<uid>`, checked to be 0700 and owned by the user |
| Find or start | `ensureServer()` | Calls `GET /lifetime/status`. Same buildId: reattach. Different buildId: `POST /lifetime/stop` and replace. Nobody answers: remove the stale socket and spawn detached with `{...env, NODE_ENV, AIRTTY_SOCKET, AIRTTY_LIFETIME=managed, AIRTTY_GRACE_MS, AIRTTY_LIFETIME_STARTER}`. **The env of whichever launch spawned the Server wins.** A race between two starters is resolved by re-checking the status |
| Lifetime | `launcher/lifetime.ts` | Clients ping every 10 s (`x-airtty-client`) and the watchdog allows 30 s. The launcher that started the Server holds its stdin, so EOF means that Client is lost. The last deliberate `leave` stops the Server at once. The last *lost* Client starts a grace period (15 min, `--grace`, `0` means none) |
| Client session file | `session.ts` `openSession` | One file per Client under `$XDG_STATE_HOME/airtty/<app>/sessions/<uuid>.json`, holding `{server: key, pid, …}`. A new Client **atomically claims** (rename) the newest orphan with a dead pid and the same key. `AIRTTY_SESSION=<id>` (used by dev) reopens a given file |
| ssh `--on` | `launcher/remote.ts` | Runs remotely `sh -c '… exec "$b" serve --detach --id $3 --grace $4'`. The comment says "arguments are app names, build ids and hex: nothing to quote". **The remote Server gets the remote env, not the local one** |
| dev | `commands/dev.ts` | Already one Server per `airtty dev` run (TCP `PORT=0`), restarted on every rebuild, with one `AIRTTY_SESSION` for the whole run |
| Build output | `build.ts` 539, 891-895 | Builds into `.airtty-<uuid>`, then `rename(.airtty → .airtty-previous)` and `rename(temp → .airtty)`. **There is no lock.** Two concurrent launches or dev runs of one app race here. The buildId is a hash of the sources, the framework and the lockfile, computed *before* bundling (line 517-534) |
| Pane instances | `instance.ts` | `x-airtty-instance` scopes Client Reference ids for `<Embed>` panes. It is **not** a state scope, so it is irrelevant here |

---

## 2. Argument-parsing libraries (npm registry, checked 2026-09-26)

Versions and dates come from `npm view`. Features come from READMEs on GitHub and project sites.

| Library | Version (last publish) | License | Deps / unpacked | Type inference | Standard Schema / Zod 4 | Auto help / version | Subcommands | Completions | Bun | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `node:util` parseArgs | built into Bun 1.4.2 | – | 0 | weak (`values` typed from config) | no | no | no | no | yes | strict mode, `tokens`. **No optional-value flags**: probed `--resume --` and it returned `"--"` as the value |
| **citty** (unjs) | 0.2.2 (2026-08-20) | MIT | 0 / 35 KB | good (own `args` DSL) | no | yes (usage) | yes, lazy | no | yes | Built on `util.parseArgs`, pre-1.0 |
| cac | 7.0.0 (2026-02-27) | MIT | 0 / 41 KB | weak | no | yes | yes | no | yes | chained API |
| commander | **15.0.0** (2026-09-02) | MIT | 0 / 207 KB | only via `@commander-js/extra-typings` | no | yes | yes | no (third-party) | yes | ESM-only, Node ≥ 22.12. 14.x maintained until 2027-05 |
| yargs | 18.2.0 (2026-09-20) | MIT | 6 deps / 237 KB | ok | no | yes | yes | bash/zsh | yes | heavy |
| clipanion | 4.0.0-rc.4 (**2024-09**) | MIT | typanion | good (classes) | typanion only | yes | yes | no | yes | stale, still RC |
| **@stricli/core** (Bloomberg) | 1.3.0 (2026-07-16) | Apache-2.0 | 0 / 327 KB | excellent | no (parser functions, wrappable) | yes, without loading commands | yes, lazy | yes (`@stricli/auto-complete`, dynamic) | yes | Opinionated, strictly scoped |
| gunshi | 0.37.3 (2026-09-16) | MIT | 0 / 248 KB | good | no (custom `parse` functions) | yes, i18n | yes, lazy | `@gunshi/plugin-completion` (recent bugs: #709 no completions without subcommands) | yes | pre-1.0, plugin system |
| **cleye** | 2.7.0 (2026-09-19) | MIT | 3 (`type-flag`, `ansis`, `terminal-columns`) / 80 KB | excellent | **yes: a Standard Schema directly as a flag type** (`port: z.coerce.number()`) | yes | yes | no | yes | Booleans must stay native `Boolean`. Arrays are written `[schema]` |
| **@optique/core + /run + /zod** | 1.3.1 (2026-09-26) | MIT | 0 / 3.4 MB (tree-shakable ESM) | excellent (combinators: `object`, `or`, `merge`, `optional`) | **yes** (`@optique/zod`, `@optique/standard-schema`, `@optique/valibot`) | yes | yes | **bash, zsh, fish, PowerShell, Nushell** | yes (`engines.bun >= 1.2`) | Most powerful. The combinator DSL would leak into the app API unless it is generated |
| @bomb.sh/args | 0.3.1 (2026-06-18) | MIT | 0 / 22 KB | none | no | no | no | no | yes | <1 KB tokenizer only |
| trpc-cli | 0.16.0 (2026-07-22) | Apache-2.0 | commander + tRPC/oRPC peers / 2.8 MB | excellent | zod/valibot/arktype input → options | yes | yes (procedures) | yes | yes | Wrong abstraction here (needs a router) |
| zod-opts | 1.0.0 (2026-01-04) | MIT | peer zod / 114 KB | good | Zod only (object schema → options) | yes | yes | no | yes | low activity |
| clerc | 1.3.1 (2026-02-22) | MIT | 8 plugin packages | good | no | plugin | yes | plugin | yes | |
| @effect/cli | 0.77.2 | MIT | Effect ecosystem / 2.1 MB | excellent | Effect Schema | yes | yes | yes | yes | Would pull in Effect |
| @bunli/core | 0.9.1 | MIT | – | good | **Standard Schema options** | yes | yes | generator | Bun-only | pre-1.0. Its `@bunli/tui` uses OpenTUI |
| incur | 0.5.1 (2026-08-14) | MIT | zod + MCP SDK + yaml… | good | zod 4 | yes | yes | yes | yes | agent/MCP-oriented, heavy |

### Recommendation: a thin Standard Schema parser owned by the framework, zero new dependencies

1. **The app-facing API should be the schema, not a library's DSL.** The repo rule is "Zod at every boundary": `examples/agent/server/config.ts` already validates env with Zod. `argv` is just another boundary. A Zod object is what app authors already write.
2. **Standard JSON Schema provides introspection for free.** Zod ≥ 4.2 (repo: 4.6.5), Valibot and ArkType expose `~standard.jsonSchema.input()`. From that the framework reads each property's type, `enum`, `default`, `description` and custom meta (`short`, `placeholder`, `kind`), and builds the grammar and the help. Validation stays `~standard.validate`, so the framework never depends on Zod's internals.
   - `zod/mini` lacks `~standard.jsonSchema` (probed). The fallback is `z.toJSONSchema` from `zod/v4/core` when `vendor === "zod"`.
   - The same JSON Schema is written to `.airtty/metadata.json`. `--help`, the launcher UI and future completions can then read arguments **without executing app code**.
3. **The grammar is framework-specific.** It needs reserved runtime flags, the `serve` subcommand, `--` pass-through, per-entry-point policies (refuse app args with `--url`) and optional-value flags (`--resume [ID]`). Mapping that onto a third-party parser means fighting it. `parseArgs` itself cannot do optional values, so a ~100-line tokenizer is needed anyway.
4. **Dependency policy.** No catalog addition, no audit surface, nothing extra in each compiled binary. The framework's own CLI (`cli.ts`, `binary.ts`, `builtArgs`) can later move onto the same module and gain per-subcommand `--help` and typo suggestions.
5. **Buying instead.** If the team prefers to buy, **cleye** is the closest fit: native Standard Schema flags, inference, auto help, MIT, active, 3 small deps. **Optique** is the choice if shell completions and mutually exclusive groups become requirements: generate an Optique parser from the JSON Schema internally, so the app API does not change. citty, cac and commander have no schema integration. stricli and gunshi would need a wrapper per flag.

---

## 3. Proposed API: app arguments

### 3.1 Declaring (`app/args.ts`, isomorphic, optional)
```ts
// examples/coder/app/args.ts
import { defineArgs } from "airtty/args";
import { z } from "zod";

export const HARNESSES = ["claude", "codex", "pi", "opencode"] as const;

export default defineArgs({
  summary: "A terminal client for coding agents",
  options: z
    .object({
      harness: z.enum(HARNESSES).meta({ short: "H", description: "Agent harness" }),
      cwd: z
        .string()
        .default(".")
        .meta({ short: "C", kind: "path", placeholder: "dir", description: "Project directory" }),
      model: z.string().min(1).optional().meta({ short: "m", description: "Model id (harness-specific)" }),
      mode: z.enum(["read", "ask", "edits", "full"]).default("ask").meta({ description: "Permission mode" }),
      // true when given bare, a string when given a value: --resume [id]
      resume: z
        .union([z.literal(true), z.string().min(1)])
        .optional()
        .meta({ placeholder: "id", description: "Resume the last session, or <id>" }),
      effort: z.enum(["low", "medium", "high", "max"]).optional().meta({ description: "Reasoning effort" }),
    })
    .strict(),
  examples: ["coder -H claude --mode edits", "coder -H codex --resume", "coder -H pi -C ../other"],
});
```

**Grammar rules**, derived from the JSON Schema of `options`. Top level must be an object.

| JSON Schema of a property | Flag |
|---|---|
| `boolean` | `--flag`, `--no-flag` |
| `string`, `enum`, `number`, `integer` | `--flag <v>`, `--flag=v`. `number`/`integer` are coerced from the string before validation |
| `anyOf [const true, string]` | optional value: takes the next token only if it does not start with `-` |
| `array` of scalars | repeatable: `--tag a --tag b` |

- camelCase properties become kebab-case flags (`maxTurns` → `--max-turns`).
- `meta.short` gives a one-letter alias. `-abc` groups booleans.
- `--` ends options; the rest go to `positionals`, an optional schema, `z.array(z.string())` by default when declared.
- Optional `meta.env` (for example `CODER_MODEL`) as a fallback: argv > env > default. This fits the house style of env config.
- `kind: "path"` is resolved against the **invocation cwd** before validation.
- Cross-field `.superRefine` runs in `validate`.

**Build checks** (`build.ts`):
- `args.ts` is bundled as its own entry, `.airtty/args/index.js` (target bun).
- It gets **Client-side boundary rules**: it runs in the launcher and binary process, so a `server-only` import is refused. It must be free of side effects.
- A property whose flag or short alias collides with the reserved runtime set (`url on target grace yes help version`, short `h`) is a build error with file and line.
- `z.toJSONSchema`/`~standard.jsonSchema` output is written to `.airtty/metadata.json` as `args` (JSON Schema + summary + examples).
- Unsupported schema shapes are rejected: nested objects, unions other than `true|string`.
- `args.ts` joins the buildId hash (it already does, as a module of the graph, once it is read like `server/auth.ts`).

### 3.2 Reading on the Server
```ts
// examples/coder/server/config.ts
import "server-only";
import cli from "../app/args";
import { getLaunch } from "airtty/server";

export const config = cli.get();          // typed z.output: { harness: "claude"|…; mode: …; resume?: true|string; … }
export const launch = getLaunch();        // { id: string; cwd: string; scope: "shared"|"per-directory"|"per-launch"; argv: readonly string[] }
```
- **`defineArgs(...)`** returns `ArgsDefinition<S>` with:
  - `get(): StandardSchemaV1.InferOutput<S>`, which reads the value the Server entry configured at start, then caches it.
  - `parse(argv, { cwd, env })`, pure, for tests.
  - `help(name)` and `schema`.
- **Typing needs no codegen.** Typing comes from the import. `getArgs()` in `airtty/server` returns `unknown` unless augmented. A later option is TanStack-style `interface Register { args: typeof cli }`, generated next to `routeTree.gen.ts`.
- **`get()` is Server-only at runtime.** In the Client process it throws "arguments are read on the Server; pass what the UI needs as props". The page renders `harness`, `model` and the rest into props. **No Client API in v1.** For local launches the Client *could* re-parse, but it has no arguments with `--url`, the generic Client or the web, so a Client API would be a trap.
- **Invariant: one Server has one argument set** (see §5: the fingerprint is part of the key). `get()` is therefore a process constant, safe in module scope, singletons and `"use cache"`.
  - For the non-memory `sqliteCache`, which is shared across processes, prefix cache keys with the args fingerprint, or document that they must not depend on args.

### 3.3 How argv reaches the Server
| Entry | App args accepted as | Parsed first by | Delivered to the Server as |
|---|---|---|---|
| `airtty dev [--app d] -- <args>` | after `--` (root script: `"coder": "… dev --app examples/coder --"`, so `bun run coder -H codex` works) | dev, after the first build. On every rebuild it is re-checked against the possibly changed schema, and a failure is reported as a build error through the existing `build-error` IPC | env `AIRTTY_ARGS` |
| `airtty ./app <args>`, `airtty github:…` | anything that is not a launcher flag (`--url --grace --yes`) | launcher. Runtime flags are checked before the build (as today). App args are checked by importing `app/args.ts` from source with Bun (fast, early `--help`), then again after the build | `ensureServer({ env: {…, AIRTTY_ARGS} })` |
| installed / npm target | forwarded verbatim | the binary | – |
| binary `coder <args>` | anything that is not a runtime flag | `binary.ts` with the bundled args module (`main(identity, { server, client, args: () => import("../args/index.js") })`) | `AIRTTY_ARGS` in `ensureServer` |
| `coder serve [--http h:p \| --socket p] [--] <args>` | yes | `serve()` path of `binary.ts` | own process env |
| `coder --on host <args>` | yes | locally | **stdin of the remote `serve --detach`** (JSON line), never argv: other users can read argv with `ps`, and the remote script forbids quoting |
| `coder --url u`, `airtty connect`, `airtty https://…` (generic) | **refused**: "app arguments configure a Server; this Client joins one that is already running" | – | – |
| `--web` | `coder serve --http …` args, as above | – | – |
| `--web-local` | not supported in v1. The SharedWorker Server has no argv. Later: page URL `?args=` parsed by the same module | – | – |
| desktop (`packages/desktop`) | the host spawns the binary on a PTY with argv from its config | the binary | as above |

**Wire format.** `AIRTTY_ARGS = {"v":1,"argv":["-H","codex"],"cwd":"/abs/invocation"}`.
- The Server entry (generated `serverSource` in `build.ts`) imports `.airtty/args` and calls `configureArgs(definition, env)` before `serve()`.
- `configureArgs` re-parses with the same code. Transforms and defaults run once, in the authoritative process.
- A failure exits with code 2 and a message in `server.log`, which `ensureServer` already shows as the log tail.
- The env is visible only to the same user.
- `/lifetime/status` gains `args: <fingerprint>` so `ensureServer` can assert that it attached to the right argument set.

### 3.4 Help and errors
```
coder 0.1.0: A terminal client for coding agents

Usage: coder [options]

Options:
  -H, --harness <claude|codex|pi|opencode>  Agent harness (required)
  -C, --cwd <dir>                           Project directory (default: .)
  -m, --model <id>                          Model id (harness-specific)
      --mode <read|ask|edits|full>          Permission mode (default: ask)
      --resume [id]                         Resume the last session, or <id>
      --effort <low|medium|high|max>        Reasoning effort

Runtime (airtty):
      --grace <duration>   Keep the Server this long after the terminal goes (default 15m)
      --on [user@]host     Run the Server on host, over ssh
      --url <url>          Join a running Server (no app options)
  -h, --help               This help
      --version            Version and build
Examples:
  coder -H claude --mode edits
```
- **Errors** print `coder: --harness: expected one of claude|codex|pi|opencode, got "cladue" (did you mean claude?)` and exit 2. Unknown flags get a nearest-match suggestion. Zod issue paths map back to flags.
- **`--version`** prints `coder 0.1.0 (build 1a2b…)` for humans. The machine JSON stays under `--version --json`, because `readBinaryIdentity` does not depend on it.
- `airtty ./app --help` prints the same help.

---

## 4. File-level change list (packages/airtty)

| File | Change |
|---|---|
| **new** `src/args.ts` (`airtty/args`) | `defineArgs`, the `ArgsDefinition` type, the JSON-Schema→grammar compiler, tokenizer, validate (Standard Schema), `renderHelp`, `suggest`, `fingerprint(value, cwd)` (sha256 of canonical JSON), `RESERVED` runtime flags. Uses `zod/mini` for its own schemas, since it ships in binaries and launchers |
| `src/build.ts` | Discover `app/args.ts` (like `server/auth.ts`, lines 320-331). Apply Client boundary rules. Bundle `.airtty/args/index.js`. Check reserved names. Pass `args` to `writeAppMetadata`. `serverSource` imports it and calls `configureArgs`. Add `"args"` to `FRAMEWORK_ENTRIES`. **Build lock + skip when unchanged**: `withLock(<app>/.airtty.lock)` (`launcher/lock.ts`), and when `.airtty/manifest.json` already has the computed buildId, return without bundling |
| `src/app-metadata.ts` | `AppPackage.airtty.server: "shared" \| "per-directory" \| "per-launch"` (+ optional `grace`). `AppMetadata.args?` (JSON Schema) and `server` |
| `src/server.ts` / `src/serve.ts` | Export `getArgs()`, `getLaunch()`, `configureArgs()`. `ServerEnvironment` gains `AIRTTY_ARGS`, `AIRTTY_LAUNCH` (id, scope). Log the fingerprint |
| `src/launcher/lifetime.ts` | `LifetimeStatus.args?` (fingerprint), `launch?` |
| `src/launcher/managed.ts` | `EnsureOptions.args?: { json: string; fingerprint: string }`, `cwd`. Spawn with `cwd` and `AIRTTY_ARGS`. Check the status fingerprint on reattach. `serverKey(base, { scope, cwd, fingerprint, launch })` |
| **new** `src/launcher/launch-key.ts` | Key composition and the **orphan claim** (below): `claimLaunch(name, baseKey)` uses `session.ts` |
| `src/session.ts` | Factor the orphan scan and atomic claim into `claimOrphan(name, predicate)`. Export it for the launcher. `openSession({ id })` stays |
| `src/launcher/index.ts` | `builtArgs()` becomes `splitArgs(args, LAUNCHER_FLAGS)`. App args are parsed by `app/args.ts`. `runBuilt` passes args, scope and launch key |
| `src/launcher/local.ts` | `runLocal` passes `AIRTTY_SESSION=<claimed id>` when it reattaches a launch |
| `src/launcher/binary.ts` | Replace `flags()` with the shared tokenizer (runtime flags + app args). `usage()` becomes generated help. `serve` accepts app args. `Roles.args?`. Key per scope. Refuse app args with `--url` |
| `src/launcher/remote.ts` | The `START` script reads one JSON line (args, cwd) from stdin into the env of `serve --detach`. `runOn({ args })` |
| `src/compile.ts` | Binary entry: `args: () => import("../args/index.js")` |
| `src/commands/dev.ts` | Split at `--`. Parse after each build. `AIRTTY_ARGS` into the Server env (and `AIRTTY_LAUNCH` with `scope: "per-launch"`, id = dev session). Print help and exit on `-- --help` |
| `src/commands/launch.ts` | `usage` mentions `[app options]`. Unchanged otherwise |
| `src/commands/start.ts` | `start --role server [-- app args]` |
| `src/generic/*`, `src/connect.ts` | Refuse app args (clear error) |
| `src/commands/init.ts` | The starter can include a commented `app/args.ts` |
| `packages/airtty/package.json` | `exports["./args"] = "./src/args.ts"`. **No new dependency** |

### Tests to add
- `tests/args.test.ts` (pure):
  - kebab-case, short flags and groups, `--no-x`, `=` inline values, the optional value (`--resume`, `--resume id`, `--resume -H x`), repeatables, `--`, number coercion, env fallback, `kind: "path"` resolution
  - unknown flag with suggestion, enum error text, required flag missing
  - reserved-name clash, fingerprint stability (key order, defaults)
  - a help snapshot
- `tests/args-types.test.ts`: `expectTypeOf(cli.get())` (pattern of `route-types.test.ts`).
- `tests/args-build.test.ts`:
  - `app/args.ts` bundled
  - `server-only` import refused with its chain
  - reserved clash refused
  - JSON Schema in `metadata.json`
  - buildId changes when `args.ts` changes
  - build lock: two concurrent `build()` calls give one output; an unchanged build is skipped
- `tests/binary.test.ts` (extend): app flags accepted, `--help` lists app then runtime options, `Unknown argument` becomes a suggestion, `serve -- args`, `--url` + app args refused, `--version`.
- `tests/launch.test.ts` (extend): `splitArgs`, app args before the build, `--help` without building.
- `tests/server-args.test.tsx` (inline fixture app, like `live.test.tsx`): the Server renders `cli.get()`, and `AIRTTY_ARGS` invalid means exit 2 with the message.
- `tests/server-scope.test.ts` (with `lifetime-server.ts`):
  - shared + same args: reattach
  - shared + different args: two sockets
  - per-directory: key follows the cwd
  - per-launch: two concurrent launches give two Servers
  - a killed Client leaves its Server in grace, and the next launch claims the orphan session and reattaches (same pid)
  - a quit Client leaves nothing
  - the status fingerprint mismatch is refused
- `tests/remote` path: extend the existing ssh stand-in (`AIRTTY_SSH`) to assert that args travel on stdin, not argv.
- PTY: `scripts/pty/dev.ts` (`-- --flag`), `scripts/pty/lifetime.ts` (two per-launch instances plus a crash and reattach), and later `scripts/pty/coder.ts` with a fake harness.

### Docs to update (French)
- `docs/API.md`: new "Arguments de l'application" section (`app/args.ts`, `defineArgs`, grammar, `get()`, `getLaunch()`, help).
- `docs/DISTRIBUTION.md`:
  - "Les arguments qui suivent la cible…" (reserved flags, `--`, `serve -- args`, `--on` via stdin)
  - the session-key paragraph (scope, fingerprint, launch)
  - the lifetime table (per-launch)
  - the binary usage table
- `docs/ARCHITECTURE.md`: args as a boundary, and the invariant "un Server = un jeu d'arguments".
- `docs/BOUNDARIES.md`: `app/args.ts` is isomorphic, no `server-only`.
- `docs/DESKTOP.md`: argv from the host, one window equals one launch under `per-launch`.
- `docs/WEB.md`: args with `serve --http`, and none in `--web-local` (v1).
- `docs/CACHE.md`: the args fingerprint and shared handlers.
- `docs/TOOLING.md`: nothing.
- `docs/DEPENDENCIES.md`: record the decision "parseur maison sur Standard (JSON) Schema, aucune dépendance".
- `README.md`: the quick example.
- `examples/agent`: optional migration of `AGENT_*` env to `app/args.ts` with `meta.env` fallback, as a showcase.

---

## 5. Multiple sessions per project

### 5.1 Requirements
- Several `coder` instances in the same project, each with its **own agent session**.
- Their arguments may differ.
- Keep what exists:
  - a crash or closed terminal leaves the agent running during grace, and relaunching reattaches
  - ssh `--on`
  - compiled binaries
  - `useLive` feeds
  - Client session restore

### 5.2 Options considered
| Option | Idea | Pros | Cons |
|---|---|---|---|
| 1. **Per-launch Server** (`server: "per-launch"`) | Key `…!<launchId>`: one process per launch | App code stays single-tenant (the `Agent` singleton in `examples/agent` works unchanged). Args, cwd and env are naturally per process. Crash isolation. Matches `airtty dev`, which is already per-run. No protocol change | One Bun Server per instance (tens of MB; the harness child dominates anyway). Crash reattachment needs the launch id to survive: solved by the orphan claim |
| 2. Key derived from args (+cwd) only | Same args = same Server | Simple | Two `coder -H claude` in one project would **share** the agent, which contradicts the requirement. It is still valuable as the default safety net: never inherit foreign args |
| 3. Multi-tenant Server with a per-Client "launch scope" | One Server; `getLaunch()` from a per-request header (`x-airtty-launch`) keys app state; dispose on leave or grace | One process, shared caches | Every app global becomes a bug. `process.cwd()`/env are process-wide. One harness crash or OOM kills all sessions. Args per request break the "args are a constant" model. Lifetime must track per-client grace. More framework surface |
| 4. App-level only (dev picks a unique `AIRTTY_SESSION_KEY`) | Wrapper sets the env | No framework change | Hidden, not declarative, no binary support |

### 5.3 Recommended design
**Manifest (`package.json`):**
```json
"airtty": { "server": "per-launch", "grace": "10m" }
```

| Scope | Key | Use |
|---|---|---|
| `shared` (default) | `<target>#<argsFingerprint>` | Notes, mdreader. Today's behaviour, with args never inherited |
| `per-directory` | `<target>@<invocation cwd>#<fp>` | Apps that write to the cwd (Notes' `notes.sqlite`!), or a "one agent per project, many viewers" coder variant |
| `per-launch` | `<target>@<cwd>#<fp>!<launchId>` | coder |

- The fingerprint is sha256 of the canonical validated input + cwd, 16 hex digits. It is omitted when the app declares no args, so today's keys are unchanged.
- `serverId = sha256(key)[:16]`, unchanged. Socket paths stay short (sun_path).

**Launch id and crash reattachment (`per-launch`):**
1. The launcher or binary computes `base = <target>@<cwd>#<fp>`.
2. `claimLaunch()` scans `$XDG_STATE_HOME/airtty/<app>/sessions/*.json` for orphan files (dead pid, `server` starting with `base!`) whose Server still answers `/lifetime/status` with the same buildId. It claims the newest by atomic rename, exactly as `openSession` does today. Its `launchId` is the suffix, and the file id becomes `AIRTTY_SESSION`.
3. If nothing is claimable, it uses a new UUID.
4. `ensureServer({ id: serverId(base + "!" + launchId), cwd, env: {AIRTTY_ARGS, AIRTTY_LAUNCH} })` finds the Server in grace (reattached, agent intact) or starts one.
5. The Client runs with `AIRTTY_SESSION_KEY = key` and `AIRTTY_SESSION = fileId`. Its route and named fields (the prompt draft) come back along with its agent.
6. Optional runtime flag `--new` (reserved) skips step 2.

**Lifetime:**
- Unchanged. Each per-launch Server has one starter Client.
  - Ctrl+C or `app.quit`: `leave`, so the Server and the harness stop at once.
  - Crash or closed terminal: grace (app default `airtty.grace`, overridable by `--grace`). The agent **keeps working** during grace, which is a feature for long turns.
- Desktop: closing the window is a quit, so the Server stops.

**Effects on the rest of the framework:**

| Area | Effect |
|---|---|
| `useLive` | No change. One Client per Server. On reattach the Client remounts, `useLive(feed, [attempt])` reopens, and the first item is a full snapshot (agent pattern). A tunnel drop is unchanged: pings fail, then "Connected" again and `app.refresh()` |
| Reconnection | Unchanged, because the client id and launch id live in the running Client |
| ssh `--on` | Key `ssh:<dest>/<name>@<remote cwd?>#<fp>!<launchId>`. `per-directory` on a remote host needs a remote cwd: v1 uses the value of `--cwd`-like args, otherwise the remote home. Args and cwd go on stdin to `serve --detach`. The claim happens locally, since sessions are local files and the id is the key |
| Compiled binaries | `binary.ts` reads the scope from its embedded metadata (compile-time constant) and computes the same key. Note that today's `local:<name>` ignores the cwd; `per-directory`/`per-launch` fix that |
| `airtty dev` | Already per-run. It sets `AIRTTY_LAUNCH` with scope `per-launch`. Two `bun run coder` in one project need the **build lock + unchanged-build skip**, otherwise they race on `.airtty/`. The second watcher's rebuild is then a no-op. The Server restart on rebuild is per run |
| Path/git launcher | Each launch runs `build()`. The same lock and skip make concurrent launches safe and fast |
| Cache | Memory handler: per process. Shared `sqliteCache`: include the fingerprint in keys, or document it |
| Web | Not applicable: browsers are Clients of a Server started by `serve --http`. `--web-local`'s SharedWorker is one per app name, so per-tab Servers would be a later option |
| Security | Nothing new crosses user boundaries: runtime dir 0700, socket 0600, session files 0600. Args travel by env or stdin, never argv |

**What the app (coder) still owns:**
- Harness session persistence and `--resume` (a harness-level id, distinct from the framework launch id).
- Killing harness children on Server exit.
- Showing `launch.id`/cwd in the status line.
- A "sessions in this project" picker is possible later by listing sockets whose key starts with `base!`. That would need a small `listLaunches()`, also usable by the launcher UI.

### 5.4 Why not the multi-tenant Server (option 3) now
It contradicts the model airtty exposes today: Server-owned singletons (`examples/agent`), a process-level env config, and the Server's cwd equal to the user's. It would force every app into request-scoped state, with a lifetime layer that tracks grace per client. It stays compatible later: `getLaunch()` already exists in this design (one launch per process), so a future `server: "multiplexed"` could make `getLaunch()` request-scoped without changing app code that uses it.

---

## 6. Suggested implementation order
1. Build lock + unchanged-build skip (`build.ts`). It is independent and fixes concurrent launches today.
2. `src/args.ts` + unit tests. Then the build integration (`app/args.ts`, metadata, `serverSource` `configureArgs`).
3. Entry points: dev (`--`), binary (split, help), launcher `splitArgs`, `serve -- args`, refusal with `--url`.
4. Key composition (fingerprint, scope) + status fingerprint. Then `per-launch` + `claimLaunch`.
5. ssh stdin args. Then docs (FR). Then `examples/coder` consumes it (`server: "per-launch"`, `app/args.ts`).

## Sources
- npm registry via `npm view` (versions, licenses, deps, sizes), 2026-09-26.
- READMEs: [citty](https://github.com/unjs/citty), [cleye (Standard Schema flags)](https://github.com/privatenumber/cleye), [Optique](https://github.com/dahlia/optique) / [optique.dev compare gunshi](https://optique.dev/compare/gunshi), [Stricli](https://bloomberg.github.io/stricli/), [gunshi](https://github.com/kazupon/gunshi) and [plugin-completion issue #709](https://github.com/kazupon/gunshi/issues/709), [trpc-cli](https://github.com/mmkal/trpc-cli), [commander 15 release](https://newreleases.io/project/github/tj/commander.js/release/v15.0.0), [Standard JSON Schema](https://standardschema.dev/json-schema), [Zod JSON Schema](https://zod.dev/json-schema).
- Local probes: zod 4.6.5 classic exposes `~standard.jsonSchema` and zod/mini does not. `util.parseArgs` in Bun 1.4.2 consumes `--` as a value for `--resume --`.
