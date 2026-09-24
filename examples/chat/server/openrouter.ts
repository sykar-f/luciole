import { z } from "zod";
import type { ChatEvent, ChatMessage, Pricing, Setup, Usage } from "../components/model";

// The key, the endpoint and every network call stay in this Server module: the Client
// only ever sees `Setup` (no key) and the events of a reply.

/** Newest DeepSeek "flash" listed by GET /api/v1/models on 2026-09-23 ($0.10 / $0.50 per M). */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const SYSTEM_PROMPT =
  "You are a helpful assistant inside a terminal chat. Be concise. Use light Markdown " +
  "only: short paragraphs, lists, **bold**, `inline code` and fenced code blocks. No tables.";
const MODELS_TIMEOUT_MS = 3000;
// Retry a failed price lookup at most this often.
const MODELS_RETRY_MS = 30_000;
const ERROR_CHARS = 300;

const Environment = z.object({
  OPENROUTER_API_KEY: z.string().trim().optional(),
  OPENROUTER_MODEL: z.string().trim().optional(),
  OPENROUTER_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
});

type Settings = { key?: string; model: string; baseUrl: string; error?: string };

/** Read at each call: a restarted Server picks up a new environment. */
export function settings(): Settings {
  const env = Environment.safeParse(process.env);
  if (!env.success) {
    const name = env.error.issues[0]?.path.join(".") ?? "environment";
    return { model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, error: `${name} is invalid` };
  }
  return {
    key: env.data.OPENROUTER_API_KEY || undefined,
    model: env.data.OPENROUTER_MODEL || DEFAULT_MODEL,
    baseUrl: (env.data.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

const ModelList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      pricing: z.object({ prompt: z.coerce.number(), completion: z.coerce.number() }).optional(),
    }),
  ),
});
type ModelInfo = { name?: string; pricing?: Pricing; contextLength?: number };

// One lookup per model and endpoint; a failure is remembered briefly, not forever.
const models = new Map<string, Promise<ModelInfo | null>>();
function modelInfo({ baseUrl, model }: Settings): Promise<ModelInfo | null> {
  const id = `${baseUrl} ${model}`;
  const cached = models.get(id);
  if (cached) return cached;
  const info = (async () => {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      const list = ModelList.safeParse(await response.json());
      const found = list.success ? list.data.data.find((m) => m.id === model) : undefined;
      if (!found) throw new Error("model not listed");
      return {
        name: found.name,
        pricing: found.pricing,
        contextLength: found.context_length ?? undefined,
      };
    } catch {
      setTimeout(() => models.delete(id), MODELS_RETRY_MS).unref();
      return null;
    }
  })();
  models.set(id, info);
  return info;
}

/** The page's view of the configuration. The model list is public: no key needed. */
export async function describeSetup(): Promise<Setup> {
  const current = settings();
  const info = current.error ? null : await modelInfo(current);
  return {
    model: current.model,
    endpoint: new URL(current.baseUrl).host,
    keyMissing: !current.key,
    configError: current.error,
    modelName: info?.name,
    pricing: info?.pricing,
    contextLength: info?.contextLength,
  };
}

// The OpenAI-compatible stream chunk, reduced to what the chat reads.
const Chunk = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});
const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

const clip = (text: string) =>
  text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text;

async function failure(response: Response) {
  const text = await response.text().catch(() => "");
  let detail = text.trim();
  try {
    const body = ErrorBody.safeParse(JSON.parse(text));
    if (body.success) detail = body.data.error.message;
  } catch {
    // Not JSON: the raw text says what happened.
  }
  const hint: Record<number, string> = {
    401: "OpenRouter rejected the API key (check OPENROUTER_API_KEY)",
    402: "Not enough OpenRouter credits for this request",
    404: "Unknown model or endpoint (check OPENROUTER_MODEL / OPENROUTER_BASE_URL)",
    429: "Rate limited by OpenRouter, try again in a moment",
  };
  const lead = hint[response.status] ?? `OpenRouter answered ${response.status}`;
  return clip(detail ? `${lead}: ${detail}` : lead);
}

function usageOf(raw: NonNullable<z.infer<typeof Chunk>["usage"]>, pricing?: Pricing): Usage {
  const usage: Usage = {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? undefined,
  };
  if (typeof raw.cost === "number") return { ...usage, cost: raw.cost };
  if (!pricing) return usage;
  return {
    ...usage,
    cost: usage.promptTokens * pricing.prompt + usage.completionTokens * pricing.completion,
    estimated: true,
  };
}

/**
 * Streams one completion as `ChatEvent`s. Never throws: every failure becomes an `error`
 * event with a message safe to show (a thrown error would reach the Client as a generic
 * `500`). Closing the generator (the Client left) aborts the upstream request.
 */
export async function* complete(history: ChatMessage[]): AsyncGenerator<ChatEvent> {
  const current = settings();
  if (current.error) {
    yield { type: "error", message: current.error };
    return;
  }
  if (!current.key) {
    yield {
      type: "error",
      message: "OPENROUTER_API_KEY is not set on the Server: export it and restart",
    };
    return;
  }
  const upstream = new AbortController();
  try {
    let response: Response;
    try {
      response = await fetch(`${current.baseUrl}/chat/completions`, {
        method: "POST",
        signal: upstream.signal,
        headers: {
          authorization: `Bearer ${current.key}`,
          "content-type": "application/json",
          "x-title": "airtty chat",
        },
        body: JSON.stringify({
          model: current.model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
          stream: true,
          usage: { include: true },
          stream_options: { include_usage: true },
        }),
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      yield {
        type: "error",
        message: clip(`Cannot reach ${new URL(current.baseUrl).host}: ${reason}`),
      };
      return;
    }
    if (!response.ok || !response.body) {
      yield { type: "error", message: await failure(response) };
      return;
    }

    const pricing = (await modelInfo(current))?.pricing;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let started = false;
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      // Everything that arrived in one read leaves as one event of each kind: fewer
      // Flight rows and renders than one per token.
      let text = "",
        reasoning = "";
      const tail: ChatEvent[] = [];
      for (const line of lines) {
        // SSE comments (": OPENROUTER PROCESSING") keep the connection alive.
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          finished = true;
          break;
        }
        let parsed: z.infer<typeof Chunk>;
        try {
          const chunk = Chunk.safeParse(JSON.parse(data));
          if (!chunk.success) continue;
          parsed = chunk.data;
        } catch {
          continue;
        }
        if (!started && parsed.model) {
          started = true;
          tail.push({ type: "start", model: parsed.model, provider: parsed.provider });
        }
        if (parsed.error) {
          tail.push({ type: "error", message: clip(parsed.error.message ?? "Stream failed") });
          finished = true;
          break;
        }
        const choice = parsed.choices?.[0];
        text += choice?.delta?.content ?? "";
        reasoning += choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? "";
        if (parsed.usage) tail.push({ type: "usage", usage: usageOf(parsed.usage, pricing) });
      }
      const start = tail.filter((e) => e.type === "start");
      yield* start;
      if (reasoning) yield { type: "reasoning", text: reasoning };
      if (text) yield { type: "text", text };
      yield* tail.filter((e) => e.type !== "start");
    }
  } finally {
    upstream.abort();
  }
}
