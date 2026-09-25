import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../packages/airtty/src/build";
import { messageOf } from "../packages/airtty/src/guards";
import { readManifest, rejectionOf } from "./helpers";
async function fixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "airtty-build-"));
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
      const manifest = await readManifest(dir);
      expect(manifest.manifest[`${manifest.buildId}/components/barrel.ts#Editor`]).toBeDefined();
      expect(await Bun.file(join(dir, ".airtty/client/index.js")).text()).not.toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(await Bun.file(join(dir, ".airtty/server/index.js")).text()).toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(manifest.clientGraph).not.toContain("server/repository.ts");
      // TanStack's server build would bypass the Client transition machinery.
      const client = await Bun.file(join(dir, ".airtty/client/index.js")).text();
      expect(client).toContain("createRouter");
      expect(client).not.toContain('process.env.NODE_ENV === "test" ? void 0 : true');
    },
  );
});
for (const [name, extra] of Object.entries<Record<string, string>>({
  transitive: {
    "shared.ts": `export {value} from './server/secret'`,
    "server/secret.ts": `export const value=1`,
  },
  marker: { "shared.ts": `import 'server-only';export const value=1` },
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
        expect(messageOf(await rejectionOf(build(dir)))).toMatch(/\.ts:\d+:\d+:/);
      },
    );
  });
test("a Client module may use Bun and Node builtins: only the side markers decide", async () => {
  // The Client runs on Bun: a local file, a subprocess or a local database are its own.
  // Keeping a module on one side is server-only, server/ or client-only (cases above).
  await fixture(
    {
      "app/page.tsx": `import {Editor} from '../editor';export default function Page(){return <Editor/>}`,
      "editor.tsx": `"use client";import {local} from './lib/local';export function Editor(){return <text>{String(local)}</text>}`,
      "lib/local.ts": `import {readFileSync} from 'node:fs';import {Database} from 'bun:sqlite';export const local=()=>[readFileSync, Database, "LOCAL_STORE_SENTINEL"];`,
    },
    async (dir) => {
      await build(dir);
      expect((await readManifest(dir)).clientGraph).toContain("lib/local.ts");
      expect(await Bun.file(join(dir, ".airtty/client/index.js")).text()).toContain(
        "LOCAL_STORE_SENTINEL",
      );
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
      expect(messageOf(await rejectionOf(build(dir)))).toContain("Inline");
      expect((await readManifest(dir)).buildId).toBe(first.buildId);
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
      const manifest = await readManifest(dir);
      expect(manifest.routes.map(({ id, url, auth }) => ({ id, url, auth }))).toEqual([
        { id: "/", url: "/", auth: "required" },
        { id: "/login", url: "/login", auth: "public" },
      ]);
    },
  );
  await fixture(
    {
      "app/page.tsx":
        'export const auth="sometimes";export default function Page(){return <text>bad</text>}',
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        'auth must be the literal "public" or "required"',
      );
    },
  );
});
for (const [file, source] of [
  ["app/loading.tsx", "export default function Loading(){return <text>wait</text>}"],
  [
    "app/loading.tsx",
    '"use client";import {db} from "../server/db";export default function Loading(){return <text>{String(db)}</text>}',
  ],
  ["app/layout.tsx", "export default function Layout({children}){return children}"],
  ["app/layout.tsx", '"use client";export function Layout({children}){return children}'],
  [
    "app/(group)/layout.tsx",
    '"use client";import {getSession} from "airtty/server";export default function Layout({children}){return <text>{getSession().userId}</text>}',
  ],
] as const)
  test(`reject ${file}: ${source.slice(0, 48)}`, async () => {
    await fixture(
      {
        "app/page.tsx": "export default function Page(){return <text>home</text>}",
        "app/(group)/about/page.tsx": "export default function Page(){return <text>about</text>}",
        "server/db.ts": "export const db = 1;",
        [file]: source,
      },
      async (dir) => {
        expect(messageOf(await rejectionOf(build(dir)))).toMatch(/(loading|layout)\.tsx:\d+:\d+:/);
      },
    );
  });
test("route graph diagnostics abort the build before any artefact", async () => {
  await fixture(
    {
      "app/(a)/users/page.tsx": "export default function Page(){return <text>a</text>}",
      "app/(b)/users/page.tsx": "export default function Page(){return <text>b</text>}",
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain("Route collision /users");
      expect(await Bun.file(join(dir, ".airtty/manifest.json")).exists()).toBe(false);
    },
  );
});
test("layouts and loadings belong to the build identity and the Client graph", async () => {
  await fixture(
    {
      "app/page.tsx": "export default function Page(){return <text>home</text>}",
      "app/loading.tsx": '"use client";export default function Loading(){return <text>wait</text>}',
      "app/(group)/layout.tsx":
        '"use client";export default function Layout({children}){return children}',
      "app/(group)/about/page.tsx": "export default function Page(){return <text>about</text>}",
    },
    async (dir) => {
      const first = await build(dir);
      const manifest = await readManifest(dir);
      for (const file of ["app/layout.tsx", "app/(group)/layout.tsx", "app/loading.tsx"])
        expect(manifest.clientGraph).toContain(file);
      expect(manifest.serverGraph).not.toContain("app/(group)/layout.tsx");
      await Bun.write(
        join(dir, "app/(group)/layout.tsx"),
        '"use client";export default function Layout({children}){return <box>{children}</box>}',
      );
      const second = await build(dir);
      expect(second.buildId).not.toBe(first.buildId);
      await Bun.write(
        join(dir, "app/loading.tsx"),
        '"use client";export default function Loading(){return <text>changed</text>}',
      );
      expect((await build(dir)).buildId).not.toBe(second.buildId);
    },
  );
});

// Fake installed packages: any package may reach the Client, unless it is made for the Server.
const packages: Record<string, string> = {
  "node_modules/tiny-format/package.json": `{"name":"tiny-format","version":"1.2.3","main":"index.js"}`,
  "node_modules/tiny-format/index.js": `import {join} from "node:path";export const shout=(s)=>join(s.toUpperCase(),"TINY_FORMAT_SENTINEL");`,
  "node_modules/chained/package.json": `{"name":"chained","version":"2.0.0","main":"index.js"}`,
  "node_modules/chained/index.js": `import {shout} from "tiny-format";export const twice=(s)=>shout(shout(s));`,
  "node_modules/db-client/package.json": `{"name":"db-client","version":"0.1.0","main":"index.js"}`,
  "node_modules/db-client/index.js": `import "server-only";export const query=()=>"SECRET_DB";`,
  "node_modules/server-only/package.json": `{"name":"server-only","version":"0.0.1","main":"index.js"}`,
  "node_modules/server-only/index.js": ``,
  "node_modules/leaky-sdk/package.json": `{"name":"leaky-sdk","version":"0.1.0","main":"index.js"}`,
  "node_modules/leaky-sdk/index.js": `import {getSession} from "airtty/server";export const who=()=>getSession();`,
};
const clientUsing = (specifier: string, name: string) => ({
  "app/page.tsx": `import {Widget} from '../components/widget';export default function Page(){return <Widget/>}`,
  "components/widget.tsx": `"use client";import {${name}} from '${specifier}';export function Widget(){return <text>{String(${name})}</text>}`,
});

test("Client packages: bundled without declaration, inventoried with their versions", async () => {
  await fixture({ ...packages, ...clientUsing("chained", "twice") }, async (dir) => {
    await build(dir);
    const manifest = await readManifest(dir);
    // Transitive dependencies included; Node builtins work on the terminal Client.
    expect(manifest.clientPackages).toContainEqual({ name: "chained", version: "2.0.0" });
    expect(manifest.clientPackages).toContainEqual({ name: "tiny-format", version: "1.2.3" });
    expect(await Bun.file(join(dir, ".airtty/client/index.js")).text()).toContain(
      "TINY_FORMAT_SENTINEL",
    );
  });
});

test("Client packages: one made for the Server is refused with its name", async () => {
  await fixture({ ...packages, ...clientUsing("db-client", "query") }, async (dir) => {
    expect(messageOf(await rejectionOf(build(dir)))).toContain(
      "Client package db-client imports server-only: it is Server-only",
    );
    expect(await Bun.file(join(dir, ".airtty/manifest.json")).exists()).toBe(false);
  });
  await fixture({ ...packages, ...clientUsing("leaky-sdk", "who") }, async (dir) => {
    expect(messageOf(await rejectionOf(build(dir)))).toContain(
      "Client package leaky-sdk imports airtty/server: it is Server-only",
    );
  });
  // The same package stays usable from Server code.
  await fixture(
    {
      ...packages,
      "app/page.tsx": `import {query} from "db-client";export default function Page(){return <text>{query()}</text>}`,
    },
    async (dir) => {
      await build(dir);
      expect(await Bun.file(join(dir, ".airtty/client/index.js")).text()).not.toContain(
        "SECRET_DB",
      );
    },
  );
});

const sidePackages: Record<string, string> = {
  "node_modules/client-only/package.json": `{"name":"client-only","version":"0.0.1","main":"index.js"}`,
  "node_modules/client-only/index.js": ``,
  "node_modules/editor-kit/package.json": `{"name":"editor-kit","version":"1.0.0","main":"index.js"}`,
  "node_modules/editor-kit/index.js": `import "client-only";export const openEditor=()=>Bun.spawn([process.env.EDITOR??"vi"]);`,
  "node_modules/hasher/package.json": `{"name":"hasher","version":"3.0.0","main":"index.js"}`,
  "node_modules/hasher/index.js": `export const hash=(s)=>"HASHER_SECRET"+s;`,
  "node_modules/auth-kit/package.json": `{"name":"auth-kit","version":"1.0.0","main":"index.js"}`,
  "node_modules/auth-kit/index.js": `import {hash} from "hasher";export const check=(s)=>hash(s);`,
};

test("boundary errors show the whole import chain, packages included", async () => {
  await fixture(
    {
      ...packages,
      "app/page.tsx": `import {Widget} from '../components/widget';export default function Page(){return <Widget/>}`,
      "components/widget.tsx": `"use client";import {label} from '../lib/format';export function Widget(){return <text>{label()}</text>}`,
      "lib/format.ts": `import {query} from 'db-client';export const label=()=>String(query);`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        "Client package db-client imports server-only: it is Server-only\n  via app/page.tsx → components/widget.tsx → lib/format.ts → db-client/index.js → server-only",
      );
    },
  );
  await fixture(
    {
      "app/page.tsx": `import {Widget} from '../components/widget';export default function Page(){return <Widget/>}`,
      "components/widget.tsx": `"use client";import {v} from '../lib/shared';export function Widget(){return <text>{v}</text>}`,
      "lib/shared.ts": `export {v} from '../server/secret'`,
      "server/secret.ts": `export const v=1`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toMatch(
        /lib\/shared\.ts:1:1: Server-only import in Client graph: \.\.\/server\/secret\n {2}via app\/page\.tsx → components\/widget\.tsx → lib\/shared\.ts/,
      );
    },
  );
});

test("client-only code never runs on the Server, except behind a use client boundary", async () => {
  // Application module marked client-only, imported by a page.
  await fixture(
    {
      "app/page.tsx": `import {open} from '../lib/editor';export default function Page(){return <text>{String(open)}</text>}`,
      "lib/editor.ts": `import "client-only";export const open=()=>Bun.spawn(["vi"]);`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toMatch(
        /lib\/editor\.ts:1:1: Client-only module in Server graph: it never runs on the Server\n {2}via app\/page\.tsx → lib\/editor\.ts/,
      );
    },
  );
  // A package marked client-only, used by Server code.
  await fixture(
    {
      ...sidePackages,
      "app/page.tsx": `import {openEditor} from 'editor-kit';export default function Page(){return <text>{String(openEditor)}</text>}`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        "Server package editor-kit imports client-only: it never runs on the Server\n  via app/page.tsx → editor-kit/index.js → client-only",
      );
    },
  );
  // Both, behind a "use client" boundary: the Server only holds references.
  await fixture(
    {
      ...sidePackages,
      "app/page.tsx": `import {Editor} from '../components/editor';export default function Page(){return <Editor/>}`,
      "components/editor.tsx": `"use client";import "client-only";import {openEditor} from 'editor-kit';export function Editor(){return <text>{String(openEditor)}</text>}`,
    },
    async (dir) => {
      await build(dir);
      expect(await Bun.file(join(dir, ".airtty/server/index.js")).text()).not.toContain("EDITOR");
    },
  );
});

test("serverPackages keeps listed third-party packages out of the Client", async () => {
  const config = { "airtty.json": `{"serverPackages":["hasher"]}` };
  await fixture({ ...sidePackages, ...config, ...clientUsing("hasher", "hash") }, async (dir) => {
    expect(messageOf(await rejectionOf(build(dir)))).toMatch(
      /components\/widget\.tsx:1:\d+: Server-only package in Client graph: hasher \(serverPackages in airtty\.json\)\n {2}via app\/page\.tsx → components\/widget\.tsx/,
    );
  });
  await fixture(
    { ...sidePackages, ...config, ...clientUsing("auth-kit", "check") },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        "Client package auth-kit imports hasher: it is listed in serverPackages (airtty.json)\n  via app/page.tsx → components/widget.tsx → auth-kit/index.js → hasher",
      );
    },
  );
  // Unlisted, the same package is bundled; listed, it stays usable on the Server.
  await fixture({ ...sidePackages, ...clientUsing("auth-kit", "check") }, (dir) =>
    build(dir).then(() => {}),
  );
  await fixture(
    {
      ...sidePackages,
      ...config,
      "app/page.tsx": `import {hash} from 'hasher';export default function Page(){return <text>{hash("x")}</text>}`,
    },
    async (dir) => {
      await build(dir);
      expect(await Bun.file(join(dir, ".airtty/client/index.js")).text()).not.toContain(
        "HASHER_SECRET",
      );
    },
  );
  for (const bad of [`{"serverPackages":"hasher"}`, `{"serverPackages":["hasher/sub"]}`, `nope`])
    await fixture(
      { ...sidePackages, "airtty.json": bad, ...clientUsing("auth-kit", "check") },
      async (dir) => {
        expect(messageOf(await rejectionOf(build(dir)))).toContain("airtty.json");
      },
    );
});
test("application code shares the framework's zod; a package keeps its own", async () => {
  await fixture(
    {
      "node_modules/legacy-kit/package.json": `{"name":"legacy-kit","version":"1.0.0","main":"index.js"}`,
      "node_modules/legacy-kit/index.js": `import {z} from "zod";export const kit=()=>z.marker;`,
      "node_modules/legacy-kit/node_modules/zod/package.json": `{"name":"zod","version":"3.0.0","main":"index.js"}`,
      "node_modules/legacy-kit/node_modules/zod/index.js": `export const z={marker:"LEGACY_ZOD_SENTINEL"};`,
      "app/page.tsx": `import {kit} from 'legacy-kit';import {z} from 'zod';export default function Page(){return <text>{String(kit())}{z.string().parse('app')}</text>}`,
    },
    async (dir) => {
      await build(dir);
      const server = await Bun.file(join(dir, ".airtty/server/index.js")).text();
      expect(server).toContain("LEGACY_ZOD_SENTINEL");
      expect(server).toContain("node_modules/zod/v4/classic/");
    },
  );
});

// The Client validates what it receives with zod/mini: the classic API would add ~130 KB.
test("the Client bundle embeds zod/mini, never the classic zod API", async () => {
  await fixture(
    // The fixture has no node_modules: application schemas use the framework's zod.
    {
      "app/page.tsx": `import {z} from 'zod';export default function Page(){return <text>{z.string().parse('page')}</text>}`,
    },
    async (dir) => {
      await build(dir);
      const client = await Bun.file(join(dir, ".airtty/client/index.js")).text();
      expect(client).toContain("node_modules/zod/v4/mini/");
      expect(client).not.toContain("node_modules/zod/v4/classic/");
      const server = await Bun.file(join(dir, ".airtty/server/index.js")).text();
      expect(server).toContain("node_modules/zod/v4/classic/");
    },
  );
});
