import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { build } from "../build";
import { formatAddress, parseAddress } from "../devtools/protocol";
import { frameworkRoot, stop, type Command } from "./command";

/**
 * `luciole devtools`: the DevTools, a luciole application of their own
 * (src/devtools/luciole-devtools), run in another pane. Their Server listens for the
 * inspected application's processes, their Client is the UI. `--env` prints what the
 * inspected application's shell needs instead.
 */
const SERVER_STARTUP_MS = 10_000;
const KEPT_OUTPUT = 4000;
const ServerReady = z.object({ ready: z.literal(true), port: z.number().int() });
const HOOK = join(frameworkRoot, "src/devtools/hook.ts");
const APP = join(frameworkRoot, "src/devtools/luciole-devtools");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** `BUN_OPTIONS` with the fiber hook, keeping whatever else it held. */
const withHook = (options = "") => `${withoutHook(options)} --preload=${HOOK}`.trim();
// The DevTools never inspect themselves: the inspected application's variables stay out.
const withoutHook = (options = "") =>
  options
    .split(/\s+/)
    .filter((token) => token && !token.endsWith("devtools/hook.ts") && token !== "--preload")
    .join(" ");

export const devtools: Command = {
  usage: "devtools [--listen 1|<socket>|ws://host:port] [--demo] [--replay file.json] [--env]",
  async run({ args, optional }) {
    // The shell's LUCIOLE_DEVTOOLS, exported for the application, is where to listen.
    const listen = optional("--listen") ?? process.env.LUCIOLE_DEVTOOLS ?? "1";
    const address = formatAddress(parseAddress(listen));
    if (args.includes("--env")) {
      console.log(`export LUCIOLE_DEVTOOLS=${quote(listen === "1" ? address : listen)}`);
      console.log(`export BUN_OPTIONS=${quote(withHook(process.env.BUN_OPTIONS))}`);
      return;
    }
    const replay = optional("--replay");
    await build(APP);
    const { LUCIOLE_DEVTOOLS: _inspected, BUN_OPTIONS, ...rest } = process.env;
    const env = { ...rest, BUN_OPTIONS: withoutHook(BUN_OPTIONS) };
    const server = spawn(
      process.execPath,
      ["--conditions=react-server", join(APP, ".luciole/server/index.js")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env,
          PORT: "0",
          LUCIOLE_DEVTOOLS_LISTEN: listen,
          LUCIOLE_DEVTOOLS_HOOK: HOOK,
          ...(args.includes("--demo") ? { LUCIOLE_DEVTOOLS_DEMO: "1" } : {}),
          ...(replay ? { LUCIOLE_DEVTOOLS_REPLAY: resolve(replay) } : {}),
        },
      },
    );
    // The UI owns the terminal: the Server's output is kept for a failure, never printed.
    let output = "";
    server.stderr.on(
      "data",
      (chunk: Buffer) => (output = (output + chunk.toString()).slice(-KEPT_OUTPUT)),
    );
    const port = await new Promise<number>((yes, no) => {
      const timer = setTimeout(
        () => no(new Error("DevTools Server startup timeout")),
        SERVER_STARTUP_MS,
      );
      server.once("exit", () => {
        clearTimeout(timer);
        no(new Error(`DevTools Server exited:\n${output}`));
      });
      createInterface({ input: server.stdout }).on("line", (line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        const ready = ServerReady.safeParse(value);
        if (!ready.success) return;
        clearTimeout(timer);
        yes(ready.data.port);
      });
    });
    const client = spawn(
      process.execPath,
      [join(APP, ".luciole/client/index.js"), "--url", `http://127.0.0.1:${port}`],
      { stdio: "inherit", env },
    );
    const shutdown = async (code: number) => {
      await Promise.all([stop(client), stop(server)]);
      process.exit(code);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown(0));
    client.once("exit", (code) => void shutdown(code ?? 0));
    server.once("exit", () => {
      console.error(`DevTools Server exited:\n${output}`);
      void shutdown(1);
    });
  },
};
