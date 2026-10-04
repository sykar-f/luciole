import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { stop, type CommandContext, type Command } from "./command";
import { ArgsError, ARGS_VARIABLE, encodeLaunchArgs } from "../args";
import { refuseArgs } from "../launcher/app-args";
// Runs a built artifact in production: `start` either role, `connect` the Client.
async function launch({ args, rest, option, optional, directory }: CommandContext) {
  const connecting = args[0] === "connect";
  const role = connecting ? "client" : option("--role", "server");
  if (!["client", "server"].includes(role)) throw new ArgsError("role must be server or client");
  // `start --role server -- options`: the application's, parsed by the Server itself.
  if (role === "client") refuseArgs(rest, "a Client joins one that is already running");
  // Every flag is read before the URL, so a flag missing its value is named as such.
  const url = connecting ? undefined : optional("--url");
  const artifact = resolve(option("--artifact", join(directory, ".luciole", role)), "index.js");
  // Without a URL the Client reads LUCIOLE_URL, then ~/.config/luciole/<app>.json.
  const target = connecting ? args[1] : url;
  if (connecting && (!target || target.startsWith("--")))
    throw new ArgsError(
      "Usage: luciole connect <url | ssh://[user@]host[/port]> [--app dir] [--artifact dir]",
    );
  const child = spawn(
    process.execPath,
    [
      ...(role === "server" ? ["--conditions=react-server"] : []),
      artifact,
      ...(role === "client" && target ? ["--url", target] : []),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        ...(rest.length ? { [ARGS_VARIABLE]: encodeLaunchArgs(rest, process.cwd()) } : {}),
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      await stop(child);
      process.exit(0);
    });
  child.on("exit", (code) => process.exit(code ?? 1));
}
export const start: Command = {
  usage: "start --role server|client [--app dir] [--url URL] [--artifact dir] [-- app arguments]",
  run: launch,
};
export const connect: Command = {
  usage: "connect <url | ssh://[user@]host[/port]> [--app dir] [--artifact dir]",
  run: launch,
};
