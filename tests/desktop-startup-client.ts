/** A real managed Client, held at URL resolution before run() installs its handlers. */
import { mock } from "bun:test";
import { resolve } from "node:path";
import { openSession } from "../packages/core/src/session";
import { connect } from "../packages/core/src/connect";
import { ensureServer } from "../packages/core/src/launcher/managed";

if (process.env.STARTUP_BARRIER) process.on("SIGHUP", () => process.send?.({ hungup: true }));
const server = await ensureServer({
  id: "startup",
  name: "startup",
  buildId: "build-1",
  command: [
    process.execPath,
    "--conditions=react-server",
    resolve("tests/desktop-startup-server.ts"),
  ],
  graceMs: 900_000,
  directories: { state: process.env.XDG_STATE_HOME ?? "/tmp" },
  client: "startup",
  attach: true,
});
if (process.env.STARTUP_BARRIER) await new Promise<never>(() => {});
process.env.LUCIOLE_LIFETIME_CLIENT = "startup";
process.env.LUCIOLE_SESSION = "startup";
// A session the launcher has claimed from a previous launch.
openSession({ name: "startup", server: "startup", id: "startup" }).flush({
  index: 0,
  entries: [{ href: "/", fields: {} }],
});
void mock.module(resolve("packages/core/src/connect.ts"), () => ({
  connect,
  serverUrl: async () => {
    process.send?.({ socket: server.socket, pid: server.pid });
    // A URL provider whose answer is controlled by the parent, not by a timer.
    await new Promise<void>((done) => process.on("message", () => done()));
    return server.url;
  },
}));
const { run } = await import("../packages/core/src/run");
await run(
  () => {
    throw new Error("The URL barrier must not be released");
  },
  { name: "startup", sessionKey: "startup" },
);
