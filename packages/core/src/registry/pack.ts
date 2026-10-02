/**
 * Turns an app's binaries into npm packages (src/registry/npm.ts): one per target,
 * holding `bin/<app>` (and `bin/native/` when the app has native packages) and declaring
 * its `os`/`cpu`/`libc`, and the app's own package
 * whose `luciole` field maps each target to it. Publish the platform packages first:
 * the app's package refers to them.
 */
import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NATIVE_DIRECTORY, nativeTarget } from "../native";
import { readBinaryIdentity, type BinaryIdentity } from "../launcher/identity";
import { APP_KEYWORD } from "./npm";
import { parsePackageSpec, type AppField } from "./registry";

export type PackOptions = {
  /** The app's npm name, `@scope/notes` or `notes`. */
  package: string;
  version: string;
  description?: string;
  /** Binaries of one build, one per target (`luciole build --compile --target …`). */
  binaries: readonly string[];
  outdir: string;
};

const EXECUTABLE = 0o755;
const directoryOf = (name: string) => name.replace("/", "__");

/** Writes the packages; returns their directories in publishing order. */
export async function packApp(options: PackOptions) {
  const spec = parsePackageSpec(options.package);
  if (!spec || spec.range !== undefined) throw new Error(`Invalid package name ${options.package}`);
  if (!Bun.semver.satisfies(options.version, options.version))
    throw new Error(`Invalid version ${options.version}`);
  if (!options.binaries.length) throw new Error("No binary to pack");
  const found: { file: string; identity: BinaryIdentity }[] = [];
  for (const file of options.binaries)
    found.push({ file, identity: await readBinaryIdentity(file) });
  const [first] = found;
  if (!first) throw new Error("No binary to pack");
  const { name, buildId } = first.identity;
  for (const { file, identity } of found) {
    if (identity.name !== name || identity.buildId !== buildId)
      throw new Error(
        `${file} is ${identity.name} ${identity.buildId}, not ${name} ${buildId}: pack one build`,
      );
    if (found.filter((other) => other.identity.target === identity.target).length > 1)
      throw new Error(`Two binaries for ${identity.target}`);
  }
  const common = {
    version: options.version,
    ...(options.description ? { description: options.description } : {}),
  };
  const binaries: AppField["binaries"] = {};
  const directories: string[] = [];
  for (const { file, identity } of found) {
    const [, os = "", cpu = "", libc] = identity.target.split("-");
    const holder = `${options.package}-${identity.target.replace(/^bun-/, "")}`;
    binaries[identity.target] = holder;
    const directory = join(options.outdir, directoryOf(holder));
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, "bin"), { recursive: true });
    await copyFile(file, join(directory, "bin", name));
    await chmod(join(directory, "bin", name), EXECUTABLE);
    // An app with native packages ships them next to its binary (src/compile.ts).
    const native = join(dirname(file), NATIVE_DIRECTORY);
    const nativeFor = nativeTarget(native);
    if (nativeFor !== undefined) {
      if (nativeFor !== identity.target)
        throw new Error(`${native} is for ${nativeFor}, not ${identity.target}`);
      await cp(native, join(directory, "bin", NATIVE_DIRECTORY), {
        recursive: true,
        dereference: true,
      });
    }
    await Bun.write(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: holder,
          ...common,
          os: [os],
          cpu: [cpu],
          ...(os === "linux" ? { libc: [libc === "musl" ? "musl" : "glibc"] } : {}),
          files: ["bin"],
          preferUnplugged: true,
        },
        null,
        2,
      ) + "\n",
    );
    directories.push(directory);
  }
  const directory = join(options.outdir, directoryOf(options.package));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const luciole: AppField = { name, buildId, binaries };
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: options.package,
        ...common,
        keywords: [APP_KEYWORD],
        luciole,
        optionalDependencies: Object.fromEntries(
          Object.values(binaries).map((holder) => [holder, options.version]),
        ),
        files: [],
      },
      null,
      2,
    ) + "\n",
  );
  directories.push(directory);
  return directories;
}
