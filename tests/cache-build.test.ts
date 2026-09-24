import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/build";
import { messageOf } from "../src/guards";
import { rejectionOf } from "./helpers";

async function fixture(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "airtty-cache-build-"));
  try {
    for (const [name, text] of Object.entries({
      "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
      "app/page.tsx": `import {read} from "../server/q";export default async function Page(){return <text>{String(await read())}</text>}`,
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

test("module and function directives wrap exported async functions on the Server only", async () => {
  await fixture(
    {
      "server/q.ts": `"use cache";import {helper} from "./h";export type T=number;async function local(){return 1}export async function read(){return helper()+await local()}export async function other(){return 2}`,
      "server/h.ts": `export const helper=()=>1;export async function fn(n:number){"use cache";return n}`,
    },
    async (dir) => {
      await build(dir);
      const server = await readFile(join(dir, ".airtty/server/index.js"), "utf8");
      for (const id of ["server/q.ts#read", "server/q.ts#other", "server/h.ts#fn"])
        expect(server).toContain(JSON.stringify(id));
      expect(server).not.toContain('"server/q.ts#local"');
    },
  );
});

for (const [name, files, message] of [
  [
    "a closure",
    {
      "server/q.ts": `export async function read(){const inner=async()=>{"use cache";return 1};return inner()}`,
    },
    "closures, methods and arrow functions are unsupported",
  ],
  [
    "a function that is not exported",
    {
      "server/q.ts": `async function hidden(){"use cache";return 1}export async function read(){return hidden()}`,
    },
    "closures, methods and arrow functions are unsupported",
  ],
  [
    "a synchronous function",
    { "server/q.ts": `export function read(){"use cache";return 1}` },
    "named, exported, async function declarations",
  ],
  [
    "a default export",
    {
      "app/page.tsx": `export default async function Page(){"use cache";return <text>page</text>}`,
    },
    "a default export (a page component) is unsupported",
  ],
  [
    "a directive after other statements",
    { "server/q.ts": `export async function read(){const a=1;"use cache";return a}` },
    '"use cache" must open the function body',
  ],
  [
    "an exported value in a cached module",
    { "server/q.ts": `"use cache";export const value=1;export async function read(){return 1}` },
    "named, exported, async function declarations",
  ],
  [
    "a reexport from a cached module",
    {
      "server/q.ts": `"use cache";export {read} from "./r"`,
      "server/r.ts": `export async function read(){return 1}`,
    },
    "cannot reexport",
  ],
  [
    "a Server Function",
    {
      "server/q.ts": `export async function read(){return 1}`,
      "actions/a.ts": `"use server";export async function act(){"use cache";return 1}`,
      "app/page.tsx": `import {act} from "../actions/a";import {read} from "../server/q";export default async function Page(){return <text>{String(await read())}{String(act)}</text>}`,
    },
    'unavailable in a "use server" module',
  ],
  [
    "conflicting module directives",
    { "server/q.ts": `"use cache";"use server";export async function read(){return 1}` },
    "Conflicting directives",
  ],
  [
    "a cached module in the Client graph",
    {
      "app/page.tsx": `import {View} from "../components/View";export default function Page(){return <View/>}`,
      "components/View.tsx": `"use client";import {read} from "../lib/q";export function View(){void read;return <text>v</text>}`,
      "lib/q.ts": `"use cache";export async function read(){return 1}`,
    },
    '"use cache" module in Client graph',
  ],
  [
    "a staleTime that is not a number",
    {
      "server/q.ts": `export async function read(){return 1}`,
      "app/other/page.tsx": `export const staleTime="long";export default function P(){return <text>p</text>}`,
    },
    "staleTime must be a number of seconds",
  ],
] as const)
  test(`refuses ${name}, naming the file and line`, async () => {
    await fixture(files, async (dir) => {
      const error = messageOf(await rejectionOf(build(dir)));
      expect(error).toContain(message);
      expect(error).toMatch(/\.tsx?:\d+:\d+:/);
    });
  });

test("a page's staleTime, in seconds, becomes its router staleTime in milliseconds", async () => {
  await fixture(
    {
      "server/q.ts": `export async function read(){return 1}`,
      "app/list/page.tsx": `export const staleTime = 5 * 60;export default function P(){return <text>p</text>}`,
    },
    async (dir) => {
      await build(dir);
      const tree = await readFile(join(dir, "app/routeTree.gen.ts"), "utf8");
      expect(tree).toContain('path: "list",\n  staleTime: 300000,\n');
      expect(tree.match(/staleTime/g)).toHaveLength(1);
    },
  );
});
