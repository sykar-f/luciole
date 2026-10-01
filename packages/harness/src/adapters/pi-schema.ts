import { z } from "zod";

// What coder reads from `pi --mode rpc` (0.87.1),
// checked on arrival: every line of the harness is external data. Checked against the
// exchanges recorded in tests/fixtures/coder/pi/.

export const Response = z.looseObject({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});
export const Event = z.looseObject({ type: z.string() });

export const Text = z.looseObject({ type: z.literal("text"), text: z.string() });
export const Thinking = z.looseObject({ type: z.literal("thinking"), thinking: z.string() });
export const ToolCall = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const Part = z.union([Text, Thinking, ToolCall, z.looseObject({ type: z.string() })]);
/** A message part as coder uses it: text, thinking, a tool call, or nothing it shows. */
export function partOf(part: unknown) {
  const text = Text.safeParse(part);
  if (text.success) return { kind: "text" as const, text: text.data.text };
  const thinking = Thinking.safeParse(part);
  if (thinking.success) return { kind: "thinking" as const, text: thinking.data.thinking };
  const call = ToolCall.safeParse(part);
  if (call.success)
    return {
      kind: "tool" as const,
      id: call.data.id,
      name: call.data.name,
      args: call.data.arguments,
    };
  return undefined;
}
/** The parts of a message's content, a plain string being one text part. */
export const partsOf = (content: unknown) =>
  typeof content === "string"
    ? [{ kind: "text" as const, text: content }]
    : Array.isArray(content)
      ? content.flatMap((p) => {
          const part = partOf(p);
          return part ? [part] : [];
        })
      : [];
export const Role = z.looseObject({ role: z.string(), content: z.unknown().optional() });
export const Usage = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  totalTokens: z.number().optional(),
  cost: z.looseObject({ total: z.number().optional() }).optional(),
});
export const Message = z.union([
  z.looseObject({ role: z.literal("user"), content: z.union([z.string(), z.array(Part)]) }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z.array(Part),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(Part).default([]),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  z.looseObject({ role: z.string() }),
]);
export type Message = z.infer<typeof Message>;
export const MessageEvent = z.looseObject({ message: Message });
export const AssistantDelta = z.looseObject({
  assistantMessageEvent: z.looseObject({
    type: z.string(),
    contentIndex: z.number().optional(),
    delta: z.string().optional(),
  }),
});
export const ToolStart = z.looseObject({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});
export const ToolUpdate = z.looseObject({
  toolCallId: z.string(),
  partialResult: z.looseObject({ content: z.array(Part).default([]) }).optional(),
});
export const ToolEnd = z.looseObject({
  toolCallId: z.string(),
  result: z.looseObject({ content: z.array(Part).default([]), details: z.unknown().optional() }),
  isError: z.boolean().optional(),
});
export const EditDetails = z.looseObject({ patch: z.string() });
export const Queue = z.looseObject({
  steering: z.array(z.string()).default([]),
  followUp: z.array(z.string()).default([]),
});
export const UiRequest = z.looseObject({
  id: z.string(),
  method: z.string(),
  title: z.string().optional(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  notifyType: z.string().optional(),
});
export const GateRequest = z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) });
export const Retry = z.looseObject({
  attempt: z.number().optional(),
  maxAttempts: z.number().optional(),
  errorMessage: z.string().optional(),
  success: z.boolean().optional(),
  finalError: z.string().optional(),
});
export const ExtensionError = z.looseObject({ error: z.string() });
export const SessionName = z.looseObject({ name: z.string().optional() });
export const ThinkingLevel = z.looseObject({ level: z.string() });

// Responses' data.
export const Model = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string(),
  reasoning: z.boolean().optional(),
});
export const State = z.looseObject({
  model: Model.nullish(),
  thinkingLevel: z.string().optional(),
  isStreaming: z.boolean().optional(),
  sessionId: z.string().optional(),
  sessionName: z.string().nullish(),
});
export const Models = z.looseObject({ models: z.array(Model) });
export const Commands = z.looseObject({
  commands: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })),
});
export const Messages = z.looseObject({ messages: z.array(z.unknown()) });
export const Stats = z.looseObject({
  tokens: z.looseObject({ input: z.number(), output: z.number() }).optional(),
  cost: z.number().optional(),
  contextUsage: z
    .looseObject({ tokens: z.number().nullish(), contextWindow: z.number().nullish() })
    .optional(),
});
/** The first line of a session file. */
export const SessionHeader = z.looseObject({
  type: z.literal("session"),
  id: z.string(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
});
