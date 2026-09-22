import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/build";
async function fixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "terminal-build-"));
  try {
    for (const [name, text] of Object.entries({
      "app/layout.tsx": "export default function Layout({children}){return children}",
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
test("automatic graph, Client reexports, action proxies, no repository in Client", async () => {
  await fixture(
    {
      "app/page.tsx": `import {Editor} from '../components/barrel'; export default function Page(){return <Editor/>}`,
      "components/barrel.ts": `"use client";export {Editor} from './editor'`,
      "components/editor.tsx": `import {save} from '../actions/save';export function Editor(){return <input onSubmit={()=>save('x')}/>}`,
      "actions/save.ts": `"use server";import {value} from '../server/repository';export async function save(x:string){return value+x;}`,
      "server/repository.ts": `import 'server-only';export const value='SECRET_REPOSITORY_SENTINEL';`,
    },
    async (dir) => {
      await build(dir);
      const manifest = await Bun.file(join(dir, ".terminal/manifest.json")).json();
      expect(manifest.manifest[`${manifest.buildId}/components/barrel.ts#Editor`]).toBeDefined();
      expect(await Bun.file(join(dir, ".terminal/client/index.js")).text()).not.toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(await Bun.file(join(dir, ".terminal/server/index.js")).text()).toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(manifest.clientGraph).not.toContain("server/repository.ts");
    },
  );
});
for (const [name, extra] of Object.entries<Record<string, string>>({
  transitive: {
    "shared.ts": `export {value} from './server/secret'`,
    "server/secret.ts": `export const value=1`,
  },
  marker: { "shared.ts": `import 'server-only';export const value=1` },
  builtin: {
    "shared.ts": `import {Database} from 'bun:sqlite';export const value=Database`,
  },
  inline: {
    "shared.ts": `export async function value(){"use server";return 1;}`,
  },
}))
  test(`reject ${name} with file/line diagnostic`, async () => {
    await fixture(
      {
        "app/page.tsx": `import {Editor} from '../editor';export default function Page(){return <Editor/>}`,
        "editor.tsx": `"use client";import {value} from './shared';export function Editor(){return <text>{String(value)}</text>}`,
        ...extra,
      },
      async (dir) => {
        await expect(build(dir)).rejects.toThrow(/\.ts:\d+:\d+:/);
      },
    );
  });
test("failed rebuild retains prior artefacts", async () => {
  await fixture(
    {
      "app/page.tsx": "export default function Page(){return <text>ok</text>}",
    },
    async (dir) => {
      const first = await build(dir);
      await Bun.write(
        join(dir, "app/page.tsx"),
        'export default async function Page(){"use server";return <text>no</text>}',
      );
      await expect(build(dir)).rejects.toThrow("Inline");
      expect((await Bun.file(join(dir, ".terminal/manifest.json")).json()).buildId).toBe(
        first.buildId,
      );
    },
  );
});
