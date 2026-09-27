/**
 * Where airtty's own sources are, for the modules that start code from them (the build
 * injects `flight/server.ts` and others into what it bundles; the sandbox builds and
 * reads its child). Running from the sources, next to the calling module. Bundled into
 * an application (studio's Server calls `build()`), `import.meta` names the bundle: the
 * sources are then where the application resolves `airtty`, its node_modules link.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** A file every checkout of airtty's src/ has. */
const MARKER = "client.tsx";

/** airtty's src/: `here` when it is that directory, else resolved from `here`. */
export function airttySources(here: string): string {
  if (existsSync(join(here, MARKER))) return here;
  return dirname(realpathSync(Bun.resolveSync("airtty/client", here)));
}
