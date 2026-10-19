import { expect, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findNativeRuntime, NATIVE_TARGETS } from "../packages/core/src/native-runtime";
import { COMPILE_TARGETS, hostTarget } from "../packages/core/src/targets";

test.skipIf(!process.env["LUCIOLE_OPENTUI_INTEGRATION"])(
  "native host CLI builds matching JS/library/ABI and reuses without Zig or sources",
  async () => {
    const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "native-host-"));
    const cache = join(root, "luciole");
    const cli = resolve("packages/core/src/cli.ts");
    async function command(reuse = false) {
      const child = Bun.spawn([process.execPath, cli, "native-runtime"], {
        env: {
          ...process.env,
          XDG_CACHE_HOME: root,
          ...(reuse ? { ZIG: "/nonexistent/zig", PATH: "/usr/bin:/bin" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      console.log(
        JSON.stringify({
          command: "luciole native-runtime",
          reuse,
          zig: reuse ? "/nonexistent/zig" : (process.env["ZIG"] ?? "zig"),
          exit,
          stdout,
          stderr,
        }),
      );
      expect(exit).toBe(0);
      return stdout.trim();
    }
    try {
      const directory = await command();
      expect(findNativeRuntime(hostTarget(), cache)).toBe(directory);
      const target = COMPILE_TARGETS.find((candidate) => candidate === hostTarget())!;
      const imported = await import(pathToFileURL(join(directory, "library/index.bun.js")).href);
      expect(existsSync(imported.default)).toBe(true);
      const library = dlopen(join(directory, "library", NATIVE_TARGETS[target].library), {
        ot_scene_copy_hits: { args: [], returns: "void" },
        ot_session_set_frame_sync: { args: [], returns: "void" },
      });
      library.close();
      const abi = readFileSync(join(directory, "core/native-abi.generated.ts"), "utf8");
      expect(abi).toContain("ot_scene_copy_hits");
      expect(abi).toContain("ot_session_set_frame_sync");
      const js = [...new Bun.Glob("*.js").scanSync({ cwd: join(directory, "core") })]
        .map((file) => readFileSync(join(directory, "core", file), "utf8"))
        .join("\n");
      expect(js).toContain("observeMouseInput");
      expect(js).toContain("writeControl");
      for (const name of readdirSync(join(cache, "native"))) {
        if (name.startsWith("opentui-") && !name.endsWith(".lock"))
          rmSync(join(cache, "native", name), { recursive: true, force: true });
      }
      expect(await command(true)).toBe(directory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  600000,
);
