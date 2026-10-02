/**
 * What an application says of itself, for the places that show it rather than run it: a
 * desktop window and its bundle (packages/desktop), a launcher's list. Declared in
 * `luciole` of its package.json, next to `capabilities` (src/capabilities.ts); `version`
 * and `description` are the package's own fields.
 *
 * The build reads the declaration before building, so a wrong icon fails at once, and
 * writes `.luciole/metadata.json` with the icon next to it: a host reads the build output,
 * never the application's sources.
 *
 * zod/mini: hosts read the built file.
 */
import { copyFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import * as z from "zod/mini";
import { Capabilities } from "./capabilities";
import { ServerScope } from "./launch";

// A duration as `--grace` takes it (src/launcher/lifetime.ts, parseDuration).
const Grace = z.string().check(z.regex(/^\d+(ms|s|m|h)?$/, "must be a duration: 15m, 30s, 1h, 0"));

// What macOS names a bundle by, and what keeps its preferences and keychain items apart.
const Identifier = z
  .string()
  .check(z.regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "must be reverse DNS, as com.example.notes"));

const MAX_DISPLAY_NAME = 64;
/** The fields of an application's package.json the build reads. */
const AppPackage = z.looseObject({
  version: z.optional(z.string()),
  description: z.optional(z.string()),
  luciole: z.optional(
    z.looseObject({
      capabilities: z.optional(Capabilities),
      /** The name people read: a window's title, a menu, the Dock. */
      displayName: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME))),
      identifier: z.optional(Identifier),
      /** A square PNG, 512 pixels or more, relative to the application's directory. */
      icon: z.optional(z.string().check(z.minLength(1))),
      server: z.optional(ServerScope),
      grace: z.optional(Grace),
    }),
  ),
});

export const APP_METADATA = "metadata.json";
export const APP_ICON = "icon.png";
/** `.luciole/metadata.json`: every field a host may show, defaults applied. */
export const AppMetadata = z.object({
  format: z.literal(1),
  /** The directory's name: binaries, sessions and sockets are named after it. */
  name: z.string(),
  /** `luciole.displayName`, or `name`. */
  displayName: z.string(),
  identifier: z.optional(Identifier),
  version: z.optional(z.string()),
  description: z.optional(z.string()),
  /** `icon.png`, next to this file, when the application declares one. */
  icon: z.optional(z.literal(APP_ICON)),
  /**
   * Which launches share a Server (src/launcher/launch-key.ts): `shared` (the default),
   * `per-directory` or `per-launch`.
   */
  server: z.optional(ServerScope),
  /** How long its Server waits for a lost Client, unless `--grace` says (`15m`, `0`…). */
  grace: z.optional(Grace),
  /** The command-line arguments `app/args.ts` declares (src/args.ts). */
  args: z.optional(
    z.object({
      summary: z.optional(z.string()),
      examples: z.optional(z.array(z.string())),
      /** The options' JSON Schema (draft 2020-12), as their Standard JSON Schema gives it. */
      schema: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type AppMetadata = z.infer<typeof AppMetadata>;
export type AppArgs = NonNullable<AppMetadata["args"]>;

/** What the application declares: its capabilities, and what hosts show of it. */
export type AppDeclaration = {
  capabilities?: Capabilities;
  metadata: AppMetadata;
  /** The declared icon, checked, to copy into the build output. */
  iconFile?: string;
};

const MIN_ICON_PX = 512;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
// The IHDR chunk comes first: its width and height follow the signature and chunk header.
const IHDR_WIDTH = 16;
const IHDR_HEIGHT = 20;
const HEADER_BYTES = IHDR_HEIGHT + Uint32Array.BYTES_PER_ELEMENT;

/** The icon's pixel size, or why it cannot be one: a square PNG, large enough to scale. */
async function checkIcon(file: string) {
  const blob = Bun.file(file);
  if (!(await blob.exists())) throw new Error(`luciole.icon: ${file} does not exist`);
  const bytes = new DataView(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const isPng =
    bytes.byteLength === HEADER_BYTES &&
    PNG_SIGNATURE.every((byte, index) => bytes.getUint8(index) === byte);
  if (!isPng) throw new Error(`luciole.icon: ${file} is not a PNG`);
  const width = bytes.getUint32(IHDR_WIDTH);
  const height = bytes.getUint32(IHDR_HEIGHT);
  if (width !== height || width < MIN_ICON_PX)
    throw new Error(
      `luciole.icon: ${file} is ${width}×${height}: it must be square, ${MIN_ICON_PX} pixels or more (1024 for sharp Retina icons)`,
    );
}

/** Reads and checks what `root`'s package.json declares; an absent file declares nothing. */
export async function readAppDeclaration(root: string): Promise<AppDeclaration> {
  const name = basename(root);
  const file = Bun.file(join(root, "package.json"));
  if (!(await file.exists())) return { metadata: { format: 1, name, displayName: name } };
  const parsed = AppPackage.safeParse(await file.json());
  if (!parsed.success) throw new Error(`${file.name}: ${z.prettifyError(parsed.error)}`);
  const { version, description, luciole = {} } = parsed.data;
  let iconFile: string | undefined;
  if (luciole.icon !== undefined) {
    iconFile = resolve(root, luciole.icon);
    const inside = relative(root, iconFile);
    if (isAbsolute(luciole.icon) || inside.startsWith(".."))
      throw new Error(`luciole.icon: ${luciole.icon} must be inside the application's directory`);
    await checkIcon(iconFile);
  }
  return {
    capabilities: luciole.capabilities,
    iconFile,
    metadata: {
      format: 1,
      name,
      displayName: luciole.displayName ?? name,
      identifier: luciole.identifier,
      version,
      description,
      icon: iconFile ? APP_ICON : undefined,
      server: luciole.server,
      grace: luciole.grace,
    },
  };
}

/** Writes `metadata.json`, and the icon next to it, into a build output. */
export async function writeAppMetadata(output: string, declaration: AppDeclaration) {
  if (declaration.iconFile) await copyFile(declaration.iconFile, join(output, APP_ICON));
  await Bun.write(join(output, APP_METADATA), JSON.stringify(declaration.metadata, null, 2));
}

/** A build output's `metadata.json`, checked. */
export async function readAppMetadata(output: string): Promise<AppMetadata> {
  const file = Bun.file(join(output, APP_METADATA));
  const parsed = AppMetadata.safeParse(await file.json());
  if (!parsed.success) throw new Error(`${file.name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
