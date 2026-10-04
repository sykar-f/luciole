/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/core/src/build";
import {
  BUILD_TEST_MS,
  WAIT_MS,
  launch,
  until,
  untilFrame,
  importClient,
  readManifest,
  destroy,
  type TestUI,
} from "./helpers";

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";import {useState} from "react";import {useInvalidation} from "@luciole-sh/core/client";import {counts} from "../actions/data";export default function Layout({children}){const [seen,setSeen]=useState("none");useInvalidation(paths=>{setSeen(paths.join(","));void counts().then(()=>{})});return <box flexDirection="column"><text>SEEN {seen}</text>{children}</box>}`,
  "app/a/page.tsx": `import {Bump} from "../../components/Bump";import {read} from "../../server/store";export default function A(){return <box flexDirection="column"><text>A {read("a")}</text><Bump/></box>}`,
  "app/b/page.tsx": `import {read} from "../../server/store";export default function B(){return <text>B {read("b")}</text>}`,
  "components/Bump.tsx": `"use client";import {useKeyboard} from "@opentui/react";import {bump,quiet} from "../actions/data";export function Bump(){useKeyboard(k=>{if(k.name==="b")void bump();if(k.name==="q")void quiet()});return <text>press b</text>}`,
  "actions/data.ts": `"use server";import {invalidate} from "@luciole-sh/core/server";import {write} from "../server/store";export async function bump(){write("a");write("b");invalidate("/a");return "done"}export async function quiet(){write("a");return "quiet"}export async function counts(){return 1}`,
  "server/store.ts": `const values={a:0,b:0};export const read=(k)=>values[k];export function write(k){values[k]++}`,
};

test(
  "a Server Function revalidates only the routes it declares changed",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "luciole-invalidate-"));
    let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
    // The Server Function calls on the wire. The Layout calls `counts()` on each
    // invalidation without awaiting it, and its request leaves a tick later: settled means
    // every invalidation got its call, and no call is left open for the teardown to cut.
    const calling = new Set<number>();
    let invalidated = 0,
      counted = 0;
    const settled = () => until(() => calling.size === 0 && counted === invalidated, WAIT_MS);
    try {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(directory, name, ".."), { recursive: true });
        await Bun.write(join(directory, name), text);
      }
      await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
      await build(directory);
      const running = await launch(join(directory, ".luciole/server/index.js"));
      server = running;
      const manifest = await readManifest(directory);
      const { createApp, Shell } = await importClient(directory);
      const renders: string[] = [];
      const app = createApp({
        url: running.url,
        initialPath: "/b",
        fetch: (input: URL, init: RequestInit) => {
          const route = input.searchParams.get("route");
          if (route) renders.push(route);
          return fetch(input, init);
        },
      });
      const invalidations: string[] = [];
      app.onEvent((event) => {
        if (event.type === "invalidate") {
          invalidated++;
          invalidations.push(...event.paths);
        }
        if (event.type !== "request" && event.type !== "end" && event.type !== "error") return;
        if (event.kind !== "action") return;
        if (event.type !== "request") calling.delete(event.id);
        else {
          calling.add(event.id);
          if (event.target.endsWith("#counts")) counted++;
        }
      });
      await app.router.load();
      const ui = await testRender(<Shell app={app} />, { width: 60, height: 8 });
      rendered = ui;
      const frame = async () => {
        await ui.renderOnce();
        return ui.captureCharFrame();
      };
      // /b is cached; /a is mounted.
      await act(async () => {
        await app.router.navigate({ to: "/a" });
      });
      expect(await frame()).toContain("A 0");
      renders.length = 0;
      await act(async () => {
        await ui.mockInput.typeText("b");
        // The frame shows the revalidated /a: the render it waited for has happened.
        await untilFrame(ui, "A 1");
        await untilFrame(ui, "SEEN /a");
        await settled();
      });
      expect(renders).toEqual(["/a"]);
      // The declared path selects its route and descendants, never a mere prefix.
      const calls: Parameters<typeof app.router.invalidate>[0][] = [];
      const invalidate = app.router.invalidate.bind(app.router);
      app.router.invalidate = (opts) => {
        calls.push(opts);
        return invalidate(opts);
      };
      await act(async () => {
        await ui.mockInput.typeText("b");
        await untilFrame(ui, "A 2");
      });
      // The filter receives route matches: a mounted match, moved to each candidate path.
      const filter = calls.find((opts) => opts?.filter)?.filter;
      const [mounted] = app.router.state.matches;
      if (!filter || !mounted) throw new Error("No filtered invalidation of a mounted route");
      const selected = ["/a", "/a/x", "/ab", "/b"].filter((pathname) =>
        filter({ ...mounted, pathname }),
      );
      expect(selected).toEqual(["/a", "/a/x"]);
      // Without invalidate(), nothing is refetched.
      await act(async () => {
        await app.router.navigate({ to: "/a" });
      });
      renders.length = 0;
      invalidations.length = 0;
      const result = await act(() =>
        app.callServer(`${manifest.buildId}/actions/data.ts#quiet`, []),
      );
      expect(result).toBe("quiet");
      // Not a wait: the transport declares an invalidation before `callServer` returns, so
      // an empty list now is final, and a refetch has nothing to start from.
      expect(invalidations).toEqual([]);
      expect(renders).toEqual([]);
    } finally {
      await settled().catch(() => {});
      await destroy(rendered);
      if (server) await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
