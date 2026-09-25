import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/airtty/src/build";
import { messageOf } from "../packages/airtty/src/guards";
import { launch, importClient, readManifest } from "./helpers";

// An exception in a Server Function is an unknown outcome for the Client, and must
// never reveal Server internals (message, stack, paths, source) in the response.
test("a failing Server Function answers a generic 500 without internals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "airtty-errors-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    for (const name of ["app", "components", "actions"])
      await mkdir(join(directory, name), { recursive: true });
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await Bun.write(
      join(directory, "app/layout.tsx"),
      `"use client";export default function Layout({children}){return <box>{children}</box>}`,
    );
    await Bun.write(
      join(directory, "app/page.tsx"),
      `import {Button} from "../components/Button";export default function Page(){return <Button/>}`,
    );
    await Bun.write(
      join(directory, "components/Button.tsx"),
      `"use client";import {explode} from "../actions/explode";export function Button(){return <text>{String(!!explode)}</text>}`,
    );
    await Bun.write(
      join(directory, "actions/explode.ts"),
      `"use server";export async function explode(){throw new Error("SECRET_INTERNAL_SENTINEL")}`,
    );
    await build(directory);
    server = await launch(join(directory, ".airtty/server/index.js"));
    const manifest = await readManifest(directory);
    const { createApp } = await importClient(directory);
    const app = createApp({ url: server.url });
    const failure = await app
      .callServer(`${manifest.buildId}/actions/explode.ts#explode`, [])
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(messageOf(failure)).toBe("HTTP 500: Server request failed");
    expect(app.status).toBe("Disconnected");
    const raw = await fetch(`${server.url}/action`, {
      method: "POST",
      headers: {
        "x-airtty-build": manifest.buildId,
        "x-airtty-action": `${manifest.buildId}/actions/explode.ts#explode`,
      },
      body: "[]",
    });
    const body = await raw.text();
    expect(raw.status).toBe(500);
    expect(body).toBe("Server request failed");
    expect(body).not.toContain("SECRET_INTERNAL_SENTINEL");
  } finally {
    if (server) await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
