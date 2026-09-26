/**
 * Records an `opencode serve` exchange for one tiny prompt on the user's real `opencode`
 * (spends a little quota), for coder's opencode adapter contract tests:
 *
 *   bun scripts/coder/record-opencode.ts <scenario> [...]    → tests/fixtures/coder/opencode/<scenario>.jsonl
 *
 * Each line is `{dir: "out", request}`, `{dir: "in", response}` or `{dir: "event", event}`
 * (the server-sent events of the project), in order. Permissions are answered as the
 * scenario says, questions with their first option. Emails, user names, the project and
 * home directories are replaced: fixtures are committed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MODE_RULES } from "../../examples/coder/server/adapters/opencode";
import { parseLine } from "../../examples/coder/server/jsonl";

const MODEL = process.env.CODER_RECORD_MODEL ?? "opencode/mimo-v2.6-flash-free";
type Scenario = {
  prompt: string;
  reply?: "once" | "always" | "reject";
  agent?: string;
  setup?: (cwd: string) => void;
};
// The rules coder's adapter sets in its ask mode.
const ASK = MODE_RULES.ask;
const SCENARIOS: Record<string, Scenario> = {
  "say-ok": { prompt: "Reply with exactly: ok" },
  bash: {
    prompt: "Run `echo coder-fixture` with bash, then reply with one word: done.",
    reply: "once",
  },
  edit: {
    prompt:
      "In greet.txt replace the word hello with world using your edit tool, then reply: done.",
    reply: "once",
    setup: (cwd) => writeFileSync(join(cwd, "greet.txt"), "hello there\n"),
  },
  deny: {
    prompt: "Run `touch denied.txt` with bash, then reply with one word: done.",
    reply: "reject",
  },
  question: {
    prompt:
      "Use your question tool once to ask whether I prefer tabs or spaces (two options), then reply with my answer in one word.",
  },
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
function scrub(value: unknown, cwd: string): unknown {
  // The temporary directory appears as /var/… and /private/var/…, absolute or from the root.
  const bare = cwd.replace(/^\/private/, "");
  if (typeof value === "string")
    return value
      .replaceAll(`/private${bare}`, "/project")
      .replaceAll(`private${bare}`, "project")
      .replaceAll(bare, "/project")
      .replaceAll(bare.slice(1), "project")
      .replaceAll(homedir(), "~")
      .replaceAll(hostname(), "host")
      .replace(EMAIL, "user@example.com");
  if (Array.isArray(value)) return value.map((v) => scrub(v, cwd));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "username" ? "user" : k === "system" ? "(system prompt)" : scrub(v, cwd),
      ]),
    );
  return value;
}
const Event = z.looseObject({ type: z.string(), properties: z.looseObject({}).optional() });
const Asked = z.looseObject({
  id: z.string(),
  questions: z
    .array(z.looseObject({ options: z.array(z.looseObject({ label: z.string() })) }))
    .optional(),
});

async function record(name: string, scenario: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "coder-record-"));
  scenario.setup?.(cwd);
  const lines: string[] = [];
  const log = (entry: Record<string, unknown>) => lines.push(JSON.stringify(scrub(entry, cwd)));
  const password = crypto.randomUUID();
  const server = Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled" }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let url = "";
  const reader = server.stdout.getReader();
  let text = "";
  while (!url) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`opencode exited: ${text}`);
    text += new TextDecoder().decode(chunk.value);
    url = /on\s+(https?:\/\/\S+)/.exec(text)?.[1] ?? "";
  }
  const headers = {
    authorization: `Basic ${btoa(`opencode:${password}`)}`,
    "x-opencode-directory": encodeURIComponent(cwd),
    "content-type": "application/json",
  };
  const call = async (method: string, path: string, body?: unknown) => {
    log({ dir: "out", request: { method, path, ...(body === undefined ? {} : { body }) } });
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    const parsed = raw ? parseLine(raw) : null;
    log({ dir: "in", response: { method, path, status: response.status, body: parsed } });
    return parsed;
  };
  let idle: () => void = () => {};
  const settled = new Promise<void>((resolve) => (idle = resolve));
  let busy = false;
  const events = await fetch(`${url}/event?directory=${encodeURIComponent(cwd)}`, { headers });
  const listening = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of events.body ?? []) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice("data:".length).trim())
          .join("\n");
        if (!data) continue;
        const event = Event.safeParse(parseLine(data));
        if (!event.success) continue;
        // The machine's own setup and the server's housekeeping: not part of a turn.
        if (
          /^(mcp|lsp|file\.watcher|installation|vcs|plugin|catalog|reference|integration)\.|^server\.heartbeat$/.test(
            event.data.type,
          )
        )
          continue;
        log({ dir: "event", event: event.data });
        const props = event.data.properties ?? {};
        if (event.data.type === "session.status") {
          const status = z
            .looseObject({ status: z.looseObject({ type: z.string() }) })
            .safeParse(props);
          if (status.success && status.data.status.type === "busy") busy = true;
          if (status.success && status.data.status.type === "idle" && busy) idle();
        } else if (event.data.type === "permission.asked") {
          const asked = Asked.safeParse(props);
          if (asked.success)
            void call("POST", `/permission/${asked.data.id}/reply`, {
              reply: scenario.reply ?? "once",
            });
        } else if (event.data.type === "question.asked") {
          const asked = Asked.safeParse(props);
          if (asked.success)
            void call("POST", `/question/${asked.data.id}/reply`, {
              answers: (asked.data.questions ?? []).map((q) => [q.options[0]?.label ?? "yes"]),
            });
        }
      }
    }
  })().catch(() => {
    // The server is killed at the end of the recording: its stream breaks.
  });
  await call("GET", "/global/health");
  await call("GET", "/provider/auth");
  const session = z
    .looseObject({ id: z.string() })
    .parse(await call("POST", "/session", { permission: ASK }));
  const [providerID = "", modelID = ""] = MODEL.split(/\/(.*)/);
  await call("POST", `/session/${session.id}/prompt_async`, {
    model: { providerID, modelID },
    agent: scenario.agent ?? "build",
    parts: [{ type: "text", text: scenario.prompt }],
  });
  await settled;
  await call("GET", `/session/${session.id}/message`);
  server.kill();
  await listening;
  const directory = resolve(import.meta.dir, "../../tests/fixtures/coder/opencode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.jsonl`), `${lines.join("\n")}\n`);
  console.log(`${name}: ${lines.length} lines`);
}

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(SCENARIOS)) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}: ${Object.keys(SCENARIOS).join(", ")}`);
  await record(name, scenario);
}
