/**
 * Chat journey on a real PTY, through `luciole dev`, against a local fake OpenRouter.
 *
 * Journey: missing key message → streamed reply (Markdown, usage, cost) → history sent back
 * → Esc stops a reply and aborts the upstream request → Ctrl+G retries → mid-stream error
 * → Ctrl+N new conversation → Ctrl+Down back → quit. No key and no network needed. Writes
 * examples/chat/pty-frame.txt.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { z } from "zod";
import { ctrl, drive, Keys } from "./driver";
import { BUN, CLI, eventually, example, listening, report, temporaryDirectory } from "./harness";

const APP = example("chat");
const TIMEOUT_MS = 30_000;
const ABORT_TIMEOUT_MS = 5000;

// The journey sets its own key and endpoint: none of the user's reaches the app.
const withoutOpenRouter = Object.fromEntries(
  Object.keys(process.env)
    .filter((name) => name.startsWith("OPENROUTER_"))
    .map((name) => [name, undefined]),
);
const Message = z.object({ role: z.string(), content: z.string() });
const Stats = z
  .object({ requests: z.number(), aborted: z.number(), histories: z.array(z.array(Message)) })
  .loose();

await using fake = await listening([BUN, join(APP, "scripts/fake-openrouter.ts")], {
  ...withoutOpenRouter,
  FAKE_DELAY_MS: "60",
});
const endpoint = `${fake.url}/api/v1`;
const stats = async () => Stats.parse(await (await fetch(`${fake.url}/__stats`)).json());
const lastHistory = async () => (await stats()).histories.at(-1);
using directory = temporaryDirectory("chat-pty-");
const launch = (env: Record<string, string>) =>
  drive({
    command: [BUN, CLI, "dev", "--app", APP],
    cols: 140,
    rows: 40,
    env: { ...withoutOpenRouter, ...env, XDG_STATE_HOME: join(directory.path, "state") },
    settle: 150,
  });
const results: Record<string, unknown> = {};

{
  // 1. No key: a clear message, and Enter sends nothing.
  await using t = await launch({ OPENROUTER_BASE_URL: endpoint });
  await t.waitFor("OPENROUTER_API_KEY is not set on the Server.", { timeout: TIMEOUT_MS });
  await t.waitFor("$0.10/M in · $0.50/M out", { timeout: TIMEOUT_MS });
  await t.type("hi\r");
  await t.waitFor("export it and restart", { timeout: TIMEOUT_MS });
  assert.equal((await stats()).requests, 0, JSON.stringify(await stats()));
  results.missingKeyMessage = true;
  await t.quit();
}

// 2. With a key: the full journey.
await using t = await launch({ OPENROUTER_BASE_URL: endpoint, OPENROUTER_API_KEY: "sk-or-fake" });
const wait = (text: string) => t.waitFor(text, { timeout: TIMEOUT_MS });
/** Until no reply is streaming: the composer is back to its normal title. */
const idle = () => wait("─ message ─");
await wait("Ask anything");
// Ctrl+J adds a line; Enter sends both.
await t.type("hello world\nsecond line");
await wait("second line");
const start = performance.now();
t.write(Keys.enter);
results.firstTokenOnScreenMs = Math.round((await wait("streaming…")) - start);
await wait("Done.");
await idle();
const shown = await t.text();
assert.ok(shown.includes("You said: hello world"), shown); // Markdown bold, markers hidden
assert.ok(!shown.includes("**") && !shown.includes("```"), shown);
assert.ok(
  shown.includes("turns received: 1") && shown.includes("in ·") && shown.includes("out"),
  shown,
);
assert.deepEqual(await lastHistory(), [{ role: "user", content: "hello world\nsecond line" }]);
results.streamedMarkdownReply = true;

await t.type("again\r");
await wait("turns received: 3");
await idle();
assert.deepEqual(
  (await lastHistory())?.map((message) => message.role),
  ["user", "assistant", "user"],
);
results.historySent = true;

// Esc stops a reply: partial text stays, the upstream stream is aborted.
const { aborted } = await stats();
t.write("stop me\r");
await wait("streaming…");
await t.escape();
await wait("stopped · Ctrl+G retry");
assert.ok(
  await eventually(async () => (await stats()).aborted !== aborted, ABORT_TIMEOUT_MS),
  JSON.stringify(await stats()),
);
results.escAbortsUpstream = true;
await t.type(ctrl("g"));
await wait("You said: stop me");
await wait("turns received: 5");
await idle();
results.retry = true;

await t.type("please fail\r");
await wait("✗ Upstream provider disconnected");
results.midStreamError = true;

await t.type(ctrl("n"));
await wait("Ask anything");
await wait("New conversation");
await t.type(Keys.ctrlDown); // the older conversation
await wait("You said: please fail");
results.conversations = true;
await Bun.write(join(APP, "pty-frame.txt"), await t.snapshot());
await t.quit();
results.terminalRestored = true;
report(results);
