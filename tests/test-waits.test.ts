import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildApp,
  eventually,
  openClient,
  startServer,
  TEST_TIMEOUT_MS,
} from "../packages/core/src/test";

const directory = await mkdtemp(join(tmpdir(), "luciole-test-waits-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
const files = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return <box>{children}</box>}`,
  "app/page.tsx": `import {Stream} from "../components/Stream";export default function Page(){return <Stream/>}`,
  "components/Stream.tsx": `"use client";import {useLive} from "@luciole-sh/core/client";import {chunks} from "../actions/chunks";export function Stream(){const {items}=useLive(chunks,[]);return <text>{items.join("")}</text>}`,
  // Simulated server latency: the chunk arrives after the screen's wait begins.
  "actions/chunks.ts": `"use server";export async function* chunks(){await Bun.sleep(50);yield "STREAMED CHUNK"}`,
};
for (const [name, source] of Object.entries(files)) {
  await mkdir(join(directory, name, ".."), { recursive: true });
  await Bun.write(join(directory, name), source);
}
const app = await buildApp(directory);

test(
  "waitFor draws a delayed useLive chunk while the wait is running",
  async () => {
    const errors = spyOn(console, "error");
    try {
      await using server = await startServer(app);
      await using client = await openClient(app, server);
      const start = performance.now();
      try {
        expect(await client.waitFor("STREAMED CHUNK")).toContain("STREAMED CHUNK");
      } finally {
        console.info(`Stream wait took ${Math.round(performance.now() - start)} ms`);
      }
      expect(errors.mock.calls.flat().join("\n")).not.toContain("not wrapped in act");
    } finally {
      errors.mockRestore();
    }
  },
  TEST_TIMEOUT_MS,
);

for (const mode of ["settled", "eventually", "requests"] as const) {
  test(
    `${mode} observes a delayed useLive chunk without act warnings`,
    async () => {
      const errors = spyOn(console, "error");
      try {
        await using server = await startServer(app);
        await using client = await openClient(app, server);
        if (mode === "settled") {
          expect(await client.settled("STREAMED CHUNK")).toContain("STREAMED CHUNK");
        } else if (mode === "eventually") {
          await eventually(async () => (await client.frame()).includes("STREAMED CHUNK"));
        } else {
          await client.requests.settled();
          expect(await client.frame()).toContain("STREAMED CHUNK");
        }
        expect(errors.mock.calls.flat().join("\n")).not.toContain("not wrapped in act");
      } finally {
        errors.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
}
