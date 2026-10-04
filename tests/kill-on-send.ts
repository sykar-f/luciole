/**
 * Preloaded into a Client (tests/restore-submit-kill.test.ts): the first call of the action
 * named `KILL_ON_ACTION` kills it with SIGKILL as the request leaves, after leaving the file
 * `KILLED_ON_SEND` behind to say so. No handler runs, nothing is written on the way out: a
 * crash in the middle of a send. Other actions (Notes lists its notes with one) go through.
 */
import { writeFileSync } from "node:fs";

const action = process.env.KILL_ON_ACTION;
const marker = process.env.KILLED_ON_SEND;
if (!action || !marker) throw new Error("KILL_ON_ACTION and KILLED_ON_SEND are both needed");
const send = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  // src/transport.ts names the action called in this header: `<module>#<export>`.
  const called = new Headers(init?.headers).get("x-luciole-action");
  if (called?.endsWith(`#${action}`)) {
    writeFileSync(marker, called);
    process.kill(process.pid, "SIGKILL");
  }
  return send(input, init);
}, send);
