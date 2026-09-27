import { z } from "zod";

// What coder reads from `codex app-server`, checked on arrival (Zod at every boundary).
// The generated types (./codex-protocol, codex 0.156.1) type what coder sends; these
// schemas accept what it receives, loosely: unknown fields pass, unknown items are tools.
// Checked against recorded exchanges in tests/fixtures/coder/codex/.

const Change = z.looseObject({
  path: z.string(),
  kind: z.looseObject({ type: z.string() }),
  diff: z.string(),
});
const CommandAction = z.looseObject({ type: z.string(), command: z.string().optional() });
export const ThreadItem = z.union([
  z.looseObject({ type: z.literal("userMessage"), id: z.string() }),
  z.looseObject({ type: z.literal("agentMessage"), id: z.string(), text: z.string() }),
  z.looseObject({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.string()).default([]),
  }),
  z.looseObject({ type: z.literal("plan"), id: z.string(), text: z.string() }),
  z.looseObject({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string().nullish(),
    status: z.string(),
    commandActions: z.array(CommandAction).default([]),
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().nullish(),
  }),
  z.looseObject({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(Change),
    status: z.string(),
  }),
  z.looseObject({
    type: z.literal("collabAgentToolCall"),
    id: z.string(),
    tool: z.string(),
    status: z.string(),
    prompt: z.string().nullish(),
  }),
  z.looseObject({ type: z.literal("contextCompaction"), id: z.string() }),
  z.looseObject({ type: z.literal("exitedReviewMode"), id: z.string(), review: z.string() }),
  z.looseObject({ type: z.string(), id: z.string() }),
]);
export type ThreadItem = z.infer<typeof ThreadItem>;

export const ItemNotification = z.looseObject({ item: z.unknown() });
export const Delta = z.looseObject({ itemId: z.string(), delta: z.string() });
export const TurnNotification = z.looseObject({
  turn: z.looseObject({
    id: z.string(),
    status: z.string(),
    error: z.looseObject({ message: z.string() }).nullish(),
  }),
});
export const PlanUpdated = z.looseObject({
  plan: z.array(z.looseObject({ step: z.string(), status: z.string() })),
});
const TokenCounts = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export const TokenUsage = z.looseObject({
  tokenUsage: z.looseObject({
    total: TokenCounts,
    last: TokenCounts,
    modelContextWindow: z.number().nullish(),
  }),
});
const Window = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
export const RateLimits = z.looseObject({
  rateLimits: z.looseObject({ primary: Window.nullish(), secondary: Window.nullish() }),
});
export const ErrorNotification = z.looseObject({
  error: z.looseObject({ message: z.string() }),
  willRetry: z.boolean().optional(),
});
export const Resolved = z.looseObject({ requestId: z.union([z.string(), z.number()]) });
export const Message = z.looseObject({ message: z.string() });

// Requests from Codex.
export const CommandApproval = z.looseObject({
  itemId: z.string(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
  commandActions: z.array(CommandAction).nullish(),
  proposedExecpolicyAmendment: z.array(z.string()).nullish(),
});
export const FileApproval = z.looseObject({ itemId: z.string(), reason: z.string().nullish() });
export const UserInputRequest = z.looseObject({
  questions: z.array(
    z.looseObject({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z
        .array(z.looseObject({ label: z.string(), description: z.string().nullish() }))
        .nullish(),
    }),
  ),
});

// Responses.
export const InitializeResponse = z.looseObject({ userAgent: z.string() });
export const AccountResponse = z.looseObject({
  account: z
    .looseObject({ type: z.string(), email: z.string().nullish(), planType: z.string().nullish() })
    .nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});
const Thread = z.looseObject({
  id: z.string(),
  preview: z.string().nullish(),
  name: z.string().nullish(),
  updatedAt: z.number().nullish(),
  cwd: z.string().nullish(),
  turns: z.array(z.looseObject({ items: z.array(z.unknown()).default([]) })).default([]),
});
export const ThreadResponse = z.looseObject({ thread: Thread, model: z.string().nullish() });
export const ThreadList = z.looseObject({ data: z.array(Thread) });
export const TurnStartResponse = z.looseObject({ turn: z.looseObject({ id: z.string() }) });
export const ModelList = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      supportedReasoningEfforts: z
        .array(z.looseObject({ reasoningEffort: z.string() }))
        .default([]),
      defaultReasoningEffort: z.string().nullish(),
    }),
  ),
});
export const SkillsList = z.looseObject({
  data: z.array(
    z.looseObject({
      skills: z.array(
        z.looseObject({
          name: z.string(),
          description: z.string(),
          path: z.string(),
          enabled: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
