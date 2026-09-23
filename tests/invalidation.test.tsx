/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until } from "./helpers";

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";import {useState} from "react";import {useInvalidation} from "airtty/client";import {counts} from "../actions/data";export default function Layout({children}){const [seen,setSeen]=useState("none");useInvalidation(paths=>{setSeen(paths.join(","));void counts().then(()=>{})});return <box flexDirection="column"><text>SEEN {seen}</text>{children}</box>}`,
  "app/a/page.tsx": `import {Bump} from "../../components/Bump";import {read} from "../../server/store";export default function A(){return <box flexDirection="column"><text>A {read("a")}</text><Bump/></box>}`,
  "app/b/page.tsx": `import {read} from "../../server/store";export default function B(){return <text>B {read("b")}</text>}`,
  "components/Bump.tsx": `"use client";import {useKeyboard} from "@opentui/react";import {bump,quiet} from "../actions/data";export function Bump(){useKeyboard(k=>{if(k.name==="b")void bump();if(k.name==="q")void quiet()});return <text>press b</text>}`,
  "actions/data.ts": `"use server";import {invalidate} from "airtty/server";import {write} from "../server/store";export async function bump(){write("a");write("b");invalidate("/a");return "done"}export async function quiet(){write("a");return "quiet"}export async function counts(){return 1}`,
  "server/store.ts": `const values={a:0,b:0};export const read=(k)=>values[k];export function write(k){values[k]++}`,
};

test("a Server Function revalidates only the routes it declares changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-invalidate-"));
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
    const renders: string[] = [];
    const app = createApp({
      url: server.url,
      initialPath: "/b",
      fetch: (input: string, init: RequestInit) => {
        const route = new URL(String(input)).searchParams.get("route");
        if (route) renders.push(route);
        return fetch(input, init);
      },
    });
    await app.router.load();
    ui = await testRender(<Shell app={app} />, { width: 60, height: 8 });
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame() as string;
    };
    // /b is cached; /a is mounted.
    await act(async () => {
      await app.router.navigate({ to: "/a" });
    });
    expect(await frame()).toContain("A 0");
    renders.length = 0;
    await act(async () => {
      await ui.mockInput.typeText("b");
      await until(() => renders.length > 0);
      await Bun.sleep(50);
    });
    expect(await frame()).toContain("A 1");
    expect(await frame()).toContain("SEEN /a");
    expect(renders).toEqual(["/a"]);
    // The declared path selects its route and descendants, never a mere prefix.
    const filters: ((m: { pathname: string }) => boolean)[] = [];
    const invalidate = app.router.invalidate.bind(app.router);
    app.router.invalidate = (opts: { filter?: (m: { pathname: string }) => boolean }) => {
      if (opts?.filter) filters.push(opts.filter);
      return invalidate(opts);
    };
    await act(async () => {
      await ui.mockInput.typeText("b");
      await Bun.sleep(80);
    });
    expect(await frame()).toContain("A 2");
    const selected = ["/a", "/a/x", "/ab", "/b"].filter((pathname) => filters[0]({ pathname }));
    expect(selected).toEqual(["/a", "/a/x"]);
    // Without invalidate(), nothing is refetched.
    await act(async () => {
      await app.router.navigate({ to: "/a" });
    });
    renders.length = 0;
    const result = await act(() => app.callServer(`${manifest.buildId}/actions/data.ts#quiet`, []));
    expect(result).toBe("quiet");
    await act(() => Bun.sleep(50));
    expect(renders).toEqual([]);
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
