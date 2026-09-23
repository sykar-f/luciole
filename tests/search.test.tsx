/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { RouterHistory } from "@tanstack/react-router";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, importClient, destroy, metricsOf, type TestUI } from "./helpers";

// `AnyRouter` types its history as `any`: checked before use.
const isHistory = (value: unknown): value is RouterHistory =>
  typeof value === "object" &&
  value !== null &&
  "back" in value &&
  typeof value.back === "function";

test("search parameters reach the Server page as strings and key the route cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-search-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    for (const name of ["app/items"]) await mkdir(join(directory, name), { recursive: true });
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/items/page.tsx"),
      `export default function Page({searchParams}:{searchParams:Record<string,string>}){return <text>ITEMS q={JSON.stringify(searchParams.q ?? null)} keys={Object.keys(searchParams).join(",")}</text>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `export default function Page(){return <text>HOME</text>}`,
    );
    await build(directory);
    const running = await launch(join(directory, ".airtty/server/index.js"));
    server = running;
    const { createApp, Shell } = await importClient(directory);
    const app = createApp({ url: running.url });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 8 });
    rendered = ui;
    const renders = async () => (await metricsOf(running)).renders;
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame();
    };
    const go = (search?: Record<string, string>) =>
      act(async () => {
        await app.router.navigate({ to: "/items", search });
      });

    await go({ q: "refund", state: "open" });
    expect(await frame()).toContain('ITEMS q="refund" keys=q,state');
    expect(app.router.state.location.href).toBe("/items?q=refund&state=open");
    await go({ q: "42" });
    // A numeric-looking value stays the string the user typed.
    expect(await frame()).toContain('ITEMS q="42" keys=q');
    await go();
    expect(await frame()).toContain("ITEMS q=null keys=");
    const before = await renders();
    // Back to a cached search: shown at once from its own cache entry.
    await act(async () => {
      const history: unknown = app.router.history;
      if (!isHistory(history)) throw new Error("The router has no history");
      history.back();
      await Bun.sleep(30);
    });
    expect(await frame()).toContain('ITEMS q="42" keys=q');
    expect(app.router.state.location.search).toEqual({ q: "42" });
    expect(await renders()).toBeGreaterThanOrEqual(before);
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
