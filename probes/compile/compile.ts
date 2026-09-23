// Compiles a built airtty Client bundle into a standalone executable.
// bun compile.ts --entry <client/index.js> --out <file> [--target bun-darwin-arm64]
//   [--runtime host|official]
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const probe = import.meta.dir;
const entry = resolve(
  option("--entry", join(probe, "../../examples/notes/.airtty/client/index.js")),
);
const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
] as const satisfies readonly Bun.Build.CompileTarget[];
const isTarget = (t: string): t is (typeof targets)[number] => targets.some((x) => x === t);
const target = option("--target", `bun-${process.platform}-${process.arch}`);
if (!isTarget(target))
  throw new Error(`Unsupported target ${target}; use one of ${targets.join(", ")}`);
const outfile = resolve(
  option("--out", join(probe, ".out", target.replace(/^bun-/, "notes-client-"))),
);
const runtime = option("--runtime", "official");
const [, os, arch, libc] = target.split("-");

// Bun's npm package holding the stock runtime for a target (no Nix/Homebrew patching).
async function officialRuntime() {
  const name = `bun-${os}-${arch === "arm64" ? "aarch64" : arch}${libc === "musl" ? "-musl" : ""}`;
  const dir = join(probe, ".runtime", `${name}-${Bun.version}`);
  const exe = join(dir, "package/bin", os === "windows" ? "bun.exe" : "bun");
  if (await Bun.file(exe).exists()) return exe;
  await mkdir(dir, { recursive: true });
  const url = `https://registry.npmjs.org/@oven/${name}/-/${name}-${Bun.version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  await Bun.write(join(dir, "bun.tgz"), res);
  const tar = Bun.spawnSync(["tar", "xzf", "bun.tgz"], { cwd: dir });
  if (tar.exitCode) throw new Error(tar.stderr.toString());
  return exe;
}

const started = performance.now();
const result = await Bun.build({
  entrypoints: [entry],
  compile: {
    target,
    outfile,
    ...(runtime === "official" ? { executablePath: await officialRuntime() } : {}),
    // A Client binary runs in arbitrary user directories: never pick up their config.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  // OpenTUI picks glibc/musl from OPENTUI_LIBC at run time; fixing it at build time
  // drops the other branch, so only one native package has to be present.
  define:
    os === "linux"
      ? { "process.env.OPENTUI_LIBC": JSON.stringify(libc === "musl" ? "musl" : "") }
      : {},
  plugins: [
    {
      // OpenTUI imports @opentui/core-<os>-<arch>; Bun folds process.platform/arch for the
      // compile target. Foreign-platform packages live in this probe, not in the app.
      name: "opentui-native-target",
      setup(b) {
        b.onResolve({ filter: /^@opentui\/core-(darwin|linux|win32)-/ }, (a) => {
          try {
            return { path: Bun.resolveSync(a.path, probe) };
          } catch {
            return undefined;
          }
        });
      },
    },
  ],
});
if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
const size = Bun.file(outfile).size;
console.log(
  JSON.stringify({
    target,
    runtime,
    outfile,
    mb: +(size / 2 ** 20).toFixed(1),
    ms: Math.round(performance.now() - started),
  }),
);
