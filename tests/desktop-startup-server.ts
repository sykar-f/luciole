/** Hold the managed Server's first readiness answer until the parent releases it. */
import { managedLifetime } from "../packages/core/src/launcher/lifetime";
const socket = process.env.LUCIOLE_SOCKET;
const barrier = process.env.STARTUP_BARRIER;
if (!socket || !barrier) throw new Error("Missing startup fixture environment");
const lifetime = managedLifetime(process.env, {
  buildId: "build-1",
  socket,
  stop: () => process.exit(0),
});
let first = true;
Bun.serve({
  unix: socket,
  async fetch(request) {
    const url = new URL(request.url);
    if (first && url.pathname === "/lifetime/status") {
      first = false;
      await fetch(barrier, { method: "POST", body: JSON.stringify({ socket, pid: process.pid }) });
    }
    return lifetime?.handle(request, url) ?? new Response("Not found", { status: 404 });
  },
});
