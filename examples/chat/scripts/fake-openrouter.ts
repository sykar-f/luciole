// A local stand-in for OpenRouter's OpenAI-compatible API, to try the chat without a key
// or network, and to test it:
//
//   bun examples/chat/scripts/fake-openrouter.ts            # prints {"port": …}
//   OPENROUTER_API_KEY=sk-or-fake OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1 \
//     bun packages/luciole/src/cli.ts dev --app examples/chat
//
// The provider itself is server/fake-provider.ts, which the Server's demo mode also calls
// in-process (CHAT_DEMO=1). GET /__stats reports requests, histories and aborted streams.
import { z } from "zod";
import { createFakeProvider } from "../server/fake-provider";

// Between two streamed chunks: slow enough to watch, fast enough for tests.
const DEFAULT_DELAY_MS = 35;
const Options = z.object({
  FAKE_PORT: z.coerce.number().int().min(0).default(0),
  FAKE_DELAY_MS: z.coerce.number().int().min(0).default(DEFAULT_DELAY_MS),
});
const options = Options.parse(process.env);
const provider = createFakeProvider({
  delayMs: options.FAKE_DELAY_MS,
  servedBy: "`fake-openrouter`",
});

const server = Bun.serve({
  port: options.FAKE_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/__stats"
      ? Response.json(provider.stats)
      : provider.handle(request),
});
console.log(JSON.stringify({ port: server.port }));
