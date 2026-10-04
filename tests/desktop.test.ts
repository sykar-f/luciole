/**
 * A Client in a desktop window (LUCIOLE_DESKTOP): Ctrl+C is the application's, closing the
 * window (a hangup of its PTY) quits on purpose, and a termination keeps the session as
 * in a terminal. The production Client runs on a real PTY (scripts/pty/driver.ts), as a
 * desktop host runs it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctrl, drive } from "../scripts/pty/driver";
import { BUILD_TEST_MS, launch, privateBuild } from "./helpers";

const built = await privateBuild("examples/notes");
let dir: string;
let server: Awaited<ReturnType<typeof launch>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "luciole-desktop-"));
  // In production, as the Client below: a development Server wants the bearer of `luciole dev`.
  server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
    NODE_ENV: "production",
  });
}, BUILD_TEST_MS);
afterAll(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const sessions = async (state: string) =>
  readdir(join(state, "luciole/notes/sessions")).catch(() => []);

/** The notes Client in a window: started and connected; stopped at the end of its scope. */
async function openWindow(state: string) {
  const window = await drive({
    command: [process.execPath, join(built.output, "client/index.js"), "--url", server.url],
    cols: 100,
    rows: 28,
    env: { NODE_ENV: "production", XDG_STATE_HOME: state, LUCIOLE_DESKTOP: "1" },
  });
  // The list comes from the Server: shown, the Client is connected.
  await window.waitFor("Welcome to Notes");
  return window;
}

test("Ctrl+C reaches the application instead of quitting", async () => {
  const state = join(dir, "ctrl-c");
  await using window = await openWindow(state);
  // Keys are read in order: once the Ctrl+T after it has shown Notes' debug overlay, the
  // Ctrl+C was handled. A quit would have deleted the session file then, synchronously.
  window.write(ctrl("c") + ctrl("t"));
  await window.waitFor(/requests \d+ · open/);
  expect(window.running).toBe(true);
  expect(await sessions(state)).toHaveLength(1);
});

test("closing the window quits: the session is forgotten", async () => {
  const state = join(dir, "close");
  await using window = await openWindow(state);
  // What a closed window does to its PTY.
  process.kill(window.pid, "SIGHUP");
  expect(await window.exited()).toBe(0);
  window.assertRestored();
  expect(await sessions(state)).toHaveLength(0);
});

test("a termination keeps the session to restore", async () => {
  const state = join(dir, "term");
  await using window = await openWindow(state);
  process.kill(window.pid, "SIGTERM");
  expect(await window.exited()).toBe(0);
  expect(await sessions(state)).toHaveLength(1);
});
