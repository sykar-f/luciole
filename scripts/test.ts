import { availableParallelism } from "node:os";

// Keep the existing four-worker cap, but do not start more workers than CPUs.
// GitHub's arm64 macOS runner has three CPUs; Ubuntu and local runs keep four.
const MAX_WORKERS = 4;
const workers = Math.min(MAX_WORKERS, availableParallelism());
const suite = Bun.spawn(
  [
    process.execPath,
    "test",
    "--timeout",
    "20000",
    `--parallel=${workers}`,
    ...process.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exit(await suite.exited);
