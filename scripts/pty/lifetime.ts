/**
 * `luciole ./examples/notes` on a PTY, across the Server's lifetime: a Client killed with
 * SIGKILL leaves its Server in grace; the next launch attaches to that same Server and
 * restores the route and the typed text; an unreachable Server shows Disconnected, then
 * Connected once it answers again; Ctrl+C stops the Server. Offline.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LifetimeStatus } from "../../packages/luciole/src/launcher/lifetime";
import { ctrl, drive, type Driver } from "./driver";
import { BUN, CLI, defer, eventually, example, report, temporaryDirectory } from "./harness";

/** Lets a key's effect (Ctrl+E focusing the text) land before the next keys arrive. */
const KEY_SETTLE_MS = 150;

const TIMEOUT_MS = 30_000;
const ENDED_TIMEOUT_MS = 10_000;
const GRACE_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 2000;
// The session file is written 200 ms after the last change.
const SESSION_WRITTEN_MS = 600;

const Session = z.object({ pid: z.number().int() }).loose();

/** GET /lifetime/status on a managed Server's socket, or undefined. */
async function status(socket: string | undefined) {
  if (!socket) return undefined;
  try {
    const response = await fetch("http://localhost/lifetime/status", {
      unix: socket,
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    return LifetimeStatus.parse(await response.json());
  } catch {
    return undefined;
  }
}

using directory = temporaryDirectory("luciole-pty-lifetime-");
// Under /tmp: a Unix socket's path is short (104 bytes on macOS).
using runtime = temporaryDirectory("luciole-rt-", "/tmp");
const sessions = join(directory.path, "state/luciole/notes/sessions");
const serverSocket = () => {
  const sockets = join(runtime.path, "luciole");
  const found = existsSync(sockets)
    ? readdirSync(sockets).find((name) => name.endsWith(".sock"))
    : undefined;
  return found === undefined ? undefined : join(sockets, found);
};
// Whatever the journey leaves: a Server stopped with SIGSTOP is woken up to terminate.
await using _leftover = defer(async () => {
  const leftover = await status(serverSocket());
  if (!leftover) return;
  process.kill(leftover.pid, "SIGCONT");
  process.kill(leftover.pid, "SIGTERM");
});
const start = () =>
  drive({
    command: [BUN, CLI, example("notes")],
    cols: 110,
    rows: 28,
    cwd: directory.path,
    env: {
      XDG_STATE_HOME: join(directory.path, "state"),
      XDG_RUNTIME_DIR: runtime.path,
      NOTES_DB: join(directory.path, "notes.sqlite"),
      // Nothing saves by itself: the words typed are still unsaved when they come back.
      NOTES_AUTOSAVE_MS: "0",
      LUCIOLE_PING_MS: "500",
    },
  });
const wait = (t: Driver, text: string) => t.waitFor(text, { timeout: TIMEOUT_MS });

let first: z.infer<typeof LifetimeStatus> | undefined;
{
  await using t = await start();
  await wait(t, "Welcome to Notes");
  await t.click("Welcome to Notes");
  await wait(t, "Getting around");
  // Ctrl+E: the cursor at the end of the text.
  await t.type(ctrl("e"), KEY_SETTLE_MS);
  // On a line of their own: the end of the note would wrap them.
  t.write("\runsaved words");
  await wait(t, "unsaved words");
  await t.pause(SESSION_WRITTEN_MS);
  first = await status(serverSocket());
  assert.ok(first && first.clients === 1, JSON.stringify(first));
  // The Client crashes: its Server waits in grace instead of going with it.
  const file = readdirSync(sessions).find((name) => name.endsWith(".json")) ?? "";
  const client = Session.parse(JSON.parse(readFileSync(join(sessions, file), "utf8")));
  process.kill(client.pid, "SIGKILL");
  await t.exited(ENDED_TIMEOUT_MS);
}
const path = serverSocket();
await eventually(async () => (await status(path))?.graceUntil !== undefined, GRACE_TIMEOUT_MS);
const inGrace = await status(path);
assert.ok(
  inGrace && inGrace.pid === first.pid && inGrace.graceUntil !== undefined,
  JSON.stringify(inGrace),
);
{
  // Launched again: same Server, same page, the text as it was typed.
  await using t = await start();
  await wait(t, "unsaved words");
  assert.ok((await t.text()).includes("● Unsaved"), await t.text());
  const again = await status(path);
  assert.ok(again?.pid === first.pid && again.graceUntil === undefined, JSON.stringify(again));
  // The Server stops answering, then answers again: the Client follows, state kept.
  process.kill(first.pid, "SIGSTOP");
  await wait(t, "Disconnected");
  process.kill(first.pid, "SIGCONT");
  // Connected again: the status line says nothing when the connection works.
  await t.waitFor("Disconnected", { timeout: TIMEOUT_MS, absent: true });
  assert.ok((await t.text()).includes("unsaved words"), await t.text());
  // Quitting on purpose stops the Server.
  t.write(ctrl("c"));
  await t.exited(ENDED_TIMEOUT_MS);
}
await eventually(() => !existsSync(path ?? ""), GRACE_TIMEOUT_MS);
assert.ok(!existsSync(path ?? "") && (await status(path)) === undefined, "Server still running");

report({
  lifetimePTY: true,
  crashKeepsServerInGrace: true,
  reattachedSameServer: true,
  routeAndFieldRestored: true,
  disconnectedThenConnected: true,
  quitStopsServer: true,
});
