/**
 * `luciole <url> [<url>…] [--inline | --sandbox] [--allow-…]`: the launcher's URL step
 * (src/launcher/index.ts). Each origin is prepared in this process, which still has the
 * terminal for questions (src/generic/prepare.ts); then the generic Client (./browser,
 * itself a luciole app run like the launcher's UI) opens them in tabs, inline or
 * sandboxed (src/sandbox).
 */
import { join } from "node:path";
import { build } from "../build";
import { readBuildId } from "../compile";
import type { LaunchOptions } from "../launcher";
import { DEFAULT_GRACE_MS } from "../launcher/lifetime";
import { runLocal } from "../launcher/local";
import { serverId } from "../launcher/managed";
import { directories as defaultDirectories } from "../launcher/paths";
import { askTerminal } from "../launcher/prompt";
import { isAllowFlag, parseAllowFlags } from "../sandbox/grants";
import { buildChild, sandboxRuntime } from "../sandbox/runtime";
import { prepareOrigin, type Mode } from "./prepare";

const APP = join(import.meta.dir, "browser");
const SERVER_URL = /^(?:https?|ssh):\/\//;

/**
 * The URLs, the mode and the `--allow-*` flags a URL launch takes; anything else is
 * refused. The mode and the flags apply to every URL given.
 */
export function urlArgs(target: string, args: readonly string[], cwd?: string) {
  const urls = [target];
  let mode: Mode | undefined;
  const flags: string[] = [];
  for (const arg of args) {
    const chosen = arg === "--inline" ? "inline" : arg === "--sandbox" ? "sandbox" : undefined;
    if (chosen && mode && mode !== chosen)
      throw new Error("--inline and --sandbox exclude each other");
    if (chosen) mode = chosen;
    else if (isAllowFlag(arg)) flags.push(arg);
    else if (SERVER_URL.test(arg)) urls.push(arg);
    else
      throw new Error(
        `A Server URL takes other Server URLs (tabs), --inline or --sandbox, and --allow-* flags (got ${arg})`,
      );
  }
  return { urls, mode, allow: parseAllowFlags(flags, cwd) };
}

export async function launchUrls(target: string, options: LaunchOptions): Promise<number> {
  const { urls, mode, allow } = urlArgs(target, options.args ?? [], options.cwd);
  const env = options.env ?? process.env;
  const directories = options.directories ?? defaultDirectories(env);
  const log = options.log ?? ((message: string) => console.error(message));
  const tabs = [];
  for (const url of urls)
    tabs.push(
      await prepareOrigin(url, {
        mode,
        allow,
        directories,
        confirm: options.confirm ?? askTerminal,
        log,
        env,
      }),
    );
  await build(APP);
  // The sandboxed Client, run from luciole's tree (src/sandbox/runtime.ts): found here,
  // where luciole runs from its sources, and handed to the bundled generic Client.
  const sandbox = tabs.some((tab) => tab.mode === "sandbox")
    ? { runtime: sandboxRuntime(), child: await buildChild() }
    : undefined;
  const bun = process.execPath;
  return runLocal({
    name: "browser",
    directories,
    env: {
      ...env,
      LUCIOLE_GENERIC_TABS: JSON.stringify(
        tabs.map((tab) => ({ ...tab, ...(tab.mode === "sandbox" && sandbox) })),
      ),
    },
    id: serverId("local:luciole-browser"),
    buildId: await readBuildId(join(APP, ".luciole")),
    graceMs: DEFAULT_GRACE_MS,
    command: [bun, "--conditions=react-server", join(APP, ".luciole/server/index.js")],
    client: [bun, join(APP, ".luciole/client/index.js")],
    sessionKey: "local:luciole-browser",
  });
}
