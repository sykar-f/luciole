/**
 * `airtty` without arguments: the launcher, itself an airtty app (./airtty), run like
 * any local app. Its Server searches, installs and updates through the same library;
 * when the user picks something to launch, it writes the target to a private handoff
 * file and the Client quits. The target is then launched here, in the foreground, with
 * the terminal to itself (and to its prompts), and the launcher comes back when it ends.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "../build";
import { socketDirectory } from "../connect";
import { messageOf } from "../guards";
import { ATTACHED_FLAG } from "./attach";
import { launch, type LaunchOptions } from "./index";
import { runLocal } from "./local";
import { directories as defaultDirectories } from "./paths";

const APP = join(import.meta.dir, "airtty");

export async function openLauncher(options: LaunchOptions = {}) {
  const directories = options.directories ?? defaultDirectories(options.env);
  const bun = process.execPath;
  await build(APP);
  let notice: string | undefined;
  for (;;) {
    const handoff = socketDirectory("airtty-home-");
    const choice = join(handoff, "target");
    try {
      const code = await runLocal({
        name: "airtty",
        directories,
        env: {
          ...(options.env ?? process.env),
          AIRTTY_LAUNCHER_HANDOFF: choice,
          ...(notice ? { AIRTTY_LAUNCHER_NOTICE: notice } : {}),
        },
        command: () => [
          bun,
          "--conditions=react-server",
          join(import.meta.dir, "serve.ts"),
          join(APP, ".airtty/server/index.js"),
          ATTACHED_FLAG,
        ],
        client: [bun, join(APP, ".airtty/client/index.js")],
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
