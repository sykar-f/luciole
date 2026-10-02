/**
 * What `@luciole-sh/markdown-editor` would publish: ESM with `.js` imports that resolve, declarations,
 * every `exports` target inside `files`, React and OpenTUI as peers.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import manifest from "../package.json";

const root = join(import.meta.dir, "..");

test("the build is ESM whose relative imports all resolve", () => {
  const out = mkdtempSync(join(tmpdir(), "editor-dist-"));
  try {
    const built = Bun.spawnSync([process.execPath, join(root, "scripts/build.ts"), out], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.stderr.toString()).toBe("");
    expect(built.exitCode).toBe(0);
    const files = readdirSync(out, { recursive: true, encoding: "utf8" });
    expect(files).toContain("index.js");
    expect(files).toContain("index.d.ts");
    for (const file of files.filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(join(out, file), "utf8");
      expect(source).not.toContain("require(");
      for (const [, specifier = ""] of source.matchAll(/from "(\.[^"]+)"/g)) {
        expect(specifier).toEndWith(".js");
        expect(existsSync(join(out, dirname(file), specifier))).toBe(true);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("exports stay inside the published files; React and OpenTUI are peers, marked the one dependency", () => {
  const entry = manifest.exports["."];
  for (const target of [entry.bun, entry.types, entry.default]) {
    const top = relative(".", target).split("/")[0] ?? "";
    expect(manifest.files).toContain(top);
  }
  expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
    "@opentui/core",
    "@opentui/react",
    "react",
  ]);
  // Its one dependency reads Markdown; everything that draws is the application's.
  expect(Object.keys(manifest.dependencies)).toEqual(["marked"]);
  expect(manifest.license).toBe("MIT");
});
