/** On demand: Zig 0.17.0 + network; builds the host runtime without FFmpeg. */
import { expect, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { readFileSync } from "node:fs";
import { nativeRuntimePlugin } from "../../packages/core/src/native-runtime-plugin";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findNativeRuntime,
  nativeRuntimeIdentity,
  NATIVE_TARGETS,
} from "../../packages/core/src/native-runtime";
import { hostTarget } from "../../packages/core/src/targets";

const TIMEOUT_MS = 600_000;
test(
  "OpenTUI 0.8.1 prepared native runtime builds, loads and reuses without Zig",
  async () => {
    const cache = join(process.env["TMPDIR"] ?? tmpdir(), "opentui-081-native-cache");
    const module = join(import.meta.dir, "../../packages/core/src/native-runtime.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import {prepareNativeRuntime} from ${JSON.stringify(module)};
    await prepareNativeRuntime({cache:${JSON.stringify(cache)}, tag:"v0.8.1"});
  `,
      ],
      { stdout: "inherit", stderr: "inherit", signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    expect(await child.exited).toBe(0);
    const target = hostTarget();
    const directory = findNativeRuntime(target, cache, "v0.8.1");
    if (!directory) throw new Error("Missing validated 0.8.1 runtime");
    const library = dlopen(
      join(
        directory,
        "library",
        NATIVE_TARGETS[nativeRuntimeIdentity(target, undefined, "v0.8.1").target].library,
      ),
      {
        ot_context_create: { args: [], returns: "ptr" },
      },
    );
    library.close();
    const abi = readFileSync(join(directory, "core/native-abi.generated.ts"), "utf8");
    expect(abi).toMatch(/ot_session_renderer_state: \{\s*size: 40,/);
    const entry = join(cache, "load.ts");
    await Bun.write(
      entry,
      `
      import {createTestRenderer} from "@opentui/core/testing";
      import {BoxRenderable, TextRenderable} from "@opentui/core";
      const ui = await createTestRenderer({width:20,height:5});
      try {
        const box = new BoxRenderable(ui.renderer, {width:12,height:3,border:true});
        box.add(new TextRenderable(ui.renderer, {content:"hello"}));
        ui.renderer.root.add(box);
        await ui.renderOnce();
        if (!ui.captureCharFrame().includes("hello")) throw new Error("Missing native cells");
      } finally {ui.renderer.destroy();}
    `,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: join(cache, "bundle"),
      target: "bun",
      plugins: [nativeRuntimePlugin(directory)],
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const loaded = Bun.spawn([process.execPath, join(cache, "bundle/load.js")], {
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    expect(await loaded.exited).toBe(0);
    const reuse = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import {prepareNativeRuntime} from ${JSON.stringify(module)};
    await prepareNativeRuntime({cache:${JSON.stringify(cache)}, tag:"v0.8.1", zig:"/missing/zig"});
  `,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await reuse.exited).toBe(0);
  },
  TIMEOUT_MS,
);
