/**
 * Which confinement this system can give a sandboxed Client, found once per launcher
 * (docs/EMBEDDING.md, section 5 and decision 6), strongest first:
 *
 * - `seatbelt` (macOS): sandbox-exec and a generated profile.
 * - `userns` (Linux): luciole-sandbox (native/luciole-sandbox) enters user, network, mount,
 *   PID and IPC namespaces itself, then applies Landlock and seccomp.
 * - `bwrap` (Linux): the system forbids unprivileged namespaces to luciole-sandbox (Ubuntu
 *   >= 23.10, AppArmor) but bubblewrap is allowed: bubblewrap makes the namespaces and
 *   mounts only what is granted, luciole-sandbox applies Landlock (when the kernel has it)
 *   and seccomp inside.
 * - `landlock` (Linux): no namespace at all. Files, execution and signals are confined;
 *   the network is not by host: Landlock filters TCP by port, towards any address.
 *   Never the default: the user chooses it with --sandbox, told exactly that.
 *
 * Anything less is refused with the reason, never simulated.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as z from "zod/mini";

export type LinuxMechanism = {
  kind: "userns" | "bwrap" | "landlock";
  /** The kernel's Landlock ABI; 0 when it has none (bwrap only). */
  landlockAbi: number;
  /** luciole-sandbox, prebuilt for this machine. */
  launcher: string;
  /** bubblewrap, for `bwrap`. */
  bwrap?: string;
};
export type Mechanism = { kind: "seatbelt" } | LinuxMechanism;
export type Availability =
  | {
      mechanism: Mechanism;
      /** Whether it confines the network by host: only then is it the default for a URL. */
      byDefault: boolean;
    }
  | { mechanism: undefined; reason: string };

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/**
 * Landlock ABI scoping signals and abstract sockets (Linux 6.12), with TCP port rules
 * (6.7): without namespaces, what keeps the child from signalling the user's processes.
 */
const ABI_SCOPE = 6;

const Probe = z.object({
  version: z.literal(1),
  landlockAbi: z.number().check(z.int(), z.gte(0)),
  userNamespaces: z.boolean(),
});
const LINUX_ARCH: Partial<Record<string, string>> = { x64: "x64", arm64: "arm64" };
/** Where the prebuilt launcher for this machine lives inside luciole's tree. */
export const launcherPath = (root: string, arch = process.arch) =>
  join(
    root,
    "native",
    "luciole-sandbox",
    "dist",
    `linux-${LINUX_ARCH[arch] ?? arch}`,
    "luciole-sandbox",
  );

function bwrapUsable(bwrap: string) {
  // What the sandbox will ask of it: a user and a network namespace, and a /proc of its own.
  const run = spawnSync(
    bwrap,
    [
      "--unshare-user",
      "--unshare-net",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "true",
    ],
    {
      stdio: "ignore",
      timeout: 5000,
    },
  );
  return run.status === 0;
}

/** Whether `launcher` is listed with its hash in the SHA256SUMS of the dist directory. */
function intact(launcher: string) {
  const dist = dirname(dirname(launcher));
  try {
    const hash = createHash("sha256").update(readFileSync(launcher)).digest("hex");
    const name = `${basename(dirname(launcher))}/${basename(launcher)}`;
    return readFileSync(join(dist, "SHA256SUMS"), "utf8").split("\n").includes(`${hash}  ${name}`);
  } catch {
    return false;
  }
}

const KINDS = ["userns", "bwrap", "landlock"] as const;
/**
 * What this system allows. `root` is luciole's tree (where the launcher is shipped);
 * `LUCIOLE_SANDBOX_LAUNCHER` names another launcher (a local cargo build) and
 * `LUCIOLE_SANDBOX_MECHANISM` asks for a weaker one than the best (tests); neither can ask
 * for one the system does not allow.
 */
export function detectMechanism(root: string, env: NodeJS.ProcessEnv = process.env): Availability {
  if (process.platform === "darwin")
    return existsSync(SANDBOX_EXEC)
      ? { mechanism: { kind: "seatbelt" }, byDefault: true }
      : { mechanism: undefined, reason: `${SANDBOX_EXEC} is missing` };
  if (process.platform !== "linux")
    return { mechanism: undefined, reason: `no sandbox on ${process.platform}` };
  const launcher = env.LUCIOLE_SANDBOX_LAUNCHER || launcherPath(root);
  if (!existsSync(launcher))
    return {
      mechanism: undefined,
      reason: `no luciole-sandbox for linux-${process.arch} (${launcher})`,
    };
  // The shipped one is the one its SHA256SUMS names (scripts/build-sandbox.ts): a damaged
  // or altered launcher would confine nothing it claims to.
  if (!env.LUCIOLE_SANDBOX_LAUNCHER && !intact(launcher))
    return { mechanism: undefined, reason: `${launcher} does not match its SHA256SUMS` };
  const run = spawnSync(launcher, ["--probe"], { encoding: "utf8", timeout: 5000 });
  let printed: unknown;
  try {
    printed = JSON.parse(run.stdout ?? "");
  } catch {
    printed = undefined;
  }
  const probe = Probe.safeParse(printed);
  if (!probe.success)
    return {
      mechanism: undefined,
      reason: `${launcher} --probe failed: ${run.stderr ?? run.error}`,
    };
  const { landlockAbi, userNamespaces } = probe.data;
  const bwrap = Bun.which("bwrap") ?? undefined;
  const allowed: LinuxMechanism[] = [];
  if (userNamespaces && landlockAbi >= 1) allowed.push({ kind: "userns", landlockAbi, launcher });
  if (bwrap && bwrapUsable(bwrap)) allowed.push({ kind: "bwrap", landlockAbi, launcher, bwrap });
  if (landlockAbi >= ABI_SCOPE) allowed.push({ kind: "landlock", landlockAbi, launcher });
  const asked = env.LUCIOLE_SANDBOX_MECHANISM;
  if (asked !== undefined && !KINDS.some((k) => k === asked))
    return {
      mechanism: undefined,
      reason: `LUCIOLE_SANDBOX_MECHANISM=${asked}: one of ${KINDS.join(", ")}`,
    };
  const mechanism = asked ? allowed.find((m) => m.kind === asked) : allowed[0];
  if (!mechanism)
    return {
      mechanism: undefined,
      reason: asked
        ? `${asked} is not available here`
        : `Landlock ABI ${landlockAbi} (${ABI_SCOPE} or more without namespaces), user namespaces ` +
          `${userNamespaces ? "allowed" : "refused"}, ` +
          `bubblewrap ${bwrap ? "refused" : "absent"}`,
    };
  return { mechanism, byDefault: mechanism.kind !== "landlock" };
}

/** Its name on the capabilities screen and the status line. */
export function mechanismName(mechanism: Mechanism) {
  switch (mechanism.kind) {
    case "seatbelt":
      return "Seatbelt";
    case "userns":
      return "Landlock + espaces de noms";
    case "bwrap":
      return mechanism.landlockAbi ? "bubblewrap + Landlock" : "bubblewrap";
    case "landlock":
      return "Landlock seul";
  }
}
