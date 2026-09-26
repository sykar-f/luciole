import { basename, join, sep } from "node:path";
import { watch } from "node:fs";
import { symlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { isUsageError, USAGE_EXIT_CODE } from "../args";
import { build } from "../build";
import { checkArgs, loadArgs, type CheckedArgs } from "../launcher/app-args";
import { LAUNCH_VARIABLE, type Launch } from "../launch";
import { messageOf } from "../guards";
import { isCode } from "../launcher/lock";
import { frameworkRoot, stop, type Command } from "./command";
const SERVER_STARTUP_MS = 10_000;
// Editors write a file in several events: one rebuild per burst.
const REBUILD_DEBOUNCE_MS = 150;
/** What a supervised Client asks, or tells, `airtty dev` (src/client.tsx). */
const ClientMessage = z.union([
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("bearer"), token: z.string().optional() }),
]);
/** The line a Server prints once it listens (src/server.ts). */
const ServerReady = z.object({ ready: z.literal(true), port: z.number().int() });
/**
 * The node_modules the framework's packages come from: its own, or the workspace root's
 * where they are hoisted. React stands for all of them.
 */
function frameworkModules() {
  const react = Bun.resolveSync("react/package.json", frameworkRoot);
  return react.slice(
    0,
    react.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length,
  );
}

const DEV_USAGE = "dev [--app dir] [-- app arguments]";
export const dev: Command = {
  usage: DEV_USAGE,
  async run({ directory, rest }) {
    // The application's arguments (after `--`), checked after each build: its schema may
    // have changed. The first build's refusal ends the run, a later one is a build error.
    const cwd = process.cwd();
    let first = true;
    // One session for every Client of this run: each rebuild reopens it (history and
    // named fields), and the bearer passes from one Client to the next in memory.
    const session = crypto.randomUUID();
    let bearer: string | undefined;
    let server: ChildProcess | undefined,
      client: ChildProcess | undefined,
      closing = false,
      building = false,
      again = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      watcher.close();
      clearTimeout(debounce);
      await Promise.all([stop(client), stop(server)]);
      process.exit(0);
    };
    async function rebuild() {
      if (closing) return;
      if (building) {
        again = true;
        return;
      }
      building = true;
      do {
        again = false;
        try {
          const { buildId } = await build(directory);
          const definition = await loadArgs(join(directory, ".airtty"), buildId);
          const name = basename(directory);
          if (first && (rest.includes("--help") || rest.includes("-h"))) {
            console.log(
              definition?.help({ name, usage: [`airtty ${DEV_USAGE}`] }) ??
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
            process.exit(isUsageError(error) ? USAGE_EXIT_CODE : 1);
          }
          first = false;
          // Development reuses the framework installation, even for a starter elsewhere;
          // an unchanged build keeps the link an earlier run made.
          await symlink(frameworkModules(), join(directory, ".airtty/node_modules"), "dir").catch(
            (error: unknown) => {
              if (!isCode(error, "EEXIST")) throw error;
            },
          );
          if (closing) break;
          await Promise.all([stop(client), stop(server)]);
          server = spawn(
            process.execPath,
            ["--conditions=react-server", join(directory, ".airtty/server/index.js")],
            {
              stdio: ["ignore", "pipe", "inherit"],
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
            },
          );
          const activeServer = server;
          const output = activeServer.stdout;
          if (!output) throw new Error("Server output is not piped");
          const ready = await new Promise<z.infer<typeof ServerReady>>((yes, no) => {
            const timer = setTimeout(
              () => no(new Error("Server startup timeout")),
              SERVER_STARTUP_MS,
            );
            const lines = createInterface({ input: output });
            activeServer.once("exit", () => {
              clearTimeout(timer);
              no(new Error("Server exited before ready"));
            });
            lines.on("line", (line) => {
              let message: unknown;
              try {
                message = JSON.parse(line);
              } catch {
                console.error(line);
                return;
              }
              const parsed = ServerReady.safeParse(message);
              if (parsed.success) {
                clearTimeout(timer);
                yes(parsed.data);
              }
            });
          });
          if (closing) break;
          console.error(
            "Rebuild ready. The Client restarts on the same page with its named fields; state kept only in memory (Drafts) is lost.",
          );
          client = spawn(
            process.execPath,
            [join(directory, ".airtty/client/index.js"), "--url", `http://127.0.0.1:${ready.port}`],
            {
              stdio: ["inherit", "inherit", "inherit", "ipc"],
              env: { ...process.env, AIRTTY_SESSION: session },
            },
          );
          const activeClient = client;
          activeClient.on("message", (received: unknown) => {
            const message = ClientMessage.safeParse(received);
            if (!message.success) return;
            if (message.data.type === "hello") activeClient.send({ type: "bearer", token: bearer });
            else bearer = message.data.token;
          });
          activeClient.once("exit", () => {
            if (client === activeClient && !building) void shutdown();
          });
        } catch (error) {
          const message = `Build failed: ${messageOf(error)}`;
          if (client?.connected) client.send({ type: "build-error", message });
          else console.error(message);
        }
      } while (again && !closing);
      building = false;
    }
    let debounce: ReturnType<typeof setTimeout>;
    const watcher = watch(directory, { recursive: true }, (_event, file) => {
      if (
        !file ||
        file.includes(".airtty") ||
        file.includes("node_modules") ||
        // Written by the build itself when the route graph changes.
        file.endsWith("routeTree.gen.ts") ||
        !/\.(tsx?|jsx?)$/.test(file)
      )
        return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void rebuild(), REBUILD_DEBOUNCE_MS);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
    await rebuild();
  },
};
