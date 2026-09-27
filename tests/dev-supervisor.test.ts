/**
 * `airtty dev` as a program on a PTY, the way a host embeds it (a multiplexer's
 * `<Terminal>`, studio's preview): what it leaves behind when the terminal goes away, and
 * the pieces of supervision it shares with other hosts (src/dev/supervisor.ts).
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/airtty/src/build";
import {
  ClientFailure,
  linkFrameworkModules,
  serialize,
  startAppServer,
} from "../packages/airtty/src/dev/supervisor";
import { messageOf } from "../packages/airtty/src/guards";
import { spawnPty, type Pty } from "../packages/airtty/src/vt/pty";
import { rejectionOf, until } from "./helpers";

const CLI = resolve("packages/airtty/src/cli.ts");
const STARTUP_MS = 15_000;
const EXIT_MS = 5000;
const COLUMNS = 80;
const ROWS = 24;

async function app(page: string) {
  const dir = await mkdtemp(join(tmpdir(), "airtty-dev-supervisor-"));
  for (const [name, text] of Object.entries({
    "app/layout.tsx": `"use client";\nexport default function Layout({ children }) {\n  return children;\n}\n`,
    "app/page.tsx": page,
  })) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await Bun.write(join(dir, name), text);
  }
  return dir;
}
/** `airtty dev --app dir` on a PTY, what it wrote, how it ended. */
function dev(dir: string) {
  let screen = "";
  const ended: (number | null)[] = [];
  const pty: Pty = spawnPty({
    command: [process.execPath, CLI, "dev", "--app", dir],
    cols: COLUMNS,
    rows: ROWS,
    onData: (bytes) => (screen += new TextDecoder().decode(bytes)),
    onExit: (code) => ended.push(code),
  });
  return { pty, screen: () => screen, ended };
}
const childrenOf = (pid: number) =>
  spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .stdout.split(/\s+/)
    .filter(Boolean)
    .map(Number);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a hangup of its terminal stops airtty dev's Server and Client too", async () => {
  const dir = await app(
    `export default function Page() {\n  return <text>dev fixture</text>;\n}\n`,
  );
  const run = dev(dir);
  try {
    // Nothing answers the Client's terminal queries here: its children are the signal.
    await until(() => childrenOf(run.pty.pid).length === 2, STARTUP_MS);
    const children = childrenOf(run.pty.pid);
    // What <Terminal> does when it unmounts, and the kernel when a terminal closes.
    run.pty.kill();
    await until(() => run.ended.length > 0, EXIT_MS);
    await until(() => !children.some(alive), EXIT_MS);
  } finally {
    run.pty.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("airtty dev ends with its Client's exit code: a crash is not a quit", async () => {
  const CRASH_CODE = 3;
  const dir = await app(
    `import { Crash } from "../components/Crash";\nexport default function Page() {\n  return <Crash />;\n}\n`,
  );
  await Bun.write(
    join(dir, "components/Crash.tsx"),
    `"use client";\nimport { useEffect } from "react";\nexport function Crash() {\n  useEffect(() => process.exit(${CRASH_CODE}), []);\n  return <text>crashing</text>;\n}\n`,
  );
  const run = dev(dir);
  try {
    await until(() => run.ended.length > 0, STARTUP_MS);
    expect(run.ended).toEqual([CRASH_CODE]);
  } finally {
    run.pty.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serialize: one run at a time, one more for any calls made during it", async () => {
  let runs = 0;
  let release = () => {};
  const rebuilds = serialize(async () => {
    runs++;
    await new Promise<void>((done) => (release = done));
  });
  const first = rebuilds.run();
  expect(rebuilds.busy).toBe(true);
  // Three calls while the first runs: one more run, not three.
  void rebuilds.run();
  void rebuilds.run();
  const last = rebuilds.run();
  release();
  await until(() => runs === 2);
  release();
  await Promise.all([first, last]);
  expect(runs).toBe(2);
  expect(rebuilds.busy).toBe(false);
});

test("startAppServer: resolves with the port, or rejects with what the Server said", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-app-server-"));
  const entry = join(dir, ".airtty/server/index.js");
  await mkdir(join(entry, ".."), { recursive: true });
  try {
    await Bun.write(
      entry,
      `console.log("starting"); console.log(JSON.stringify({ ready: true, port: 4331 })); setInterval(() => {}, 1000);`,
    );
    const output: string[] = [];
    const server = await startAppServer({
      directory: dir,
      env: process.env,
      onOutput: (line) => output.push(line),
    });
    expect(server.port).toBe(4331);
    expect(output).toEqual(["starting"]);
    await server.stop();
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);

    await Bun.write(
      entry,
      `console.error("SyntaxError: Export named 'useState' not found"); process.exit(1);`,
    );
    const failure = await rejectionOf(
      startAppServer({ directory: dir, env: process.env, stderr: () => {} }),
    );
    expect(messageOf(failure)).toContain("Server exited before ready");
    expect(messageOf(failure)).toContain("Export named 'useState' not found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Client started with an IPC channel reports the page that failed, and why", async () => {
  const dir = await app(
    `export default function Page() {\n  if (Date.now() > 0) throw new Error("generated page failed");\n  return <text>never</text>;\n}\n`,
  );
  let client: Pty | undefined;
  try {
    await build(dir);
    await linkFrameworkModules(dir, resolve("packages/airtty"));
    const server = await startAppServer({ directory: dir, env: { ...process.env, PORT: "0" } });
    try {
      const failures: ClientFailure[] = [];
      client = spawnPty({
        command: [
          process.execPath,
          join(dir, ".airtty/client/index.js"),
          "--url",
          `http://127.0.0.1:${server.port}`,
        ],
        cols: COLUMNS,
        rows: ROWS,
        onData: () => {},
        onExit: () => {},
        ipc: (message) => {
          const failure = ClientFailure.safeParse(message);
          if (failure.success) failures.push(failure.data);
        },
      });
      await until(() => failures.length > 0, STARTUP_MS);
      expect(failures[0]?.path).toBe("/");
      expect(failures[0]?.message).toContain("generated page failed");
    } finally {
      client?.kill();
      await server.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
