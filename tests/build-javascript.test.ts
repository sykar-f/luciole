import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { build } from "../packages/core/src/build";
import { BUILD_TEST_MS } from "./helpers";

test("JavaScript load hooks leave transformation to Bun", async () => {
  // TypeScript's transpileModule export is a non-configurable accessor, so it cannot
  // be spied on. Inspect the registered load callbacks, including nested functions,
  // to distinguish the frozen graph diagnostics call from the load path.
  const source = await Bun.file(resolve("packages/core/src/build.ts")).text();
  const ast = ts.createSourceFile("build.ts", source, ts.ScriptTarget.Latest, true);
  const callbacks: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "onLoad"
    ) {
      const callback = node.arguments[1];
      if (callback) callbacks.push(callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(callbacks.length).toBeGreaterThan(0);
  for (const callback of callbacks) expect(callback.getText(ast)).not.toContain("transpileModule");
});

for (const fileName of ["module.js", "module.jsx"])
  test(`TypeScript already preserves unused JavaScript imports in ${fileName}`, () => {
    const source = `import Default from "default-package";
import { Unused } from "named-package";
import * as Namespace from "namespace-package";
import { Model } from "model-package";
/** @type {Model} */ export let model;
export const value = 1;`;
    const output = ts.transpileModule(source, {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        jsxImportSource: "react",
      },
    }).outputText;
    for (const name of ["default-package", "named-package", "namespace-package", "model-package"])
      expect(output).toContain(`from "${name}"`);
  });

test(
  "JavaScript packages and application JSX use each role's native runtime",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "luciole-build-javascript-"));
    const imports: { importer: string; path: string; role: string }[] = [];
    const nativeBuild = Bun.build;
    const observer = spyOn(Bun, "build").mockImplementation((options) => {
      const role = options.outdir ?? "";
      return nativeBuild({
        ...options,
        plugins: [
          ...(options.plugins ?? []),
          {
            name: "observe-javascript-runtime",
            setup(b) {
              b.onResolve({ filter: /jsx-runtime$/ }, (args) => {
                imports.push({ importer: args.importer, path: args.path, role });
                return undefined;
              });
            },
          },
        ],
      });
    });
    try {
      await mkdir(join(dir, "node_modules"));
      for (const name of await readdir(resolve("node_modules")))
        await symlink(resolve("node_modules", name), join(dir, "node_modules", name));
      const files: Record<string, string> = {
        "node_modules/native-js-fixture/package.json": JSON.stringify({
          name: "native-js-fixture",
          type: "module",
          exports: { "./plain": "./plain.js", "./jsx": "./view.jsx" },
        }),
        "node_modules/native-js-fixture/plain.js": `export function Plain() { return <text>PLAIN_JS_SENTINEL</text>; }`,
        "node_modules/native-js-fixture/view.jsx": `export function View() { return <text>PACKAGE_JSX_SENTINEL</text>; }`,
        "app/layout.tsx": `"use client";export default function Layout({children}) { return children; }`,
        "app/page.tsx": `import { Plain } from "native-js-fixture/plain";
import { View } from "native-js-fixture/jsx";
import { Application } from "../application.jsx";
import { Client } from "../client.jsx";
import { answer } from "../hashbang.js";
export default async function Page() { return <><Plain/><View/><Application/><Client/>{await answer()}</>; }`,
        "application.jsx": `export async function Application() { await Promise.resolve(); return <text>APPLICATION_JSX_SENTINEL</text>; }`,
        "client.jsx": `"use client";
import { Plain } from "native-js-fixture/plain";
import { View } from "native-js-fixture/jsx";
export function Client() { return <><Plain/><View/></>; }`,
        "hashbang.js": `#!/usr/bin/env bun\nexport async function answer() { return await Promise.resolve("HASHBANG_SENTINEL"); }`,
      };
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(dir, name, ".."), { recursive: true });
        await Bun.write(join(dir, name), text);
      }
      const { output } = await build(dir, undefined, { webServer: true });
      for (const [role, runtime] of [
        ["server", "react"],
        ["client", "@opentui/react"],
        ["web-server", "react"],
      ]) {
        for (const file of [
          "plain.js",
          "view.jsx",
          role === "client" ? "client.jsx" : "application.jsx",
        ]) {
          expect(
            imports.some(
              (i) =>
                i.role.endsWith(`/${role}`) &&
                i.importer.endsWith(`/${file}`) &&
                i.path === `${runtime}/jsx-runtime`,
            ),
          ).toBe(true);
        }
      }
      const server = await Bun.file(join(output, "server/index.js")).text();
      expect(server).toContain("HASHBANG_SENTINEL");
      const worker = await Bun.file(join(output, "web-server/server-worker.js")).text();
      expect(worker).toContain("HASHBANG_SENTINEL");
      expect(worker).toContain("APPLICATION_JSX_SENTINEL");
      expect(worker).toMatch(/resume\([^\n]*save\(\), await Promise.resolve\(/);
      expect(await Bun.file(join(output, "client/index.js")).text()).toContain("Client.__luciole");
    } finally {
      observer.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
