/** Packed desktop apps must not depend on symlinks that Electrobun drops on extraction. */
import { expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signClient } from "../packages/core/src/sign";
import { execute } from "./helpers";

test.skipIf(process.platform !== "darwin")(
  "the desktop hook puts the binary and signed helper in real adjacent entries",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pty-desktop-layout-"));
    try {
      for (const path of [
        "scripts",
        "src",
        ".stage",
        "build/Probe.app/Contents/MacOS",
        "build/Probe.app/Contents/Resources/app/luciole/bin/native",
      ])
        await mkdir(join(directory, path), { recursive: true });
      await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
      await cp(
        resolve("packages/desktop/scripts/single-runtime.ts"),
        join(directory, "scripts/single-runtime.ts"),
      );
      await cp(resolve("packages/desktop/src/staged.ts"), join(directory, "src/staged.ts"));
      const contents = join(directory, "build/Probe.app/Contents");
      const bundled = join(contents, "Resources/app/luciole");
      const metadata = JSON.stringify({ format: 1, name: "probe", displayName: "Probe" });
      await Bun.write(join(directory, ".stage/metadata.json"), metadata);
      await Bun.write(join(bundled, "metadata.json"), metadata);
      await Bun.write(join(bundled, "bin/probe"), "the app binary");
      await Bun.write(join(contents, "MacOS/bun"), "the old runtime");
      await cp(
        resolve("packages/core/native/luciole-pty/dist/luciole-pty"),
        join(bundled, "bin/native/luciole-pty"),
      );
      await signClient(join(bundled, "bin/native/luciole-pty"), "-");
      const result = await execute(
        [process.execPath, join(directory, "scripts/single-runtime.ts")],
        {
          env: { ELECTROBUN_OS: "macos", ELECTROBUN_BUILD_DIR: join(directory, "build") },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(contents, "MacOS/probe")).text()).toBe("the app binary");
      expect((await lstat(join(contents, "MacOS/native"))).isDirectory()).toBe(true);
      expect(
        (
          await execute([
            "codesign",
            "--verify",
            "--strict",
            "--all-architectures",
            join(contents, "MacOS/native/luciole-pty"),
          ])
        ).exitCode,
      ).toBe(0);
      expect(await Bun.file(join(bundled, "bin/probe")).exists()).toBe(false);
      for (const entry of await readdir(contents, { recursive: true, withFileTypes: true }))
        expect(entry.isSymbolicLink()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
