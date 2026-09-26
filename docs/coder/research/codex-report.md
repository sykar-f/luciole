# OpenAI Codex CLI as an embeddable harness — capability inventory

Researched 2026-09-26 against local `codex-cli 0.156.1` (macOS, logged in with ChatGPT, plan `prolite`).

## Sources

**Local, generated from the installed binary (these are authoritative for 0.156.1):**

- `/private/tmp/claude-501/research/codex-schema/`: `codex app-server generate-json-schema --out …` (39 files, v1/ + v2/, `ClientRequest.json`, `ServerNotification.json`, `ServerRequest.json`, and so on)
- `/private/tmp/claude-501/research/codex-ts/`: `codex app-server generate-ts --out …` (stable surface, 631 v2 types)
- `/private/tmp/claude-501/research/codex-ts-exp/`: `generate-ts --experimental` (766 v2 types, includes experimental fields)
- `/private/tmp/claude-501/research/ClientRequest.methods.txt` and `ServerNotification.methods.txt`: full method lists
- `/private/tmp/claude-501/research/probe.jsonl`: a live read-only handshake transcript (initialize, account/read, model/list, thread/list, account/rateLimits/read, permissionProfile/list). It used no tokens and started no turn. **It contains the account email in `account/read`, so don't share it.**

**Official docs.** developers.openai.com/codex/* now 308-redirects to learn.chatgpt.com/docs/*, and each page has a `.md` twin. Local copies are `doc-*.md` in the same directory.

- App Server: https://learn.chatgpt.com/docs/app-server.md (`doc-app-server.md`, about 2,400 lines)
- Codex SDK: https://learn.chatgpt.com/docs/codex-sdk.md
- Non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode.md
- Authentication: https://learn.chatgpt.com/docs/auth.md
- Agent approvals & security: https://learn.chatgpt.com/docs/agent-approvals-security.md
- Sandbox: https://learn.chatgpt.com/docs/sandboxing.md, Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review.md, Permissions: https://learn.chatgpt.com/docs/permissions.md
- Developer commands and slash commands: https://learn.chatgpt.com/docs/developer-commands.md?surface=cli
- MCP: https://learn.chatgpt.com/docs/extend/mcp.md. Config reference: https://learn.chatgpt.com/docs/config-file/config-reference.md
- Removal of the MCP server: https://learn.chatgpt.com/docs/mcp-server.md
- Doc index: https://learn.chatgpt.com/llms.txt

**GitHub:**

- https://github.com/openai/codex/tree/main/codex-rs/app-server. The README at `raw…/codex-rs/app-server/README.md` is now only a changelog-style list of recent additions (user verification, gateway OAuth, attachments, and so on). The full protocol docs live on learn.chatgpt.com.
- https://github.com/openai/codex/tree/main/sdk/typescript (`src/exec.ts`, `src/items.ts`, `src/events.ts`) and https://github.com/openai/codex/tree/main/sdk/python
- Policy discussion: https://github.com/openai/codex/discussions/8338

---

## 1. Integration options

| Option                                                 | Transport                                                                                                                                                                                                           | Approvals                                                                                                      | History/listing                                                          | Auth UI                                                                        | Intended use                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`codex app-server`**                                 | JSON-RPC 2.0 (without the `"jsonrpc"` field) over stdio JSONL by default. Also `--listen ws://IP:PORT` (experimental), `unix://[PATH]` (WebSocket over a Unix socket), or `off`                                     | Full, bidirectional: the server sends requests and the client answers them                                     | thread/list, read, resume, fork, archive, delete, turns/items pagination | account/read, login/start (browser, device code, API key), logout, rate limits | **Rich clients.** "Codex app-server is the interface Codex uses to power rich clients (for example, the Codex VS Code extension). Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." (app-server.md) |
| `codex exec --json` (`--experimental-json` in the SDK) | One-shot process, JSONL events on stdout                                                                                                                                                                            | None. It is non-interactive: `-a` is not accepted and there is only `--approve-for-me` (auto-review) or bypass | `codex exec resume <id>` / `--last` only                                 | None (uses stored auth, or `CODEX_API_KEY`)                                    | Scripts and CI                                                                                                                                                                                                                                                                                  |
| `@openai/codex-sdk` (TS)                               | Wraps `codex exec --experimental-json` (see `sdk/typescript/src/exec.ts`, which builds `["exec","--experimental-json", --model, --sandbox, --cd, --add-dir, --output-schema, --image, --config approval_policy=…]`) | None interactive                                                                                               | `resumeThread(id)`                                                       | None                                                                           | "Use the SDK to automate coding tasks, including jobs in CI. Use the Codex app server to build custom clients…" (codex-sdk.md)                                                                                                                                                                  |
| Python SDK `openai-codex`                              | Drives **app-server** over JSON-RPC and ships a pinned CLI runtime                                                                                                                                                  | Via app-server                                                                                                 | Via app-server                                                           | Via app-server                                                                 | Automation (a useful reference implementation of an app-server client)                                                                                                                                                                                                                          |
| `codex mcp-server`                                     | **Removed.** "Use the Codex app server for existing integrations."                                                                                                                                                  | n/a                                                                                                            | n/a                                                                      | n/a                                                                            | n/a                                                                                                                                                                                                                                                                                             |

**Recommendation:** use `codex app-server` over stdio for a GUI. It is the only option with interactive approvals, streaming deltas, auth and login flows, model discovery, session listing, and rate-limit display.

Things to watch:

- The CLI help still labels the command "[experimental]". The docs say the WebSocket transport is "experimental and unsupported", while stdio is the documented path.
- The protocol is versioned by binary. Generate the schema from whatever `codex` binary the user has installed (`generate-ts` / `generate-json-schema`), or pin a version.
- A shared daemon also exists: `codex app-server daemon`, and `codex app-server proxy` pipes stdio to the running daemon's control socket. The TUI uses it unless given `--no-daemon`. Spawning your own `codex app-server` child keeps things isolated.

The v2 `exec --json` event and item types are useful for comparison. Events: `thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.started|updated|completed`, `error`. Items: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`.

---

## 2. app-server protocol

### 2.1 Framing and handshake

Wire format (from app-server.md "Protocol" and "Message schema"):

```json
{ "method": "thread/start", "id": 10, "params": { "model": "gpt-6-sol" } }
{ "id": 10, "result": { "thread": { "id": "thr_123" } } }
{ "id": 10, "error": { "code": 123, "message": "Something went wrong" } }
{ "method": "turn/started", "params": { "turn": { "id": "turn_456" } } }   // notification: no id
```

Handshake: send the `initialize` request once per connection, then the `initialized` notification. Any other request sent before this gets `Not initialized`, and a second `initialize` gets `Already initialized`.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"my_client","title":"My Client","version":"0.1.0"},
  "capabilities":{"experimentalApi":false,"optOutNotificationMethods":["item/reasoning/textDelta"]}}}
{"method":"initialized"}
```

Real response (probe):

```json
{
  "id": 1,
  "result": {
    "userAgent": "research_probe/0.156.1 (Mac OS 26.6.2; arm64) ghostty/1.3.1 (research_probe; 0.0.1)",
    "codexHome": "/Users/sykar-f/.codex",
    "platformFamily": "unix",
    "platformOs": "macos"
  }
}
```

`InitializeCapabilities` fields:

- `experimentalApi`: this gates experimental methods and fields. Without it the server rejects them with `<descriptor> requires experimentalApi capability`.
- `optOutNotificationMethods`: exact method names only.
- `requestAttestation`, `mcpServerOpenaiFormElicitation`, and `extensions`.

`clientInfo.name` is recorded for OpenAI's Compliance Logs. The docs say: "If you are developing a new Codex integration intended for enterprise use, please contact OpenAI to get it added to a known clients list."

Unsolicited notifications arrive right after init, for example `remoteControl/status/changed` and `account/updated {authMode:"chatgpt", planType:"prolite"}`. Every notification carries `emittedAtMs`.

### 2.2 Client → server methods (0.156.1, stable plus experimental)

The full list is in `ClientRequest.methods.txt`. Grouped:

- **Threads:**
  - `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/loaded/list`
  - `thread/turns/list`, `thread/items/list` (experimental pagination)
  - `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`
  - `thread/name/set`, `thread/metadata/update` (gitInfo, isPinned), `thread/goal/{set,get,clear}`, `thread/attachment/{add,list,remove}`
  - `thread/compact/start`, `thread/shellCommand` (a user `!cmd`; runs **unsandboxed**), `thread/revert` (history only, files are left alone), `thread/inject_items`, `thread/approveGuardianDeniedAction`
  - `threadSection/*` (folders)
- **Turns:** `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`
- **Models and config:**
  - `model/list`, `modelProvider/capabilities/read`, `experimentalFeature/list`, `experimentalFeature/enablement/set`, `permissionProfile/list`, `collaborationMode/list` (experimental)
  - `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`
  - `externalAgentConfig/{detect,import}` (imports Claude Code or Cursor setups, including sessions)
- **Skills, plugins, apps:**
  - `skills/list`, `skills/config/write`, `skills/extraRoots/set`, `hooks/list`
  - `plugin/*` and `marketplace/*` (marked "don't call from production clients yet")
  - `app/{list,read,installed}`
- **MCP:** `mcpServerStatus/list`, `mcpServer/oauth/login`, `mcpServer/resource/read`, `mcpServer/tool/call`, `config/mcpServer/reload`
- **Account:**
  - `account/read`, `account/login/start`, `account/login/cancel`, `account/logout`
  - `account/rateLimits/read`, `account/usage/read`, `account/rateLimitResetCredit/consume`, `account/workspaceMessages/read`, `account/sendAddCreditsNudgeEmail`
- **Utilities:**
  - `command/exec` (+ `/write`, `/resize`, `/terminate`): sandboxed argv execution outside any thread, with PTY support
  - `fs/{readFile,writeFile,createDirectory,getMetadata,readDirectory,remove,copy,watch,unwatch}`
  - `fuzzyFileSearch` (for @-mention pickers)
  - `feedback/upload`, `windowsSandbox/{setupStart,readiness}`

### 2.3 Core request shapes (from the generated TS, `codex-ts/v2/*.ts`)

`ThreadStartParams` (all fields optional):

- model and provider: `model`, `modelProvider`, `serviceTier`
- location and policy: `cwd`, `approvalPolicy: AskForApproval`, `approvalsReviewer: "user"|"auto_review"|"guardian_subagent"`, `sandbox: "read-only"|"workspace-write"|"danger-full-access"`
- configuration and instructions: `config` (a map of arbitrary config.toml overrides), `baseInstructions`, `developerInstructions`
- other: `ephemeral`, `serviceName`, `threadSource`

Experimental fields: `permissions` (a named profile), `dynamicTools`, `historyMode`, `environments`, `multiAgentMode`, `projectId`.

`ThreadStartResponse` returns:

- `thread: Thread`
- the effective settings: `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox: SandboxPolicy`, `reasoningEffort`
- `instructionSources`: the AGENTS.md and other instruction files actually loaded
- `disabledPluginIds`

`thread/started` is also emitted, and the connection is auto-subscribed to the thread's events.

`ThreadResumeParams` has `threadId` plus the same overrides and `excludeTurns`. Precedence is history > path > threadId. Resuming a _running_ thread rejoins it. `thread/fork` takes `lastTurnId` and `ephemeral`.

`TurnStartParams`:

```ts
{ threadId, input: UserInput[], clientUserMessageId?, cwd?, approvalPolicy?, approvalsReviewer?,
  sandboxPolicy?: SandboxPolicy, model?, serviceTier?, serviceTierForTurn?, effort?: ReasoningEffort,
  summary?: "auto"|"concise"|"detailed"|"none", outputSchema?: JSONSchema, toolOutput?, disabledPluginIds? }
// experimental: collaborationMode {mode:"plan"|"default", settings{model,reasoning_effort,developer_instructions}},
//               permissions, environments, additionalContext, multiAgentMode
```

- Overrides persist for later turns. `outputSchema` applies to the current turn only.
- Response: `{turn:{id,status:"inProgress",items:[],error:null}}`.

`UserInput` is one of:

- `{type:"text", text, text_elements[]}`
- `{type:"image", url|fileId, detail?}`
- `{type:"localImage", path, detail?}`
- `{type:"audio", url}` or `{type:"localAudio", path}`
- `{type:"skill", name, path}`
- `{type:"mention", name, path}`

The other turn controls:

- `turn/steer {threadId, input, expectedTurnId}` → `{turnId}`. It appends input to the in-flight turn and takes no overrides.
- `turn/interrupt {threadId, turnId}` → `{}`. The turn then completes with `status:"interrupted"`.

### 2.4 Server → client notifications

The full list (82 methods) is in `ServerNotification.methods.txt`. The ones a chat GUI needs:

| Method                                                                                                                                              | Payload                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/started`, `thread/status/changed`                                                                                                           | `ThreadStatus = notLoaded \| idle \| systemError \| active{activeFlags: ["waitingOnApproval","waitingOnUserInput"]}`                                                         |
| `turn/started` / `turn/completed`                                                                                                                   | `{threadId, turn}`. `turn.status ∈ completed\|interrupted\|failed\|inProgress`, with `turn.error: {message, codexErrorInfo, additionalDetails}` and `durationMs`             |
| `item/started` / `item/completed`                                                                                                                   | `{item: ThreadItem, threadId, turnId, startedAtMs\|completedAtMs}`. `item/completed` is authoritative                                                                        |
| `item/agentMessage/delta`                                                                                                                           | `{threadId, turnId, itemId, delta}`                                                                                                                                          |
| `item/reasoning/summaryTextDelta`                                                                                                                   | `{…, delta, summaryIndex}`, plus `item/reasoning/summaryPartAdded` and `item/reasoning/textDelta {…, contentIndex}` (raw reasoning)                                          |
| `item/commandExecution/outputDelta`                                                                                                                 | `{…, delta}` (stdout+stderr). Also `item/commandExecution/terminalInteraction`                                                                                               |
| `item/fileChange/patchUpdated`                                                                                                                      | Patch updates (`item/fileChange/outputDelta` is deprecated and no longer emitted)                                                                                            |
| `item/plan/delta`                                                                                                                                   | Plan-mode plan text (experimental)                                                                                                                                           |
| `item/mcpToolCall/progress`                                                                                                                         | `{…, message}`                                                                                                                                                               |
| `turn/diff/updated`                                                                                                                                 | `{threadId, turnId, diff}`: the aggregated unified diff for the turn                                                                                                         |
| `turn/plan/updated`                                                                                                                                 | `{threadId, turnId, explanation, plan:[{step, status: pending\|inProgress\|completed}]}` (the todo list)                                                                     |
| `thread/tokenUsage/updated`                                                                                                                         | `{threadId, turnId, tokenUsage:{total, last:{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}, modelContextWindow}}` |
| `account/rateLimits/updated`                                                                                                                        | `{rateLimits: RateLimitSnapshot}`, a sparse update to merge into the last `account/rateLimits/read` result                                                                   |
| `account/updated`, `account/login/completed`                                                                                                        | Auth changes                                                                                                                                                                 |
| `serverRequest/resolved`                                                                                                                            | `{threadId, requestId}`: a pending approval was answered or cleared (for example by an interrupt)                                                                            |
| `error`                                                                                                                                             | `{error: TurnError, willRetry, threadId, turnId}`                                                                                                                            |
| `warning`, `configWarning`, `deprecationNotice`, `model/rerouted`, `model/safetyBuffering/updated`, `model/verification`, `turn/moderationMetadata` | Informational                                                                                                                                                                |
| `hook/started` / `hook/completed`, `skills/changed`, `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed`                            | Tooling                                                                                                                                                                      |
| `thread/compacted`                                                                                                                                  | Deprecated; use the `contextCompaction` item instead                                                                                                                         |

`CodexErrorInfo` values:

- plain: `contextWindowExceeded`, `sessionBudgetExceeded`, `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`, `cyberPolicy`, `internalServerError`, `unauthorized`, `badRequest`, `sandboxError`, `other`
- with a payload: `httpConnectionFailed{httpStatusCode}`, `responseStreamDisconnected{httpStatusCode}`, `activeTurnNotSteerable{turnKind}`, and others

### 2.5 Server → client requests (the client must answer)

From `ServerRequest.json`:

| Method                                        | Params (abridged)                                                                                                                                                                                                             | Response                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`       | `{threadId, turnId, itemId, kind, approvalId?, startedAtMs, command?, cwd?, commandActions?, reason?, networkApprovalContext?{host,protocol}, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?, environmentId}` | `{decision: "accept" \| "acceptForSession" \| {acceptWithExecpolicyAmendment:{execpolicy_amendment:[...]}} \| {applyNetworkPolicyAmendment:{network_policy_amendment}} \| "decline" \| "cancel"}` |
| `item/fileChange/requestApproval`             | `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}` (the diff is on the already-emitted `fileChange` item)                                                                                                         | `{decision: "accept" \| "acceptForSession" \| "decline" \| "cancel"}`                                                                                                                             |
| `item/permissions/requestApproval`            | `{threadId, turnId, itemId, cwd, reason, permissions: RequestPermissionProfile}`                                                                                                                                              | `{permissions: GrantedPermissionProfile (subset), scope: "turn" \| "session", strictAutoReview?}`                                                                                                 |
| `item/tool/requestUserInput` (experimental)   | `{questions:[{id, header, question, isOther, isSecret, options}], isBlocking, autoResolutionMs}`                                                                                                                              | `{answers:{[id]: …}}`                                                                                                                                                                             |
| `mcpServer/elicitation/request`               | `{threadId, turnId?, serverName, mode: "form" \| "openai/form" \| "url", message, requestedSchema \| url}`                                                                                                                    | `{action: "accept" \| "decline" \| "cancel", content}`                                                                                                                                            |
| `item/tool/call` (experimental dynamic tools) | `{tool, arguments, …}`                                                                                                                                                                                                        | `{contentItems, success}`                                                                                                                                                                         |
| `account/chatgptAuthTokens/refresh`           | Only in external-token mode                                                                                                                                                                                                   | New tokens                                                                                                                                                                                        |
| `attestation/generate`                        | Only if `requestAttestation` was set                                                                                                                                                                                          | `{token}`                                                                                                                                                                                         |
| `applyPatchApproval`, `execCommandApproval`   | Legacy v1                                                                                                                                                                                                                     | —                                                                                                                                                                                                 |

Command approval ordering (docs):

1. `item/started` (a `commandExecution` item with `status: inProgress`)
2. `item/commandExecution/requestApproval`
3. The client responds
4. `serverRequest/resolved`
5. `item/completed` with `status: completed|failed|declined`

File changes follow the same order. Render the diff from `item.changes[].diff` at `item/started`.

Example exchange:

```json
{"id":"srv-7","method":"item/fileChange/requestApproval","params":{"threadId":"thr_1","turnId":"t_1","itemId":"call_9","startedAtMs":1790443100000,"reason":null,"grantRoot":null}}
{"id":"srv-7","result":{"decision":"acceptForSession"}}
```

---

## 3. ThreadItem types (`codex-ts/v2/ThreadItem.ts`)

The union is tagged by `type`:

- `userMessage {id, clientId, content: UserInput[]}`
- `agentMessage {id, text, phase: "commentary"|"final_answer"|null, memoryCitation, delivery, questions}`
- `reasoning {id, summary: string[], content: string[]}`
- `plan {id, text}`: plan mode; the final item is authoritative
- `commandExecution {id, command, cwd, processId, source, status: inProgress|completed|failed|declined, commandActions: [{type: read{name,path} | listFiles{path} | search{query,path} | unknown}], aggregatedOutput, exitCode, durationMs, pluginId, scriptPath}`
- `fileChange {id, changes: [{path, kind: {type: add | delete | update{move_path}}, diff}], status}`
- `mcpToolCall {id, server, tool, status, arguments, appContext, mcpAppUi, pluginId, readOnlyHint, result, error, durationMs}`
- `dynamicToolCall {id, namespace, tool, arguments, status, contentItems, success, durationMs}`
- `collabAgentToolCall {id, tool, status, senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agentsStates}`: sub-agents. Also `subAgentActivity {kind, agentThreadId, agentPath}`
- `webSearch {id, query, action: search{query,queries} | open_page{url} | find_in_page{url,pattern} | other, results}`
- `imageView {id, path}`, `imageGeneration {…}`, `sleep {…}`
- `enteredReviewMode {id, review}` / `exitedReviewMode {id, review}`: the final review text is in `exitedReviewMode.review`
- `contextCompaction {id}`
- `functionCallOutput {id, name, namespace, output}`, `hookPrompt {id, fragments}`

The "todo list" is not an item in app-server. It is the `turn/plan/updated` notification (in `exec --json` it is a `todo_list` item).

---

## 4. Sandbox and approvals

**Sandbox modes.** Thread-level `SandboxMode` is kebab-case. Turn-level `SandboxPolicy` is a tagged object:

```ts
SandboxMode   = "read-only" | "workspace-write" | "danger-full-access"
SandboxPolicy = {type:"dangerFullAccess"} | {type:"readOnly", networkAccess, access?}
              | {type:"externalSandbox", networkAccess:"restricted"|"enabled"}
              | {type:"workspaceWrite", writableRoots[], networkAccess, excludeTmpdirEnvVar, excludeSlashTmp, readOnlyAccess?}
```

Doc caveat: the docs example shows `"sandbox": "workspaceWrite"` and `"approvalPolicy": "unlessTrusted"`. The generated schema is `workspace-write` / `untrusted`. Trust the schema.

How the sandbox is enforced:

- macOS: Seatbelt (`sandbox-exec`)
- Linux: bwrap + seccomp
- Windows: a native sandbox, set up via `windowsSandbox/setupStart`
- In `workspace-write`, `.git`, `.agents` and `.codex` under the writable roots stay read-only
- Network is off by default in workspace-write; set `sandbox_workspace_write.network_access = true` to allow it

**Approval policy:**

```ts
AskForApproval =
  "untrusted" |
  "on-request" |
  "never" |
  { granular: { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations } };
```

- The docs say `approval_policy = "untrusted"` is **retired** and "can prevent either client from starting". Use `on-request`, or `trust_level="untrusted"` per project. The CLI help only lists `on-request | never`.
- `approvalsReviewer: "user" | "auto_review"` routes approvals to an LLM reviewer. It costs extra usage, and the `item/autoApprovalReview/*` notifications report its progress.
- `permissionProfile/list` returns beta named profiles (the probe found `:read-only`, `:workspace`, `:danger-full-access`). They are experimental and replace `sandbox`.
- Admin constraints come from `configRequirements/read` (for example allowed approval policies and sandbox modes). A GUI should grey out disallowed options.

**Suggested GUI mapping.** These presets mirror Codex's own `/permissions` picker:

| Preset                           | sandbox              | approvalPolicy                                  | Notes                                                         |
| -------------------------------- | -------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Read-only / Ask                  | `read-only`          | `on-request`                                    | Chat and planning                                             |
| **Auto (default in a git repo)** | `workspace-write`    | `on-request`                                    | Prompts on writes outside the workspace and on network access |
| Auto + auto-review               | `workspace-write`    | `on-request`, `approvalsReviewer:"auto_review"` | Fewer prompts                                                 |
| Full access                      | `danger-full-access` | `never`                                         | Needs a warning badge                                         |

Add a separate toggle for network access (`workspaceWrite.networkAccess`) and optional extra writable roots. Offer per-prompt buttons for Allow once (`accept`), Allow for session (`acceptForSession`), Always allow this command prefix (`acceptWithExecpolicyAmendment` using `proposedExecpolicyAmendment`), Deny (`decline`), and Deny + stop turn (`cancel`).

---

## 5. Auth

**Detecting auth without touching tokens.** Do not read `~/.codex/auth.json`; it holds plaintext tokens, or it may not exist because credentials are in the keyring.

- `codex login status` prints e.g. `Logged in using ChatGPT` or `Logged in using an API key…`, exits non-zero when not logged in, and exposes no secrets.
- app-server `account/read {refreshToken:false}` returns `{account: null | {type:"apiKey"} | {type:"chatgpt", email, planType} | {type:"amazonBedrock", …}, requiresOpenaiAuth}`. Probe result: `{type:"chatgpt", planType:"prolite"}` with `requiresOpenaiAuth: true`.
- `account/updated {authMode, planType}` is pushed after `initialize`.
- `AuthMode` values: `apikey | chatgpt | chatgptAuthTokens | headers | agentIdentity | personalAccessToken | bedrockApiKey | bedrockAccessKeys`.
- Storage location follows `cli_auth_credentials_store = file|keyring|auto|ephemeral`. `forced_login_method` can restrict the allowed method.

**Login flows via app-server** (so the GUI never handles OAuth tokens):

- `account/login/start {type:"chatgpt"}` → `{loginId, authUrl}`. Open the URL; app-server hosts the localhost callback and then emits `account/login/completed` and `account/updated`.
- `{type:"chatgptDeviceCode"}` → `{verificationUrl, userCode}`
- `{type:"apiKey", apiKey}`: Codex stores the key
- `account/logout`, `account/login/cancel {loginId}`
- `chatgptAuthTokens`: an experimental external-token mode for hosts that own the ChatGPT OAuth themselves. A third-party GUI should not use it.

**Policy on third-party clients using a ChatGPT subscription through the official binary:**

- OpenAI documents app-server as the way to "Embed Codex into your product", and its auth section includes the ChatGPT browser and device-code login flows. The server exposes ChatGPT rate limits and plan types to the embedding client. `clientInfo.name` exists to identify integrations in compliance logs, and the docs invite enterprise integrators to contact OpenAI to be added to a "known clients list".
- I found no explicit written statement that permits or forbids a third-party GUI driving the official `codex` binary with a user's own ChatGPT login.
- An OpenAI maintainer in https://github.com/openai/codex/discussions/8338 said the CLI is Apache-2.0 and "you're welcome to fork the repo", then declined to interpret the ToS ("I'm an engineer, not a lawyer").
- Third-party docs such as OpenClaw (https://docs.openclaw.ai/providers/openai) claim "OpenAI explicitly supports subscription OAuth usage in external tools". That is secondary and unverified.
- **Practical reading:** a local GUI that spawns the user's installed official `codex app-server` stays within the documented and supported embedding path. The user logs in through Codex's own flow, tokens stay in Codex's store, and usage is the user's own. The ToS risk applies to re-implementing the OAuth client or reselling or pooling subscription access. Set an honest `clientInfo.name`, and contact OpenAI if targeting enterprise.
- **Usage accounting:** ChatGPT login uses plan rate limits (`account/rateLimits/read`; the probe showed a weekly window, `windowDurationMins: 10080`). API-key auth is billed at API rates, and some features are unavailable with it (auth.md).

---

## 6. Models, effort, images, review, compaction, skills, MCP

**Models.** `model/list {limit, includeHidden}` returns entries of the form `{id, model, displayName, description, hidden, isDefault, supportedReasoningEfforts:[{reasoningEffort, description}], defaultReasoningEffort, inputModalities, serviceTiers, upgrade, upgradeInfo}`.

The live catalog (probe, 0.156.1, ChatGPT prolite):

| Model           | Notes   | Efforts   |
| --------------- | ------- | --------- |
| `gpt-6-astra`   | Default | low…ultra |
| `gpt-6-sol`     |         | low…ultra |
| `gpt-6-luna`    |         | low…max   |
| `gpt-5.6-sol`   |         | low…ultra |
| `gpt-5.6-terra` |         | low…ultra |
| `gpt-5.6-luna`  |         | low…max   |
| `gpt-5.5`       |         | low…xhigh |

- The efforts seen are `low, medium, high, xhigh, max, ultra`. All models take text and image input, and all offer the `priority` (Fast) service tier.
- `ReasoningEffort` is typed as an open `string`, so drive the picker from `supportedReasoningEfforts`.
- Set the model and effort per turn (`turn/start.model`, `.effort`, `.summary`) or per thread. `serviceTier` selects Fast mode. `model/rerouted` tells you when the service swapped models.

**Images.** Use `UserInput` `localImage {path}` or `image {url}`. Check `inputModalities` includes `"image"`. There is also audio input. `imageView` and `imageGeneration` items appear in output.

**Review mode.**

- `review/start {threadId, target: uncommittedChanges | baseBranch{branch} | commit{sha,title} | custom{instructions}, delivery: "inline"|"detached"}` → `{turn, reviewThreadId}`. `detached` is deprecated.
- Output comes as the `enteredReviewMode` / `exitedReviewMode{review}` items.
- The CLI equivalents are `codex review` and `codex exec review`.

**Compaction.**

- `thread/compact/start {threadId}` → `{}`. Progress streams as turn and item events with a `contextCompaction` item.
- Auto-compaction is controlled by config `model_auto_compact_token_limit`, with `compact_prompt` for the prompt.
- `thread/tokenUsage/updated.modelContextWindow` gives the context-meter denominator.

**Skills.**

- `skills/list {cwds, forceReload}` → per-cwd `{skills:[{name, description, interface{displayName, shortDescription}, dependencies, path, scope, enabled, pluginId}], errors}`
- Invoke a skill with text `$skill-name …` plus a `{type:"skill", name, path}` input
- `skills/changed` invalidates the cache, and `skills/config/write` enables or disables a skill
- Skills live in `~/.codex/skills`, the repo `.agents/skills`, and plugins
- Legacy custom prompts in `~/.codex/prompts` are not exposed via app-server. The current docs don't mention them; skills and plugins replaced them.

**Slash commands.** These are TUI-only; nothing is exposed as an RPC. A GUI re-implements the useful ones on top of the API:

| Slash command                                                | API equivalent                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `/model`, `/fast`                                            | `model/list` + turn overrides                                  |
| `/permissions`                                               | sandbox and approval overrides                                 |
| `/plan`                                                      | experimental `collaborationMode {mode:"plan"}`                 |
| `/compact`                                                   | `thread/compact/start`                                         |
| `/review`                                                    | `review/start`                                                 |
| `/new`, `/resume`, `/fork`, `/rename`, `/archive`, `/delete` | `thread/*`                                                     |
| `/status`, `/usage`                                          | token usage + `account/rateLimits/read` / `account/usage/read` |
| `/mcp`                                                       | `mcpServerStatus/list`                                         |
| `/skills`                                                    | `skills/list`                                                  |
| `/init`                                                      | a prompt that writes AGENTS.md                                 |
| `/diff`                                                      | `turn/diff/updated` or git                                     |
| `/goal`                                                      | `thread/goal/*`                                                |
| `/mention`                                                   | `fuzzyFileSearch` + `mention` input                            |

The full list is in developer-commands.md.

**AGENTS.md.** Loaded automatically (global `~/.codex/AGENTS.md`, then from the repo root down to cwd). The loaded files are returned in `instructionSources`. `developerInstructions` and `baseInstructions` add to or replace the instructions per thread.

**MCP.**

- Configure servers in `config.toml` `[mcp_servers.<name>]`: either stdio (`command`, `args`, `env`, `env_vars`) or streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`, `oauth`). A `required = true` server makes thread/start fail if it can't start.
- CLI: `codex mcp add|list|login`.
- App-server: `mcpServerStatus/list` (tools, resources, `authStatus`), `mcpServer/oauth/login` → authorization URL, `config/mcpServer/reload`, `mcpServer/tool/call`, `mcpServer/resource/read`, plus the startup-status notifications and the elicitation server request.
- Config can also be written via `config/value/write` / `config/batchWrite`.

---

## 7. Session storage and listing

- **Rollouts:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuidv7>.jsonl`. `thread.path` exposes this (marked UNSTABLE).
- **Archived rollouts:** `$CODEX_HOME/archived_sessions/`.
- **SQLite indexes** (0.156.1): `state_5.sqlite` (thread metadata), `thread_history_1.sqlite` (the new "paginated" history), plus `session_index.jsonl` and `history.jsonl` (the prompt history). `codex migrate-rollouts` converts old rollouts to paginated history.
- **Don't parse these files.** Use:
  - `thread/list {cursor, limit, sortKey, sortDirection, modelProviders, sourceKinds, archived, cwd, searchTerm, useStateDbOnly}` → `{data: Thread[], nextCursor, backwardsCursor}`
  - `thread/read {threadId, includeTurns}`
  - `thread/turns/list` / `thread/items/list` (experimental) to hydrate transcripts
- `Thread` fields: `{id (UUIDv7), sessionId, forkedFromId, parentThreadId, preview, name, ephemeral, modelProvider, model, reasoningEffort, createdAt, updatedAt, recencyAt, status, path, cwd, cliVersion, originator, source, gitInfo, turns}`.
- `sourceKinds` defaults to interactive sources (`cli`, `vscode`, `appServer`, and so on). Pass `["exec"]` etc. to include others. In the probe, the user's existing VS Code threads were visible with `historyMode:"paginated"`, so threads are shared across the CLI, IDE, desktop and your GUI.
- Ephemeral threads (`ephemeral: true`, or `codex exec --ephemeral`) are never written to disk.
- Other lifecycle: `thread/archive` and `thread/unarchive` move files, `thread/delete` is permanent and includes sub-agent descendants, and `thread/name/set` renames.
- The CLI equivalents are `codex resume`, `codex fork`, `codex archive`, and `codex delete`.
