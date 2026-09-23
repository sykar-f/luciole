/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import type { Transport } from "../src/transport";
import { importClient, destroy, type TestUI } from "./helpers";

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return <box flexDirection="column">{children}</box>}`,
  "app/page.tsx": "export default function Page(){return <text>home</text>}",
  "app/loading.tsx": `"use client";export default function Loading({path}){return <text>ROOT LOADING {path}</text>}`,
  "app/notes/[id]/page.tsx": "export default function Page(){return <text>note</text>}",
  "app/notes/[id]/loading.tsx": `"use client";export default function Loading({params}){return <text>NOTE LOADING {params.id}</text>}`,
  "app/notes/new/page.tsx": "export default function Page(){return <text>new</text>}",
  "app/(settings)/layout.tsx": `"use client";import {useState} from "react";import {useKeyboard} from "@opentui/react";export default function Settings({children}){const [n,setN]=useState(0);useKeyboard(k=>{if(k.name==="k"&&k.ctrl)setN(x=>x+1)});return <box flexDirection="column"><text>SETTINGS LAYOUT {n}</text>{children}</box>}`,
  "app/(settings)/profile/page.tsx": "export default function Page(){return <text>profile</text>}",
  "app/(settings)/account/[section]/page.tsx":
    "export default function Page(){return <text>account</text>}",
};

test("generated route tree: inherited loading, static before dynamic, pathless groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-routes-"));
  let rendered: TestUI | undefined;
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
    await build(dir);
    const { createApp, Shell } = await importClient(dir);
    const requests: [string, Record<string, string>][] = [];
    let release: (() => void) | undefined;
    const releasePage = () => {
      if (!release) throw new Error("No page render is pending");
      release();
    };
    const transport: Transport = {
      render(routeId, params) {
        requests.push([routeId, params]);
        return new Promise((done) => {
          release = () =>
            done(
              <text>
                PAGE {routeId} {JSON.stringify(params)}
              </text>,
            );
        });
      },
      call: () => Promise.reject(new Error("unused")),
      setToken() {},
    };
    const app = createApp({ url: "http://terminal.invalid", transport });
    const ui = await testRender(<Shell app={app} />, { width: 80, height: 12 });
    rendered = ui;
    const visit = async (path: string, loading: string, page: string) => {
      await act(async () => {
        void app.router.navigate({ to: path });
        await Bun.sleep(10);
      });
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain(loading);
      await act(async () => {
        releasePage();
        await Bun.sleep(10);
      });
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain(page);
    };
    await act(async () => {
      await Bun.sleep(10);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("ROOT LOADING /");
    await act(async () => {
      releasePage();
      await Bun.sleep(10);
    });
    await visit("/notes/new", "ROOT LOADING /notes/new", "PAGE /notes/new {}");
    await visit(
      "/notes/hello%20world",
      "NOTE LOADING hello world",
      'PAGE /notes/[id] {"id":"hello world"}',
    );
    await visit("/profile", "ROOT LOADING /profile", "PAGE /(settings)/profile {}");
    await act(async () => {
      ui.mockInput.pressKey("k", { ctrl: true });
    });
    await visit(
      "/account/security",
      "SETTINGS LAYOUT 1",
      'PAGE /(settings)/account/[section] {"section":"security"}',
    );
    await ui.renderOnce();
    // The pathless group layout persisted across its two pages.
    expect(ui.captureCharFrame()).toContain("SETTINGS LAYOUT 1");
    expect(requests.map(([id]) => id)).toEqual([
      "/",
      "/notes/new",
      "/notes/[id]",
      "/(settings)/profile",
      "/(settings)/account/[section]",
    ]);
    // Escape restores the resolved route without a request; a later navigation to a
    // cached route still revalidates it.
    await act(async () => {
      void app.router.navigate({ to: "/notes/$id", params: { id: "slow" } });
      await Bun.sleep(10);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("NOTE LOADING slow");
    await act(async () => {
      ui.mockInput.pressEscape();
      await Bun.sleep(20);
    });
    await ui.renderOnce();
    expect(app.router.state.resolvedLocation?.pathname).toBe("/account/security");
    // The pending destination left the group, so its layout remounts on cancel.
    expect(ui.captureCharFrame()).toContain("SETTINGS LAYOUT 0");
    expect(ui.captureCharFrame()).toContain("PAGE /(settings)/account/[section]");
    expect(requests.length).toBe(6);
    await act(async () => {
      await app.router.navigate({ to: "/profile" });
      await Bun.sleep(10);
    });
    expect(requests.at(-1)?.[0]).toBe("/(settings)/profile");
    expect(requests.length).toBe(7);
  } finally {
    await destroy(rendered);
    await rm(dir, { recursive: true, force: true });
  }
});
