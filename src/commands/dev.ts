import { join } from "node:path";
import { watch } from "node:fs";
import { symlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { build } from "../build";
import { messageOf } from "../guards";
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
export const dev: Command = {
  usage: "dev",
  async run({ directory }) {
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
          await build(directory);
          // Development reuses the framework installation, even for a starter elsewhere.
          await symlink(
            join(frameworkRoot, "node_modules"),
            join(directory, ".airtty/node_modules"),
            "dir",
          );
          if (closing) break;
          await Promise.all([stop(client), stop(server)]);
          server = spawn(
            process.execPath,
            ["--conditions=react-server", join(directory, ".airtty/server/index.js")],
            {
              stdio: ["ignore", "pipe", "inherit"],
              env: { ...process.env, PORT: process.env.PORT ?? "0" },
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
