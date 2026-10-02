/**
 * What a Client leaves behind when it ends other than by unmounting: the terminal it took
 * (src/run.tsx) and the PTY children it spawned, which have sessions of their own
 * (src/vt/pty.ts).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { build } from "../packages/core/src/build";
import { linkFrameworkModules, startAppServer } from "../packages/core/src/dev/supervisor";
import { spawnPty, type Pty } from "../packages/core/src/vt/pty";
import { BUILD_TEST_MS, until } from "./helpers";

const STARTUP_MS = 20_000;
const GONE_MS = 2000;
const TEST_MS = 60_000;
const COLUMNS = 80;
const ROWS = 24;
/** The renderer's own take and reset of the screen and the cursor. */
const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const Pong = z.object({ type: z.literal("pong") });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * One page, built once (a build takes tens of seconds on a loaded machine). The test
 * drives it by key once it has seen the first frame: `x` does what the Client's
 * `FIXTURE` says, `p` answers over IPC to prove the Client still runs.
 */
const PAGE = `"use client";
import { useKeyboard } from "@opentui/react";
import { Terminal } from "@luciole-sh/core/client";
export default function Page() {
  useKeyboard((key) => {
    if (key.name === "p") process.send?.({ type: "pong" });
    if (key.name !== "x") return;
    if (process.env.FIXTURE === "exit") process.exit(3);
    if (process.env.FIXTURE === "throw")
      setTimeout(() => {
        throw new Error("after the first render");
      }, 0);
  });
  if (process.env.FIXTURE === "terminal")
    return <Terminal command={["sh", "-c", "trap '' HUP; echo child=$$; exec sleep 300"]} />;
  return <text>READY</text>;
}
`;

let directory = "";
let server: Awaited<ReturnType<typeof startAppServer>> | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "luciole-client-crash-"));
  for (const [name, text] of Object.entries({
    "app/layout.tsx": `"use client";\nexport default function Layout({ children }) {\n  return children;\n}\n`,
    "app/page.tsx": PAGE,
  })) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await Bun.write(join(directory, name), text);
  }
  await build(directory);
  await linkFrameworkModules(directory, resolve("packages/core"));
  server = await startAppServer({ directory, env: { ...process.env, PORT: "0" } });
}, BUILD_TEST_MS);
afterAll(async () => {
  await server?.stop();
  await rm(directory, { recursive: true, force: true });
});

/** The built Client on a PTY, as a terminal emulator would host it. */
async function withClient(
  fixture: string,
  body: (client: {
    pty: Pty;
    pongs: () => number;
    screen: () => string;
    ended: () => (number | null)[];
  }) => Promise<void>,
) {
  let screen = "";
  const ended: (number | null)[] = [];
  let pongs = 0;
  const pty = spawnPty({
    command: [
      process.execPath,
      join(directory, ".luciole/client/index.js"),
      "--url",
      `http://127.0.0.1:${server?.port}`,
    ],
    env: { FIXTURE: fixture },
    cols: COLUMNS,
    rows: ROWS,
    onData: (bytes) => (screen += new TextDecoder().decode(bytes)),
    onExit: (code) => ended.push(code),
    ipc: (message) => {
      if (Pong.safeParse(message).success) pongs++;
    },
  });
  try {
    await body({ pty, pongs: () => pongs, screen: () => screen, ended: () => ended });
  } finally {
    pty.kill();
  }
}

const frameSeen = (client: { screen: () => string }) =>
  until(() => client.screen().includes("READY"), STARTUP_MS);

test(
  "a Client that exits through process.exit after its first render resets the terminal",
  () =>
    withClient("exit", async (client) => {
      await frameSeen(client);
      client.pty.write("x");
      await until(() => client.ended().length > 0, GONE_MS);
      expect(client.ended()[0]).toBe(3);
      const screen = client.screen();
      const entered = screen.indexOf(ENTER_ALTERNATE_SCREEN);
      expect(entered).toBeGreaterThan(-1);
      expect(screen.lastIndexOf(LEAVE_ALTERNATE_SCREEN)).toBeGreaterThan(entered);
      const hidden = screen.lastIndexOf(HIDE_CURSOR);
      expect(hidden).toBeGreaterThan(-1);
      expect(screen.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(hidden);
    }),
  TEST_MS,
);

// OpenTUI's own handler (node_modules/@opentui/core, `handleError`) swallows an uncaught
// exception: it logs to its console and the process lives on, so there is nothing to reset
// until something ends the Client.
test(
  "an exception after the first render leaves the Client alive, its terminal reset on exit",
  () =>
    withClient("throw", async (client) => {
      await frameSeen(client);
      client.pty.write("x");
      await until(() => client.screen().includes("after the first render"), GONE_MS);
      expect(client.ended()).toEqual([]);
      // Still running: it answers a key.
      client.pty.write("p");
      await until(() => client.pongs() > 0, GONE_MS);
      process.kill(client.pty.pid, "SIGTERM");
      await until(() => client.ended().length > 0, GONE_MS);
      const screen = client.screen();
      const entered = screen.indexOf(ENTER_ALTERNATE_SCREEN);
      expect(entered).toBeGreaterThan(-1);
      expect(screen.lastIndexOf(LEAVE_ALTERNATE_SCREEN)).toBeGreaterThan(entered);
    }),
  TEST_MS,
);

// The program ignores the hangup the PTY's close sends: only the Client can end it.
test(
  "SIGTERM to a Client takes the programs of its <Terminal>s with it",
  () =>
    withClient("terminal", async (client) => {
      let pid = 0;
      await until(() => {
        const found = /child=(\d+)/.exec(client.screen());
        pid = found ? Number(found[1]) : 0;
        return pid > 0;
      }, STARTUP_MS);
      expect(alive(pid)).toBe(true);
      process.kill(client.pty.pid, "SIGTERM");
      await until(() => !alive(pid), GONE_MS);
    }),
  TEST_MS,
);
