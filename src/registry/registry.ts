/**
 * Where apps are published. The registry only serves packages that are really
 * installable (an app's binaries, one per platform); what is installed here is recorded
 * here (src/registry/apps.ts), never in the registry.
 */
import { z } from "zod";
import { APP_NAME } from "../launcher/paths";

/** `name`, `name@range`, `@scope/name`, `@scope/name@range` (a version, range or tag). */
export type PackageSpec = { name: string; range?: string };
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
// npm's own limit.
const MAX_NAME_LENGTH = 214;
export function parsePackageSpec(spec: string): PackageSpec | undefined {
  const at = spec.lastIndexOf("@");
  const [name, range] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
  if (!PACKAGE_NAME.test(name) || name.length > MAX_NAME_LENGTH || range === "") return undefined;
  return { name, range };
}
export const formatSpec = ({ name, range }: PackageSpec) => (range ? `${name}@${range}` : name);

/**
 * The `airtty` field of an app's package.json: its name (the command and the install
 * directory), its build, and the package holding its binary for each target.
 */
export const AppField = z.object({
  name: z.string().regex(APP_NAME),
  buildId: z.string().regex(/^[0-9a-f]+$/),
  binaries: z.record(z.string().regex(/^bun-[a-z0-9-]+$/), z.string().regex(PACKAGE_NAME)),
});
export type AppField = z.infer<typeof AppField>;

/** A search hit. */
export type Listing = { package: string; version: string; description?: string };
/** One version of an app's package. */
export type Release = {
  package: string;
  version: string;
  description?: string;
  app: AppField;
};

export interface Registry {
  /** Where it is, for messages. */
  readonly location: string;
  /** Published apps matching `text` (all of them when empty). */
  search(text: string): Promise<readonly Listing[]>;
  /** The newest release `spec` designates now. */
  resolve(spec: PackageSpec): Promise<Release>;
  /** The release's binary for `target`, verified against what the registry published. */
  download(release: Release, target: string): Promise<Uint8Array>;
}
