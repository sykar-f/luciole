/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until } from "./helpers";

async function authFixture(directory: string) {
  for (const name of ["app/login", "app/public", "components", "actions", "server"])
    await mkdir(join(directory, name), { recursive: true });
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
}

test("public and protected routes and actions use the application auth adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-auth-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await authFixture(directory);
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {getSession} from "@terminal/framework/server";import {Actions} from "../components/Actions";export default function Page(){return <box flexDirection="column"><text>PRIVATE {getSession().userId}</text><Actions/></box>}`,
    );
    await Bun.write(
      join(directory, "app/login/page.tsx"),
      `export const auth="public" as const;export default function Page(){return <text>LOGIN</text>}`,
    );
    await Bun.write(
      join(directory, "app/public/page.tsx"),
      `import {getOptionalSession} from "@terminal/framework/server";export const auth="public" as const;export default function Page(){return <text>PUBLIC {getOptionalSession()?.userId??"guest"}</text>}`,
    );
    await Bun.write(
      join(directory, "components/Actions.tsx"),
      `"use client";import {privateAction} from "../actions/private";import {publicAction} from "../actions/public";export function Actions(){return <text>{String(privateAction&&publicAction)}</text>}`,
    );
    await Bun.write(
      join(directory, "actions/private.ts"),
      `"use server";import {getSession} from "@terminal/framework/server";export async function privateAction(){return getSession().userId}`,
    );
    await Bun.write(
      join(directory, "actions/public.ts"),
      `"use server";import {getOptionalSession} from "@terminal/framework/server";export const auth="public" as const;export async function publicAction(){return getOptionalSession()?.userId??"guest"}`,
    );
    await Bun.write(
      join(directory, "server/auth.ts"),
      `import type {AuthConfig} from "@terminal/framework/server";const users={"Bearer valid":"alice","Bearer other":"bob"};export default {unauthorizedPath:"/login",authenticate(request){const userId=users[request.headers.get("authorization")];return userId?{userId,role:"admin"}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".terminal/server/index.js"));
    const { createApp } = await import(join(directory, ".terminal/client/index.js"));
    const manifest = await Bun.file(join(directory, ".terminal/manifest.json")).json();
    const at = (app: any) => app.router.state.resolvedLocation?.pathname;
    const anonymous = createApp({ url: server.url });
    await anonymous.router.load();
    expect(at(anonymous)).toBe("/login");
    expect(anonymous.status).toBe("Connected");
    await anonymous.router.navigate({ to: "/public" });
    expect(at(anonymous)).toBe("/public");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/public.ts#publicAction`, []),
    ).toBe("guest");
    await expect(
      anonymous.callServer(`${manifest.buildId}/actions/private.ts#privateAction`, []),
    ).rejects.toMatchObject({ loginPath: "/login" });
    await until(() => at(anonymous) === "/login");

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
    const raw = (query: string, token?: string) =>
      fetch(`${server!.url}/render?${query}`, {
        headers: {
          "x-terminal-build": manifest.buildId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    expect((await raw("route=%2F&params=%7B%7D")).status).toBe(401);
    expect((await raw("route=%2Fmissing&params=%7B%7D", "valid")).status).toBe(404);
    expect((await raw("route=%2F&params=%7B%22x%22%3A%221%22%7D", "valid")).status).toBe(400);
    expect((await raw("route=%2F&params=oops", "valid")).status).toBe(400);
    expect((await raw("route=%2F&params=%7B%7D", "valid")).status).toBe(200);
  } finally {
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout and bearer changes purge cached private trees before any protected render", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-auth-cache-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined, ui: any;
  try {
    await authFixture(directory);
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {getSession} from "@terminal/framework/server";export default function Page(){return <text>PRIVATE of {getSession().userId}</text>}`,
    );
    await Bun.write(
      join(directory, "app/login/page.tsx"),
      `export const auth="public" as const;export default function Page(){return <text>LOGIN</text>}`,
    );
    await Bun.write(
      join(directory, "server/auth.ts"),
      `import type {AuthConfig} from "@terminal/framework/server";const users={"Bearer valid":"alice","Bearer other":"bob"};export default {unauthorizedPath:"/login",authenticate(request){const userId=users[request.headers.get("authorization")];return userId?{userId}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".terminal/server/index.js"));
    const { createApp, Shell } = await import(join(directory, ".terminal/client/index.js"));
    let gate: PromiseWithResolvers<void> | undefined;
    const app = createApp({
      url: server.url,
      token: "valid",
      fetch: async (url: string, init: RequestInit) => {
        const held = gate;
        gate = undefined;
        if (held) await held.promise;
        return fetch(url, init);
      },
    });
    await app.router.load();
    ui = await testRender(<Shell app={app} />, { width: 60, height: 10 });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("PRIVATE of alice");
    await act(async () => {
      await app.router.navigate({ to: "/login" });
    });
    // The cache now holds alice's page. A new bearer must not reveal it, nor her Drafts.
    for (const [token, expected] of [
      ["other", "PRIVATE of bob"],
      [undefined, "LOGIN"],
    ] as const) {
      app.drafts.get({ id: "shared-doc", title: "", value: "", version: 1 }).edit("alice's Draft");
      app.setToken(token);
      expect(app.drafts.size).toBe(0);
      gate = Promise.withResolvers<void>();
      const held = gate;
      let navigation!: Promise<void>;
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
    expect(app.router.state.resolvedLocation.pathname).toBe("/login");
    // Renewing the bearer of the same identity may keep its unsaved work.
    app.drafts.get({ id: "renewed", title: "", value: "", version: 1 }).edit("kept");
    app.setToken("valid", { preserveDrafts: true });
    expect(app.drafts.unsaved().map((d: { id: string }) => d.id)).toEqual(["renewed"]);
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
