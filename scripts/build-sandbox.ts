// Builds airtty-sandbox (native/airtty-sandbox), the Linux launcher of the sandbox mode,
// for each Linux architecture: a static musl binary, one per architecture, which runs on
// glibc and musl systems alike. Reproducible: a pinned toolchain image (by digest), the
// locked dependencies, no path of this machine in the binary; `--check` rebuilds and
// compares with the committed SHA256SUMS instead of replacing them.
//   bun scripts/build-sandbox.ts [--arch x64|arm64] [--check]
// Needs a Docker engine (OrbStack, Docker Desktop or Linux); the other architecture runs
// emulated. The binaries are committed: users of airtty install nothing.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// rust:1.95.0-alpine3.22 (index sha256:064dfc92…), one manifest per platform, by digest
// alone: some engines refuse the tag@digest form, or an index digest with --platform.
const ARCHS = {
  x64: {
    platform: "linux/amd64",
    image: "rust@sha256:2805e96db5234c9cfaf7ecb50f488693dab84d28ad30b6290cc1b707a18bf775",
  },
  arm64: {
    platform: "linux/arm64",
    image: "rust@sha256:7027e56e68dfd2c7bc66383bda559e1e1efb72301f55e4252925f6fa637d979d",
  },
} as const;
const crate = resolve("native/airtty-sandbox");
const dist = join(crate, "dist");

const args = process.argv.slice(2);
const check = args.includes("--check");
const only = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : undefined;
const archs = (["x64", "arm64"] as const).filter((a) => !only || a === only);
if (!archs.length) throw new Error("--arch must be x64 or arm64");

async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${cmd.join(" ")}`);
}
const sha256 = async (file: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");

const out = check ? await mkdtemp(join(tmpdir(), "airtty-sandbox-build-")) : dist;
try {
  const sums: string[] = [];
  for (const arch of archs) {
    const { platform, image } = ARCHS[arch];
    const target = join(out, `linux-${arch}`);
    await mkdir(target, { recursive: true });
    // The sources read-only; cargo's registry and target directory inside the container.
    // --remap-path-prefix keeps the container's paths out of panic messages.
    await run([
      "docker",
      "run",
      "--rm",
      "--platform",
      platform,
      "-v",
      `${crate}:/src:ro`,
      "-v",
      `${target}:/out`,
      "-e",
      "CARGO_TARGET_DIR=/tmp/target",
      "-e",
      "RUSTFLAGS=--remap-path-prefix=/src=airtty-sandbox --remap-path-prefix=/usr/local/cargo=cargo",
      "-w",
      "/src",
      image,
      "sh",
      "-c",
      // Static, or refused: the binary must run on glibc and musl systems alike.
      "cargo build --locked --release && ! ldd /tmp/target/release/airtty-sandbox 2>/dev/null | grep -q '=>' && cp /tmp/target/release/airtty-sandbox /out/ && chmod 755 /out/airtty-sandbox",
    ]);
    sums.push(`${await sha256(join(target, "airtty-sandbox"))}  linux-${arch}/airtty-sandbox`);
  }
  if (check) {
    const committed = await readFile(join(dist, "SHA256SUMS"), "utf8");
    const missing = sums.filter((line) => !committed.includes(line));
    if (missing.length)
      throw new Error(
        `The committed binaries are not what these sources build:\n${missing.join("\n")}`,
      );
    console.log(`Reproduced: ${sums.join(", ")}`);
  } else {
    const previous = await readFile(join(dist, "SHA256SUMS"), "utf8").catch(() => "");
    const kept = previous
      .split("\n")
      .filter((line) => line && !archs.some((a) => line.endsWith(`linux-${a}/airtty-sandbox`)));
    await writeFile(join(dist, "SHA256SUMS"), [...kept, ...sums].sort().join("\n") + "\n");
    console.log(sums.join("\n"));
  }
} finally {
  if (check) await rm(out, { recursive: true, force: true });
}
