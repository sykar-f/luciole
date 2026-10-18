import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import { defaultCache } from "../packages/core/src/compile";
import { webRuntimeDirectory } from "../packages/core/src/web-runtime";
import { opentuiWasm } from "../packages/core/src/web/opentui/plugin";
import { detectOpenTuiSeams } from "../packages/core/src/web/opentui-seams";

const root = resolve(import.meta.dir, "..");
const INTEGRATION_MS = 240_000;

test("native OpenTUI reports the missing seams for fallback", async () => {
  const { renderer } = await createTestRenderer({ width: 8, height: 2 });
  try {
    expect(detectOpenTuiSeams(renderer)).toEqual({
      available: false,
      missing: ["setFramePlan", "captureHitMap", "dispatchMouseEventFromHitMap"],
    });
    Object.assign(renderer, { setFramePlan() {} });
    expect(detectOpenTuiSeams(renderer)).toEqual({
      available: false,
      missing: ["captureHitMap", "dispatchMouseEventFromHitMap"],
    });
  } finally {
    renderer.destroy();
  }
});

// Selected integration: builds the same patched sources/WASM as the web runtime.
// Explicit opt-in keeps network, Zig and browser prerequisites out of unit runs.
test.skipIf(process.env["LUCIOLE_OPENTUI_INTEGRATION"] !== "1")(
  "patched OpenTUI renderer seams over the web WASM/feed path",
  async () => {
    // Preparation uses synchronous external tools. Keep it off the test worker so
    // a cold clone/build cannot silence its watchdog or block the test timeout.
    const prepare = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { prepareWebRuntime } from ${JSON.stringify(join(root, "packages/core/src/web-runtime.ts"))}; await prepareWebRuntime();`,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(INTEGRATION_MS - 5_000),
      },
    );
    const [preparedOut, preparedErr, preparedCode] = await Promise.all([
      new Response(prepare.stdout).text(),
      new Response(prepare.stderr).text(),
      prepare.exited,
    ]);
    expect({ code: preparedCode, output: preparedOut + preparedErr }).toMatchObject({ code: 0 });
    const runtime = await webRuntimeDirectory();
    const patch = await readFile(join(root, "packages/core/web/opentui-v0.6.6.patch"));
    const key = createHash("sha256").update(patch).digest("hex").slice(0, 16);
    const checkout = join(defaultCache(), "web", `opentui-v0.6.6-${key}`);
    const directory = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "opentui-seams-"));
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "opentui-seams-fixture.ts")],
      outdir: directory,
      naming: "seams.test.js",
      target: "bun",
      format: "esm",
      external: ["bun:test"],
      plugins: [
        opentuiWasm,
        {
          name: "patched-opentui",
          setup(build) {
            build.onResolve({ filter: /\/testing\/test-streams$/ }, () => ({
              path: join(checkout, "packages/core/src/testing/test-streams.ts"),
            }));
            build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
              path: join(checkout, "packages/core/src/index.ts"),
            }));
            build.onResolve({ filter: /^@opentui\/core\/testing$/ }, () => ({
              path: join(checkout, "packages/core/src/testing/test-renderer.ts"),
            }));
          },
        },
      ],
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const preload = join(directory, "preload.ts");
    await Bun.write(
      preload,
      `globalThis.OPENTUI_WASM = new Uint8Array(await Bun.file(${JSON.stringify(join(runtime, "opentui.wasm"))}).arrayBuffer());\n`,
    );
    const child = Bun.spawn(
      [process.execPath, "test", "--preload", preload, join(directory, "seams.test.js")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  },
  INTEGRATION_MS,
);
