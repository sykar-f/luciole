/** On demand: Zig 0.16.0 + network + Chrome; no version pin changes and no CI discovery. */
import { test, expect } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import * as z from "zod/mini";
import { defaultCache } from "../../packages/core/src/compile";
import { prepareWebRuntimeEntry } from "../../packages/core/src/web-runtime";
import { browserNode } from "../../packages/core/src/web/node/plugin";
import { opentuiWasmFor } from "../../packages/core/src/web/opentui/plugin";
import { Browser } from "./cdp";

const VERSION = "0.6.6";
const HASH_LENGTH = 16;
const TIMEOUT_MS = 240_000;
const Result = z.object({ ok: z.literal(true) });

test(
  "OpenTUI 0.6.6 wasm32: box, changing text, and cells after memory growth",
  async () => {
    const patch = join(import.meta.dir, `../../packages/core/web/opentui-v${VERSION}.patch`);
    const patchKey = createHash("sha256")
      .update(readFileSync(patch))
      .digest("hex")
      .slice(0, HASH_LENGTH);
    const checkout = join(defaultCache(), "web", `opentui-v${VERSION}-${patchKey}`);
    const scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "opentui-066-"));
    const directory = await prepareWebRuntimeEntry({
      directory: join(scratch, "page"),
      checkout,
      async build(outdir) {
        // The synchronous Zig build runs in a child so it cannot block the test watchdog.
        const child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `
        import { prepareOpenTui } from ${JSON.stringify(join(import.meta.dir, "../../packages/core/src/web-runtime.ts"))};
        prepareOpenTui(${JSON.stringify(checkout)}, ${JSON.stringify(process.env["ZIG"] ?? "zig")},
          { tag: "v${VERSION}", patch: ${JSON.stringify(patch)} });
      `,
          ],
          { stdout: "inherit", stderr: "inherit", signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        expect(await child.exited).toBe(0);
        const sources: BunPlugin = {
          name: "opentui-066-sources",
          setup(build) {
            build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
              path: join(checkout, "packages/core/src/index.ts"),
            }));
            build.onResolve({ filter: /^@opentui\/core\/testing$/ }, () => ({
              path: join(checkout, "packages/core/src/testing.ts"),
            }));
          },
        };
        const bundled = await Bun.build({
          entrypoints: [join(import.meta.dir, "opentui-066-page.ts")],
          outdir,
          naming: "page.js",
          target: "browser",
          format: "esm",
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
          plugins: [opentuiWasmFor(VERSION), sources, browserNode],
        });
        if (!bundled.success) throw new Error(bundled.logs.map(String).join("\n"));
        copyFileSync(
          join(checkout, "packages/native/lib/wasm32-wasi/opentui.wasm"),
          join(outdir, "opentui.wasm"),
        );
        await Bun.write(
          join(outdir, "index.html"),
          '<!doctype html><meta charset="utf-8"><script type="module" src="page.js"></script>',
        );
      },
    });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        return new Response(Bun.file(join(directory, path === "/" ? "index.html" : path.slice(1))));
      },
    });
    try {
      await using browser = await Browser.start();
      await browser.open(`http://127.0.0.1:${server.port}/`);
      const result = await browser.waitFor("globalThis.__opentui066", "OpenTUI 0.6.6 WASM results");
      console.log(
        JSON.stringify({ ua: await browser.evaluate("navigator.userAgent"), result }, null, 2),
      );
      Result.parse(result);
    } finally {
      await server.stop(true);
    }
  },
  TIMEOUT_MS,
);
