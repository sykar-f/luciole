/** @jsxImportSource @opentui/react */
/**
 * `run()`: an Application in the terminal it was started from. Everything here belongs to
 * that platform (the process environment, signals, `luciole dev`'s supervisor, the session
 * file, the TTY renderer); the Application itself (src/client.tsx) does not know it. The
 * web runtime replaces this module (docs/WEB.md, W1).
 */
import { desktopHangup } from "./desktop-hangup";
import { definedProperties } from "./defined-properties";
import { constants } from "node:os";
import * as z from "zod/mini";
import { createCliRenderer, NativeError, NativeStatus, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Shell, type Application, type ApplicationOptions } from "./client";
import { connect, serverUrl } from "./connect";
import { messageOf } from "./guards";
import { openSession, SessionId } from "./session";
import { networkFromEnv } from "./transport";
import { attachPixelScroll } from "./pixel-scroll/attach";
import { detectOpenTuiControlWriter, detectOpenTuiMouseObserver } from "./opentui-seams";

// The Client's own environment; the Server's URL comes from `serverUrl` (src/connect.ts)
// and network conditions from `networkFromEnv`.
const ClientEnvironment = z.object({
  LUCIOLE_TOKEN: z.optional(z.string()),
  LUCIOLE_LATENCY_MS: z._default(z.coerce.number().check(z.gte(0)), 0),
  /** Set by `luciole dev`: the session this Client reopens after each rebuild. */
  LUCIOLE_SESSION: z.optional(SessionId),
  /** Set by src/launcher: what sessions are kept under instead of the Server's URL. */
  LUCIOLE_SESSION_KEY: z.optional(z.string().check(z.minLength(1))),
  /** Development only: the address of `luciole devtools` (src/devtools/client-agent.ts). */
  LUCIOLE_DEVTOOLS: z.optional(z.string()),
  /**
   * Set by a desktop host (docs/DESKTOP.md): the Client fills a window of its own. Closing
   * the window quits; Ctrl+C belongs to the application.
   */
  LUCIOLE_DESKTOP: z.optional(z.literal("1")),
  LUCIOLE_PIXEL_SCROLL: z.optional(z.string()),
});
/** What `luciole dev` sends the Client it supervises (src/commands/dev.ts). */
const DevMessage = z.union([
  z.object({ type: z.literal("build-error"), message: z.string() }),
  z.object({ type: z.literal("bearer"), token: z.optional(z.string()) }),
]);
// The supervisor answers at once; a Client started by hand with LUCIOLE_SESSION only
// waits this long.
const SUPERVISOR_REPLY_MS = 1000;
// A failure reported to the supervisor: its message, cut to this many characters.
const FAILURE_MESSAGE_MAX = 2000;
/** Shell exit status for a signal is 128 plus its platform signal number. */
const SIGNAL_EXIT_BASE = 128;
/**
 * Development only: the bearer the previous Client of this `luciole dev` held. It lives
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
    name = "luciole",
    sessionKey,
    pixelScroll,
  }: {
    name?: string;
    /**
     * Keys the sessions this Client restores, instead of the Server's URL: the launcher
     * gives one per app and target, since its local socket changes on every launch.
     */
    sessionKey?: string;
    /** Web and desktop hosts: overrides the launch flag; off by default. */
    pixelScroll?: boolean;
  } = {},
) {
  const hangup = desktopHangup();
  const env = ClientEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Client environment: ${z.prettifyError(env.error)}`);
  const desktop = env.data.LUCIOLE_DESKTOP === "1";
  const openStore = (server: string) =>
    openSession({
      name,
      server,
      ...(env.data.LUCIOLE_SESSION === undefined ? {} : { id: env.data.LUCIOLE_SESSION }),
    });
  const key = sessionKey ?? env.data.LUCIOLE_SESSION_KEY;
  // A launcher may already have claimed a session. Own it before URL resolution
  // (which can wait for configuration or SSH authentication).
  const earlySession = desktop && key ? openStore(key) : undefined;
  if (earlySession) hangup?.add(() => earlySession.remove());
  // Resolved before the renderer takes the terminal: ssh may prompt for a passphrase.
  const url = await serverUrl({ name }).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  if (hangup?.quitting) return;
  const connection = await connect(url).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  hangup?.add(async () => {
    await connection.managed?.leave();
    connection.close();
  });
  if (hangup?.quitting) return;
  const supervised =
    env.data.LUCIOLE_SESSION !== undefined && process.send
      ? (message: unknown) => void process.send?.(message)
      : undefined;
  const handed = supervised ? await bearerFromSupervisor(supervised) : undefined;
  if (hangup?.quitting) return;
  // Keyed by the address the user gave: a tunnel's local port changes on every start.
  const session = earlySession ?? openStore(key ?? url);
  if (!earlySession) hangup?.add(() => session.remove());
  const devtools = env.data.LUCIOLE_DEVTOOLS
    ? (await import("./devtools/client-agent")).startClientAgent({
        address: env.data.LUCIOLE_DEVTOOLS,
        name,
      })
    : undefined;
  if (hangup?.quitting) return;
  const app = create({
    url: connection.url,
    ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
    ...definedProperties({ token: handed ?? env.data.LUCIOLE_TOKEN }),
    latencyMs: env.data.LUCIOLE_LATENCY_MS,
    network: networkFromEnv(process.env),
    ...(session.restored === undefined ? {} : { session: session.restored }),
    quitOnCtrlC: !desktop,
    ...(devtools && { wrapTransport: devtools.wrapTransport }),
  });
  // Claims the session at once: another Client starting now must not take it.
  app.restoration.persistTo(session);
  if (supervised) app.onTokenChange((token) => supervised({ type: "bearer", token }));
  // Whoever started this Client over IPC (`luciole dev`, a sandbox host, studio) hears
  // which page failed and why: the error screen alone tells only a person.
  const parent = process.send?.bind(process);
  if (parent)
    app.onEvent((event) => {
      if (event.type !== "failure") return;
      void parent({
        type: "failure",
        path: event.path,
        message: event.message.slice(0, FAILURE_MESSAGE_MAX),
      });
    });
  // Nothing reconnects by itself, but a managed Server's tunnel does (src/launcher): the
  // status follows it, Disconnected then Connected, the Client's state kept.
  connection.managed?.watch(() => void app.refresh());
  process.on("message", (received: unknown) => {
    const message = DevMessage.safeParse(received);
    if (!message.success || message.data.type !== "build-error") return;
    app.buildError = message.data.message;
    app.notify();
  });
  // Handlers first: from here on a signal must stop the tunnel, even during setup.
  let renderer: CliRenderer | undefined;
  let creating: Promise<CliRenderer> | undefined;
  // A hangup may reach the Client twice. Every exit waits for terminal restoration.
  let ending = false;
  const stop = async (code: number, voluntary = false) => {
    try {
      const active = renderer ?? (await creating);
      active?.destroy();
      await active?.closed;
    } catch (error) {
      // OpenTUI drains terminal restoration through native stdout. A desktop
      // host may already have closed the PTY after a successful voluntary leave.
      const closedOutput =
        desktop &&
        voluntary &&
        error instanceof NativeError &&
        error.operation === "ot_session_drain_stdout" &&
        error.status === NativeStatus.OutputFailed;
      if (!closedOutput) {
        console.error(messageOf(error));
        code = 1;
      }
    } finally {
      connection.close();
      process.exit(code);
    }
  };
  const end = (how: () => Promise<void>) => () => {
    if (ending) return;
    ending = true;
    void how().catch((error: unknown) => {
      console.error(messageOf(error));
      return stop(1);
    });
  };
  // A signal is not the user's choice (a rebuild, a closed terminal, a killed process):
  // the session stays on disk to be restored. Quitting (Ctrl+C, `app.quit`) deletes it.
  const interruptWith = (code: number) =>
    end(async () => {
      session.flush(app.restoration.snapshot());
      await stop(code);
    });
  const interrupted = interruptWith(0);
  const failed = (error: unknown) => {
    if (ending) return;
    ending = true;
    console.error(error);
    session.flush(app.restoration.snapshot());
    void stop(1);
  };
  // Voluntary: a Server the launcher manages stops once its last Client left it.
  const quit = end(async () => {
    session.remove();
    await connection.managed?.leave();
    await stop(0, true);
  });
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  // Closing a desktop window is a voluntary quit; a terminal hangup keeps the session.
  if (hangup) hangup.handle(quit);
  else process.on("SIGHUP", interrupted);
  // Keep OpenTUI's other terminating signals, with their conventional exit codes.
  // SIGBREAK exists on Windows only; SIGPIPE keeps Bun's ignored default.
  for (const signal of ["SIGQUIT", "SIGABRT", "SIGBUS", "SIGBREAK"] as const) {
    const number = constants.signals[signal];
    if (number !== undefined) process.on(signal, interruptWith(SIGNAL_EXIT_BASE + number));
  }
  process.on("beforeExit", interrupted);
  app.quit = quit;
  try {
    // Luciole owns signals and Ctrl+C so it can save the session and close the tunnel
    // before exit. OpenTUI's destroy remains asynchronous on every path.
    // Explicit app process.exit() uses OpenTUI's synchronous native exit hook on
    // the real stdout fd. A second exit reset would pop terminal modes twice.
    // Uncaught errors keep OpenTUI's existing non-fatal console behavior.
    creating = createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
    renderer = await creating;
    void renderer.closed.then(interrupted, failed);
    if (ending || renderer.isDestroyed) return;
    if (desktop && (pixelScroll ?? env.data.LUCIOLE_PIXEL_SCROLL === "1")) {
      const writer = detectOpenTuiControlWriter(renderer);
      const observer = detectOpenTuiMouseObserver(renderer);
      if (writer.available && observer.available)
        attachPixelScroll(renderer, {
          pixelScroll: true,
          write: (commands) => {
            // The shared controller does not await writes. Observe failures here,
            // including a rejected final release while the renderer is closing.
            void writer.renderer.writeControl(Buffer.from(commands)).catch(failed);
          },
          observeOrdinary: (receive) => observer.renderer.observeMouseInput(receive),
        });
    }
    devtools?.attach(app, renderer);
    const root = createRoot(renderer);
    root.render(<Shell app={app} />);
    // A focused <Terminal> sends Ctrl+C to its program. Otherwise it quits this Client.
    if (app.options.quitOnCtrlC !== false)
      renderer.keyInput.on("keypress", (key) => {
        if (key.ctrl && key.name === "c" && !key.defaultPrevented) quit();
      });
  } catch (error) {
    failed(error);
  }
}
