/** @jsxImportSource @opentui/react */
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Fetch } from "../src/client";
import { createForge } from "../examples/forge/server/forge";
import { openDatabase } from "../examples/forge/server/schema";
import { launch, until, importClient, metricsOf } from "./helpers";

export const forgeDirectory = resolve("examples/forge");

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
export async function startForge(options: Options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "forge-"));
  const database = join(temp, "forge.sqlite");
  const server = await launch(join(forgeDirectory, ".airtty/server/index.js"), {
    FORGE_DB: database,
    FORGE_SLOW_MS: "20",
    FORGE_CI_SCALE: "0.1",
    ...options.env,
  });
  const { createApp, Shell } = await importClient(forgeDirectory);
  const app = createApp({
    url: server.url,
    latencyMs: options.latencyMs ?? 0,
    fetch: options.fetch,
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
  const settle = (ms = 50) => step(() => Bun.sleep(ms));
  const path = () => app.router.state.resolvedLocation?.pathname;
  const waitFor = async (text: string, timeout = 5000) => {
    const start = performance.now();
    for (;;) {
      await settle(20);
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
  return { app, ui, server, operator, frame, step, settle, path, waitFor, metrics, signIn, stop };
}
export type ForgeHarness = Awaited<ReturnType<typeof startForge>>;
