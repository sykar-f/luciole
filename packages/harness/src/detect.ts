import { HARNESS_NAMES, type HarnessId } from "./model";
import { AuthStatus } from "./adapters/claude-protocol";
import type { HarnessStatus } from "./adapters/types";
import { parseLine } from "./jsonl";
import { probe } from "./probe";
import { opencodeAnthropicOAuth, piAnthropicOAuth } from "./anthropic-guard";

/**
 * Whether each harness can run here, found without asking a model anything: its binary,
 * its version, whether it is signed in. Never a token: only what the harness itself
 * prints about its login (docs/CODER-HANDOFF.md §3).
 */

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

async function claude(env: NodeJS.ProcessEnv): Promise<HarnessStatus> {
  const id = "claude";
  const binary = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (!binary)
    return {
      id,
      installed: false,
      ready: false,
      fix: "install Claude Code: https://code.claude.com",
      warnings: [],
    };
  const [version, auth] = await Promise.all([
    probe([binary, "--version"], env),
    // JSON by default; exit 0 signed in, 1 not. Says how, and who: never a token.
    probe([binary, "auth", "status"], env),
  ]);
  const status = AuthStatus.safeParse(parseLine(auth?.stdout.trim() ?? ""));
  const loggedIn = status.success && status.data.loggedIn;
  const warnings: string[] = [];
  // In SDK mode an API key in the environment wins over the subscription login.
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter((name) => env[name]);
  if (keys.length && status.success && status.data.authMethod === "claude.ai")
    warnings.push(
      `${keys.join(" and ")} is set: Claude Code bills it instead of your subscription`,
    );
  return {
    id,
    installed: true,
    version: firstLine(version?.stdout ?? "").replace(/\s*\(Claude Code\)$/, "") || undefined,
    ready: loggedIn,
    account: status.success
      ? [status.data.email, status.data.subscriptionType].filter(Boolean).join(" · ") ||
        status.data.authMethod
      : undefined,
    fix: loggedIn ? undefined : "run `claude auth login` in a terminal",
    warnings,
  };
}

async function codex(env: NodeJS.ProcessEnv): Promise<HarnessStatus> {
  const id = "codex";
  const binary = Bun.which("codex", { PATH: env.PATH ?? "" });
  if (!binary)
    return {
      id,
      installed: false,
      ready: false,
      fix: "install Codex: https://developers.openai.com/codex",
      warnings: [],
    };
  const [version, login] = await Promise.all([
    probe([binary, "--version"], env),
    // Exits 0 when signed in and says how ("Logged in using ChatGPT"): no secret.
    probe([binary, "login", "status"], env),
  ]);
  const ready = login?.code === 0;
  return {
    id,
    installed: true,
    version: firstLine(version?.stdout ?? "").replace(/^codex-cli\s+/, "") || undefined,
    ready,
    account: ready
      ? firstLine(login.stdout).replace(/^Logged in using\s+/i, "") || undefined
      : undefined,
    fix: ready ? undefined : "run `codex login` in a terminal",
    warnings: [],
  };
}

async function pi(env: NodeJS.ProcessEnv): Promise<HarnessStatus> {
  const id = "pi";
  const binary = Bun.which("pi", { PATH: env.PATH ?? "" });
  if (!binary)
    return { id, installed: false, ready: false, fix: "install pi: https://pi.dev", warnings: [] };
  const [version, models, oauth] = await Promise.all([
    probe([binary, "--version"], env),
    // Only models whose provider can be used: a table, one model per line after the head.
    probe([binary, "--offline", "--list-models"], env),
    piAnthropicOAuth(env, binary),
  ]);
  const usable = models?.code === 0 ? models.stdout.trim().split("\n").length - 1 : 0;
  return {
    id,
    installed: true,
    version: firstLine(version?.stdout ?? "") || undefined,
    ready: usable > 0,
    account: usable > 0 ? `${usable} models` : undefined,
    fix:
      usable > 0 ? undefined : "sign in to a provider: run `pi`, then /login (or set an API key)",
    warnings: oauth.length ? [`Anthropic models are blocked in pi: ${oauth[0]}`] : [],
  };
}

// `opencode auth list` marks each credential, stored or from the environment, with ●.
const CREDENTIAL = /^\s*●/;

async function opencode(env: NodeJS.ProcessEnv): Promise<HarnessStatus> {
  const id = "opencode";
  const binary = Bun.which("opencode", { PATH: env.PATH ?? "" });
  if (!binary)
    return {
      id,
      installed: false,
      ready: false,
      fix: "install opencode: https://opencode.ai",
      warnings: [],
    };
  const [version, credentials, oauth] = await Promise.all([
    probe([binary, "--version"], env),
    // Provider names and how each is signed in ("api", "oauth", a variable's name): no secret.
    probe([binary, "auth", "list"], env),
    opencodeAnthropicOAuth(env),
  ]);
  const signed =
    credentials?.code === 0
      ? Bun.stripANSI(credentials.stdout)
          .split("\n")
          .filter((line) => CREDENTIAL.test(line)).length
      : 0;
  return {
    id,
    installed: true,
    version: firstLine(version?.stdout ?? "") || undefined,
    ready: signed > 0,
    account: signed > 0 ? `${signed} providers` : undefined,
    fix: signed > 0 ? undefined : "run `opencode auth login` in a terminal (or set an API key)",
    warnings: oauth.length ? [`Anthropic models are blocked in opencode: ${oauth[0]}`] : [],
  };
}

/** Whether `id` can run with this environment. */
export async function detect(
  id: HarnessId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessStatus> {
  switch (id) {
    case "fake":
      return {
        id,
        installed: true,
        ready: true,
        version: "demo",
        account: "demo@example.com",
        warnings: [],
      };
    case "claude":
      return claude(env);
    case "codex":
      return codex(env);
    case "pi":
      return pi(env);
    case "opencode":
      return opencode(env);
  }
}

// Without --harness: the first ready one, in this order (spec §3).
const AUTO_ORDER: readonly HarnessId[] = ["claude", "codex", "opencode", "pi"];

/** The harness of this session: the one asked for, or the first ready one. */
export async function pickHarness(
  wanted: HarnessId | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessStatus> {
  if (wanted) return detect(wanted, env);
  const found = await Promise.all(AUTO_ORDER.map((id) => detect(id, env)));
  const ready = found.find((status) => status.ready);
  if (ready) return ready;
  throw new Error(
    "No harness is ready: " +
      found
        .map(
          (s) =>
            `${HARNESS_NAMES[s.id]}: ${s.installed ? (s.fix ?? "not signed in") : "not installed"}`,
        )
        .join("; ") +
      ". Try --harness fake for a scripted demo.",
  );
}
