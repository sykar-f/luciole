/** @jsxImportSource @opentui/react */
/**
 * `run()`: an Application in the terminal it was started from. Everything here belongs to
 * that platform (the process environment, signals, `airtty dev`'s supervisor, the session
 * file, the TTY renderer); the Application itself (src/client.tsx) does not know it. The
 * web runtime replaces this module (docs/WEB.md, W1).
 */
import * as z from "zod/mini";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Shell, type Application, type ApplicationOptions } from "./client";
import { connect, serverUrl } from "./connect";
import { messageOf } from "./guards";
import { openSession, SessionId } from "./session";
import { networkFromEnv } from "./transport";

// The Client's own environment; the Server's URL comes from `serverUrl` (src/connect.ts)
// and network conditions from `networkFromEnv`.
const ClientEnvironment = z.object({
  AIRTTY_TOKEN: z.optional(z.string()),
  AIRTTY_LATENCY_MS: z._default(z.coerce.number().check(z.gte(0)), 0),
  /** Set by `airtty dev`: the session this Client reopens after each rebuild. */
  AIRTTY_SESSION: z.optional(SessionId),
  /** Set by src/launcher: what sessions are kept under instead of the Server's URL. */
  AIRTTY_SESSION_KEY: z.optional(z.string().check(z.minLength(1))),
  /** Development only: the address of `airtty devtools` (src/devtools/client-agent.ts). */
  AIRTTY_DEVTOOLS: z.optional(z.string()),
  /**
   * Set by a desktop host (docs/DESKTOP.md): the Client fills a window of its own. Closing
   * the window quits; Ctrl+C belongs to the application.
   */
  AIRTTY_DESKTOP: z.optional(z.literal("1")),
});
/** What `airtty dev` sends the Client it supervises (src/commands/dev.ts). */
const DevMessage = z.union([
  z.object({ type: z.literal("build-error"), message: z.string() }),
  z.object({ type: z.literal("bearer"), token: z.optional(z.string()) }),
]);
// The supervisor answers at once; a Client started by hand with AIRTTY_SESSION only
// waits this long.
const SUPERVISOR_REPLY_MS = 1000;
/**
 * Development only: the bearer the previous Client of this `airtty dev` held. It lives
 * in the supervisor's memory, never on disk, so a rebuild does not ask to sign in again.
 */
function bearerFromSupervisor(send: (message: unknown) => void) {
  return new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => done(undefined), SUPERVISOR_REPLY_MS);
    const done = (token: string | undefined) => {
      clearTimeout(timer);
      process.off("message", listener);
      resolve(token);
    };
    const listener = (received: unknown) => {
      const message = DevMessage.safeParse(received);
      if (message.success && message.data.type === "bearer") done(message.data.token);
    };
    process.on("message", listener);
    send({ type: "hello" });
  });
}
/** What `run()` gives the function that creates its Application. */
export type RunOptions = Pick<
  ApplicationOptions,
  "url" | "fetch" | "token" | "latencyMs" | "network" | "session" | "wrapTransport" | "quitOnCtrlC"
>;
export async function run(
  create: (options: RunOptions) => Application,
  {
    name = "airtty",
    sessionKey,
  }: {
    name?: string;
    /**
     * Keys the sessions this Client restores, instead of the Server's URL: the launcher
     * gives one per app and target, since its local socket changes on every launch.
     */
    sessionKey?: string;
  } = {},
) {
  const env = ClientEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Client environment: ${z.prettifyError(env.error)}`);
  const desktop = env.data.AIRTTY_DESKTOP === "1";
  // Resolved before the renderer takes the terminal: ssh may prompt for a passphrase.
  const url = await serverUrl({ name }).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  const connection = await connect(url).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  const supervised =
    env.data.AIRTTY_SESSION !== undefined && process.send
      ? (message: unknown) => void process.send?.(message)
      : undefined;
  const handed = supervised ? await bearerFromSupervisor(supervised) : undefined;
  // Keyed by the address the user gave: a tunnel's local port changes on every start.
  const session = openSession({
    name,
    server: sessionKey ?? env.data.AIRTTY_SESSION_KEY ?? url,
    id: env.data.AIRTTY_SESSION,
  });
  const devtools = env.data.AIRTTY_DEVTOOLS
    ? (await import("./devtools/client-agent")).startClientAgent({
        address: env.data.AIRTTY_DEVTOOLS,
        name,
      })
    : undefined;
  const app = create({
    url: connection.url,
    fetch: connection.fetch,
    token: handed ?? env.data.AIRTTY_TOKEN,
    latencyMs: env.data.AIRTTY_LATENCY_MS,
    network: networkFromEnv(process.env),
    session: session.restored,
    quitOnCtrlC: !desktop,
    ...(devtools && { wrapTransport: devtools.wrapTransport }),
  });
  // Claims the session at once: another Client starting now must not take it.
  session.flush(app.restoration.snapshot());
  app.restoration.subscribe(() => session.schedule(app.restoration.snapshot()));
  if (supervised) app.onTokenChange((token) => supervised({ type: "bearer", token }));
  // Nothing reconnects by itself, but a managed Server's tunnel does (src/launcher): the
  // status follows it, Disconnected then Connected, the Client's state kept.
  connection.managed?.watch(() => void app.refresh());
  process.on("message", (received: unknown) => {
    const message = DevMessage.safeParse(received);
    if (!message.success || message.data.type !== "build-error") return;
    app.buildError = message.data.message;
    app.notify();
  });
  // Handlers first: from here on a signal must stop the tunnel, the renderer is optional.
  let renderer: CliRenderer | undefined;
  // One end only: a hangup reaches the Client twice (from the kernel, and forwarded by a
  // launcher in between), and a quit waits for its leave.
  let ending = false;
  const end = (how: () => void) => () => {
    if (ending) return;
    ending = true;
    how();
  };
  const stop = () => {
    renderer?.destroy();
    connection.close();
    process.exit(0);
  };
  // A signal is not the user's choice (a rebuild, a closed terminal, a killed process):
  // the session stays on disk to be restored. Quitting (Ctrl+C, `app.quit`) deletes it.
  const interrupted = end(() => {
    session.flush(app.restoration.snapshot());
    stop();
  });
  // Voluntary: a Server the launcher manages stops once its last Client left it.
  const quit = end(() => {
    session.remove();
    void (connection.managed?.leave() ?? Promise.resolve()).then(stop);
  });
  // SIGHUP: the terminal closed; the Client and its tunnel must not outlive it. A desktop
  // window is the application itself: closing it hangs its PTY up, and the user quit.
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  process.on("SIGHUP", desktop ? quit : interrupted);
  app.quit = quit;
  renderer = await createCliRenderer({ exitOnCtrlC: false });
  devtools?.attach(app, renderer);
  const root = createRoot(renderer);
  // RouterProvider's Transitioner performs the initial load.
  root.render(<Shell app={app} />);
  // Unless something already took the key: a focused <Terminal> sends Ctrl+C to its
  // program. A tree that failed to mount prevents nothing, so Ctrl+C still quits.
  if (app.options.quitOnCtrlC !== false)
    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c" && !key.defaultPrevented) quit();
    });
}
