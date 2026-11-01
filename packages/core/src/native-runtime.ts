/** Matching patched OpenTUI JavaScript and native code, prepared independently of luciole. */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import * as z from "zod/mini";
import { ArgsError } from "./args";
import { COMPILE_TARGETS, type CompileTarget, defaultCache, hostTarget } from "./targets";
import {
  OPENTUI_TAG,
  OPENTUI_REPOSITORY,
  prepareOpenTuiCheckout,
  buildOpenTuiLibrary,
  publishRuntimeEntry,
  checkZig,
  openTuiZigVersion,
  nativePatches,
  type OpenTuiTag,
} from "./opentui-runtime";

const LAYOUT_VERSION = 1;
const HASH_PREFIX = 16;
const MANIFEST = "native-runtime.json";
const SOURCE_TREE = "opentui-source-tree";
const GENERATED_ABI = "core/native-abi.generated.ts";

/** Upstream's output directory drops minimum OS/libc versions from the Zig target. */
export const NATIVE_TARGETS = {
  "bun-darwin-arm64": {
    zig: "aarch64-macos.13.0",
    output: "aarch64-macos",
    library: "libopentui.dylib",
    libc: "system",
  },
  "bun-darwin-x64": {
    zig: "x86_64-macos.13.0",
    output: "x86_64-macos",
    library: "libopentui.dylib",
    libc: "system",
  },
  "bun-linux-x64": {
    zig: "x86_64-linux-gnu.2.17",
    output: "x86_64-linux",
    library: "libopentui.so",
    libc: "glibc",
  },
  "bun-linux-arm64": {
    zig: "aarch64-linux-gnu.2.17",
    output: "aarch64-linux",
    library: "libopentui.so",
    libc: "glibc",
  },
  "bun-linux-x64-musl": {
    zig: "x86_64-linux-musl",
    output: "x86_64-linux-musl",
    library: "libopentui.so",
    libc: "musl",
  },
  "bun-linux-arm64-musl": {
    zig: "aarch64-linux-musl",
    output: "aarch64-linux-musl",
    library: "libopentui.so",
    libc: "musl",
  },
} as const satisfies Record<
  CompileTarget,
  { zig: string; output: string; library: string; libc: string }
>;

function checkedTarget(target: string): CompileTarget {
  const found = COMPILE_TARGETS.find((candidate) => candidate === target);
  if (!found)
    throw new ArgsError(
      `Unsupported native target ${target}; expected ${COMPILE_TARGETS.join(", ")}`,
    );
  return found;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Ordered patch digests preserve byte and order changes without framework invalidations. */
export function nativeRuntimeIdentity(
  target: string,
  patches?: readonly Buffer[],
  tag: OpenTuiTag = OPENTUI_TAG,
) {
  const selected = checkedTarget(target);
  return {
    layout: LAYOUT_VERSION,
    tag,
    patches: (patches ?? nativePatches(tag).map((patch) => readFileSync(patch))).map(digest),
    zigVersion: openTuiZigVersion(tag),
    target: selected,
    zigTarget: NATIVE_TARGETS[selected].zig,
    libc: NATIVE_TARGETS[selected].libc,
  };
}

export function nativeRuntimeDirectory(
  target = hostTarget(),
  cache = defaultCache(),
  tag: OpenTuiTag = OPENTUI_TAG,
) {
  return join(
    cache,
    "native",
    `${target}-${digest(JSON.stringify(nativeRuntimeIdentity(target, undefined, tag))).slice(0, HASH_PREFIX)}`,
  );
}

const Manifest = z.object({
  layout: z.number(),
  tag: z.string(),
  patches: z.array(z.string()),
  zigVersion: z.string(),
  target: z.string(),
  zigTarget: z.string(),
  libc: z.string(),
  tree: z.string().check(z.regex(/^[a-f0-9]{40}$/)),
  files: z.record(z.string(), z.string().check(z.regex(/^[a-f0-9]{64}$/))),
});

/** Validate provenance and every staged file; requires neither Zig nor a source checkout. */
export function nativeRuntimeComplete(
  directory: string,
  target = hostTarget(),
  tag: OpenTuiTag = OPENTUI_TAG,
) {
  const identity = nativeRuntimeIdentity(target, undefined, tag);
  try {
    const manifest = Manifest.parse(JSON.parse(readFileSync(join(directory, MANIFEST), "utf8")));
    const { tree, files, ...recorded } = manifest;
    if (JSON.stringify(recorded) !== JSON.stringify(identity)) return false;
    const required = [
      "core/package.json",
      "core/index.bun.js",
      "core/parser.worker.js",
      GENERATED_ABI,
      "library/index.bun.js",
      `library/${NATIVE_TARGETS[identity.target].library}`,
      SOURCE_TREE,
    ];
    if (!required.every((file) => Object.hasOwn(files, file))) return false;
    if (readFileSync(join(directory, SOURCE_TREE), "utf8") !== `${tree}\n`) return false;
    // File names are canonical relative paths, never paths outside this entry.
    const names = Object.keys(files);
    if (
      names.some(
        (file) =>
          !file ||
          file.split("/").some((part) => !part || part === "." || part === "..") ||
          file.includes("\\") ||
          file === MANIFEST,
      )
    )
      return false;
    const actual = [
      ...new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true, dot: true }),
    ]
      .filter((file) => file !== MANIFEST)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(names.sort())) return false;
    return names.every((file) => digest(readFileSync(join(directory, file))) === files[file]);
  } catch {
    return false;
  }
}

/** The compiler can discover a complete entry without preparing or invoking any tool. */
export function findNativeRuntime(
  target = hostTarget(),
  cache = defaultCache(),
  tag: OpenTuiTag = OPENTUI_TAG,
) {
  const directory = nativeRuntimeDirectory(target, cache, tag);
  return nativeRuntimeComplete(directory, target, tag) ? directory : undefined;
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error(`${command.join(" ")} failed`);
}

/** Internal seam for deterministic cache/lock tests; production supplies the real builder. */
export function prepareNativeRuntimeEntry({
  target = hostTarget(),
  cache = defaultCache(),
  build,
  sourceTree,
  waiting,
  tag = OPENTUI_TAG,
}: {
  target?: string;
  cache?: string;
  build: (temporary: string) => Promise<void>;
  sourceTree: () => string;
  waiting?: () => void;
  tag?: OpenTuiTag;
}) {
  const directory = nativeRuntimeDirectory(target, cache, tag);
  const identity = nativeRuntimeIdentity(target, undefined, tag);
  const checkout = nativeCheckoutDirectory(cache, tag);
  const complete = (path: string) => nativeRuntimeComplete(path, target, tag);
  let tree = "";
  return publishRuntimeEntry({
    directory,
    checkout,
    marker: MANIFEST,
    complete,
    validateReuse: complete,
    ...(waiting === undefined ? {} : { waiting }),
    sourceTree: () => (tree = sourceTree()),
    async build(temporary) {
      await build(temporary);
      // Hash the sidecar too; the shared publisher writes the same bytes before rename.
      writeFileSync(join(temporary, SOURCE_TREE), `${tree}\n`);
      const files: Record<string, string> = {};
      for (const file of [
        ...new Bun.Glob("**/*").scanSync({ cwd: temporary, onlyFiles: true, dot: true }),
      ].sort())
        files[file] = digest(readFileSync(join(temporary, file)));
      writeFileSync(
        join(temporary, MANIFEST),
        `${JSON.stringify({ ...identity, tree, files }, null, 2)}\n`,
      );
      if (!complete(temporary)) throw new Error("Incomplete native OpenTUI runtime build");
    },
  });
}

function nativeCheckoutDirectory(cache: string, tag: OpenTuiTag) {
  return join(
    cache,
    "native",
    `opentui-${tag}-${openTuiZigVersion(tag)}-${digest(Buffer.concat(nativePatches(tag).map((patch) => readFileSync(patch)))).slice(0, HASH_PREFIX)}`,
  );
}

/** Prepare the selected target once, atomically, with a lock shared by all native targets. */
export async function prepareNativeRuntime({
  target = hostTarget(),
  cache = defaultCache(),
  zig = process.env["ZIG"] ?? "zig",
  tag = OPENTUI_TAG,
}: { target?: string; cache?: string; zig?: string; tag?: OpenTuiTag } = {}) {
  const selected = checkedTarget(target);
  const configuration = NATIVE_TARGETS[selected];
  const checkout = nativeCheckoutDirectory(cache, tag);
  let tree = "";
  return prepareNativeRuntimeEntry({
    target,
    cache,
    tag,
    sourceTree: () =>
      (tree = prepareOpenTuiCheckout(checkout, OPENTUI_REPOSITORY, tag, nativePatches(tag))),
    waiting: () =>
      console.error(`luciole native-runtime: waiting for another preparation of ${target}`),
    async build(temporary) {
      checkZig(zig, "native runtime", openTuiZigVersion(tag));
      // Upstream's ABI/distribution scripts invoke `zig` by name. Honor ZIG there too.
      const toolchain = join(temporary, ".toolchain");
      mkdirSync(toolchain);
      symlinkSync(Bun.which(zig) ?? resolve(zig), join(toolchain, "zig"));
      const env = {
        PATH: `${toolchain}:${process.env["PATH"] ?? ""}`,
        ...(process.platform === "darwin" &&
        !process.env["DEVELOPER_DIR"] &&
        existsSync("/Library/Developer/CommandLineTools")
          ? { DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }
          : {}),
      };
      const artifact = buildOpenTuiLibrary({
        checkout,
        zig,
        tree,
        artifact: join(
          checkout,
          "packages/native/lib",
          configuration.output,
          configuration.library,
        ),
        options: [`-Dlibrary-target=${configuration.zig}`, "-Doptimize=ReleaseFast"],
        runtime: "native runtime",
        tag,
        env,
      });
      const core = join(checkout, "packages/core");
      await run([process.execPath, "scripts/build.ts", "--lib"], core, env);
      cpSync(join(core, "dist"), join(temporary, "core"), { recursive: true });
      cpSync(join(core, "src/native-abi.generated.ts"), join(temporary, GENERATED_ABI));
      mkdirSync(join(temporary, "library"));
      cpSync(artifact, join(temporary, "library", configuration.library));
      writeFileSync(
        join(temporary, "library/index.bun.js"),
        `import path from "./${configuration.library}" with { type: "file" };\nexport default path;\n`,
      );
      rmSync(toolchain, { recursive: true, force: true });
    },
  });
}
