import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ABI_KEY, ABI_PACKAGES, ABI_SPECIFIERS, AppManifest } from "../packages/airtty/src/abi";
import { loadAppBundle, runtimeSpecifiers } from "../packages/airtty/src/app-bundle";
import { build } from "../packages/airtty/src/build";
import { messageOf } from "../packages/airtty/src/guards";
import { readJsonFile } from "../packages/airtty/src/package-json";
import { rejectionOf } from "./helpers";

test("the ABI names the installed versions and the runtime provides every specifier", async () => {
  // The workspace catalog pins every version the framework and the examples declare.
  const { workspaces } = await readJsonFile(
    "package.json",
    z.object({ workspaces: z.object({ catalog: z.record(z.string(), z.string()) }) }),
  );
  for (const [name, version] of Object.entries(ABI_PACKAGES))
    expect(`${name}@${workspaces.catalog[name]}`).toBe(`${name}@${version}`);
  expect(runtimeSpecifiers().sort()).toEqual([...ABI_SPECIFIERS].sort());
  expect(ABI_KEY).toMatch(/^\d+-[0-9a-f]{16}$/);
});

async function fixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "airtty-app-bundle-"));
  try {
    for (const [name, text] of Object.entries({
      "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
      ...files,
    })) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const manifestOf = (dir: string) =>
  readJsonFile(join(dir, ".airtty/app/manifest.json"), z.unknown());

test("the application bundle leaves the runtime to the ABI and audits Node built-ins", async () => {
  await fixture(
    {
      "package.json": JSON.stringify({
        name: "disk",
        airtty: { capabilities: { net: ["api.example.com"] } },
      }),
      "app/page.tsx": `import {Disk} from '../components/disk'; export default function Page(){return <Disk/>}`,
      "components/disk.tsx": `"use client";import {readFileSync} from 'node:fs';import {useState} from 'react';import {save} from '../actions/save';export function Disk(){const [v]=useState(()=>readFileSync('/dev/null','utf8'));return <text onMouseDown={()=>save(v)}>{v}</text>}`,
      "actions/save.ts": `"use server";export async function save(x:string){return x}`,
    },
    async (dir) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await build(dir);
        const manifest = AppManifest.parse(await manifestOf(dir));
        expect(manifest.abi).toBe(ABI_KEY);
        expect(manifest.builtins).toEqual(["fs"]);
        expect(manifest.capabilities?.net).toEqual(["api.example.com"]);
        // Declared net, uses fs: reported, not refused.
        expect(warn.mock.calls.map(([m]) => String(m)).join("\n")).toContain(
          "requires fs but airtty.capabilities does not declare fs.read/fs.write",
        );
        const code = await Bun.file(join(dir, ".airtty/app/index.cjs")).text();
        for (const runtime of ["createRouter", "KeymapProvider", "createServerReference"])
          expect(code).not.toContain(runtime);
        const loaded = await loadAppBundle(join(dir, ".airtty/app"));
        expect(loaded.buildId).toBe(manifest.buildId);
        expect([...loaded.modules.keys()]).toContain(`${manifest.buildId}/components/disk.tsx`);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

test("a bundle is refused for another ABI, altered bytes or an undeclared built-in", async () => {
  await fixture(
    {
      "app/page.tsx": `import {Plain} from '../components/plain'; export default function Page(){return <Plain/>}`,
      "components/plain.tsx": `"use client";import {join} from 'node:path';export function Plain(){return <text>{join('a','b')}</text>}`,
    },
    async (dir) => {
      await build(dir);
      const app = join(dir, ".airtty/app");
      const file = join(app, "manifest.json");
      const manifest = AppManifest.parse(await manifestOf(dir));
      const write = (next: Partial<AppManifest>) =>
        Bun.write(file, JSON.stringify({ ...manifest, ...next }));
      await write({ abi: "0-0000000000000000" });
      expect(messageOf(await rejectionOf(loadAppBundle(app)))).toContain("runtime ABI 0-");
      await write({ sha256: "0".repeat(64) });
      expect(messageOf(await rejectionOf(loadAppBundle(app)))).toContain("does not match");
      await write({ builtins: [] });
      expect(messageOf(await rejectionOf(loadAppBundle(app)))).toContain(
        "requires path, outside the runtime ABI",
      );
      await write({});
      expect((await loadAppBundle(app)).buildId).toBe(manifest.buildId);
    },
  );
});

test("top-level await in Client code: the app builds, is not embeddable, and says where", async () => {
  await fixture(
    {
      "app/page.tsx": `import {Late} from '../components/late'; export default function Page(){return <Late/>}`,
      "components/late.tsx": `"use client";\nconst value = await Promise.resolve("x");\nexport function Late(){return <text>{value}</text>}`,
    },
    async (dir) => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Not embedded: the Client and the Server build as before, without .airtty/app.
        await build(dir);
        expect(await Bun.file(join(dir, ".airtty/client/index.js")).exists()).toBe(true);
        expect(await Bun.file(join(dir, ".airtty/app/manifest.json")).exists()).toBe(false);
        expect(warn.mock.calls.map(([m]) => String(m)).join("\n")).toContain(
          "components/late.tsx:2: top-level await in Client code",
        );
        expect(messageOf(await rejectionOf(loadAppBundle(join(dir, ".airtty/app"))))).toContain(
          "has no application bundle",
        );
      } finally {
        warn.mockRestore();
      }
      // Embedding asked for explicitly (`airtty build --app-bundle`): the build fails.
      const error = messageOf(await rejectionOf(build(dir, undefined, { appBundle: "required" })));
      expect(error).toContain("components/late.tsx:2: top-level await in Client code");
    },
  );
});

test("the examples build their application bundle", async () => {
  const dir = resolve("examples/latency");
  await build(dir);
  const manifest = AppManifest.parse(await manifestOf(dir));
  expect(manifest.name).toBe("latency");
  expect((await loadAppBundle(join(dir, ".airtty/app"))).buildId).toBe(manifest.buildId);
});
