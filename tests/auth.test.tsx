import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until } from "./helpers";

test("public and protected routes and actions use the application auth adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-auth-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    for (const name of ["app/login", "app/public", "components", "actions", "server"])
      await mkdir(join(directory, name), { recursive: true });
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await Bun.write(
      join(directory, "app/layout.tsx"),
      "export default function Layout({children}){return <box>{children}</box>}",
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {getSession} from "@terminal/framework/server";import {Actions} from "../components/Actions";export default function Page(){return <box><text>PRIVATE {getSession().userId}</text><Actions/></box>}`,
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
      `import type {AuthConfig} from "@terminal/framework/server";export default {unauthorizedPath:"/login",authenticate(request){return request.headers.get("authorization")==="Bearer valid"?{userId:"alice",role:"admin"}:null}} satisfies AuthConfig`,
    );
    await build(directory);
    server = await launch(join(directory, ".terminal/server/index.js"));
    const { createApp } = await import(join(directory, ".terminal/client/index.js"));
    const manifest = await Bun.file(join(directory, ".terminal/manifest.json")).json();
    const anonymous = createApp({ url: server.url });
    await anonymous.navigate("/");
    expect(anonymous.path).toBe("/login");
    expect(anonymous.status).toBe("Connected");
    await anonymous.navigate("/public");
    expect(anonymous.path).toBe("/public");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/public.ts#publicAction`, []),
    ).toBe("guest");
    await expect(
      anonymous.callServer(`${manifest.buildId}/actions/private.ts#privateAction`, []),
    ).rejects.toMatchObject({ loginPath: "/login" });
    await until(() => anonymous.path === "/login");

    anonymous.setToken("valid");
    await anonymous.navigate("/");
    expect(anonymous.path).toBe("/");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/private.ts#privateAction`, []),
    ).toBe("alice");
    expect(
      await anonymous.callServer(`${manifest.buildId}/actions/public.ts#publicAction`, []),
    ).toBe("alice");
  } finally {
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
