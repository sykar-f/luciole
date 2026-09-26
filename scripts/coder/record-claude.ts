/**
 * Records what the Agent SDK yields for one tiny prompt on the user's real `claude`
 * (spends a little quota), for coder's Claude adapter contract tests:
 *
 *   bun scripts/coder/record-claude.ts <scenario> [...]    → tests/fixtures/coder/claude/<scenario>.jsonl
 *
 * Each line is `{kind: "init" | "message" | "can_use_tool" | "answer", …}`. Fixtures are
 * committed: they are recorded without the user's settings, hooks or instructions
 * (`settingSources: []`), hook messages are left out, long lists (commands, skills,
 * plugins…) are cut to a few entries, and emails, organisations, the temporary project
 * directory and the home directory are replaced. The SDK runs the user's own binary
 * (pathToClaudeCodeExecutable), never the one it bundles.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

type Scenario = {
  prompt: string;
  mode: "default" | "plan";
  setup?: (cwd: string) => void;
  answer: (tool: string, input: Record<string, unknown>) => PermissionResult;
};
const allow = (_tool: string, input: Record<string, unknown>): PermissionResult => ({
  behavior: "allow",
  updatedInput: input,
});
const SCENARIOS: Record<string, Scenario> = {
  "say-ok": { prompt: "Reply with exactly: ok", mode: "default", answer: allow },
  bash: {
    prompt: "Run `echo coder-fixture` with the Bash tool, then reply with one word: done.",
    mode: "default",
    answer: allow,
  },
  edit: {
    prompt:
      "In greet.txt, replace the word hello with world using the Edit tool. Then reply: done.",
    mode: "default",
    setup: (cwd) => writeFileSync(join(cwd, "greet.txt"), "hello there\n"),
    answer: allow,
  },
  question: {
    prompt:
      "Use the AskUserQuestion tool once to ask whether I prefer tabs or spaces (two options). Then reply with my answer in one word.",
    mode: "default",
    answer: (tool, input) =>
      tool === "AskUserQuestion"
        ? { behavior: "allow", updatedInput: { ...input, answers: answersFor(input, "spaces") } }
        : allow(tool, input),
  },
  plan: {
    prompt:
      "Make a one-step plan to add the line hi to notes.txt, then present it with ExitPlanMode. Do not edit anything.",
    mode: "plan",
    answer: (tool, input) =>
      tool === "ExitPlanMode"
        ? { behavior: "deny", message: "Stop here: this was only a recording.", interrupt: true }
        : allow(tool, input),
  },
};

const Questions = z.object({
  questions: z.array(
    z.object({ question: z.string(), options: z.array(z.object({ label: z.string() })) }),
  ),
});
/** AskUserQuestion's answer: the label `wanted` for every question, when offered. */
function answersFor(input: Record<string, unknown>, wanted: string) {
  const answers: Record<string, string> = {};
  const parsed = Questions.safeParse(input);
  for (const q of parsed.success ? parsed.data.questions : []) {
    const labels = q.options.map((o) => o.label);
    answers[q.question] =
      labels.find((l) => l.toLowerCase().includes(wanted)) ?? labels[0] ?? wanted;
  }
  return answers;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Lists that describe the recording machine rather than the protocol: a few entries show
// their shape.
const SHORTENED = new Set([
  "commands",
  "slash_commands",
  "skills",
  "plugins",
  "agents",
  "mcp_servers",
  "tools",
  "models",
  "available_output_styles",
]);
const KEPT = 3;
const DROPPED = new Set(["memory_paths", "messaging_socket_path", "pid", "user_output_styles_dir"]);
function scrub(value: unknown, cwd: string): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(cwd, "/project")
      .replaceAll(cwd.replace(/^\/private/, ""), "/project")
      .replaceAll(homedir(), "~")
      .replace(EMAIL, "user@example.com");
  if (Array.isArray(value)) return value.map((v) => scrub(v, cwd));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !DROPPED.has(k))
        .map(([k, v]) => [
          k,
          ["orgName", "organization", "orgId", "organizationName"].includes(k)
            ? "Example Org"
            : SHORTENED.has(k) && Array.isArray(v)
              ? scrub(v.slice(0, KEPT), cwd)
              : scrub(v, cwd),
        ]),
    );
  return value;
}

async function record(name: string, scenario: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "coder-record-"));
  scenario.setup?.(cwd);
  const claude = Bun.which("claude");
  if (!claude) throw new Error("claude is not on PATH");
  const lines: string[] = [];
  const log = (line: Record<string, unknown>) => lines.push(JSON.stringify(scrub(line, cwd)));
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => (finished = resolve));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: scenario.prompt },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    };
    await done;
  }
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claude,
      model: "haiku",
      permissionMode: scenario.mode,
      systemPrompt: { type: "preset", preset: "claude_code" },
      // coder itself loads them; a committed fixture must not carry the user's own.
      settingSources: [],
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      env: { ...process.env },
      canUseTool: async (tool, input, options) => {
        log({
          kind: "can_use_tool",
          tool,
          input,
          options: {
            toolUseID: options.toolUseID,
            suggestions: options.suggestions,
            title: options.title,
            displayName: options.displayName,
            description: options.description,
            decisionReason: options.decisionReason,
            blockedPath: options.blockedPath,
          },
        });
        const answer = scenario.answer(tool, input);
        log({ kind: "answer", answer });
        return answer;
      },
    },
  });
  log({ kind: "init", result: await q.initializationResult() });
  try {
    for await (const message of q) {
      const hook = message.type === "system" && message.subtype.startsWith("hook_");
      if (!hook) log({ kind: "message", message });
      if (message.type === "result") finished();
    }
  } catch (error: unknown) {
    // The SDK ends its iterator with an error after an error result: part of the contract.
    log({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
  const directory = resolve(import.meta.dir, "../../tests/fixtures/coder/claude");
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
