# agent

agent is a small terminal UI for the [pi](https://github.com/earendil-works/pi) coding
agent. It shows the conversation as it streams, and each tool call with its arguments and
result. You can interrupt the agent and start a new agent session.

It shows how a luciole Server drives one long-lived process and streams its state to the
Client with `useLive`. The prompt is a restored field, and the keys come from
`useBindings`.

```
   Client                       Server                          pi --mode rpc
 ┌────────────────┐  sendPrompt  ┌─────────────────────┐  JSON lines  ┌──────────────┐
 │ transcript     │ ───────────▶ │ server/agent.ts     │ ───────────▶ │ read  bash   │
 │ tool calls     │              │ server/transcript.ts│              │ edit  write  │
 │ prompt         │ ◀─────────── │                     │ ◀─────────── │              │
 └────────────────┘  feed:       └─────────────────────┘  events      └──────────────┘
                     snapshots                                         in AGENT_CWD
```

## Run it

agent needs the `pi` CLI on your `PATH`, with its `openai-codex` provider signed in
through a ChatGPT subscription. Each prompt spends that quota. There is no scripted mode:
without a signed-in `pi`, the example does not work end to end.

With luciole installed:

```sh
bunx luciole.sh example agent
```

From a clone of the repository, with Bun 1.4.2, run it from the root:

```sh
git clone https://github.com/sykar-f/luciole && cd luciole
bun install --frozen-lockfile
bun run agent
```

The screen opens on an empty conversation, with the prompt at the bottom. While pi starts,
the conversation reads "Starting pi…".

## Try it

Send a prompt that makes the agent use its tools, such as "write hello.txt, then cat it".
The reply streams in, and each tool call appears as a block you can fold.

| Key            | Effect                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------ |
| Enter          | Sends the prompt. While the agent works, the prompt steers it after the current tool call. |
| Ctrl+X         | Interrupts the agent and drops the queued prompts                                          |
| Ctrl+N, twice  | Starts a new agent session. The previous one stays in pi's history.                        |
| Esc            | Browses the tool calls and thinking blocks. The prompt loses the focus.                    |
| `j`/`k` or ↑/↓ | Selects a block while you browse                                                           |
| Enter or Space | Folds or unfolds the selected block. `a` folds or unfolds them all.                        |
| `i` or Esc     | Returns to the prompt                                                                      |
| PgUp/PgDn      | Scrolls the conversation. The mouse wheel does too, and a click folds a block.             |
| Ctrl+R         | Refreshes, and reopens the live feed if it closed                                          |
| Ctrl+C         | Quits                                                                                      |

Letters type into the prompt while it has the focus. They become commands only while you
browse. The help line at the bottom lists the keys that work at that moment.

## How it is built

Open these files first:

- `server/agent.ts`: the Server's one agent. It starts pi, restarts it when needed, and
  publishes a snapshot after each change, at most one every 50 ms.
- `server/pi.ts`: one `pi --mode rpc` process, with JSON lines on stdin and stdout.
  Responses match their command by `id`.
- `server/protocol.ts`: the part of pi's protocol that agent reads. Zod checks each line.
- `server/transcript.ts`: turns pi's events into the blocks the screen shows.
- `actions/agent.ts`: the Server Functions `sendPrompt`, `abort`, `newSession` and the live
  `feed`.
- `components/AgentScreen.tsx`: the Client screen, its keys and the prompt.

At start, pi continues the latest agent session of `AGENT_CWD`. The Server rebuilds the
conversation from pi's messages, so a rebuild in `luciole dev` keeps it.

pi runs with its four core tools only: `read`, `bash`, `edit` and `write`. Extensions,
skills and prompt templates are turned off. agent declines any dialog an extension asks
for.

The prompt is the restored field `agent/prompt`. Text you typed comes back after a crash
of the Client. While a prompt is being sent, the field is empty. If the send fails, the
text goes back into the field.

`feed` returns an async iterator written by hand, not an `async function*` generator. When
the Client leaves, only a hand-written iterator can stop a wait for a change that may
never come.

### Check your changes

```sh
bun run check
bun run lint
bun run format:check
bun run test:pty:agent   # the real pi and a real model: spends a little quota
```

`test:pty:agent` runs `luciole dev` with a temporary sandbox and state. It sends a prompt
that calls `write` and then `bash`, and checks the file the agent wrote. Then it unfolds
the calls and interrupts a `sleep 30`. Last, it starts a new agent session and quits. It
checks that your terminal is restored and that no pi process is left.

## Environment variables

| Variable         | Default                         | Role                                                                        |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `AGENT_MODEL`    | `openai-codex/gpt-5.6-terra`    | The pi model. Without a `provider/` prefix, agent adds `openai-codex/`.     |
| `AGENT_THINKING` | `low`                           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`                 |
| `AGENT_CWD`      | `$TMPDIR/luciole-agent-sandbox` | The agent's working directory, created if needed. It is not the repository. |
| `AGENT_PI`       | `pi`                            | The pi executable                                                           |
| `XDG_STATE_HOME` | `~/.local/state`                | pi's conversations go under `luciole/agent/pi-sessions` there.              |

The default is Terra, the middle one of the three GPT-5.6 variants. It follows multi-step
tool use reliably and spends less quota than Sol. With `low` thinking, a short turn
answers in a few seconds. Set `AGENT_MODEL=gpt-5.6-sol` for hard tasks, or `gpt-5.6-luna`
for quick tries.

## Limits

> **Warning:** `AGENT_CWD` is not a sandbox. The `bash` tool can read and write outside
> it, with your rights, and agent asks nothing before a command runs.

- **One agent per Server.** Several Clients see and drive the same conversation.
- **Whole snapshots.** Each snapshot holds the whole conversation, up to its last 400
  blocks. A tool output over 12,000 characters loses its middle. A snapshot survives a
  reconnection, but a very long conversation makes each one heavy.
- **Plain text.** Replies show as plain text, with no Markdown. The prompt is one line,
  with no images.
- **A new agent session with no reply.** pi does not write an agent session that has no reply
  yet. After the Server restarts, pi continues the previous agent session instead.
