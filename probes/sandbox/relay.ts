/**
 * Runs inside the Linux sandbox's network namespace, where only loopback exists: exposes
 * the bind-mounted proxy socket as 127.0.0.1:PORT (what HTTP_PROXY names), then runs the
 * child and exits with it. Usage: bun relay.ts <socket> <port> -- <argv…>
 */
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

const [socketPath = "", port = "", separator, ...argv] = process.argv.slice(2);
if (separator !== "--" || !argv.length)
  throw new Error("usage: relay.ts <socket> <port> -- <argv…>");
const server = createServer((client) => {
  const upstream = connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
server.listen(Number(port), "127.0.0.1", () => {
  const [file = "", ...args] = argv;
  const child = spawn(file, args, { stdio: "inherit" });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
