import { z } from "zod";

// The part of the Agent SDK's messages (SDKMessage, sdk.d.ts of 0.3.283) that coder
// reads, checked on arrival: the SDK types them, but they come from another process whose
// version moves (Zod at every boundary). Checked against recorded streams in
// tests/fixtures/coder/claude/. Unknown fields pass; unknown messages are ignored.

const Text = z.object({ type: z.literal("text"), text: z.string() });
const Thinking = z.object({ type: z.literal("thinking"), thinking: z.string() });
const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const ToolResultContent = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);
const ToolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: ToolResultContent.optional(),
  is_error: z.boolean().optional(),
});
export const ContentBlock = z.union([
  Text,
  Thinking,
  ToolUse,
  ToolResult,
  z.looseObject({ type: z.string() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export type ToolUse = z.infer<typeof ToolUse>;
export type ToolResult = z.infer<typeof ToolResult>;
export const isToolUse = (b: ContentBlock): b is ToolUse => b.type === "tool_use" && "input" in b;
export const isToolResult = (b: ContentBlock): b is ToolResult =>
  b.type === "tool_result" && "tool_use_id" in b;

const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

const Assistant = z.object({
  type: z.literal("assistant"),
  message: z.looseObject({
    id: z.string(),
    model: z.string().optional(),
    content: z.array(ContentBlock),
    usage: Usage.optional(),
  }),
  parent_tool_use_id: z.string().nullish(),
  error: z.string().optional(),
});
const User = z.object({
  type: z.literal("user"),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]) }),
  parent_tool_use_id: z.string().nullish(),
  tool_use_result: z.unknown().optional(),
  isReplay: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
});
const StreamEvent = z.object({
  type: z.literal("stream_event"),
  parent_tool_use_id: z.string().nullish(),
  event: z.looseObject({ type: z.string() }),
});
// The events of a partial message, read one by one (stream_event.event).
export const MessageStart = z.object({
  type: z.literal("message_start"),
  message: z.looseObject({ id: z.string() }),
});
export const BlockStart = z.object({
  type: z.literal("content_block_start"),
  index: z.number(),
  content_block: z.looseObject({ type: z.string() }),
});
export const BlockDelta = z.object({
  type: z.literal("content_block_delta"),
  index: z.number(),
  delta: z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  }),
});
export const BlockStop = z.object({ type: z.literal("content_block_stop"), index: z.number() });
const Result = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  total_cost_usd: z.number().optional(),
  usage: Usage.optional(),
  modelUsage: z
    .record(z.string(), z.looseObject({ contextWindow: z.number().optional() }))
    .optional(),
  terminal_reason: z.string().optional(),
});
const Init = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  claude_code_version: z.string().optional(),
  apiKeySource: z.string().optional(),
});
const Status = z.object({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: z.string().nullish(),
  permissionMode: z.string().optional(),
});
const CompactBoundary = z.object({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
});
const TaskStarted = z.object({
  type: z.literal("system"),
  subtype: z.literal("task_started"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
});
const TaskProgress = z.object({
  type: z.literal("system"),
  subtype: z.literal("task_progress"),
  task_id: z.string(),
  description: z.string().optional(),
  usage: z.looseObject({ tool_uses: z.number().optional() }).optional(),
  summary: z.string().optional(),
});
const Informational = z.object({
  type: z.literal("system"),
  subtype: z.literal("informational"),
  content: z.string(),
  level: z.string().optional(),
});
const ApiRetry = z.object({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number(),
  max_retries: z.number(),
  error: z.unknown().optional(),
});
const Reset = z.object({ type: z.literal("conversation_reset") });
const Window = z.looseObject({
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
});
const RateLimit = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string().optional(),
    resetsAt: z.number().optional(),
    unifiedWindows: z
      .looseObject({ five_hour: Window.optional(), seven_day: Window.optional() })
      .optional(),
  }),
});

/** A message coder uses, or `undefined` for one it does not. */
export const ClaudeMessage = z.union([
  Assistant,
  User,
  StreamEvent,
  Result,
  Init,
  Status,
  CompactBoundary,
  TaskStarted,
  TaskProgress,
  Informational,
  ApiRetry,
  Reset,
  RateLimit,
]);
export type ClaudeMessage = z.infer<typeof ClaudeMessage>;
export const parseMessage = (value: unknown) => {
  const parsed = ClaudeMessage.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** `initializationResult()`: commands, models, account; nothing secret. */
export const InitializeResult = z.looseObject({
  commands: z
    .array(z.looseObject({ name: z.string(), description: z.string().optional() }))
    .default([]),
  models: z
    .array(
      z.looseObject({
        value: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        supportedEffortLevels: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  account: z
    .looseObject({
      email: z.string().optional(),
      subscriptionType: z.string().optional(),
      apiKeySource: z.string().optional(),
    })
    .optional(),
});

// Tool inputs and structured results the transcript shows.
export const BashInput = z.looseObject({ command: z.string(), description: z.string().optional() });
export const BashResult = z.looseObject({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
});
export const EditInput = z.looseObject({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
export const MultiEditInput = z.looseObject({
  file_path: z.string(),
  edits: z.array(
    z.looseObject({
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
  ),
});
export const WriteInput = z.looseObject({ file_path: z.string(), content: z.string() });
export const EditResult = z.looseObject({
  filePath: z.string(),
  originalFile: z.string().nullish(),
});
export const TodoInput = z.looseObject({
  todos: z.array(
    z.looseObject({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }),
  ),
});
export const AgentInput = z.looseObject({
  description: z.string().optional(),
  prompt: z.string().optional(),
  subagent_type: z.string().optional(),
});
export const QuestionInput = z.looseObject({
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string().optional(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
    }),
  ),
});
export const PlanInput = z.looseObject({
  plan: z.string().optional(),
  planFilePath: z.string().optional(),
});

/** One stored message of a session (`getSessionMessages`), for a resumed transcript. */
export const SessionMessage = z.looseObject({
  type: z.enum(["user", "assistant"]),
  uuid: z.string().optional(),
  message: z.unknown(),
  parent_tool_use_id: z.string().nullish(),
});
export const SessionInfo = z.looseObject({
  sessionId: z.string(),
  summary: z.string().optional(),
  customTitle: z.string().nullish(),
  firstPrompt: z.string().nullish(),
  lastModified: z.number(),
  cwd: z.string().nullish(),
});

/** `claude auth status` (JSON): who is signed in, never a token. */
export const AuthStatus = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
  apiProvider: z.string().optional(),
});
