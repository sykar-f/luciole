/**
 * An app on this machine: its Server on a Unix socket in a private directory, its Client
 * in the terminal. No TCP port, so nothing to collide with and nothing another user can
 * reach; the Server ends with the Client (see attach.ts).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as z from "zod/mini";
import { socketDirectory } from "../connect";
import type { Directories } from "./paths";

const SERVER_STARTUP_MS = 30_000;
// A child that ignores SIGTERM this long is killed.
const STOP_GRACE_MS = 1500;
const LOG_TAIL_BYTES = 4096;
const PRIVATE_DIRECTORY = 0o700;
/** The line a Server prints once it listens on its socket (src/server.ts). */
const Ready = z.object({ ready: z.literal(true), socket: z.string() });

export type LocalServer = {
  /** What the Client is given: `unix:<socket>` (src/connect.ts). */
  url: string;
  /** Stops the Server and removes its socket directory. */
  stop(): Promise<void>;
};

export type ServerOptions = {
  /** The app's name: its Server log is `<state>/<name>/<log>`. */
  name: string;
  /**
   * Starts the Server, given the socket the Client will use (also in AIRTTY_SOCKET).
   * The Server must stop when its stdin ends (`--attached`).
   */
  command: (socket: string) => readonly string[];
  directories: Pick<Directories, "state">;
  env?: NodeJS.ProcessEnv;
  /** Defaults to `server.log`. */
  log?: string;
};

export const serverLog = (state: string, name: string, log = "server.log") =>
  join(state, name, log);

/** Ends `child`: SIGTERM, then SIGKILL after a grace period. */
export function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts the Server and resolves once it listens. What it prints goes to its log, never
 * over the Client's screen; a Server that fails to start is explained from that log.
 */
export async function startServer({
  name,
  command,
  directories,
  env = process.env,
  log: logName,
}: ServerOptions): Promise<LocalServer> {
  const logFile = serverLog(directories.state, name, logName);
  mkdirSync(join(directories.state, name), { recursive: true, mode: PRIVATE_DIRECTORY });
  const log = openSync(logFile, "a");
  const start = statSync(logFile).size;
  const directory = socketDirectory("airtty-");
  const socket = join(directory, "s");
  const [executable, ...args] = command(socket);
  if (!executable) throw new Error("No Server command");
  const child = spawn(executable, args, {
    // stdin stays open and silent: its end is the Server's signal to stop.
    stdio: ["pipe", "pipe", log],
    env: { ...env, NODE_ENV: "production", AIRTTY_SOCKET: socket },
  });
  const cleanup = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  const tail = () => {
    const text = readFileSync(logFile, "utf8").slice(start).trim();
    return text.length > LOG_TAIL_BYTES ? `…${text.slice(-LOG_TAIL_BYTES)}` : text;
  };
  const stdout = child.stdout;
  if (!stdout) throw new Error("Server output is not piped");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${name}: the Server did not start in ${SERVER_STARTUP_MS} ms`)),
        SERVER_STARTUP_MS,
      );
      const failed = (why: string) => {
        clearTimeout(timer);
        const logged = tail();
        reject(
          new Error(`${name}: the Server ${why}${logged ? `:\n${logged}` : ""}\n(${logFile})`),
        );
      };
      child.once("error", (error) => failed(error.message));
      child.once("exit", (code, signal) => failed(`exited with ${signal ?? code}`));
      let ready = false;
      createInterface({ input: stdout }).on("line", (line) => {
        if (!ready) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {}
          if (Ready.safeParse(value).success) {
            ready = true;
            clearTimeout(timer);
            resolve();
            return;
          }
        }
        try {
          writeSync(log, `${line}\n`);
        } catch {
          // The log was closed by stop(): the Server's last words are dropped.
        }
      });
    });
  } catch (error: unknown) {
    cleanup();
    process.off("exit", cleanup);
    closeSync(log);
    throw error;
  }
  return {
    url: `unix:${socket}`,
    async stop() {
      process.off("exit", cleanup);
      await terminate(child);
      rmSync(directory, { recursive: true, force: true });
      closeSync(log);
    },
  };
}

/**
 * Runs a Client in the foreground until it quits. The launcher stays in between: a
 * signal it receives (a closed terminal, a `kill`) is passed on, and the Client decides
 * how to end, keeping its session as it would alone.
 */
export function runForeground(command: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const [executable, ...args] = command;
  if (!executable) throw new Error("No Client command");
  const child = spawn(executable, args, { stdio: "inherit", env });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const s of signals) process.off(s, forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/** Starts the Server, runs the Client against it, then stops the Server. */
export async function runLocal(options: ServerOptions & { client: readonly string[] }) {
  const server = await startServer(options);
  try {
    return await runForeground([...options.client, "--url", server.url], options.env);
  } finally {
    await server.stop();
  }
}
