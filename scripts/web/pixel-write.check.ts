/** Selected page attachment proof against the actual patched WASM output queue. */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openTuiCheckoutDirectory, prepareWebRuntime } from "../../packages/core/src/web-runtime";
import { opentuiWasm } from "../../packages/core/src/web/opentui/plugin";

const TIMEOUT_MS = 240_000;
test(
  "runInPage orders pixel writes and observes their failures",
  async () => {
    const runtime = await prepareWebRuntime();
    const checkout = openTuiCheckoutDirectory();
    const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "web-pixel-write-"));
    const stubs = resolve("tests/web-pixel-page-stubs.ts");
    const result = await Bun.build({
      entrypoints: [resolve("tests/web-pixel-write-fixture.ts")],
      outdir: directory,
      naming: "fixture.test.js",
      target: "bun",
      external: ["bun:test"],
      plugins: [
        opentuiWasm,
        {
          name: "page-ui-and-patched-core",
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (
                args.importer.endsWith("/web/platform/run.tsx") &&
                [
                  "@xterm/xterm",
                  "@xterm/addon-fit",
                  "../terminal-view",
                  "../../pixel-scroll/attach",
                  "@opentui/core",
                  "@opentui/react",
                  "../../client",
                  "../wheel-room",
                  "../embed",
                ].includes(args.path)
              )
                return { path: stubs };
              if (args.path === "@opentui/core")
                return { path: join(checkout, "packages/core/src/index.ts") };
              return undefined;
            });
          },
        },
      ],
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const preload = join(directory, "preload.ts");
    await Bun.write(
      preload,
      `Object.assign(globalThis, { window: globalThis, parent: globalThis, location: { search: "" } }); globalThis.OPENTUI_WASM = new Uint8Array(await Bun.file(${JSON.stringify(join(runtime, "opentui.wasm"))}).arrayBuffer());`,
    );
    const child = Bun.spawn(
      [process.execPath, "test", "--preload", preload, join(directory, "fixture.test.js")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    console.log(stdout + stderr);
    expect(code).toBe(0);
  },
  TIMEOUT_MS,
);
