/**
 * `airtty dev` as a program on a PTY, the way a host embeds it (a multiplexer's
 * `<Terminal>`, studio's preview): what it leaves behind when the terminal goes away.
 */
import { test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPty, type Pty } from "../packages/airtty/src/vt/pty";
import { until } from "./helpers";

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
