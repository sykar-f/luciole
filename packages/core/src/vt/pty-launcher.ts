/** One location rule for source/npm, compiled apps, and the desktop host. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PTY_LAUNCHER = "luciole-pty";
export const sourcePtyLauncher = () =>
  fileURLToPath(new URL("../../native/luciole-pty/dist/luciole-pty", import.meta.url));

export function ptyLauncher() {
  const bundled = join(dirname(process.execPath), "native", PTY_LAUNCHER);
  if (existsSync(bundled)) return bundled;
  const source = sourcePtyLauncher();
  if (!source.startsWith("/$bunfs/") && existsSync(source)) return source;
  // Built JS Clients still resolve their installed core package at run time.
  // A compiled app has no node_modules and must carry the sidecar above.
  if (!source.startsWith("/$bunfs/")) {
    try {
      const manifest = createRequire(import.meta.url).resolve("@luciole-sh/core/package.json");
      const installed = join(dirname(manifest), "native/luciole-pty/dist", PTY_LAUNCHER);
      if (existsSync(installed)) return installed;
    } catch {}
  }
  throw new Error(
    `The macOS PTY launcher is missing: ${source.startsWith("/$bunfs/") ? bundled : source}`,
  );
}
