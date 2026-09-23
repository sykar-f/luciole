/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { z } from "zod";
import { launch, importClient, readManifest, destroy, type TestUI } from "./helpers";

// What the `stats` Server Function of the fixture returns.
const Stats = z.strictObject({ open: z.number(), closed: z.number() });

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return <box flexDirection="column">{children}</box>}`,
  "app/page.tsx": `export default function Home(){return <text>HOME</text>}`,
  "app/live/page.tsx": `import {Ticker} from "../../components/Ticker";export default function Live(){return <Ticker/>}`,
  "components/Ticker.tsx": `"use client";import {useLive} from "airtty/client";import {ticks} from "../actions/live";export function Ticker(){const {items,done,error}=useLive(ticks,["t"],{limit:3});return <text>TICKS {items.join(",")} {done?"DONE":""} {error?"ERROR "+String(error.outcome):""}</text>}`,
  "actions/live.ts": `"use server";import {status} from "../server/status";export async function* ticks(prefix:string){status.open++;try{for(let i=0;;i++){yield prefix+i;await Bun.sleep(20)}}finally{status.closed++}}export async function stats(){return {...status}}`,
  "server/status.ts": `export const status={open:0,closed:0};`,
};

test("useLive streams a Server generator while mounted and stops it on unmount", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-live-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await Bun.write(join(directory, name), text);
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const manifest = await readManifest(directory);
    const { createApp, Shell } = await importClient(directory);
    const app = createApp({ url: server.url, initialPath: "/live" });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 60, height: 5 });
    rendered = ui;
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame();
    };
    const stats = async () =>
      Stats.parse(await app.callServer(`${manifest.buildId}/actions/live.ts#stats`, []));
    await act(async () => {
      await Bun.sleep(200);
    });
    // Values keep arriving; only the latest `limit` are kept.
    const ticks = /TICKS (\S+)/.exec(await frame());
    expect(ticks).not.toBeNull();
    const shown = (ticks?.[1] ?? "").split(",");
    expect(shown).toHaveLength(3);
    expect(Number(shown[2].slice(1))).toBeGreaterThan(3);
    expect(await stats()).toEqual({ open: 1, closed: 0 });
    // Leaving the route cancels the request: the Server generator runs its finally.
    await act(async () => {
      await app.router.navigate({ to: "/" });
    });
    let last: z.infer<typeof Stats> | undefined;
    const start = performance.now();
    while (performance.now() - start < 2000) {
      last = await stats();
      if (last.closed === 1) break;
      await Bun.sleep(20);
    }
    expect(last).toEqual({ open: 1, closed: 1 });

    // A lost Server ends the stream with an error the application can read.
    await act(async () => {
      await app.router.navigate({ to: "/live" });
      await Bun.sleep(100);
    });
    await server.stop();
    await act(async () => {
      await Bun.sleep(100);
    });
    expect(await frame()).toContain("ERROR unknown");
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
