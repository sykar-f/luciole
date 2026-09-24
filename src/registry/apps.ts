/**
 * Apps installed from a registry, in `$XDG_DATA_HOME/airtty/apps/<app>/`:
 *
 *   installed.json          which package, version and build, and the range it follows
 *   <buildId>/<app>         the binary (the layout `--on` installs on remote hosts too)
 *
 * A new version is written next to the current one and switched to by rewriting
 * installed.json; the old binary is removed after. A running old binary keeps working:
 * removing a file does not take it from a process that has it open.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hostTarget } from "../compile";
import { checksums, SUMS } from "../launcher/bundle";
import { readBinaryIdentity } from "../launcher/identity";
import { withLock } from "../launcher/lock";
import { checkAppName, type Directories } from "../launcher/paths";
import type { Confirm } from "../launcher/prompt";
import { readJsonFile } from "../package-json";
import { formatSpec, type PackageSpec, type Registry, type Release } from "./registry";

const Installed = z.object({
  app: z.string(),
  package: z.string(),
  version: z.string(),
  /** What `update` follows: the range or tag installed, `latest` when none was given. */
  range: z.string().optional(),
  buildId: z.string(),
  target: z.string(),
  registry: z.string(),
  installedAt: z.string(),
});
export type Installed = z.infer<typeof Installed>;

const EXECUTABLE = 0o755;
const appDirectory = (directories: Pick<Directories, "apps">, app: string) =>
  join(directories.apps, checkAppName(app));
const recordOf = (directories: Pick<Directories, "apps">, app: string) =>
  join(appDirectory(directories, app), "installed.json");
export const binaryOf = (directories: Pick<Directories, "apps">, installed: Installed) =>
  join(appDirectory(directories, installed.app), installed.buildId, installed.app);

/** The installed app `app`, or `undefined`. */
export async function findInstalled(directories: Pick<Directories, "apps">, app: string) {
  const record = recordOf(directories, app);
  if (!existsSync(record)) return undefined;
  return readJsonFile(record, Installed);
}

export async function listInstalled(directories: Pick<Directories, "apps">) {
  const entries = await readdir(directories.apps).catch((): string[] => []);
  const found: Installed[] = [];
  for (const entry of entries.sort()) {
    if (!existsSync(join(directories.apps, entry, "installed.json"))) continue;
    found.push(await readJsonFile(join(directories.apps, entry, "installed.json"), Installed));
  }
  return found;
}

export type InstallOptions = {
  registry: Registry;
  directories: Pick<Directories, "apps">;
  log: (message: string) => void;
  /** Asked before installing, with what would be installed; accepts when absent. */
  confirm?: Confirm;
  target?: string;
};

/** Writes the release's binary and switches the app to it. */
async function place(release: Release, spec: PackageSpec, options: InstallOptions) {
  const { registry, directories, log, target = hostTarget() } = options;
  const app = checkAppName(release.app.name);
  const directory = appDirectory(directories, app);
  const previous = await findInstalled(directories, app);
  if (previous && previous.package !== release.package)
    throw new Error(
      `${app} is already installed from ${previous.package}: remove it before installing ${release.package}`,
    );
  if (
    previous?.buildId === release.app.buildId &&
    previous.version === release.version &&
    existsSync(binaryOf(directories, previous))
  ) {
    // Same binary; a new range is still remembered.
    const installed = { ...previous, range: spec.range };
    await writeFile(recordOf(directories, app), JSON.stringify(installed, null, 2) + "\n");
    return { installed, changed: false };
  }
  log(`Downloading ${release.package}@${release.version} for ${target}…`);
  // Downloaded aside, checked, then swapped in whole, with its SHA256SUMS.
  const build = join(directory, release.app.buildId);
  const staging = `${build}.new.${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    await registry.download(release, target, staging);
    await chmod(join(staging, app), EXECUTABLE);
    const identity = await readBinaryIdentity(join(staging, app));
    if (
      identity.name !== app ||
      identity.buildId !== release.app.buildId ||
      identity.target !== target
    )
      throw new Error(
        `${release.package}@${release.version} for ${target} holds ${identity.name} ` +
          `${identity.buildId} for ${identity.target}, not what its package.json declares`,
      );
    await writeFile(join(staging, SUMS), await checksums(staging));
    await rm(build, { recursive: true, force: true });
    await rename(staging, build);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const installed: Installed = {
    app,
    package: release.package,
    version: release.version,
    ...(spec.range ? { range: spec.range } : {}),
    buildId: release.app.buildId,
    target,
    registry: registry.location,
    installedAt: new Date().toISOString(),
  };
  const record = recordOf(directories, app);
  await writeFile(`${record}.tmp`, JSON.stringify(installed, null, 2) + "\n");
  await rename(`${record}.tmp`, record);
  if (previous && previous.buildId !== installed.buildId)
    await rm(join(directory, previous.buildId), { recursive: true, force: true });
  return { installed, changed: true };
}

/** Installs, or moves to, the release `spec` designates now. */
export async function install(spec: PackageSpec, options: InstallOptions) {
  const release = await options.registry.resolve(spec);
  const app = checkAppName(release.app.name);
  if (options.confirm) {
    const current = await findInstalled(options.directories, app);
    if (current?.version !== release.version) {
      const question =
        `Install ${release.package}@${release.version} (${app}) from ${options.registry.location}?` +
        (release.description ? `\n  ${release.description}` : "") +
        "\nIt runs as you, its Server included.";
      if (!(await options.confirm(question)))
        throw new Error(`${formatSpec(spec)} was not installed`);
    }
  }
  await mkdir(options.directories.apps, { recursive: true });
  return withLock(join(options.directories.apps, `.${app}.lock`), () =>
    place(release, spec, options),
  );
}

/** Moves each app (or those named) to the newest release its range allows. */
export async function update(names: readonly string[], options: InstallOptions) {
  const all = await listInstalled(options.directories);
  const unknown = names.filter((name) => !all.some((installed) => installed.app === name));
  if (unknown.length) throw new Error(`Not installed: ${unknown.join(", ")}`);
  const results: { installed: Installed; changed: boolean; from: string }[] = [];
  for (const current of all.filter((installed) => !names.length || names.includes(installed.app))) {
    const spec = { name: current.package, range: current.range };
    const { installed, changed } = await install(spec, { ...options, confirm: undefined });
    results.push({ installed, changed, from: current.version });
  }
  return results;
}

export async function remove(app: string, directories: Pick<Directories, "apps">) {
  if (!(await findInstalled(directories, app))) throw new Error(`${app} is not installed`);
  await rm(appDirectory(directories, app), { recursive: true, force: true });
}
