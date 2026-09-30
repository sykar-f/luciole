/**
 * `luciole` without arguments: the launcher, itself a luciole app (./luciole), run like
 * any local app. Its Server searches, installs and updates through the same library;
 * when the user picks something to launch, it writes the target to a private handoff
 * file and the Client quits. The target is then launched here, in the foreground, with
 * the terminal to itself (and to its prompts), and the launcher comes back when it ends.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "../build";
import { readBuildId } from "../compile";
import { socketDirectory } from "../connect";
import { messageOf } from "../guards";
import { launch, type LaunchOptions } from "./index";
import { runLocal } from "./local";
import { DEFAULT_GRACE_MS } from "./lifetime";
import { serverId } from "./managed";
import { directories as defaultDirectories } from "./paths";

const APP = join(import.meta.dir, "luciole");

export async function openLauncher(options: LaunchOptions = {}) {
  const directories = options.directories ?? defaultDirectories(options.env);
  const bun = process.execPath;
  await build(APP);
  const buildId = await readBuildId(join(APP, ".luciole"));
  let notice: string | undefined;
  for (;;) {
    const handoff = socketDirectory("luciole-home-");
    const choice = join(handoff, "target");
    try {
      const code = await runLocal({
        name: "luciole",
        directories,
        env: {
          ...(options.env ?? process.env),
          LUCIOLE_LAUNCHER_HANDOFF: choice,
          ...(notice ? { LUCIOLE_LAUNCHER_NOTICE: notice } : {}),
        },
        id: serverId("local:luciole"),
        buildId,
        graceMs: DEFAULT_GRACE_MS,
        command: [bun, "--conditions=react-server", join(APP, ".luciole/server/index.js")],
        client: [bun, join(APP, ".luciole/client/index.js")],
        sessionKey: "local:luciole",
      });
      let target: string;
      try {
        target = readFileSync(choice, "utf8");
      } catch {
        // Quit without choosing.
        return code;
      }
      try {
        const exit = await launch(target, { ...options, directories });
        notice = exit ? `${target} exited with ${exit}` : undefined;
      } catch (error: unknown) {
        notice = `${target}: ${messageOf(error)}`;
      }
    } finally {
      rmSync(handoff, { recursive: true, force: true });
    }
  }
}
