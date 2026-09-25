// A local stand-in for OpenRouter's OpenAI-compatible API, to try the chat without a key
// or network, and to test it:
//
//   bun examples/chat/scripts/fake-openrouter.ts            # prints {"port": …}
//   OPENROUTER_API_KEY=sk-or-fake OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1 \
//     bun packages/airtty/src/cli.ts dev --app examples/chat
//
// It streams an echo of the last message in Markdown, a few reasoning chunks first, and
// the usage with its cost last. The key `sk-or-bad` is refused (401); a message containing
// "fail" breaks mid-stream. GET /__stats reports requests, histories and aborted streams.
import { z } from "zod";

// Between two streamed chunks: slow enough to watch, fast enough for tests.
const DEFAULT_DELAY_MS = 35;
const Options = z.object({
  FAKE_PORT: z.coerce.number().int().min(0).default(0),
  FAKE_DELAY_MS: z.coerce.number().int().min(0).default(DEFAULT_DELAY_MS),
});
const options = Options.parse(process.env);
const MODEL = "deepseek/deepseek-v4.1-flash";
const PRICING = { prompt: "0.0000001", completion: "0.0000005" };
const CONTEXT = 1_048_576;
// Rough token count of a text: one per four characters.
const CHARS_PER_TOKEN = 4;
const REASONING_TOKENS = 12;
const HTTP_UNAUTHORIZED = 401,
  HTTP_BAD_REQUEST = 400,
  HTTP_NOT_FOUND = 404;

const Body = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
});
type Turn = { role: string; content: string };
const stats: { requests: number; completed: number; aborted: number; histories: Turn[][] } = {
  requests: 0,
  completed: 0,
  aborted: 0,
  histories: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tokensOf = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
const chunk = (payload: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "gen-fake", provider: "Fake", model: MODEL, ...payload })}\n\n`;
const delta = (content: Record<string, string>) =>
  chunk({ choices: [{ index: 0, delta: content, finish_reason: null }] });

function answer(messages: { role: string; content: string }[]) {
  const last = messages.at(-1)?.content ?? "";
  const turns = messages.filter((m) => m.role !== "system").length;
  return [
    "## Echo",
    "",
    `You said: **${last}**`,
    "",
    `- turns received: ${turns}`,
    `- system prompt: ${messages[0]?.role === "system" ? "yes" : "no"}`,
    "- served by: `fake-openrouter`",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "Done.",
  ].join("\n");
}

function complete(body: z.infer<typeof Body>, signal: AbortSignal) {
  const history = body.messages;
  stats.histories.push(history.filter((m) => m.role !== "system"));
  const text = answer(history);
  const fails = history.at(-1)?.content.includes("fail") ?? false;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      try {
        send(": OPENROUTER PROCESSING\n\n");
        send(delta({ role: "assistant", content: "" }));
        for (const piece of ["Reading ", "the ", "question… "]) {
          await sleep(options.FAKE_DELAY_MS);
          send(delta({ reasoning: piece }));
        }
        const words = text.split(/(?<= )/);
        for (const [i, word] of words.entries()) {
          if (signal.aborted) throw new Error("aborted");
          if (fails && i === Math.floor(words.length / 2)) {
            send(chunk({ error: { code: 502, message: "Upstream provider disconnected" } }));
            controller.close();
            return;
          }
          await sleep(options.FAKE_DELAY_MS);
          send(delta({ content: word }));
        }
        const promptTokens = tokensOf(history.map((m) => m.content).join(" "));
        const completionTokens = tokensOf(text) + REASONING_TOKENS;
        send(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        send(
          chunk({
            choices: [],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
              cost:
                promptTokens * Number(PRICING.prompt) +
                completionTokens * Number(PRICING.completion),
            },
          }),
        );
        send("data: [DONE]\n\n");
        stats.completed++;
        controller.close();
      } catch {
        stats.aborted++;
      }
    },
    cancel() {
      stats.aborted++;
    },
  });
}

const server = Bun.serve({
  port: options.FAKE_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/__stats") return Response.json(stats);
    if (pathname === "/api/v1/models")
      return Response.json({
        data: [
          { id: MODEL, name: "DeepSeek: V4.1 Flash", context_length: CONTEXT, pricing: PRICING },
        ],
      });
    if (pathname !== "/api/v1/chat/completions" || request.method !== "POST")
      return Response.json({ error: { message: "Not found" } }, { status: HTTP_NOT_FOUND });
    stats.requests++;
    const key = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!key || key === "sk-or-bad")
      return Response.json(
        { error: { code: HTTP_UNAUTHORIZED, message: "User not found." } },
        { status: HTTP_UNAUTHORIZED },
      );
    const body = Body.safeParse(await request.json());
    if (!body.success)
      return Response.json({ error: { message: "Invalid body" } }, { status: HTTP_BAD_REQUEST });
    return new Response(complete(body.data, request.signal), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(JSON.stringify({ port: server.port }));
