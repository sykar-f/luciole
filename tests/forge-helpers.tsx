/** @jsxImportSource @opentui/react */
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Fetch } from "../packages/core/src/client";
import { createForge } from "../examples/forge/server/forge";
import { openDatabase } from "../examples/forge/server/schema";
import {
  launch,
  until,
  importClient,
  metricsOf,
  wire,
  WAIT_MS,
  type PrivateBuild,
  type TestUI,
} from "./helpers";

export const forgeDirectory = resolve("examples/forge");

// A step of `waitFor`'s poll: the wait ends on the frame, WAIT_MS only guards a hang.
const POLL_MS = 20;

/**
 * The bytes OpenTUI's stdin parser holds back: a lone ESC stays there until the parser's
 * pause has passed (ESC followed at once by "/" is Alt+/), then is read as Escape. Read
 * through `Reflect`, the parser being private; one that changed shape fails the wait.
 */
function unread(ui: TestUI) {
  const parser: unknown = Reflect.get(ui.renderer, "stdinParser");
  const pending: unknown =
    typeof parser === "object" && parser !== null ? Reflect.get(parser, "pending") : undefined;
  const length: unknown =
    typeof pending === "object" && pending !== null ? Reflect.get(pending, "length") : undefined;
  if (typeof length !== "number") throw new Error("OpenTUI's stdin parser has no pending bytes");
  return length;
}

type Options = {
  env?: Record<string, string>;
  latencyMs?: number;
  width?: number;
  height?: number;
  fetch?: Fetch;
};

/**
 * A real Forge Server (temporary database) and a real generated Client rendered in
 * OpenTUI's test renderer. `operator` opens the same database as a second process
 * would: it pushes revisions, edits descriptions and arms lost responses.
 */
export async function startForge(built: PrivateBuild, options: Options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "forge-"));
  const database = join(temp, "forge.sqlite");
  const server = await launch(join(built.output, "server/index.js"), {
    FORGE_DB: database,
    FORGE_SLOW_MS: "20",
    FORGE_CI_SCALE: "0.1",
    ...options.env,
  });
  const { createApp, Shell } = await importClient(built.directory);
  const app = createApp({
    url: server.url,
    latencyMs: options.latencyMs ?? 0,
    fetch: options.fetch,
  });
  const requests = wire(app);
  // Preloads that loaded the page, and how many `preloaded()` has awaited.
  let preloads = 0;
  let awaited = 0;
  app.onEvent((event) => {
    if (event.type !== "loader" || event.phase !== "end") return;
    if (event.cause === "preload" && event.result === "ok") preloads++;
  });
  await app.router.load();
  const ui = await testRender(<Shell app={app} />, {
    width: options.width ?? 140,
    height: options.height ?? 40,
  });
  const db = openDatabase(database);
  const operator = createForge(db);
  const frame = async () => {
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  /** One React batch per call: a real terminal delivers separate reads. */
  const step = (work: () => unknown) =>
    act(async () => {
      await work();
    });
  /**
   * Waits until what the test sent has had its effect: every key read (a lone Escape once
   * the parser's pause has passed), what the keys set off started, and every request on
   * the wire answered. A request that a key would send, it would send by then.
   */
  const settle = () =>
    step(async () => {
      await until(() => unread(ui) === 0, WAIT_MS, () => `${unread(ui)} bytes unread`);
      // A turn of the event loop, not a delay: what the keys set off runs first.
      await new Promise<void>((done) => setImmediate(done));
      await requests.settled();
    });
  /**
   * Waits until a preload not awaited yet (the pull request the list selects) has loaded
   * its page, and nothing more is on the wire.
   */
  const preloaded = async () => {
    await step(() => until(() => preloads > awaited));
    awaited = preloads;
    await settle();
  };
  /**
   * A negative wait: lets `ms` pass for what must not happen (a request) to have had the
   * time to. Nothing marks a request that is never sent, so this one waits on the clock.
   */
  const quietFor = (ms: number) => step(() => Bun.sleep(ms));
  const path = () => app.router.state.resolvedLocation?.pathname;
  const waitFor = async (text: string, timeout = WAIT_MS) => {
    const start = performance.now();
    for (;;) {
      await step(() => Bun.sleep(POLL_MS));
      const shown = await frame();
      if (shown.includes(text)) return shown;
      if (performance.now() - start > timeout)
        throw new Error(`Frame never showed ${JSON.stringify(text)}:\n${shown}`);
    }
  };
  const probe = operator.login("carol", "forge");
  if (!probe.ok) throw new Error(probe.error);
  /** Server counters (test mode only): renders and actions since start. */
  const metrics = () => metricsOf(server, { authorization: `Bearer ${probe.token}` });
  async function signIn(user: string) {
    await until(() => path() === "/login");
    await step(() => ui.mockInput.typeText(user));
    await step(() => ui.mockInput.pressEnter());
    await step(() => ui.mockInput.typeText("forge"));
    await step(() => ui.mockInput.pressEnter());
    await step(() => until(() => path() === "/"));
    await waitFor(`@${user} ·`);
  }
  async function stop() {
    await act(async () => ui.renderer.destroy());
    await server.stop();
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
  return {
    app,
    ui,
    server,
    operator,
    frame,
    step,
    settle,
    preloaded,
    quietFor,
    path,
    waitFor,
    metrics,
    signIn,
    stop,
  };
}
export type ForgeHarness = Awaited<ReturnType<typeof startForge>>;
