/**
 * The npm registry as an app registry, the way esbuild ships native binaries: an app is a
 * package whose `luciole` field names, per target, a package that holds its binary in
 * `bin/<app>` and declares `os`/`cpu` (listed as its optionalDependencies, so a package
 * manager would also pick the right one). Apps carry the `luciole-app` keyword, which is
 * what search looks for.
 *
 * Only the registry's public read API is used: packuments, tarballs and `/-/v1/search`.
 * A tarball is checked against the integrity the registry publishes; npm signatures are
 * not verified, so this protects from a damaged download, not from a compromised
 * registry.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  AppField,
  formatSpec,
  type Listing,
  type PackageSpec,
  type Registry,
  type Release,
} from "./registry";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const APP_KEYWORD = "luciole-app";
const SEARCH_SIZE = 50;
const NOT_FOUND = 404;

/** `LUCIOLE_REGISTRY`, then npm's own setting, then the public registry. */
export const registryUrl = (env: NodeJS.ProcessEnv = process.env) =>
  (
    env.LUCIOLE_REGISTRY ||
    env.NPM_CONFIG_REGISTRY ||
    env.npm_config_registry ||
    DEFAULT_REGISTRY
  ).replace(/\/+$/, "");

const Dist = z.object({
  tarball: z.string().min(1),
  integrity: z.string().min(1).optional(),
  shasum: z.string().min(1).optional(),
});
type Dist = z.infer<typeof Dist>;
/** The part of an npm version document that locates and verifies the tarball. */
const VersionDocument = z.object({ dist: Dist });
/** The `dist` entry of an npm version document, when it can be verified. */
export function publishedDist(document: unknown) {
  const parsed = VersionDocument.safeParse(document);
  if (!parsed.success) return undefined;
  const { dist } = parsed.data;
  return dist.integrity || dist.shasum ? dist : undefined;
}
/** Whether `tarball` is what `dist` describes: sha512 integrity, else the legacy sha1. */
export function matchesDist(tarball: Uint8Array, dist: Dist) {
  const digest = (algorithm: "sha512" | "sha1", encoding: "base64" | "hex") =>
    new Bun.CryptoHasher(algorithm).update(tarball).digest(encoding);
  return dist.integrity?.startsWith("sha512-")
    ? digest("sha512", "base64") === dist.integrity.slice("sha512-".length)
    : dist.shasum !== undefined && digest("sha1", "hex") === dist.shasum;
}

const Packument = z.object({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).default({}),
  versions: z.record(z.string(), z.unknown()).default({}),
});
const AppVersion = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  luciole: AppField.optional(),
});
const SearchResults = z.object({
  objects: z.array(
    z.object({
      package: z.object({
        name: z.string(),
        version: z.string(),
        description: z.string().optional(),
      }),
    }),
  ),
});

/** The version `range` picks among `versions`: a dist-tag, else the highest match. */
function pick(packument: z.infer<typeof Packument>, range = "latest") {
  const tagged = packument["dist-tags"][range];
  if (tagged) return tagged;
  const matching = Object.keys(packument.versions).filter((version) => {
    try {
      return Bun.semver.satisfies(version, range);
    } catch {
      return false;
    }
  });
  return matching.sort(Bun.semver.order).at(-1);
}

export function npmRegistry(location = registryUrl()): Registry {
  const get = async (path: string) => {
    const url = `${location}/${path}`;
    const response = await fetch(url, { headers: { accept: "application/json" } }).catch(
      (error: unknown) => {
        throw new Error(
          `${location} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return { url, response };
  };
  const json = async (path: string, what: string): Promise<unknown> => {
    const { url, response } = await get(path);
    if (response.status === NOT_FOUND) throw new Error(`${what} is not on ${location}`);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  };
  // A scoped name keeps its "@" and escapes its "/", as npm does.
  const packument = async (name: string) =>
    Packument.parse(await json(name.replace("/", "%2f"), name));
  return {
    location,
    async search(text) {
      const query = `keywords:${APP_KEYWORD} ${text}`.trim();
      const results = SearchResults.parse(
        await json(`-/v1/search?text=${encodeURIComponent(query)}&size=${SEARCH_SIZE}`, "Search"),
      );
      return results.objects.map(({ package: p }): Listing => ({
        package: p.name,
        version: p.version,
        ...(p.description ? { description: p.description } : {}),
      }));
    },
    async resolve(spec: PackageSpec): Promise<Release> {
      const document = await packument(spec.name);
      const version = pick(document, spec.range);
      if (!version) throw new Error(`No version of ${spec.name} matches ${formatSpec(spec)}`);
      const parsed = AppVersion.safeParse(document.versions[version]);
      if (!parsed.success) throw new Error(`${spec.name}@${version}: unreadable package.json`);
      if (!parsed.data.luciole)
        throw new Error(`${spec.name}@${version} is not a luciole app: no "luciole" field`);
      return {
        package: spec.name,
        version,
        description: parsed.data.description,
        app: parsed.data.luciole,
      };
    },
    async download(release, target, directory) {
      const holder = release.app.binaries[target];
      if (!holder)
        throw new Error(
          `${release.package}@${release.version} has no binary for ${target} ` +
            `(it has ${Object.keys(release.app.binaries).join(", ") || "none"})`,
        );
      const document = (await packument(holder)).versions[release.version];
      if (document === undefined) throw new Error(`${holder}@${release.version} is not published`);
      const dist = publishedDist(document);
      if (!dist) throw new Error(`${holder}@${release.version} publishes no verifiable tarball`);
      const response = await fetch(dist.tarball).catch((error: unknown) => {
        throw new Error(
          `${dist.tarball} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!response.ok) throw new Error(`${dist.tarball}: HTTP ${response.status}`);
      const tarball = new Uint8Array(await response.arrayBuffer());
      if (!matchesDist(tarball, dist))
        throw new Error(`${dist.tarball} does not match the integrity published by ${location}`);
      await buildIn(tarball, release.app.name, dist.tarball, directory);
    },
  };
}

/** Extracts `package/bin/` of an npm tarball (`<app>`, `native/`) into `directory`. */
async function buildIn(tarball: Uint8Array, app: string, source: string, directory: string) {
  const staging = await mkdtemp(join(tmpdir(), "luciole-package-"));
  try {
    const tar = Bun.spawnSync(["tar", "xzf", "-", "-C", staging, "package/bin"], {
      stdin: tarball,
    });
    if (tar.exitCode !== 0 || !existsSync(join(staging, "package/bin", app)))
      throw new Error(`${source} holds no package/bin/${app}`);
    await rename(join(staging, "package/bin"), directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
