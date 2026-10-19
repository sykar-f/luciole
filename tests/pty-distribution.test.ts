/** Compiled programs use the helper beside the executable, including paths with spaces. */
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileClient } from "../packages/core/src/compile";
import { execute } from "./helpers";

test.skipIf(process.platform !== "darwin")(
  "a relocated compiled program finds its signed PTY helper in a path with spaces",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pty-compiled-"));
    try {
      const output = join(directory, "output");
      await mkdir(join(output, "client"), { recursive: true });
      const child = `process.on('SIGWINCH',()=>setTimeout(()=>{console.log('SIGWINCH '+process.stdout.columns+'x'+process.stdout.rows);process.exit(0)},0));console.log('READY');setInterval(()=>{},1000)`;
      await Bun.write(
        join(output, "client/index.js"),
        `
import {spawnPty} from ${JSON.stringify(resolve("packages/core/src/vt/pty.ts"))};
let output = '', resized = false;
const pty = spawnPty({command:[process.execPath,'-e',${JSON.stringify(child)}],env:{BUN_BE_BUN:'1'},cols:80,rows:24,
  onData(bytes) {const text = new TextDecoder().decode(bytes);process.stdout.write(text);output += text;if(!resized && output.includes('READY')) {resized=true;pty.resize(120,40)}},
  onExit(code) {process.exit(code ?? 1)}
});
setTimeout(()=>{pty.kill();process.exit(2)},5000);
`,
      );
      await compileClient(output, {
        name: "probe",
        outfile: join(directory, "build/probe"),
        runtime: "host",
        sign: "-",
      });
      const relocated = join(directory, "path with spaces");
      await cp(join(directory, "build"), relocated, { recursive: true });
      const helper = join(relocated, "native/luciole-pty");
      expect((await execute(["codesign", "--verify", "--strict", helper])).exitCode).toBe(0);
      const options = { cwd: relocated, env: { PATH: "/usr/bin:/bin", HOME: directory } };
      const childRun = await execute([join(relocated, "probe")], options);
      expect(childRun.exitCode).toBe(0);
      expect(childRun.stdout.toString()).toContain("SIGWINCH 120x40");
      await rm(helper);
      const missing = await execute([join(relocated, "probe")], options);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr.toString()).toContain(`The macOS PTY launcher is missing: ${helper}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
