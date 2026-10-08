import { basename, join } from "node:path";
import { watch } from "node:fs";
import { isLinkedSource, linkedPackages } from "../lockfile";
import { spawn, type ChildProcess } from "node:child_process";
import { isUsageError, USAGE_EXIT_CODE } from "../args";
import { build } from "../build";
import {
  bearerRelay,
  linkFrameworkModules,
  serialize,
  startAppServer,
  type AppServer,
} from "../dev/supervisor";
import { checkArgs, loadArgs, type CheckedArgs } from "../launcher/app-args";
import { LAUNCH_VARIABLE, type Launch } from "../launch";
import { messageOf } from "../guards";
import { frameworkRoot, stop, type Command } from "./command";
import { printStaleNotice } from "./skills";
// Editors write a file in several events: one rebuild per burst.
const REBUILD_DEBOUNCE_MS = 150;
// A Client killed by a signal has no exit code: the run still says it did not quit.
const SIGNALLED_EXIT_CODE = 1;

const DEV_USAGE = "dev [--app dir] [-- app arguments]";
export const dev: Command = {
  usage: DEV_USAGE,
  flags: { "--app": "value" },
  async run({ directory, rest }) {
    await printStaleNotice(directory);
    // The application's arguments (after `--`), checked after each build: its schema may
    // have changed. The first build's refusal ends the run, a later one is a build error.
    const cwd = process.cwd();
    let first = true;
    // One session for every Client of this run: each rebuild reopens it (history and
    // named fields), and the bearer passes from one Client to the next in memory.
    const session = crypto.randomUUID();
    const bearer = bearerRelay();
    let server: AppServer | undefined,
      client: ChildProcess | undefined,
      closing = false;
    // `code`: the Client's, when it ended the run; a supervisor tells a crash from a quit.
    const shutdown = async (code = 0) => {
      if (closing) return;
      closing = true;
      watcher.close();
      for (const each of linked) each.close();
      clearTimeout(debounce);
      await Promise.all([stop(client), server?.stop()]);
      process.exit(code);
    };
    async function once() {
      if (closing) return;
      try {
        const { buildId } = await build(directory);
        const definition = await loadArgs(join(directory, ".luciole"), buildId);
        const name = basename(directory);
        if (first && (rest.includes("--help") || rest.includes("-h"))) {
          console.log(
            definition?.help({ name, usage: [`luciole ${DEV_USAGE}`] }) ??
              `${name} declares no arguments (app/args.ts)`,
          );
          await shutdown();
          return;
        }
        let args: CheckedArgs;
        try {
          args = await checkArgs(definition, rest, { cwd, name });
        } catch (error) {
          if (!first) throw error;
          console.error(messageOf(error));
          closing = true;
          watcher.close();
          for (const each of linked) each.close();
          process.exit(isUsageError(error) ? USAGE_EXIT_CODE : 1);
        }
        first = false;
        // An unchanged build keeps the link an earlier run made.
        await linkFrameworkModules(directory, frameworkRoot);
        if (closing) return;
        await Promise.all([stop(client), server?.stop()]);
        server = await startAppServer({
          directory,
          env: {
            ...process.env,
            PORT: process.env.PORT ?? "0",
            ...args.env,
            // Already one Server per run, whatever the application declares.
            [LAUNCH_VARIABLE]: JSON.stringify({
              v: 1,
              scope: "per-launch",
              id: session,
              cwd,
            } satisfies Launch),
          },
          onOutput: (line) => console.error(line),
        });
        if (closing) return;
        console.error(
          "Rebuild ready. The Client restarts on the same page with its named fields; state kept only in memory (Drafts) is lost.",
        );
        client = spawn(
          process.execPath,
          [join(directory, ".luciole/client/index.js"), "--url", `http://127.0.0.1:${server.port}`],
          {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: { ...process.env, LUCIOLE_SESSION: session },
          },
        );
        const activeClient = client;
        bearer.attach(activeClient);
        activeClient.once("exit", (code, signal) => {
          if (client === activeClient && !rebuilds.busy)
            void shutdown(code ?? (signal ? SIGNALLED_EXIT_CODE : 0));
        });
      } catch (error) {
        const message = `Build failed: ${messageOf(error)}`;
        if (client?.connected) client.send({ type: "build-error", message });
        else console.error(message);
      }
    }
    const rebuilds = serialize(once);
    let debounce: ReturnType<typeof setTimeout>;
    const changed = (file: string | null) => {
      if (
        !file ||
        file.includes(".luciole") ||
        file.includes("node_modules") ||
        // Written by the build itself when the route graph changes.
        file.endsWith("routeTree.gen.ts") ||
        !/\.(tsx?|jsx?)$/.test(file)
      )
        return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void rebuilds.run(), REBUILD_DEBOUNCE_MS);
    };
    const watcher = watch(directory, { recursive: true }, (_event, file) => changed(file));
    // The workspace's own packages the app links are its sources too (an editor, a canvas).
    const linked = linkedPackages(directory).map((package_) =>
      watch(package_, { recursive: true }, (_event, file) =>
        changed(file && isLinkedSource(file) ? file : null),
      ),
    );
    // SIGHUP too: a closed terminal, or a host that ends its embedded terminal
    // (<Terminal>), must not leave the Server and the Client running without it.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(signal, () => void shutdown());
    await rebuilds.run();
  },
};
