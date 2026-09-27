/**
 * What supervising an application under development takes, whoever decides when to
 * rebuild: `airtty dev` on each file change (src/commands/dev.ts), a host such as studio
 * at the end of a harness's turn. Starting a built application's Server and waiting until
 * it listens, handing the bearer from one Client to the next, the link to the framework's
 * packages, and rebuilds that never overlap.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { isCode } from "../launcher/lock";

const DEFAULT_STARTUP_MS = 10_000;
// What a Server that died before listening wrote last, kept for the error.
const STDERR_KEPT = 4000;
// A child that ignores SIGTERM this long is killed.
const STOP_GRACE_MS = 1500;

/** The line a Server prints once it listens (src/serve.ts). */
const ServerReady = z.object({ ready: z.literal(true), port: z.number().int() });

/** Stops a child: SIGTERM, then SIGKILL after a grace period. */
export async function stopChild(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

/**
 * The node_modules the framework's packages come from, seen from `from` (the framework's
 * own directory): its own, or the workspace root's where they are hoisted. React stands
 * for all of them.
 */
export function frameworkModules(from: string) {
  const react = Bun.resolveSync("react/package.json", from);
  return react.slice(
    0,
    react.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length,
  );
}
/**
 * Links `<directory>/.airtty/node_modules` to the framework's packages: a built app runs
 * against the framework installation, even a starter elsewhere. An existing link stays.
 */
export async function linkFrameworkModules(directory: string, from: string) {
  await symlink(frameworkModules(from), join(directory, ".airtty/node_modules"), "dir").catch(
    (error: unknown) => {
      if (!isCode(error, "EEXIST")) throw error;
    },
  );
}

export type AppServerOptions = {
  /** The application directory, built: its `.airtty/server/index.js` is started. */
  directory: string;
  /** Where it was built instead (`build(directory, output)`): its `server/index.js`. */
  output?: string;
  /** The Server's whole environment (`PORT` included). */
  env: NodeJS.ProcessEnv;
  /** Wraps the command, to start it confined (src/sandbox/server.ts). */
  command?: (argv: readonly string[]) => readonly string[];
  /** Lines of stdout that are not the ready line: `airtty dev` shows them. */
  onOutput?: (line: string) => void;
  /** `inherit` (the default): the Server writes to this process's stderr. */
  stderr?: "inherit" | ((text: string) => void);
  timeoutMs?: number;
};
export type AppServer = {
  port: number;
  child: ChildProcess;
  stop(): Promise<void>;
};
/**
 * Starts a built application's Server and resolves once it listens. A Server that exits
 * or times out first rejects, with what it wrote on stderr when that is piped.
 */
export async function startAppServer(options: AppServerOptions): Promise<AppServer> {
  const argv = [
    process.execPath,
    "--conditions=react-server",
    join(options.output ?? join(options.directory, ".airtty"), "server/index.js"),
  ];
  const [command, ...rest] = options.command?.(argv) ?? argv;
  if (!command) throw new Error("A Server needs a command");
  const piped = typeof options.stderr === "function";
  const child = spawn(command, rest, {
    stdio: ["ignore", "pipe", piped ? "pipe" : "inherit"],
    env: options.env,
  });
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    errors = (errors + text).slice(-STDERR_KEPT);
    if (typeof options.stderr === "function") options.stderr(text);
  });
  const output = child.stdout;
  if (!output) throw new Error("Server output is not piped");
  const why = (reason: string) => new Error(errors ? `${reason}:\n${errors.trim()}` : reason);
  try {
    const ready = await new Promise<z.infer<typeof ServerReady>>((yes, no) => {
      const timer = setTimeout(
        () => no(why("Server startup timeout")),
        options.timeoutMs ?? DEFAULT_STARTUP_MS,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        // Its last words may still be in the pipe: read them before rejecting.
        setImmediate(() => no(why("Server exited before ready")));
      });
      createInterface({ input: output }).on("line", (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          options.onOutput?.(line);
          return;
        }
        const parsed = ServerReady.safeParse(message);
        if (parsed.success) {
          clearTimeout(timer);
          yes(parsed.data);
        }
      });
    });
    return { port: ready.port, child, stop: () => stopChild(child) };
  } catch (error: unknown) {
    await stopChild(child);
    throw error;
  }
}

/** What a supervised Client asks, or tells, its supervisor (src/run.tsx). */
const ClientMessage = z.union([
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("bearer"), token: z.string().optional() }),
]);
/**
 * The bearer of a development run, passed from each Client to the next in memory (never
 * on disk): a rebuild does not ask to sign in again. `attach` answers a new Client's
 * hello and keeps what it later holds.
 */
export function bearerRelay() {
  let bearer: string | undefined;
  return {
    attach(client: ChildProcess) {
      client.on("message", (received: unknown) => {
        const message = ClientMessage.safeParse(received);
        if (!message.success) return;
        if (message.data.type === "hello") client.send({ type: "bearer", token: bearer });
        else bearer = message.data.token;
      });
    },
  };
}

/** A page of a supervised Client failed (src/run.tsx): its path and why. */
export const ClientFailure = z.object({
  type: z.literal("failure"),
  path: z.string(),
  message: z.string(),
});
export type ClientFailure = z.infer<typeof ClientFailure>;
/** Calls `listener` for each failure a Client started with an IPC channel reports. */
export function onClientFailure(
  client: Pick<ChildProcess, "on">,
  listener: (failure: ClientFailure) => void,
) {
  client.on("message", (received: unknown) => {
    const failure = ClientFailure.safeParse(received);
    if (failure.success) listener(failure.data);
  });
}

/**
 * `task` run one at a time: a call while it runs asks for one more run after it, however
 * many calls came in between (a burst of file changes, turns ending close together).
 * `run()` resolves once the runs it caused are done; `busy` says whether one is going on.
 */
export function serialize(task: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let again = false;
  return {
    get busy() {
      return running !== undefined;
    },
    run(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await task();
          } while (again);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
}
