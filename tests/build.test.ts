import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, publish } from "../packages/core/src/build";
import { readBuildId } from "../packages/core/src/compile";
import { messageOf } from "../packages/core/src/guards";
import { BUILD_TEST_MS, execute, readManifest, rejectionOf, temporaryApp } from "./helpers";
async function fixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "luciole-build-"));
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
      expect(await Bun.file(join(dir, ".luciole/client/index.js")).text()).not.toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(await Bun.file(join(dir, ".luciole/server/index.js")).text()).toContain(
        "SECRET_REPOSITORY_SENTINEL",
      );
      expect(manifest.clientGraph).not.toContain("server/repository.ts");
      // TanStack's server build would bypass the Client transition machinery.
      const client = await Bun.file(join(dir, ".luciole/client/index.js")).text();
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
      expect(await Bun.file(join(dir, ".luciole/client/index.js")).text()).toContain(
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

test("a failed publication puts the previous build back", async () => {
  const work = await mkdtemp(join(tmpdir(), "luciole-publish-"));
  try {
    const output = join(work, ".luciole");
    const next = join(work, "next");
    await mkdir(output);
    await mkdir(next);
    await Bun.write(join(output, "manifest.json"), '{"buildId":"previous"}');
    await Bun.write(join(next, "manifest.json"), '{"buildId":"next"}');
    // The second move (the new build into place) fails; the first and the restore work.
    let moves = 0;
    const failing: typeof rename = async (from, to) => {
      if (++moves === 2) throw new Error("injected rename failure");
      await rename(from, to);
    };
    expect(messageOf(await rejectionOf(publish(next, output, failing)))).toBe(
      "injected rename failure",
    );
    expect(await Bun.file(join(output, "manifest.json")).json()).toEqual({ buildId: "previous" });
    expect(await Bun.file(`${output}-previous/manifest.json`).exists()).toBe(false);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
test("a step staged with the build that fails leaves the previous build", async () => {
  await fixture(
    { "app/page.tsx": "export default function Page(){return <text>ok</text>}" },
    async (dir) => {
      const first = await build(dir);
      await Bun.write(
        join(dir, "app/page.tsx"),
        "export default function Page(){return <text>NEW_PAGE_SENTINEL</text>}",
      );
      const staged: string[] = [];
      // What `--web` does once the app is built: a failing runtime install.
      const failure = await rejectionOf(
        build(dir, undefined, {
          stage: async (temp) => {
            staged.push(temp);
            expect(await readBuildId(temp)).not.toBe(first.buildId);
            throw new Error("web runtime unavailable");
          },
        }),
      );
      expect(messageOf(failure)).toBe("web runtime unavailable");
      expect((await readManifest(dir)).buildId).toBe(first.buildId);
      expect(await Bun.file(join(dir, ".luciole/server/index.js")).text()).not.toContain(
        "NEW_PAGE_SENTINEL",
      );
      expect(await stat(staged[0]).catch(() => undefined)).toBeUndefined();
      expect(await readdir(dir)).not.toContain(".luciole-previous");
    },
  );
});
test(
  "a failed --compile leaves the previous build and the previous binary",
  async () => {
    // The CLI runs in its own process: the application needs its node_modules link.
    const dir = await temporaryApp("compile-rollback");
    try {
      await mkdir(join(dir, "app"));
      await Bun.write(
        join(dir, "app/layout.tsx"),
        `"use client";export default function Layout({children}){return children}`,
      );
      await Bun.write(
        join(dir, "app/page.tsx"),
        "export default function Page(){return <text>ok</text>}",
      );
      const cli = (...flags: string[]) =>
        execute([process.execPath, resolve("packages/core/src/cli.ts"), "build", ...flags], {
          cwd: dir,
        });
      const outfile = join(dir, "dist/app-binary");
      const first = await cli("--compile", "--runtime", "host", "--outfile", outfile);
      expect(first.exitCode).toBe(0);
      const previous = await Bun.file(outfile).bytes();
      const { buildId } = await readManifest(dir);
      await Bun.write(
        join(dir, "app/page.tsx"),
        "export default function Page(){return <text>changed</text>}",
      );
      // The runtime is looked up once the Server is bundled: after the app build.
      const failed = await cli(
        "--compile",
        "--runtime",
        join(dir, "no-such-bun"),
        "--outfile",
        outfile,
      );
      expect(failed.exitCode).not.toBe(0);
      expect((await readManifest(dir)).buildId).toBe(buildId);
      expect(await Bun.file(outfile).bytes()).toEqual(previous);
      expect(await readdir(join(dir, "dist"))).toEqual(["app-binary"]);
      // Without --outfile the binary is part of the build, and so is its failure.
      const inside = await cli("--compile", "--runtime", join(dir, "no-such-bun"));
      expect(inside.exitCode).not.toBe(0);
      expect((await readManifest(dir)).buildId).toBe(buildId);
      // A successful rebuild publishes the binary with the build.
      const rebuilt = await cli("--compile", "--runtime", "host");
      expect(rebuilt.exitCode).toBe(0);
      expect((await readManifest(dir)).buildId).not.toBe(buildId);
      expect((await readdir(join(dir, ".luciole/bin"))).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS * 3,
);
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
    '"use client";import {getSession} from "@luciole-sh/core/server";export default function Layout({children}){return <text>{getSession().userId}</text>}',
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
      expect(await Bun.file(join(dir, ".luciole/manifest.json")).exists()).toBe(false);
    },
  );
});
test(
  "layouts and loadings belong to the build identity and the Client graph",
  async () => {
    await fixture(
      {
        "app/page.tsx": "export default function Page(){return <text>home</text>}",
        "app/loading.tsx":
          '"use client";export default function Loading(){return <text>wait</text>}',
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
  },
  BUILD_TEST_MS,
);

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
  "node_modules/leaky-sdk/index.js": `import {getSession} from "@luciole-sh/core/server";export const who=()=>getSession();`,
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
    expect(await Bun.file(join(dir, ".luciole/client/index.js")).text()).toContain(
      "TINY_FORMAT_SENTINEL",
    );
  });
});

test(
  "Client packages: one made for the Server is refused with its name",
  async () => {
    await fixture({ ...packages, ...clientUsing("db-client", "query") }, async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        "Client package db-client imports server-only: it is Server-only",
      );
      expect(await Bun.file(join(dir, ".luciole/manifest.json")).exists()).toBe(false);
    });
    await fixture({ ...packages, ...clientUsing("leaky-sdk", "who") }, async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toContain(
        "Client package leaky-sdk imports @luciole-sh/core/server: it is Server-only",
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
        expect(await Bun.file(join(dir, ".luciole/client/index.js")).text()).not.toContain(
          "SECRET_DB",
        );
      },
    );
  },
  BUILD_TEST_MS,
);

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
      expect(await Bun.file(join(dir, ".luciole/server/index.js")).text()).not.toContain("EDITOR");
    },
  );
});

test(
  "serverPackages keeps listed third-party packages out of the Client",
  async () => {
    const config = { "luciole.json": `{"serverPackages":["hasher"]}` };
    await fixture({ ...sidePackages, ...config, ...clientUsing("hasher", "hash") }, async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toMatch(
        /components\/widget\.tsx:1:\d+: Server-only package in Client graph: hasher \(serverPackages in luciole\.json\)\n {2}via app\/page\.tsx → components\/widget\.tsx/,
      );
    });
    await fixture(
      { ...sidePackages, ...config, ...clientUsing("auth-kit", "check") },
      async (dir) => {
        expect(messageOf(await rejectionOf(build(dir)))).toContain(
          "Client package auth-kit imports hasher: it is listed in serverPackages (luciole.json)\n  via app/page.tsx → components/widget.tsx → auth-kit/index.js → hasher",
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
        expect(await Bun.file(join(dir, ".luciole/client/index.js")).text()).not.toContain(
          "HASHER_SECRET",
        );
      },
    );
    for (const bad of [`{"serverPackages":"hasher"}`, `{"serverPackages":["hasher/sub"]}`, `nope`])
      await fixture(
        { ...sidePackages, "luciole.json": bad, ...clientUsing("auth-kit", "check") },
        async (dir) => {
          expect(messageOf(await rejectionOf(build(dir)))).toContain("luciole.json");
        },
      );
  },
  BUILD_TEST_MS,
);
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
      const server = await Bun.file(join(dir, ".luciole/server/index.js")).text();
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
      const client = await Bun.file(join(dir, ".luciole/client/index.js")).text();
      expect(client).toContain("node_modules/zod/v4/mini/");
      expect(client).not.toContain("node_modules/zod/v4/classic/");
      const server = await Bun.file(join(dir, ".luciole/server/index.js")).text();
      expect(server).toContain("node_modules/zod/v4/classic/");
    },
  );
});
test("concurrent builds take turns, and an unchanged build keeps the output in place", async () => {
  await fixture(
    { "app/page.tsx": `export default function Page(){return <text>HOME</text>}` },
    async (dir) => {
      await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
      // Two launches of one application at once: neither swaps directories under the other.
      const [first, second] = await Promise.all([build(dir), build(dir)]);
      expect(second.buildId).toBe(first.buildId);
      const server = join(dir, ".luciole/server/index.js");
      const { ino } = await stat(server);
      expect((await build(dir)).buildId).toBe(first.buildId);
      expect((await stat(server)).ino).toBe(ino);
      expect(await Bun.file(join(dir, ".luciole-lock")).exists()).toBe(false);
      // The declaration is part of the identity: its metadata would go stale otherwise.
      await Bun.write(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));
      const changed = await build(dir);
      expect(changed.buildId).not.toBe(first.buildId);
      expect((await stat(server)).ino).not.toBe(ino);
      // Other options, another output: the Worker Server is missing from the first.
      await build(dir, undefined, { webServer: true });
      expect(await Bun.file(join(dir, ".luciole/web-server/server-worker.js")).exists()).toBe(true);
    },
  );
}, 60000);
test("subpath imports (#name) join the graph: every target of every condition", async () => {
  await fixture(
    {
      "package.json": JSON.stringify({
        imports: {
          "#greeting": { browser: "./server/web.ts", default: "./server/terminal.ts" },
          "#parts/*": "./components/*.tsx",
        },
      }),
      "app/page.tsx": `import {greeting} from '#greeting';import {Badge} from '#parts/badge';export default function Page(){return <Badge text={greeting}/>}`,
      "server/terminal.ts": `import 'server-only';export const greeting='TERMINAL';`,
      "server/web.ts": `export const greeting='WEB';`,
      "components/badge.tsx": `"use client";export function Badge({text}:{text:string}){return <text>{text}</text>}`,
    },
    async (dir) => {
      await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
      const first = await build(dir);
      const manifest = await readManifest(dir);
      expect(manifest.serverGraph).toContain("server/terminal.ts");
      expect(manifest.serverGraph).toContain("server/web.ts");
      // A "use client" module reached by a subpath import is a Client Reference too.
      expect(manifest.manifest[`${first.buildId}/components/badge.tsx#Badge`]).toBeDefined();
      // The browser's target alone changed: still another build, not a stale one skipped.
      await Bun.write(join(dir, "server/web.ts"), `export const greeting='WEB 2';`);
      expect((await build(dir)).buildId).not.toBe(first.buildId);
    },
  );
}, 60000);
test("a syntax error and an unresolved import are reported where they are", async () => {
  // Line 3, column 11: the unclosed <text>'s tag; a reader (or a harness) fixes that line.
  await fixture(
    {
      "app/page.tsx": `export default function Page() {\n  return (\n    <box><text>unclosed</box>\n  );\n}\n`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toMatch(/^app\/page\.tsx:3:\d+: /);
    },
  );
  await fixture(
    {
      "app/page.tsx": `import { title } from "../lib/title";\nimport { Header } from "../components/Header";\nexport default function Page() {\n  return <Header title={title} />;\n}\n`,
      "lib/title.ts": `export const title = "t";\n`,
    },
    async (dir) => {
      expect(messageOf(await rejectionOf(build(dir)))).toBe(
        "app/page.tsx:2:1: Cannot resolve ../components/Header",
      );
    },
  );
});
test("a Client-only React hook in a Server Component fails the build where it is imported", async () => {
  // Without the check the build succeeds and the Server dies at start on a missing export.
  await fixture(
    {
      "app/page.tsx": `import { useMemo, useState } from "react";\nexport default function Page() {\n  const [name] = useState(useMemo(() => "", []));\n  return <text>{name}</text>;\n}\n`,
    },
    async (dir) => {
      const message = messageOf(await rejectionOf(build(dir)));
      expect(message).toMatch(/^app\/page\.tsx:1:19: useState is Client-only React/);
      expect(message).toContain('Add "use client"');
    },
  );
  // Behind "use client", the same hook is the Client's.
  await fixture(
    {
      "app/page.tsx": `import { Name } from "../components/Name";\nexport default function Page() {\n  return <Name />;\n}\n`,
      "components/Name.tsx": `"use client";\nimport { useState } from "react";\nexport function Name() {\n  const [name] = useState("");\n  return <text>{name}</text>;\n}\n`,
    },
    async (dir) => {
      await build(dir);
    },
  );
});
