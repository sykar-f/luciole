import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { ROUTE_TREE_FILE } from "../src/route-graph";

// Inside the checkout so `@terminal/framework` and TanStack resolve like in an example.
test("generated route tree types navigation targets and params", async () => {
  const dir = await mkdtemp(join(resolve("."), ".route-types-"));
  try {
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({
        extends: "../tsconfig.base.json",
        include: ["app", "components"],
      }),
      "app/layout.tsx": `"use client";import type {LayoutProps} from "@terminal/framework/client";export default function Layout({children}:LayoutProps){return <box>{children}</box>}`,
      "app/page.tsx": "export default function Page(){return <text>home</text>}",
      "app/notes/[id]/page.tsx": "export default function Page(){return <text>note</text>}",
      "app/(g)/layout.tsx": `"use client";import {useParams,type LayoutProps} from "@terminal/framework/client";export default function G({children}:LayoutProps){const {section}=useParams({strict:false});return <box><text>{section??""}</text>{children}</box>}`,
      "app/(g)/settings/[section]/page.tsx":
        "export default function Page(){return <text>s</text>}",
      "components/Good.tsx": `"use client";
import { useNavigate } from "@terminal/framework/client";
export function Good() {
  const navigate = useNavigate();
  void navigate({ to: "/notes/$id", params: { id: "1" } });
  void navigate({ to: "/settings/$section", params: { section: "a" } });
  void navigate({ to: "/notes/$id", params: { id: "1" }, search: { tab: "files" } });
  return null;
}`,
      "components/Bad.tsx": `"use client";
import { useNavigate } from "@terminal/framework/client";
export function Bad() {
  const navigate = useNavigate();
  void navigate({ to: "/missing" });
  void navigate({ to: "/notes/$id" });
  void navigate({ to: "/notes/$id", params: { note: "1" } });
  void navigate({ to: "/notes/$id", params: { id: 1 } });
  void navigate({ to: "/notes/$id", params: { id: "1" }, search: { tab: 1 } });
  return null;
}`,
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    await build(dir);
    const tsc = Bun.spawn([resolve("node_modules/.bin/tsc"), "--noEmit", "-p", dir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(tsc.stdout).text();
    await tsc.exited;
    const lines = [...output.matchAll(/components\/(\w+)\.tsx\((\d+),/g)].map(
      ([, file, line]) => `${file}:${line}`,
    );
    expect(lines).toEqual(["Bad:5", "Bad:6", "Bad:7", "Bad:8", "Bad:9"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

test("checked-in example route trees match the route graph", async () => {
  for (const example of ["examples/notes", "examples/latency", "examples/forge"]) {
    const file = join(resolve(example), ROUTE_TREE_FILE);
    const committed = await readFile(file, "utf8");
    await build(resolve(example));
    expect(await readFile(file, "utf8")).toBe(committed);
  }
});
