/** Isolated Client: real renderer, controlled connection and an IPC quit barrier. */
import { mock } from "bun:test";
import { closeSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@opentui/core";
import { createRootRoute } from "@tanstack/react-router";
import { Application } from "../packages/core/src/client";

const mode = process.env.QUIT_FAILURE;
const createRenderer = core.createCliRenderer;
void mock.module(resolve("packages/core/src/connect.ts"), () => ({
  serverUrl: async () => "http://localhost",
  connect: async () => ({
    url: "http://localhost",
    close() {},
    managed: {
      watch() {},
      async leave() {
        const response = await fetch(String(process.env.QUIT_EVENTS), { method: "POST" });
        if (!response.ok) throw new Error("leave failed");
        if (mode === "closed-output") closeSync(1);
        else {
          const lib = core.resolveRenderLib();
          lib.sessionDrainStdout = () => {
            if (mode === "lookalike")
              throw new Error("ot_session_drain_stdout failed: OutputFailed");
            throw new core.NativeError(
              mode === "other-operation" ? "ot_scene_flush" : "ot_session_drain_stdout",
              mode === "internal"
                ? core.NativeStatus.InternalError
                : core.NativeStatus.OutputFailed,
            );
          };
        }
      },
    },
  }),
}));
void mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async (options: core.CliRendererConfig) => {
    const renderer = await createRenderer(options);
    void renderer.closed.catch((error: unknown) => {
      process.send?.({
        failure: error instanceof core.NativeError ? error.status : "Error",
        operation: error instanceof core.NativeError ? error.operation : undefined,
      });
    });
    return renderer;
  },
}));
void mock.module("@opentui/react", () => ({
  createRoot: () => ({
    render() {
      process.send?.({ ready: true });
    },
  }),
}));
const { run } = await import("../packages/core/src/run");
let app: Application;
process.once("message", () => {
  if (process.env.QUIT_INTERRUPTED) {
    closeSync(1);
    process.kill(process.pid, "SIGTERM");
  } else app.quit?.();
});
await run(
  (options) =>
    (app = new Application({
      ...options,
      buildId: "quit-test",
      routeTree: createRootRoute(),
      resolveModule: async () => {
        throw new Error("No modules in quit fixture");
      },
    })),
  { name: "quit", sessionKey: "quit" },
);
