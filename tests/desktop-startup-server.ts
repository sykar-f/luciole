/** Hold the managed Server's first readiness answer until the parent releases it. */
import { managedLifetime } from "../packages/core/src/launcher/lifetime";
const socket = process.env.LUCIOLE_SOCKET;
const barrier = process.env.STARTUP_BARRIER;
if (!socket) throw new Error("Missing startup fixture socket");
const lifetime = managedLifetime(process.env, {
  buildId: "build-1",
  socket,
  stop: () => process.exit(0),
});
// Lifetime registered its stdin listeners first: this event observes the drop
// after the real lifetime code has changed the Client count and grace state.
const events = process.env.STARTUP_EVENTS;
if (events) {
  let sent = false;
  const lost = () => {
    if (sent) return;
    sent = true;
    void fetch(events, { method: "POST" }).catch(console.error);
  };
  process.stdin.once("end", lost);
  process.stdin.once("close", lost);
}
let first = true;
Bun.serve({
  unix: socket,
  async fetch(request) {
    const url = new URL(request.url);
    if (first && barrier && url.pathname === "/lifetime/status") {
      first = false;
      await fetch(barrier, { method: "POST", body: JSON.stringify({ socket, pid: process.pid }) });
    }
    return lifetime?.handle(request, url) ?? new Response("Not found", { status: 404 });
  },
});
