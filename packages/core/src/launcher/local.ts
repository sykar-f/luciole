/**
 * An app on this machine: its Server on a Unix socket of this user (no TCP port, nothing
 * to collide with, nothing another user can reach), its Client in the terminal. The
 * Server's lifetime follows its Clients (src/launcher/lifetime.ts, managed.ts).
 */
import { spawn } from "node:child_process";
import { ensureServer, newClientId, type EnsureOptions } from "./managed";

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

/**
 * Finds or starts the Server of `sessionKey`, runs the Client against it, then lets go.
 * A Client that quits on purpose stops the Server (when it was the last); one that dies
 * leaves it in grace, where the next launch of the same target finds it.
 */
export async function runLocal(
  options: Omit<EnsureOptions, "client" | "attach"> & {
    client: readonly string[];
    sessionKey: string;
    /** The session file a crashed Client left, claimed for this one (launch-key.ts). */
    session?: string;
  },
) {
  const client = newClientId();
  const server = await ensureServer({ ...options, client, attach: true });
  try {
    return await runForeground([...options.client, "--url", server.url], {
      ...(options.env ?? process.env),
      LUCIOLE_SESSION_KEY: options.sessionKey,
      LUCIOLE_LIFETIME_CLIENT: client,
      ...(options.session ? { LUCIOLE_SESSION: options.session } : {}),
    });
  } finally {
    server.release();
  }
}
