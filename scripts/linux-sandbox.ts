// Runs the sandbox mode's tests on Linux, in containers, once per mechanism
// (src/sandbox/mechanism.ts): airtty-sandbox with its own namespaces, under bubblewrap,
// and Landlock alone. Each runs tests/sandbox.test.ts and scripts/pty-sandbox.py as a
// user (not root), on a copy of this checkout with its own Linux node_modules; then
// `cargo test` for the launcher itself.
//   bun scripts/linux-sandbox.ts [--arch arm64|x64] [--only userns|bwrap|landlock]
// Needs a Docker engine (OrbStack, Docker Desktop or Linux) and the prebuilt launcher
// (bun scripts/build-sandbox.ts). Namespaces need the container's seccomp profile off
// (Docker's default one refuses unshare(CLONE_NEWUSER)); Landlock alone runs with the
// defaults, which is also what a system refusing user namespaces looks like.
// x64 on an arm64 machine runs emulated, where Landlock may be missing (Rosetta has
// none): then only what the emulator allows runs, and the script says which.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const arch = option("--arch") ?? (process.arch === "arm64" ? "arm64" : "x64");
if (arch !== "arm64" && arch !== "x64") throw new Error("--arch must be arm64 or x64");
const platform = arch === "arm64" ? "linux/arm64" : "linux/amd64";
const only = option("--only");
const IMAGE = `airtty-linux-sandbox:${arch}`;
// Bun's image (Debian), bubblewrap, pyte for the PTY journey, ps for its process checks.
const DOCKERFILE = `FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 python3-pyte procps \\
 && rm -rf /var/lib/apt/lists/* && useradd -m ada
`;
// Docker masks parts of /proc, which forbids mounting a fresh one (bubblewrap's --proc)
// inside the container; a real host has no such mask.
const UNCONFINED = [
  "--security-opt",
  "seccomp=unconfined",
  "--security-opt",
  "apparmor=unconfined",
  "--security-opt",
  "systempaths=unconfined",
];
const CASES = [
  { mechanism: "userns", flags: UNCONFINED },
  { mechanism: "bwrap", flags: UNCONFINED },
  { mechanism: "landlock", flags: [] },
] as const;

const SKIPPED = 3;
const launcher = resolve(`packages/airtty/native/airtty-sandbox/dist/linux-${arch}/airtty-sandbox`);
if (!existsSync(launcher)) throw new Error(`${launcher} is missing: bun scripts/build-sandbox.ts`);

async function run(cmd: string[], stdin?: string) {
  const child = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

const work = await mkdtemp(join(tmpdir(), "airtty-linux-sandbox-"));
let failed = false;
let ran = 0;
try {
  if ((await run(["docker", "build", "--platform", platform, "-t", IMAGE, "-"], DOCKERFILE)) !== 0)
    throw new Error("The test image did not build");
  // What git tracks or would track, without this machine's node_modules and builds.
  const files = (
    await new Response(
      Bun.spawn(["git", "ls-files", "-co", "--exclude-standard"], { stdout: "pipe" }).stdout,
    ).text()
  )
    .split("\n")
    .filter(Boolean);
  const copy = join(work, "airtty");
  for (const file of files)
    if (existsSync(file)) await cp(file, join(copy, file), { recursive: true });
  // The script inside: its own install, a ~/.ssh to protect, then the tests.
  const inside = [
    "set -e",
    "cp -r /src /home/ada/airtty && cd /home/ada/airtty",
    "bun install --frozen-lockfile >/dev/null",
    "mkdir -p ~/.ssh && echo 'Host secret' > ~/.ssh/config",
    // A mechanism this kernel does not allow (Landlock ABI < 6 for Landlock alone, say) is
    // skipped, and said so; the run fails if none ran at all.
    `bun -e "import {sandboxAvailability as a} from './packages/airtty/src/sandbox/runtime';const r=a();if(!r.mechanism){console.log('skipped: '+r.reason);process.exit(${SKIPPED})}"`,
    `echo "mechanism: $AIRTTY_SANDBOX_MECHANISM, probe: $(${join("/src", "packages/airtty/native/airtty-sandbox/dist", `linux-${arch}`, "airtty-sandbox")} --probe)"`,
    "bun test --timeout 60000 tests/sandbox.test.ts",
    "python3 scripts/pty-sandbox.py",
  ].join("\n");
  for (const { mechanism, flags } of CASES) {
    if (only && only !== mechanism) continue;
    console.log(`\n=== ${mechanism} (${arch})`);
    const code = await run([
      "docker",
      "run",
      "--rm",
      "--platform",
      platform,
      ...flags,
      "-v",
      `${copy}:/src:ro`,
      "-e",
      `AIRTTY_SANDBOX_MECHANISM=${mechanism}`,
      "-u",
      "ada",
      "-w",
      "/home/ada",
      IMAGE,
      "bash",
      "-c",
      inside,
    ]);
    if (code === SKIPPED) console.log(`=== ${mechanism}: skipped (not available with this kernel)`);
    else if (code !== 0) {
      failed = true;
      console.error(`=== ${mechanism}: FAILED (${code})`);
    } else {
      ran++;
      console.log(`=== ${mechanism}: passed`);
    }
  }
  if (!only) {
    console.log(`\n=== cargo test (${arch})`);
    const crate = resolve("packages/airtty/native/airtty-sandbox");
    const code = await run([
      "docker",
      "run",
      "--rm",
      "--platform",
      platform,
      "-v",
      `${crate}:/src:ro`,
      "-e",
      "CARGO_TARGET_DIR=/tmp/target",
      "-w",
      "/src",
      arch === "arm64"
        ? "rust@sha256:7027e56e68dfd2c7bc66383bda559e1e1efb72301f55e4252925f6fa637d979d"
        : "rust@sha256:2805e96db5234c9cfaf7ecb50f488693dab84d28ad30b6290cc1b707a18bf775",
      "cargo",
      "test",
      "--locked",
    ]);
    if (code !== 0) failed = true;
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (!ran) console.error("No mechanism ran: nothing of the Linux sandbox was tested");
if (failed || !ran) process.exit(1);
console.log(`\nLinux sandbox (${arch}): all passed, launcher ${dirname(launcher)}`);
