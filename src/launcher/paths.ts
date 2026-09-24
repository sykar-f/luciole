/**
 * Where the launcher keeps things, by the XDG base directories: installed apps are data
 * (`~/.local/share`), git checkouts, builds and downloaded bundles a cache (`~/.cache`,
 * safe to delete), the
 * trust the user granted is configuration (`~/.config`), Server logs are state.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type Directories = {
  /** `$XDG_DATA_HOME/airtty/apps`: one directory per installed app. */
  apps: string;
  /** `$XDG_CACHE_HOME/airtty/git`: checkouts and builds of git sources. */
  git: string;
  /** `$XDG_CACHE_HOME/airtty/bundles`: application bundles downloaded by URL, by hash. */
  bundles: string;
  /** `$XDG_CONFIG_HOME/airtty`: trust.json. */
  config: string;
  /** `$XDG_STATE_HOME/airtty`: `<app>/server.log`, next to the Client's sessions. */
  state: string;
};

export function directories(env: NodeJS.ProcessEnv = process.env): Directories {
  const home = env.HOME || homedir();
  const base = (variable: string, fallback: string) =>
    join(env[variable] || join(home, fallback), "airtty");
  return {
    apps: join(base("XDG_DATA_HOME", ".local/share"), "apps"),
    git: join(base("XDG_CACHE_HOME", ".cache"), "git"),
    bundles: join(base("XDG_CACHE_HOME", ".cache"), "bundles"),
    config: base("XDG_CONFIG_HOME", ".config"),
    state: base("XDG_STATE_HOME", ".local/state"),
  };
}

/** An app's name becomes a directory: nothing that could leave its parent. */
export const APP_NAME = /^[a-z0-9][\w.-]{0,63}$/i;
export function checkAppName(name: string) {
  if (!APP_NAME.test(name) || name.includes(".."))
    throw new Error(`Invalid app name "${name}": letters, digits, ".", "_" and "-" only`);
  return name;
}
