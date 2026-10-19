import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as z from "zod/mini";
import {
  NATIVE_TARGETS,
  findNativeRuntime,
  nativeRuntimeDirectory,
  nativeRuntimeIdentity,
  prepareNativeRuntime,
  prepareNativeRuntimeEntry,
} from "../packages/core/src/native-runtime";
import { COMPILE_TARGETS, hostTarget } from "../packages/core/src/targets";

const roots: string[] = [];
function scratch() {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "native-runtime-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tree = "a".repeat(40);
const files = {
  "core/package.json": '{"type":"module"}',
  "core/index.bun.js": 'export const renderer = "patched";',
  "core/parser.worker.js": "// parser worker",
  "core/native-abi.generated.ts": "export const symbols = {};",
  "library/index.bun.js": 'export default "native";',
};
function stage(directory: string, target = hostTarget()) {
  for (const [file, contents] of Object.entries({
    ...files,
    [`library/${NATIVE_TARGETS[nativeRuntimeIdentity(target).target].library}`]: "native bytes",
  })) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }
}
const prepare = (cache: string, target = hostTarget()) =>
  prepareNativeRuntimeEntry({
    cache,
    target,
    sourceTree: () => tree,
    async build(directory) {
      stage(directory, target);
    },
  });

test("all six target entries require a complete, matching manifest and digests", async () => {
  const cache = scratch();
  for (const target of COMPILE_TARGETS) {
    const directory = await prepare(cache, target);
    expect(findNativeRuntime(target, cache)).toBe(directory);
    const library = join(directory, "library", NATIVE_TARGETS[target].library);
    rmSync(library);
    expect(findNativeRuntime(target, cache)).toBeUndefined();
    writeFileSync(library, "modified native bytes");
    expect(findNativeRuntime(target, cache)).toBeUndefined();
    await prepare(cache, target);
    expect(findNativeRuntime(target, cache)).toBe(directory);
    const manifestPath = join(directory, "native-runtime.json");
    const manifest = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    manifest["files"] = {};
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(findNativeRuntime(target, cache)).toBeUndefined();
  }
});

test("provenance, required assets and relative digest paths are validated", async () => {
  const cache = scratch();
  const directory = await prepare(cache);
  const manifestPath = join(directory, "native-runtime.json");
  const original = readFileSync(manifestPath, "utf8");
  for (const change of [
    { layout: 0 },
    { tag: "v0.0.0" },
    { patches: [] },
    { zigVersion: "0.0.0" },
    { target: "bun-windows-x64" },
    { libc: "other" },
    { tree: "b".repeat(40) },
    { files: { "../outside": "0".repeat(64) } },
  ]) {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...z.record(z.string(), z.unknown()).parse(JSON.parse(original)),
        ...change,
      }),
    );
    expect(findNativeRuntime(hostTarget(), cache)).toBeUndefined();
  }
  writeFileSync(manifestPath, original);
  rmSync(join(directory, "core/parser.worker.js"));
  expect(findNativeRuntime(hostTarget(), cache)).toBeUndefined();
  await prepare(cache);
  writeFileSync(join(directory, "unrecorded.js"), "changed distribution");
  expect(findNativeRuntime(hostTarget(), cache)).toBeUndefined();
});

test("a complete entry is reused without Zig or its checkout by the API and CLI", async () => {
  const cache = scratch();
  const directory = await prepare(cache);
  expect(await prepareNativeRuntime({ cache, zig: "/nonexistent/zig" })).toBe(directory);
  const cliCache = join(cache, "xdg/luciole");
  cpSync(directory, nativeRuntimeDirectory(hostTarget(), cliCache), { recursive: true });
  const child = Bun.spawn(
    [process.execPath, resolve("packages/core/src/cli.ts"), "native-runtime"],
    {
      env: { ...process.env, XDG_CACHE_HOME: join(cache, "xdg"), ZIG: "/nonexistent/zig" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain(
    nativeRuntimeDirectory(hostTarget(), cliCache),
  );
  expect(await new Response(child.stderr).text()).toBe("");
});

test("native preparation rejects unsupported targets before any build", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/core/src/cli.ts"),
      "native-runtime",
      "--target",
      "bun-windows-x64",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("Unsupported native target");
});

test("cache identity tracks ordered patch bytes, target and upstream toolchain", () => {
  const a = Buffer.from("patch A"),
    b = Buffer.from("patch B");
  expect(nativeRuntimeIdentity(hostTarget(), [a])).not.toEqual(
    nativeRuntimeIdentity(hostTarget(), [b]),
  );
  expect(nativeRuntimeIdentity(hostTarget(), [a, b])).not.toEqual(
    nativeRuntimeIdentity(hostTarget(), [b, a]),
  );
  expect(new Set(COMPILE_TARGETS.map((target) => nativeRuntimeDirectory(target))).size).toBe(6);
  expect(nativeRuntimeIdentity(hostTarget())).toMatchObject({
    layout: 1,
    tag: "v0.6.6",
    zigVersion: "0.16.0",
  });
});

test("a framework source change keeps the native entry key", async () => {
  const root = scratch();
  const source = resolve("packages/core/src/native-runtime.ts");
  // Bundle a private installation and retain source bytes that frameworkHash would read.
  const entry = join(root, "entry.ts");
  writeFileSync(entry, `export {nativeRuntimeDirectory} from ${JSON.stringify(source)};`);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(root, "src"),
    target: "bun",
    external: ["bun:sqlite"],
  });
  expect(result.success).toBe(true);
  const bundle = join(root, "src/entry.js");
  const frameworkSource = join(root, "src/framework-source.ts");
  writeFileSync(frameworkSource, "export const framework = 1;\n");
  const key = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {nativeRuntimeDirectory} from ${JSON.stringify(bundle)}; console.log(await nativeRuntimeDirectory("bun-darwin-arm64", "/cache"))`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return output;
  };
  // import.meta.dir in the private bundle locates its own patch, as a published install does.
  mkdirSync(join(root, "web"));
  cpSync(
    resolve("packages/core/web/opentui-v0.6.6-pixel-scroll.patch"),
    join(root, "web/opentui-v0.6.6-pixel-scroll.patch"),
  );
  const before = await key();
  writeFileSync(frameworkSource, "export const framework = 2;\n");
  expect(await key()).toBe(before);
  writeFileSync(join(root, "web/opentui-v0.6.6-pixel-scroll.patch"), "changed patch");
  expect(await key()).not.toBe(before);
});

test("concurrent processes publish once and reuse the entry after waiting", async () => {
  const cache = scratch();
  const started = join(cache, "started"),
    waiting = join(cache, "waiting");
  const module = resolve("packages/core/src/native-runtime.ts");
  const code = `
    import {prepareNativeRuntimeEntry, NATIVE_TARGETS} from ${JSON.stringify(module)};
    import {mkdirSync, writeFileSync, existsSync, appendFileSync} from "node:fs";
    import {join} from "node:path";
    await prepareNativeRuntimeEntry({ cache: ${JSON.stringify(cache)}, target: "bun-darwin-arm64", sourceTree: () => ${JSON.stringify(tree)},
      waiting: () => writeFileSync(${JSON.stringify(waiting)}, "waiting"),
      async build(directory) {
        appendFileSync(${JSON.stringify(started)}, "build\\n");
        const deadline = Date.now() + 5000;
        while (!existsSync(${JSON.stringify(waiting)})) { if (Date.now() > deadline) throw new Error("waiter never arrived"); await Bun.sleep(10); }
        for (const [file, contents] of Object.entries(${JSON.stringify({ ...files, "library/libopentui.dylib": "native" })})) {
          mkdirSync(join(directory, file, ".."), {recursive:true}); writeFileSync(join(directory, file), contents);
        }
      }
    });`;
  const first = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 5000;
  while (!existsSync(started)) {
    if (Date.now() > deadline) throw new Error("builder never started");
    await Bun.sleep(10);
  }
  const second = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  expect(readFileSync(started, "utf8")).toBe("build\n");
  expect(findNativeRuntime("bun-darwin-arm64", cache)).toBeDefined();
}, 15000);
