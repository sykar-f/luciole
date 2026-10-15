/** A protocol peer that acknowledges startup, then deliberately withholds one reply. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";

const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.split("=")[1];
if (!profile) throw new Error("missing profile");
const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdout: "ignore",
  stderr: "ignore",
});
const server = Bun.serve({
  port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/json/list")
      return Response.json([
        { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/stuck` },
      ]);
    if (server.upgrade(request)) return;
    return new Response("missing", { status: 404 });
  },
  websocket: {
    message(socket, raw) {
      const message = z
        .object({
          id: z.number(),
          method: z.string(),
          params: z.optional(z.object({ expression: z.optional(z.string()) })),
        })
        .parse(JSON.parse(String(raw)));
      if (process.env.CDP_EXCEPTIONS === "1") {
        if (message.method === "Runtime.enable")
          socket.send(
            JSON.stringify({
              method: "Runtime.executionContextCreated",
              params: { context: { id: 7, origin: "https://frame.test" } },
            }),
          );
        if (message.method === "Runtime.evaluate") {
          const expression = message.params?.expression;
          const exception =
            expression === "description"
              ? { description: "Error: the expression failed" }
              : expression === "empty"
                ? { description: "" }
                : expression === "missing-description"
                  ? {}
                  : undefined;
          const result =
            expression === "value"
              ? { result: { value: 42 } }
              : {
                  result: {},
                  exceptionDetails: {
                    text: "Uncaught",
                    ...(exception === undefined ? {} : { exception }),
                  },
                };
          socket.send(JSON.stringify({ id: message.id, result }));
          return;
        }
      }
      if (message.method === (process.env.STUCK_METHOD ?? "Runtime.evaluate")) return;
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    },
  },
});
writeFileSync(join(profile, "DevToolsActivePort"), `${server.port}\n`);
if (process.env.CDP_RECORD)
  writeFileSync(
    process.env.CDP_RECORD,
    JSON.stringify({
      chrome: process.pid,
      guard: process.ppid,
      descendant: descendant.pid,
      profile,
    }),
  );
