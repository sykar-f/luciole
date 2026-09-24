/**
 * `airtty <url> [<url>…] [--inline]`: the launcher's URL step (src/launcher/index.ts). Each
 * origin is prepared in this process, which still has the terminal for questions
 * (src/generic/prepare.ts); then the generic Client (./browser, itself an airtty app run
 * like the launcher's UI) opens them in tabs.
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
import { prepareOrigin } from "./prepare";

const APP = join(import.meta.dir, "browser");
const SERVER_URL = /^(?:https?|ssh):\/\//;

/** The URLs and `--inline` a URL launch takes; anything else is refused. */
export function urlArgs(target: string, args: readonly string[]) {
  const urls = [target];
  let inline = false;
  for (const arg of args) {
    if (arg === "--inline") inline = true;
    else if (SERVER_URL.test(arg)) urls.push(arg);
    else throw new Error(`A Server URL takes other Server URLs (tabs) and --inline (got ${arg})`);
  }
  return { urls, inline };
}

export async function launchUrls(target: string, options: LaunchOptions): Promise<number> {
  const { urls, inline } = urlArgs(target, options.args ?? []);
  const env = options.env ?? process.env;
  const directories = options.directories ?? defaultDirectories(env);
  const log = options.log ?? ((message: string) => console.error(message));
  const tabs = [];
  for (const url of urls)
    tabs.push(
      await prepareOrigin(url, {
        inline,
        directories,
        confirm: options.confirm ?? askTerminal,
        log,
        env,
      }),
    );
  await build(APP);
  const bun = process.execPath;
  return runLocal({
    name: "browser",
    directories,
    env: { ...env, AIRTTY_GENERIC_TABS: JSON.stringify(tabs) },
    id: serverId("local:airtty-browser"),
    buildId: await readBuildId(join(APP, ".airtty")),
    graceMs: DEFAULT_GRACE_MS,
    command: [bun, "--conditions=react-server", join(APP, ".airtty/server/index.js")],
    client: [bun, join(APP, ".airtty/client/index.js")],
    sessionKey: "local:airtty-browser",
  });
}
