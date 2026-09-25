import { createHash } from "node:crypto";
import { join } from "node:path";
import { readPackageJson } from "../../packages/airtty/src/package-json";

/**
 * The runtime ABI: the only specifiers an application bundle may import from the generic
 * Client, everything else being bundled into the application. Bumped by hand when an
 * export of `airtty/client` or `airtty/route-tree` changes incompatibly; the package
 * versions below enter the key on their own.
 */
export const ABI_VERSION = 1;
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
  "zod",
  "zod/mini",
] as const;
export type AbiSpecifier = (typeof ABI_SPECIFIERS)[number];
export const isAbiSpecifier = (specifier: string): specifier is AbiSpecifier =>
  ABI_SPECIFIERS.some((s) => s === specifier);
// The packages behind those specifiers: their exact versions are the contract, since a
// bundle compiled against another React or OpenTUI may call what this one lacks.
const ABI_PACKAGES = [
  "react",
  "@opentui/core",
  "@opentui/react",
  "@opentui/keymap",
  "@tanstack/react-router",
  "zod",
  "react-server-dom-webpack",
] as const;
const KEY_LENGTH = 16;
/** `{ version, packages }` and its short hash, which a bundle manifest must repeat. */
export async function runtimeAbi() {
  const pkg = await readPackageJson(join(import.meta.dir, "../../package.json"));
  const packages = Object.fromEntries(
    ABI_PACKAGES.map((name) => [name, pkg.dependencies?.[name] ?? "missing"]),
  );
  const described = { version: ABI_VERSION, specifiers: [...ABI_SPECIFIERS].sort(), packages };
  const key = createHash("sha256")
    .update(JSON.stringify(described))
    .digest("hex")
    .slice(0, KEY_LENGTH);
  return { ...described, key: `${ABI_VERSION}-${key}` };
}
