import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { AppManifest } from "../packages/core/src/abi";
import { evaluateAppBundle } from "../packages/core/src/app-evaluate";
import { build } from "../packages/core/src/build";
import { BUILD_TEST_MS, temporaryApp } from "./helpers";

test(
  "importing math evaluates in a browser host without Node built-ins",
  async () => {
    const directory = await temporaryApp("optional-bundle");
    try {
      await mkdir(join(directory, "app"));
      await Bun.write(
        join(directory, "app/layout.tsx"),
        '"use client";export default function Layout({children}){return children}',
      );
      await Bun.write(
        join(directory, "app/page.tsx"),
        '"use client";export {renderMath} from "@luciole-sh/core/math";export default function Page(){return <text>MATH_READY</text>}',
      );
      const { buildId } = await build(directory);
      const file = join(directory, ".luciole/app/index.cjs");
      const code = await Bun.file(file).text();
      const manifest = AppManifest.parse(
        await Bun.file(join(directory, ".luciole/app/manifest.json")).json(),
      );
      // The web host has no builtin loader. Importing math must not initialize
      // the Node package-resolution guard used only by build-time features.
      const loaded = evaluateAppBundle({
        manifest,
        publisher: undefined,
        code,
        sha256: createHash("sha256").update(code).digest("hex"),
        file,
        directory,
        compile: (source, filename): unknown => runInThisContext(source, { filename }),
      });
      expect(loaded.modules.get(`${buildId}/app/page.tsx`)?.renderMath).toBeFunction();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
