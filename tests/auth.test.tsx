/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import type { Application } from "../src/client";
import { launch, importClient, readManifest, rejectionOf, destroy, type TestUI } from "./helpers";

async function authFixture(directory: string) {
  for (const name of ["app/login", "app/public", "components", "actions", "server"])
    await mkdir(join(directory, name), { recursive: true });
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
}

test("public and protected routes and actions use the application auth adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-auth-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await authFixture(directory);
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {getSession} from "airtty/server";import {Actions} from "../components/Actions";export default function Page(){return <box flexDirection="column"><text>PRIVATE {getSession().userId}</text><Actions/></box>}`,
    );
    await Bun.write(
      join(directory, "app/login/page.tsx"),
      `export const auth="public" as const;export default function Page(){return <text>LOGIN</text>}`,
    );
    await Bun.write(
      join(directory, "app/public/page.tsx"),
      `import {getOptionalSession} from "airtty/server";export const auth="public" as const;export default function Page(){return <text>PUBLIC {getOptionalSession()?.userId??"guest"}</text>}`,
    );
    await Bun.write(
      join(directory, "components/Actions.tsx"),
      `"use client";import {privateAction} from "../actions/private";import {publicAction} from "../actions/public";export function Actions(){return <text>{String(privateAction&&publicAction)}</text>}`,
    );
    await Bun.write(
      join(directory, "actions/private.ts"),
      `"use server";import {getSession} from "airtty/server";export async function privateAction(){return getSession().userId}`,
    );
    await Bun.write(
      join(directory, "actions/public.ts"),
      `"use server";import {getOptionalSession} from "airtty/server";export const auth="public" as const;export async function publicAction(){return getOptionalSession()?.userId??"guest"}`,
    );
    await Bun.write(
      join(directory, "server/auth.ts"),
      `import type {AuthConfig} from "airtty/server";const users={"Bearer valid":"alice","Bearer other":"bob"};export default {unauthorizedPath:"/login",authenticate(request){const userId=users[request.headers.get("authorization")];return userId?{userId,role:"admin"}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const { createApp } = await importClient(directory);
    const manifest = await readManifest(directory);
    const at = (app: Application) => app.router.state.resolvedLocation?.pathname;
    const anonymous = createApp({ url: server.url });
    await anonymous.router.load();
    expect(at(anonymous)).toBe("/login");
    expect(anonymous.status).toBe("Connected");
    await anonymous.router.navigate({ to: "/public" });
    expect(at(anonymous)).toBe("/public");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/public.ts#publicAction`, []),
    ).toBe("guest");
    // A refused action is reported, not handled: the application decides to sign in.
    expect(
      await rejectionOf(
        anonymous.callServer(`${manifest.buildId}/actions/private.ts#privateAction`, []),
      ),
    ).toMatchObject({ loginPath: "/login", outcome: "rejected" });
    expect(at(anonymous)).toBe("/public");
    expect(anonymous.status).toBe("Authentication required");

    anonymous.setToken("valid");
    await anonymous.router.navigate({ to: "/" });
    expect(at(anonymous)).toBe("/");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/private.ts#privateAction`, []),
    ).toBe("alice");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/public.ts#publicAction`, []),
    ).toBe("alice");

    // The Server never trusts the Client route guard.
    const { url } = server;
    const raw = (query: string, token?: string) =>
      fetch(`${url}/render?${query}`, {
        headers: {
          "x-airtty-build": manifest.buildId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    expect((await raw("route=%2F&params=%7B%7D")).status).toBe(401);
    expect((await raw("route=%2Fmissing&params=%7B%7D", "valid")).status).toBe(404);
    expect((await raw("route=%2F&params=%7B%22x%22%3A%221%22%7D", "valid")).status).toBe(400);
    expect((await raw("route=%2F&params=oops", "valid")).status).toBe(400);
    // Search parameters are untrusted too: string values under bounded keys only.
    const search = (value: unknown) =>
      raw(`route=%2F&params=%7B%7D&search=${encodeURIComponent(JSON.stringify(value))}`, "valid");
    expect((await search({ q: "refund", state: "open" })).status).toBe(200);
    expect((await search({ q: 1 })).status).toBe(400);
    expect((await search(["q"])).status).toBe(400);
    expect((await search({ "bad key": "x" })).status).toBe(400);
    expect((await search({ q: "x".repeat(1001) })).status).toBe(400);
    expect((await raw("route=%2F&params=%7B%7D", "valid")).status).toBe(200);
  } finally {
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout and bearer changes purge cached private trees before any protected render", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-auth-cache-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    await authFixture(directory);
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {getSession} from "airtty/server";export default function Page(){return <text>PRIVATE of {getSession().userId}</text>}`,
    );
    await Bun.write(
      join(directory, "app/login/page.tsx"),
      `export const auth="public" as const;export default function Page(){return <text>LOGIN</text>}`,
    );
    await Bun.write(
      join(directory, "server/auth.ts"),
      `import type {AuthConfig} from "airtty/server";const users={"Bearer valid":"alice","Bearer other":"bob"};export default {unauthorizedPath:"/login",authenticate(request){const userId=users[request.headers.get("authorization")];return userId?{userId}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const { createApp, Shell } = await importClient(directory);
    let gate: PromiseWithResolvers<void> | undefined;
    const app = createApp({
      url: server.url,
      token: "valid",
      fetch: async (url: URL, init: RequestInit) => {
        const held = gate;
        gate = undefined;
        if (held) await held.promise;
        return fetch(url, init);
      },
    });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 60, height: 10 });
    rendered = ui;
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("PRIVATE of alice");
    await act(async () => {
      await app.router.navigate({ to: "/login" });
    });
    // The cache now holds alice's page. A new bearer must not reveal it.
    for (const [token, expected] of [
      ["other", "PRIVATE of bob"],
      [undefined, "LOGIN"],
    ] as const) {
      app.setToken(token);
      gate = Promise.withResolvers<void>();
      const held = gate;
      let navigation: Promise<void> | undefined;
      await act(async () => {
        navigation = app.router.navigate({ to: "/" });
        await Bun.sleep(20);
      });
      await ui.renderOnce();
      expect(ui.captureCharFrame()).not.toContain("PRIVATE of alice");
      await act(async () => {
        held.resolve();
        await navigation;
        await Bun.sleep(50);
      });
      await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain(expected);
      expect(ui.captureCharFrame()).not.toContain("PRIVATE of alice");
      if (token) {
        await act(async () => {
          await app.router.navigate({ to: "/login" });
        });
      }
    }
    expect(app.router.state.resolvedLocation?.pathname).toBe("/login");
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a navigation still in flight when the bearer changes never shows the previous identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-auth-late-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, rendered: TestUI | undefined;
  try {
    await authFixture(directory);
    await mkdir(join(directory, "app/private"), { recursive: true });
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/private/page.tsx"),
      `import {getSession} from "airtty/server";export default function Page(){return <text>PRIVATE of {getSession().userId}</text>}`,
    );
    await Bun.write(
      join(directory, "app/login/page.tsx"),
      `export const auth="public" as const;export default function Page(){return <text>LOGIN</text>}`,
    );
    await Bun.write(
      join(directory, "server/auth.ts"),
      `import type {AuthConfig} from "airtty/server";const users={"Bearer valid":"alice","Bearer other":"bob"};export default {unauthorizedPath:"/login",authenticate(request){const userId=users[request.headers.get("authorization")];return userId?{userId}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const { createApp, Shell } = await importClient(directory);
    // Holds the next request after its headers (alice's bearer) are set, before it leaves.
    let gate: PromiseWithResolvers<void> | undefined;
    const app = createApp({
      url: server.url,
      token: "valid",
      initialPath: "/login",
      fetch: async (url: URL, init: RequestInit) => {
        const held = gate;
        gate = undefined;
        if (held) await held.promise;
        return fetch(url, init);
      },
    });
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 60, height: 10 });
    rendered = ui;
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("LOGIN");
    // Alice starts opening a private screen; her bearer changes before the answer, once
    // after her request left and once in the same tick as the navigation.
    for (const [token, previous, expected, sentFirst] of [
      ["other", "PRIVATE of alice", "PRIVATE of bob", true],
      ["valid", "PRIVATE of bob", "PRIVATE of alice", false],
      [undefined, "PRIVATE of alice", "LOGIN", true],
    ] as const) {
      await act(async () => {
        await app.router.navigate({ to: "/login" });
      });
      const held = Promise.withResolvers<void>();
      gate = held;
      let navigation: Promise<void> | undefined;
      await act(async () => {
        navigation = app.router.navigate({ to: "/private" });
        if (sentFirst) await Bun.sleep(20);
        app.setToken(token);
        await Bun.sleep(20);
      });
      await act(async () => {
        held.resolve();
        await navigation;
        await Bun.sleep(50);
      });
      await ui.renderOnce();
      expect(ui.captureCharFrame()).not.toContain(previous);
      expect(ui.captureCharFrame()).toContain(expected);
    }
  } finally {
    await destroy(rendered);
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
