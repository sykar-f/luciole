/**
 * `notes --on [user@]host`: the Server runs on the host, the Client here.
 *
 * 1. One ssh master connection authenticates once; every later command reuses it.
 * 2. The host says its OS and architecture, and whether this build is installed in
 *    `${XDG_DATA_HOME:-~/.local/share}/airtty/apps/<app>/<buildId>/<app>`.
 * 3. If not, this binary is copied there when the platforms match, otherwise the one
 *    given with `--target`; a lock directory lets one of concurrent launches upload
 *    while the others wait for it.
 * 4. `<app> serve --socket` runs there in a fresh private directory, its socket
 *    forwarded to a local one by the same ssh command; it stops when ssh goes away.
 *
 * Remote commands are `sh -c '<script>' airtty <args>`, whose scripts hold neither
 * single quotes nor backslashes: every common login shell, fish included, passes them
 * to sh unchanged. Arguments are app names, build ids and hex: nothing to quote.
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { socketDirectory } from "../connect";
import { readBinaryIdentity, type BinaryIdentity } from "./identity";
import { startServer, type LocalServer } from "./local";
import { checkAppName, type Directories } from "./paths";

// The ssh executable, as git's GIT_SSH: a wrapper, or a test's stand-in.
const sshCommand = (env: NodeJS.ProcessEnv) => env.AIRTTY_SSH || "ssh";
const RANDOM_BYTES = 8;

const INSTALL_DIRECTORY = 'd="${XDG_DATA_HOME:-$HOME/.local/share}/airtty/apps/$1/$2"; b="$d/$1"';

/** Prints what the launcher needs to know of the host. */
const PROBE = `${INSTALL_DIRECTORY}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
if ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"; fi
if [ -x "$b" ]; then echo "installed=1"; fi`;

/**
 * Receives the binary on stdin, unless it is there already. The lock directory holds
 * the uploader's pid: a lock left by a dead one is taken over.
 */
const UPLOAD = `set -e
${INSTALL_DIRECTORY}
mkdir -p "$d"
until [ -x "$b" ] || mkdir "$d.lock" 2>/dev/null; do
  p=$(cat "$d.lock/pid" 2>/dev/null || true)
  if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$d.lock"; else sleep 1; fi
done
if [ -x "$b" ]; then cat >/dev/null; echo present; exit 0; fi
echo $$ > "$d.lock/pid"
t="$d/.$1.$$"
cat > "$t"
if [ "$(wc -c < "$t" | tr -d " ")" != "$3" ]; then rm -f "$t"; rm -rf "$d.lock"; echo truncated; exit 1; fi
chmod 755 "$t"
mv -f "$t" "$b"
rm -rf "$d.lock"
echo installed`;

/** Runs the Server attached to ssh's stdin; its directory goes with it. */
const SERVE = `${INSTALL_DIRECTORY}
s="/tmp/airtty-$3"
mkdir -m 700 "$s" || exit 1
"$b" serve --socket "$s/s" --attached
rm -rf "$s"`;

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
  };
}

export type RunOnOptions = {
  identity: BinaryIdentity;
  /** This binary: copied when the host's platform is its own. */
  self: string;
  /** A binary of the same build for the host's platform, when it differs. */
  target?: string;
  directories: Pick<Directories, "state">;
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
export async function runOn(destination: string, options: RunOnOptions): Promise<LocalServer> {
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
    const { target, installed } = hostTargetOf(probe.stdout);
    if (!installed) {
      const binary = target === identity.target ? options.self : options.target;
      if (!binary)
        throw new Error(
          `${host} is ${target}, this binary ${identity.target}: ` +
            `pass --target <${name} binary built for ${target}>`,
        );
      const theirs = await readBinaryIdentity(binary);
      if (theirs.buildId !== identity.buildId || theirs.name !== name || theirs.target !== target)
        throw new Error(
          `${binary} is ${theirs.name} ${theirs.buildId} for ${theirs.target}; ` +
            `${host} needs ${name} ${identity.buildId} for ${target}`,
        );
      const bytes = await Bun.file(binary).bytes();
      log(`Installing ${name} ${identity.buildId} on ${host} (${target})…`);
      const upload = await sshRun(
        ssh,
        [...command, remote(UPLOAD, name, identity.buildId, String(bytes.byteLength))],
        { env, input: bytes },
      );
      if (upload.code !== 0)
        throw new Error(
          `Installing on ${host} failed: ${upload.stderr.trim() || upload.stdout.trim()}`,
        );
    }
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES))).toString("hex");
    const server = await startServer({
      name,
      log: "remote-server.log",
      directories: options.directories,
      env,
      command: (socket) => [
        ssh,
        ...reuse,
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${socket}:/tmp/airtty-${id}/s`,
        ...to,
        remote(SERVE, name, identity.buildId, id),
      ],
    });
    return {
      url: server.url,
      async stop() {
        await server.stop();
        process.off("exit", closeMaster);
        closeMaster();
      },
    };
  } catch (error: unknown) {
    process.off("exit", closeMaster);
    closeMaster();
    throw error;
  }
}
