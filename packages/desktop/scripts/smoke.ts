/**
 * Opens the built bundle as a user's Mac would, and checks the whole chain:
 *
 *   bun run smoke [path/to/App.app]      (default: the one .app under build/)
 *
 * The launcher starts with nothing but the system on its PATH (no Bun, no Nix) and a
 * throwaway HOME. Passes when the host runs on the app binary (single runtime), the view
 * has opened the app on its PTY (the app's managed Server is up), and ending the host
 * ends everything: the app quits as from a closed window, session included.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { METADATA, BUNDLED, readMetadata } from "../src/staged";

const STARTUP_MS = 20_000;
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

/**
 * The processes running an executable of this bundle: pid and command line. Matched on
 * the command's start, not anywhere in it: a shell that merely names the bundle is not
 * one of them, and must never be killed.
 */
function processes(bundle: string) {
  const ps = Bun.spawnSync(["ps", "-axwwo", "pid=,args="]).stdout.toString();
  return ps
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && match[2]?.startsWith(`${bundle}/`))
    .map((match) => ({ pid: Number(match?.[1]), args: String(match?.[2]) }));
}
/** The executable a process runs, whatever its arguments say (the host's is a script). */
const executableOf = (pid: number) =>
  Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)])
    .stdout.toString()
    .trim();

async function eventually<T>(what: string, check: () => T | undefined | false, timeout: number) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`smoke: timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

const bundle = process.argv[2] ? resolve(process.argv[2]) : await builtBundle();
const contents = join(bundle, "Contents");
const { name } = readMetadata(
  await Bun.file(join(contents, "Resources", "app", BUNDLED, METADATA)).text(),
);
const home = await mkdtemp(join(tmpdir(), "luciole-desktop-smoke-"));
const launcher = Bun.spawn([join(contents, "MacOS", "launcher")], {
  cwd: join(contents, "MacOS"),
  env: { HOME: home, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "ignore",
});
try {
  const server = await eventually(
    "the app's Server",
    () => processes(bundle).find((p) => p.args.endsWith(`/${name} serve`)),
    STARTUP_MS,
  );
  const host = processes(bundle).find((p) => p.args.includes("main.js"));
  if (!host) throw new Error("smoke: no host process");
  const runtime = basename(executableOf(host.pid));
  if (runtime !== name)
    throw new Error(`smoke: the host runs on ${runtime}, not on the app binary ${name}`);

  // The host's end closes the PTY: the app hangs up and quits, as from a closed window.
  process.kill(host.pid, "SIGTERM");
  await eventually("every process to end", () => processes(bundle).length === 0, SHUTDOWN_MS).catch(
    (error: unknown) => {
      const left = processes(bundle).map((p) => `${p.pid} ${p.args.slice(bundle.length)}`);
      throw new Error(`${String(error)}; still running: ${left.join(", ")}`);
    },
  );
  const sessions = await readdir(join(home, ".local/state/luciole", name, "sessions")).catch(
    () => [],
  );
  if (sessions.length)
    throw new Error(`smoke: the session survived the quit: ${sessions.join(", ")}`);
  console.log({ bundle: basename(bundle), host: runtime, server: server.pid, quit: "clean" });
} finally {
  for (const { pid } of processes(bundle)) process.kill(pid, "SIGKILL");
  launcher.kill();
  await rm(home, { recursive: true, force: true });
}
