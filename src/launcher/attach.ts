/**
 * A Server started by the launcher lives as long as its Client. The launcher keeps the
 * Server's stdin open and never writes to it: when the launcher ends, even killed with
 * SIGKILL, or when ssh drops the connection to a remote Server, stdin reaches its end
 * and the Server stops. No pid files, no polling.
 */
import { rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export const ATTACHED_FLAG = "--attached";

/**
 * Stops the Server when stdin ends. Its socket and the directory made for it are removed
 * on the way out (serve() exits before Bun's own unlink runs): a launcher that died
 * leaves nothing behind.
 */
export function exitWithStdin(socket = process.env.AIRTTY_SOCKET) {
  const stop = () => process.kill(process.pid, "SIGTERM");
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.resume();
  if (socket)
    process.on("exit", () => {
      rmSync(socket, { force: true });
      try {
        rmdirSync(dirname(socket));
      } catch {
        // Already gone (the launcher removed it), or holding something else: kept.
      }
    });
}
