/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import type { ApplicationEvent } from "../src/client";
import { destroy, importClient, launch, until, type TestUI } from "./helpers";

// Two cached reads with their own tag, an action that invalidates one tag, a page with a
// router staleTime, and the SQLite handler chosen by server/cache.ts.
const files: Record<string, string> = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return <box flexDirection="column">{children}</box>}`,
  "app/a/page.tsx": `import {Bump} from "../../components/Bump";import {readA} from "../../server/queries";export default async function A(){const a=await readA();return <box flexDirection="column"><text>A {a.value} runs {a.runs}</text><Bump/></box>}`,
  "app/b/page.tsx": `import {readB} from "../../server/queries";export default async function B(){const b=await readB();return <text>B {b.value} runs {b.runs}</text>}`,
  "app/c/page.tsx": `export const staleTime = 60;export default function C(){return <text>C page</text>}`,
  "components/Bump.tsx": `"use client";import {useKeyboard} from "@opentui/react";import {bumpA} from "../actions/data";export function Bump(){useKeyboard(k=>{if(k.name==="b")void bumpA()});return <text>press b</text>}`,
  "actions/data.ts": `"use server";import {invalidate} from "airtty/server";import {write} from "../server/store";export async function bumpA(){write("a");invalidate({tag:"a"});return "done"}`,
  "server/store.ts": `const values={a:0,b:0},runs={a:0,b:0};export const read=(k)=>values[k];export function write(k){values[k]++}export function ran(k){return ++runs[k]}`,
  "server/queries.ts": `"use cache";import {cacheTag} from "airtty/server";import {read,ran} from "./store";export async function readA(){cacheTag("a");return {value:read("a"),runs:ran("a")}}export async function readB(){cacheTag("b");return {value:read("b"),runs:ran("b")}}`,
  "server/cache.ts": `import {sqliteCache} from "airtty/server";export default sqliteCache({path:process.env.CACHE_DB??"cache.sqlite"});`,
};

test("a tag invalidation purges the Server cache and revalidates only the routes that read it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-cache-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await Bun.write(join(directory, name), text);
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await build(directory);
    expect(await readFile(join(directory, "app/routeTree.gen.ts"), "utf8")).toContain(
      "staleTime: 60000,",
    );
    const running = await launch(join(directory, ".airtty/server/index.js"), {
      CACHE_DB: join(directory, "cache.sqlite"),
    });
    server = running;
    const { createApp, Shell } = await importClient(directory);
    const renders: string[] = [];
    const headers = new Map<string, string | null>();
    const events: ApplicationEvent[] = [];
    const app = createApp({
      url: running.url,
      initialPath: "/b",
      fetch: async (input: URL, init: RequestInit) => {
        const route = input.searchParams.get("route");
        if (route) renders.push(route);
        const response = await fetch(input, init);
        if (route) headers.set(route, response.headers.get("x-airtty-tags"));
        return response;
      },
    });
    app.onEvent((event) => events.push(event));
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 60, height: 8 });
    rendered = ui;
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame();
    };
    expect(await frame()).toContain("B 0 runs 1");
    expect(headers.get("/b")).toBe("b");
    await act(async () => {
      await app.router.navigate({ to: "/a" });
    });
    expect(await frame()).toContain("A 0 runs 1");
    // Rendered again (staleTime 0): the Server answers from its cache, the function never runs.
    await act(async () => {
      await app.router.navigate({ to: "/b" });
      await app.router.navigate({ to: "/a" });
    });
    await act(() => Bun.sleep(50));
    expect(renders.filter((r) => r === "/a").length).toBeGreaterThan(1);
    expect(await frame()).toContain("A 0 runs 1");

    renders.length = 0;
    events.length = 0;
    await act(async () => {
      await ui.mockInput.typeText("b");
      await until(() => renders.length > 0);
      await Bun.sleep(80);
    });
    expect(await frame()).toContain("A 1 runs 2");
    // /b is in the router's cache but read only tag "b": never refetched.
    expect(renders).toEqual(["/a"]);
    expect(events.find((e) => e.type === "invalidate")).toMatchObject({
      paths: [],
      tags: ["a"],
      origin: "server",
    });

    // A page within its staleTime is shown from the router's cache, without a request.
    await act(async () => {
      await app.router.navigate({ to: "/c" });
      await app.router.navigate({ to: "/a" });
    });
    renders.length = 0;
    events.length = 0;
    await act(async () => {
      await app.router.navigate({ to: "/c" });
    });
    expect(await frame()).toContain("C page");
    expect(renders).toEqual([]);
    const loaders = events.flatMap((e) =>
      e.type === "loader" ? [[e.phase, e.routeId, e.source]] : [],
    );
    expect(loaders).toEqual([["end", "/c", "router-cache"]]);
    // A network load says so.
    events.length = 0;
    await act(async () => {
      await app.router.navigate({ to: "/a" });
    });
    await act(() => Bun.sleep(50));
    expect(
      events.find((e) => e.type === "loader" && e.routeId === "/a" && e.phase === "end"),
    ).toMatchObject({ source: "network", result: "ok" });
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
