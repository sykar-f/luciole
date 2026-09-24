/**
 * Ships a built Client as one executable: no Bun and no node_modules on the terminal's
 * machine. The build identity is inside it; it connects to Servers of the same build only.
 * Validated by probes/compile (OpenTUI embeds its native library through `type: "file"`).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { bundleMessages, logMessages } from "./bundle-errors";
import { formatIdentity, type BinaryIdentity } from "./launcher/identity";
import { checkAppName } from "./launcher/paths";
import { readJsonFile } from "./package-json";
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
   * build (see `hostRuntimeWarning`); anything else is the path of a Bun executable.
   */
  runtime?: string;
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
export function hostRuntimeWarning(runtime = process.execPath) {
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
): Promise<Compiled & { identity: BinaryIdentity }> {
  const { target } = parseTarget(options.target ?? hostTarget());
  const { buildId } = await readJsonFile(join(output, "manifest.json"), BuildManifest);
  const staging = join(output, "binary");
  await rm(staging, { recursive: true, force: true });
  const server = await Bun.build({
    entrypoints: [join(output, "server/index.js")],
    outdir: staging,
    naming: "server.js",
    target: "bun",
    conditions: ["react-server"],
  }).catch((error: unknown) => {
    throw new Error(bundleMessages(error).join("\n"));
  });
  if (!server.success) throw new Error(logMessages(server.logs));
  const identity: BinaryIdentity = { name: checkAppName(options.name), buildId, target };
  const entry = join(staging, "entry.js");
  await Bun.write(
    entry,
    `import {main} from ${JSON.stringify(join(framework, "launcher/binary.ts"))};\n` +
      `await main(${JSON.stringify(formatIdentity(identity))},{` +
      `server:()=>import("./server.js"),client:()=>import("../client/index.js")});\n`,
  );
  try {
    const compiled = await compileEntry(entry, {
      ...options,
      outfile: options.outfile ?? join(output, "bin", `${options.name}-${suffix(options)}`),
    });
    return { ...compiled, identity };
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
        `${missing} is not installed for ${target}: install it for that platform ` +
          `(bun add ${missing} --os=${os} --cpu=*) in a directory passed as --native-dir`,
      );
    throw new Error(messages);
  });
  if (!result.success) throw new Error(logMessages(result.logs));
  if (options.sign !== undefined) await signClient(outfile, options.sign);
  return {
    outfile,
    target,
    warning: runtime === process.execPath ? hostRuntimeWarning(runtime) : undefined,
    notarization:
      options.notarize === undefined ? undefined : await notarizeClient(outfile, options.notarize),
  };
}

const defaultCache = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "airtty");

/** The part of an npm version document that locates and verifies the tarball. */
const VersionDocument = z.object({
  dist: z.object({
    tarball: z.string().min(1),
    integrity: z.string().min(1).optional(),
    shasum: z.string().min(1).optional(),
  }),
});
/** The `dist` entry of an npm version document, when it can be verified. */
function publishedDist(document: unknown) {
  const parsed = VersionDocument.safeParse(document);
  if (!parsed.success) return undefined;
  const { dist } = parsed.data;
  return dist.integrity || dist.shasum ? dist : undefined;
}

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
  const digest = (algorithm: "sha512" | "sha1", encoding: "base64" | "hex") =>
    new Bun.CryptoHasher(algorithm).update(tarball).digest(encoding);
  const verified = dist.integrity?.startsWith("sha512-")
    ? digest("sha512", "base64") === dist.integrity.slice("sha512-".length)
    : dist.shasum !== undefined && digest("sha1", "hex") === dist.shasum;
  if (!verified)
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
