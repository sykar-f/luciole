/**
 * The runtime ABI (docs/EMBEDDING.md, section 2): what an application bundle
 * (`.airtty/app/`) may import from the Client that evaluates it. Everything else is
 * bundled into the application. The table that satisfies these specifiers lives in the
 * runtime (src/app-bundle.ts); tests/abi.test.ts checks both lists agree and that the
 * versions below are the ones installed.
 *
 * `ABI_VERSION` is bumped by hand when an export of `airtty/client` or `airtty/route-tree`
 * changes incompatibly; a package version change changes the key on its own. A bundle
 * built for another key is refused before it is evaluated.
 */
import { createHash } from "node:crypto";
import * as z from "zod/mini";
import { Capabilities } from "./capabilities";

export const ABI_VERSION = 1;
/**
 * Shared, never bundled twice: the modules whose instances carry React contexts or
 * native state (router, keymap, renderer, the airtty runtime) and the pinned zod/mini
 * the runtime already contains. Classic `zod` is not in it: an application that uses it
 * bundles it, the Client runtime stays without it.
 */
export const ABI_SPECIFIERS = [
  "airtty/client",
  "airtty/route-tree",
  "@tanstack/react-router",
  "react",
  "react/jsx-runtime",
  "@opentui/core",
  "@opentui/react",
  "@opentui/react/jsx-runtime",
  "@opentui/keymap",
  "@opentui/keymap/react",
  "zod/mini",
] as const;
export type AbiSpecifier = (typeof ABI_SPECIFIERS)[number];
export const isAbiSpecifier = (specifier: string): specifier is AbiSpecifier =>
  ABI_SPECIFIERS.some((s) => s === specifier);
/** The exact versions behind those specifiers, as package.json pins them. */
export const ABI_PACKAGES = {
  react: "19.3.0",
  "@opentui/core": "0.5.12",
  "@opentui/react": "0.5.12",
  "@opentui/keymap": "0.5.12",
  "@tanstack/react-router": "1.170.38",
  "react-server-dom-webpack": "19.3.0",
  zod: "4.6.5",
} as const;
const KEY_HEX = 16;
/** `<version>-<sha256 short>` of the version, the specifiers and the package versions. */
export const ABI_KEY = `${ABI_VERSION}-${createHash("sha256")
  .update(
    JSON.stringify({
      version: ABI_VERSION,
      specifiers: [...ABI_SPECIFIERS].sort(),
      packages: ABI_PACKAGES,
    }),
  )
  .digest("hex")
  .slice(0, KEY_HEX)}`;

/** `.airtty/app/manifest.json`: written by the build, read before any evaluation. */
export const AppManifest = z.object({
  format: z.literal(1),
  name: z.string(),
  buildId: z.string().check(z.regex(/^[0-9a-f]+$/)),
  abi: z.string(),
  /** The bundle file, next to the manifest. */
  bundle: z.string().check(z.regex(/^[\w.-]+$/)),
  sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  size: z.number(),
  /** Node built-ins the bundle requires, as its `require` calls name them. */
  builtins: z.array(z.string()),
  /** `airtty.capabilities` of the application's package.json, when it declares them. */
  capabilities: z.optional(Capabilities),
  /**
   * The publisher's Ed25519 signature (src/publisher.ts) over every other field, with the
   * key that made it (SPKI, base64). Absent when the build was not asked to sign.
   */
  signature: z.optional(z.object({ publicKey: z.string(), value: z.string() })),
});
export type AppManifest = z.infer<typeof AppManifest>;
export const APP_MANIFEST = "manifest.json";
