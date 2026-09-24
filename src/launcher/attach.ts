/**
 * A Server started by the launcher lives as long as its Client. The launcher keeps the
 * Server's stdin open and never writes to it: when the launcher ends, even killed with
 * SIGKILL, or when ssh drops the connection to a remote Server, stdin reaches its end
 * and the Server stops. No pid files, no polling.
 */
export const ATTACHED_FLAG = "--attached";

export function exitWithStdin() {
  const stop = () => process.kill(process.pid, "SIGTERM");
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.stdin.resume();
}
