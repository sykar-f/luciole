import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CliRenderer } from "@opentui/core";
import { defaultCache } from "../packages/core/src/compile";
import { prepareWebRuntime } from "../packages/core/src/web-runtime";
import { opentuiWasm } from "../packages/core/src/web/opentui/plugin";
import { detectOpenTuiSeams } from "../packages/core/src/web/opentui-seams";

const root = resolve(import.meta.dir, "..");
const INTEGRATION_MS = 240_000;

test("native OpenTUI reports the missing seams for fallback", () => {
  const absent = detectOpenTuiSeams({} as CliRenderer);
  expect(absent).toEqual({
    available: false,
    missing: ["setFramePlan", "captureHitMap", "dispatchMouseEventFromHitMap"],
  });
  const partial = detectOpenTuiSeams({ setFramePlan() {} } as unknown as CliRenderer);
  expect(partial).toEqual({
    available: false,
    missing: ["captureHitMap", "dispatchMouseEventFromHitMap"],
  });
});

// Selected integration: builds the same patched sources/WASM as the web runtime.
// Explicit opt-in keeps network, Zig and browser prerequisites out of unit runs.
test.skipIf(process.env["LUCIOLE_OPENTUI_INTEGRATION"] !== "1")(
  "patched OpenTUI renderer seams over the web WASM/feed path",
  async () => {
    const runtime = await prepareWebRuntime();
    const patch = await readFile(join(root, "packages/core/web/opentui-v0.5.12.patch"));
    const key = createHash("sha256").update(patch).digest("hex").slice(0, 16);
    const checkout = join(defaultCache(), "web", `opentui-v0.5.12-${key}`);
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

test.skipIf(process.env["LUCIOLE_WEB_SMOKE"] !== "1")(
  "existing Notes browser journey with the patched renderer",
  async () => {
    const child = Bun.spawn([process.execPath, "scripts/web/notes.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
  },
  INTEGRATION_MS,
);
