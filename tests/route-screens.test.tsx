/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/airtty/src/build";
import { compileRouteGraph } from "../packages/airtty/src/route-graph";
import { launch, importClient, readManifest, destroy, type TestUI } from "./helpers";

/** The layout's mount stamp: unchanged while the layout stays mounted. */
const layoutOf = (frame: string) => /LAYOUT (\d+)/.exec(frame)?.[1];

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";import {useState} from "react";export default function Layout({children}){const [mounted]=useState(()=>String(Math.random()).slice(2,8));return <box flexDirection="column"><text id="layout">LAYOUT {mounted}</text>{children}</box>}`,
  "app/page.tsx": `export default function Page(){return <text>HOME</text>}`,
  "app/not-found.tsx": `"use client";export default function Missing({path}){return <text>NO ROUTE {path}</text>}`,
  "app/error.tsx": `"use client";import {useKeyboard} from "@opentui/react";export default function Failure({error,retry}){useKeyboard(k=>{if(k.name==="r")void retry()});return <text>FAILED {error.message} [{String(error.outcome)}]</text>}`,
  "app/items/[id]/page.tsx": `import {notFound} from "airtty/server";export default async function Item({params}){if(params.id==="9")notFound("Item 9");return <text>ITEM {params.id}</text>}`,
  "app/items/not-found.tsx": `"use client";export default function Missing({what,params}){return <text>MISSING {what} (id {params.id})</text>}`,
  "app/boom/page.tsx": `let calls=0;export default async function Boom(){calls++;if(calls===1)throw new Error("secret detail");return <text>RECOVERED {calls}</text>}`,
  "app/docs/[...slug]/page.tsx": `export default function Docs({params}){return <text>DOC {params.slug}</text>}`,
  "app/docs/[section]/page.tsx": `export default function Section({params}){return <text>SECTION {params.section}</text>}`,
};

test("error.tsx, notFound() and catch-all routes render inside the persistent layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-screens-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await Bun.write(join(directory, name), text);
    }
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await build(directory);
    const manifest = await readManifest(directory);
    expect(manifest.routes.find((r: { id: string }) => r.id === "/items/[id]")).toMatchObject({
      error: "app/error.tsx",
      notFound: "app/items/not-found.tsx",
    });
    // Production Flight sends a Server exception without its message or stack.
    const production = await launch(join(directory, ".airtty/server/index.js"), {
      NODE_ENV: "production",
    });
    try {
      const body = await (
        await fetch(`${production.url}/render?route=%2Fboom&params=%7B%7D`, {
          headers: { "x-airtty-build": manifest.buildId },
        })
      ).text();
      expect(body).toContain("Server render failed");
      expect(body).not.toContain("secret detail");
    } finally {
      await production.stop();
    }
    const running = await launch(join(directory, ".airtty/server/index.js"));
    server = running;
    const { createApp, Shell } = await importClient(directory);
    const app = createApp({ url: running.url });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 10 });
    rendered = ui;
    const frame = async () => {
      await ui.renderOnce();
      return ui.captureCharFrame();
    };
    const go = (href: string) =>
      act(async () => {
        await app.router.navigate({ href });
        await Bun.sleep(30);
      });
    const layout = layoutOf(await frame());
    expect(layout).toBeDefined();

    await go("/items/9");
    expect(await frame()).toContain("MISSING Item 9 (id 9)");
    expect(app.status).toBe("Connected");
    await go("/items/3");
    expect(await frame()).toContain("ITEM 3");

    // A Server exception reaches error.tsx (development keeps its message); retry()
    // loads the page again.
    await go("/boom");
    expect(await frame()).toContain("FAILED secret detail [undefined]");
    await act(async () => {
      await ui.mockInput.typeText("r");
      await Bun.sleep(50);
    });
    expect(await frame()).toContain("RECOVERED 2");

    // The catch-all takes one or more segments; a single parameter ranks first.
    await go("/docs/guide/install/linux");
    expect(await frame()).toContain("DOC guide/install/linux");
    await go("/docs/intro");
    expect(await frame()).toContain("SECTION intro");

    await go("/nowhere/at/all");
    expect(await frame()).toContain("NO ROUTE /nowhere/at/all");
    expect(layoutOf(await frame())).toBe(layout);

    // A transport failure reaches error.tsx with its outcome.
    await running.stop();
    await go("/items/4");
    expect(await frame()).toContain("[not-sent]");
    expect(layoutOf(await frame())).toBe(layout);
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catch-all segments are last, hold no layout and keep their own collision key", () => {
  const graph = compileRouteGraph([
    "app/layout.tsx",
    "app/files/[...path]/page.tsx",
    "app/files/[name]/page.tsx",
    "app/files/error.tsx",
  ]);
  expect(graph.pages.find((p) => p.splat)).toMatchObject({
    url: "/files/$",
    params: ["path"],
    splat: "path",
    error: "app/files/error.tsx",
  });
  expect(() => compileRouteGraph(["app/layout.tsx", "app/[...rest]/more/page.tsx"])).toThrow(
    "A catch-all segment must be the last one",
  );
  expect(() =>
    compileRouteGraph(["app/layout.tsx", "app/[...rest]/layout.tsx", "app/[...rest]/page.tsx"]),
  ).toThrow("A catch-all segment cannot hold a layout");
  expect(() =>
    compileRouteGraph(["app/layout.tsx", "app/a/[...x]/page.tsx", "app/a/[...y]/page.tsx"]),
  ).toThrow("Route collision");
});
