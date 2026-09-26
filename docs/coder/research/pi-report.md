# pi coding agent: capability inventory for embedding in a multi-backend GUI

Researched 2026-09-26 against the local install `pi` **0.87.1** (released 2026-09-22).

- **Package:** `@earendil-works/pi-coding-agent`. It was renamed from `@mariozechner/pi-coding-agent`; CHANGELOG ~line 1710 covers the scope migration.
- **Repo:** https://github.com/earendil-works/pi (formerly badlogic/pi-mono), directory `packages/coding-agent`.
- **Local install root (nix):** `/nix/store/il4y2236i8bcrmjpqs27zbdq8f10bg3m-pi-coding-agent-0.87.1/lib/node_modules/pi-monorepo/`, referred to as `$PI` below.
- **Primary sources:** the docs bundled with that version under `$PI/docs/*.md`. They mirror https://pi.dev docs and `packages/coding-agent/docs/` on GitHub. `$PI/docs/` is the authoritative reference for 0.87.1.
- **Other sources:** examples under `$PI/examples/`, compiled source under `$PI/dist/`, and read-only CLI probes (listed in section 8). No prompts were run and no secrets were printed.

---

## 1. Integration options

pi has four CLI modes plus an in-process SDK (docs `cli-integration.md`, `rpc.md`, `sdk.md`):

| Interface | Invocation | Lifetime | Notes |
|---|---|---|---|
| Interactive TUI | `pi` | until exit | not embeddable |
| Print | `pi -p "…"` | one shot | final text only; nonzero exit on `error`/`aborted` stopReason |
| JSON | `pi --mode json "…"` | one shot | JSONL: session header + the same event stream as RPC; **no stdin commands** |
| **RPC** | `pi --mode rpc [opts]` | long-lived | JSONL commands on stdin, responses and events on stdout, extension-UI subprotocol |
| SDK | `createAgentSession()` from `@earendil-works/pi-coding-agent` | in-process | Node/Bun only; full API (SessionManager, tree navigation, custom tools, ResourceLoader) |
| `RpcClient` (TS) | exported from the same package | child process | typed wrapper over RPC: `start()`, `promptAndWait()`, `onEvent()`, `waitForIdle()`, `stop()` (`$PI/examples/rpc-client.ts`) |

There is also an experimental remote-session protocol:

- `@earendil-works/pi-protocol`: CBOR frames, protocol v8, `serverId`/`sessionId`/`attachmentId` routing.
- `@earendil-works/pi-client`: the matching transport-neutral client, built on "Chord" services.

Its README says it is experimental, and "peer authentication … not implemented". Do not build on it yet.

**Recommendation for a rich GUI:**

- **Default: RPC mode.** It works from any language, isolates the pi process, and gives you:
  - full streaming (text, thinking and tool-call deltas);
  - steering and follow-up queues, abort, and model/thinking switching;
  - compaction, fork/clone/switch session, tree and entries with durable cursors, stats and cost;
  - extension dialogs (select, confirm, input, editor).

  This matches how the GUI will likely drive Claude Code (stream-json) and Codex (app-server): one child process per session.
- **Use the SDK only if the GUI host is Node/Electron and you need features RPC lacks:**
  - in-file tree navigation (`session.navigateTree()`; RPC only offers fork, clone and switch);
  - custom in-process tools or custom permission hooks without writing an extension file;
  - session listing through `SessionManager`;
  - an in-memory settings or auth store.
- **Hybrid:** RPC plus a small bundled GUI extension passed with `-e /path/gui-bridge.ts`. The extension adds approvals and other features through `ctx.ui.*` dialogs, which RPC forwards to the GUI.

Recommended launch:

```
pi --mode rpc --session-dir <dir> [--session <id>|--continue|--no-session] \
   [--provider X --model Y --thinking high] [--tools …] [-e gui-bridge.ts] [--approve|--no-approve] [--offline]
```

Set `cwd` to the project directory. `--approve`/`--no-approve` makes the project-trust decision explicit, because RPC cannot show the trust prompt.

## 2. RPC protocol (docs `rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`, `message-types.md`)

**Framing:**

- Strict JSONL: split only on `\n` and strip a trailing `\r`.
- **Do not use Node `readline`**, because it splits on U+2028/U+2029 inside JSON strings.
- stdout carries protocol records only; stderr carries diagnostics.
- Read stdout continuously, or pi stalls on backpressure.
- Close stdin to shut pi down in an orderly way.

**Correlation:**

- Every command takes an optional `id`, and its `response` echoes it.
- Command handling is async, so correlate by `id`, not by order.
- Events carry no id, except `bash_execution_update`, which carries the originating `bash` command's id.

Responses:

```json
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}
{"id":"req-3","type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}
```

### 2.1 Commands (complete list from `dist/modes/rpc/rpc-types.d.ts` / `rpc-mode.js` switch)

| Command | Fields | Response `data` |
|---|---|---|
| `prompt` | `message`, `images?: ImageContent[]`, `streamingBehavior?: "steer"\|"followUp"` (**required while streaming, else error**) | none. Success means accepted, queued or handled, **not completed**. `/ext-cmd` runs immediately; `/skill:x` and `/template` are expanded. |
| `steer` | `message`, `images?` | none. Delivered after the current turn's tool calls, before the next LLM call. |
| `follow_up` | `message`, `images?` | none. Delivered when the agent is done. |
| `abort` | none | none. Waits until idle. |
| `clear_queue` | none | `{steering:string[], followUp:string[]}`. For Esc behavior, send `clear_queue` and then `abort`. |
| `new_session` | `parentSession?` | `{cancelled}` (an extension can veto) |
| `get_state` | none | see the `get_state` example below |
| `get_messages` | none | `{messages: AgentMessage[]}` (active context) |
| `set_model` | `provider`, `modelId` | full Model object |
| `cycle_model` | none | `{model, thinkingLevel, isScoped}` or `null` |
| `get_available_models` | none | `{models: Model[]}` (only providers with usable auth) |
| `set_thinking_level` | `level: off\|minimal\|low\|medium\|high\|xhigh\|max` | none |
| `cycle_thinking_level` | none | `{level}` or `null` |
| `get_available_thinking_levels` | none | `{levels}` (`["off"]` for non-reasoning models) |
| `set_steering_mode` / `set_follow_up_mode` | `mode: "all"\|"one-at-a-time"` | none |
| `compact` | `customInstructions?` | `{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details}` |
| `set_auto_compaction` | `enabled` | none |
| `set_auto_retry` | `enabled` | none |
| `abort_retry` | none | none |
| `bash` | `command`, `excludeFromContext?`, `id` | `{output, exitCode, cancelled, truncated, fullOutputPath?}`. Streams `bash_execution_update`. The output enters context on the **next** prompt as "Ran \`cmd\`…". This is the equivalent of the TUI's `!cmd` (`!!` corresponds to `excludeFromContext`). |
| `abort_bash` | none | none |
| `get_session_stats` | none | see the `get_session_stats` example below |
| `export_html` | `outputPath?` | `{path}` |
| `switch_session` | `sessionPath` | `{cancelled}` |
| `fork` | `entryId` (a user message) | `{text, cancelled}`. Creates a new session file; returns the forked prompt text to prefill the editor. |
| `clone` | none | `{cancelled}` |
| `get_fork_messages` | none | `{messages:[{entryId,text}]}` |
| `get_entries` | `since?` (entry id cursor) | `{entries, leafId}`. Includes pre-compaction entries and abandoned branches; this is the best source for a transcript view. |
| `get_tree` | none | `{tree:[{entry, children, label?, labelTimestamp?}], leafId}` |
| `get_last_assistant_text` | none | `{text\|null}` |
| `set_session_name` | `name` | none |
| `get_commands` | none | `{commands:[{name, description?, source:"extension"\|"prompt"\|"skill", sourceInfo:{path,source,scope,origin,baseDir?}}]}`. Built-in TUI commands are excluded. |

Example `get_state` data:

```json
{"model":{...},"thinkingLevel":"medium","isStreaming":false,"isCompacting":false,
 "steeringMode":"all","followUpMode":"one-at-a-time","sessionFile":"/path/x.jsonl",
 "sessionId":"abc123","sessionName":"my-feature","autoCompactionEnabled":true,
 "messageCount":5,"pendingMessageCount":0}
```

Example `get_session_stats` data:

```json
{"sessionFile":"...","sessionId":"...","userMessages":5,"assistantMessages":5,"toolCalls":12,"toolResults":12,"totalMessages":22,
 "tokens":{"input":50000,"output":10000,"cacheRead":40000,"cacheWrite":5000,"total":105000},"cost":0.45,
 "contextUsage":{"tokens":60000,"contextWindow":200000,"percent":30}}
```

After compaction, `contextUsage.tokens` and `contextUsage.percent` are `null`.

Model object:

```json
{"id":"claude-sonnet-4-20250514","name":"Claude Sonnet 4","api":"anthropic-messages","provider":"anthropic",
 "baseUrl":"https://api.anthropic.com","reasoning":true,"input":["text","image"],"contextWindow":200000,
 "maxTokens":16384,"cost":{"input":3.0,"output":15.0,"cacheRead":0.3,"cacheWrite":3.75}}
```

**Not available over RPC (use the CLI, the SDK, or files instead):**

- login/logout;
- listing sessions (read the session directory, or use the SDK `SessionManager`);
- in-file tree navigation and labels;
- changing the active tool set (choose it at launch with `--tools`, `--exclude-tools` or `--no-tools`);
- reload, settings edits, and theme changes.

### 2.2 Events (stdout, shared with JSON mode, `json.md`)

Example sequence for a basic run:

```
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user",...}}
{"type":"message_end","message":{...}}
{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending",...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"agent_settled"}
```

**Run lifecycle:**

- `agent_start`, `agent_end{messages, willRetry}`, `agent_settled`.
- `turn_start`, `turn_end{message, toolResults}`.
- `agent_settled` is the event that means pi is idle. Retries, overflow recovery, steering or follow-ups can still happen after `agent_end`.

**Messages:**

- `message_start{message}`.
- `message_update{usage, assistantMessageEvent}`. This is delta-only on the wire: the `partial` snapshots are stripped.
- `message_end{message}` is authoritative: replace your reconstruction with it.

`assistantMessageEvent.type` is one of:

- `text_start{contentIndex}`, `text_delta{contentIndex,delta}`, `text_end{contentIndex,content}`
- `thinking_start`, `thinking_delta`, `thinking_end` (same fields as the text events)
- `toolcall_start{contentIndex,id,toolName}`, `toolcall_delta{contentIndex,delta}`, `toolcall_end{contentIndex,toolCall}`
- `start`, `done{reason,message}`, `error{reason,error}` (normally translated into `message_start` and `message_end`)

**Tools:**

- `tool_execution_start{toolCallId, toolName, args}`
- `tool_execution_update{toolCallId, toolName, args, partialResult}`
- `tool_execution_end{toolCallId, toolName, result:{content,details}, isError}`
- Tool calls from one assistant message can run in parallel.

**Queue and state:**

- `queue_update{steering, followUp}` (full queues)
- `entry_appended{entry}`
- `session_info_changed{name?}`
- `thinking_level_changed{level}`

**Compaction:**

- `compaction_start{reason:"manual"|"threshold"|"overflow"}`
- `compaction_end{reason, result?, aborted, willRetry, errorMessage?}`

**Retry:**

- `auto_retry_start{attempt, maxAttempts, delayMs, errorMessage}`
- `auto_retry_end{success, attempt, finalError?}`
- `summarization_retry_scheduled{attempt, maxAttempts, delayMs, errorMessage}`
- `summarization_retry_attempt_start{source:"compaction"|"branchSummary", reason?}`
- `summarization_retry_finished`

**RPC-only:**

- `bash_execution_update{id?, delta}`
- `extension_error{extensionPath, event, error}`

**AssistantMessage fields:**

- `content[]` (text, thinking, toolCall)
- `api`, `provider`, `model`, `responseModel?`
- `usage{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost{…,total}}`
- `stopReason: pending|stop|length|toolUse|error|aborted|deferred`
- `errorMessage?`, `timestamp` (ms)

**Other message roles:**

- `user`
- `toolResult{toolCallId, toolName, content, details?, isError}`
- `system` (prompt sections and tool deltas)
- `bashExecution`
- `custom{customType, content, display, details}`
- `branchSummary`
- `compactionSummary`
- Tolerate unknown roles.

### 2.3 Extension UI subprotocol (`rpc-extension-ui.md`)

pi to the GUI:

```json
{"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Allow dangerous command?","options":["Allow","Block"],"timeout":10000}
{"type":"extension_ui_request","id":"uuid-2","method":"confirm","title":"Clear session?","message":"All messages will be lost.","timeout":5000}
{"type":"extension_ui_request","id":"uuid-3","method":"input","title":"Enter a value","placeholder":"..."}
{"type":"extension_ui_request","id":"uuid-4","method":"editor","title":"Edit","prefill":"..."}
```

Fire-and-forget methods (no response):

- `notify{message, notifyType: info|warning|error}`
- `setStatus{statusKey, statusText?}`
- `setWidget{widgetKey, widgetLines?, widgetPlacement: aboveEditor|belowEditor}`
- `setTitle{title}`
- `set_editor_text{text}`

GUI to pi (dialogs only):

```json
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
{"type":"extension_ui_response","id":"uuid-2","confirmed":true}
{"type":"extension_ui_response","id":"uuid-3","cancelled":true}
```

**Timeouts:** pi auto-resolves a dialog when its timeout expires. Resolved values are `undefined` or `false`.

**Degraded under RPC:**

- `ctx.ui.custom()` returns `undefined`.
- `setFooter`, `setHeader`, working indicators and autocomplete are no-ops.
- `getEditorText()` returns `""`.
- Themes are unsupported.
- `ctx.mode === "rpc"` and `ctx.hasUI === true`.

## 3. Permissions and tools

**No approvals by default.** `security.md` says: "it does not ask for approval before every tool call". pi's own docs recommend isolation (a container or VM, or a dedicated user).

**Project trust:**

- Project trust gates loading of `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`/`APPEND_SYSTEM.md`, and `.agents/skills`.
- It does **not** gate tool actions.
- In RPC/JSON/print modes there is no trust prompt, so pi follows `defaultProjectTrust`. With the default `"ask"`, protected project resources are skipped.
- Use `--approve` or `--no-approve` to decide explicitly.
- Saved decisions live in `~/.pi/agent/trust.json`.
- `AGENTS.md`/`CLAUDE.md` context files load regardless of trust.

**Built-in tools** (`cli.md`, `dist/core/tools/`):

| Tool | Default |
|---|---|
| `read` (text and images) | on |
| `bash` | on |
| `edit` (exact replace) | on |
| `write` | on |
| `grep` | off |
| `find` | off |
| `ls` | off |
| `powershell` (Windows) | off |

- Change the default set with the `defaultTools` setting.
- Launch flags: `--tools a,b`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`.
- A read-only mode is simply `--tools read,grep,find,ls`.

**Building approvals.** Approvals must be built with an extension `tool_call` hook. It can mutate the input or return `{block:true, reason}`, and it can ask the GUI through `ctx.ui.select/confirm`. The canonical example is `$PI/examples/extensions/permission-gate.ts`:

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;
  ...
  if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
  const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
  if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
});
```

Other relevant examples:

- `protected-paths.ts`, `confirm-destructive.ts`, `plan-mode/`
- `sandbox/` (uses `@anthropic-ai/sandbox-runtime`)
- `gondolin/` (micro-VM)
- `tool-override.ts`, `tools.ts`

**GUI plan:** ship a `gui-approvals.ts` extension that emits `confirm`/`select` for every `edit`, `write` and `bash` call, with a policy mode (ask, auto-edit, yolo). Pass the mode through `pi.registerFlag`, for example `--gui-approval=ask`. Render the `extension_ui_request` as the approval dialog.

**Caveats:**

- A failing `tool_call` handler blocks the tool, which is fail-safe.
- Parallel tool calls can produce concurrent dialogs, so the GUI must handle several pending ids at once.

## 4. Providers and auth

**Credential precedence** (`models.md`, `providers.md`):

1. `--api-key`
2. `auth.json` stored credential (`/login`), either `{type:"api_key", key}` or `{type:"oauth", …}`. The key can be `"!command"`, for example from a secret manager.
3. `models.json` `apiKey`
4. Environment variables or ambient cloud credentials

**Providers:**

- Anthropic, OpenAI, Azure OpenAI, Google Gemini, Vertex, Bedrock, OpenRouter, Groq, Cerebras, xAI, Mistral, DeepSeek, Fireworks, Together, Baseten, HF, GitHub Copilot, ZAI, Kimi, MiniMax, Moonshot, Qwen, Xiaomi, Cloudflare (AI Gateway and Workers AI), Vercel AI Gateway, OpenCode, Radius, and more.
- Local: llama.cpp router, plus any OpenAI-, Anthropic- or Google-compatible endpoint through `models.json` (Ollama, vLLM, SGLang, and so on).
- Custom providers through extensions (`pi.registerProvider`).

**OAuth/subscription providers** (`node_modules/@earendil-works/pi-ai/dist/auth/oauth/*.js`):

- `anthropic` ("Anthropic (Claude Pro/Max)")
- `openai-codex` (ChatGPT subscription)
- `github-copilot`
- `kimi-coding`
- `openrouter`
- `xai`
- `radius`
- `meta`

Login is TUI-only (`/login`). There is no RPC command for it.

**Detecting providers and models without reading secrets:**

- `pi auth check --provider <p> --json --no-refresh` returns:
  - `{"status":"ready","provider":"openai-codex","authType":"oauth"}`
  - `{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}`
  - `{"status":"invalid","reason":"invalid_state"}`
  - `"provider_not_found"`
- Omit `--credentials`, which emits the secret. Use `--no-refresh` to avoid a network token refresh. The source is `$PI/dist/cli/auth-check.js`.
- `pi --offline --list-models [search]` prints a table (provider, model, context, max-out, thinking, images) of models whose provider has usable auth. There is no JSON flag, so parse the table or use RPC `get_available_models`, which returns full JSON Model objects.
- Metadata only:
  - `jq 'to_entries[]|{k:.key,t:.value.type}' ~/.pi/agent/auth.json` lists provider names and types without values.
  - `models.json` lists custom providers.
  - `settings.json` holds `defaultProvider`, `defaultModel` and `defaultThinkingLevel`.
- Local machine example: `auth.json` has only `openai-codex: oauth`. Env keys make `google`, `openai` and `openai-codex` ready. `models.json` defines `kimi`, `ollama` and `sglang-homelab`. Anthropic is `not_ready`.

**Anthropic subscription OAuth: policy and how to detect it.**

Policy timeline:

- pi still ships Anthropic OAuth (`/login` then "Anthropic (Claude Pro/Max)"). It even keeps the Claude Code version header current (0.87.1 changelog: "Fixed inherited Anthropic OAuth requests reporting an outdated Claude Code version").
- Since 0.66.0 (2026-04-08), the interactive TUI **only** warns: "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits…". Setting `warnings.anthropicExtraUsage` controls the warning. **RPC/JSON/print modes do not show it.**
- External reporting: Anthropic enforced its block on subscription OAuth in third-party harnesses from 2026-04-04 (VentureBeat). Later changes are murky: a proposed "Agent SDK credit" (announced May 13, paused June 15). Treat this per your policy: disallowed.

pi's own detection logic (`dist/modes/interactive/interactive-mode.js` ~L141, L4248):

```js
if ((await modelRuntime.checkAuth("anthropic"))?.type === "oauth") warn();
const apiKey = (await modelRuntime.getAuth("anthropic"))?.auth.apiKey;
if (apiKey?.startsWith("sk-ant-oat")) warn();   // OAuth access token passed as a "key"
```

**Verified pitfall:** `pi auth check` reports `authType:"api_key"` even when the credential is an OAuth token supplied through `ANTHROPIC_OAUTH_TOKEN`, or as `ANTHROPIC_API_KEY=sk-ant-oat…`. Tested with dummy values, so `authType` alone is not enough.

GUI detection checklist (none of these checks exposes secret values to the user):

1. `pi auth check --provider anthropic --json --no-refresh`, then look for `authType === "oauth"` (from `/login` stored in `auth.json`).
2. `jq -r '.anthropic.type // empty' ~/.pi/agent/auth.json`. Also check whether `.anthropic.key` starts with `sk-ant-oat`, testing only the prefix in-process.
3. Check the environment the GUI passes to pi:
   - `ANTHROPIC_OAUTH_TOKEN` is set;
   - `ANTHROPIC_AUTH_TOKEN` is set (bearer);
   - `ANTHROPIC_API_KEY` starts with `sk-ant-oat`.
4. Check the `models.json` `providers.anthropic.apiKey` literal prefix, or flag a `!cmd`/`$VAR` value as unknown.

Remediation:

- **Hard block.** When any check fires and the chosen model's `provider === "anthropic"`, refuse to start or `set_model`, and show a fix-it prompt.
- **Steer to a key.** Enter an `sk-ant-api…` key and launch pi with `ANTHROPIC_API_KEY` in its env. Do not pass the key through `--api-key`, which is visible in `ps`.
- **Neutralize OAuth.** Strip `ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_AUTH_TOKEN` from the child env. Auth precedence puts `auth.json` above env vars, so tell the user to `/logout` Anthropic.
- **Runtime guard.** In RPC, watch `get_state.model.provider` and `cycle_model` results. Also filter `anthropic` models out of the picker while OAuth is detected.
- **Backstop extension.** An extension could block on `model_select` or `before_agent_start` when `ctx.modelRegistry` auth is OAuth.
- **Alternative route.** Point users who want a Claude subscription to the GUI's Claude Code backend instead.

## 5. Sessions (`sessions.md`, `session-format.md`)

**Location:**

- Path: `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl`.
- Override the directory with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting.
- `PI_CODING_AGENT_DIR` moves the whole agent directory.
- The local machine has 67 project directories.

**Format:**

- JSONL, version 3.
- Header line:

  ```json
  {"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path","parentSession?":"..."}
  ```

- Every other entry has `{type, id (8-hex), parentId, timestamp (ISO)}`. The entries form a **tree**, and the leaf is the active branch.
- Entry types:
  - `message` (an AgentMessage, including `system` prompt/tool delta messages)
  - `model_change`, `thinking_level_change`
  - `usage` (e.g. cache warm)
  - `compaction{summary, firstKeptEntryId, tokensBefore, systemMessage?, usage?, details{readFiles, modifiedFiles}}`
  - `context_edit{targetId, replacement|null}` (new in 0.87.0)
  - `branch_summary{fromId, summary}`
  - `custom` (extension state, not in context)
  - `custom_message` (in context)
  - `label{targetId, label}`
  - `session_info{name}`

**Resume, fork and switch:**

- CLI: `--continue` (latest for the cwd), `--resume` (picker, TUI), `--session <path|partial-uuid>`, `--session-id <exact>` (creates it if missing, which is handy for GUI-assigned ids), `--fork <path|id>`, `--no-session`, `--name`.
- RPC: `switch_session`, `new_session`, `fork{entryId}`, `clone`, `get_tree`, `get_entries{since}`.

**Branching within one file** (`/tree`, with an optional LLM branch summary) is TUI/SDK-only (`session.navigateTree()`).

**Listing sessions** for a GUI sidebar has two options:

- Scan the directory and read each header plus the last `session_info` name.
- Use the SDK `SessionManager` list API (`$PI/examples/sdk/11-sessions.ts`).

**Export and share:** `export_html` over RPC, and `pi --export file.jsonl [out.html]` from the CLI. `/share` (gist or Radius) is TUI-only.

## 6. Extensions, skills, prompts, themes, thinking, images, compaction

**Extensions** (`extensions.md`):

- TypeScript modules loaded with jiti from `~/.pi/agent/extensions/`, `.pi/extensions/` (trusted projects), `-e path`, or packages (`pi install npm:…|git:…`).
- API: `pi.on(event)`, `registerTool` (TypeBox schema), `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `sendUserMessage`/`sendMessage`, `appendEntry`, `setActiveTools`, and model/thinking control.
- Events: `project_trust`, `session_start`/`session_shutdown`, `before_agent_start`, `context`/`context_with_system`, `tool_call` (block or mutate), `tool_result`, `message_end` (replace), `turn_end`/`agent_before_settle` (can continue), `user_bash`, `session_before_switch`/`session_before_fork` (veto), `cache_warming_decision`, `model_select`.
- Extensions run in-process with full user permissions.
- `--no-extensions` disables discovery.

**Skills** (`skills.md`):

- Follow the Agent Skills spec: a `SKILL.md` directory with frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`, …).
- Discovered in `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills` and `.agents/skills`.
- Only the name, description and path go into the system prompt; the model reads the full `SKILL.md` on demand.
- Forced with `/skill:name args`, which is available over RPC through `prompt` and listed by `get_commands` with `source:"skill"`.

**Prompt templates** (`prompt-templates.md`):

- Markdown files in `~/.pi/agent/prompts` or `.pi/prompts`. The filename becomes `/name`.
- Frontmatter: `description`, `argument-hint`. Arguments use `${1:-default}`-style substitution.
- Expanded by RPC `prompt`, `steer` and `follow_up`.

**Context files:**

- `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md`, loaded from the agent directory, the cwd and its ancestors. Disable with `--no-context-files`.
- `SYSTEM.md` replaces the system prompt; `APPEND_SYSTEM.md` appends to it. Launch flags: `--system-prompt`, `--append-system-prompt`.

**Themes:** JSON TUI color themes. They are irrelevant to a GUI; `setTheme` fails under RPC.

**Thinking levels:**

- `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, filtered per model. `get_available_thinking_levels` returns them.
- Launch forms: `--thinking` or the `--model sonnet:high` shorthand.
- Settings: `defaultThinkingLevel`, `modelThinkingLevels`, `thinkingBudgets`.
- The `thinking_level_changed` event reports changes.
- Session entries persist changes, and resuming restores them.

**Images:**

- `ImageContent{type:"image", data:base64, mimeType}` in `prompt`/`steer`/`follow_up.images`.
- The `read` tool returns images.
- Images are auto-resized to at most 2000x2000 and 4.5 MiB (`images.autoResize`), with per-model `inputLimits.images.resize`.
- `images.blockImages` stops images from being sent.
- The Model `input` array shows whether a model accepts images.

**Compaction** (`compaction.md`):

- Automatic when `contextTokens > contextWindow - reserveTokens` (reserve 16384 by default, keeping about 20k recent tokens).
- Also compact-and-retry recovery on overflow.
- Manual through `compact{customInstructions}`.
- Events: `compaction_start`/`compaction_end`. The toggle is `set_auto_compaction`.
- Original entries are kept in the tree.
- Extensions can supply custom compaction (`examples/extensions/custom-compaction.ts`).

**Retry:** `retry.enabled`/`maxRetries` (3)/`baseDelayMs` (2000). Controlled with `set_auto_retry` and `abort_retry`, reported with `auto_retry_*` events.

**Other:**

- Steering and follow-up queues, with modes `all` or `one-at-a-time`.
- `get_session_stats` gives cost and context usage (USD, from the per-model cost table).
- `cacheWarming` setting.
- `--offline` / `PI_OFFLINE=1`.
- The nix wrapper sets `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`.

## 7. GUI integration checklist (pi backend)

**Probes:**

- `pi --version`
- `pi auth check --provider X --json --no-refresh` for each candidate provider
- `pi --offline --list-models`, or a short-lived RPC `get_available_models`

**Run the session:**

- Spawn `pi --mode rpc --session-id <gui-id> --session-dir … --approve|--no-approve -e gui-approvals.ts`, with a scrubbed environment (the Anthropic OAuth variables removed).
- Reader: a byte-level LF splitter.
- Keep maps of pending command ids and pending `extension_ui_request` ids.
- Transcript: use `message_*` deltas live, reconcile on `message_end`, and treat `agent_settled` as idle.
- Rehydrate with `get_entries` and `get_tree` (the `since` cursor gives incremental sync).

**Gaps to cover outside RPC:**

- login: run the `pi` TUI in a terminal, or prefer API keys through env;
- session list: scan the session directory;
- tool toggling: restart with different `--tools`;
- in-file tree navigation: SDK only.

## 8. Sources

**Local docs** (`$PI/docs/`):

- `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `message-types.md`
- `sdk.md`, `cli-integration.md`, `cli.md`
- `security.md`, `providers.md`, `models.md`
- `sessions.md`, `session-format.md`
- `extensions.md`, `skills.md`, `prompt-templates.md`, `compaction.md`
- `settings.md`, `configuration.md`, `how-pi-works.md`, `usage.md`

**Local source:**

- `$PI/dist/modes/rpc/rpc-types.d.ts`, `rpc-mode.js`
- `$PI/dist/cli/auth-check.js`
- `$PI/dist/modes/interactive/interactive-mode.js` (Anthropic warning)
- `$PI/node_modules/@earendil-works/pi-ai/dist/auth/oauth/`
- `$PI/examples/rpc-client.ts`, `$PI/examples/extensions/permission-gate.ts`, `$PI/examples/extensions/README.md`
- `$PI/CHANGELOG.md` (0.66.0 warning; 0.87.x)
- `$PI/node_modules/@earendil-works/pi-client|pi-protocol/README.md` (experimental)

**Upstream:**

- https://github.com/earendil-works/pi (`packages/coding-agent/src/modes/rpc/rpc-types.ts`, `rpc-client.ts`, `docs/`)
- https://pi.dev, https://pi.dev/models

**Policy context:**

- https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and
- https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch
- https://fazm.ai/blog/anthropic-subscription-auth-warning-third-party-extra-usage

**CLI probes run (read-only):**

- `pi --help`
- `pi auth --help`
- `pi auth check … --json --no-refresh` (including dummy-env tests)
- `pi --offline --list-models`
- `jq` over `auth.json` keys and types only (no values)
