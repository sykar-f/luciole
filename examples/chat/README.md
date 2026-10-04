# Chat — an AI chat over OpenRouter

A chat in your terminal that streams each reply token by token. It shows a Server Function
that yields events, and `useLive` reading them in the Client. The key never leaves the Server.
The Client receives the model's description and the events of each reply, never the key.

It also has light Markdown rendering, several conversations, and a counter of tokens and cost.

## Run it

Run the example from a release of luciole, with no clone:

```sh
OPENROUTER_API_KEY=sk-or-… bunx luciole.sh example chat   # key from https://openrouter.ai/keys
CHAT_DEMO=1 bunx luciole.sh example chat                  # no key, no network: a scripted model answers
```

Or from a clone of the repository, at its root. The example depends on workspace packages, so
it does not start from its own folder. You need Bun 1.4.2, and `bun install --frozen-lockfile`
once.

```sh
OPENROUTER_API_KEY=sk-or-… bun run chat
CHAT_DEMO=1 bun run chat
```

`bun run chat` is `luciole dev --app examples/chat`. You should see an empty conversation and
a text field. Without a key and without `CHAT_DEMO`, the screen says the key is missing, and
Enter sends nothing.

## What to try

| Keys                        | Action                                                       |
| --------------------------- | ------------------------------------------------------------ |
| Enter                       | Send the message                                             |
| Alt+Enter, Ctrl+J           | New line (Shift+Enter on terminals that report it)           |
| Esc                         | Stop the reply; the text received so far stays               |
| Ctrl+G                      | Ask again after a stopped or failed reply                    |
| Ctrl+N                      | Start a new conversation                                     |
| Ctrl+↑ / Ctrl+↓, or a click | Newer / older conversation (the list shows from 100 columns) |
| PgUp / PgDn, mouse wheel    | Scroll the conversation                                      |
| Ctrl+R, Ctrl+T, Ctrl+C      | Refresh, show the requests (`DebugOverlay`), quit            |

Start a reply, then press Ctrl+N and send in the new conversation. The first reply keeps
streaming in the background. The help line at the bottom lists the keys that are active.

To see the failures without a key, use the fake provider (see [Try it without a key](#try-it-without-a-key)).

## How it is built

Open these files first:

- `app/page.tsx` describes the setup on the Server: model, price and context size read from
  `/models` (cached), and whether a key exists. It never sends the key. `app/loading.tsx` keeps
  the same layout while that lookup runs.
- `actions/chat.ts` exposes `reply(history)`, a Server Function that yields events. Zod
  validates the history before any request.
- `server/openrouter.ts` calls `/chat/completions` with `stream: true`, reads the SSE stream
  and yields `ChatEvent`s: `start`, `reasoning`, `text`, `usage` and `error`. It throws
  nothing. A 401, 402, 429, an endpoint that is down, or a stream cut halfway becomes a
  readable message.
- `components/ReplyStream.tsx` subscribes with `useLive` and pours the events into
  `components/conversations.ts`, a store above the routes. Esc unmounts the subscription,
  which closes the Server's generator and aborts the OpenRouter request.
- `components/Chat.tsx` holds the composer. Its field is named `chat/prompt`, so unsaved text
  comes back after a crash or a rebuild, and is forgotten once sent.

The cost is `usage.cost` from OpenRouter. When it is missing, the Client estimates it from the
catalogue price and prefixes it with `≈`.

## Environment variables

The Server reads all of them. Only the first four matter when you run the chat.

| Variable              | Default                        | Role                                                      |
| --------------------- | ------------------------------ | --------------------------------------------------------- |
| `OPENROUTER_API_KEY`  | none                           | OpenRouter key, read by the Server only.                  |
| `OPENROUTER_MODEL`    | `deepseek/deepseek-v4.1-flash` | Any id from `GET /api/v1/models`.                         |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Another OpenAI-compatible endpoint, an http(s) URL.       |
| `CHAT_DEMO`           | none                           | `1`: a scripted model answers in the Server, with no key. |
| `FAKE_PORT`           | `0` (any free port)            | Port of `scripts/fake-openrouter.ts`.                     |
| `FAKE_DELAY_MS`       | `35`                           | Pause between two streamed chunks of that script.         |

An invalid variable, such as a `OPENROUTER_BASE_URL` that is not an http(s) URL, is named on
the screen. The default model is the newest DeepSeek "flash" listed by OpenRouter on
2026-09-23: $0.10 per million input tokens, $0.50 per million output tokens.

## Try it without a key

`CHAT_DEMO=1` runs a fake provider, `server/fake-provider.ts`, inside the Server. The live demo
of the landing page uses it, because no key can live in a web page.

The same provider also runs as a local HTTP server, which the tests and the screenshots use.
From a clone, in two terminals:

```sh
bun examples/chat/scripts/fake-openrouter.ts   # prints {"port": …}
OPENROUTER_API_KEY=sk-or-fake OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1 bun run chat
```

It echoes your last message in Markdown, after some reasoning, then reports usage and cost.
The key `sk-or-bad` is refused with a 401, and a message containing `fail` cuts the stream.

To check the example, run `bun run test:pty:chat`. It drives `luciole dev` in a PTY against the
fake provider: the missing-key message, a streamed reply, Esc, Ctrl+G, a stream that fails,
Ctrl+N and Ctrl+↓. It writes the last screen to `pty-frame.txt`.

## Limits

- The real OpenRouter stream was not exercised for lack of a key. Only `/models` and the
  refusal of an invalid key (401) were checked against the real API. The rest ran against the
  fake provider, which follows the OpenAI and OpenRouter format.
- Conversations live in the Client's memory. Ctrl+C, a crash or a rebuild of `luciole dev`
  loses them. Only the text being typed is restored.
- There is no clipboard copy, no edit of a sent message and no model picker.
- Reasoning shows as one gray line, and only until the first text arrives.
- Stopping a reply reaches OpenRouter at the next chunk, because an async generator cannot be
  interrupted during a network `await`.
- The composer estimates its wrapped lines and scrolls past six.

### Framework findings

- OpenTUI's `textarea` reports its new content _after_ `onSubmit` when Enter arrives in the
  same read as the typing, as with fast typing or a paste. The state of a controlled
  `<Textarea>` then lags. The example reads `plainText` from the renderable on submit and
  clears the field itself (`components/Chat.tsx`). A framework helper would save the next
  author from rediscovering it.
- During a rebuild, `luciole dev` briefly creates a staging folder, `examples/<app>/.luciole-<uuid>/`.
  Neither `.gitignore` nor `oxlint` ignores it, so an `oxlint` run at that moment fails on the
  generated bundle.
