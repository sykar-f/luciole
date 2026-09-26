/**
 * Records a `pi --mode rpc` exchange for one tiny prompt on the user's real `pi`, with
 * coder's approval gate loaded (spends a little quota), for the pi adapter's contract
 * tests:
 *
 *   bun scripts/coder/record-pi.ts <scenario> [...]    → tests/fixtures/coder/pi/<scenario>.jsonl
 *
 * Each line is `{dir: "out" | "in", message}`. Sessions go to a temporary directory, not
 * the user's; emails and the project and home directories are replaced.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LineProcess, parseLine } from "../../examples/coder/server/jsonl";
import { ALLOW_ONCE, DENY, GATE_TITLE, gateFile } from "../../examples/coder/server/pi-gate";

const MODEL = process.env.CODER_RECORD_MODEL ?? "openai-codex/gpt-5.6-luna";
type Scenario = { prompt: string; answer?: string; setup?: (cwd: string) => void; before?: string };
const SCENARIOS: Record<string, Scenario> = {
  "say-ok": { prompt: "Reply with exactly: ok", before: "/coder-mode ask" },
  bash: {
    prompt: "Run `echo coder-fixture` with bash, then reply with one word: done.",
    answer: ALLOW_ONCE,
  },
  edit: {
    prompt: "In greet.txt replace the word hello with world using the edit tool, then reply: done.",
    answer: ALLOW_ONCE,
    setup: (cwd) => writeFileSync(join(cwd, "greet.txt"), "hello there\n"),
  },
  deny: {
    prompt: "Run `touch denied.txt` with bash, then reply with one word: done.",
    answer: DENY,
  },
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TEMPORARY = tmpdir().replace(/\/$/, "");
/** Whether a recorded line would carry pi's system prompt: it holds the user's context files. */
export const systemPrompt = (message: unknown) =>
  z.looseObject({ message: z.looseObject({ role: z.literal("system") }) }).safeParse(message)
    .success;
export function scrub(value: unknown, cwd: string): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(cwd, "/project")
      .replaceAll(cwd.replace(/^\/private/, ""), "/project")
      .replaceAll(TEMPORARY, "/tmp")
      .replaceAll(homedir(), "~")
      .replaceAll(hostname(), "host")
      .replace(EMAIL, "user@example.com");
  if (Array.isArray(value)) return value.map((v) => scrub(v, cwd));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        // The whole conversation again, the system prompt first: not needed, left out.
        k === "messages" && Array.isArray(v) ? [] : scrub(v, cwd),
      ]),
    );
  return value;
}
const Line = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  method: z.string().optional(),
  title: z.string().optional(),
});

async function record(name: string, scenario: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "coder-record-"));
  const sessions = mkdtempSync(join(tmpdir(), "coder-record-sessions-"));
  scenario.setup?.(cwd);
  const lines: string[] = [];
  const log = (dir: "in" | "out", message: unknown) =>
    lines.push(JSON.stringify(scrub({ dir, message }, cwd)));
  const waiting = new Map<string, (value: unknown) => void>();
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => (finished = resolve));
  let prompted = false;
  const env = { ...process.env };
  // Never an Anthropic subscription token in pi (docs/CODER-HANDOFF.md §3.5).
  delete env.ANTHROPIC_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const pi = new LineProcess(
    [
      "pi",
      "--mode",
      "rpc",
      "--session-dir",
      sessions,
      "--session-id",
      crypto.randomUUID(),
      "--no-approve",
      "--model",
      MODEL,
      "--thinking",
      "low",
      "-e",
      gateFile(),
      "--coder-mode",
      "ask",
    ],
    {
      cwd,
      env,
      onLine: (text) => {
        const raw = parseLine(text);
        const line = Line.safeParse(raw);
        if (!line.success) return;
        if (!systemPrompt(raw)) log("in", raw);
        const m = line.data;
        if (m.type === "response" && m.id) waiting.get(m.id)?.(raw);
        else if (m.type === "extension_ui_request" && m.id && m.method === "select") {
          const answer = m.title?.startsWith(GATE_TITLE) ? scenario.answer : undefined;
          send(
            answer
              ? { type: "extension_ui_response", id: m.id, value: answer }
              : { type: "extension_ui_response", id: m.id, cancelled: true },
          );
        } else if (m.type === "agent_settled" && prompted) finished();
      },
    },
  );
  let next = 0;
  const send = (message: Record<string, unknown>) => {
    log("out", message);
    pi.write(message);
  };
  const command = (message: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      const id = `c${++next}`;
      waiting.set(id, resolve);
      send({ ...message, id });
    });
  await command({ type: "get_state" });
  await command({ type: "get_commands" });
  if (scenario.before) await command({ type: "prompt", message: scenario.before });
  prompted = true;
  await command({ type: "prompt", message: scenario.prompt });
  await done;
  await command({ type: "get_session_stats" });
  pi.kill();
  const directory = resolve(import.meta.dir, "../../tests/fixtures/coder/pi");
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
