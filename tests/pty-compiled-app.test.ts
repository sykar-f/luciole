/** Exercise the public compiler and a real Terminal pane after moving the whole app. */
import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ctrl, drive } from "../scripts/pty/driver";
import { execute, temporaryApp } from "./helpers";

test.skipIf(process.platform !== "darwin")(
  "luciole build --compile ships a working PTY helper with a relocated app",
  async () => {
    const app = await temporaryApp("pty-compiled-mux");
    const directory = await mkdtemp(join(tmpdir(), "pty-app-"));
    try {
      // Build a private copy so other test files can build examples/mux independently.
      await cp(resolve("examples/mux"), app, {
        recursive: true,
        filter: (path) => !path.includes("/node_modules") && !path.includes("/.luciole"),
      });
      const compiled = await execute([
        process.execPath,
        "packages/core/src/cli.ts",
        "build",
        "--app",
        app,
        "--compile",
        "--runtime",
        "host",
        "--outfile",
        join(directory, "build/mux"),
      ]);
      expect(compiled.exitCode).toBe(0);
      const moved = join(directory, "app with spaces");
      await cp(join(directory, "build"), moved, { recursive: true });
      const probe = join(directory, "child.ts");
      await Bun.write(
        probe,
        `
import {dlopen} from 'bun:ffi';
const {symbols} = dlopen('libc.dylib',{tcgetpgrp:{args:['i32'],returns:'i32'}});
process.on('SIGWINCH',()=>console.log('RESIZED'));
console.log('GROUP '+process.pid+' '+symbols.tcgetpgrp(0));
setInterval(()=>{},1000);
`,
      );
      await using window = await drive({
        command: [join(moved, "mux")],
        cols: 100,
        rows: 28,
        env: {
          MUX_PANES: JSON.stringify([[process.execPath, probe]]),
          MUX_APPS: "[]",
          XDG_STATE_HOME: join(directory, "state"),
          XDG_CACHE_HOME: join(directory, "cache"),
        },
      });
      await window.waitFor(/GROUP (\d+) \1/);
      window.resize(120, 40);
      await window.waitFor("RESIZED");
      window.write(ctrl("o") + "q");
      expect(await window.exited()).toBe(0);
    } finally {
      await rm(app, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
