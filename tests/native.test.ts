import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";
import { z } from "zod";
import { build } from "../packages/luciole/src/build";
import { compileApp, hostTarget } from "../packages/luciole/src/compile";
import { connect } from "../packages/luciole/src/connect";
import { messageOf } from "../packages/luciole/src/guards";
import { isNativeDirectory, layOutNative, nativePackage } from "../packages/luciole/src/native";
import { createHttpTransport } from "../packages/luciole/src/transport";
import { checksums, packBundle } from "../packages/luciole/src/launcher/bundle";
import { readBinaryIdentity } from "../packages/luciole/src/launcher/identity";
import { install } from "../packages/luciole/src/registry/apps";
import { packApp } from "../packages/luciole/src/registry/pack";
import type { Registry } from "../packages/luciole/src/registry/registry";
import { execute, rejectionOf } from "./helpers";

// examples/files makes thumbnails with sharp, whose addon links libvips next to it.
const root = resolve("examples/files");
let work: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-native-"));
});
afterAll(() => rm(work, { recursive: true, force: true }));

test("sharp is native, through its platform packages; zod is not", () => {
  const importer = join(root, "server/thumbnails.ts");
  expect(nativePackage("sharp", importer)?.name).toBe("sharp");
  expect(nativePackage("zod", importer)).toBeUndefined();
  expect(nativePackage("./fs", importer)).toBeUndefined();
  expect(nativePackage("node:fs", importer)).toBeUndefined();
  expect(isNativeDirectory(resolve("node_modules/react"))).toBe(false);
});

test("the build keeps native packages out of the Server bundle", async () => {
  const { output } = await build(root);
  const bundle = await Bun.file(join(output, "server/index.js")).text();
  expect(bundle).toContain('from "sharp"');
  expect(bundle).not.toContain("sharp-darwin-arm64/sharp.node");
}, 60000);

const Ready = z.object({ ready: z.literal(true), socket: z.string(), buildId: z.string() });
const Thumbnail = z.object({
  data: z.instanceof(Uint8Array),
  width: z.number(),
  height: z.number(),
});

test("a compiled binary loads sharp from native/ next to it, far from any node_modules", async () => {
  const { output, buildId } = await build(root);
  const compiled = await compileApp(output, {
    name: "files",
    outfile: join(work, "build/files"),
    // The stock runtime is covered by runtime.test.ts; this test stays offline.
    runtime: "host",
  });
  expect(compiled.native).toBe(join(work, "build/native"));
  const modules = join(work, "build/native/node_modules");
  // The target's platform packages only, none of the others sharp lists.
  const platforms = (await readdir(join(modules, "@img"))).filter((name) =>
    name.startsWith("sharp-"),
  );
  expect(platforms.sort()).toEqual(
    [`sharp-${hostTarget().slice(4)}`, `sharp-libvips-${hostTarget().slice(4)}`].sort(),
  );
  // Installed elsewhere, as apps/<app>/<buildId>/ would be: the binary and native/ only.
  const app = await mkdtemp("/tmp/luciole-app-");
  const pictures = join(work, "pictures");
  await mkdir(pictures);
  await sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } })
    .png()
    .toFile(join(pictures, "blue.png"));
  await cp(join(work, "build"), app, { recursive: true });
  const socket = join(app, "s");
  const server = spawn(join(app, "files"), ["serve", "--socket", socket], {
    cwd: app,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: work,
      FILES_ROOT: pictures,
      XDG_CACHE_HOME: join(work, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  try {
    await new Promise<void>((done, fail) => {
      server.once("exit", () => fail(new Error(`Server exited: ${errors}`)));
      createInterface({ input: server.stdout }).on("line", (line) => {
        if (Ready.safeParse(JSON.parse(line)).success) done();
      });
    });
    const transport = createHttpTransport({
      ...(await connect(`unix:${socket}`)),
      buildId,
      callServer: () => Promise.reject(new Error("unused")),
    });
    const thumbnail = Thumbnail.parse(
      await transport.call(`${buildId}/actions/files.ts#thumbnail`, [
        "blue.png",
        { width: 64, height: 64 },
      ]),
    );
    expect(thumbnail.width).toBe(64);
    const decoded = await sharp(thumbnail.data).metadata();
    expect(decoded.format).toBe("webp");
  } finally {
    server.kill();
    await rm(app, { recursive: true, force: true });
  }
}, 180000);

test("native/ travels with the binary: --on archive, npm package, install", async () => {
  // The build compiled by the previous test.
  const binary = join(work, "build/files");
  const archive = await packBundle("files", binary, hostTarget());
  const listing = (await execute(["tar", "tf", "-"], { stdin: archive })).stdout.toString();
  expect(listing).toContain("./native/node_modules/sharp/package.json");
  expect(listing).toContain("./native/server.js");
  const unpacked = join(work, "unpacked");
  await mkdir(unpacked);
  await execute(["tar", "xf", "-", "-C", unpacked], { stdin: archive });
  const sums = await Bun.file(join(unpacked, "SHA256SUMS")).text();
  expect(sums).toContain("  native/server.js\n");
  expect(sums).toContain(`  native/node_modules/@img/sharp-${hostTarget().slice(4)}/package.json`);
  expect(messageOf(await rejectionOf(packBundle("files", binary, "bun-linux-riscv")))).toContain(
    "next to the wrong binary",
  );
  const [platform, main] = await packApp({
    package: "@ada/files",
    version: "1.0.0",
    binaries: [binary],
    outdir: join(work, "npm"),
  });
  expect(await Bun.file(join(platform ?? "", "bin/native/server.js")).exists()).toBe(true);
  // Installed from a registry serving that package's bin/: native/ lands next to it.
  expect(await Bun.file(join(main ?? "", "package.json")).exists()).toBe(true);
  const identity = await readBinaryIdentity(binary);
  const registry: Registry = {
    location: "memory",
    search: async () => [],
    resolve: async () => ({
      package: "@ada/files",
      version: "1.0.0",
      app: {
        name: "files",
        buildId: identity.buildId,
        binaries: { [hostTarget()]: "@ada/files-x" },
      },
    }),
    download: async (_release, _target, directory) => {
      await cp(join(platform ?? "", "bin"), directory, { recursive: true });
    },
  };
  const apps = join(work, "apps");
  const { installed } = await install(
    { name: "@ada/files" },
    { registry, directories: { apps }, log: () => {} },
  );
  const build = join(apps, "files", installed.buildId);
  expect(await Bun.file(join(build, "native/server.js")).exists()).toBe(true);
  expect(await Bun.file(join(build, "SHA256SUMS")).text()).toBe(await checksums(build));
}, 120000);

test("a foreign target without its platform package is explained", async () => {
  const sharpDirectory = resolve("node_modules/sharp");
  const foreign = hostTarget() === "bun-linux-x64" ? "bun-darwin-arm64" : "bun-linux-x64";
  expect(
    messageOf(
      await rejectionOf(
        layOutNative(new Map([["sharp", sharpDirectory]]), {
          destination: join(work, "foreign/native"),
          target: foreign,
        }),
      ),
    ),
  ).toContain(`has no native code for ${foreign} here`);
});
