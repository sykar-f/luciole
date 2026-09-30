// Runs the compiled Notes Client for Linux in containers that have no Bun: glibc (Debian),
// musl (Alpine) and glibc with a noexec /tmp, each against a Server on this machine.
// Needs a Docker engine (OrbStack, Docker Desktop or Linux) and, on the first run, network
// access for the images, the native packages and Bun's stock runtime.
//   bun scripts/linux-client.ts [--arch arm64|x64]
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { build } from "../packages/luciole/src/build";
import { compileClient } from "../packages/luciole/src/compile";
import { readJsonFile } from "../packages/luciole/src/package-json";
import { launch } from "../tests/helpers";

const args = process.argv.slice(2);
const archIndex = args.indexOf("--arch");
const arch = archIndex < 0 ? (process.arch === "arm64" ? "arm64" : "x64") : args[archIndex + 1];
if (arch !== "arm64" && arch !== "x64") throw new Error("--arch must be arm64 or x64");
const platform = arch === "arm64" ? "linux/arm64" : "linux/amd64";
const root = resolve("examples/notes");
// A container pulls its image and starts the Client well within this.
const STARTUP_MS = 60000;
const POLL_MS = 100;
// Enough of the last screen to see why the Client did not show the notes.
const SCREEN_TAIL = 1500;
const work = await mkdtemp(join(tmpdir(), "luciole-linux-"));

async function run(cmd: string[], options: { cwd?: string; stdin?: string } = {}) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  if ((await child.exited) !== 0) throw new Error(`Failed: ${cmd.join(" ")}\n${stdout}${stderr}`);
  return stdout;
}

// Bun's musl runtime links libstdc++ and libgcc, which Alpine does not install by default.
const muslImage = `luciole-alpine-libstdcxx:${arch}`;
const cases = [
  { name: "glibc", target: `bun-linux-${arch}`, image: "debian:bookworm-slim", flags: [] },
  { name: "musl", target: `bun-linux-${arch}-musl`, image: muslImage, flags: [] },
  {
    // Bun extracts OpenTUI's library into $TMPDIR before loading it.
    name: "glibc, noexec /tmp, TMPDIR=/run",
    target: `bun-linux-${arch}`,
    image: "debian:bookworm-slim",
    flags: ["--tmpfs", "/tmp:rw,noexec", "--tmpfs", "/run:rw,exec", "-e", "TMPDIR=/run"],
  },
] as const;

let failed = false;
const { output } = await build(root);
const server = await launch(join(root, ".luciole/server/index.js"), {
  NOTES_DB: join(work, "notes.sqlite"),
});
try {
  const native = join(work, "native");
  await mkdir(native);
  await Bun.write(join(native, "package.json"), "{}");
  const { version } = await readJsonFile(
    "node_modules/@opentui/core/package.json",
    z.object({ version: z.string() }),
  );
  await run(
    [
      process.execPath,
      "add",
      `@opentui/core-linux-${arch}@${version}`,
      `@opentui/core-linux-${arch}-musl@${version}`,
      "--os=linux",
      `--cpu=${arch}`,
    ],
    { cwd: native },
  );
  await run(["docker", "build", "-q", "--platform", platform, "-t", muslImage, "-"], {
    stdin: "FROM alpine:3.22\nRUN apk add --no-cache libstdc++\n",
  });
  // A Linux engine shares the host's loopback; OrbStack and Docker Desktop forward it.
  const [network, host] =
    process.platform === "linux"
      ? [["--network", "host"], "127.0.0.1"]
      : [[], "host.docker.internal"];
  for (const [i, variant] of cases.entries()) {
    const outfile = join(work, "bin", variant.target);
    if (!(await Bun.file(outfile).exists()))
      await compileClient(output, {
        name: "notes",
        target: variant.target,
        nativeDir: native,
        outfile,
      });
    const name = `luciole-linux-${process.pid}-${i}`;
    const started = performance.now();
    const container = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-t",
        "--name",
        name,
        "--platform",
        platform,
        ...network,
        ...variant.flags,
        "-v",
        `${outfile}:/opt/client:ro`,
        "-e",
        "TERM=xterm-256color",
        variant.image,
        "sh",
        "-c",
        "stty cols 100 rows 30; if command -v bun; then exit 3; fi; " +
          `exec /opt/client --url http://${host}:${server.port}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let screen = "";
    const reader = (async () => {
      for await (const chunk of container.stdout)
        screen += Bun.stripANSI(new TextDecoder().decode(chunk));
    })();
    const deadline = performance.now() + STARTUP_MS;
    while (
      performance.now() < deadline &&
      container.exitCode === null &&
      !screen.includes("First note")
    )
      await Bun.sleep(POLL_MS);
    // The list only exists once the Server answered.
    const ok = screen.includes("YOUR NOTES") && screen.includes("First note");
    await run(["docker", "kill", name]).catch(() => {});
    await container.exited;
    await reader;
    console.log(
      JSON.stringify({
        case: variant.name,
        target: variant.target,
        image: variant.image,
        ok,
        ms: Math.round(performance.now() - started),
      }),
    );
    if (!ok) {
      failed = true;
      console.error(
        screen.replace(/\s+/g, " ").slice(-SCREEN_TAIL),
        await new Response(container.stderr).text(),
      );
    }
  }
} finally {
  await server.stop();
  await rm(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
