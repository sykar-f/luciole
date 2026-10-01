import { z } from "zod";

// What coder reads from `opencode serve` (1.18.31), checked on arrival: every response and
// every server-sent event is external data.
// Checked against the exchanges recorded in tests/fixtures/coder/opencode/.

/** One server-sent event: `data: {id, type, properties}`. */
export const Event = z.looseObject({ type: z.string(), properties: z.unknown().optional() });
export const Health = z.looseObject({ healthy: z.boolean(), version: z.string().optional() });

export const Time = z.looseObject({
  created: z.number().optional(),
  updated: z.number().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
});
export const Session = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  directory: z.string().optional(),
  parentID: z.string().optional(),
  time: Time.optional(),
});
export const Sessions = z.array(Session);
export const SessionEvent = z.looseObject({ info: Session });
export const Status = z.looseObject({
  type: z.string(),
  attempt: z.number().optional(),
  message: z.string().optional(),
});
export const StatusEvent = z.looseObject({ sessionID: z.string(), status: Status });
export const Statuses = z.record(z.string(), Status);
export const SessionError = z.looseObject({
  sessionID: z.string().optional(),
  error: z
    .looseObject({
      name: z.string(),
      data: z.looseObject({ message: z.string().optional() }).optional(),
    })
    .optional(),
});
export const SessionOnly = z.looseObject({ sessionID: z.string() });

export const Tokens = z.looseObject({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cache: z.looseObject({ read: z.number(), write: z.number() }).optional(),
});
export const MessageInfo = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  role: z.string(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
});
export const MessageEvent = z.looseObject({ info: MessageInfo });

const PartBase = { id: z.string(), sessionID: z.string(), messageID: z.string() };
export const TextPart = z.looseObject({
  ...PartBase,
  type: z.enum(["text", "reasoning"]),
  text: z.string(),
  synthetic: z.boolean().optional(),
  time: Time.optional(),
});
export const ToolState = z.looseObject({
  status: z.enum(["pending", "running", "completed", "error"]),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.string().optional(),
  error: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const ToolPart = z.looseObject({
  ...PartBase,
  type: z.literal("tool"),
  tool: z.string(),
  callID: z.string(),
  state: ToolState,
});
export const StepFinish = z.looseObject({
  ...PartBase,
  type: z.literal("step-finish"),
  cost: z.number().optional(),
  tokens: Tokens.optional(),
});
export const CompactionPart = z.looseObject({ ...PartBase, type: z.literal("compaction") });
export const AnyPart = z.looseObject({ ...PartBase, type: z.string() });
export const PartEvent = z.looseObject({ part: z.unknown() });
export const PartDelta = z.looseObject({
  sessionID: z.string(),
  partID: z.string(),
  field: z.string(),
  delta: z.string(),
});
export const Messages = z.array(z.looseObject({ info: MessageInfo, parts: z.array(z.unknown()) }));

export const PermissionAsked = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  always: z.array(z.string()).default([]),
});
export const Permissions = z.array(PermissionAsked);
export const QuestionAsked = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
      multiple: z.boolean().optional(),
    }),
  ),
});
export const Questions = z.array(QuestionAsked);
export const Replied = z.looseObject({ sessionID: z.string(), requestID: z.string() });
export const Todos = z.looseObject({
  sessionID: z.string(),
  todos: z.array(z.looseObject({ content: z.string(), status: z.string() })),
});

export const EditMetadata = z.looseObject({
  diff: z.string().optional(),
  filediff: z.looseObject({ patch: z.string().optional() }).optional(),
});
export const BashMetadata = z.looseObject({
  output: z.string().optional(),
  exit: z.number().nullish(),
});

// Responses.
export const Model = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  limit: z.looseObject({ context: z.number().optional() }).optional(),
  variants: z.record(z.string(), z.unknown()).optional(),
});
export const Providers = z.looseObject({
  all: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      models: z.record(z.string(), Model).default({}),
    }),
  ),
  default: z.record(z.string(), z.string()).default({}),
  connected: z.array(z.string()).default([]),
});
export type Providers = z.infer<typeof Providers>;
export const Config = z.looseObject({ model: z.string().optional() });
export const Commands = z.array(
  z.looseObject({ name: z.string(), description: z.string().optional() }),
);
