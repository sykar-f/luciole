# T3 Code — how it integrates Claude Code, Codex and other harnesses

Source: `github.com/pingdotgg/t3code`, shallow clone at `95030dc` (2026-09-26), version 0.0.42.
Clone: `/private/tmp/claude-501/research/t3code`. All paths below are relative to that root.

---

## TL;DR

- **Claude** is driven through the **official `@anthropic-ai/claude-agent-sdk` (`query()`)** in *streaming-input* mode (one long-lived `query()` per thread, fed by an `AsyncIterable<SDKUserMessage>`). The SDK is pointed at the **user's own installed `claude` binary** (`pathToClaudeCodeExecutable`, default `"claude"`). T3 excludes the SDK's bundled platform binaries in `pnpm-workspace.yaml`, so it always runs the CLI the user installed. Auth is whatever that CLI has: the user runs `claude auth login`, and T3 never runs a login flow for Claude. Metadata text generation (titles, commit messages, PR bodies) uses `claude -p --output-format json --json-schema …`.
- **Codex** is driven through **`codex app-server`** (JSON-RPC over stdio, v2 protocol, `experimentalApi: true`). T3 generated a typed Effect client from OpenAI's published JSON schemas (`packages/effect-codex-app-server`). Text generation uses `codex exec --ephemeral --output-schema`.
- **Others:** Cursor (`cursor-agent acp`) and Grok (`grok agent stdio`) use **ACP** through their own `packages/effect-acp`. OpenCode uses `opencode serve` plus its SDK. Antigravity uses a native protocol that T3 installs.
- **Compliance:** the code has **no explicit "Anthropic-approved" statement**. The posture is implicit: use the official Agent SDK, the user's own install and the user's own login ("bring your own subscription"). **Key policy fact (issue #2680):** Anthropic's email says that from **June 15 2026**, Agent SDK and `claude -p` usage, *including third-party apps built on the Agent SDK*, **runs on a separate monthly Agent SDK credit** (for example $100 on Max 5x) and then on "extra usage". It does **not** draw on the interactive subscription limits, which "stay reserved for interactive usage of Claude Code, Claude Cowork, and chat". T3 kept the SDK approach anyway. Community forks switched to driving the interactive TUI through a PTY (issues #2680 and #2958), but maintainers did not merge those.
- **Caveat in T3 itself:** `claudeResetCredits.ts` **does read the OAuth access token** from `<CLAUDE_CONFIG_DIR>/.credentials.json` (non-macOS only) and calls `api.anthropic.com/api/oauth/usage` with a spoofed `user-agent: claude-cli/<ver> (external, cli)`. It uses this to show and redeem "banked resets". This is the one place where T3 touches Claude credentials directly. Do **not** copy it if you want a clean compliance story.

---

## 1. Overall architecture

| Piece | Tech |
|---|---|
| `apps/server` (npm package `t3`, bin `t3`) | **Node ≥22** server, written entirely in **Effect** (effect v4-style `Effect.fn`, `Layer`, `Context.Service`, `effect/unstable/rpc`, `effect/unstable/process`). SQLite persistence (`state.sqlite`), event-sourced orchestration. |
| `apps/web` | React 19 + Vite + TanStack Router + zustand; `@pierre/diffs` for diffs; xterm for terminals |
| `apps/desktop` | **Electron 44**; bundles and spawns the server; the renderer is the same web app talking to the local server over the same WS boundary |
| `apps/mobile` | Expo / React Native; connects to any T3 server remotely |
| `packages/contracts` | Effect `Schema` types for everything on the wire (RPC, orchestration commands/events, provider runtime events) |
| `packages/client-runtime` | shared connection/domain state for web and mobile |
| `packages/effect-codex-app-server` | generated typed client for `codex app-server` |
| `packages/effect-acp` | ACP JSON-RPC client (Cursor, Grok, Antigravity) |
| `packages/ssh`, `packages/tailscale`, relay ("T3 Connect") | remote access |

From `CLAUDE.md`/`AGENTS.md`: *"A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients."*

**UI ↔ backend:** Effect RPC over **WebSocket** with JSON serialization (`apps/server/src/ws.ts`: `RpcServer` + `RpcSerialization.layerJson`). The schema lives in `packages/contracts/src/rpc.ts`, which defines about 144 RPCs. The core ones are:

- `orchestration.dispatchCommand` (payload `ClientOrchestrationCommand`)
- `orchestration.subscribeThread` / `subscribeShell` (streams)
- `orchestration.getTurnDiff` / `getFullThreadDiff`
- `terminal.open|attach|write|resize|…` plus `subscribeTerminalEvents`
- `server.refreshProviders`, `providerAuth*`, `providerInstall*`, settings, PRs, and so on

Client commands (`packages/contracts/src/orchestration.ts`):

```
thread.create, thread.turn.start, thread.turn.interrupt, thread.approval.respond,
thread.user-input.respond, thread.user-input.dismiss, thread.checkpoint.revert,
thread.conversation.revert, thread.session.stop, thread.runtime-mode.set,
thread.interaction-mode.set, thread.archive/pin/snooze/settle..., project.create...
```

The server is event-sourced (`docs/internals/overview.md`): a decider turns commands into events inside one DB transaction, and then "reactors" do the side effects, such as calling `ProviderService` or taking checkpoints. Provider runtime events are projected into thread activities and messages, and clients subscribe to per-thread streams.

---

## 2. Claude integration (the key part)

Files:
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (5.6k lines)
- `apps/server/src/provider/Layers/ClaudeProvider.ts` (status probe)
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`, `ClaudeExecutable.ts`, `ClaudeHome.ts`, `ClaudeSkills.ts`, `ClaudeSkillDispatch.ts`
- `apps/server/src/textGeneration/ClaudeTextGeneration.ts`
- `apps/server/src/provider/Layers/claudeUsageLimits.ts`, `claudeResetCredits.ts`

### 2.1 Mechanism: Agent SDK `query()` in streaming-input mode

```ts
// ClaudeAdapter.ts header
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
import { type CanUseTool, query, getSessionMessages, forkSession, ... } from "@anthropic-ai/claude-agent-sdk";
```

`apps/server/package.json`: `"@anthropic-ai/claude-agent-sdk": "^0.3.276"`. `pnpm-workspace.yaml` maps every `@anthropic-ai/claude-agent-sdk-<platform>` optional binary to `"-"`, so none are installed. The SDK therefore always launches the user's `claude`.

Each thread gets **one `query()`**. Its prompt is an `AsyncIterable` built from an Effect `Queue` (`promptQueue`). `sendTurn` pushes a new `SDKUserMessage` onto the queue. A `sendTurn` issued while a turn is running is treated as a **steer**: the message is injected into the live agent loop and no new turn boundary is created.

### 2.2 Exact `query()` options (ClaudeAdapter.ts ~L4900)

```ts
const queryOptions: ClaudeQueryOptions = {
  ...(input.cwd ? { cwd: input.cwd } : {}),
  ...(apiModelId ? { model: apiModelId } : {}),
  pathToClaudeCodeExecutable: claudeBinaryPath,          // user's `claude` (Windows shims resolved to claude.exe / cli.js)
  systemPrompt: { type: "preset", preset: "claude_code",
                  append: buildRuntimeInstructions({ harness: "Claude Code" }) },
  settingSources: ["user", "project", "local"],          // CLAUDE_SETTING_SOURCES
  ...(effectiveEffort ? { effort } : {}),
  ...(thinking-display === "summarized" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  ...(permissionMode ? { permissionMode } : {}),
  ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
  ...(settings non-empty ? { settings } : {}),           // {alwaysThinkingEnabled, showThinkingSummaries, fastMode, ultracode, autoCompactWindow}
  ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
  ...(newSessionId ? { sessionId: newSessionId } : {}),  // T3 pre-assigns the Claude session UUID
  includePartialMessages: true,
  canUseTool,
  onUserDialog, supportedDialogKinds: ["resume_return"], // "resume old session: compact?" dialog -> AskUserQuestion UI
  env: McpProviderSession.withAgentDeviceEnvironment(claudeEnvironment, mcpSession),
  additionalDirectories: [cwd, serverConfig.attachmentsDir],
  ...(extraArgs non-empty ? { extraArgs } : {}),        // user "Launch arguments" parsed into CLI flags
  ...(mcpSession ? { mcpServers: { "t3-code": { type: "http", url, headers: { Authorization } } } } : {}),
};
```

`buildRuntimeInstructions` appends a short `<runtime_info>` block ("you are running in T3 Code through the Claude Code harness…") and `<pull_request_linking>` instructions that tell the agent to use T3's own MCP tools (`link_pull_request`).

**Environment / multi-account (`Drivers/ClaudeHome.ts`):** only `CLAUDE_CONFIG_DIR` is overridden, never `HOME`. The code explains why:

> Overriding HOME also relocates the macOS login keychain lookup … so the spawned CLI can't find its stored OAuth credentials and reports "Not logged in".

### 2.3 Auth

- There is no in-app Claude login. The Claude driver has no `auth` controller; only Antigravity and Grok do. The README says: *"Claude: install Claude Code and run `claude auth login`"*.
- The signed-out message (`ClaudeHome.ts`) reads: *"For subscription login, run `claude auth login` on this environment's machine … For API-key authentication, check this instance's configured credentials."*
- API keys, OpenRouter and other routers are supported through per-instance environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`), as documented in `docs/user/providers-claude.md`.
- **Exception:** `Layers/claudeResetCredits.ts` reads `claudeAiOauth.accessToken` from `.credentials.json` (skipped on macOS because there the token is in the Keychain). It then calls `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1` and a claim endpoint with `anthropic-beta: oauth-2025-04-20` and `user-agent: claude-cli/${version} (external, cli)`. This impersonates the CLI and is the least compliance-friendly code in the repo.

### 2.4 Detection / health (`Layers/ClaudeProvider.ts`)

1. Runs `claude --version` (through `resolveSpawnCommand`) with a timeout. If the command is missing or fails, the provider is reported as `installed:false` or an error.
2. **SDK capability probe:** `query()` with a prompt iterable that **never yields**, so no API request is ever made. It awaits `q.initializationResult()`, which returns `account {email, subscriptionType, tokenSource, apiProvider}` and `commands` (slash commands). The code comment says:
   > "We pass a never-yielding AsyncIterable as the prompt so that no user message is ever written to the subprocess stdin … completes its local initialization IPC … but never starts an API request to Anthropic."

   Probe options: `persistSession:false`, `settings:{disableAllHooks:true}`, `allowedTools:[]`, `mcpServers:{}`, `strictMcpConfig:true`, env `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_AUTO_CONNECT_IDE=0`, and a 25s timeout (Bedrock is slow).
3. Also calls `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` to get subscription rate-limit windows for the Usage page.
4. Result: `auth.status = "authenticated"` with a label such as "Claude Max 20x Subscription" or "Amazon Bedrock". If the probe fails, the result is `status:"warning"` with "Could not verify Claude authentication status".
5. Refreshes every 5 minutes (`DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`), and also on demand through `server.refreshProviders`.

### 2.5 Feature mapping

| Feature | How |
|---|---|
| **Permission modes** | T3 `RuntimeMode` → SDK `permissionMode`: `approval-required`→(unset = CLI default), `auto-accept-edits`→`acceptEdits`, `auto`→`auto`, `full-access`→`bypassPermissions` (+`allowDangerouslySkipPermissions`). A `--permission-mode` / `--dangerously-skip-permissions` launch arg overrides the mapping. |
| **Approvals** | `canUseTool` callback. In `full-access` it returns allow immediately. Otherwise it emits `request.opened` {requestType, detail, args{toolName,input,toolUseId}}, parks on a `Deferred`, and when the user answers (`respondToRequest`) emits `request.resolved`. `accept` returns `allow`; `acceptForSession` returns `allow` plus `updatedPermissions` built from the SDK `suggestions`; `decline`/`cancel` return `deny` with a message. The abort signal cancels a pending request. |
| **AskUserQuestion** | Also intercepted in `canUseTool`: emits `user-input.requested` {questions[] with header/options/multiSelect}. The answers go back as `allow` with `updatedInput:{questions, answers}`, keyed by the question text (SDK ≥2.1.121 requirement, issue #2388). |
| **Plan mode** | `interactionMode:"plan"` → `query.setPermissionMode("plan")`; `"default"` restores the base mode. `ExitPlanMode` is caught in `canUseTool`: T3 emits `turn.proposed.completed` {planMarkdown} and **denies** the tool with "The client captured your proposed plan. Stop here…". The UI then offers to implement the plan in a new turn. |
| **Model switch** | `query.setModel(apiModelId)` in the next `sendTurn`, so the switch happens within the session (`capabilities.sessionModelSwitch:"in-session"`). Effort is set at the session level via `effort`; for some models it is injected into the prompt as a prefix (`applyClaudePromptEffortPrefix`). |
| **Interrupt** | **Hard stop:** `interruptTurn` → `stopSessionInternal` → `query.close()` (SDK closes stdin, then SIGTERM, then SIGKILL). The code comment says `interrupt()` can acknowledge while background tasks keep the CLI alive. Pending approvals are cancelled and the turn is completed as `interrupted`. The next message restarts the session with `resume`. |
| **Resume** | `resumeCursor = {threadId, resume: sessionId, resumeSessionAt: lastAssistantUuid, turnCount, turnStartMessageIds}` is persisted. On restart T3 passes `resume`. T3 also pre-assigns `sessionId` for new sessions and uses its own turn UUID as the `SDKUserMessage.uuid`, so turn boundaries can be found in the transcript. |
| **Rollback / "Edit from here"** | `getSessionMessages()` locates turn boundaries; `forkSession(sessionId, {upToMessageId})` creates a truncated copy; T3 then restarts the query with `resume: fork.sessionId`. When a custom `CLAUDE_CONFIG_DIR` is in use, this runs in a child process (`claude-history-worker.ts`) so the server's env isn't mutated. |
| **Images** | Base64 `image` content blocks in the `SDKUserMessage` (png/jpeg/gif/webp). Other files are passed as a path line in the prompt; the attachments dir is added to `additionalDirectories` so no permission prompt appears. |
| **Slash commands / skills** | The command list comes from the init probe (`init.commands`) plus a synthetic `/compact`. Skills are discovered by scanning `<config>/skills` and `.claude/skills`. A `$skill` chip is rewritten so that `/name …` starts the **last** text block, because the CLI expands a skill only in that position (`ClaudeSkillDispatch.ts`). Compaction is sent as a `/compact` turn. |
| **MCP** | User MCP servers come from the settingSources. T3 injects its own HTTP MCP server `t3-code` (per thread, bearer auth) for PR linking and device/browser tools. |
| **Streaming** | `includePartialMessages:true`; `stream_event` deltas become `content.delta` (`assistant_text` / `reasoning_summary_text`). `assistant`/`user` messages become `item.started/updated/completed` (tool lifecycle); `system` subtypes (init, compact_boundary, hook_*, task_* for subagents, api_retry, notification, …) become the matching canonical events; `rate_limit_event` becomes `account.rate-limits.updated`; `auth_status` becomes `auth.status`; `result` becomes `turn.completed` plus `thread.token-usage.updated`. |
| **Token usage** | From `result.usage` / `modelUsage` → `ThreadTokenUsageSnapshot {usedTokens, maxTokens(context window), input/cached/output/reasoning, autoCompactThreshold…}` for the context meter. |
| **Diffs** | Claude emits no diff; T3 computes diffs from git checkpoints (§6). |
| **Text generation** | `claude -p --output-format json --json-schema <schema> --model … --settings {"disableAllHooks":true,…} --tools "" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk`, with the prompt on stdin. |

---

## 3. Codex integration

Files:
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`, `CodexAdapter.ts`, `CodexProvider.ts`, `codexLaunchArgs.ts`
- `packages/effect-codex-app-server`: generated from `openai/codex` `codex-rs/app-server-protocol/schema/json` at a pinned upstream ref

**Transport:** spawns **`codex app-server [launchArgs]`** per session with `CODEX_HOME` set if configured, and speaks JSON-RPC over stdio. Handshake:

```ts
client.request("initialize", { clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop", version },
                               capabilities: { experimentalApi: true } });
client.notify("initialized", undefined);
```

**Thread / turn lifecycle:**
- `thread/start` {cwd, approvalPolicy, sandbox, approvalsReviewer, model, serviceTier}, or `thread/resume` {threadId} (falls back to start if the thread is missing)
- `turn/start` {threadId, input:[{type:"text"},{type:"localImage",path}], approvalPolicy, approvalsReviewer, sandboxPolicy, model, effort, collaborationMode:{mode:"plan"|"default", settings:{model, reasoning_effort, developer_instructions}}, additionalContext}
- `turn/interrupt` {threadId, turnId}; child collab-agent turns are interrupted first
- `thread/read`, `thread/turns/list`; rollback uses `thread/revert` {threadId, beforeTurnId}; compaction uses `thread/compact/start`
- Notifications consumed: `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`, `thread/compacted`, `turn/started`, `turn/completed`, `turn/plan/updated`, `turn/diff/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/textDelta|summaryTextDelta|summaryPartAdded`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta|patchUpdated`, `item/plan/delta`, `item/mcpToolCall/progress`, `serverRequest/resolved`, `model/rerouted`, `collabAgent/statusChanged`, `error`, and more

**Permission mapping (`runtimeModeToThreadConfig`):**

| T3 mode | approvalPolicy | sandbox | approvalsReviewer |
|---|---|---|---|
| approval-required | `untrusted` | `read-only` | user |
| auto-accept-edits | `on-request` | `workspace-write` | user |
| auto | `on-request` | `workspace-write` | `auto_review` |
| full-access | `never` | `danger-full-access` | user |

**Approvals (server→client requests):** `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/requestUserInput`. Each one parks a `Deferred` and responds with `{decision: accept|acceptForSession|decline|cancel}` (`acceptAlways` is folded into `acceptForSession`). Codex **async questions** arrive as notifications and are answered by sending a new user message.

**Auth detection (`CodexProvider.ts`):** spawns a short-lived `app-server`, runs `initialize` (the version is parsed from `initialize.userAgent`), then calls `account/read`, `model/list`, `skills/list` and `account/rateLimits/read`. If there is no account, it reports "Codex CLI is not authenticated. Run `codex login`". Multi-account support uses a "shadow home" approach.

**Text generation:** `codex exec --ephemeral … --output-schema`.

---

## 4. Provider abstraction / normalized event model

**Adapter contract** (`apps/server/src/provider/Services/ProviderAdapter.ts`):

```ts
export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderDriverKind;
  readonly capabilities: { sessionModelSwitch: "in-session"|"unsupported";
                           promptlessTurnContinuation?: boolean; supportsConversationRollback?: boolean };
  readonly startSession: (input: ProviderSessionStartInput) => Effect<ProviderSession, TError>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Effect<ProviderTurnStartResult, TError>;
  readonly compaction?: { type: "native"; start(...) } | { type: "slash-command"; command: `/${string}` };
  readonly interruptTurn: (threadId, turnId?) => Effect<void, TError>;
  readonly respondToRequest: (threadId, requestId, decision: ProviderApprovalDecision) => Effect<void, TError>;
  readonly respondToUserInput: (threadId, requestId, answers) => Effect<void, TError>;
  readonly stopSession, listSessions, hasSession, readThread, rollbackThread(threadId, numTurns), uploadFeedback?, stopAll;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
```

**Driver / instance** (`apps/server/src/provider/ProviderDriver.ts`): a `ProviderDriver<Config>` has `{driverKind, metadata, configSchema, defaultConfig, create(input) → ProviderInstance}`. A `ProviderInstance` bundles `{instanceId, driverKind, continuationIdentity, snapshot (ServerProvider status stream), adapter, textGeneration, auth?, refreshModels?, consumeResetCredit?}`. Several instances of one driver are allowed (for example two Claude accounts), and work is routed by `instanceId`. `builtInDrivers.ts` lists Claude, Codex, Cursor, Grok, OpenCode and Antigravity.

**Inputs** (`packages/contracts/src/provider.ts`):

```ts
ProviderSessionStartInput { threadId, providerInstanceId?, cwd?, modelSelection?, resumeCursor?: unknown,
                            approvalPolicy?, sandboxMode?, runtimeMode }
ProviderSendTurnInput     { threadId, input?, attachments?, modelSelection?, interactionMode?: "default"|"plan", continuation? }
ProviderSession.status:   "connecting" | "ready" | "running" | "error" | "closed"
RuntimeMode:              "approval-required" | "auto-accept-edits" | "auto" | "full-access"   (default full-access)
ProviderApprovalDecision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
```

**Canonical runtime events** (`packages/contracts/src/providerRuntime.ts`). Every event has the base `{eventId, provider, providerInstanceId?, threadId, createdAt, turnId?, itemId?, requestId?, providerRefs?, raw?{source, method, payload}}`. The event types are:

```
session.started | session.configured | session.state.changed | session.exited
thread.started | thread.state.changed | thread.metadata.updated | thread.token-usage.updated
thread.realtime.{started,item-added,audio.delta,error,closed}
turn.started | turn.completed | turn.aborted | turn.plan.updated
turn.proposed.delta | turn.proposed.completed | turn.diff.updated
item.started | item.updated | item.completed | content.delta
request.opened | request.resolved | user-input.requested | user-input.resolved
task.started | task.progress | task.updated | task.completed          (subagents)
hook.started | hook.progress | hook.completed | tool.progress | tool.summary
auth.status | account.updated | account.rate-limits.updated | mcp.status.updated | mcp.oauth.completed
model.rerouted | config.warning | deprecation.notice | files.persisted | tool.denied
runtime.warning | runtime.error
```

Enums:
- `RuntimeSessionState`: starting | ready | running | waiting | stopped | error
- `RuntimeTurnState`: completed | failed | interrupted | cancelled
- `CanonicalItemType`: user_message | assistant_message | reasoning | plan | command_execution | file_change | mcp_tool_call | dynamic_tool_call | collab_agent_tool_call | web_search | image_view | review_entered | review_exited | context_compaction | error | unknown
- `CanonicalRequestType`: command_execution_approval | file_read_approval | file_change_approval | apply_patch_approval | exec_command_approval | mcp_elicitation_approval | permission_approval | tool_user_input | dynamic_tool_call | auth_tokens_refresh | unknown
- `RuntimeContentStreamKind`: assistant_text | reasoning_text | reasoning_summary_text | plan_text | command_output | file_change_output | unknown

The vocabulary is clearly modeled on the Codex app-server (items, turns, and so on). The Claude adapter translates SDK messages into it.

`ProviderService` (`Layers/ProviderService.ts`) routes by instance, writes attachment paths into the prompt, persists resume cursors (`ProviderSessionDirectory`), and reaps idle sessions (`ProviderSessionReaper`).

---

## 5. Provider detection / availability

- `ServerProvider` snapshot (`packages/contracts/src/server.ts`): `{instanceId, driver, enabled, installed, version, status: "ready"|"warning"|"error"|"disabled", auth:{status:"authenticated"|"unauthenticated"|"unknown", type?, label?, email?}, message?, availability?, models[], slashCommands[], skills[], usageLimits?, versionAdvisory?, compatibilityAdvisory?, updateState?, setup?{canAuthenticate, canInstall}, supportsConversationRollback?, showInteractionModeToggle?, ...}`.
- `makeManagedServerProvider.ts` runs each driver's probe and refreshes it every 5 minutes by default and on demand. Probes are designed to avoid side effects: the internals doc says "Setup must not happen as a health-check side effect". Examples are the Claude probe with hooks and MCP disabled and no prompt, and the Codex probe that only runs `initialize` + `account/read`.
- Binary lookup: a configurable `binaryPath` (defaults `claude`, `codex`, `cursor-agent`, …) resolved through `resolveSpawnCommand` (PATH/PATHEXT, Windows shim handling). `--version` or the initialize user-agent gives the version. `providerCompatibility.ts` flags known-incompatible versions. `providerMaintenance.ts` offers a one-click update only when it can prove the installer (brew/npm/native).
- UI: `ModelPickerContent.tsx` / `ChatView.logic.ts` / `ProviderStatusBanner.tsx` check `enabled`, `installed`, `status`, `auth.status` and `isProviderAvailable` (`availability !== "unavailable"`). Unusable providers are greyed out or show a setup CTA ("install", "run `claude auth login`"). A Welcome Wizard walks through setup.

---

## 6. Notable UX features

- **Threads per project**, running concurrently. Threads can be pinned, snoozed, "settled", archived or searched; mobile remote control; background threads.
- **Checkpoints:** hidden git refs `refs/t3/checkpoints/…`, captured per turn with a temporary index so no commits land on the user's branch. Turn diffs and full-thread diffs are computed between checkpoints; for Claude this is how diffs are produced.
- **Revert / "Edit from here":** rewinds the provider conversation (Claude uses `forkSession`, Codex uses `thread/revert`). "Revert files too" is offered only in a worktree thread. A provider that can't roll back rejects the revert before touching files.
- **Worktrees:** threads can run in git worktrees and have a setup script (`t3.json`).
- **Integrated terminal:** node-pty, multiple terminals, persisted history.
- **Composer:** queue vs steer follow-ups, `$skill` chips, `/` commands, attachments (images plus files by path), prompt stash, voice input, model and effort picker, plan-mode toggle, permission-mode selector per thread.
- **Plan sidebar:** plans from `turn.plan.updated` (TodoWrite/Task tools); proposed plans come from `ExitPlanMode`.
- **Subagent / task panel:** Claude `task_*` system messages; Codex collab agents.
- **Usage & limits dashboard:** per-account subscription windows and API-equivalent cost estimates computed from local history files.
- **Other:** PR review and management UI (GitHub/GitLab/…), link PRs to threads through T3's MCP, AI-generated titles, commit messages and PR bodies, import of existing Claude/Codex sessions (`agentSessions`), remote access (Tailscale, relay, SSH), device and browser preview tools exposed to agents over MCP.

---

## 7. Anthropic compliance: what's actually stated

- **No explicit statement in the repo** (README, docs, code) that Anthropic approved the integration. The positioning is *"Works with your subscriptions on Claude Code, Codex, … If they're set up on your computer, T3 Code can control them"* and *"bring-your-own-subscription alternative to apps like Claude Desktop, Codex App…"* (`AGENTS.md`).
- The implicit compliance posture:
  1. Uses only the **official Agent SDK** and the official `claude` CLI (`-p` for helpers).
  2. Runs the **user's own installed binary** (the SDK's bundled binaries are excluded).
  3. Uses the **user's own login**, set up with `claude auth login`. T3 never runs an OAuth flow for Claude, and it isolates accounts with `CLAUDE_CONFIG_DIR` rather than copying credentials.
  4. Keeps Claude's system prompt preset (`claude_code`) and only appends to it.
  5. The server runs on the user's machine ("environment"); remote clients control it but never carry credentials.
- **Policy change (issue #2680, screenshot of Anthropic's email, May 2026):**
  > "Starting June 15, Max 5x plan subscribers can claim a $100 monthly credit for using the Claude Agent SDK and `claude -p`, including third-party tools built on the Agent SDK. As part of this change, Agent SDK and other programmatic usage will run on this credit, and will not impact your subscription limits. This includes third-party applications built on the Agent SDK. If you use your full Agent SDK credit in a given month, continued use will draw from extra usage… Your subscription usage limits don't change. They stay reserved for interactive usage of Claude Code, Claude Cowork, and chat."

  Maintainer `juliusmarminge` closed the issue on 2026-06-20: "The subscription-policy question was answered in the thread", with a pointer to a Theo video (a community comment summarizes it as "additional $100 credit for the SDK… if you only use SDK you just got nerfed"). A community fork added a `ClaudePtyAdapter` that drives the interactive TUI in a PTY and reads the `~/.claude/projects/*.jsonl` transcripts. Issue #2958 proposed `@ybouane/dash-p`, which wraps the TUI. **Neither was adopted upstream.** T3 still uses the Agent SDK.
- **Implication for your design:** a GUI built T3-style (Agent SDK + user's `claude` + user's login) is the sanctioned path for third-party apps. After June 15 2026, though, it bills against the **Agent SDK credit / extra usage, not the interactive Claude Code subscription limits**. Driving the interactive TUI through a PTY to get "interactive" limits is exactly the workaround the community built. It is brittle, and maintainers avoided it because of legal and policy risk. Treat it as non-compliant.
- **Watch-outs inside T3:**
  - `claudeResetCredits.ts` reads the OAuth token directly and spoofs the `claude-cli` user-agent against `/api/oauth/usage`.
  - Open issue #10020: "Keep the Claude t3-code MCP bearer out of process arguments".
  - `usage/cliproxyApi.ts` integrates CLIProxyAPI hubs, a third-party account-pooling proxy.

  Avoid these in a compliance-sensitive design.

---

## 8. Takeaways for a Claude / Codex / pi GUI

1. **Adapter interface:** copy T3's `ProviderAdapterShape` + `ProviderRuntimeEvent` vocabulary almost verbatim. It already covers approvals, user-input questions, plans, subagent tasks, token usage and rollback, across very different harnesses.
2. **Claude:** use `query()` streaming-input with one query per thread, plus these options:
   - `pathToClaudeCodeExecutable` pointed at the user's binary
   - `settingSources:["user","project","local"]` and the `claude_code` preset + append
   - `includePartialMessages`
   - `canUseTool` for approvals, AskUserQuestion and ExitPlanMode capture
   - `setPermissionMode("plan")` for plan mode and `setModel` for model switches
   - `resume` + pre-assigned `sessionId`
   - `forkSession` for rewind

   Detect auth with `claude --version` plus a no-prompt `initializationResult()` probe. Never read tokens.
3. **Codex:** use `codex app-server` JSON-RPC (`initialize` with `experimentalApi`, then `thread/start|resume`, `turn/start|interrupt`, `thread/revert`, and the approval server-requests), and generate types from OpenAI's published schema. Detect auth with `account/read`.
4. **pi:** not supported by T3. It would slot in as another driver next to the ACP drivers (Cursor, Grok), using `packages/effect-acp` or a pi RPC mode, and map into the same event vocabulary.
