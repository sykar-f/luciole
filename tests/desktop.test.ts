/**
 * A Client in a desktop window (AIRTTY_DESKTOP): Ctrl+C is the application's, closing the
 * window (a hangup of its PTY) quits on purpose, and a termination keeps the session as
 * in a terminal. The production Client runs on a real PTY, as a desktop host runs it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/airtty/src/build";
import { spawnPty, type Pty } from "../packages/airtty/src/vt/pty";
import { launch, until } from "./helpers";

const root = resolve("examples/notes");
let dir: string;
let server: Awaited<ReturnType<typeof launch>>;

beforeAll(async () => {
  await build(root);
  dir = await mkdtemp(join(tmpdir(), "airtty-desktop-"));
  // In production, as the Client below: a development Server wants the bearer of `airtty dev`.
  server = await launch(join(root, ".airtty/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
    NODE_ENV: "production",
  });
});
afterAll(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const sessions = async (state: string) =>
  readdir(join(state, "airtty/notes/sessions")).catch(() => []);

/** The notes Client in a window: started, connected, its session claimed. */
async function openWindow(state: string) {
  let output = "";
  let exit: number | null | undefined;
  const pty: Pty = spawnPty({
    command: [process.execPath, join(root, ".airtty/client/index.js"), "--url", server.url],
    cols: 100,
    rows: 28,
    env: { NODE_ENV: "production", XDG_STATE_HOME: state, AIRTTY_DESKTOP: "1" },
    onData: (bytes) => {
      const text = new TextDecoder().decode(bytes);
      // No emulator answers here: the cursor and device queries get a plausible reply.
      if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");
      if (text.includes("\x1b[c")) pty.write("\x1b[?1;2c");
      output += text;
    },
    onExit: (code) => {
      exit = code;
    },
  });
  // A Client that never connects must not outlive the test.
  await until(() => output.includes("Connected"), 10_000).catch((error: unknown) => {
    pty.kill();
    throw error;
  });
  return {
    pty,
    exited: async () => {
      await until(() => exit !== undefined);
      return exit;
    },
    running: () => exit === undefined,
  };
}

test("Ctrl+C reaches the application instead of quitting", async () => {
  const state = join(dir, "ctrl-c");
  const window = await openWindow(state);
  window.pty.write("\x03");
  await Bun.sleep(500);
  expect(window.running()).toBe(true);
  expect(await sessions(state)).toHaveLength(1);
  window.pty.kill();
  await window.exited();
});

test("closing the window quits: the session is forgotten", async () => {
  const state = join(dir, "close");
  const window = await openWindow(state);
  // What a closed window does to its PTY.
  window.pty.kill();
  expect(await window.exited()).toBe(0);
  expect(await sessions(state)).toHaveLength(0);
});

test("a termination keeps the session to restore", async () => {
  const state = join(dir, "term");
  const window = await openWindow(state);
  process.kill(window.pty.pid, "SIGTERM");
  expect(await window.exited()).toBe(0);
  expect(await sessions(state)).toHaveLength(1);
});
