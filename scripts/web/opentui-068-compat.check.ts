/** Explicit migration proof: rebuild 0.6.8 with both producers at identical paths. */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "ed46b2870ecc60d4c0f046e3ac5900fef277a17d";
const TIMEOUT_MS = 900_000;
test(
  "0.6.8 source/native keys and rebuilt WASM/native bytes match the mission base",
  async () => {
    const scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "opentui-068-compat-"));
    const baseline = join(scratch, "baseline");
    const checkout = Bun.spawn(["git", "worktree", "add", "--detach", baseline, BASE], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(await checkout.exited).toBe(0);
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import {createHash} from "node:crypto";
    import {readFileSync, rmSync, symlinkSync} from "node:fs";
    import {join} from "node:path";
    import {pathToFileURL} from "node:url";
    import {expect} from "bun:test";
    const root = ${JSON.stringify(join(import.meta.dir, "../.."))};
    const baseline = ${JSON.stringify(baseline)};
    const scratch = ${JSON.stringify(scratch)};
    symlinkSync(join(root,"node_modules"), join(baseline,"node_modules"));
    const load = (root,name) => import(pathToFileURL(join(root,"packages/core/src",name+".ts")).href);
    const oldWeb = await load(baseline,"web-runtime");
    const newWeb = await load(root,"web-runtime");
    const oldNative = await load(baseline,"native-runtime");
    const newNative = await load(root,"native-runtime");
    const {hostTarget, COMPILE_TARGETS} = await load(root,"targets");
    const zig = process.env.ZIG ?? "zig";
    const cache = join(scratch,"cache");
    expect(oldWeb.openTuiCheckoutDirectory(cache)).toBe(newWeb.openTuiCheckoutDirectory(cache));
    const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
    const webCheckout = oldWeb.openTuiCheckoutDirectory(cache);
    const wasm = oldWeb.prepareOpenTui(webCheckout,zig);
    const oldWasm = hash(wasm);
    rmSync(wasm); rmSync(wasm+".source-tree");
    newWeb.prepareOpenTui(webCheckout,zig);
    expect(hash(wasm)).toBe(oldWasm);
    for (const target of COMPILE_TARGETS) {
      expect(oldNative.nativeRuntimeDirectory(target,cache)).toBe(newNative.nativeRuntimeDirectory(target,cache));
    }
    const target = hostTarget();
    expect(oldNative.nativeRuntimeIdentity(target)).toEqual(newNative.nativeRuntimeIdentity(target));
    const directory = await oldNative.prepareNativeRuntime({cache,zig});
    expect(directory).toBe(newNative.nativeRuntimeDirectory(target,cache));
    const libraryName = oldNative.NATIVE_TARGETS[target].library;
    const oldLibrary = hash(join(directory,"library",libraryName));
    rmSync(directory,{recursive:true});
    const source = [...new Bun.Glob("opentui-*").scanSync({cwd:join(cache,"native"),onlyFiles:false})]
      .find(name=>!name.endsWith(".lock"));
    if (!source) throw new Error("Missing native checkout");
    const artifact = join(cache,"native",source,"packages/native/lib",oldNative.NATIVE_TARGETS[target].output,libraryName);
    rmSync(artifact); rmSync(artifact+".source-tree");
    await newNative.prepareNativeRuntime({cache,zig});
    expect(hash(join(directory,"library",libraryName))).toBe(oldLibrary);
    console.log(JSON.stringify({wasm:oldWasm,native:oldLibrary,keysUnchanged:true}));
  `,
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    expect(await child.exited).toBe(0);
  },
  TIMEOUT_MS,
);
