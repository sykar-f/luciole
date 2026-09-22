import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/build";
import { matchRoute } from "../src/routes";
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

test("loading routes inherit the nearest local fallback and respect static route precedence", async () => {
  await fixture(
    {
      "app/page.tsx": "export default function Page(){return <text>home</text>}",
      "app/loading.tsx":
        '"use client";export default function Loading(){return <text>ROOT LOADING</text>}',
      "app/notes/[id]/page.tsx": "export default function Page(){return <text>note</text>}",
      "app/notes/[id]/loading.tsx":
        '"use client";export default function Loading({params}){return <text>{params.id}</text>}',
      "app/notes/new/page.tsx": "export default function Page(){return <text>new</text>}",
    },
    async (dir) => {
      await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
      const first = await build(dir);
      const { createApp } = await import(join(dir, ".terminal/client/index.js"));
      const app = createApp({ url: "http://127.0.0.1:1" });
      for (const [path, expected] of [
        ["/", "ROOT LOADING"],
        ["/notes/new", "ROOT LOADING"],
        ["/notes/hello%20world", "hello world"],
      ]) {
        const matched = matchRoute(app.options.loadingRoutes, path)!;
        const component = (matched.route as any).component;
        expect(component({ path, params: matched.params }).props.children).toBe(expected);
      }
      await Bun.write(
        join(dir, "app/loading.tsx"),
        '"use client";export default function Loading(){return <text>CHANGED</text>}',
      );
      expect((await build(dir)).buildId).not.toBe(first.buildId);
    },
  );
});
test("route auth metadata is secure by default and validated", async () => {
  await fixture(
    {
      "app/page.tsx": "export default function Page(){return <text>private</text>}",
      "app/login/page.tsx":
        'export const auth="public" as const;export default function Page(){return <text>login</text>}',
    },
    async (dir) => {
      await build(dir);
      const manifest = await Bun.file(join(dir, ".terminal/manifest.json")).json();
      expect(manifest.routes).toEqual([
        { path: "/login", auth: "public" },
        { path: "/", auth: "required" },
      ]);
    },
  );
  await fixture(
    {
      "app/page.tsx":
        'export const auth="sometimes";export default function Page(){return <text>bad</text>}',
    },
    async (dir) => {
      await expect(build(dir)).rejects.toThrow('auth must be the literal "public" or "required"');
    },
  );
});
for (const [name, loading] of Object.entries({
  "missing client directive": "export default function Loading(){return <text>wait</text>}",
  "server import":
    '"use client";import {readFile} from "node:fs";export default function Loading(){return <text>{String(readFile)}</text>}',
}))
  test(`reject loading with ${name}`, async () => {
    await fixture(
      {
        "app/page.tsx": "export default function Page(){return <text>home</text>}",
        "app/loading.tsx": loading,
      },
      async (dir) => {
        await expect(build(dir)).rejects.toThrow(/loading.tsx:\d+:\d+:/);
      },
    );
  });
