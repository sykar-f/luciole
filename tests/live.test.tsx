/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch } from "./helpers";

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
  let server: Awaited<ReturnType<typeof launch>> | undefined, ui: any;
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await Bun.write(join(directory, name), text);
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const manifest = await Bun.file(join(directory, ".airtty/manifest.json")).json();
    const { createApp, Shell } = await import(join(directory, ".airtty/client/index.js"));
    const app = createApp({ url: server.url, initialPath: "/live" });
    await app.router.load();
    ui = await testRender(<Shell app={app} />, { width: 60, height: 5 });
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame() as string;
    };
    const stats = () => app.callServer(`${manifest.buildId}/actions/live.ts#stats`, []);
    await act(async () => {
      await Bun.sleep(200);
    });
    // Values keep arriving; only the latest `limit` are kept.
    const shown = (await frame()).match(/TICKS (\S+)/)![1].split(",");
    expect(shown).toHaveLength(3);
    expect(Number(shown[2].slice(1))).toBeGreaterThan(3);
    expect(await stats()).toEqual({ open: 1, closed: 0 });
    // Leaving the route cancels the request: the Server generator runs its finally.
    await act(async () => {
      await app.router.navigate({ to: "/" });
    });
    let last: unknown;
    const start = performance.now();
    while (performance.now() - start < 2000) {
      last = await stats();
      if ((last as { closed: number }).closed === 1) break;
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
    if (ui) await act(async () => ui.renderer.destroy());
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
