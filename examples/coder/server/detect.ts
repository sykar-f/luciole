import { HARNESS_NAMES, type HarnessId } from "../components/model";
import { AuthStatus } from "./adapters/claude-protocol";
import type { HarnessStatus } from "./adapters/types";
import { parseLine } from "./jsonl";

/**
 * Whether each harness can run here, found without asking a model anything: its binary,
 * its version, whether it is signed in. Never a token: only what the harness itself
 * prints about its login (docs/CODER-HANDOFF.md §3).
 */

// A harness that does not answer `--version` in this time is reported, not awaited.
const PROBE_TIMEOUT_MS = 10_000;

/** Runs a harness's own command; its output, or `undefined` when it failed or hung. */
export async function probe(argv: readonly string[], env: NodeJS.ProcessEnv) {
  try {
    const child = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    return { stdout, code };
  } catch {
    return undefined;
  }
}
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
    case "pi":
    case "opencode":
      return {
        id,
        installed: Bun.which(id, { PATH: env.PATH ?? "" }) !== null,
        ready: false,
        fix: `${HARNESS_NAMES[id]} is not supported by this build of coder yet`,
        warnings: [],
      };
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
