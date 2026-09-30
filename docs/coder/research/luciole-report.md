# luciole: research report for a multi-harness coding-agent example

Repo: `/Users/sykar-f/workdir/drafts/luciole` (HEAD `01c8558`, clean). Read-only study; nothing modified.

---

## 0. TL;DR

- luciole = a single codebase compiled into **two processes**. The **Server** (Bun, `--conditions=react-server`) renders pages with React Flight and runs Server Functions. The **Client** (Bun + OpenTUI + TanStack Router) runs Client Components, keymaps, focus and local state. They talk over HTTP/Flight on a unix socket or TCP, and optionally `ssh://`.
- **Server→Client push = `useLive(serverFn, args)`**. The Server Function is `async` and returns an `AsyncIterable` (or is an `async function*`). It streams for as long as the component stays mounted, and nothing reconnects it automatically. `examples/agent` already uses this to push **whole-transcript snapshots** (throttled to 50 ms) from a long-lived `pi --mode rpc` child process.
- Every failed request raises `TransportError.outcome ∈ {not-sent, rejected, unknown}`. The app owns the retry and consult policy. The framework has **no** business state.
- Keybindings use `@opentui/keymap` through `useBindings` (layers are scoped to the component's lifetime). `<KeyHelp groups inline/>` generates the help bar from the active bindings that carry a `desc`.
- OpenTUI **0.5.12** (`@opentui/core`, `@opentui/react`, `@opentui/keymap`). The examples already use `<markdown streaming>`, `<diff view=unified|split filetype syntaxStyle>`, `<scrollbox stickyScroll>`, `<textarea>`/`<input>` (via `Input`/`Textarea`), `<select>`, `<ascii-font>`, `useTimeline`, `usePaste`, `EmbeddedTerminalRenderable` (via `<Terminal>`) and `SyntaxStyle`.
- A `--harness` CLI flag **does not reach the Server** today:
  - `luciole dev` ignores extra args and passes only `process.env` to the Server.
  - The launcher (`luciole ./app`) accepts only `--url` and `--grace`.
  - A compiled binary rejects unknown args (`Unknown argument`).
  - The workable options are an env var (`AGENT_HARNESS=claude|codex|pi`, validated by Zod, as every example does), a runtime picker in the UI, or a framework change.
- Adding `@anthropic-ai/claude-agent-sdk` to an example is fine by the repo's conventions: add it to the root `workspaces.catalog`, depend on it as `"catalog:"`, and import it only from `server/` (`server-only`). The server bundle is built with `Bun.build`, and third-party packages get **bundled** unless native. Docs are in **French**; code comments, README code and commit messages are in **English**.

---

## 1. Framework model

### 1.1 Processes, components, boundaries

Sources: `README.md`, `docs/ARCHITECTURE.md`, `docs/BOUNDARIES.md`.

- App layout (`examples/notes` is the canonical one): `app/` (routes), `components/`, `actions/` (`"use server"`), `server/` (server-only business code). Optional files: `server/auth.ts` and `server/cache.ts`.
- `page.tsx` is a **Server Component** by default and never enters the Client bundle.
- `layout.tsx`, `loading.tsx`, `error.tsx` and `not-found.tsx` are **always Client** (they must say `"use client"` and have a default export). Layouts are **persistent**, so their state, focus and scroll survive navigation under their segment.
- `"use client"` cuts the graph: the Server receives Client References.
- `"use server"` modules may only export **named async function declarations**, plus `export const auth = "public"|"required"`. Inline or closure actions are refused with file and line.
- A module under `server/`, or one that imports `server-only`, is refused in the Client graph. `client-only` guards the reverse direction. This matters because both processes run Bun: code meant for the user's terminal (for example `$EDITOR`) would run on the wrong machine. See `examples/forge/components/editor.ts`.
- Client Components may import **any** package, including `node:*` and `bun:*`, because the Client runs on Bun. `examples/mux` reads `process.env` and `Bun.which` in a Client Component.
  > Note: `docs/ECOSYSTEM-BUY-VS-BUILD.md` still says the Client compiler "rejects every non-local runtime package". That is **stale**; BOUNDARIES.md and FORGE.md record that the restriction was removed.
- `luciole.json` `{ "serverPackages": [...] }` forces a third-party package to the Server side.
- Server Function args arrive **decoded but unchecked**: validate them with Zod (repo rule). A thrown exception becomes a generic 500, which the caller sees as `unknown`.

### 1.2 Flight streaming, actions, refresh, invalidation

Source: `docs/API.md`.

- A page can pass a `Promise` (read with `use()` under `<Suspense>`) or an async iterable as a prop. Flight streams it in the same response. Forge streams each diff behind its own Suspense boundary.
  - Caveat: an async iterable in a prop can be read only once, and a cached tree may remount. For screen-bound feeds, prefer `useLive`.
- Actions: import the `"use server"` function in a Client Component and `await` it. The transport timeout is **10 s** (`DEFAULT_TIMEOUT_MS` in `src/transport.ts`) and bounds only the wait for the root model. After it, the result is `unknown`. So **an action must not block waiting for the agent turn or for an approval**. Return quickly and stream progress through the live feed.
- Invalidation:
  - Server side: `invalidate(path?)` or `invalidate({ tag })` in a Server Function. The Client revalidates after the response.
  - Client side: `useApplication().invalidate()` or `refresh()`.
  - `useInvalidation(listener)` covers data read outside loaders.
  - During a refresh the tree stays mounted (`useConnection().activity === "refresh"`).
- **Live**: `useLive(source, args, { limit })` returns `{ items, done, error }`. Implementation is `src/client.tsx:668`. The default limit is 1000 and the items array is re-sliced on each item. Changing `args` reopens the subscription (agent uses `attempt` for Ctrl+R reconnect). Unmount aborts, and the Server generator's `finally` runs.
  - **Gotcha, documented in `examples/agent/README.md`**: an `async function*` that waits forever does not close when the Client leaves. Flight's `throw()` stays queued until the next `yield`. Agent therefore uses a **hand-written `AsyncIterableIterator`** whose `throw()`/`return()` wake the pending wait (`server/agent.ts` `subscribe()`).
  - Live responses are exempt from the Server idle timeout (`serve.ts` `keepAlive`). Nothing reconnects automatically: a cut ends the stream with `TransportError(unknown)`.
- `useApplication().withSignal(signal, call)` binds an AbortSignal to any Server Function call.

### 1.3 Request outcome model

| outcome    | cases                                     | did app code run? |
| ---------- | ----------------------------------------- | ----------------- |
| `not-sent` | connection refused, cancelled before send | no                |
| `rejected` | 4xx: auth, BuildMismatch, unknown action  | no                |
| `unknown`  | timeout, cut or lost response, 5xx        | maybe             |

Notes and Forge policy: never auto-replay an unknown outcome; consult it instead (Ctrl+O, ledger lookup by operation id). See `examples/forge/components/operations.ts` (`useOperation`) and `examples/notes/components/draft.ts`.

For approvals this matters. An `approve(requestId, decision)` action is naturally idempotent if it is keyed by the harness request id, so a retry after `unknown` is safe if the Server ignores duplicate decisions.

### 1.4 Latency tolerance

- `LUCIOLE_LATENCY_MS=500` adds 250 ms before send and 250 ms before delivery, per request.
- `LUCIOLE_JITTER_MS`, `LUCIOLE_CHUNK_DELAY_MS`, and `LUCIOLE_FAULT=refuse:0.1,drop:0.05,cut:0.05` inject faults.
- Local interaction (typing, scroll, hover) never waits for the network. Test bench: `examples/latency` and `tests/latency.test.tsx`.

### 1.5 Routing

Sources: `docs/ROUTER.md`, API.md "Navigation".

- TanStack Router 1.170.38 with memory history is the only navigation authority. The build generates `app/routeTree.gen.ts`; commit it and don't edit it. It gives typed `to` and `params`.
- Supported: `(group)`, `[param]`, `[...catchAll]`, search params (strings only), `router.preloadRoute`, and inherited `loading.tsx`/`error.tsx`/`not-found.tsx`.
- Esc cancels a pending navigation. There is no `<Link>`: use `useNavigate()`.
- `loading.tsx` replaces only the page, and layouts stay mounted. **Geometry contract**: the loading screen shares the page's frame, so nothing moves. The agent uses `components/Frame.tsx` for both.

### 1.6 Drafts, restorable fields, session

- The framework keeps only history plus the text of **named fields** (`<Input name="agent/prompt">`, `<Textarea name>`).
- They are stored per history entry in a `0600` file under `$XDG_STATE_HOME/luciole/<app>/sessions/`.
- They survive a crash, SIGHUP/SIGTERM and a dev rebuild. **Ctrl+C deletes them.**
- `useRestoredFields(group).submit(action, { failed })` forgets the text before the request and keeps it again if the request was `not-sent`/`rejected` or `failed(result)` returns true. The agent's prompt uses exactly this.
- Everything else, such as Drafts or selection, is app memory. The pattern is `useSyncExternalStore` stores **above the route tree**: `examples/chat/components/conversations.ts`, `examples/notes/components/draft.ts`, `examples/forge/components/{draft,operations,session}.ts`.

### 1.7 Keybindings, help bar, focus

- `Shell` installs OpenTUI's default keymap. The framework declares only `ctrl+c` (quit) and `escape` (cancel navigation) in group `luciole`.
- Apps use `useBindings(() => ({ bindings: [{ key, cmd, desc?, group? }] }), deps)`. A layer lives with its component. Keys without `desc` are active but hidden from help. `<KeyHelp inline groups={[...]} fg accent/>` renders the help bar (`src/client.tsx:876`).
- Pitfalls recorded in FORGE.md:
  - A layer **consumes** its key by default. Use `fallthrough` when needed.
  - `"G"` must be written `shift+g`.
  - Sequences are written by juxtaposition: `"ctrl+oo"` means Ctrl+O then O.
  - Single-letter bindings must be **conditional**, installed only when no text field is focused, or they swallow typing.
  - Forge's `components/editing.tsx` (an `EditingProvider` with `useEditingWhile`) and the agent's `mode: "compose" | "browse"` are the two patterns.
- Focus is managed by the `focused` prop on `Input`/`Textarea` driven by app state. `Embed` and `Terminal` take `active` and a `prefix` key.
- Also exported: `useActiveKeys`, `useKeymap`, `usePendingSequence` (a which-key-style pending display).

### 1.8 Other capabilities worth exploiting

- **`host`** (`luciole/client`): `host.notify({ title, body })`, `host.clipboard.read()/write()`, `host.openUrl`, `host.secret(name)` (keychain), and `useGlobalKey`. Useful for "approval needed" notifications and copying a message or diff.
- **`<Terminal command active prefix onExit>`** runs a local program on a PTY inside the tree, using OpenTUI's `EmbeddedTerminalRenderable` (libghostty-vt). Uses: an `$EDITOR` for long prompts, a shell pane, or the vendor's own TUI as a fallback. `examples/mux` shows it.
- **`renderer.suspend()/resume()`** gives the terminal to an external editor (`examples/forge/components/editor.ts`, a `client-only` module).
- **`<Embed app>`** runs another luciole app inline, for example mdreader for docs.
- **`<DebugOverlay/>`**: Ctrl+T in Notes and Chat.
- **DevTools** (`docs/DEVTOOLS.md`): `luciole devtools` in another pane plus `eval "$(luciole devtools --env)"`. Panels are Network (Client and Server waterfall by `callId`, live streams shown open), Components (Client plus Server components, render reasons), Console (both processes), Router, Cache, Input and Conditions (live network faults). It records and replays sessions. It costs nothing without `LUCIOLE_DEVTOOLS`.
- **Cache** (`docs/CACHE.md`): `"use cache"` on exported async functions, with `cacheTag` and `cacheLife`. Keys are SHA-256 of buildId, function id and args. It refuses async iterables and React elements. Handlers are memory (default) or `sqliteCache`. It is mostly irrelevant to a single-session agent, except maybe for caching model lists or `/models`-style metadata.
- **Auth**: single user by default (`LUCIOLE_USER`, optional `LUCIOLE_TOKEN`), or `server/auth.ts`.
- **Web** (`docs/WEB.md`): `build --web` gives an xterm.js page against a real Server, which works for an agent. `--web-local` puts the Server in a SharedWorker, which has **no child_process**, so no real harness is possible. The chat example uses `CHAT_DEMO=1` with an in-process fake provider for the landing demo, and a fake harness would do the same job.
- **Desktop** (`docs/DESKTOP.md`): Electrobun host, the app binary on a PTY, `LUCIOLE_DESKTOP=1`. Under it Ctrl+C is not quit and closing the window means quit.
- **Distribution** (`docs/DISTRIBUTION.md`):
  - `luciole ./examples/x` builds, then runs the Server detached on a unix socket keyed by session key.
  - **Two launches of the same target share the same Server.** That is relevant to "single instance": a second launch attaches to the first Server with the first Server's env.
  - Grace period is 15 min after the last Client leaves; pings every 10 s.
  - `build --compile` produces a single binary with both roles.

---

## 2. `examples/agent` in depth (pi over RPC)

Run it with `bun run agent`. Prerequisites: `pi` v0.85 on PATH and the `openai-codex` provider logged in. It has about 1,690 LOC.

| File                                             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/config.ts` (48)                          | Zod-validated env: `AGENT_MODEL` (default `openai-codex/gpt-5.6-terra`), `AGENT_THINKING` (`off`…`max`), `AGENT_CWD` (default `$TMPDIR/luciole-agent-sandbox`, created), `AGENT_PI`. Session dir is `$XDG_STATE_HOME/luciole/agent/pi-sessions`.                                                                                                                                                                                                                                                                                                                                                           |
| `server/pi.ts` (111)                             | `PiProcess`: `Bun.spawn(argv, {stdin/stdout/stderr: pipe})`. An LF-only line reader (it deliberately avoids splitting on U+2028). `send(cmd)` gives each command an `id` `c<n>` and correlates responses with a 30 s timeout. It resolves `{success:false}` instead of throwing (on exit, timeout or write failure). Everything that is not a correlated response goes to `onEvent`. It auto-declines `extension_ui_request` (`cancelled: true`). It keeps the last 2 KB of stderr to explain an exit.                                                                                                     |
| `server/protocol.ts` (132)                       | Zod schemas for the subset of pi RPC it reads: `Part` (text, thinking, toolCall), `Message` (user, assistant with usage/stopReason, toolResult), `AssistantEvent` (`text_*`, `thinking_*`, `toolcall_*` with `contentIndex`), and the `Event` union (response, message_start/end/update, tool_execution_start/update/end, queue_update, auto_retry__, compaction_start, extension__, agent_start/end/settled, turn_*). Unknown events are ignored. Also `textOf()`.                                                                                                                                        |
| `server/transcript.ts` (203)                     | `Transcript`: reduces events into immutable `Block[]` (user, text, thinking, tool, notice). Blocks are replaced, never mutated, so snapshots stay stable. Tool output is clipped head and tail at 12,000 chars and only the last 400 blocks are kept. `load(messages)` rebuilds after restart from `get_messages`. `settle()` marks unfinished tools as errors. Abort detection handles `stopReason: error` while aborting.                                                                                                                                                                                |
| `server/agent.ts` (254)                          | Singleton `Agent`: lazy `start()` spawns `pi --mode rpc --model … --thinking … --session-dir … --continue --no-extensions --no-skills --no-prompt-templates --tools read,bash,edit,write`, then loads `get_state` and `get_messages`. State machine: `starting/idle/running/aborting/stopped`. `prompt()` becomes `streamingBehavior: "steer"` when busy. `abort()` runs `clear_queue` then `abort`. `newSession()` runs `new_session`. `subscribe()` is a hand-written iterator with a version counter, wake-on-change and a 50 ms throttle, and returns full `Snapshot`s. It kills pi on `process.exit`. |
| `actions/agent.ts` (33)                          | `sendPrompt(unknown)` (Zod 1..20,000 chars), `abort`, `newSession`, `feed(_attempt)` returning `agent.subscribe()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `components/model.ts` (49)                       | Types shared by both sides: `Block`, `ToolStatus`, `AgentState`, `Usage`, `Snapshot`, `SendResult`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `app/page.tsx`                                   | Server: boots pi and renders `<AgentScreen initial={agent.snapshot()}/>` (the first frame without waiting for live).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `app/layout.tsx`                                 | Chrome: heading with connection status and activity, error line, `<KeyHelp inline groups={["agent","global","luciole"]}/>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `app/loading.tsx`                                | The same `Frame` with a `Pulse` skeleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `components/AgentScreen.tsx` (283)               | `useLive(feed, [attempt], {limit:1})` and `snap = items.at(-1) ?? initial`. Local state: prompt, `mode` (compose/browse), expanded folds, selection, message, double Ctrl+N confirm, spinner tick (only while busy). `send()` goes through `fields.submit(() => sendPrompt(text), {failed})`. Bindings: Ctrl+N, Ctrl+X (only while busy), Ctrl+R (reopens a lost feed via `attempt++`), PgUp/PgDn, Esc to browse, then j/k/↑/↓, Enter/Space fold, `a` fold-all, `i`/Esc back.                                                                                                                              |
| `components/Transcript.tsx` (243)                | `<scrollbox stickyScroll stickyStart="bottom">`. Renders the block views. Tool header: glyph, name, title, status or duration. Click toggles a fold. A folded running tool shows its last 4 output lines. `scrollChildIntoView(blockId)`.                                                                                                                                                                                                                                                                                                                                                                  |
| `components/tools.ts` (112)                      | Per-tool presentation for pi's 4 tools: title, args (diff-like `-`/`+` lines for `edit`/`write`), status and duration, glyphs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Frame.tsx`, `Line.tsx`, `Pulse.tsx`, `theme.ts` | Shared geometry (title, subtitle, bordered conversation, 1-row status, 3-row prompt box), a fixed-height truncated line, the `useTimeline` opacity pulse, and Forge's palette.                                                                                                                                                                                                                                                                                                                                                                                                                             |

Tests: there is **no** `tests/agent*.test.tsx`. There is only `scripts/pty/agent.ts`: a real PTY, real pi and a real model (it spends quota). It runs `luciole dev` with a temporary sandbox and state, and checks: prompt, write and bash streamed, file exists, browse/unfold, Ctrl+X on `sleep 30`, Ctrl+N twice, quit, and no orphan pi (found via `pgrep` plus `lsof` cwd).

**What works well**

- **Server-owned session**: a single process survives Client disconnects and dev rebuilds, and resumes via `--continue`.
- **Snapshot live feed**: simple, and robust to reconnects.
- **Harness quirks are isolated** in `pi.ts`, with Zod on every line and no-throw responses.
- **Immutable blocks**.
- **Named prompt field** restored after a crash.
- **Mode-gated letter keys**.
- **Identical loading and page geometry**.
- **The PTY journey** checks that no process is orphaned.

**Limitations to redesign**

1. **Single harness hard-wired**: `Agent` knows pi's commands, and `Transcript` knows pi's event names. It needs a **harness adapter interface** that produces a harness-neutral event and model stream.
2. **No approvals**: pi runs tools unconfirmed, and extension UI requests are auto-declined. Needed:
   - a `PendingRequest` model on the Server (id, kind, tool, args, diff),
   - a `respond(id, decision)` action,
   - a modal or overlay on the Client with its own key layer,
   - `host.notify`.
3. **Full snapshot per update**: 400 blocks, up to 12 K chars per tool, every 50 ms. That is costly for long sessions and remote links, as the README admits. Options: send a versioned snapshot first, then **patches** (append or replace block by id), with a client-side store rebuilt from the patches. Alternatively keep snapshots but split `settled blocks` from the `streaming tail`.
4. **Plain text only**: no markdown, although chat and mdreader prove that `<markdown streaming conceal syntaxStyle>` works. No real diff view either: Forge uses `<diff>`.
5. **One-line `<Input>` prompt**. Chat uses a multi-line `<Textarea>`, whose known quirk is that the change arrives after `onSubmit`, so it reads `plainText` from the renderable.
6. **No** model, thinking or mode switching at runtime (env only), no slash commands, no plan or todos, no resume picker (only `--continue`), and no real statusline (just a status row).
7. Multiple Clients share the same agent, which is acceptable for "single instance".

**Reuse vs redesign**

| Reuse (nearly as is)                                                                                                                                                                                                                    | Redesign                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PiProcess` line reader and correlator, generalised to a JSON-lines RPC helper that codex `app-server` can share. Codex is JSON-RPC 2.0 with `id`, so `send` becomes `request` and server-initiated requests (approvals) need handling. | `Agent` becomes a harness-agnostic `Session` plus `HarnessAdapter` (`start`, `prompt`, `interrupt`, `respond`, `setModel`, `setEffort`, `setMode`, `listSessions`, `resume`, `commands`) |
| The hand-written `subscribe()` iterator pattern (a must)                                                                                                                                                                                | The block model: add `plan`/`todo`, `approval`, `diff`, `subagent`/`task` and `system` kinds, plus usage and context fields                                                              |
| `Frame`/`Line`/`Pulse`/`theme`, the loading-geometry discipline                                                                                                                                                                         | Transcript rendering: markdown text, `<diff>` for edits, tool-specific renderers per harness tool set                                                                                    |
| `useRestoredFields` + named prompt field, compose/browse mode                                                                                                                                                                           | Snapshot, or snapshot plus patch, protocol                                                                                                                                               |
| Zod on every harness line, clip long outputs                                                                                                                                                                                            | Config: `AGENT_HARNESS` env plus a UI switch                                                                                                                                             |
| PTY journey structure (`scripts/pty/agent.ts`, `harness.ts`, `driver.ts`)                                                                                                                                                               | Add a **fake harness** (like chat's `fake-provider.ts`) for deterministic `tests/*.test.tsx` and web demos                                                                               |

---

## 3. Other examples: reusable UI patterns

| Need                                 | Where                                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming **markdown**               | `examples/chat/components/Transcript.tsx` (`<markdown content syntaxStyle={syntax} conceal streaming={streaming}/>`), `examples/chat/components/syntax.ts`                                                                                             | `SyntaxStyle` is a Client-only native object and never crosses Flight.                                                                                                                         |
| Full markdown reader, reflow         | `examples/mdreader/components/Reader.tsx`, `server/reflow.ts`                                                                                                                                                                                          | OpenTUI keeps soft line breaks, and reflow joins paragraphs using the `marked` lexer, on the Server. Depends on `marked` (catalog).                                                            |
| Headless live pump into a store      | `examples/chat/components/ReplyStream.tsx` + `conversations.ts`                                                                                                                                                                                        | `useLive` → `useEffect` applies new items to a `useSyncExternalStore` store. Esc unmounts it, which closes the Server generator and aborts upstream.                                           |
| Multi-line prompt                    | `examples/chat/components/Chat.tsx`                                                                                                                                                                                                                    | `<Textarea name="chat/prompt">`. Alt+Enter or Ctrl+J for a newline. Reads `field.current.plainText` on submit (quirk).                                                                         |
| **Diff** rendering                   | `examples/forge/components/FilesReview.tsx` (`<diff diff={patch} view="unified"                                                                                                                                                                        | "split" filetype syntaxStyle showLineNumbers addedBg removedBg …/>`, `highlightLines`cursor),`examples/forge/server/diff.ts` (`unifiedDiff(path, before, after)`, LCS with 3 lines of context) | Directly reusable for Claude `Edit`/`MultiEdit`/`Write`, codex `fileChange` and pi `edit`. |
| Suspense-streamed heavy items        | Forge FilesReview (a `use(file.diff)` per file)                                                                                                                                                                                                        |                                                                                                                                                                                                |
| Lists, filter, pickers               | `examples/mdreader/components/Library.tsx` (j/k, g/G, `/` find with `<input>`, filtered list), `examples/forge/components/PullList.tsx` (selection with preload), `packages/luciole/src/launcher/luciole/components/Launcher.tsx` (OpenTUI `<select>`) | No command palette exists yet. A slash-command palette would be new, built from `<input>` plus a filtered list or `<select>`.                                                                  |
| Floating menu with its own key layer | `examples/files/components/ContextMenu.tsx`                                                                                                                                                                                                            | An overlay that owns the keyboard while open (arrows, j/k, Enter, Esc) and closes on outside click. It is a good template for an **approval dialog** and a model/effort/mode picker.           |
| Forms                                | `examples/forge/components/NewPullForm.tsx` (TanStack Form with `Input`/`Textarea`/`useRestoredFields`)                                                                                                                                                |                                                                                                                                                                                                |
| Unknown-outcome operations           | `examples/forge/components/operations.ts` (`useOperation`)                                                                                                                                                                                             |                                                                                                                                                                                                |
| Editing-mode letter keys             | `examples/forge/components/editing.tsx`                                                                                                                                                                                                                |                                                                                                                                                                                                |
| External editor                      | `examples/forge/components/editor.ts` (`client-only`, `renderer.suspend()`)                                                                                                                                                                            | Compose a long prompt in `$EDITOR`, or open a changed file.                                                                                                                                    |
| PTY panes, embedded apps             | `examples/mux/components/Mux.tsx` (`<Terminal>`, `<Embed>`, `ctrl+o` prefix, `usePendingSequence`)                                                                                                                                                     |                                                                                                                                                                                                |
| Spinner, pulse                       | agent `AgentScreen` / chat `useSpinner`, `Pulse.tsx` (`useTimeline`)                                                                                                                                                                                   |                                                                                                                                                                                                |
| Help bar                             | every `layout.tsx` / `components/Help.tsx`                                                                                                                                                                                                             |                                                                                                                                                                                                |

---

## 4. Layout, running, CLI args, tests, conventions

### 4.1 Example layout

```
examples/<app>/
  package.json        {"name":"@luciole-examples/<app>","private":true,"type":"module",
                       "dependencies":{"luciole":"workspace:*","@opentui/core":"catalog:",
                       "@opentui/react":"catalog:","@tanstack/react-router":"catalog:",
                       "react":"catalog:","zod":"catalog:", …}}
                      optional "luciole": {displayName, identifier, icon, capabilities}
  tsconfig.json       {"extends":"luciole/tsconfig","include":["app","components","actions","server"],…}
  README.md           (French)
  app/ layout.tsx page.tsx loading.tsx [error.tsx not-found.tsx] routeTree.gen.ts (generated, committed)
  components/ actions/ server/ [scripts/]
  .luciole/            build output (gitignored): manifest.json, metadata.json, client/, server/, app/, [web/], node_modules symlink in dev
```

Root wiring for a new example, `examples/<app>` (see how `agent` was wired in commit "chore(scripts): wire files/mdreader/chat/agent examples"):

- `package.json` scripts:
  - `"<app>": "bun packages/luciole/src/cli.ts dev --app examples/<app>"`
  - append `&& tsc --noEmit -p examples/<app>` to `check`
  - `"test:pty:<app>": "bun scripts/pty/<app>.ts"`
- The workspace glob already covers `examples/*`.
- The linker is `hoisted` (`bunfig.toml`), so there is a single root `node_modules`.

### 4.2 Running

- Dev: `bun packages/luciole/src/cli.ts dev --app examples/<app>`, or `bun run <app>`. It:
  1. builds,
  2. symlinks node_modules,
  3. spawns the Server (`bun --conditions=react-server .luciole/server/index.js`, env = `process.env` + `PORT=0`, stdout JSON `ready` line),
  4. spawns the Client (`.luciole/client/index.js --url http://127.0.0.1:<port>`),
  5. watches files; a rebuild restarts both processes.
- Prod: `luciole build`, then `start --role server` and `start --role client --url`. Or `luciole ./examples/<app>` (the launcher, a detached Server on a unix socket). Or `build --compile`.

### 4.3 Can we pass `--harness`?

Not as a CLI flag without a framework change:

- `packages/luciole/src/commands/dev.ts`: the Server and Client are spawned with fixed argv. Extra args to `luciole dev` are silently ignored (`cli.ts` only looks up known flags). **Env is inherited**, so `AGENT_HARNESS=codex bun run <app>` works.
- `packages/luciole/src/launcher/index.ts` `builtArgs()`: a built directory accepts only `--url` and `--grace` and throws on anything else.
- `packages/luciole/src/launcher/binary.ts` `flags(...)`: throws `Unknown argument`.
- The Client reads `--url` itself (`src/connect.ts`).

Options:

- (a) An env var validated by Zod in `server/config.ts`, which is the house style: `AGENT_*`, `CHAT_DEMO`, `MD_PATH`, `MUX_PANES`.
- (b) A thin wrapper script `examples/<app>/scripts/start.ts` that parses `--harness` and sets env before invoking the CLI.
- (c) A runtime harness picker. The Server can switch adapters on an action, and the default comes from env.
- (d) A framework change that forwards app args after `--` to the Server env or argv. That touches `cli.ts`/`dev.ts`/launcher, which ARCHITECTURE.md says extensions should avoid.

(a) + (c) fits best. Also note the launcher's shared-Server semantics: a second `luciole ./app` with a different env attaches to the existing Server.

### 4.4 Tests

- `bun test --timeout 20000` runs `tests/` only. The examples have no own test dirs.
- Integration tests build an example, launch its real Server (`tests/helpers.ts` `launch()`, `LUCIOLE_TEST=1`, `PORT=0`), import the generated Client (`importClient`), and render `<Shell app>` with OpenTUI's `testRender`. Assertions run on `captureCharFrame()` and on `app.callServer(...)`. Patterns to follow:
  - `tests/live.test.tsx`: an inline fixture app in a temp dir.
  - `tests/forge*.test.tsx`: `forge-helpers.tsx` `startForge()` with env overrides.
  - Pure domain tests: `forge-domain.test.ts`, `draft.test.ts`.
- PTY journeys: `scripts/pty/<app>.ts`, using `driver.ts` (`drive({command, cols, rows, env})`, `t.type`, `t.waitFor(text|regex)`, `t.snapshot()`, `t.quit`) and `harness.ts` (`temporaryDirectory`, `defer`, `eventually`, `report`). No magic-number lint applies in tests and PTY scripts. Only `test:pty` (Notes) and `test:pty:dev` run in CI (`.github/workflows/ci.yml`). The agent and chat journeys are manual.
- A **fake harness** should back unit and integration tests; chat's `server/fake-provider.ts` plus `scripts/fake-openrouter.ts` are the precedent. Real harness journeys stay manual, as `test:pty:agent` does.

### 4.5 Conventions

- No `CLAUDE.md` or `AGENTS.md` in the repo.
- **Docs and READMEs in French.** Code, comments, UI strings and commit messages in **English**.
- Commits: Conventional Commits with a scope (`feat(agent):`, `fix(website):`, `test(scripts):`, `chore(scripts):`). The body explains why (symptom, root cause, solution for fixes; user need and approach for features) and ends with a `Co-Authored-By` trailer.
- Strict TS and lint (`docs/TOOLING.md`):
  - no `any`, no `as` except `as const`, no `!`, no ts-ignore, no enum or namespace, `eqeqeq`, `no-magic-numbers` (named constants, as the agent code does with `*_MS` constants), `no-floating-promises` (hence the `void` prefixes)
  - Zod at every external boundary: env, JSON lines, action args
  - `bun run verify` = check + lint + format:check + test + build
- The `.gitignore` covers `.luciole/`, `.luciole-*/`, `*.sqlite*`, `*.log`.

---

## 5. OpenTUI

- Versions are pinned in the root catalog: `@opentui/core`, `@opentui/react` and `@opentui/keymap` at **0.5.12**, `react-reconciler` at **0.33.0** (0.34 crashes TanStack transitions), React 19.3.0.
- `tests/dependencies.test.ts` checks that there is a single React and Core.

Imports found (packages plus examples):

- `@opentui/core` (40 imports): `ScrollBoxRenderable`, `BoxRenderable`, `TextareaRenderable`, `MarkdownRenderable`, `DiffRenderable`, `SelectRenderable`, `EmbeddedTerminalRenderable`, `SyntaxStyle`, `RGBA`, `KeyEvent`, `MouseEvent`, `MouseButton`, `decodePasteBytes`, `createCliRenderer`, `CliRenderer`, `OptimizedBuffer`, `CliRenderEvents`.
- `@opentui/react` (26): `useTerminalDimensions`, `useRenderer`, `useTimeline`, `usePaste`, `createRoot`, and `@opentui/react/test-utils` (`testRender`).
- `@opentui/keymap`, `/react`, `/opentui`, `/addons`: `KeymapProvider`, `createDefaultOpenTuiKeymap`, `useBindings`, `useActiveKeys`, `usePendingSequence`, `useKeymap`, `createOpenTuiKeymapHost`.
- JSX intrinsics used: `<box> <text> <span> <scrollbox> <input> <textarea> <markdown> <diff> <code> <line-number> <select> <ascii-font>`.

luciole wraps:

- `Input`/`Textarea` (controlled and restorable, `src/fields.tsx`)
- `Terminal` (`src/vt/`, with gaps filled in `gaps.ts`)
- `Embed`
- `KeyHelp`
- the keymap re-exports
- `DebugOverlay`

Not yet used: `<tab-select>`, `<slider>`, `useOnResize`, selection handlers.

The web target runs OpenTUI as WASM with a patch (`packages/luciole/web/opentui-v0.5.12.patch`). tree-sitter for `<markdown>`/`<code>` runs in a Worker there.

---

## 6. Constraints

- **Bun 1.4.2** (`packageManager: bun@1.4.2`), TS 7.0.2 (plus the `@typescript/typescript6` AST), oxlint 1.85.0, oxfmt 0.70.0, zod 4.6.5. The Client bundle uses `zod/mini` for the framework, while apps can use full zod.
- **Dependencies** (`docs/DEPENDENCIES.md`):
  - Every version lives in the root `workspaces.catalog`, exact pins, stable only (no canary).
  - Examples depend on `"catalog:"`.
  - Precedent for example-only deps: `sharp` (files), `marked` (mdreader), `@tanstack/react-form` (forge) are all listed in the "added to the catalog after this check" table in DEPENDENCIES.md.
  - `bun audit --json` should stay `{}`.
  - The `luciole` package pins must equal the catalog (only for the framework's own deps).
- **Adding `@anthropic-ai/claude-agent-sdk` to an example**: no rule forbids it.
  - Add it to the catalog at an exact stable version.
  - Add it to `examples/<app>/package.json` as `"catalog:"`.
  - Add a row to DEPENDENCIES.md.
  - Import it only from `server/` files (`import "server-only"`).
  - Things to verify:
    1. The Server bundle is produced by `Bun.build` and bundles third-party code; only React, react-server-dom-webpack, OpenTUI and native packages (`src/native.ts` heuristic: `.node` addons, node-gyp loaders, or `os`/`cpu` optionalDependencies holding a `.node`) stay external. The SDK resolves its bundled `cli.js` through `import.meta.url`, which breaks when bundled. Passing `pathToClaudeCodeExecutable` for the user's `claude` sidesteps this. If the SDK version ships per-platform binaries as optionalDependencies, check that they are neither pulled in nor mis-detected.
    2. The lockfile enters the build id, which is fine.
    3. The licence: the SDK is under Anthropic's commercial terms, not OSI. That is fine for a personal, non-commercial example, but the README should mention it, and the user must use their own `claude` login.
- Codex (`codex app-server`) and pi (`pi --mode rpc`) need **no npm deps**, only CLIs on PATH, spawned like `PiProcess`. The `@openai/codex` TS types could be generated or hand-written with Zod.
- Server-side process hygiene, as in the agent:
  - kill children on `process.exit`
  - the PTY journey asserts no orphans
  - `luciole dev` restarts the Server on every rebuild, so each harness must resume its session (pi `--continue`, codex `thread/resume`, Claude `resume: sessionId`)
- **Security note** (agent README): `AGENT_CWD` is not a sandbox. With approvals this becomes a real feature: map harness permission modes (Claude `permissionMode` plus `canUseTool`, codex `approvalPolicy`/`sandbox`) onto a common UI.

---

## 7. Design hints drawn from the framework

1. **Server = session owner.** One `Session` singleton holds a `HarnessAdapter`, and the adapter is chosen by `AGENT_HARNESS` or switched by an action. Adapters normalise events into a common `Block`/`Event` model.
2. **One live feed** (`useLive(feed, [attempt])`) with a hand-written iterator. Consider sending a snapshot first, then patches, to cut bandwidth. Keep a `version` so a reconnect restarts from a snapshot.
3. **Actions return fast.** `prompt`, `interrupt`, `respond(approvalId, decision)`, `setModel`, `setEffort`, `setMode`, `newSession`, `resume(id)` and `runCommand(name, args)` all return `{ok}|{ok:false,error}` within 10 s. Everything slow shows up through the feed.
4. **Approvals**:
   - They are pending entries in the snapshot.
   - The Client shows a ContextMenu-style overlay with its own key layer (`y`/`n`/`a` always, Esc) and `host.notify` when unfocused.
   - They are idempotent by request id (an `unknown` outcome is safe to retry).
   - The Server holds the harness's callback promise, for Claude's `canUseTool` and codex's server-initiated JSON-RPC request.
5. **UI**:
   - `<markdown streaming>` for assistant text
   - `<diff>` plus `unifiedDiff` for edits
   - a collapsible tool list (reuse agent `Transcript` and `tools.ts`)
   - a plan/todos panel
   - a statusline row (model, effort, mode, context %, tokens, cost, cwd, git branch)
   - a slash-command palette (an `<input>` plus a filtered list)
   - pickers (a ContextMenu-like overlay)
   - a `<Textarea name>` prompt with `useRestoredFields`
   - `$EDITOR` via `renderer.suspend()`
6. **Routes**: a single page is enough (`app/page.tsx` with `loading.tsx` sharing the Frame). Optionally `/sessions` (a resume picker rendered by the Server from the harness session list) as a second route, using `preloadRoute`.
7. **Testing**: a `fake` harness adapter drives the `tests/<app>*.test.tsx` integration tests, following `startForge`. Manual `scripts/pty/<app>.ts` journeys cover each real harness.
