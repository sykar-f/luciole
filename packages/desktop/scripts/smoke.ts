/**
 * Checks the stable, packed bundle through its own extraction launcher, with only
 * system tools on PATH and a private HOME. The build artifact stays packed.
 *
 *   bun run smoke [path/to/App.app]      (default: the one .app under build/)
 */
import { access, cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { METADATA, BUNDLED, readMetadata } from "../src/staged";

const STARTUP_MS = 30_000;
const SHUTDOWN_MS = 10_000;
const POLL_MS = 100;

async function builtBundle() {
  const build = resolve(import.meta.dir, "../build");
  const found: string[] = [];
  for (const target of await readdir(build).catch(() => []))
    for (const entry of await readdir(join(build, target)).catch(() => []))
      if (entry.endsWith(".app")) found.push(join(build, target, entry));
  if (found.length !== 1)
    throw new Error(`Expected one .app under ${build}, found ${found.length}: pass its path`);
  return String(found[0]);
}

/** Match executable prefixes, never a shell that merely names the bundle in its args. */
function processes(bundle: string) {
  return Bun.spawnSync(["/bin/ps", "-axwwo", "pid=,ppid=,tpgid=,tty=,args="])
    .stdout.toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match?.[5]?.startsWith(`${bundle}/`)
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              foreground: Number(match[3]),
              tty: String(match[4]),
              args: match[5],
            },
          ]
        : [];
    });
}

function checked(command: string[]) {
  const result = Bun.spawnSync(command);
  if (result.exitCode !== 0)
    throw new Error(`smoke: ${command[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

async function eventually<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeout: number,
) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`smoke: timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

const source = process.argv[2] ? resolve(process.argv[2]) : await builtBundle();
const archives = (await readdir(join(source, "Contents/Resources"))).filter((file) =>
  file.endsWith(".tar.zst"),
);
if (archives.length !== 1)
  throw new Error(
    "smoke: expected a packed stable bundle (one Resources/*.tar.zst); run bun run build",
  );
const scratch = await realpath(await mkdtemp(join(tmpdir(), "luciole-desktop-smoke-")));
// Unix socket paths are limited to 104 bytes on macOS; a long TMPDIR cannot hold them.
const runtime = await realpath(await mkdtemp("/tmp/luciole-smoke-"));
const bundle = join(scratch, basename(source));
const home = join(scratch, "home");
let launcher: ReturnType<typeof Bun.spawn> | undefined;
try {
  await cp(source, bundle, { recursive: true });
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  // Measured with Electrobun 2.0.2: the outer launcher replaces its packed .app
  // in place, retaining the tar under HOME/Library/Application Support/<id>/
  // stable/self-extraction. Never start it on the original build artifact.
  launcher = Bun.spawn([join(contents, "MacOS/launcher")], {
    cwd: join(contents, "MacOS"),
    env: { HOME: home, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtime },
    stdout: Bun.file(join(scratch, "launcher.log")),
    stderr: Bun.file(join(scratch, "launcher-error.log")),
  });
  const metadata = join(resources, "app", BUNDLED, METADATA);
  await eventually(
    "the stable launcher's extraction",
    async () =>
      (await Bun.file(metadata).exists()) &&
      !(await Bun.file(join(resources, String(archives[0]))).exists()),
    STARTUP_MS,
  );
  const { name } = readMetadata(await Bun.file(metadata).text());
  const helper = join(contents, "MacOS/native/luciole-pty");
  if (!(await Bun.file(helper).exists())) throw new Error(`smoke: missing PTY helper ${helper}`);
  checked(["/usr/bin/codesign", "--verify", "--strict", "--all-architectures", helper]);
  await access(helper, constants.X_OK);

  const client = await eventually(
    "the Client's renderer (raw PTY, after SIGHUP handler setup)",
    () => {
      const program = processes(bundle).find(
        (p) => p.args === join(contents, "MacOS", name) && p.tty !== "??",
      );
      if (!program) return undefined;
      const modes = Bun.spawnSync(["/bin/stty", "-a", "-f", `/dev/${program.tty}`]);
      return modes.exitCode === 0 && /(?:^|\s)-icanon(?:\s|$)/.test(modes.stdout.toString())
        ? program
        : undefined;
    },
    STARTUP_MS,
  );
  if (client.foreground !== client.pid)
    throw new Error(
      `smoke: Client ${client.pid} is not its PTY's foreground group: ${client.foreground}`,
    );
  const server = await eventually(
    "the app's Server",
    () => processes(bundle).find((p) => p.args.endsWith(`/${name} serve`)),
    STARTUP_MS,
  );
  const host = processes(bundle).find((p) => p.pid === client.parent && p.args.includes("main.js"));
  if (!host) throw new Error("smoke: no host process");
  const hostRuntime = basename(checked(["/bin/ps", "-o", "comm=", "-p", String(host.pid)]).trim());
  if (hostRuntime !== name)
    throw new Error(`smoke: the host runs on ${hostRuntime}, not on the app binary ${name}`);

  console.log(
    checked(["/bin/ps", "-o", "pid,sess,tpgid,tty,args", "-p", String(client.pid)]).trim(),
  );
  // Target this host's UI process, even if another build of the same app is open.
  checked([
    "/usr/bin/osascript",
    "-e",
    `tell application "System Events"
    tell (first application process whose unix id is ${host.pid})
      set frontmost to true
      keystroke "q" using command down
    end tell
  end tell`,
  ]);
  await eventually(
    "host, Client and Server to quit voluntarily",
    () => processes(bundle).every((p) => p.pid === launcher?.pid),
    SHUTDOWN_MS,
  );
  const log = await Bun.file(join(home, ".local/state/luciole", name, "server.log")).text();
  if (!log.includes("stopping: the last Client left"))
    throw new Error(`smoke: Server did not record a voluntary leave: ${log}`);
  const sessions = await readdir(join(home, ".local/state/luciole", name, "sessions")).catch(
    () => [],
  );
  if (sessions.length)
    throw new Error(`smoke: the session survived the quit: ${sessions.join(", ")}`);
  // Electrobun's initial installer stays alive after the real app quits.
  launcher.kill();
  await launcher.exited;
  await eventually(
    "the extraction bootstrap to end",
    () => processes(bundle).length === 0,
    SHUTDOWN_MS,
  );
  console.log({
    bundle: basename(source),
    layout: "packed stable",
    helper: "signed and executable",
    host: hostRuntime,
    client: client.pid,
    tpgid: client.foreground,
    tty: client.tty,
    server: server.pid,
    ready: "raw PTY",
    quit: "voluntary leave; all processes gone",
  });
} catch (error) {
  const left = processes(bundle).map((p) => `${p.pid} ${p.args.slice(bundle.length)}`);
  throw new Error(`${String(error)}${left.length ? `; still running: ${left.join(", ")}` : ""}`);
} finally {
  for (const { pid } of processes(bundle)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // A process may have exited between ps and kill.
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        console.error("smoke: cleanup kill failed", pid, error);
    }
  }
  if (launcher) await launcher.exited;
  await eventually(
    "cleanup of bundle processes",
    () => processes(bundle).length === 0,
    SHUTDOWN_MS,
  );
  await rm(scratch, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
  console.log("smoke: temporary bundle, extraction, HOME and sockets removed");
}
