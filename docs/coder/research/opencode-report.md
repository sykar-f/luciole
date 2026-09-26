# opencode as an embeddable harness for `coder` (airtty example)

Research date: 2026-09-26. Local binary: `opencode` 1.18.31 (`/etc/profiles/per-user/sykar-f/bin/opencode`).
Repo: **github.com/sst/opencode now redirects (301) to github.com/anomalyco/opencode** (~210k stars, active).
SDK: npm `@opencode-ai/sdk` (1.18.x), exports `.`, `./v2`, `./v2/client`, `./v2/server`, `./v2/types`, `./client`, `./server`.

Method: ran `opencode serve --port 47123`, pulled the OpenAPI 3.1 spec from `GET /doc` (479 KB, saved at
`<scratchpad>/openapi.json`), called read-only endpoints (agents, commands, providers, provider auth methods,
skills, config keys, sessions, SSE first events), then killed the server. I sent no prompts. I also tested
`OPENCODE_SERVER_PASSWORD` on a second server, which I killed too. The auth.json file was inspected only
through `jq 'map_values(.type)'`, so no secret values were read. Sources: opencode.ai/docs (server, sdk, permissions, acp, providers),
T3 Code at `/private/tmp/claude-501/research/t3code/apps/server/src/provider/*`.

---

## 1. Integration options

| Option                                                  | What it is                                                                                                                                                                                        | Fit for rich client                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`opencode serve` + HTTP/SSE (`@opencode-ai/sdk/v2`)** | Headless HTTP server with an OpenAPI 3.1 spec at `/doc`. Clients use REST plus an SSE bus at `GET /event` (per directory) or `GET /global/event` (all directories). The TUI uses the same server. | **Best.** Full surface: sessions, fork/revert, permissions, questions, todos, diffs, agents, commands, MCP, providers, PTY, find/files, VCS. **This is what T3 Code uses.**                                                                                                                             |
| `opencode acp`                                          | Agent Client Protocol over stdio (it also takes `--cwd` and `--port`).                                                                                                                            | Portable, but the docs say _"Some built-in slash commands like `/undo` and `/redo` are currently unsupported"_. ACP also can't carry opencode-specific features: todos, fork/revert, agents list, model variants, providers/auth, questions. Use it only if coder already speaks ACP for every backend. |
| `opencode run --format json`                            | One-shot CLI that prints raw JSON events. It can `--attach <url>` to a running server and takes `--session/--continue/--fork/--agent/--model/--variant/--file/--dir/--auto`.                      | Only good for scripted turns. It has no interactive permission replies (only `--auto` or config rules) and no mid-turn control. (I did not verify its JSON event schema because that needs a prompt.)                                                                                                   |

**Recommendation: `opencode serve` + SDK v2 (or raw HTTP/SSE if coder isn't TS).** T3 Code does exactly this
(`apps/server/src/provider/opencodeRuntime.ts`, `Layers/OpenCodeAdapter.ts`; `@opencode-ai/sdk` ^1.3.15, `import … from "@opencode-ai/sdk/v2"`, `MINIMUM_OPENCODE_VERSION = "1.14.19"`).

### Server lifecycle (verified)

- Spawn: `opencode serve --hostname=127.0.0.1 --port=<N>`. `--port 0` (the default) picks a random port. Parse the
  stdout line `opencode server listening on http://127.0.0.1:NNNNN` (the SDK's `createOpencodeServer` and T3
  both use the regex `/on\s+(https?:\/\/[^\s]+)/`). Then check `GET /global/health` → `{"healthy":true,"version":"1.18.31"}`.
- Config injection: set the `OPENCODE_CONFIG_CONTENT` env var to a JSON config, which is merged over the user config. The SDK's
  `createOpencodeServer` sets it to `JSON.stringify(options.config ?? {})`. T3 warns that setting it unconditionally
  "clobbered the user's opencode config", so it only defaults to `{}` when unset. `OPENCODE_AUTH_CONTENT` can
  override auth.json (T3 `openCodeUsageLimits.ts`).
- Auth: with no password, the server logs `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`
  With `OPENCODE_SERVER_PASSWORD=x`, it answers `401` + `www-authenticate: Basic realm="Secure Area"`. **HTTP Basic** auth
  with user `opencode` (override via `OPENCODE_SERVER_USERNAME`) works. `?auth_token=` does not work. T3 sends
  `Authorization: Basic base64("opencode:"+pw)`. **Recommendation:** generate a random password per spawn,
  since any local process could otherwise drive the agent (and bash).
- **Directory scoping:** one server can serve many project directories. Every route takes `?directory=` (and
  `?workspace=`). The SDK sets the header `x-opencode-directory: encodeURIComponent(dir)` and rewrites it into the query for GET
  (`dist/v2/client.js`). The server lazily creates an "instance" per directory (`POST /instance/dispose`,
  event `server.instance.disposed {directory}`). `GET /event?directory=` streams only that directory's bus. `GET /global/event`
  wraps each event as `{directory, payload}`.
- **One server vs shared:** T3 spawns **one `opencode serve` per chat thread/session** (`connectToOpenCodeServer` in
  `startSession`, lifetime bound to the session scope). Separately, `OpenCodeServerOwner.ts` keeps a lazily shared server for
  inventory probes, closed after a 30 s idle TTL. T3 also supports an **external server URL** (`serverUrl` setting) plus
  a password. Since the server is multi-directory, **one shared server per coder process is viable** and cheaper
  (startup is noticeable). Per-session servers give isolation, e.g. MCP injected via `POST /mcp` or per-session env. Note:
  all CLI commands share one SQLite DB, and T3 serializes CLI calls because of "database is locked" errors.
- Kill: SIGTERM the child. The SDK's `close()` calls `stop(proc)`.

## 2. HTTP API (from /doc on 1.18.31)

Two surfaces coexist: the **classic** routes (used by SDK v2 `client.session.*`, T3, and the TUI) and a newer
**`/api/*` "v2"** surface (durable per-session event log, `delivery: "steer"|"queue"`, staged revert,
integrations/credentials). The `/api/*` routes appear to be experimental or in migration: `GET /api/integration` returned `data: []`
even with credentials configured. **Build on the classic routes.** Keep `/api/session/{id}/event?after=`
(a resumable durable stream) in mind for the future.

### Sessions (classic)

| Method/path                                                                | Body / params                                                                                                                                                                                                                | Returns                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /session`                                                             | `directory, workspace, scope, path, roots, start, search, limit`                                                                                                                                                             | `Session[]`                                                                  |
| `GET /experimental/session`                                                | `roots, start, cursor, search, limit, archived` (cross-project)                                                                                                                                                              | `GlobalSession[]`                                                            |
| `POST /session`                                                            | `{parentID?, title?, agent?, model?:{id,providerID,variant?}, metadata?, permission?: PermissionRule[], workspaceID?}`                                                                                                       | `Session`                                                                    |
| `GET/PATCH/DELETE /session/{id}`                                           | PATCH `{title?, metadata?, permission?, time?:{archived?}}`                                                                                                                                                                  | `Session`                                                                    |
| `GET /session/status`                                                      | –                                                                                                                                                                                                                            | `Record<sessionID, SessionStatus>`                                           |
| `GET /session/{id}/children`                                               | –                                                                                                                                                                                                                            | subagent sessions                                                            |
| `GET /session/{id}/message`                                                | `limit, before` (pagination)                                                                                                                                                                                                 | `{info: Message, parts: Part[]}[]`                                           |
| `GET /session/{id}/message/{mid}`, `DELETE …`                              |                                                                                                                                                                                                                              |                                                                              |
| `POST /session/{id}/message` (**prompt**, blocks until the turn completes) | `{messageID?, model?:{providerID,modelID}, agent?, noReply?, tools?:Record<string,bool>, format?: OutputFormat (json_schema), system?, variant?, parts: (TextPartInput\|FilePartInput\|AgentPartInput\|SubtaskPartInput)[]}` | `{info: AssistantMessage, parts}`                                            |
| `POST /session/{id}/prompt_async`                                          | same body                                                                                                                                                                                                                    | 204. Drive the UI from SSE (**T3 uses this, with a 10 s admission timeout**) |
| `POST /session/{id}/command`                                               | `{messageID?, agent?, model?: "prov/model", arguments, command, variant?, parts?: FilePart[]}`                                                                                                                               | runs a slash command template                                                |
| `POST /session/{id}/shell`                                                 | `{agent, model?, command}`                                                                                                                                                                                                   | runs a user shell command into the transcript                                |
| `POST /session/{id}/abort`                                                 | –                                                                                                                                                                                                                            | bool                                                                         |
| `POST /session/{id}/fork`                                                  | `{messageID?}` (fork up to a message). The SDK also passes `directory`                                                                                                                                                       | new `Session`                                                                |
| `POST /session/{id}/revert`                                                | `{messageID, partID?}` (restores file snapshots and hides later messages)                                                                                                                                                    | `Session` (with `revert`)                                                    |
| `POST /session/{id}/unrevert`                                              | –                                                                                                                                                                                                                            | `Session`                                                                    |
| `POST /session/{id}/summarize` (**compact**)                               | `{providerID, modelID, auto?}`                                                                                                                                                                                               | bool                                                                         |
| `POST /session/{id}/init`                                                  | `{modelID, providerID, messageID}` (generates AGENTS.md)                                                                                                                                                                     | bool                                                                         |
| `POST/DELETE /session/{id}/share`                                          | –                                                                                                                                                                                                                            | `Session.share.url`                                                          |
| `GET /session/{id}/diff?messageID=`                                        | –                                                                                                                                                                                                                            | `SnapshotFileDiff[] {file, patch, additions, deletions, status}`             |
| `GET /session/{id}/todo`                                                   | –                                                                                                                                                                                                                            | `Todo[] {content, status, priority}`                                         |
| `PATCH/DELETE /session/{id}/message/{mid}/part/{pid}`                      | edit or delete a part                                                                                                                                                                                                        |                                                                              |

`Session = {id, slug, projectID, workspaceID?, directory, path?, parentID?, summary?:{additions,deletions,files,diffs?}, cost?, tokens?, share?:{url}, title, agent?, model?, version, metadata?, time:{created,updated,compacting?,archived?}, permission?: PermissionRule[], revert?}`

`SessionStatus = {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next, action?}`

### Messages & parts

- `UserMessage {id, sessionID, role:"user", time.created, agent, model{providerID,modelID,variant?}, system?, tools?, format?, summary?}`
- `AssistantMessage {id, sessionID, role:"assistant", parentID, providerID, modelID, mode, agent, path{cwd,root}, cost, tokens{total?,input,output,reasoning,cache{read,write}}, finish?, error?, structured?, variant?, summary?, time{created,completed?}}`
- `Part` union (`type`):
  - `text {text, synthetic?, ignored?, time?}`
  - `reasoning {text, time}`
  - `tool {callID, tool, state}` where `state.status` = `pending{input,raw}` | `running{input,title?,metadata?,time.start}` | `completed{input,output,title,metadata,time{start,end,compacted?},attachments?: FilePart[]}` | `error{input,error,time}`
  - `step-start {snapshot?}`
  - `step-finish {reason, snapshot?, cost, tokens}`
  - `patch {hash, files[]}`
  - `file {mime, filename?, url, source?}`
  - `snapshot {snapshot}`
  - `agent {name}`
  - `subtask {prompt, description, agent, model?, command?}`
  - `retry {attempt, error: APIError}`
  - `compaction {auto, overflow?}`
- Input parts: `text`, `file` (`url` can be `file://…` or `data:`; T3 sends `pathToFileURL(path)` only for png/jpeg/gif/webp, `text/*`, and pdf ≤ 20 MB), `agent` (@-mention a subagent), `subtask`.
- Errors: `ProviderAuthError{providerID,message}`, `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, `APIError{message,statusCode?,isRetryable,responseHeaders?,responseBody?}`.

### Other endpoints

- **Config:** `GET/PATCH /config`, `GET/PATCH /global/config`, `GET /config/providers` → `{providers, default}`.
- **Providers/models:** `GET /provider` → `{all: Provider[], default: Record<prov,model>, connected: string[]}`. On this machine: 184 providers, connected `google, opencode, zai-coding-plan, kimi-for-coding, cerebras, openai`.
  - `Provider {id, name, source: env|config|custom|api, env[], key?, options, models: Record<id, Model>}`.
  - `Model {id, providerID, name, family?, capabilities{reasoning, attachment, toolcall, input{text,image,pdf,…}, …}, cost{input,output,cache{read,write}}, limit{context,output}, status, variants?: Record<name, opts>}`. Variants carry the reasoning effort: low/medium/high/max, etc.
- `GET /provider/auth` → `Record<providerID, {type:"oauth"|"api", label, prompts?}[]>`. `POST /provider/{id}/oauth/authorize|callback`, `PUT/DELETE /auth/{providerID}`.
- **Agents:** `GET /agent` → `Agent {name, description?, mode: primary|subagent|all, native?, hidden?, permission: PermissionRule[], model?, variant?, prompt?, steps?}`.
  - Built-ins seen: `build` (primary, default), `plan` (primary, edits denied/asked), `explore` and `general` (subagents).
  - Hidden: `compaction`, `summary`, `title`.
  - Choose the agent per prompt with `agent: "plan"`. T3 maps its "plan" interaction mode to agent `plan`.
- **Commands:** `GET /command` → `Command {name, description?, agent?, model?, source: command|mcp|skill, template, subtask?, hints[]}`. Seen: `init`, `review` plus every skill exposed as a command. Run them with `POST /session/{id}/command`.
- **Skills:** `GET /skill` → `{name, description?, location, content}[]`. It picks up `~/.config/opencode/skills`, `~/.agents/skills`, `~/.claude/skills` and built-ins.
- **Files:** `GET /find?pattern=` (ripgrep matches), `GET /find/file?query=&dirs=&type=&limit=`, `GET /find/symbol`, `GET /file`, `GET /file/content?path=`, `GET /file/status`, `GET /vcs`, `/vcs/status`, `/vcs/diff`, `/vcs/diff/raw`, `POST /vcs/apply`.
- **Permissions:** `GET /permission` (pending), `POST /permission/{requestID}/reply {reply:"once"|"always"|"reject", message?}`. There is also a deprecated `POST /session/{id}/permissions/{permissionID} {response}`.
- **Questions** (the agent's `question` tool, i.e. an AskUserQuestion equivalent): `GET /question`, `POST /question/{requestID}/reply {answers: string[][]}` (one string array per question), `POST /question/{requestID}/reject`.
- **MCP:** `GET /mcp` (status: connected/disabled/failed/needs_auth/needs_client_registration), `POST /mcp {name, config}` (runtime add; T3 injects its own remote MCP this way), `/mcp/{name}/connect|disconnect|auth…`, `GET /experimental/resource`.
- **Misc:** `GET /project`, `/project/current`, `GET /path`, `GET /lsp`, `/formatter`, `/experimental/tool[/ids]`, `/experimental/worktree` (CRUD), PTY (`/pty` + WebSocket connect), `/tui/*` (remote-control a TUI), `POST /log`.

### SSE events (`GET /event`; each `data:` line is `{id, type, properties}`)

The first event is `server.connected`. There are heartbeat comments (`: heartbeat`). Key types and their `properties`:

- `session.created|updated|deleted {sessionID, info: Session}`
- `session.status {sessionID, status: SessionStatus}`. `session.idle {sessionID}` means the turn ended.
- `session.error {sessionID?, error?}`
- `session.compacted {sessionID}`
- `session.diff {sessionID, diff: SnapshotFileDiff[]}`
- `message.updated {sessionID, info: Message}`
- `message.removed {sessionID, messageID}`
- `message.part.updated {sessionID, part: Part, time}` carries the full part snapshot. `message.part.delta {sessionID, messageID, partID, field, delta}` carries streaming text: append `delta` to `part[field]`, e.g. `text`.
- `message.part.removed {sessionID, messageID, partID}`
- `permission.asked {id, sessionID, permission, patterns[], metadata, always[], tool?:{messageID, callID}}`
- `permission.replied {sessionID, requestID, reply}`
- `question.asked {id, sessionID, questions: {question, header, options:{label,description}[], multiple?, custom?}[], tool?}`
- `question.replied {sessionID, requestID, answers}`, `question.rejected`
- `todo.updated {sessionID, todos: Todo[]}`
- `command.executed {name, sessionID, arguments, messageID}`
- `file.edited {file}`, `file.watcher.updated {file, event}`
- `vcs.branch.updated`, `lsp.updated`, `mcp.tools.changed {server}`, `installation.update-available {version}`
- `pty.*`, `worktree.*`, `workspace.*`, `project.updated`, `server.instance.disposed {directory}`, `tui.*`
- Newer granular `session.next.*` events: `text.started/delta/ended`, `reasoning.*`, `tool.input.*`, `tool.called/progress/success/failed`, `step.started/ended {cost, tokens}`, `compaction.*`, `revert.*`, `prompted/prompt.admitted {delivery: steer|queue}`, `retried`. Also `permission.v2.*` and `question.v2.*`. T3 does **not** rely on these; it uses the classic `message.*`, `permission.*`, `question.*`, `todo.updated`, `session.status/error/compacted`.

T3's turn model: it subscribes once per session to `/event`, calls `promptAsync` with a client-generated `messageID`, and marks the turn complete on `session.status` → idle. It sums tokens from `step-finish` parts and reconciles on reconnect with `session.status` + `permission.list` + `question.list`. It warns "OpenCode connection lost. Reconnecting." when the SSE stream drops.

## 3. Permission model

- Actions: `allow | ask | deny`. Keys: `read, edit, glob, grep, list, bash, task, skill, lsp, question, webfetch, websearch, codesearch, todowrite, external_directory, doom_loop` (see the `PermissionConfig` schema).
- Config shape: either a single action, or `{ bash: { "git *": "allow", "*": "ask" }, edit: "ask", … }`. Patterns use `*`/`?` wildcards and `~`/`$HOME` expansion. **"Rules are evaluated by pattern match, with the last matching rule winning."** Agent permissions merge over global ones, and agent rules take precedence.
- Defaults are permissive. Most keys are `allow`. `doom_loop` (the same tool call three times with identical input) and `external_directory` are `ask`. `read` denies `.env` files. (https://opencode.ai/docs/permissions/)
- Runtime form: `PermissionRule[] = {permission, pattern, action}[]`, set **per session** with `POST /session {permission}` or `PATCH /session/{id} {permission}`. T3 re-asserts it on resume. T3's rulesets (`buildOpenCodePermissionRules`):
  - full-access: `[{*,*,allow},{external_directory,*,allow}]`.
  - supervised: starts with `{*,*,ask}`, then allows read/glob/grep/lsp/skill/todowrite/question. It asks for `*.env` reads, bash, webfetch, websearch, codesearch, external_directory and doom_loop. Edit is `ask`, or `allow` in auto-accept-edits mode.
- Answering: on `permission.asked`, show `permission`, `patterns`, `metadata` (e.g. the command or diff) and `always[]` (the patterns that "always" would approve). Reply with `POST /permission/{id}/reply {reply}`:
  - `once`: approve this call only.
  - `always`: approve future matching requests for the rest of the session. T3 maps both acceptForSession and acceptAlways to `always`.
  - `reject`: deny, with an optional `message` fed back to the model.
- The CLI flag `--auto` auto-approves everything that isn't explicitly denied.

## 4. Providers, auth and the Anthropic policy

- Credentials live in `~/.local/share/opencode/auth.json` (XDG_DATA_HOME), one entry per provider. `Auth = {type:"oauth", refresh, access, expires, accountId?, enterpriseUrl?} | {type:"api", key, metadata?} | {type:"wellknown", key, token}`. Env keys also count (e.g. `ANTHROPIC_API_KEY`). The newer DB `credential` table (`integration_id, method_id, …`) was empty here.
- `opencode providers list` (alias `auth list`) prints each credential with its type, e.g. `●  OpenCode Zen  api`. Environment-based providers show their env var name. It never prints secret values.
- **Anthropic OAuth:** Anthropic began rejecting third-party OAuth tokens around 2026-01-09. opencode then removed its bundled Claude Pro/Max plugins. The docs say _"Anthropic explicitly prohibits this"_ and _"Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0"_. PR #18186 "Remove anthropic references per legal requests" was merged 2026-03-19, per press. On 1.18.31, `GET /provider/auth` lists **no `anthropic` entry**. The OAuth-capable entries are openai, github-copilot, gitlab, poe, digitalocean, snowflake-cortex and xai. **Third-party plugins can still re-add it.**
- **Detection recipe for coder:** block when any of the following hold, and point the user to `--harness claude`.
  1. `jq -r '.anthropic.type // empty' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"` is `oauth`. This reads only the type field. Also honor `OPENCODE_AUTH_CONTENT` if set.
  2. `GET /provider/auth` contains `anthropic` with any `{type:"oauth"}` method. That means a Claude-subscription plugin is loaded.
  3. `GET /config` → the `plugin[]` list matches `/anthropic|claude/i` (e.g. `opencode-anthropic-auth`, `opencode-claude-*`). Treat that as suspect.
  4. If none of these hold, `anthropic` is allowed when it is in `GET /provider`.connected **and** auth.json has `type:"api"` or `ANTHROPIC_API_KEY` is set. This is metered API use and is fine.

  Enforce at model-selection time (filter out `anthropic/*` in the picker) **and** at prompt time: refuse `promptAsync` when `model.providerID==="anthropic"` and OAuth was detected. Claude models from other providers are billed or licensed separately and are not subscription OAuth: `github-copilot`, `opencode` (Zen), `amazon-bedrock`, `google-vertex-anthropic`, `openrouter`, `azure`, and similar. Leave them allowed, but consider warning on unknown gateways.

- **OpenAI ChatGPT Plus/Pro OAuth** is first-party in opencode ("ChatGPT Pro/Plus (browser|headless)" methods; the docs recommend it). It was introduced in v1.1.11, around Jan 2026. It is widely reported as tolerated or endorsed by OpenAI; I found no prohibition. Low policy risk, but coder should still say it's the user's own subscription.
- **GitHub Copilot:** there is an official partnership. GitHub Changelog 2026-01-16, "GitHub Copilot now supports OpenCode", covers paid Copilot plans. It gives OAuth device login and includes Claude models, and it is **fine**.
- **OpenCode Zen** (pay-as-you-go curated gateway, provider id `opencode`, API key from opencode.ai/auth) and **OpenCode Go** (a $10/mo open-weight plan, provider `opencode-go`; usage at `GET https://opencode.ai/zen/go/v1/usage` with a bearer key, per T3's `openCodeUsageLimits.ts`) are opencode's own first-party offerings with no issue. Black ($200/mo) was also launched. Other "coding plan" providers (zai-coding-plan, kimi-for-coding, minimax-coding-plan…) are API keys from those vendors.
- xAI "SuperGrok Subscription" OAuth, Poe and GitLab OAuth also exist. Their policy status is unknown; no action needed.

## 5. Session storage, listing and resume

- Storage is SQLite at `~/.local/share/opencode/opencode-stable.db`. The name is channel-specific; T3 globs `opencode(-*)?.db`. Tables: `project, session, message, part, todo, permission, session_share, event, workspace, credential, account, …`. Legacy JSON lives in `storage/message/`. Snapshots (a shadow git) live in `~/.local/share/opencode/snapshot/`.
- A project's id is the root-commit hash of the git repo. Non-git directories map to project `global` (worktree `/`). Sessions record `directory` and `projectID`.
- List: `GET /session?directory=<cwd>` gives the project's sessions (`roots=true` skips subagent children; supports `search`, `limit`, `start`). `GET /experimental/session` lists across projects with a cursor. CLI: `opencode session list`, `opencode export <id>`, `opencode import`.
- Resume: just reuse the session id (`GET /session/{id}`, then prompt). History is server-side. T3 stores `{sessionId}` as its resume cursor. If the session's directory differs from the new cwd, T3 **forks** with `session.fork({sessionID, directory})` to keep history. After resume it re-applies permissions with PATCH. Load the transcript with `GET /session/{id}/message?limit&before`.

## 6. Other capabilities

- **Todos:** the built-in `todowrite` tool, the `todo.updated` event, and `GET /session/{id}/todo`. Items are `{content, status, priority}`.
- **Diffs/snapshots:** each step records a snapshot hash (`step-start`/`step-finish.snapshot`). `patch` parts list changed files. `session.diff` events and `GET /session/{id}/diff?messageID=` return unified patches. Undo/redo is `revert`/`unrevert`; `fork` works at any message. VCS routes provide a git-level diff.
- **Token usage/cost:** `AssistantMessage.tokens/cost` (per message), `step-finish.tokens/cost` (per step), `Session.cost/tokens` (totals). Model pricing and context limits come from `/provider` models (from models.dev). CLI: `opencode stats`.
- **Compaction:** automatic on context overflow (the hidden `compaction` agent, `compaction` part `{auto, overflow}`, `session.compacted` event, `Session.time.compacting`). Manual: `POST /session/{id}/summarize {providerID, modelID}`.
- **Images/files:** `file` input parts with `mime` and a `url` (file:// or data:). Check `Model.capabilities.input.image/pdf`. Tool results can carry `attachments`.
- **Structured output:** `format: {type:"json_schema", schema}` produces `AssistantMessage.structured`.
- **MCP:** configured in opencode.json (`mcp: {name: {type:"local"|"remote", …}}`). Runtime control: `POST /mcp`, connect/disconnect, and an OAuth flow.
- **Custom commands:** markdown in `.opencode/command/` or `~/.config/opencode/command/`, or `command` in config. `GET /command` lists them; `POST /session/{id}/command` runs them. MCP prompts and skills appear as commands too (`source`).
- **Skills:** `GET /skill` (it also reads `~/.claude/skills` and `~/.agents/skills`). The `skill` tool is governed by the `skill` permission.
- **Agents:** custom agents in `.opencode/agent/*.md` or the config `agent` key (primary or subagent, with model, prompt and permissions). Subagents run as child sessions (`GET /session/{id}/children`, `subtask` parts, `task` permission).
- **Other:** share (`POST /session/{id}/share` → a public opncd.ai URL; **disable by default in coder**), PTY, worktrees/workspaces, LSP diagnostics, formatters, and a `system` addendum per prompt (T3 injects runtime instructions this way).

## References

- https://opencode.ai/docs/server/ , /docs/sdk/ , /docs/permissions/ , /docs/acp/ , /docs/providers/
- https://github.com/anomalyco/opencode (formerly sst/opencode)
- OpenAPI dump: `GET http://127.0.0.1:<port>/doc` (saved in the scratchpad as openapi.json)
- SDK source: `@opencode-ai/sdk@1.18.31` `dist/v2/client.js` (directory header), `dist/v2/server.js` (spawn/parse)
- T3 Code: `apps/server/src/provider/opencodeRuntime.ts`, `OpenCodeServerOwner.ts`, `Layers/OpenCodeAdapter.ts`, `Layers/OpenCodeProvider.ts`, `Layers/openCodeUsageLimits.ts`, `usage/opencodeUsageReader.ts`
- Policy: https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/ ; https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026 ; https://ridakaddir.com/blog/post/did-anthropic-kill-opencode-claude-subscription-ban ; https://aiengineerguide.com/til/chatgpt-subscription-with-opencode/
