# coder

coder runs one coding-agent session in your terminal, on the agent you choose at launch:
Claude Code, Codex, pi or opencode. It drives the official binaries you installed and
signed in to. coder never talks to a model and never reads a credential.

It is also luciole's showcase. It uses a per-launch Server, app arguments, live Server
Functions, restored fields, key bindings and `<Markdown>` together.

```
 ● fake · /home/ada/src/timers · New session                       ← header

   › parseDuration("abc") returns NaN: make it throw a clear error, then run its tests

  ▸ thinking A bare word matches nothing and the destructuring hides it…
  ▸ ⚙ read src/duration.ts                                            ✓ 0.2 s
  ▾ ✎ src/duration.ts                                                  +4 −1
     5 -   const [, n, unit] = FORMAT.exec(text) ?? [];
     5 +   const match = FORMAT.exec(text);
     6 +   if (!match)
     7 +     throw new RangeError(`Not a duration: ${text}`);
  ▸ $ bun test tests/duration.test.ts                         ✓ exit 0 · 1.8 s

  Your turn: ask for the next change.                              ← transcript

 ╭─────────────────────────────────────────────────────────────────────────╮
 │ › Message… (/ commands, @ files)                                        │ ← prompt
 ╰─────────────────────────────────────────────────────────────────────────╯
  fake-large · medium · ✋ ask │ ctx ░░░░░░ 1 % │ $0.00   Scripted demo · no model calls
  pageup scroll · shift+tab mode · ctrl+g editor · ctrl+o browse    ← key help
```

The screen above is the `fake` harness after its demo prompt, trimmed from the site's
capture. The line above the key help is the status line.

## Run it

With luciole installed, run the scripted demo:

```sh
bunx luciole.sh example coder -- --harness fake
```

From a clone of the repository, run it from the root:

```sh
git clone https://github.com/sykar-f/luciole && cd luciole
bun install --frozen-lockfile
bun run coder -- --harness fake
```

The clone needs Bun 1.4.2. The `fake` harness needs nothing else: it runs offline and
spends no quota. Every other harness needs its official binary on your `PATH`, already
signed in: `claude`, `codex`, `pi` or `opencode`.

```sh
bun run coder -- -H codex --mode edits   # a real harness: spends your quota
bun run coder -- -H claude --resume
bun run coder -- --help                  # the help generated from app/args.ts
```

Everything after `--` is coder's own command line:

| Option                          | Effect                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `-H, --harness`                 | `claude`, `codex`, `pi`, `opencode`, or `fake` for the scripted demo          |
| `-C, --cwd DIR`                 | The project directory. Default: where you typed the command.                  |
| `-m, --model`, `-e, --effort`   | The model and its reasoning effort, as the harness names them                 |
| `--mode read\|ask\|edits\|full` | The permission mode. Default: `ask`, which asks before each write or command. |
| `-r, --resume [ID]`             | Resume the latest agent session of the project, or the one with this ID       |
| `--new`                         | Start a new agent session instead of reattaching an interrupted launch        |

Without `--harness`, coder picks the first harness that is ready, in this order: `claude`,
`codex`, `opencode`, `pi`. When none is ready, it says what is missing. `--new` belongs to
luciole, not to coder, so `--help` does not list it.

> **Warning:** `--mode full` turns off the agent's sandbox. With Codex, it runs with
> `danger-full-access` and asks nothing. In every mode, the agent inherits coder's whole
> environment, keys included, and acts with your rights on the project. Keep `ask` or
> `read` outside a throwaway directory.

## Try it

With `--harness fake`, the words of your prompt pick a scripted scene:

- `parseDuration`: the site's demo. It reads `src/duration.ts`, proposes a diff, waits for
  `y` and runs `bun test`. It plays at a model's pace, so you can follow it in about twenty
  seconds.
- `fix` or `edit`: a file change to approve first.
- `test` or `run`: a command with streamed output.
- `plan`, `question`, `agent`, `search` or `markdown`: a plan to review, a question, a
  subagent, a tool call, or a long Markdown reply.
- `slow`: a long command. Press Esc to interrupt it.
- `fail`: a failed turn.

Then try these keys:

| Where      | Keys                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Prompt     | Enter sends · Alt+Enter queues after the turn · Shift+Enter or Ctrl+J adds a line · Esc interrupts · Shift+Tab changes the mode |
| Prompt     | Ctrl+G opens `$EDITOR` · Ctrl+O browses the transcript · `/` lists commands · `@` completes a file                              |
| Browsing   | `j`/`k` select a block · Enter or Space folds it · `a` folds all · `y` copies it · `g`/`G` top or bottom · `i` or Esc returns   |
| Dialog     | `y` once · `s` for this agent session · `a` always · `n` denies · Esc denies and stops the turn                                 |
| Everywhere | PgUp/PgDn scroll · End follows · Ctrl+R reopens the live feed · Ctrl+C quits and stops the harness                              |

While a turn runs, Enter injects your message into it. A harness that cannot inject
queues the message instead.

The app's commands are `/new`, `/resume`, `/model`, `/effort`, `/mode`, `/plan`,
`/compact`, `/status` and `/help`. The harness adds its own, such as skills and prompts. A
command the harness cannot run does not appear.

## How it is built

Open these files first:

- `app/args.ts`: the command line, in Zod. The launcher reads it, and so does the Server.
- `app/page.tsx`: the Server page. It starts the agent session and renders its first
  snapshot.
- `components/SessionScreen.tsx`: the Client screen, with its key bindings and commands.
- `actions/session.ts`: the Server Functions, such as `send`, `interrupt`, `respond` and
  the live `feed`.
- `server/session.ts`: this launch's agent session, on `HarnessSession` from
  `@luciole-sh/harness`.
- `server/launches.ts`: which agent session each launch drives, so that a rebuild resumes
  it.

The adapters, the agent session model and the transcript UI are shared with studio in
[`packages/harness`](../../packages/harness/README.md). Each adapter turns its agent's
protocol into neutral events, such as `turn.*`, `item.*` and `request.*`.

What each luciole feature does here:

| Feature                       | In coder                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `"server": "per-launch"`      | Two `coder` in the same directory are two agent sessions. A killed Client finds its own.               |
| `"grace": "15m"`              | The Server waits 15 minutes for a lost Client before it stops. The agent works meanwhile.              |
| `@luciole-sh/core/args`       | A real command line, with `--help` and errors generated from `app/args.ts`.                            |
| `useLive`                     | The screen gets one snapshot, then patches, rather than a new snapshot every 50 ms.                    |
| Transport outcomes            | An approval is never sent twice. When its outcome is `unknown`, the Client asks the Server.            |
| Restored fields               | The prompt you are typing survives a crash or a rebuild of the Client.                                 |
| `useBindings` and `<KeyHelp>` | Each mode has its own keys, and the help line lists them.                                              |
| `host.notify`                 | A notification tells you that the agent waits for you while your terminal is not focused.              |
| `renderer.suspend()`          | Ctrl+G hands your terminal to `$EDITOR`, then takes it back.                                           |
| `<Markdown>`                  | Replies and thinking stay stable while they stream.                                                    |
| OpenTUI                       | A `<diff>` per file, `<code>`, overlays, and a mouse selection copied to your clipboard, over SSH too. |

### Run the tests

```sh
bun test tests/coder.test.tsx tests/coder-store.test.ts   # real Server and Client, fake harness
bun run test:pty:coder                                    # the whole journey in a PTY, fake harness
bun run test:web:coder                                    # the web demo in headless Chrome
bun test tests/markdown*.test.ts*                         # <Markdown>: settled blocks, closing, parity
bun run test:pty:markdown                                 # no flicker while a Markdown reply streams
```

The adapters replay exchanges recorded once on the real binaries, in
`tests/coder-{claude,codex,pi,opencode}.test.ts`. `scripts/coder/record-*.ts` records them
again. Journeys on the real harnesses spend a little quota, so you run them by hand:

```sh
bun scripts/pty/coder-real.ts claude          # or codex, pi, opencode; a model may follow
bun scripts/pty/markdown-stability.ts claude  # one real Markdown reply; or codex, pi, opencode
```

## Environment variables

| Variable              | Default                                   | Role                                                                    |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `CODER_HARNESS`       | The first harness that is ready           | Same as `--harness`. The command line wins.                             |
| `CODER_CWD`           | The directory where you typed the command | Same as `--cwd`. The command line wins.                                 |
| `VISUAL`, `EDITOR`    | `vi`                                      | The editor that Ctrl+G opens. `VISUAL` wins over `EDITOR`.              |
| `XDG_STATE_HOME`      | `~/.local/state`                          | Where coder records each launch's agent session, under `luciole/coder/` |
| `CODER_FAKE_DELAY_MS` | `25`                                      | The pause between streamed chunks of the `fake` harness, in ms          |

The adapters also pass on each agent's own variables, such as `PI_CODING_AGENT_DIR`.

## Limits

- **Quota.** Every harness but `fake` spends your own quota.
- **Accounts.** coder reads no secret: no `~/.claude/.credentials.json`, no keychain, no
  `~/.codex/auth.json`. Each harness signs you in itself, as with `claude auth login` or
  `codex login`.
- **Claude Code.** coder drives your own `claude` binary through the Agent SDK. The Agent
  SDK's license is not an OSI license, so this example is for personal, non-commercial
  use.
- **Claude subscriptions.** pi and opencode refuse Anthropic models signed in with a
  Claude subscription. Use `--harness claude` for those.
- **opencode.** Each agent session starts its own `opencode serve` on 127.0.0.1, behind a
  random password. Public sharing is turned off.
- **Names.** Codex and Claude Code see coder as `luciole-coder`. The status line writes
  "powered by …" in plain text, with no brand.
- **The web demo.** On the site, the Server runs in a Web Worker with no process or
  network. Only the `fake` harness runs there.
