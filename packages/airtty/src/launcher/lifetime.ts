/**
 * The lifetime of a Server the launcher manages (AIRTTY_LIFETIME=managed, on a socket):
 *
 * - Clients ping `POST /lifetime/ping` every ~10 s (src/connect.ts). Any request counts
 *   too. A Client silent for the watchdog period (30 s) is lost.
 * - A Client that quits on purpose says so (`POST /lifetime/leave`): when it was the
 *   last one, the Server stops at once.
 * - When the last Client is lost instead (watchdog, the starting launcher's pipe closed
 *   without a leave: a crash, a closed terminal, a cut network), the Server waits in
 *   grace (15 min by default, AIRTTY_GRACE_MS; 0 stops at once) for a Client to come
 *   back, then stops. A Client that pings again in time is attached again.
 * - `POST /lifetime/stop` stops it whatever its Clients (another build replaces it).
 *
 * The launcher finds it again by its socket, whose path derives from the session key
 * (src/launcher/managed.ts), and checks `GET /lifetime/status` (build id) first.
 */
import { rmSync } from "node:fs";
import * as z from "zod/mini";

const MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
const GRACE_MINUTES = 15;
export const DEFAULT_GRACE_MS = GRACE_MINUTES * MS.m;
export const MS_PER_MINUTE = MS.m;
const DEFAULT_WATCHDOG_MS = 30_000;
// How often clients are checked against the watchdog period.
const CHECKS_PER_PERIOD = 3;
const NO_CONTENT = 204;

/** `15m`, `30s`, `1h`, `500ms`, or a number of seconds; `0` is none. */
export function parseDuration(text: string) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid duration "${text}": expected 15m, 30s, 1h, 500ms or 0`);
  const unit = match[2] === "ms" ? MS.ms : match[2] === "m" ? MS.m : match[2] === "h" ? MS.h : MS.s;
  return Number(match[1]) * unit;
}

const Milliseconds = z.coerce.number().check(z.int(), z.gte(0));
const Environment = z.object({
  AIRTTY_LIFETIME: z.optional(z.literal("managed")),
  AIRTTY_GRACE_MS: z._default(Milliseconds, DEFAULT_GRACE_MS),
  AIRTTY_WATCHDOG_MS: z._default(Milliseconds, DEFAULT_WATCHDOG_MS),
  /** The Client of the launcher that started this Server, whose pipe is stdin. */
  AIRTTY_LIFETIME_STARTER: z.optional(z.string()),
});

/** What `GET /lifetime/status` answers. */
export const LifetimeStatus = z.object({
  buildId: z.string(),
  pid: z.number(),
  clients: z.number(),
  graceUntil: z.optional(z.number()),
});
export const CLIENT_HEADER = "x-airtty-client";

export type Lifetime = {
  /** Answers a `/lifetime/*` request; `undefined` for any other (activity of a Client). */
  handle(request: Request, url: URL): Response | undefined;
};

export function managedLifetime(
  env: NodeJS.ProcessEnv,
  { buildId, socket, stop }: { buildId: string; socket: string; stop: () => void },
): Lifetime | undefined {
  const parsed = Environment.safeParse(env);
  if (!parsed.success)
    throw new Error(`Invalid lifetime environment: ${z.prettifyError(parsed.error)}`);
  const settings = parsed.data;
  if (settings.AIRTTY_LIFETIME !== "managed") return undefined;
  const { AIRTTY_GRACE_MS: graceMs, AIRTTY_WATCHDOG_MS: watchdogMs } = settings;
  const say = (message: string) => console.error(`[lifetime] ${message}`);
  const clients = new Map<string, number>();
  let activity = performance.now();
  let grace: { timer: ReturnType<typeof setTimeout>; until: number } | undefined;
  // Removed on the way out: the next launch must find no socket, not a dead one.
  process.on("exit", () => rmSync(socket, { force: true }));

  const end = (why: string) => {
    say(`stopping: ${why}`);
    stop();
  };
  const attached = () => {
    if (!grace) return;
    clearTimeout(grace.timer);
    grace = undefined;
    say("a Client is back: grace over");
  };
  const lost = (why: string) => {
    if (clients.size || grace) return;
    if (graceMs === 0) return end(`${why}, no grace`);
    say(`${why}: waiting ${Math.round(graceMs / MS.s)} s for a Client`);
    grace = {
      until: Date.now() + graceMs,
      timer: setTimeout(() => end("grace expired"), graceMs),
    };
  };
  const drop = (client: string, why: string) => {
    if (!clients.delete(client)) return;
    lost(why);
  };
  // A Server that never hears from a Client counts it lost too, from its start.
  const started = performance.now();
  const watchdog = setInterval(() => {
    const now = performance.now();
    for (const [client, seen] of clients)
      if (now - Math.max(seen, activity) > watchdogMs) drop(client, `Client ${client} silent`);
    if (!clients.size && !grace && now - Math.max(started, activity) > watchdogMs)
      lost("no Client");
  }, watchdogMs / CHECKS_PER_PERIOD);
  watchdog.unref();

  const starter = settings.AIRTTY_LIFETIME_STARTER;
  if (starter) {
    clients.set(starter, performance.now());
    // The starting launcher holds stdin: its end without a leave is that Client lost.
    const gone = () => drop(starter, "the launcher went away");
    process.stdin.once("end", gone);
    process.stdin.once("close", gone);
    process.stdin.resume();
  }

  return {
    handle(request, url) {
      if (!url.pathname.startsWith("/lifetime/")) {
        // A page or an action means a Client is there: grace ends; it pings within seconds.
        activity = performance.now();
        attached();
        return undefined;
      }
      // Status and stop come from launchers, not Clients: they neither count as activity
      // nor end grace.
      const client = request.headers.get(CLIENT_HEADER) ?? "";
      if (url.pathname === "/lifetime/status" && request.method === "GET")
        return Response.json({
          buildId,
          pid: process.pid,
          clients: clients.size,
          ...(grace ? { graceUntil: grace.until } : {}),
        } satisfies z.infer<typeof LifetimeStatus>);
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      if (url.pathname === "/lifetime/ping" && client) {
        clients.set(client, performance.now());
        attached();
        return Response.json({ buildId });
      }
      if (url.pathname === "/lifetime/leave" && client) {
        clients.delete(client);
        // Answered first; the Server goes once the Client has its reply.
        if (!clients.size) setTimeout(() => end("the last Client left"), 0);
        return new Response(null, { status: NO_CONTENT });
      }
      if (url.pathname === "/lifetime/stop") {
        setTimeout(() => end("asked to stop"), 0);
        return new Response(null, { status: NO_CONTENT });
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
