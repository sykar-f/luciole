#!/usr/bin/env bun
// The install name only forwards: core's own CLI runs in this very process, so there is one
// PID to signal and one exit code. It reads `process.argv.slice(2)` at import, which is the
// shape this bin was started with.
const core = import.meta.resolve("@luciole-sh/core/package.json");
await import(new URL("./src/cli.ts", core).href);
