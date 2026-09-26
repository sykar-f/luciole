import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { probe } from "./probe";
import { parseLine } from "./jsonl";

/**
 * Anthropic forbids its subscription login (OAuth) outside its own applications
 * (docs/CODER-HANDOFF.md §3.5): pi and opencode can use it, coder must not let them.
 * Claude stays available there through an API key, Bedrock, Vertex, Copilot…; a Claude
 * subscription goes through `--harness claude`.
 *
 * Nothing here reads a secret: the environment's variables are tested for presence or a
 * prefix; files are asked about through `jq`, which prints only an entry's type or
 * whether a value starts with the OAuth prefix, never the value.
 */
export const OAUTH_PREFIX = "sk-ant-oat";
export const USE_CLAUDE = "Claude subscriptions are not allowed here: use --harness claude";
const OAUTH_VARIABLES = ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

/** Why the environment carries an Anthropic OAuth token, if it does (names only). */
export function oauthInEnvironment(env: NodeJS.ProcessEnv) {
  const named = OAUTH_VARIABLES.filter((name) => env[name]);
  if (env.ANTHROPIC_API_KEY?.startsWith(OAUTH_PREFIX))
    named.push("ANTHROPIC_API_KEY (an OAuth token)");
  return named;
}

/** The environment for pi or opencode: Anthropic OAuth tokens removed. */
export function withoutOAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of OAUTH_VARIABLES) delete clean[name];
  if (clean.ANTHROPIC_API_KEY?.startsWith(OAUTH_PREFIX)) delete clean.ANTHROPIC_API_KEY;
  return clean;
}

/**
 * `jq` on a credentials file, printing a type or a boolean computed inside jq: the
 * value never leaves it. `undefined` when jq or the file is missing.
 */
async function ask(file: string, filter: string, env: NodeJS.ProcessEnv) {
  const jq = Bun.which("jq", { PATH: env.PATH ?? "" });
  if (!jq || !(await Bun.file(file).exists())) return undefined;
  const answer = await probe([jq, "-r", filter, file], env);
  return answer?.code === 0 ? answer.stdout.trim() : undefined;
}
const TYPE = ".anthropic.type // empty";
const OAUTH_VALUE = `[.anthropic.key, .anthropic.access, .anthropic.apiKey] | map(select(type == "string" and startswith("${OAUTH_PREFIX}"))) | length > 0`;
const OAUTH_IN_MODELS = `(.providers.anthropic.apiKey // "") | startswith("${OAUTH_PREFIX}")`;

const PiAuthCheck = z.looseObject({ status: z.string(), authType: z.string().optional() });
const piDirectory = (env: NodeJS.ProcessEnv) =>
  env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent");

/** Every sign that pi would use an Anthropic subscription; empty when there is none. */
export async function piAnthropicOAuth(env: NodeJS.ProcessEnv, pi: string) {
  const reasons = oauthInEnvironment(env).map((name) => `${name} is set`);
  // pi's own answer: `authType` says oauth for a /login; a token passed by the
  // environment reads as api_key, hence the checks above.
  const checked = await probe(
    [pi, "auth", "check", "--provider", "anthropic", "--json", "--no-refresh"],
    env,
  );
  const status = PiAuthCheck.safeParse(parseLine(checked?.stdout.trim() ?? ""));
  if (status.success && status.data.authType === "oauth")
    reasons.push("pi is signed in to Anthropic with OAuth");
  const directory = piDirectory(env);
  if ((await ask(join(directory, "auth.json"), TYPE, env)) === "oauth")
    reasons.push("pi's auth.json holds an Anthropic OAuth login");
  if ((await ask(join(directory, "auth.json"), OAUTH_VALUE, env)) === "true")
    reasons.push("pi's auth.json holds an Anthropic OAuth token");
  if ((await ask(join(directory, "models.json"), OAUTH_IN_MODELS, env)) === "true")
    reasons.push("pi's models.json holds an Anthropic OAuth token");
  return reasons;
}

/** Whether a model belongs to Anthropic's own API (Claude through Bedrock, Vertex… is fine). */
export const isAnthropic = (provider: string) => provider === "anthropic";
