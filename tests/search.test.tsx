/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch } from "./helpers";

test("search parameters reach the Server page as strings and key the route cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-search-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, ui: any;
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
    server = await launch(join(directory, ".airtty/server/index.js"));
    const { createApp, Shell } = await import(join(directory, ".airtty/client/index.js"));
    const app = createApp({ url: server.url });
    await app.router.load();
    ui = await testRender(<Shell app={app} />, { width: 80, height: 8 });
    const renders = async () =>
      (
        await (
          await fetch(`${server!.url}/test-metrics`, {
            headers: { "x-airtty-build": server!.buildId },
          })
        ).json()
      ).renders;
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame() as string;
    };
    const go = (options: object) =>
      act(async () => {
        await app.router.navigate(options);
      });

    await go({ to: "/items", search: { q: "refund", state: "open" } });
    expect(await frame()).toContain('ITEMS q="refund" keys=q,state');
    expect(app.router.state.location.href).toBe("/items?q=refund&state=open");
    await go({ to: "/items", search: { q: "42" } });
    // A numeric-looking value stays the string the user typed.
    expect(await frame()).toContain('ITEMS q="42" keys=q');
    await go({ to: "/items" });
    expect(await frame()).toContain("ITEMS q=null keys=");
    const before = await renders();
    // Back to a cached search: shown at once from its own cache entry.
    await act(async () => {
      app.router.history.back();
      await Bun.sleep(30);
    });
    expect(await frame()).toContain('ITEMS q="42" keys=q');
    expect(app.router.state.location.search).toEqual({ q: "42" });
    expect(await renders()).toBeGreaterThanOrEqual(before);
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
