import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/core/src/build";
import { importClient, temporaryApp } from "./helpers";

test("built bundles link source maps that point at the original lines", async () => {
  const dir = await temporaryApp("source-maps");
  try {
    const files: Record<string, string> = {
      "app/layout.tsx": `"use client";\nimport type { LayoutProps } from "@luciole-sh/core/client";\nexport default function Layout({ children }: LayoutProps) {\n  return <box>{children}</box>;\n}\n`,
      "app/page.tsx": `import { Boom } from "../components/Boom";\nexport default function Page() {\n  return <Boom />;\n}\n`,
      "components/Boom.tsx": `"use client";\nimport { useState } from "react";\n\ntype Props = { label?: string };\n\nexport function Boom(_props: Props) {\n  const [count] = useState(0);\n  return <text>{count}</text>;\n}\nexport function explode(): never {\n  throw new Error("boom");\n}\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    const { buildId, output } = await build(dir);
    expect(await Bun.file(join(output, "client/index.js.map")).exists()).toBe(true);
    expect(await Bun.file(join(output, "server/index.js.map")).exists()).toBe(true);
    const client = await importClient(dir, "source-maps");
    const app = client.createApp({ url: "http://terminal.invalid" });
    const { explode } = app.options.resolveModule(`${buildId}/components/Boom.tsx`);
    if (typeof explode !== "function") throw new Error("explode is not exported");
    let stack = "";
    try {
      Reflect.apply(explode, undefined, []);
    } catch (error) {
      stack = error instanceof Error ? String(error.stack) : "";
    }
    // The type lines Bun strips do not shift the line: the bundle's map is the source's.
    expect(stack).toContain(`${join(dir, "components/Boom.tsx")}:11:`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("JavaScript JSX maps an exception to its original line", async () => {
  const dir = await temporaryApp("source-maps-jsx");
  try {
    const files: Record<string, string> = {
      "app/layout.tsx": `"use client";export default function Layout({children}) { return children; }`,
      "app/page.tsx": `import { Boom } from "../Boom.jsx"; export default function Page() { return <Boom />; }`,
      "Boom.jsx": `"use client";
export function Boom() {
  return <text>JavaScript</text>;
}

export function explode() {
  throw new Error("original JSX line");
}
`,
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name, ".."), { recursive: true });
      await Bun.write(join(dir, name), text);
    }
    const { buildId } = await build(dir);
    const client = await importClient(dir, "source-maps-jsx");
    const app = client.createApp({ url: "http://terminal.invalid" });
    const { explode } = app.options.resolveModule(`${buildId}/Boom.jsx`);
    if (typeof explode !== "function") throw new Error("explode is not exported");
    let stack = "";
    try {
      Reflect.apply(explode, undefined, []);
    } catch (error) {
      stack = error instanceof Error ? String(error.stack) : "";
    }
    expect(stack).toContain(`${join(dir, "Boom.jsx")}:7:`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
