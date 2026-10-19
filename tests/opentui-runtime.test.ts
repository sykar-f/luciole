import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOpenTuiLibrary, publishRuntimeEntry } from "../packages/core/src/opentui-runtime";

test("optional reuse validation rebuilds rejected entries under the publication lock", async () => {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "runtime-validation-"));
  const directory = join(root, "runtime");
  let builds = 0;
  const options = {
    directory,
    checkout: join(root, "checkout"),
    marker: "manifest",
    complete: () => true,
    async build(temporary: string) {
      builds++;
      writeFileSync(join(temporary, "manifest"), "valid");
    },
  };
  try {
    await publishRuntimeEntry(options);
    writeFileSync(join(directory, "manifest"), "invalid");
    // Existing callers keep marker-only reuse.
    await publishRuntimeEntry(options);
    expect(builds).toBe(1);
    expect(readFileSync(join(directory, "manifest"), "utf8")).toBe("invalid");
    const validated = {
      ...options,
      validateReuse: (path: string) => readFileSync(join(path, "manifest"), "utf8") === "valid",
    };
    await publishRuntimeEntry(validated);
    expect(builds).toBe(2);
    await publishRuntimeEntry(validated);
    expect(builds).toBe(2);
    expect(readFileSync(join(directory, "manifest"), "utf8")).toBe("valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime publication uses the product marker and completeness check", async () => {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "runtime-entry-"));
  const directory = join(root, "runtime");
  const marker = "native-runtime.json";
  const tree = "a".repeat(40);
  let checked = false;
  const options = {
    directory,
    checkout: join(root, "checkout"),
    marker,
    sourceTree: () => tree,
    complete: (path: string) => {
      checked = true;
      return existsSync(join(path, "library"));
    },
    async build() {
      // Simulate a complete entry published by an older unlocked preparer.
      mkdirSync(directory);
      writeFileSync(join(directory, marker), "{}");
      writeFileSync(join(directory, "library"), "native");
      writeFileSync(join(directory, "opentui-source-tree"), tree);
    },
  };
  try {
    expect(await publishRuntimeEntry(options)).toBe(directory);
    expect(checked).toBe(true);
    expect(existsSync(join(directory, "web-runtime.json"))).toBe(false);
    expect(
      await publishRuntimeEntry({
        ...options,
        async build() {
          throw new Error("cached");
        },
      }),
    ).toBe(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("library builds accept target options and an inherited toolchain environment", () => {
  const checkout = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "runtime-library-"));
  const artifact = join(checkout, "library.dylib");
  const spawn = Bun.spawnSync;
  const calls: { command: string[]; env: unknown }[] = [];
  const buildCommands: typeof spawn = (command, options?) => {
    if (options !== undefined && (typeof options !== "object" || options === null))
      throw new Error("Expected spawn options");
    if (!Array.isArray(command)) throw new Error("Expected command array");
    calls.push({ command, env: options && "env" in options ? options.env : undefined });
    if (command[1] === "build") writeFileSync(artifact, "native");
    return spawn([process.execPath, "--eval", "console.log('0.16.0')"]);
  };
  const commands = spyOn(Bun, "spawnSync").mockImplementation(buildCommands);
  try {
    const options = {
      checkout,
      artifact,
      zig: "fake-zig",
      tree: "native-source",
      runtime: "native runtime",
      options: ["-Dlibrary-target=aarch64-macos", "-Doptimize=ReleaseFast"],
      env: { DEVELOPER_DIR: "/toolchain" },
    };
    expect(buildOpenTuiLibrary(options)).toBe(artifact);
    expect(calls.at(-1)?.command).toEqual(["fake-zig", "build", ...options.options]);
    expect(calls.at(-1)?.env).toMatchObject({
      DEVELOPER_DIR: "/toolchain",
      PATH: process.env["PATH"],
    });
    expect(readFileSync(`${artifact}.source-tree`, "utf8")).toBe("native-source\n");
    expect(buildOpenTuiLibrary(options)).toBe(artifact);
    expect(calls.length).toBe(4);
  } finally {
    commands.mockRestore();
    rmSync(checkout, { recursive: true, force: true });
  }
});
