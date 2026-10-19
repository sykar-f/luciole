import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import { openTuiCheckoutDirectory, webRuntimeDirectory } from "../packages/core/src/web-runtime";
import { opentuiWasm } from "../packages/core/src/web/opentui/plugin";
import {
  detectOpenTuiSeams,
  detectOpenTuiMouseObserver,
  detectOpenTuiControlWriter,
} from "../packages/core/src/opentui-seams";

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
    const checkout = openTuiCheckoutDirectory();
    const directory = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "opentui-seams-"));
    const result = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "opentui-seams-fixture.ts"),
        join(checkout, "packages/core/src/tests/pixel-seams.test.ts"),
      ],
      outdir: directory,
      naming: "[name].test.js",
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
      [
        process.execPath,
        "test",
        "--preload",
        preload,
        join(directory, "opentui-seams-fixture.test.js"),
        join(directory, "pixel-seams.test.test.js"),
      ],
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

test("input observer and control writer detections are independent and reject missing methods", () => {
  for (const candidate of [
    undefined,
    null,
    false,
    1,
    "renderer",
    {},
    { observeMouseInput: true, writeControl: 1 },
  ]) {
    expect(detectOpenTuiMouseObserver(candidate)).toEqual({
      available: false,
      missing: ["observeMouseInput"],
    });
    expect(detectOpenTuiControlWriter(candidate)).toEqual({
      available: false,
      missing: ["writeControl"],
    });
  }
  const observer = {
    observeMouseInput() {
      return () => {};
    },
  };
  const writer = { async writeControl() {} };
  const observed = detectOpenTuiMouseObserver(observer);
  expect(observed.available).toBe(true);
  expect(observed.available && Object.is(observed.renderer, observer)).toBe(true);
  expect(detectOpenTuiControlWriter(observer).available).toBe(false);
  const written = detectOpenTuiControlWriter(writer);
  expect(written.available).toBe(true);
  expect(written.available && Object.is(written.renderer, writer)).toBe(true);
  expect(detectOpenTuiMouseObserver(writer).available).toBe(false);
});

test.skipIf(process.env["LUCIOLE_OPENTUI_INTEGRATION"] !== "1")(
  "pixel patch alone applies at v0.6.6 and passes native ABI and pixel groups",
  async () => {
    const directory = await mkdtemp(
      join(process.env["TMPDIR"] ?? tmpdir(), "opentui-native-seams-"),
    );
    const checkout = join(directory, "opentui");
    const execute = async (command: string[], cwd = root) => {
      const child = Bun.spawn(command, {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        signal: AbortSignal.timeout(INTEGRATION_MS - 5_000),
      });
      expect(await child.exited).toBe(0);
    };
    await execute([
      process.execPath,
      "--eval",
      `
      import { prepareOpenTuiCheckout } from ${JSON.stringify(join(root, "packages/core/src/web-runtime.ts"))};
      const tree = prepareOpenTuiCheckout(${JSON.stringify(checkout)}, "https://github.com/anomalyco/opentui", "v0.6.6", [${JSON.stringify(join(root, "packages/core/web/opentui-v0.6.6-pixel-scroll.patch"))}]);
      console.log("native pixel-only source tree:", tree);
    `,
    ]);
    await execute([process.execPath, "install", "--frozen-lockfile"], checkout);
    await execute([process.execPath, "packages/core/scripts/native-abi.ts", "--check"], checkout);
    const native = join(checkout, "packages/native");
    await execute([process.execPath, "run", "prepare:zig"], native);
    const zig = process.env["ZIG"] ?? "zig";
    for (const group of ["Pixel", "Scene", "renderer", "Session"])
      await execute([zig, "build", "test", `-Dtest-filter=${group}`, "--summary", "all"], native);
    await execute([zig, "build", "test-abi", "--summary", "all"], native);
  },
  // Each native filter compiles a separate test executable on a cold cache.
  INTEGRATION_MS * 3,
);
