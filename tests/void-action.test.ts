import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/core/src/build";
import { decode } from "../packages/core/src/flight/client";
import { isAsyncIterable } from "../packages/core/src/guards";
import { createHttpTransport } from "../packages/core/src/transport";
import { BUILD_TEST_MS, launch, readManifest } from "./helpers";

const files: Record<string, string> = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return <box>{children}</box>}`,
  "app/page.tsx": `import {Actions} from "../components/Actions";export default function Page(){return <Actions/>}`,
  "components/Actions.tsx": `"use client";import * as actions from "../actions/results";export function Actions(){return <text>{Object.keys(actions).join(",")}</text>}`,
  "actions/results.ts": `"use server";let calls=0;export async function restart():Promise<void>{calls++}export async function count(){return calls}export async function result(value:unknown){return value}export async function* live(){yield null;yield false;yield 0;yield ""}`,
};

test(
  "void Server Functions resolve to undefined and falsy and live results keep their values",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "luciole-void-action-"));
    let server: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(directory, name, ".."), { recursive: true });
        await Bun.write(join(directory, name), text);
      }
      await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
      await build(directory);
      server = await launch(join(directory, ".luciole/server/index.js"));
      const { buildId } = await readManifest(directory);
      const unused = () => Promise.reject(new Error("No nested Server reference"));
      let decodedVoid: unknown;
      const transport = createHttpTransport({
        url: server.url,
        buildId,
        callServer: unused,
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (new Headers(init.headers).get("x-luciole-action")?.endsWith("#restart")) {
            const body = response.clone().body;
            if (!body) throw new Error("Missing action response body");
            decodedVoid = await decode(body, unused);
          }
          return response;
        },
      });
      const call = (name: string, args: unknown[] = []) =>
        transport.call(`${buildId}/actions/results.ts#${name}`, args);
      // Flight's decoder removes the undefined property from the received model.
      // The Server effect still commits even if the Client refuses that model.
      let failure: unknown;
      const result = await call("restart").catch((error: unknown) => {
        failure = error;
      });
      expect(decodedVoid).toMatchObject({ kind: "result", invalidate: [] });
      if (typeof decodedVoid !== "object" || decodedVoid === null)
        throw new Error("Missing decoded action envelope");
      expect(Object.hasOwn(decodedVoid, "value")).toBe(false);
      expect(await call("count")).toBe(1);
      if (failure) throw failure;
      expect(result).toBeUndefined();
      for (const value of [undefined, null, false, 0, ""])
        expect(await call("result", [value])).toBe(value);
      const live = await call("live");
      if (!isAsyncIterable(live)) throw new Error("Missing live action result");
      const items: unknown[] = [];
      for await (const item of live) items.push(item);
      expect(items).toEqual([null, false, 0, ""]);
    } finally {
      if (server) await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
