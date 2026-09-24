import "server-only";
import { z } from "zod";

// The subset of pi's RPC protocol (`pi --mode rpc`, docs/rpc.md of pi) this example reads.
// Every line from pi is JSON checked here: an unknown event is ignored, never trusted.

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const ThinkingPart = z.object({ type: z.literal("thinking"), thinking: z.string() });
const ToolCallPart = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const OtherPart = z.object({ type: z.string() });
export const Part = z.union([TextPart, ThinkingPart, ToolCallPart, OtherPart]);
export type Part = z.infer<typeof Part>;
const Content = z.union([z.string(), z.array(Part)]);

const Usage = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.object({ total: z.number() }),
});

export const Message = z.union([
  z.object({ role: z.literal("user"), content: Content }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(Part),
    stopReason: z.string(),
    errorMessage: z.string().optional(),
    usage: Usage.optional(),
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: Content,
    isError: z.boolean(),
  }),
  z.object({ role: z.string() }),
]);
export type Message = z.infer<typeof Message>;

const ToolResult = z.object({ content: Content.optional() });

const AssistantEvent = z.object({
  type: z.string(),
  contentIndex: z.number(),
  delta: z.string().optional(),
  content: z.string().optional(),
  id: z.string().optional(),
  toolName: z.string().optional(),
  toolCall: ToolCallPart.optional(),
});
export type AssistantEvent = z.infer<typeof AssistantEvent>;

export const Response = z.object({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

export const Event = z.union([
  Response,
  z.object({
    type: z.enum(["message_start", "message_end"]),
    message: Message,
  }),
  z.object({ type: z.literal("message_update"), assistantMessageEvent: AssistantEvent }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    partialResult: ToolResult,
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    result: ToolResult,
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("queue_update"),
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  }),
  z.object({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number(),
    errorMessage: z.string(),
  }),
  z.object({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    finalError: z.string().optional(),
  }),
  z.object({ type: z.literal("compaction_start"), reason: z.string() }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.string() }),
  z.object({ type: z.literal("extension_error"), error: z.string() }),
  z.object({
    type: z.enum(["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end"]),
  }),
]);
export type Event = z.infer<typeof Event>;

export const State = z.object({
  sessionId: z.string().nullish(),
  isStreaming: z.boolean(),
  model: z.object({ provider: z.string(), id: z.string() }).nullish(),
  thinkingLevel: z.string().optional(),
});
export const Messages = z.object({ messages: z.array(Message) });

/** The text of a message or tool result; images are named, not shown. */
export function textOf(content: string | readonly Part[] | undefined) {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => ("text" in part ? part.text : part.type === "image" ? "[image]" : ""))
    .join("");
}
