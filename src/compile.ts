/**
 * Ships a built Client as one executable: no Bun and no node_modules on the terminal's
 * machine. The build identity is inside it; it connects to Servers of the same build only.
 * Validated by probes/compile (OpenTUI embeds its native library through `type: "file"`).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

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
   * Bun executable embedded in the binary. Defaults to the one running the build; use
   * `airtty runtime` for the stock runtime of a target (see `hostRuntimeWarning`).
   */
  runtime?: string;
  /** Where `@opentui/core-<os>-<arch>` of a foreign target is installed. */
  nativeDir?: string;
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
        'Pass --runtime "$(airtty runtime)" to embed Bun\'s stock runtime.'
    : undefined;
}

export async function compileClient(
  output: string,
  options: CompileOptions & { name: string },
): Promise<{ outfile: string; target: CompileTarget; warning?: string }> {
  const { target, os, musl } = parseTarget(options.target ?? hostTarget());
  const outfile = resolve(
    options.outfile ?? join(output, "client", `${options.name}-${target.replace(/^bun-/, "")}`),
  );
  const nativeDir = options.nativeDir ? resolve(options.nativeDir) : undefined;
  const result = await Bun.build({
    entrypoints: [join(output, "client/index.js")],
    compile: {
      target,
      outfile,
      ...(options.runtime ? { executablePath: resolve(options.runtime) } : {}),
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
    const errors = (error as { errors?: { message?: string }[] }).errors ?? [];
    const messages = errors.map((e) => e.message ?? String(e)).join("\n");
    const missing = /Could not resolve: "(@opentui\/core-[\w-]+)"/.exec(messages)?.[1];
    if (missing)
      throw new Error(
        `${missing} is not installed for ${target}: install it for that platform ` +
          `(bun add ${missing} --os=${os} --cpu=*) in a directory passed as --native-dir`,
      );
    throw new Error(messages || (error as Error).message);
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
  return {
    outfile,
    target,
    warning: options.runtime || target !== hostTarget() ? undefined : hostRuntimeWarning(),
  };
}

/**
 * Downloads Bun's stock runtime for `target` from npm into a cache and returns its path.
 * Separate from the build on purpose: `airtty build` never touches the network.
 */
export async function fetchRuntime(
  target = hostTarget(),
  cache = join(homedir(), ".cache/airtty"),
) {
  const { os, arch, musl } = parseTarget(target);
  const name = `bun-${os}-${arch === "arm64" ? "aarch64" : arch}${musl ? "-musl" : ""}`;
  const dir = join(cache, "runtime", `${name}-${Bun.version}`);
  const executable = join(dir, "package/bin/bun");
  if (await Bun.file(executable).exists()) return executable;
  await mkdir(dir, { recursive: true });
  const url = `https://registry.npmjs.org/@oven/${name}/-/${name}-${Bun.version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await Bun.write(join(dir, "runtime.tgz"), response);
  const tar = Bun.spawnSync(["tar", "xzf", "runtime.tgz"], { cwd: dir });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  return executable;
}
