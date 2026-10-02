#!/usr/bin/env bun
// The install name only forwards: every argument goes to @luciole-sh/core's own CLI, with
// its stdio, and its exit code comes back.
import { fileURLToPath } from "node:url";
const core = import.meta.resolve("@luciole-sh/core/package.json");
const cli = fileURLToPath(new URL("./src/cli.ts", core));
const child = Bun.spawn([process.execPath, cli, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
