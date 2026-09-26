# Claude Code as an embeddable harness: capability inventory for a third-party GUI client

Research date: 2026-09-26. Local install checked: `claude` 2.1.283 (`~/.local/bin/claude`). TS Agent SDK checked: `@anthropic-ai/claude-agent-sdk` 0.3.283 (npm `latest`, which bundles Claude Code 2.1.283). Python SDK: `claude-agent-sdk` 0.2.160 (PyPI).

Primary sources (all fetched as `.md` from the docs index https://code.claude.com/docs/llms.txt):

- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Python SDK reference: https://code.claude.com/docs/en/agent-sdk/python
- Headless / programmatic: https://code.claude.com/docs/en/headless
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Permissions (SDK): https://code.claude.com/docs/en/agent-sdk/permissions
- Permission modes: https://code.claude.com/docs/en/permission-modes
- User input / approvals: https://code.claude.com/docs/en/agent-sdk/user-input
- Sessions (SDK): https://code.claude.com/docs/en/agent-sdk/sessions
- Sessions (CLI): https://code.claude.com/docs/en/sessions
- Streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output
- File checkpointing: https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- Cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Todo tracking: https://code.claude.com/docs/en/agent-sdk/todo-tracking
- Claude Code features in SDK: https://code.claude.com/docs/en/agent-sdk/claude-code-features
- Skills / commands in SDK: https://code.claude.com/docs/en/agent-sdk/skills
- Model config: https://code.claude.com/docs/en/model-config
- Authentication: https://code.claude.com/docs/en/authentication
- Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Help Center, "Use the Claude Agent SDK with your Claude plan": https://support.claude.com/en/articles/15036540
- Package typings (ground truth where the docs are silent): `sdk.d.ts` and `sdk-tools.d.ts` from `@anthropic-ai/claude-agent-sdk@0.3.283` (unpacked at `/private/tmp/claude-501/research/pkg/package/`)
- A real stream sample captured from `claude -p "say ok" --output-format stream-json --verbose --max-turns 1`: `/private/tmp/claude-501/research/sample-stream.jsonl`

Items marked **[typings]** are in `sdk.d.ts` but not on the docs pages. Items marked **[observed]** were seen on the wire in 2.1.283 but are documented nowhere. Items marked **[internal]** are marked experimental or internal in the typings, so a client should not rely on them.

---

## 0. Compliance summary (read first)

What the sources say:

1. **Legal and compliance page** (https://code.claude.com/docs/en/legal-and-compliance):
   - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
   - It also says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
   - Anyone embedding Claude Code must meet these conditions: "The Claude Code binary must not be modified … may not remove, disable, or restrict any authentication method built into it", and "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential". The integrator must not pay for, resell, or intermediate usage.
   - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
   - Naming: a product may say it "runs Claude Code". It may not use "Claude Code" or the Anthropic names or logos in its own product name or logo.
2. **Agent SDK overview and quickstart notes**: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods …". SDK branding rules allow "Claude Agent", or "{YourAgentName} Powered by Claude". They do not allow "Claude Code" or "Claude Code Agent", or any Claude Code-like ASCII art.
3. **Help Center 15036540**: dated update of June 15, 2026: *"We're pausing the changes to Claude Agent SDK usage … For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."* The paused plan (a separate monthly Agent SDK credit: Pro $20, Max 5x $100, Max 20x $200, and so on) explicitly listed "Third-party apps that authenticate with your Claude subscription through the Agent SDK" as a covered use. Anthropic therefore expects such apps to exist and to bill against the user's plan.

A defensible pattern for a GUI such as T3 Code, which is my synthesis of the sources above:

- Spawn only the official, unmodified binary, either the user's installed `claude` or the binary bundled with `@anthropic-ai/claude-agent-sdk`. Pass no flags that strip auth methods.
- Do not build a "Sign in with Claude" button that runs its own OAuth. Never read the Keychain or `~/.claude/.credentials.json`, never handle `CLAUDE_CODE_OAUTH_TOKEN`, never proxy requests, and never set `ANTHROPIC_BASE_URL` to your own server.
- Detect login state with `claude auth status` (JSON, exit code 0 or 1). When the user is not logged in, tell them to run `claude auth login`, which is Anthropic's own browser flow, in a terminal, or open the official CLI's `/login`. Whether a GUI may itself spawn `claude auth login`, which opens Anthropic's browser page and reads a pasted code on stdin, is a gray area. The safest option is a "Run `claude auth login` in Terminal" affordance.
- One user, one machine, their own login. No shared or pooled accounts.
- Brand as "X, powered by Claude" or "runs Claude Code". Do not name the product "Claude Code".
- The docs themselves conflict: the SDK pages say "not without approval" while the legal page carves out "end user signing in to the unmodified binary". A commercial product should get written confirmation from Anthropic (via sales). The docs say approval can be granted.

Technical traps that would silently break subscription use:

- `--bare` never reads OAuth or the keychain. It uses only `ANTHROPIC_API_KEY` or `apiKeyHelper`. Do not use it for subscription users (https://code.claude.com/docs/en/headless#start-faster-with-bare-mode).
- In the TS SDK, `env` **replaces** the child environment. Always spread `...process.env`, or `HOME`, `PATH` and keychain access are lost.
- Credential precedence puts `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` above the subscription login. In `-p` and SDK mode the key "is always used when present". If one leaks into the child environment, usage bills to that key instead of the plan. Check `apiKeySource` in `system/init` (`"none"` means no API key) and `authMethod` from `claude auth status`.

---

## 1. Integration options

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **TS Agent SDK `query()`** (`@anthropic-ai/claude-agent-sdk`) | Library that spawns the Claude Code native binary and speaks its stdin/stdout control protocol | Typed messages; `canUseTool` callback plumbing; hooks as JS callbacks; in-process MCP tools; all runtime control methods; session helpers (`listSessions`, `getSessionMessages`, `forkSession`, `renameSession`, `tagSession`, `deleteSession`); `startup()` and `prewarm()` for low latency | Node, Bun or Deno only; the version is pinned to the bundled CLI |
| **Python Agent SDK** (`claude-agent-sdk`) | Same approach; `query()` for one-shot, `ClaudeSDKClient` for interactive | Bundles the CLI in platform wheels | Fewer runtime methods (for example, no `applyFlagSettings`); interrupts only via `ClaudeSDKClient` |
| **Raw CLI** `claude -p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages] [--permission-prompt-tool stdio]` | NDJSON over stdio. This is exactly what the SDK does under the hood. | Any language; uses the user's installed `claude` | The stdio control protocol (`control_request` / `control_response`) is documented only through SDK typings. `--permission-prompt-tool stdio` is an undocumented value. You re-implement the SDK's plumbing. |

**Recommendation.** Use the **TypeScript Agent SDK** in streaming-input mode, which is `prompt` as an `AsyncIterable<SDKUserMessage>`. The docs call it "the preferred way" (https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). It is required for `interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings`, image input and queued messages. The docs point other languages to the raw CLI (https://code.claude.com/docs/en/agent-sdk/overview).

**What the SDK spawns** (from `sdk.mjs` 0.3.283): `claude --output-format stream-json --verbose --input-format stream-json`, plus flags translated from options: `--thinking`, `--effort`, `--max-turns`, `--max-budget-usd`, `--permission-prompt-tool stdio` (when `canUseTool` is set), `--permission-prompts`, `--continue`, `--resume=<id>`, `--allowedTools`, `--disallowedTools`, `--tools`, `--mcp-config`, and so on. Hooks, agents, the system prompt, the JSON schema and SDK MCP servers go in the `initialize` control request, not argv. It sets `CLAUDE_AGENT_SDK_VERSION` in the child environment. `CLAUDE_AGENT_SDK_CLIENT_APP` can identify your app in the User-Agent.

**How the SDK locates the binary**:

- **TS.** The SDK bundles a native binary as a platform `optionalDependency` (`@anthropic-ai/claude-agent-sdk-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,linux-*-musl,win32-x64,win32-arm64}`). It resolves the binary with `require.resolve`. If none is found, it throws `Native CLI binary for <platform>-<arch> not found … set options.pathToClaudeCodeExecutable`. SDK `0.3.N` bundles Claude Code `2.1.N`. You can override with `pathToClaudeCodeExecutable`, for example to use the user's own `~/.local/bin/claude`, which auto-updates. For `bun build --compile`, use `extractFromBunfs()` from `@anthropic-ai/claude-agent-sdk/extract`. Two entry points exist: root, and `/core` (smaller; omits `prewarm` and the session list, read and fork helpers).
- **Python.** The CLI is bundled in platform wheels. Override with `ClaudeAgentOptions(cli_path=...)`.

**Is the bundled binary compliant?** It is Anthropic's published, unmodified binary, so it meets "installed and run as published by Anthropic". Either the bundled binary or the user's `claude` is fine. The user's install shares its login and settings automatically, because both read `~/.claude` and the Keychain entry keyed to `CLAUDE_CONFIG_DIR`.

**Sessions started by the SDK or `-p` do not appear** in the interactive `claude --resume` picker or in `claude --continue`. They can still be resumed by ID (https://code.claude.com/docs/en/sessions).

---

## 2. SDK `Options` (TypeScript, 0.3.283)

Source: https://code.claude.com/docs/en/agent-sdk/typescript#options, plus [typings].

| Option | Meaning |
|---|---|
| `abortController` | Cancels the query and kills the process (stdin closes first, then the signal fires about 2 s later) |
| `additionalDirectories` | Extra dirs (`--add-dir`); also loads their skills, commands and agents when the `project` source is on |
| `agent` | Named agent to run as the main thread |
| `agents` | `Record<name, AgentDefinition>` programmatic subagents: `description`, `prompt`, `tools`, `disallowedTools`, `model`, `mcpServers`, `skills`, `initialPrompt`, `maxTurns`, `background`, `omitClaudeMd`, `memory`, `effort`, `permissionMode` |
| `agentProgressSummaries` | One-line progress summaries on `task_progress.summary` for subagents |
| `allowDangerouslySkipPermissions` | Required to use or switch to `bypassPermissions` |
| `allowedTools` | Auto-approve rules (for example `"Read"`, `"Bash(npm test *)"`, `"mcp__srv__*"`); does not restrict availability |
| `betas` | Beta headers (API key only; `context-1m-2025-08-07` is retired) |
| `canUseTool` | Permission callback (see section 5) |
| `continue` | Continue the most recent session in `cwd` |
| `cwd` | Working directory |
| `debug`, `debugFile` | Debug logging |
| `disallowedTools` | A bare name removes the tool; a scoped rule denies matches in every mode; `"*"` and `"mcp__*"` globs are supported |
| `effort` | `'low'|'medium'|'high'|'xhigh'|'max'` |
| `enableFileCheckpointing` | Track Write, Edit and NotebookEdit changes for `rewindFiles` |
| `env` | Child environment (**replaces** `process.env`) |
| `executable`, `executableArgs` | JS runtime for a JS CLI (legacy) |
| `extraArgs` | Arbitrary CLI flags, for example `{ "replay-user-messages": null }` |
| `fallbackModel` | Comma-separated fallback chain |
| `forkSession` | With `resume`, fork to a new session ID |
| `forwardSubagentText` | Emit subagent text and thinking as messages with `parent_tool_use_id` |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>`, JS callbacks |
| `includeHookEvents` | Emit `hook_started`, `hook_progress` and `hook_response` for all hooks |
| `includePartialMessages` | Emit `stream_event` partials (token streaming) |
| `loadTimeoutMs` | *Alpha.* `sessionStore` load timeout |
| `managedSettings` | Policy-tier settings from the host (restrictive-only filter) |
| `maxBudgetUsd` | Stop when the client-side cost estimate reaches this value |
| `maxThinkingTokens` | *Deprecated*; use `thinking` |
| `maxTurns` | Limit on agentic turns |
| `mcpServers` | `Record<name, stdio|sse|http|sdk config>` |
| `model` | Alias (`default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `opus[1m]`, `sonnet[1m]`, `opusplan`) or full ID |
| `onElicitation` | MCP elicitation handler (form or url); if unset, elicitation is declined |
| `onUserDialog`, `supportedDialogKinds` **[typings]** | Host-rendered blocking dialogs (`request_user_dialog`, for example `refusal_fallback_prompt`); the CLI only emits the kinds you declare |
| `outputFormat` | `{ type:'json_schema', schema }` for structured output (`result.structured_output`) |
| `pathToClaudeCodeExecutable` | Override the binary |
| `permissionMode` | `default|acceptEdits|plan|dontAsk|auto|bypassPermissions` (SDK default: `default`) |
| `permissionPromptToolName` | MCP tool that answers prompts (mutually exclusive with `canUseTool`) |
| `permissionPrompts` | `'host'` (default) or `'none'` (deny anything that would prompt; also removes AskUserQuestion) |
| `perTaskStopAffordance` **[typings]** | Declares that the UI has per-task stop buttons; interrupt then spares background tasks |
| `persistSession` | `false` means no transcript on disk |
| `planModeInstructions` | Replace the plan-mode workflow body |
| `pluginDelivery` **[typings]** | `'argv'|'initialize'` |
| `plugins` | `[{type:'local', path, skipMcpDiscovery?}]` |
| `projectConfigRoot` | For worktrees: read project config from the main checkout |
| `promptSuggestions` | Emit `prompt_suggestion` after turns |
| `resume`, `resumeSessionAt`, `resumeDropsTurn` | Resume by ID, optionally truncating at a message UUID |
| `sandbox` | `SandboxSettings` (enabled, network allow and deny lists, filesystem allowWrite, denyWrite and denyRead, excludedCommands, and so on) |
| `sessionId` | Choose the session UUID |
| `sessionStore`, `sessionStoreFlush` | Mirror transcripts to external storage |
| `settings` | Inline settings object, JSON string or path (flag-settings layer) |
| `settingSources` | `['user','project','local']` by default; `[]` disables them (managed settings, `~/.claude.json`, auto-memory and claude.ai connectors still load) |
| `skills` | `'all'` or a list of names (auto-adds the Skill tool) |
| `spawnClaudeCodeProcess` | Custom spawn (VM, container, SSH) |
| `stderr` | stderr callback |
| `strictMcpConfig` | Use only `mcpServers`; ignore `.mcp.json`, user, plugin and claude.ai connector servers |
| `systemPrompt` | String, string array, `{type:'custom',prompt,snapshot?}`, or `{type:'preset',preset:'claude_code',append?,excludeDynamicSections?,snapshot?}`. **Default is a minimal prompt, not Claude Code's.** Use the preset for Claude Code behavior. |
| `taskBudget` | *Alpha.* API-side token budget |
| `thinking` | `{type:'adaptive'|'enabled'|'disabled', budgetTokens?, display?:'summarized'|'omitted'}`. On Opus 4.7 and later the default display is `omitted`, so set `'summarized'` to show thinking text. |
| `title` | Session display title |
| `toolAliases` | Map built-in tools to MCP tools (for example `Bash` to `mcp__ws__bash`) |
| `toolConfig` | `{ askUserQuestion: { previewFormat: 'markdown'|'html' } }` |
| `tools` | Array of built-in tool names, or `{type:'preset',preset:'claude_code'}` |
| `verbatimPrompts` | Send every prompt with `client_composed: true` (no `@` expansion or slash dispatch) |

Other top-level functions: `query`, `startup` (returns `WarmQuery`), `prewarm` (returns `SpareProcess.claim()`), `tool`, `createSdkMcpServer`, `listSessions`, `getSessionInfo`, `getSessionMessages`, `getSubagentMessages`, `listSubagents`, `renameSession`, `tagSession`, `deleteSession`, `forkSession(id,{upToMessageId})`, `importSessionToStore`, `resolveSettings` (alpha), `InMemorySessionStore`, `AbortError`.

---

## 3. Message and event schema (`SDKMessage` union)

Every message carries `uuid` and `session_id`. Wire lines are the same JSON objects. Sources: https://code.claude.com/docs/en/agent-sdk/typescript#message-types, plus [typings].

### Conversation messages
- **`assistant`**: `{ message: BetaMessage (id, model, content[text|thinking|redacted_thinking|tool_use|server_tool_use…], stop_reason, usage), parent_tool_use_id, error?, aborted?, timestamp?, context_usage?, user_message_uuid(s)? }`. `error` is one of `authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|rate_limit|overloaded|invalid_request|model_not_found|server_error|max_output_tokens|cloud_credential_error|unknown`.
  - One API message can arrive as several `assistant` frames that share `message.id`, one per content block. The sample shows the thinking block, then the text block.
  - [observed] extra fields: `request_id`, and in `message`: `container`, `stop_details`, `diagnostics`, `context_management`.
- **`user`** (input or echo): `{ message: MessageParam, parent_tool_use_id, uuid?, isSynthetic?, shouldQuery?, client_composed?, tool_use_result?, origin?, pasted_content?, inline_pastes? }`.
  - Tool results come back as `user` messages that contain `tool_result` blocks. `tool_use_result` holds the tool's structured output; see the Tool Output Types in `sdk-tools.d.ts`.
  - `origin.kind` is one of `human|channel|peer|task-notification|coordinator|auto-continuation|unclassified`. **Set `origin:{kind:'human'}` on user-typed messages.**
- **`user` with `isReplay: true`**: echo of stdin messages (with `--replay-user-messages`) and injected peer or channel turns.
- **`stream_event`** (`includePartialMessages`): `{ event: BetaRawMessageStreamEvent, parent_tool_use_id (always null), ttft_ms? }`.
  - Event types: `message_start`, `content_block_start`, `content_block_delta` (`text_delta` / `input_json_delta` / `thinking_delta`), `content_block_stop`, `message_delta`, `message_stop`, and `ping`. Treat `ping` as liveness.
- **`result`**:
  - Subtypes: `success|error_max_turns|error_during_execution|error_max_budget_usd|error_max_structured_output_retries`.
  - Fields: `duration_ms, duration_api_ms, is_error, api_error_status?, num_turns, result (success only), stop_reason, total_cost_usd, usage, modelUsage{model→{inputTokens,outputTokens,thinkingTokens?,cacheRead/CreationInputTokens,webSearchRequests,costUSD,contextWindow,maxOutputTokens,canonicalModel?,provider?,costBasis?}}, permission_denials[{tool_name,tool_use_id,tool_input}], queued_turn_count?, structured_output?, deferred_tool_use?, terminal_reason?, fast_mode_state?, fast_mode_disabled_reason?, origin?, errors[] (error arms), startup_failure_reason?, ttft_ms?, ttft_stream_ms?, first_content_frame_ms?, user_message_uuid(s)?`.
  - `terminal_reason` is one of `completed|max_turns|tool_deferred|aborted_streaming|aborted_tools|hook_stopped|stop_hook_prevented|background_requested|blocking_limit|rapid_refill_breaker|prompt_too_long|image_error|model_error|api_error|malformed_tool_use_exhausted|budget_exhausted|structured_output_retry_exhausted|tool_deferred_unavailable|turn_setup_failed`.
  - [observed] also `result_index`, `time_to_request_ms`, and `subagent_stats{spawned, requested, completed, failed, killed, refused, by_type…}`.
  - In streaming-input mode you get **one result per turn**, and `modelUsage` and `total_cost_usd` are cumulative.
- **`prompt_suggestion`**: `{ suggestion }`.
- **`tool_use_summary`**: `{ summary, preceding_tool_use_ids[] }`.
- **`conversation_reset`**: `{ new_conversation_id, trigger?: clear|plan_mode_exit|fresh_session|onboarding, user_message_uuid?, timestamp? }`. On this message, reset the transcript view.

### `type: "system"` subtypes
- **`init`**: `agents?, apiKeySource ('ANTHROPIC_API_KEY'|'apiKeyHelper'|'/login managed key'|'none'), betas?, claude_code_version, cwd, tools[], mcp_servers[{name,status,source?}], model, permissionMode, slash_commands[], terminal_slash_commands?, output_style, skills[], plugins[{name,path}], plugin_errors?, mcp_server_errors?, fast_mode_state?, fast_mode_disabled_reason?, effort?, capabilities?[]`.
  - Capabilities in 2.1.283 **[observed]**: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`, `mcp_read_resource_v1`, `mcp_tool_ui_meta_v1`.
  - [observed] extra fields: `analytics_disabled`, `product_feedback_disabled`, `memory_paths{auto}`, `messaging_socket_path`, `per_turn_effort_active`, `view_mode`, and `plugins[].source/version`.
- **`compact_boundary`**: `{ compact_metadata:{ trigger:'manual'|'auto', pre_tokens } }`.
- **`status`**: `{ status:'compacting'|null, permissionMode? }`. Use it for the compaction spinner and for mode changes.
- **`informational`**: `{ content, level:'info'|'notice'|'suggestion'|'warning', tool_use_id?, prevent_continuation? }`. Carries warnings and hook systemMessages.
- **`hook_started` / `hook_progress` / `hook_response`**: `{ hook_id, hook_name, hook_event, stdout, stderr, output, exit_code?, outcome }`. SessionStart and Setup hooks always emit these.
- **`task_started`**: `{ task_id, tool_use_id?, description, task_type:'local_bash'|'local_agent'|'remote_agent', is_backgrounded?, spawn_depth?, ambient? }`.
- **`task_progress`**: `{ task_id, description, subagent_type?, usage{total_tokens,tool_uses,duration_ms}, last_tool_name?, summary? }`.
- **`task_updated`**: `{ task_id, patch{status,description,end_time,total_paused_ms,error,is_backgrounded} }`.
- **`task_notification`**: `{ task_id, tool_use_id?, status:'completed'|'failed'|'stopped', output_file, summary, usage?, resource_links? }`.
- **`background_tasks_changed`**: `{ tasks[{task_id,task_type,description,ambient?}] }`. This is the full live set, so replace the cached set with it.
- **`thinking_tokens`**: `{ estimated_tokens, estimated_tokens_delta }`. Use it for a live thinking counter.
- **`api_retry`**: `{ attempt, max_retries, retry_delay_ms, error_status, error, no_response? }`.
- **`permission_denied`**: `{ tool_name, tool_use_id, agent_id?, decision_reason_type?, decision_reason?, message }`.
- **`commands_changed`**: `{ commands: SlashCommand[] }` (full list).
- **`notification`** [typings]: `{ key, text, priority:'low'|'medium'|'high'|'immediate', color?, timeout_ms? }`.
- **`session_state_changed`** [typings]: `{ state:'idle'|'running'|'requires_action' }`. The SDK source lists an env var `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, which is likely required to enable it (unverified).
- **`memory_recall`** [typings]: `{ mode, memories[{path,scope,content?}] }`.
- **`elicitation_complete`** [typings]: `{ mcp_server_name, elicitation_id }`.
- **`files_persisted`**: `{ files[{filename,file_id}], failed[], processed_at }`.
- **`plugin_install`**: `{ status, name?, error? }` (with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`).
- **`worker_shutting_down`**: `{ reason }`.
- **`mirror_error`**: `{ error, key }` (sessionStore).
- **`local_command_output`**: declared but not emitted. Command output arrives as `assistant` messages.
- **`control_request_progress`** [typings]: progress for long control requests.

### Other types
- **`tool_progress`**: `{ tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, task_id?, heartbeat? (every 30 s), subagent_type?, subagent_retry? }`.
- **`auth_status`**: `{ isAuthenticating, output[], error? }`.
- **`rate_limit_event`**: documented as `{ rate_limit_info:{ status:'allowed'|'allowed_warning'|'rejected', resetsAt?, utilization?, errorCode?:'credits_required', canUserPurchaseCredits?, hasChargeableSavedPaymentMethod? } }`.
  - [observed] on a Max plan: `rateLimitType:'five_hour'`, `overageStatus`, `overageDisabledReason`, `isUsingOverage`, and `unifiedWindows{five_hour{utilization,resetsAt}, seven_day{…}}`. **This is the way to show subscription usage bars without any token access.**

Subagent attribution: a nested agent's messages carry `parent_tool_use_id` set to the Agent or Skill `tool_use` ID. `SessionMessage.parent_agent_id` covers nested depth.

---

## 4. Control protocol and runtime `Query` methods

Wire envelope ([typings]):

- Request, sent by either side: `{"type":"control_request","request_id":"…","request":{"subtype":…}}`
- Reply: `{"type":"control_response","response":{"subtype":"success"|"error","request_id","response"|"error", pending_permission_requests?, pending_user_dialog_requests?}}`
- Cancel: `{"type":"control_cancel_request","request_id"}`
- User input on stdin: `{"type":"user","message":{"role":"user","content":…},"parent_tool_use_id":null,"uuid"?:…,"origin":{"kind":"human"}}`

Documented `Query` methods (https://code.claude.com/docs/en/agent-sdk/typescript#query-object). Methods marked (S) need streaming-input mode.

| Method | Wire subtype | Purpose |
|---|---|---|
| `interrupt()` | `interrupt` (`cancel_queued?`) | Stop the current turn. Returns `{still_queued[], cancelled?}` receipt. (S) |
| `setPermissionMode(mode)` | `set_permission_mode` | Change mode live. (S) |
| `setModel(model?)` | `set_model` | Switch model; `undefined` or `"default"` resets. Applies mid-turn from the next API call. (S) |
| `setMaxThinkingTokens(n|null)` | `set_max_thinking_tokens` | Deprecated |
| `applyFlagSettings(settings)` | `apply_flag_settings` | Any settings key at runtime: `effortLevel` (and `ultracode`), `permissions`, `hooks`, `fastMode`, `agent`, `model`, `skillOverrides`; `null` clears. System prompt changes have no effect mid-session. (S) |
| `updateSettings(source,{…})` | `update_settings` | Persist `outputStyle` (localSettings) or `effortLevel` (userSettings) |
| `initializationResult()` / `reinitialize()` | `initialize` | `{commands, agents, output_style, available_output_styles, models, account, fast_mode_state, fast_mode_disabled_reason?, hooks_applied?}`; `reinitialize` re-delivers pending permission requests after a transport gap |
| `supportedCommands()` | from init / `commands_changed` | `SlashCommand{name,description,argumentHint,aliases?,builtin?}` |
| `supportedModels()` | init (`list_models` for remote) | `ModelInfo{value,resolvedModel?,displayName,description,supportsEffort?,supportedEffortLevels?,supportsAdaptiveThinking?,supportsFastMode?,supportsAutoMode?}` |
| `supportedAgents()` | init | `AgentInfo{name,description,model?}` |
| `mcpServerStatus()` | `mcp_status` | `[{name,status:'connected'|'failed'|'needs-auth'|'pending'|'disabled',serverInfo?,error?,config?,scope?,source?,tools?[]}]` |
| `reconnectMcpServer(name)` / `toggleMcpServer(name,bool)` / `setMcpServers(map)` | `mcp_reconnect` / `mcp_toggle` / `mcp_set_servers` | MCP management |
| `readMcpResource(server, 'ui://…')` | `mcp_read_resource` | MCP Apps widget HTML (render sandboxed) |
| `getContextUsage({detail})` | `get_context_usage` | `/context` data: `categories, totalTokens, maxTokens, percentage, memoryFiles, mcpTools, agents, skills, autoCompactThreshold, isAutoCompactEnabled, messageBreakdown, apiUsage` |
| `readFile(path,{maxBytes,encoding})` | `read_file` | Read files in the session cwd (for a file viewer) |
| `reloadSkills()` / `reloadPlugins()` [typings] / `reloadOutputStyles()` [typings] | `reload_*` | Hot reload |
| `accountInfo()` | from init | `{email?, organization?, subscriptionType?, tokenSource?, apiKeySource?}`. **Auth info without tokens.** |
| `rewindFiles(userMsgId,{dryRun})` | `rewind_files` | `{canRewind,error?,filesChanged?,insertions?,deletions?,skippedLinks?}` |
| `streamInput(iterable)` | stdin `user` lines | Push more user messages |
| `stopTask(taskId)` | `stop_task` | Stop a background task |
| `backgroundTasks(toolUseId?)` [typings] | `background_tasks` | The Ctrl+B equivalent: background running Bash or subagents |
| `setMcpPermissionModeOverride(server, 'default'|'auto'|null)` [typings] | — | Tighten-only per-server override |
| `seedReadState(path, mtime)` [typings] | `seed_read_state` | Internal edit-safety cache |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})` [internal] | `get_usage` | `/usage` data including `subscription_type` and plan `rate_limits{five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_oauth_apps, …}` |
| `close()` | — | Kill the process |

Other control subtypes exist on the wire but have no public method: `rename_session`, `set_color`, `get_session_cost`, `get_binary_version`, `file_suggestions` (@-mention autocomplete), `cancel_async_message` (unqueue a message by UUID), `get_settings`, `get_hooks_listing`, `list_permission_rules`, `mcp_call`, `mcp_message`, `register_repo_root`. CLI-to-host requests: `can_use_tool`, `hook_callback`, `elicitation`, `request_user_dialog`.

---

## 5. Permissions

Modes (https://code.claude.com/docs/en/permission-modes, https://code.claude.com/docs/en/agent-sdk/permissions):

| Mode | Behavior |
|---|---|
| `default` (labeled **Manual** in the UI; the CLI accepts the alias `manual`) | Reads auto-approved; everything else prompts through `canUseTool` |
| `acceptEdits` | Edits and filesystem commands (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`) inside the working directories are auto-approved |
| `plan` | Read-only exploration; edits and file-modifying shell commands always go to `canUseTool`; ends with `ExitPlanMode` |
| `auto` | A classifier approves or denies prompts (plan and model availability rules apply) |
| `dontAsk` | Anything that would prompt is denied; `canUseTool` is never called |
| `bypassPermissions` | Everything is approved (needs `allowDangerouslySkipPermissions`; refused as root) |

The SDK and `-p` start in `default`. The interactive terminal defaults to `auto` in 2.1.283. `permissions.defaultMode` in settings also applies: the sample `-p` run started in `auto` because this user's `~/.claude/settings.json` sets `"defaultMode": "auto"`.

Evaluation order: hooks, then deny rules, then ask rules, then mode, then allow rules, then `canUseTool`. "Actions no mode auto-approves" always reach the callback, or are denied in `dontAsk`: explicit ask rules, AskUserQuestion, MCP tools with `requiresUserInteraction`, org-`ask` connectors, and `rm`/`rmdir` of critical paths.

**`canUseTool(toolName, input, {signal, suggestions?, blockedPath?, mcpServer?, decisionReason?, toolUseID, agentID?, requestId})`** returns a `PermissionResult`:
- Allow: `{ behavior:'allow', updatedInput?, updatedPermissions?: PermissionUpdate[], toolUseID? }`. `updatedInput` lets you edit the call.
- Deny: `{ behavior:'deny', message, interrupt?: boolean }`. Claude sees `message`; `interrupt:true` also stops the turn.
- `null` means your app already answered out of band using `requestId`.
- Callbacks may stay pending indefinitely; there is no timeout. Make them idempotent per `requestId`, because `reinitialize` re-dispatches pending requests.
- The raw wire `can_use_tool` request also carries [typings] `title`, `display_name`, `description`, `decision_reason_type`, `classifier_approvable`, `suppress_always_allow_rule`, `default_to_no` and `matched_ask_rule`. These are useful for rendering the prompt the way the CLI does.

**"Always allow"**: echo one of `suggestions` in `updatedPermissions`. `PermissionUpdate` is one of:

- `addRules|replaceRules|removeRules{rules[{toolName,ruleContent?}], behavior:'allow'|'deny'|'ask', destination}`
- `setMode{mode,destination}`
- `addDirectories|removeDirectories{directories,destination}`

`destination` is one of `userSettings|projectSettings|localSettings|session|cliArg`. A `localSettings` suggestion writes to `.claude/settings.local.json`.

**AskUserQuestion** reaches `canUseTool` with `toolName === 'AskUserQuestion'`:

- Input: `{ questions:[{question, header (≤12 chars), options:[{label, description, preview?}] (2–4), multiSelect}] }`.
- Answer by allowing with `updatedInput: { questions, answers: { [questionText]: label | "a, b" | freeText }, response?: string }`.
- `toolConfig.askUserQuestion.previewFormat` turns on markdown or HTML previews on options.
- It is not available in subagents. `permissionPrompts:'none'` removes the tool.
- (https://code.claude.com/docs/en/agent-sdk/user-input)

**ExitPlanMode** in plan mode also routes to `canUseTool`:

- The documented input schema is only the deprecated `allowedPrompts` plus an open index signature. The plan text and plan-file path are surfaced in the tool input by the CLI **(verify on the wire; the output type has `plan`, `filePath` and `planWasEdited`)**.
- Approve: allow, then usually call `setPermissionMode('acceptEdits'|'default'|'auto')`. You can also return `updatedPermissions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]`.
- Reject or keep planning: deny with feedback text.
- `planModeInstructions` customizes the plan workflow.
- A `conversation_reset` with `trigger:'plan_mode_exit'` appears if clear-context-on-accept is used.

Deferral: a `PreToolUse` hook can return `permissionDecision:"defer"`. The result then has `stop_reason:"tool_deferred"` and `deferred_tool_use`. Resume later. This covers long-pending approvals.

---

## 6. Auth detection (no token access)

- **`claude auth status`**: JSON by default (`--text` for human output). **Exit code 0 means logged in; 1 means not.** Verified on 2.1.283:
  ```json
  {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,
   "projectsDirectory":"~/.claude/projects","configDirectory":"~/.claude",
   "email":"…","orgId":"…","orgName":"…","subscriptionType":"max"}
  ```
  - `authMethod` values, from the 2.1.283 binary: `claude.ai` | `api_key` | `api_key_helper` | `oauth_token` (`CLAUDE_CODE_OAUTH_TOKEN` or setup-token) | `third_party` (Bedrock, Vertex or Foundry) | `none`. The Console "/login managed key" also reports `claude.ai`, with `apiKeySource` set.
  - Optional `apiKeySource` and `forcedLoginMethod` fields.
  - `email`, `orgId`, `orgName` and `subscriptionType` (`pro`/`max`/`team`/`enterprise`) appear only for `claude.ai`.
  - `apiProvider` is one of `firstParty`, `bedrock`, `vertex`, `foundry`, `gateway`, and others.
- **In-session**: `system/init.apiKeySource` (`none` means no API key is in use, so it is OAuth or a provider), `query.accountInfo()` (`{email, organization, subscriptionType, tokenSource, apiKeySource}`), and `auth_status` messages during auth flows.
- **Error signals**: assistant `error:'authentication_failed'|'oauth_org_not_allowed'|'billing_error'|'account_on_hold'`, a "Not logged in" or "Login expired · Please run /login" result, and `rate_limit_event.errorCode:'credits_required'`.
- **Login and logout** (Anthropic's own flows): `claude auth login [--claudeai|--console|--sso|--email]`, `claude auth logout`, and `/login`, `/logout` in the TUI. The login opens a browser and accepts a pasted code on stdin when the localhost callback fails. `claude setup-token` prints a one-year subscription token for CI. A GUI should not collect it.
- Credentials live in the macOS Keychain, or in `~/.claude/.credentials.json` (mode 0600) on Linux and Windows. Do not read either (https://code.claude.com/docs/en/authentication#credential-management).
- Precedence: cloud provider env, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then Anthropic profile, then subscription `/login`.

---

## 7. Sessions

- **Storage**: `~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`). Names over 200 characters are truncated and hashed; `CLAUDE_CODE_PROJECT_DIR_NAME` overrides the directory name. Retention is 30 days (`cleanupPeriodDays`). The JSONL format is **internal and changes between versions**, so use the SDK helpers rather than parsing it (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).
- **List and read**: `listSessions({dir?, limit?, includeWorktrees?})` returns `{sessionId, summary, lastModified, fileSize, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt}`. Also `getSessionInfo`, `getSessionMessages(id,{dir,limit,offset})` (user and assistant only, with `parent_tool_use_id` and `parent_agent_id`), `getSubagentMessages` and `listSubagents`.
- **Mutate**: `renameSession`, `tagSession`, `deleteSession`, `forkSession(id,{upToMessageId})`.
- **Resume, continue, fork**: options `resume: id`, `continue: true`, `forkSession: true`, `resumeSessionAt: msgUuid`, `sessionId: uuid`, `persistSession:false`. CLI equivalents: `-r/--resume <id|name|path.jsonl>`, `-c/--continue`, `--fork-session`, `--session-id`, `--no-session-persistence`, `-n/--name`.
  - The session ID comes from `system/init.session_id` or any message.
  - Resume restores history, model, agent and goal. It does **not** restore `--mcp-config`, `--settings`, `--plugin-dir` or `--add-dir`; pass them again. `-p` and SDK resumes start in the default mode, except that plan mode is restored under specific conditions.
  - `/clear` produces `conversation_reset` with `new_conversation_id`.
- **External storage**: the `sessionStore` adapter (https://code.claude.com/docs/en/agent-sdk/session-storage).

---

## 8. Other things a GUI should surface

- **Models**: `supportedModels()` gives the picker with effort-level support per model. Switch with `setModel`. Aliases resolve per provider; on the first-party API, `opus` is Opus 5.5 and `sonnet` is Sonnet 5. `fallbackModel` and `opusplan` also exist. Fast mode needs `settings.fastMode:true` (the init sample showed `fast_mode_disabled_reason:'sdk_opt_in_required'`).
- **Effort and thinking**: `effort` option, or `applyFlagSettings({effortLevel})` at runtime. Levels depend on the model (`low|medium|high|xhigh|max`); Opus 5.5 defaults to `medium`. `ultracode` is available. Configure `thinking`, and set `display:'summarized'` to receive thinking text. Show `thinking_tokens` events as a live counter.
- **Context and compaction**: use `getContextUsage()` or send `/context` (the assistant message then carries `context_usage`). Show `status:'compacting'` and `compact_boundary{trigger,pre_tokens}`. Manual compaction: send `/compact [instructions]` as a prompt. Tune with `--autocompact` or the auto-compact window setting. PreCompact and PostCompact hooks exist.
- **Cost and usage**: `result.total_cost_usd` and `modelUsage` are client-side list-price estimates. For subscription users, show plan utilization from `rate_limit_event` (`unifiedWindows` five_hour and seven_day), or from the experimental `get_usage` request (https://code.claude.com/docs/en/agent-sdk/cost-tracking).
- **Images and files**: send content blocks in `SDKUserMessage.message.content`: `{type:'image',source:{type:'base64',media_type,data}}`, and document blocks for PDFs. `@path` mentions in text expand to file references unless `client_composed:true`. Use `pasted_content` or `inline_pastes` for pasted text. The `file_suggestions` control request powers @-autocomplete [internal].
- **Slash commands and skills**: `init.slash_commands` (hide `terminal_slash_commands`), `supportedCommands()` and `commands_changed`. Send `/name args` as a user message; output arrives as `assistant` messages. `skills` option; `reloadSkills()`.
- **Subagents and background tasks**: use `task_started`, `task_progress`, `task_updated`, `task_notification` and `background_tasks_changed` to build a task panel. Also `tool_progress` heartbeats, `stopTask(id)`, `backgroundTasks()`, and `forwardSubagentText` for nested transcripts. Set `perTaskStopAffordance` if the UI has per-task stop buttons.
- **Todos**: `TodoWrite` `{todos:[{content,status,activeForm}]}`, or the Task tools (`TaskCreate`, `TaskUpdate` with status including `deleted`, `TaskList`, `TaskGet`). These exist by default only on older models (Opus ≤4.7, Sonnet ≤4.6, Haiku 4.5). On newer models, opt in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or by listing them in `allowedTools` or `tools`. Render from `tool_use` inputs (https://code.claude.com/docs/en/agent-sdk/todo-tracking).
- **File checkpointing and rewind**: `enableFileCheckpointing:true`, then `rewindFiles(userMessageUuid,{dryRun})`. You need user-message UUIDs: set `uuid` on your own messages, or use `extraArgs:{'replay-user-messages':null}`. Only Write, Edit and NotebookEdit changes are tracked, not Bash. Files are rewound; the conversation is not. For conversation rewind use `resumeSessionAt` or `forkSession(upToMessageId)`.
- **Notifications and attention**: `system/notification`, `session_state_changed` (`requires_action`), pending `can_use_tool`, `PermissionRequest` and `Notification` hooks, and `prompt_suggestion`.
- **MCP**: `init.mcp_servers`, `mcpServerStatus()`, `toggleMcpServer`, `reconnectMcpServer` and `setMcpServers`. `needs-auth` means you should direct the user to `claude mcp login <name>`. Also `onElicitation`, MCP Apps via `readMcpResource`, and the CLI commands `claude mcp add|add-json|list|get|remove|login|logout`. claude.ai connectors load automatically with a subscription login (`source:'claudeai'`).
- **Plugins**: `plugins` option, `init.plugins` and `plugin_errors`, and `claude plugin list --json [--available]`, `install`, `enable`, `disable`, `marketplace`.
- **Settings**: `settingSources`, inline `settings`, `resolveSettings()` (alpha; shows effective settings with provenance), `applyFlagSettings` and `updateSettings`. The output style comes from `initializationResult().available_output_styles`.
- **Hooks**: 33 events, including PreToolUse, PostToolUse, Stop, SessionStart, UserPromptSubmit, PreCompact, PermissionRequest, Notification, SubagentStart and FileChanged. Register them as SDK callbacks, and render hook lifecycle events with `includeHookEvents`.
- **Sandbox**: `sandbox` option (macOS Seatbelt; Linux bubblewrap and socat), with network domain allow and deny lists and filesystem rules.
- **Errors and retries**: `api_retry` events, `result.startup_failure_reason` (set `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`), and `AbortError`. `SIGTERM` exits 143 without a result, so prefer `interrupt()`.
- **Structured output**: `outputFormat:{type:'json_schema',schema}`, read from `result.structured_output`.
- **Diagnostics**: `claude doctor`, `claude --version`, and `init.claude_code_version`, plus `capabilities` for feature detection.

---

## Appendix: captured stream sample (2.1.283, `-p`, abbreviated)

Order: 5× `hook_started` (SessionStart), `hook_response`/`hook_progress` ×6, `system/init`, `assistant` (thinking block), `assistant` (text block, same `message.id`), `rate_limit_event`, `result/success`. Full file: `/private/tmp/claude-501/research/sample-stream.jsonl`.

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790449800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.06,"resetsAt":1790449800},"seven_day":{"utilization":0.2,"resetsAt":1790845200}}}, "uuid":"…","session_id":"…"}
```

Result keys: `api_error_status, duration_api_ms, duration_ms, fast_mode_disabled_reason, fast_mode_state, first_content_frame_ms, is_error, modelUsage, num_turns, permission_denials, queued_turn_count, result, result_index, session_id, stop_reason, subagent_stats, subtype, terminal_reason, time_to_request_ms, total_cost_usd, ttft_ms, ttft_stream_ms, type, usage, uuid`.
