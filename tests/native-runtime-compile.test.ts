import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/mini";
import { compileClient } from "../packages/core/src/compile";
import { nativeRuntimeDirectory } from "../packages/core/src/native-runtime";
import { hostTarget } from "../packages/core/src/targets";
import { ctrl, drive } from "../scripts/pty/driver";
import { execute, temporaryApp, until } from "./helpers";

test("missing and corrupt entries compile stock OpenTUI with one actionable notice", async () => {
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "native-fallback-"));
  const notice = spyOn(console, "warn");
  try {
    await Bun.write(
      join(root, "client/index.js"),
      `
      import {CliRenderer} from "@opentui/core";
      console.log(JSON.stringify({observer: typeof CliRenderer.prototype.observeMouseInput,
        writer: typeof CliRenderer.prototype.writeControl}));
    `,
    );
    // Resolve the stock package from the application, while the cache is independent.
    const entry = await Bun.file(join(root, "client/index.js")).text();
    await Bun.write(
      join(root, "client/index.js"),
      entry.replace(
        '"@opentui/core"',
        JSON.stringify(Bun.resolveSync("@opentui/core", import.meta.dir)),
      ),
    );
    for (const corrupt of [false, true]) {
      if (corrupt)
        await Bun.write(
          join(nativeRuntimeDirectory(hostTarget(), root), "native-runtime.json"),
          "{broken",
        );
      notice.mockClear();
      const { outfile } = await compileClient(root, {
        name: "probe",
        runtime: "host",
        cache: root,
        outfile: join(root, "probe"),
      });
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0]?.[0]).toContain(
        `luciole native-runtime --target ${hostTarget()}`,
      );
      expect(notice.mock.calls[0]?.[0]).toContain("row scroll");
      const run = await execute([outfile], { cwd: root, env: { PATH: "/usr/bin:/bin" } });
      console.log(
        JSON.stringify({
          cache: corrupt ? "corrupt" : "empty",
          notice: z.string().parse(notice.mock.calls[0]?.[0]),
          stdout: run.stdout.toString(),
          stderr: run.stderr.toString(),
        }),
      );
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual({
        observer: "undefined",
        writer: "undefined",
      });
    }
  } finally {
    notice.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(!process.env["LUCIOLE_OPENTUI_INTEGRATION"])(
  "compiled Notes on a standalone PTY reports the prepared pixel seams and stock fallback",
  async () => {
    const root = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "native-notes-"));
    const app = await temporaryApp("native-notes");
    try {
      await cp(resolve("examples/notes"), app, {
        recursive: true,
        filter: (path) => !path.includes("/node_modules") && !path.includes("/.luciole"),
      });
      // Observe the app's actual renderer, including the React importer, without
      // adding a diagnostic API to the shipped framework or example.
      const layout = join(app, "app/layout.tsx");
      await Bun.write(
        layout,
        (await Bun.file(layout).text())
          .replace(
            "import { useTerminalDimensions }",
            "import { useRenderer, useTerminalDimensions }",
          )
          .replace("import { useState,", "import { useEffect, useState,")
          .replace("<PaletteProvider>", "<PaletteProvider><NativeProbe />") +
          `
function NativeProbe() {
  const renderer = useRenderer();
  useEffect(() => {
    const timer = setTimeout(() => {
      const found = detectOpenTuiSeams(renderer);
      const map = found.available ? found.renderer.captureHitMap() : undefined;
      writeFileSync(process.env["NATIVE_REPORT"]!, JSON.stringify({
        available: found.available,
        observer: typeof Reflect.get(renderer, "observeMouseInput"),
        writer: typeof Reflect.get(renderer, "writeControl"),
        width: map?.width, height: map?.height,
        compiled: import.meta.url.includes("$bunfs"),
      }));
    }, 500);
    return () => clearTimeout(timer);
  }, [renderer]);
  return null;
}
import {writeFileSync} from "node:fs";
import {detectOpenTuiSeams} from ${JSON.stringify(resolve("packages/core/src/opentui-seams.ts"))};
`,
      );
      const preparation = await execute(
        [process.execPath, resolve("packages/core/src/cli.ts"), "native-runtime"],
        { env: { ...process.env, XDG_CACHE_HOME: join(root, "prepared") } },
      );
      console.log(
        JSON.stringify({
          preparationExit: preparation.exitCode,
          stdout: preparation.stdout.toString(),
          stderr: preparation.stderr.toString(),
        }),
      );
      expect(preparation.exitCode).toBe(0);
      for (const prepared of [true, false]) {
        const xdg = join(root, prepared ? "prepared" : "empty");
        const binary = join(root, prepared ? "pixel/notes" : "stock/notes");
        const compiled = await execute(
          [
            process.execPath,
            resolve("packages/core/src/cli.ts"),
            "build",
            "--app",
            app,
            "--compile",
            "--runtime",
            "host",
            "--outfile",
            binary,
          ],
          { env: { ...process.env, XDG_CACHE_HOME: xdg, ZIG: "/nonexistent/zig" } },
        );
        console.log(
          JSON.stringify({
            prepared,
            compileExit: compiled.exitCode,
            stdout: compiled.stdout.toString(),
            stderr: compiled.stderr.toString(),
          }),
        );
        expect(compiled.exitCode).toBe(0);
        expect(compiled.stderr.toString().includes("luciole native-runtime --target")).toBe(
          !prepared,
        );
        const report = join(root, prepared ? "pixel.json" : "stock.json");
        const cwd = join(root, prepared ? "run-pixel" : "run-stock");
        await Bun.write(join(cwd, ".keep"), "");
        await using window = await drive({
          command: [binary],
          cols: 100,
          rows: 30,
          cwd,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: cwd,
            NATIVE_REPORT: report,
            NOTES_DB: join(cwd, "notes.sqlite"),
            XDG_STATE_HOME: join(cwd, "state"),
            XDG_CACHE_HOME: join(cwd, "cache"),
          },
        });
        await window.waitFor("Welcome to Notes");
        await until(() => existsSync(report));
        const evidence = z
          .object({
            available: z.boolean(),
            observer: z.string(),
            writer: z.string(),
            width: z.optional(z.number()),
            height: z.optional(z.number()),
            compiled: z.boolean(),
          })
          .parse(await Bun.file(report).json());
        console.log(JSON.stringify({ prepared, evidence }));
        expect(evidence.available).toBe(prepared);
        expect(evidence.observer).toBe(prepared ? "function" : "undefined");
        expect(evidence.writer).toBe(prepared ? "function" : "undefined");
        expect(evidence.compiled).toBe(true);
        if (prepared) {
          expect(evidence.width).toBe(100);
          expect(evidence.height).toBe(30);
        }
        window.write(ctrl("c"));
        expect(await window.exited()).toBe(0);
      }
    } finally {
      await rm(app, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  600000,
);
