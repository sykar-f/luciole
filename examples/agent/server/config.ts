import "server-only";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * GPT-5.6 Terra through the ChatGPT subscription (`openai-codex`). Of the three variants,
 * Sol is the largest and slowest, Luna the smallest; Terra sits between them (its API
 * price is half of Sol's, ten times Luna's) and follows multi-step tool use reliably,
 * which is what a coding agent does all day. `low` thinking keeps short turns quick.
 */
const DEFAULT_MODEL = "openai-codex/gpt-5.6-terra";
const DEFAULT_THINKING = "low";

const Env = z.object({
  AGENT_MODEL: z.string().min(1).default(DEFAULT_MODEL),
  AGENT_THINKING: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .default(DEFAULT_THINKING),
  AGENT_CWD: z.string().min(1).optional(),
  AGENT_PI: z.string().min(1).default("pi"),
  XDG_STATE_HOME: z.string().min(1).optional(),
});

function load() {
  const env = Env.safeParse(process.env);
  if (!env.success) {
    const issue = env.error.issues[0];
    throw new Error(`Invalid ${issue?.path.join(".") ?? "environment"}: ${issue?.message}`);
  }
  // A stable sandbox rather than a fresh temporary directory: pi keys its sessions by
  // working directory, so the conversation survives the rebuilds of `airtty dev`.
  const cwd = resolve(env.data.AGENT_CWD ?? join(tmpdir(), "airtty-agent-sandbox"));
  mkdirSync(cwd, { recursive: true });
  const state = env.data.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const sessionDir = join(state, "airtty", "agent", "pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  return {
    model: env.data.AGENT_MODEL,
    thinking: env.data.AGENT_THINKING,
    cwd,
    sessionDir,
    pi: env.data.AGENT_PI,
  };
}

export const config = load();
