/**
 * Records a `codex app-server` exchange for one tiny prompt on the user's real `codex`
 * (spends a little quota), for coder's Codex adapter contract tests:
 *
 *   bun scripts/coder/record-codex.ts <scenario> [...]    → tests/fixtures/coder/codex/<scenario>.jsonl
 *
 * Each line is `{dir: "out" | "in", message}`: what coder sent, what Codex answered or
 * pushed, in order. Emails, the project and home directories and the user agent are
 * replaced: fixtures are committed. Approvals are accepted, questions answered with their
 * first option.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LineProcess, parseLine } from "../../packages/harness/src/jsonl";

const MODEL = process.env.CODER_RECORD_MODEL ?? "gpt-5.6-luna";
type Scenario = {
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  plan?: boolean;
  setup?: (cwd: string) => void;
};
const SCENARIOS: Record<string, Scenario> = {
  "say-ok": { prompt: "Reply with exactly: ok", sandbox: "workspace-write" },
  command: {
    prompt: "Run `echo coder-fixture` in the shell, then reply with one word: done.",
    sandbox: "workspace-write",
  },
  "approve-command": {
    prompt: "Run `touch made.txt` in the shell (ask for approval if needed), then reply: done.",
    sandbox: "read-only",
  },
  "approve-edit": {
    prompt: "In greet.txt replace hello with world by editing the file, then reply: done.",
    sandbox: "read-only",
    setup: (cwd) => writeFileSync(join(cwd, "greet.txt"), "hello there\n"),
  },
  plan: {
    prompt: "Plan in one step how to add the line hi to notes.txt. Do not edit anything.",
    sandbox: "read-only",
    plan: true,
  },
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Identifiers of the recording machine and account: replaced, the shape kept.
const REDACTED = new Set([
  "installationId",
  "chatgptAccountId",
  "serverName",
  "accountId",
  "workspaceId",
  "userId",
]);
// Notifications about the recording machine's own setup (its MCP servers, its remote
// control, its skills and hooks): left out of fixtures.
export const PRIVATE_METHODS = /^(remoteControl|mcpServer|skills|hook|app)\//;
export function scrub(value: unknown, cwd: string): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(cwd, "/project")
      .replaceAll(cwd.replace(/^\/private/, ""), "/project")
      .replaceAll(homedir(), "~")
      .replaceAll(hostname(), "host")
      .replace(EMAIL, "user@example.com");
  if (Array.isArray(value)) return value.map((v) => scrub(v, cwd));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "workspaceRouting")
        .map(([k, v]) => [
          k,
          // The version stays, the machine's description goes.
          k === "userAgent" && typeof v === "string"
            ? `${v.split(" ")[0]} (recorded)`
            : REDACTED.has(k) && typeof v === "string"
              ? "redacted"
              : scrub(v, cwd),
        ]),
    );
  return value;
}

const Message = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
});
const ThreadStarted = z.object({ thread: z.object({ id: z.string() }) });
const Questions = z.object({
  questions: z.array(
    z.object({ id: z.string(), options: z.array(z.object({ label: z.string() })).nullish() }),
  ),
});

async function record(name: string, scenario: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "coder-record-"));
  scenario.setup?.(cwd);
  const lines: string[] = [];
  const log = (dir: "in" | "out", message: unknown) =>
    lines.push(JSON.stringify(scrub({ dir, message }, cwd)));
  let next = 0;
  const waiting = new Map<string, (result: unknown) => void>();
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => (finished = resolve));
  const codex = new LineProcess(["codex", "app-server"], {
    cwd,
    env: process.env,
    onLine: (line) => {
      const raw = parseLine(line);
      const parsed = Message.safeParse(raw);
      if (!parsed.success) return;
      if (!PRIVATE_METHODS.test(parsed.data.method ?? "")) log("in", raw);
      const m = parsed.data;
      if (m.method !== undefined && m.id !== undefined) {
        // A request from Codex: approvals accepted, questions answered with option one.
        const questions = Questions.safeParse(m.params);
        const result =
          m.method === "item/tool/requestUserInput" && questions.success
            ? {
                answers: Object.fromEntries(
                  questions.data.questions.map((q) => [
                    q.id,
                    { answers: [q.options?.[0]?.label ?? "yes"] },
                  ]),
                ),
              }
            : { decision: "accept" };
        send({ id: m.id, result });
      } else if (m.method === "turn/completed") finished();
      else if (m.id !== undefined) waiting.get(String(m.id))?.(m.result);
    },
  });
  const send = (message: Record<string, unknown>) => {
    log("out", message);
    codex.write(message);
  };
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = ++next;
      waiting.set(String(id), resolve);
      send({ id, method, params });
    });
  await request("initialize", {
    clientInfo: { name: "luciole-coder", title: "coder (luciole)", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  send({ method: "initialized" });
  await request("account/read", { refreshToken: false });
  await request("model/list", { limit: 50 });
  const started = ThreadStarted.parse(
    await request("thread/start", {
      cwd,
      model: MODEL,
      approvalPolicy: "on-request",
      sandbox: scenario.sandbox,
    }),
  );
  await request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: scenario.prompt, text_elements: [] }],
    effort: "low",
    ...(scenario.plan
      ? {
          collaborationMode: {
            mode: "plan",
            settings: { model: MODEL, reasoning_effort: "low", developer_instructions: null },
          },
        }
      : {}),
  });
  await done;
  codex.kill();
  const directory = resolve(import.meta.dir, "../../tests/fixtures/coder/codex");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.jsonl`), `${lines.join("\n")}\n`);
  console.log(`${name}: ${lines.length} lines`);
}

const wanted = import.meta.main ? process.argv.slice(2) : ["--none"];
for (const name of wanted.length ? wanted.filter((w) => w !== "--none") : Object.keys(SCENARIOS)) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario ${name}: ${Object.keys(SCENARIOS).join(", ")}`);
  await record(name, scenario);
}
