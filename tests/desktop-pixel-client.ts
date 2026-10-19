/** Isolated run() on a PTY: real stock/prepared renderer, controlled connection. */
import { mock } from "bun:test";
import { resolve } from "node:path";
import { createRootRoute } from "@tanstack/react-router";
import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import { detectOpenTuiMouseObserver } from "../packages/core/src/opentui-seams";

// eslint-disable-next-line typescript/no-unsafe-assignment -- Opt-in entry supplies the same OpenTUI exports as the stock module.
const core: typeof import("@opentui/core") = await import(
  process.env.DESKTOP_PIXEL_CORE ?? "@opentui/core"
);
const createRenderer = core.createCliRenderer;
const mode = process.env.DESKTOP_PIXEL_CASE;
let active: CliRenderer;
let observed = 0;
let detached = false;
void mock.module(resolve("packages/core/src/connect.ts"), () => ({
  serverUrl: async () => "http://localhost",
  connect: async () => ({ url: "http://localhost", close() {} }),
}));
void mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async (options: CliRendererConfig) => {
    active = await createRenderer(options);
    const reportError = console.error.bind(console);
    console.error = (error: unknown) => {
      process.send?.({ failure: error instanceof Error ? error.message : String(error) });
      reportError(error);
    };
    // Structural seams let the stock runtime exercise host gating and rejection.
    // The fractional journey below uses the prepared runtime's actual methods.
    if (mode !== "stock" && !process.env.DESKTOP_PIXEL_CORE)
      Object.assign(active, {
        setFramePlan() {},
        captureHitMap() {},
        dispatchMouseEventFromHitMap() {
          return false;
        },
        writeControl: async () => {
          if (mode === "reject") throw new Error("desktop control write rejected");
        },
        observeMouseInput: () => () => {
          detached = true;
        },
      });
    if (mode === "missing-writer") Reflect.deleteProperty(active, "writeControl");
    if (mode === "missing-observer") Reflect.deleteProperty(active, "observeMouseInput");
    if (mode === "missing-frame") Reflect.deleteProperty(active, "setFramePlan");
    const observer = detectOpenTuiMouseObserver(active);
    if (observer.available) {
      const observe = observer.renderer.observeMouseInput.bind(active);
      Object.assign(active, {
        observeMouseInput(receive: (raw: string) => void) {
          const unsubscribe = observe((raw) => {
            observed++;
            process.send?.({ observed: true });
            receive(raw);
          });
          process.send?.({ attached: true });
          return () => {
            unsubscribe();
            detached = true;
          };
        },
      });
    }
    active.on("destroy", () => {
      // The attachment's destroy listener runs in the same emission.
      queueMicrotask(() => process.send?.({ destroyed: true, detached, observed }));
    });
    return active;
  },
}));
const react = await import("@opentui/react");
void mock.module("@opentui/react", () => ({
  ...react,
  createRoot: (renderer: CliRenderer) => ({
    render() {
      const scroll = new core.ScrollBoxRenderable(renderer, {
        width: 30,
        height: 6,
        onMouseScroll() {
          queueMicrotask(() => process.send?.({ rowScroll: scroll.scrollTop }));
        },
      });
      for (let i = 0; i < 30; i++)
        scroll.add(new core.TextRenderable(renderer, { content: `Desktop row ${i}`, height: 1 }));
      renderer.root.add(scroll);
      renderer.requestRender();
      process.send?.({ ready: true });
    },
  }),
}));
const { Application } = await import("../packages/core/src/client");
const { run } = await import("../packages/core/src/run");
let app: InstanceType<typeof Application>;
process.on("message", () => app.quit?.());
await run(
  (options) =>
    (app = new Application({
      ...options,
      buildId: "desktop-pixel-test",
      routeTree: createRootRoute(),
      resolveModule() {
        throw new Error("No modules in desktop pixel fixture");
      },
    })),
  {
    name: "desktop-pixel",
    sessionKey: "desktop-pixel",
    ...(mode?.startsWith("launch-") ? {} : { pixelScroll: mode !== "disabled" }),
  },
);
