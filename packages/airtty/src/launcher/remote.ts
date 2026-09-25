/**
 * `notes --on [user@]host`: the Server runs on the host, the Client here.
 *
 * 1. One ssh master connection authenticates once; every later command reuses it.
 * 2. The host says its OS and architecture, and whether this build is installed in
 *    `${XDG_DATA_HOME:-~/.local/share}/airtty/apps/<app>/<buildId>/<app>`.
 * 3. If not, or if that build no longer matches the SHA256SUMS written at install
 *    (damaged, altered), this binary is sent there (as a tar with its SHA256SUMS,
 *    checked before it replaces anything) when the platforms match, otherwise the one
 *    given with `--target`; a lock directory lets one of concurrent launches upload
 *    while the others wait for it.
 * 4. `<app> serve --socket` runs there in a fresh private directory, its socket
 *    forwarded to a local one by the same ssh command; it stops when ssh goes away.
 *
 * Remote commands are `sh -c '<script>' airtty <args>`, whose scripts hold neither
 * single quotes nor backslashes: every common login shell, fish included, passes them
 * to sh unchanged. Arguments are app names, build ids and hex: nothing to quote.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { socketDirectory } from "../connect";
import { packBundle } from "./bundle";
import { readBinaryIdentity, type BinaryIdentity } from "./identity";
import { parseEnsured } from "./managed";
import { checkAppName } from "./paths";

// The ssh executable, as git's GIT_SSH: a wrapper, or a test's stand-in.
const sshCommand = (env: NodeJS.ProcessEnv) => env.AIRTTY_SSH || "ssh";
const TUNNEL_READY_MS = 60_000;
const POLL_MS = 100;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// ssh itself notices a dead connection: 3 unanswered keepalives, 10 s apart.
const KEEPALIVE = ["-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];

const INSTALL_DIRECTORY = 'd="${XDG_DATA_HOME:-$HOME/.local/share}/airtty/apps/$1/$2"; b="$d/$1"';

// `sha256sum -c` or macOS's `shasum -a 256 -c` on the build directory's SHA256SUMS.
const VERIFIED = `verified() { [ -f "$d/SHA256SUMS" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then c=sha256sum; else c="shasum -a 256"; fi
  (cd "$d" && $c -c SHA256SUMS >/dev/null 2>&1); }`;

/** Prints what the launcher needs to know of the host. */
const PROBE = `${INSTALL_DIRECTORY}
${VERIFIED}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
if ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"; fi
if [ -x "$b" ]; then echo "installed=1"; fi
if verified; then echo "verified=1"; fi`;

/**
 * Receives the build as a tar on stdin, unless an intact one is there already. It is
 * extracted aside, checked against its SHA256SUMS, then swapped in whole: a damaged
 * install is replaced, never patched. The lock directory holds the uploader's pid: a lock
 * left by a dead one is taken over.
 */
const UPLOAD = `set -e
${INSTALL_DIRECTORY}
${VERIFIED}
mkdir -p "$(dirname "$d")"
until verified || mkdir "$d.lock" 2>/dev/null; do
  p=$(cat "$d.lock/pid" 2>/dev/null || true)
  if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$d.lock"; else sleep 1; fi
done
if verified; then cat >/dev/null; echo present; exit 0; fi
echo $$ > "$d.lock/pid"
t="$d.new.$$"
rm -rf "$t"
mkdir -m 700 "$t"
tar xf - -C "$t"
if command -v sha256sum >/dev/null 2>&1; then c=sha256sum; else c="shasum -a 256"; fi
if ! (cd "$t" && $c -c SHA256SUMS >/dev/null 2>&1); then rm -rf "$t" "$d.lock"; echo damaged; exit 1; fi
chmod 755 "$t/$1"
if [ -e "$d" ]; then mv "$d" "$d.old.$$"; fi
mv "$t" "$d"
rm -rf "$d.old.$$" "$d.lock"
echo installed`;

/**
 * Finds or starts the managed Server of this session key there, detached from ssh: it
 * outlives a cut connection, in grace, and prints its socket once it answers.
 */
const SERVE = `${INSTALL_DIRECTORY}
exec "$b" serve --detach --id $3 --grace $4`;

const remote = (script: string, ...args: readonly string[]) =>
  `sh -c '${script}' airtty ${args.join(" ")}`;

const OS = { Darwin: "darwin", Linux: "linux" } as const;
const ARCH = { x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" } as const;
const pick = <T extends Record<string, string>>(table: T, key: string) =>
  Object.entries(table).find(([name]) => name === key)?.[1];

/** The compile target of a host, from what PROBE printed. */
export function hostTargetOf(probe: string) {
  const fields = new Map(
    probe
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
  const os = pick(OS, fields.get("os") ?? ""),
    arch = pick(ARCH, fields.get("arch") ?? "");
  if (!os || !arch)
    throw new Error(`Unsupported host: ${fields.get("os")} ${fields.get("arch")} (no Bun target)`);
  return {
    target: `bun-${os}-${arch}${fields.get("libc") === "musl" ? "-musl" : ""}`,
    installed: fields.get("installed") === "1",
    verified: fields.get("verified") === "1",
  };
}

export type RunOnOptions = {
  identity: BinaryIdentity;
  /** The Server's id there: from the session key (src/launcher/managed.ts). */
  id: string;
  /** How long the Server waits there for a lost Client. */
  graceMs: number;
  /** This binary: copied when the host's platform is its own. */
  self: string;
  /** A binary of the same build for the host's platform, when it differs. */
  target?: string;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

/** `[user@]host[:port]` or `ssh://[user@]host[:port]`, as ssh arguments. */
function destinationOf(destination: string) {
  const url = new URL(destination.startsWith("ssh://") ? destination : `ssh://${destination}`);
  const user = decodeURIComponent(url.username);
  if (!url.hostname || url.pathname.replace(/^\/$/, "") || url.search || url.hash)
    throw new Error(`--on expects [user@]host[:port], not ${destination}`);
  if (url.hostname.startsWith("-") || user.startsWith("-"))
    throw new Error(`--on ${destination}: host and user cannot start with "-"`);
  return {
    host: url.hostname,
    args: [
      ...(url.port ? ["-p", url.port] : []),
      "--",
      user ? `${user}@${url.hostname}` : url.hostname,
    ],
  };
}

function sshRun(
  ssh: string,
  args: readonly string[],
  { env, input }: { env: NodeJS.ProcessEnv; input?: Uint8Array },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * Makes sure the build runs on `destination`, starts its Server there and forwards it:
 * resolves once the Server listens, with the `unix:` URL the Client connects to.
 */
export async function runOn(
  destination: string,
  options: RunOnOptions,
): Promise<{ url: string; stop(): Promise<void> }> {
  const { identity, log, env = process.env } = options;
  const name = checkAppName(identity.name);
  const ssh = sshCommand(env);
  const { host, args: to } = destinationOf(destination);
  const control = socketDirectory("airtty-on-");
  const shared = ["-o", `ControlPath=${join(control, "c")}`];
  const closeMaster = () => {
    spawnSync(ssh, [...shared, "-O", "exit", ...to], { stdio: "ignore", env });
    rmSync(control, { recursive: true, force: true });
  };
  process.on("exit", closeMaster);
  try {
    // Authenticates in the foreground (prompts use the terminal), then stays behind.
    const master = spawnSync(
      ssh,
      [...shared, "-o", "ControlMaster=yes", "-o", "ControlPersist=yes", "-M", "-N", "-f", ...to],
      { stdio: ["inherit", "ignore", "inherit"], env },
    );
    if (master.error) throw master.error;
    if (master.status !== 0) throw new Error(`ssh ${host}: exited with ${master.status}`);
    const reuse = [...shared, "-o", "ControlMaster=no"];
    const command = [...reuse, ...to];
    const probe = await sshRun(ssh, [...command, remote(PROBE, name, identity.buildId)], {
      env,
    });
    if (probe.code !== 0) throw new Error(`ssh ${host}: ${probe.stderr.trim() || probe.code}`);
    const { target, installed, verified } = hostTargetOf(probe.stdout);
    // Installed and intact: used as is. Missing, damaged or altered: (re)installed.
    if (!verified) {
      const binary = target === identity.target ? options.self : options.target;
      if (!binary)
        throw new Error(
          (installed
            ? `${name} ${identity.buildId} on ${host} does not match its SHA256SUMS (damaged or altered): `
            : `${host} is ${target}, this binary ${identity.target}: `) +
            `pass --target <${name} binary built for ${target}>` +
            (installed ? " to reinstall it" : ""),
        );
      const theirs = await readBinaryIdentity(binary);
      if (theirs.buildId !== identity.buildId || theirs.name !== name || theirs.target !== target)
        throw new Error(
          `${binary} is ${theirs.name} ${theirs.buildId} for ${theirs.target}; ` +
            `${host} needs ${name} ${identity.buildId} for ${target}`,
        );
      log(
        installed
          ? `${name} ${identity.buildId} on ${host} does not match its SHA256SUMS: reinstalling…`
          : `Installing ${name} ${identity.buildId} on ${host} (${target})…`,
      );
      const upload = await sshRun(ssh, [...command, remote(UPLOAD, name, identity.buildId)], {
        env,
        input: await packBundle(name, binary, target),
      });
      if (upload.code !== 0)
        throw new Error(
          `Installing on ${host} failed: ${upload.stderr.trim() || upload.stdout.trim()}`,
        );
    }
    const started = await sshRun(
      ssh,
      [...command, remote(SERVE, name, identity.buildId, options.id, String(options.graceMs))],
      { env },
    );
    const server = parseEnsured(started.stdout);
    if (started.code !== 0 || !server)
      throw new Error(
        `Starting ${name} on ${host} failed: ${started.stderr.trim() || started.stdout.trim()}`,
      );
    if (server.reattached) log(`${name} on ${host}: back to its running Server`);
    const tunnel = await superviseTunnel({
      ssh,
      shared,
      to,
      remoteSocket: server.socket,
      env,
    });
    const stop = () => {
      tunnel.stop();
      process.off("exit", stop);
      closeMaster();
    };
    process.off("exit", closeMaster);
    process.on("exit", stop);
    return { url: tunnel.url, stop: async () => stop() };
  } catch (error: unknown) {
    process.off("exit", closeMaster);
    closeMaster();
    throw error;
  }
}

const accepts = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connectSocket({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * `ssh -N -L <local socket>:<remote socket>`, kept up while the Client runs: when it
 * ends (a cut network, a sleeping laptop), it is started again after 1 s, 2 s, 4 s… up to
 * 30 s, on the same local socket, so the Client reaches the same Server again. Later
 * attempts never prompt (BatchMode): a password cannot be typed over the Client's screen.
 */
async function superviseTunnel({
  ssh,
  shared,
  to,
  remoteSocket,
  env,
}: {
  ssh: string;
  shared: readonly string[];
  to: readonly string[];
  remoteSocket: string;
  env: NodeJS.ProcessEnv;
}) {
  const directory = socketDirectory("airtty-tunnel-");
  const local = join(directory, "s");
  let child: ChildProcess | undefined;
  let stopped = false;
  let delay = BACKOFF_FIRST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = (batch: boolean) => {
    const current = spawn(
      ssh,
      [
        ...shared,
        "-o",
        "ControlMaster=no",
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StreamLocalBindUnlink=yes",
        ...KEEPALIVE,
        ...(batch ? ["-o", "BatchMode=yes"] : []),
        "-L",
        `${local}:${remoteSocket}`,
        ...to,
      ],
      { stdio: ["ignore", "ignore", batch ? "ignore" : "inherit"], env },
    );
    child = current;
    current.once("exit", () => {
      if (stopped || child !== current) return;
      timer = setTimeout(() => {
        void (async () => {
          open(true);
          const deadline = performance.now() + delay;
          while (!stopped && child?.exitCode === null && performance.now() < deadline) {
            if (await accepts(local)) {
              delay = BACKOFF_FIRST_MS;
              return;
            }
            await Bun.sleep(POLL_MS);
          }
        })();
      }, delay);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    });
    return current;
  };
  const first = open(false);
  const deadline = performance.now() + TUNNEL_READY_MS;
  while (!(await accepts(local))) {
    if (first.exitCode !== null || first.signalCode !== null || performance.now() > deadline) {
      stopped = true;
      first.kill();
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`ssh: no tunnel to ${remoteSocket}`);
    }
    await Bun.sleep(POLL_MS);
  }
  return {
    url: `unix:${local}`,
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
