import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeRuntimePlugin } from "../packages/core/src/native-runtime-plugin";
import { execute } from "./helpers";

test.each([false, true])(
  "prepared core unifies bare, subpath and absolute imports and keeps installed dependencies (symlink: %s)",
  async (linked) => {
    const root = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "native-plugin-"));
    const installed = dirname(Bun.resolveSync("@opentui/core", resolve("packages/core/src")));
    try {
      const core = join(root, "runtime/core");
      await Bun.write(
        join(core, "package.json"),
        JSON.stringify({
          exports: {
            ".": { bun: "./index.bun.js", import: "./wrong.js" },
            "./testing": { import: "./testing.js" },
            "./nested/export": "./nested.js",
            "./default": { default: "./default.js" },
          },
        }),
      );
      await Bun.write(
        join(core, "index.bun.js"),
        `
      import width from "string-width";
      import {basename} from "node:path";
      import {version} from "bun";
      export const singleton = {};
      export const value = [width("界"), basename("/a/b"), typeof version];
    `,
      );
      await Bun.write(join(core, "testing.js"), 'export {singleton} from "./index.bun.js";');
      await Bun.write(join(core, "nested.js"), 'export const nested = "nested";');
      await Bun.write(join(core, "default.js"), 'export const fallback = "default";');
      await Bun.write(
        join(root, "runtime/library/index.bun.js"),
        'export default "paired library";',
      );
      const runtime = join(root, linked ? "runtime-link" : "runtime");
      if (linked) await symlink(join(root, "runtime"), runtime, "dir");
      const entry = join(root, "entry.js");
      const nativeImports = ["darwin-arm64", "linux-x64", "linux-x64-musl", "win32-x64"]
        .map((target, i) => `import native${i} from "@opentui/core-${target}";`)
        .join("\n");
      await Bun.write(
        entry,
        `
      import {singleton as bare, value} from "@opentui/core";
      import {singleton as testing} from "@opentui/core/testing";
      import {singleton as absolute} from ${JSON.stringify(join(installed, "index.bun.js"))};
      import {singleton as absoluteTesting} from ${JSON.stringify(join(installed, "testing.js"))};
      import {nested} from "@opentui/core/nested/export";
      import {fallback} from "@opentui/core/default";
      ${nativeImports}
      console.log(JSON.stringify([bare === testing && bare === absolute && bare === absoluteTesting,
        value, nested, fallback, native0, native1, native2, native3]));
    `,
      );
      const result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        outdir: join(root, "bundle"),
        plugins: [nativeRuntimePlugin(runtime)],
      });
      expect(result.success).toBe(true);
      const run = await execute([process.execPath, join(root, "bundle/entry.js")]);
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual([
        true,
        [2, "b", "string"],
        "nested",
        "default",
        "paired library",
        "paired library",
        "paired library",
        "paired library",
      ]);
      await Bun.write(entry, 'import "@opentui/core/missing";');
      const missing = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        plugins: [nativeRuntimePlugin(runtime)],
        throw: false,
      });
      expect(missing.success).toBe(false);
      expect(missing.logs.map(String).join("\n")).toContain("Prepared OpenTUI has no export");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
