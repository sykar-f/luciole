import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { serverStatus } from "../packages/luciole/src/launcher/managed";
import { leaveCrashedSession } from "./helpers";

const cli = resolve("packages/luciole/src/cli.ts");

// macOS and util-linux spell script(1) differently; see tests/compile.test.ts.
const inPty = (log: string, command: string) => {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q ${log} ${command}`
      : `script -q -e -f -c '${command}' ${log}`;
  return ["/bin/sh", "-c", `(while [ ! -f stop ]; do sleep 0.1; done; printf '\\003') | ${script}`];
};

test("`luciole ./app` builds it, runs its Server on a socket and its Client here", async () => {
  const temporary = await mkdtemp("/tmp/luciole-t-");
  const run = await mkdtemp(join(tmpdir(), "luciole-launch-"));
  try {
    // A Client of this app crashed on a note: the new launch, on another socket, reopens it.
    await leaveCrashedSession(
      join(run, "state"),
      "notes",
      `local:${resolve("examples/notes")}`,
      "/notes/1",
    );
    const log = join(run, "screen.log");
    const child = Bun.spawn(inPty(log, `${process.execPath} ${cli} ${resolve("examples/notes")}`), {
      cwd: run,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        TMPDIR: temporary,
        XDG_RUNTIME_DIR: temporary,
        XDG_STATE_HOME: join(run, "state"),
        NOTES_DB: join(run, "notes.sqlite"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    // Includes building Notes: a loaded machine (a full `verify`) can take a while.
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline && !screen.includes("✎ Edit")) {
      await Bun.sleep(100);
      screen = Bun.stripANSI(await readFile(log, "utf8").catch(() => ""));
    }
    const sockets = () =>
      readdirSync(join(temporary, "luciole")).filter((entry) => entry.endsWith(".sock"));
    expect(sockets()).toHaveLength(1);
    await Bun.write(join(run, "stop"), "");
    await Promise.race([child.exited, Bun.sleep(5000).then(() => child.kill())]);
    expect(screen).toContain("✎ Edit");
    expect(existsSync(join(run, "state/luciole/notes/server.log"))).toBe(true);
    const gone = performance.now() + 3000;
    while (sockets().length && performance.now() < gone) await Bun.sleep(50);
    expect(sockets()).toEqual([]);
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, 120000);

test("a launcher killed with SIGKILL leaves its Server in grace, or stops it with no grace", async () => {
  const work = await mkdtemp(join(tmpdir(), "luciole-kill-"));
  const runtime = await mkdtemp("/tmp/luciole-rt-");
  // A launcher holding its Server's stdin, as `luciole ./app` and app binaries do.
  const launcher = async (graceMs: number) => {
    const script = join(work, `launcher-${graceMs}.ts`);
    await Bun.write(
      script,
      `import { ensureServer, serverId } from ${JSON.stringify(resolve("packages/luciole/src/launcher/managed.ts"))};
const server = await ensureServer({
  id: serverId("local:kill-${graceMs}"),
  name: "kill",
  buildId: "build-1",
  command: [process.execPath, "--conditions=react-server", ${JSON.stringify(resolve("tests/lifetime-server.ts"))}],
  graceMs: ${graceMs},
  directories: { state: ${JSON.stringify(join(work, "state"))} },
  client: "crashing",
  attach: true,
});
console.log(JSON.stringify({ socket: server.socket, pid: server.pid }));
setInterval(() => {}, 1000);`,
    );
    const child = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, XDG_RUNTIME_DIR: runtime },
    });
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The launcher exited");
      line += new TextDecoder().decode(value);
    }
    const started = z.object({ socket: z.string(), pid: z.number() }).parse(JSON.parse(line));
    child.kill("SIGKILL");
    await child.exited;
    return started;
  };
  try {
    const kept = await launcher(60_000);
    const inGrace = async () => {
      const status = await serverStatus(kept.socket);
      return status?.pid === kept.pid && status.graceUntil !== undefined;
    };
    const deadline = performance.now() + 5000;
    while (!(await inGrace()) && performance.now() < deadline) await Bun.sleep(50);
    expect(await inGrace()).toBe(true);
    await fetch("http://localhost/lifetime/stop", { method: "POST", unix: kept.socket });
    const stopped = await launcher(0);
    const gone = performance.now() + 5000;
    while (existsSync(stopped.socket) && performance.now() < gone) await Bun.sleep(50);
    expect(existsSync(stopped.socket)).toBe(false);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});

test("the CLI explains what it cannot launch", () => {
  const luciole = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, cli, ...args]);
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  // Refused before the Server is contacted: what a URL takes is said.
  expect(luciole("https://notes.example.com", "--nope")).toMatchObject({ code: 1 });
  expect(luciole("https://notes.example.com", "--nope").stderr).toContain("--inline or --sandbox");
  expect(luciole("./no-such-app").stderr).toContain("is not a luciole app");
  expect(luciole("examples/notes").stderr).toContain("start it with ./");
  expect(luciole("--nope").stderr).toContain("Usage: luciole");
  expect(luciole("./examples/notes", "--on", "host").stderr).toContain("luciole build --compile");
});
