/**
 * Ships a built Client as one executable: no Bun and no node_modules on the terminal's
 * machine. The build identity is inside it; it connects to Servers of the same build only.
 * Validated by probes/compile (OpenTUI embeds its native library through `type: "file"`).
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { bundleMessages, logMessages } from "./bundle-errors";
import { formatIdentity, type BinaryIdentity } from "./launcher/identity";
import { checkAppName } from "./launcher/paths";
import {
  layOutNative,
  NATIVE_DIRECTORY,
  NATIVE_SERVER,
  nativePackage,
  nativeTarget,
} from "./native";
import { readJsonFile } from "./package-json";
import { matchesDist, publishedDist } from "./registry/npm";
import { checkSigning, notarizeClient, signClient, type SignOptions } from "./sign";

export const COMPILE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
] as const satisfies readonly Bun.Build.CompileTarget[];
export type CompileTarget = (typeof COMPILE_TARGETS)[number];
const isTarget = (target: string): target is CompileTarget =>
  COMPILE_TARGETS.some((t) => t === target);
export const hostTarget = () => `bun-${process.platform}-${process.arch}`;

export type CompileOptions = {
  /** Defaults to the machine running the build. */
  target?: string;
  /** Defaults to `<output>/client/<app>-<target>`. */
  outfile?: string;
  /**
   * Bun executable embedded in the binary: `"official"` (default) is Bun's stock runtime
   * for the target, downloaded once by `fetchRuntime`; `"host"` is the Bun running the
   * build (see `runtimePortability`); anything else is the path of a Bun executable.
   */
  runtime?: string;
  /**
   * Fails, before building, when the runtime links libraries other machines may lack,
   * instead of warning: for binaries shipped to other people (a desktop bundle).
   */
  portable?: boolean;
  /** Where `@opentui/core-<os>-<arch>` of a foreign target is installed. */
  nativeDir?: string;
} & RuntimeSource &
  SignOptions;

export type RuntimeSource = {
  /** Defaults to `$XDG_CACHE_HOME/airtty` or `~/.cache/airtty`. */
  cache?: string;
  registry?: string;
};

function parseTarget(target: string) {
  if (!isTarget(target))
    throw new Error(`Unsupported target ${target}; use one of ${COMPILE_TARGETS.join(", ")}`);
  const [, os, arch, libc] = target.split("-");
  return { target, os, arch, musl: libc === "musl" };
}

/**
 * A macOS Bun from Nix or Homebrew may link libraries that other Macs do not have: the
 * binary built on it would not start there. Returns why, or nothing when it is stock.
 */
export function runtimePortability(runtime: string) {
  if (process.platform !== "darwin") return undefined;
  const otool = Bun.spawnSync(["otool", "-L", runtime]);
  if (otool.exitCode !== 0) return undefined;
  const foreign = otool.stdout
    .toString()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((lib) => lib && !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/"));
  return foreign.length
    ? `${runtime} links ${foreign.join(", ")}: the binary may not start on other Macs. ` +
        "Omit --runtime to embed Bun's stock runtime."
    : undefined;
}

async function resolveRuntime(target: CompileTarget, options: CompileOptions) {
  const runtime = options.runtime ?? "official";
  if (runtime === "official") return fetchRuntime(target, options);
  if (runtime === "host") {
    if (target !== hostTarget())
      throw new Error(`--runtime host only builds for ${hostTarget()}, not ${target}`);
    return process.execPath;
  }
  const executable = resolve(runtime);
  if (!(await Bun.file(executable).exists())) throw new Error(`Runtime ${executable} not found`);
  return executable;
}

export async function compileClient(
  output: string,
  options: CompileOptions & { name: string },
): Promise<Compiled> {
  return compileEntry(join(output, "client/index.js"), {
    ...options,
    outfile: options.outfile ?? join(output, "client", `${options.name}-${suffix(options)}`),
  });
}

const BuildManifest = z.object({ buildId: z.string().min(1) });
/** The build id of a build output directory (`.airtty`). */
export const readBuildId = async (output: string) =>
  (await readJsonFile(join(output, "manifest.json"), BuildManifest)).buildId;
const framework = import.meta.dir;

/**
 * The whole app in one executable: Client and Server of one build, and the launcher that
 * picks the role (src/launcher/binary.ts). `notes` runs both locally, `notes serve` the
 * Server alone, `notes --url …` the Client alone, `notes --on host` the Server there.
 *
 * The two roles need React under different export conditions, which one bundle cannot
 * mix: the Server is bundled first, whole, under `react-server`, then embedded next to
 * the Client, which keeps the default conditions. Each role loads only its own half.
 */
export async function compileApp(
  output: string,
  options: CompileOptions & { name: string },
): Promise<Compiled & { identity: BinaryIdentity; native?: string }> {
  const { target } = parseTarget(options.target ?? hostTarget());
  const buildId = await readBuildId(output);
  const staging = join(output, "binary");
  await rm(staging, { recursive: true, force: true });
  const outfile = resolve(
    options.outfile ?? join(output, "bin", suffix(options), checkAppName(options.name)),
  );
  // Native packages stay out of the bundle: a compiled binary cannot resolve packages at
  // run time, so the Server then runs from native/server.js, next to native/node_modules,
  // with the binary acting as Bun (src/launcher/binary.ts).
  const natives = new Map<string, string>();
  const server = await Bun.build({
    entrypoints: [join(output, "server/index.js")],
    outdir: staging,
    naming: "server.js",
    target: "bun",
    conditions: ["react-server"],
    // Set so that the binary acts as Bun; the application's own children must not.
    banner: "delete process.env.BUN_BE_BUN;",
    plugins: [
      {
        name: "airtty-native",
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (a) => {
            const found = a.importer ? nativePackage(a.path, a.importer) : undefined;
            if (!found) return undefined;
            natives.set(found.name, found.directory);
            return { path: a.path, external: true };
          });
        },
      },
    ],
  }).catch((error: unknown) => {
    throw new Error(bundleMessages(error).join("\n"));
  });
  if (!server.success) throw new Error(logMessages(server.logs));
  const nativeDirectory = join(dirname(outfile), NATIVE_DIRECTORY);
  const previous = nativeTarget(nativeDirectory);
  if (natives.size && previous && previous !== target)
    throw new Error(
      `${nativeDirectory} holds native packages for ${previous}: compile ${target} into ` +
        "another directory (--outfile)",
    );
  if (natives.size || previous === target)
    await layOutNative(natives, {
      destination: nativeDirectory,
      target,
      nativeDir: options.nativeDir ? resolve(options.nativeDir) : undefined,
    });
  if (natives.size) await cp(join(staging, "server.js"), join(nativeDirectory, NATIVE_SERVER));
  const identity: BinaryIdentity = { name: checkAppName(options.name), buildId, target };
  const entry = join(staging, "entry.js");
  await Bun.write(
    entry,
    `import {main} from ${JSON.stringify(join(framework, "launcher/binary.ts"))};\n` +
      `await main(${JSON.stringify(formatIdentity(identity))},{` +
      `server:${natives.size ? "null" : '()=>import("./server.js")'},client:()=>import("../client/index.js")` +
      // The application's arguments, parsed by the launcher half before any Server starts.
      `${(await Bun.file(join(output, "args/index.js")).exists()) ? ',args:()=>import("../args/index.js")' : ""}});\n`,
  );
  try {
    const compiled = await compileEntry(entry, { ...options, outfile });
    return { ...compiled, identity, native: natives.size ? nativeDirectory : undefined };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

type Compiled = { outfile: string; target: CompileTarget; warning?: string; notarization?: string };
const suffix = (options: CompileOptions) => (options.target ?? hostTarget()).replace(/^bun-/, "");

async function compileEntry(
  entry: string,
  options: CompileOptions & { outfile: string },
): Promise<Compiled> {
  const { target, os, musl } = parseTarget(options.target ?? hostTarget());
  checkSigning(target, options);
  const outfile = resolve(options.outfile);
  const nativeDir = options.nativeDir ? resolve(options.nativeDir) : undefined;
  const runtime = await resolveRuntime(target, options);
  const portability = runtimePortability(runtime);
  if (portability && options.portable) throw new Error(portability);
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      target,
      outfile,
      executablePath: runtime,
      // A Client binary runs in arbitrary user directories: never pick up their config.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    // OpenTUI picks glibc or musl at run time; fixing it drops the other native package.
    define:
      os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(musl ? "musl" : "") } : {},
    plugins: nativeDir
      ? [
          {
            name: "airtty-native-target",
            setup(b) {
              b.onResolve({ filter: /^@opentui\/core-(darwin|linux|win32)-/ }, (a) => ({
                path: Bun.resolveSync(a.path, nativeDir),
              }));
            },
          },
        ]
      : [],
  }).catch((error: unknown) => {
    const messages = bundleMessages(error).join("\n");
    const missing = /Could not resolve: "(@opentui\/core-[\w-]+)"/.exec(messages)?.[1];
    if (missing)
      throw new Error(
        `${missing} is not installed for ${target}: install the app's packages for that ` +
          `platform from its lock (bun install --frozen-lockfile --os=${os} --cpu=* next to ` +
          `a copy of its package.json and bun.lock) and pass that directory as --native-dir`,
      );
    throw new Error(messages);
  });
  if (!result.success) throw new Error(logMessages(result.logs));
  if (options.sign !== undefined) await signClient(outfile, options.sign);
  return {
    outfile,
    target,
    warning: portability,
    notarization:
      options.notarize === undefined ? undefined : await notarizeClient(outfile, options.notarize),
  };
}

export const defaultCache = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "airtty");

/**
 * Bun's stock runtime for `target` (`@oven/bun-<os>-<arch>` on npm), downloaded on the
 * first use, checked against the integrity the registry publishes, then reused offline.
 * The cache entry appears in one rename: an interrupted download leaves nothing behind.
 */
export async function fetchRuntime(
  target = hostTarget(),
  { cache = defaultCache(), registry = "https://registry.npmjs.org" }: RuntimeSource = {},
) {
  const { os, arch, musl } = parseTarget(target);
  const name = `bun-${os}-${arch === "arm64" ? "aarch64" : arch}${musl ? "-musl" : ""}`;
  const runtimes = join(cache, "runtime");
  const dir = join(runtimes, `${name}-${Bun.version}`);
  const executable = join(dir, "package/bin/bun");
  // Entries are published whole by a rename. The older layout extracted in place next to
  // its runtime.tgz, so its bun may be truncated: such an entry is fetched again.
  const complete = async () =>
    (await Bun.file(executable).exists()) && !(await Bun.file(join(dir, "runtime.tgz")).exists());
  if (await complete()) return executable;
  const download = async (url: string) => {
    const response = await fetch(url).catch((error: unknown) => {
      throw new Error(
        `Bun's stock runtime for ${target} is not cached in ${runtimes} and ${url} is ` +
          `unreachable (${error instanceof Error ? error.message : String(error)}). ` +
          "Connect once to cache it, or pass --runtime host or --runtime <bun executable>.",
      );
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
  };
  const metadata = `${registry}/@oven/${name}/${Bun.version}`;
  const dist = publishedDist(await (await download(metadata)).json());
  if (!dist) throw new Error(`${metadata} publishes no tarball with an integrity`);
  const tarball = new Uint8Array(await (await download(dist.tarball)).arrayBuffer());
  if (!matchesDist(tarball, dist))
    throw new Error(`${dist.tarball} does not match the integrity published by ${registry}`);
  await mkdir(runtimes, { recursive: true });
  const staging = await mkdtemp(join(runtimes, `.${name}-`));
  try {
    await Bun.write(join(staging, "runtime.tgz"), tarball);
    const tar = Bun.spawnSync(["tar", "xzf", "runtime.tgz"], { cwd: staging });
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
    await rm(join(staging, "runtime.tgz"));
    if (!(await Bun.file(join(staging, "package/bin/bun")).exists()))
      throw new Error(`${dist.tarball} holds no package/bin/bun`);
    await rename(staging, dir).catch(async () => {
      // Another build finished first, or an incomplete entry predates this cache layout.
      if (await complete()) return;
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return executable;
}
