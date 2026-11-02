/** Isolated run() with a controlled renderer.closed rejection and IPC barriers. */
import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import * as core from "@opentui/core";
import { createRootRoute } from "@tanstack/react-router";
import { Application } from "../packages/core/src/client";

const message = "NativeSession graceful close ran late; queued output was dropped";
const late = new Error(message);
const rejection = process.env.CLOSE_KIND === "lookalike" ? new Error(message) : late;
const closed = Promise.withResolvers<void>();
const session = {
  late,
  isCloseInterruption(error: unknown) {
    return error === this.late && process.env.CLOSE_KIND !== "unrestored";
  },
};
const renderer = {
  closed: closed.promise,
  keyInput: new EventEmitter(),
  isDestroyed: false,
  ...(process.env.CLOSE_KIND === "missing"
    ? {}
    : {
        nativeSession:
          process.env.CLOSE_KIND === "nonfunction" ? { isCloseInterruption: true } : session,
      }),
  destroy() {
    this.isDestroyed = true;
    closed.reject(rejection);
  },
};
void mock.module(resolve("packages/core/src/connect.ts"), () => ({
  serverUrl: async () => "http://localhost",
  connect: async () => ({ url: "http://localhost", close() {} }),
}));
void mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async () => renderer,
}));
void mock.module("@opentui/react", () => ({
  createRoot: () => ({ render() {} }),
}));
const { run } = await import("../packages/core/src/run");
let app: Application;
process.on("message", () => {
  if (process.env.CLOSE_END === "quit") app.quit?.();
  else if (process.env.CLOSE_END === "failure") closed.reject(rejection);
  else process.kill(process.pid, process.env.CLOSE_END as NodeJS.Signals);
});
await run(
  (options) =>
    (app = new Application({
      ...options,
      buildId: "late-close-test",
      routeTree: createRootRoute(),
      resolveModule() {
        throw new Error("No modules in late close fixture");
      },
    })),
  { name: "late-close", sessionKey: "late-close" },
);
process.send?.({ ready: true });
