/**
 * Browser bundles (the page, the in-browser Server) get src/abi.ts with its key written in:
 * a page cannot hash synchronously, and the key is this build's anyway.
 */
import type { BunPlugin } from "bun";
import { ABI_KEY } from "../abi";

/** Fails the build if the expression it replaces changed. */
export const abiKeyLiteral: BunPlugin = {
  name: "airtty-abi-key",
  setup(build) {
    build.onLoad({ filter: /\/src\/abi\.ts$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      const next = text
        .replace(
          /export const ABI_KEY = `\$\{ABI_VERSION\}-\$\{createHash\([\s\S]*?\.slice\(0, KEY_HEX\)\}`;/,
          `export const ABI_KEY = ${JSON.stringify(ABI_KEY)};`,
        )
        .replace('import { createHash } from "node:crypto";\n', "");
      if (next.includes("createHash"))
        throw new Error(`${args.path}: the ABI key is no longer computed as expected`);
      return { loader: "ts", contents: next };
    });
  },
};
