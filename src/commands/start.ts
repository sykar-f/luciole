import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { stop, type CommandContext, type Command } from "./command";
// Runs a built artifact in production: `start` either role, `connect` the Client.
async function launch({ args, option, optional, directory }: CommandContext) {
  const connecting = args[0] === "connect";
  const role = connecting ? "client" : option("--role", "server");
  if (!["client", "server"].includes(role)) throw new Error("role must be server or client");
  // Without a URL the Client reads AIRTTY_URL, then ~/.config/airtty/<app>.json.
  const url = connecting ? args[1] : optional("--url");
  if (connecting && (!url || url.startsWith("--")))
    throw new Error("Usage: airtty connect <url | ssh://[user@]host[/port]> [--app dir]");
  const artifact = resolve(option("--artifact", join(directory, ".airtty", role)), "index.js");
  const child = spawn(
    process.execPath,
    [
      ...(role === "server" ? ["--conditions=react-server"] : []),
      artifact,
      ...(role === "client" && url ? ["--url", url] : []),
    ],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      await stop(child);
      process.exit(0);
    });
  child.on("exit", (code) => process.exit(code ?? 1));
}
export const start: Command = {
  usage: "start --role server|client [--app dir] [--url URL] [--artifact dir]",
  run: launch,
};
export const connect: Command = {
  usage: "connect <url | ssh://[user@]host[/port]> [--app dir]",
  run: launch,
};
