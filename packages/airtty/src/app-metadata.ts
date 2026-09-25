/**
 * What an application says of itself, for the places that show it rather than run it: a
 * desktop window and its bundle (packages/desktop), a launcher's list. Declared in
 * `airtty` of its package.json, next to `capabilities` (src/capabilities.ts); `version`
 * and `description` are the package's own fields.
 *
 * The build reads the declaration before building, so a wrong icon fails at once, and
 * writes `.airtty/metadata.json` with the icon next to it: a host reads the build output,
 * never the application's sources.
 *
 * zod/mini: hosts read the built file.
 */
import { copyFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import * as z from "zod/mini";
import { Capabilities } from "./capabilities";

// What macOS names a bundle by, and what keeps its preferences and keychain items apart.
const Identifier = z
  .string()
  .check(z.regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "must be reverse DNS, as com.example.notes"));

const MAX_DISPLAY_NAME = 64;
/** The fields of an application's package.json the build reads. */
const AppPackage = z.looseObject({
  version: z.optional(z.string()),
  description: z.optional(z.string()),
  airtty: z.optional(
    z.looseObject({
      capabilities: z.optional(Capabilities),
      /** The name people read: a window's title, a menu, the Dock. */
      displayName: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME))),
      identifier: z.optional(Identifier),
      /** A square PNG, 512 pixels or more, relative to the application's directory. */
      icon: z.optional(z.string().check(z.minLength(1))),
    }),
  ),
});

export const APP_METADATA = "metadata.json";
export const APP_ICON = "icon.png";
/** `.airtty/metadata.json`: every field a host may show, defaults applied. */
export const AppMetadata = z.object({
  format: z.literal(1),
  /** The directory's name: binaries, sessions and sockets are named after it. */
  name: z.string(),
  /** `airtty.displayName`, or `name`. */
  displayName: z.string(),
  identifier: z.optional(Identifier),
  version: z.optional(z.string()),
  description: z.optional(z.string()),
  /** `icon.png`, next to this file, when the application declares one. */
  icon: z.optional(z.literal(APP_ICON)),
});
export type AppMetadata = z.infer<typeof AppMetadata>;

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
  if (!(await blob.exists())) throw new Error(`airtty.icon: ${file} does not exist`);
  const bytes = new DataView(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const isPng =
    bytes.byteLength === HEADER_BYTES &&
    PNG_SIGNATURE.every((byte, index) => bytes.getUint8(index) === byte);
  if (!isPng) throw new Error(`airtty.icon: ${file} is not a PNG`);
  const width = bytes.getUint32(IHDR_WIDTH);
  const height = bytes.getUint32(IHDR_HEIGHT);
  if (width !== height || width < MIN_ICON_PX)
    throw new Error(
      `airtty.icon: ${file} is ${width}×${height}: it must be square, ${MIN_ICON_PX} pixels or more (1024 for sharp Retina icons)`,
    );
}

/** Reads and checks what `root`'s package.json declares; an absent file declares nothing. */
export async function readAppDeclaration(root: string): Promise<AppDeclaration> {
  const name = basename(root);
  const file = Bun.file(join(root, "package.json"));
  if (!(await file.exists())) return { metadata: { format: 1, name, displayName: name } };
  const parsed = AppPackage.safeParse(await file.json());
  if (!parsed.success) throw new Error(`${file.name}: ${z.prettifyError(parsed.error)}`);
  const { version, description, airtty = {} } = parsed.data;
  let iconFile: string | undefined;
  if (airtty.icon !== undefined) {
    iconFile = resolve(root, airtty.icon);
    const inside = relative(root, iconFile);
    if (isAbsolute(airtty.icon) || inside.startsWith(".."))
      throw new Error(`airtty.icon: ${airtty.icon} must be inside the application's directory`);
    await checkIcon(iconFile);
  }
  return {
    capabilities: airtty.capabilities,
    iconFile,
    metadata: {
      format: 1,
      name,
      displayName: airtty.displayName ?? name,
      identifier: airtty.identifier,
      version,
      description,
      icon: iconFile ? APP_ICON : undefined,
    },
  };
}

/** Writes `metadata.json`, and the icon next to it, into a build output. */
export async function writeAppMetadata(output: string, declaration: AppDeclaration) {
  if (declaration.iconFile) await copyFile(declaration.iconFile, join(output, APP_ICON));
  await Bun.write(join(output, APP_METADATA), JSON.stringify(declaration.metadata, null, 2));
}
