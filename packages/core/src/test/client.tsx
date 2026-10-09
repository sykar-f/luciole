import { join } from "node:path";
import { act, type ReactNode } from "react";
import type { MouseButton } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { Application, ApplicationOptions, TransportEvent } from "../client";
import { until, untilDrawn, untilFrame, WAIT_MS, type TestUI } from "./wait";

/** What a generated Client's `createApp` takes: the build provides the rest. */
export type ClientOptions = Omit<ApplicationOptions, "routeTree" | "buildId" | "resolveModule">;

/**
 * The exports of a generated Client (`.luciole/client/index.js`). The bundle is untyped
 * JavaScript: its functions are checked to be there, their signatures are the build's contract.
 */
export type BuiltClient = {
  createApp: (options: ClientOptions) => Application;
  Shell: (props: { app: Application }) => ReactNode;
};
const isBuiltClient = (value: unknown): value is BuiltClient =>
  typeof value === "object" &&
  value !== null &&
  "createApp" in value &&
  typeof value.createApp === "function" &&
  "Shell" in value &&
  typeof value.Shell === "function";

/**
 * Imports the generated Client of the build in `directory`. A distinct `tag` gives a test its
 * own runtime (module registry, router, Drafts); the same tag shares it.
 */
export async function importClient(directory: string, tag?: string): Promise<BuiltClient> {
  const file = join(directory, ".luciole/client/index.js");
  const module: unknown = await import(tag ? `${file}?${tag}` : file);
  if (!isBuiltClient(module)) throw new Error(`${file} is not a generated Client`);
  return module;
}

/**
 * The requests `app` has on the wire, read from its transport events, and those that have
 * finished (`end` or `error`), in order. A teardown awaits `settled()` before it stops the
 * Server: a call left in flight, unawaited by the application or abandoned by a failed
 * assertion, would otherwise be cut into an unhandled TransportError.
 */
export function wire(app: Pick<Application, "onEvent">) {
  const open = new Set<number>();
  const finished: Extract<TransportEvent, { type: "end" | "error" }>[] = [];
  app.onEvent((event) => {
    if (event.type === "request") open.add(event.id);
    if (event.type !== "end" && event.type !== "error") return;
    open.delete(event.id);
    finished.push(event);
  });
  return { open, finished, settled: () => until(() => open.size === 0, WAIT_MS) };
}

/** Destroys a test renderer inside `act()`, when the test got as far as rendering. */
export async function destroy(ui: TestUI | undefined) {
  if (ui) await act(async () => ui.renderer.destroy());
}

/** Where `text` is drawn: its first cell, or undefined when the frame does not show it. */
export function cellOf(ui: TestUI, text: string) {
  const rows = ui.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  return y < 0 ? undefined : { x: rows[y]?.indexOf(text) ?? 0, y };
}
/** A left click on the first cell of `text`, as a user points at a label; fails if not shown. */
export async function clickOn(ui: TestUI, text: string, button?: MouseButton) {
  await ui.renderOnce();
  const cell = cellOf(ui, text);
  if (!cell) throw new Error(`Nothing to click: "${text}" is not shown\n${ui.captureCharFrame()}`);
  await ui.mockMouse.click(cell.x, cell.y, button);
}

/**
 * What `openClient` takes beyond the Client's own options (`fetch`, `transport`, …). Among
 * those, `latencyMs` and `network` set the network conditions of a test.
 */
export type OpenClientOptions = Omit<ClientOptions, "url"> & {
  /**
   * Shares a runtime (module registry, router, Drafts) between Clients: those opened with the
   * same tag share one. Without a tag, every Client gets a runtime of its own.
   */
  tag?: string;
  /** Columns of the test terminal. Default: `110`. */
  width?: number;
  /** Rows of the test terminal. Default: `32`. */
  height?: number;
};

/** The modifiers of a key press. */
export type KeyModifiers = { ctrl?: boolean; shift?: boolean; meta?: boolean };

/** A Client rendered in a test terminal, as `openClient` returns it. */
export type TestClient = {
  /** The running `Application`: its router, its restoration, its events. */
  app: Application;
  /** The test terminal: OpenTUI's renderer, `mockInput`, `mockMouse` and frame captures. */
  ui: TestUI;
  /** The requests on the wire. `await client.requests.settled()` before stopping the Server. */
  requests: ReturnType<typeof wire>;
  /**
   * Renders until the screen shows `text`, and returns that frame. Fails with the last frame
   * after `timeout` milliseconds (default: `WAIT_MS`).
   */
  waitFor(text: string, timeout?: number): Promise<string>;
  /**
   * Renders until the screen shows `text` and has stopped changing: no code block is still
   * highlighting, no image still loading. Returns that frame. Without `text`, waits for the
   * screen to settle.
   */
  settled(text?: string): Promise<string>;
  /** The screen now, as text. */
  frame(): Promise<string>;
  /** A left click on the first cell of `text`; fails when the screen does not show it. */
  click(text: string, button?: MouseButton): Promise<void>;
  /** Presses a key, `"s"` with `{ ctrl: true }` for Ctrl+S, or `"return"`, `"escape"`, … */
  press(key: string, modifiers?: KeyModifiers): Promise<void>;
  /** Types `text` one character at a time. */
  type(text: string): Promise<void>;
  /**
   * Waits for the requests still on the wire, then destroys the terminal. Stopping twice is
   * harmless. It does not stop the Server.
   */
  stop(): Promise<void>;
  /** Same as `stop()`, for `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Renders the Client of a built app in a test terminal, connected to `server`: the journey of
 * a user's screen, without a pty. It imports the generated Client, creates the app, loads
 * the first page and draws the `Shell`. Each Client has a runtime of its own, so nothing one
 * leaves (a draft, a route) reaches the next; pass the same `tag` to share one. Declare it
 * after the Server with `await using`, so the screen is released first.
 */
export async function openClient(
  app: { directory: string },
  server: { url: string },
  options: OpenClientOptions = {},
): Promise<TestClient> {
  const { tag, width = 110, height = 32, ...clientOptions } = options;
  const { createApp, Shell } = await importClient(app.directory, tag ?? crypto.randomUUID());
  const running = createApp({ url: server.url, ...clientOptions });
  const requests = wire(running);
  await running.router.load();
  const ui = await testRender(<Shell app={running} />, { width, height });
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      // The calls still on the wire end before the Server they talk to stops.
      await act(() => requests.settled().catch(() => {}));
      await destroy(ui);
    })());
  return {
    app: running,
    ui,
    requests,
    // Inside `act()` for the whole wait: timers of the app update its state meanwhile.
    waitFor: (text, timeout) => act(() => untilFrame(ui, text, timeout)),
    settled: (text) => act(() => untilDrawn(ui, text)),
    frame: async () => {
      await ui.renderOnce();
      return ui.captureCharFrame();
    },
    click: (text, button) => act(() => clickOn(ui, text, button)),
    press: (key, modifiers) =>
      act(async () => {
        ui.mockInput.pressKey(key, modifiers);
      }),
    type: (text) =>
      act(async () => {
        await ui.mockInput.typeText(text);
      }),
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
