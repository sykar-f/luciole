import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { connect, socketDirectory } from "../packages/luciole/src/connect";
import { createHttpTransport } from "../packages/luciole/src/transport";

const Ready = z.object({ ready: z.literal(true), socket: z.string(), buildId: z.string() });

test("LUCIOLE_SOCKET: the Server listens on a private socket only, even with a remote host", async () => {
  const socket = join(socketDirectory("luciole-server-"), "s");
  // No token and a non-loopback host: refused over TCP, accepted on a socket.
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "tests/instrument-server.ts"],
    {
      env: { ...process.env, LUCIOLE_SOCKET: socket, LUCIOLE_HOST: "0.0.0.0" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  try {
    const ready = await new Promise<z.infer<typeof Ready>>((resolve, reject) => {
      child.once("exit", () => reject(new Error("Server exited before ready")));
      createInterface({ input: child.stdout }).on("line", (line) => {
        const parsed = Ready.safeParse(JSON.parse(line));
        if (parsed.success) resolve(parsed.data);
      });
    });
    expect(ready.socket).toBe(socket);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const connection = await connect(`unix:${socket}`);
    const transport = createHttpTransport({
      ...connection,
      buildId: ready.buildId,
      callServer: () => Promise.reject(new Error("unused")),
    });
    expect(await transport.call("a.ts#run", [])).toBe(42);
  } finally {
    child.kill();
    await new Promise((done) => child.once("exit", done));
    await rm(dirname(socket), { recursive: true, force: true });
  }
});
