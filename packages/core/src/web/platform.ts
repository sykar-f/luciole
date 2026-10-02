/**
 * The browser build's platform variants (docs/WEB.md, § 2): a framework module that has a
 * counterpart at the same path under `src/web/platform/` is replaced by it, with the same
 * exports. `src/run.tsx` becomes `src/web/platform/run.tsx`, `src/vt/terminal.tsx` becomes
 * `src/web/platform/vt/terminal.tsx`; nothing else in the framework knows.
 */
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SOURCE = resolve(import.meta.dir, "..");
const PLATFORM = join(import.meta.dir, "platform");
const EXTENSIONS = ["", ".ts", ".tsx"];

/** The file `specifier` names from `importer`, when it is a framework source. */
function frameworkFile(specifier: string, importer: string) {
  const base = isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier);
  return EXTENSIONS.map((extension) => base + extension).find(
    (file) => file.startsWith(SOURCE) && !file.startsWith(PLATFORM) && existsSync(file),
  );
}

export const platformVariants: BunPlugin = {
  name: "luciole-web-platform",
  setup(build) {
    // Relative imports, and the absolute ones src/build.ts writes into generated code.
    build.onResolve({ filter: /^(\.\.?)?\// }, (args) => {
      const file = frameworkFile(args.path, args.importer);
      if (!file) return undefined;
      const variant = join(PLATFORM, relative(SOURCE, file));
      return existsSync(variant) ? { path: variant } : undefined;
    });
  },
};
